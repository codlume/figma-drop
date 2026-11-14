// usage: RECEIVER_WORK=<work dir> node e2e.mjs <runtime> <receiver.cjs> <body.json> <iterations> [cpuProfDir]
// Drives one built receiver child over real loopback HTTP with a stand-in for main:
// findExport misses and commit renames staging into a scratch library.
// Prints one JSON line with per-request phase times taken from the child's own messages.
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [runtime, receiver, bodyPath, iterArg, profDir] = process.argv.slice(2);
const iterations = Number(iterArg ?? 5);
const work = process.env.RECEIVER_WORK;
if (!work) throw new Error('set RECEIVER_WORK to a disposable directory for the scratch library');
const body = readFileSync(bodyPath);

const port = await new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => resolve(free));
  });
});
await mkdir(join(work, 'runs'), { recursive: true });
const base = await mkdtemp(join(work, 'runs', 'run-'));
const stagingDir = join(base, 'staging');
const library = join(base, 'library');
await mkdir(stagingDir, { recursive: true });
await mkdir(library, { recursive: true });

const execArgv = ['--require', join(here, 'shim.cjs')];
if (profDir) execArgv.push('--cpu-prof', `--cpu-prof-dir=${profDir}`);
const child = fork(receiver, [], {
  execPath: runtime,
  execArgv,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
const exited = new Promise((resolve) =>
  child.on('exit', (code, signal) => resolve({ code, signal })),
);

let marks = {};
let listening;
const ready = new Promise((resolve) => (listening = resolve));
child.on('message', async (message) => {
  const now = performance.now();
  if (message.type === 'status') {
    if (message.status.state === 'listening') listening();
    return;
  }
  if (message.type === 'parse-start' || message.type === 'parse-end') {
    marks[message.type] = now;
    return;
  }
  if (message.type !== 'call') return;
  const { callId, call } = message;
  if (call.method === 'findExport') {
    marks.findExport = now;
    marks.contentHash = call.lookup.contentHash;
    child.send({ type: 'reply', callId, result: { method: 'findExport', result: null } });
    return;
  }
  if (call.method === 'commit') {
    marks.commit = now;
    const id = call.staged.stagingId;
    const dest = join(library, id);
    await rename(join(stagingDir, id), dest);
    child.send({
      type: 'reply',
      callId,
      result: {
        method: 'commit',
        result: { ok: true, status: 'committed', revisionId: id, path: join(dest, 'bundle') },
      },
    });
  }
});
child.send({ type: 'start', port, stagingDir });
await ready;

function post() {
  return new Promise((resolve, reject) => {
    const sent = {};
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/sync',
        headers: {
          Host: `localhost:${port}`,
          Origin: 'null',
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            text: Buffer.concat(chunks).toString(),
            flushed: sent.at,
            end: performance.now(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body, () => (sent.at = performance.now()));
  });
}

function procStatus(field) {
  const text = readFileSync(`/proc/${child.pid}/status`, 'utf8');
  return Math.round(Number(new RegExp(`${field}:\\s+(\\d+)`).exec(text)?.[1] ?? 0) / 1024);
}

async function digestBundle(dir) {
  const hash = createHash('sha256');
  const names = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  let bytes = 0;
  for (const name of names) {
    const content = await readFile(name);
    bytes += content.length;
    hash.update(name.slice(dir.length));
    hash.update('\0');
    hash.update(content);
  }
  return { files: names.length, bytes, digest: hash.digest('hex').slice(0, 16) };
}

const round = (ms) => Math.round(ms * 10) / 10;
const rows = [];
let identity = null;
let failure = null;
for (let i = 0; i < iterations; i += 1) {
  marks = {};
  try {
    writeFileSync(`/proc/${child.pid}/clear_refs`, '5');
  } catch {}
  const start = performance.now();
  let reply;
  try {
    reply = await post();
  } catch (error) {
    failure = {
      iteration: i,
      error: error.code ?? error.message,
      afterMs: round(performance.now() - start),
    };
    break;
  }
  const row = {
    status: reply.status,
    total: round(reply.end - start),
    read: round((marks['parse-start'] ?? NaN) - start),
    prepare: round(marks['parse-end'] - marks['parse-start']),
    find: round(marks.findExport - marks['parse-end']),
    stage: round(marks.commit - marks.findExport),
    commitReply: round(reply.end - marks.commit),
    hwmMb: procStatus('VmHWM'),
  };
  rows.push(row);
  if (reply.status === 200) {
    const { path } = JSON.parse(reply.text);
    identity ??= { contentHash: marks.contentHash, ...(await digestBundle(path)) };
    await rm(dirname(path), { recursive: true, force: true });
  } else {
    identity ??= { reply: reply.text };
  }
}
const rssAfterMb = failure ? null : procStatus('VmRSS');
child.send({ type: 'stop' });
const exit = await Promise.race([
  exited,
  new Promise((resolve) => setTimeout(() => resolve('no exit in 10 s'), 10_000)),
]);
if (exit === 'no exit in 10 s') child.kill('SIGKILL');
await rm(base, { recursive: true, force: true });
console.log(
  JSON.stringify({
    body: basename(bodyPath),
    bytes: body.length,
    receiver,
    runtime: basename(runtime),
    identity,
    failure,
    exit,
    rssAfterMb,
    rows,
  }),
);
