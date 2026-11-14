// Runs a built receiver.cjs as a real child process behind a parent-port shim and prints every
// reply, with run-specific paths and ids replaced, so two builds can be diffed.
// usage: node receiver-e2e.mjs <receiver.cjs> <scratchDir> <port>
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename } from 'node:fs/promises';
import { request } from 'node:http';
import { join, relative } from 'node:path';

const [receiver, scratch, portArg] = process.argv.slice(2);
const port = Number(portArg);
const base = await mkdtemp(join(scratch, 'run-'));
const stagingDir = join(base, 'staging');
const library = join(base, 'library', 'files');
await mkdir(stagingDir, { recursive: true });
await mkdir(library, { recursive: true });

const child = fork(receiver, [], {
  execArgv: ['--require', new URL('./parent-port-shim.cjs', import.meta.url).pathname],
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
const exited = new Promise((resolve) =>
  child.on('exit', (code, signal) => resolve({ code, signal })),
);
const statuses = [];
const calls = [];
const ids = new Map();
const idLabel = (id) => ids.get(id) ?? ids.set(id, `<staging-${ids.size + 1}>`).get(id);
let listening;
const ready = new Promise((resolve) => (listening = resolve));

child.on('message', async (message) => {
  if (message.type === 'status') {
    statuses.push(message.status.state);
    if (message.status.state === 'listening') listening();
    return;
  }
  if (message.type !== 'call') return;
  const { callId, call } = message;
  if (call.method === 'findExport') {
    calls.push('findExport');
    child.send({ type: 'reply', callId, result: { method: 'findExport', result: null } });
  } else if (call.method === 'focus') {
    calls.push('focus');
    child.send({ type: 'reply', callId, result: { method: 'focus', result: 'found' } });
  } else if (call.method === 'commit') {
    const id = call.staged.stagingId;
    const source = join(stagingDir, id);
    const files = (await readdir(source)).toSorted();
    const dest = join(library, id);
    await rename(source, dest);
    calls.push(
      `commit ${JSON.stringify({ ...call.staged, stagingId: idLabel(id) })} files=${files.join(',')}`,
    );
    child.send({
      type: 'reply',
      callId,
      result: {
        method: 'commit',
        result: { ok: true, status: 'committed', revisionId: id, path: dest },
      },
    });
  }
});

// A failed run must not leave its receiver listening.
process.on('exit', () => child.kill());
child.send({ type: 'start', port, stagingDir });
await ready;

const payload = {
  outputDir: '/tmp/ignored',
  fileKey: 'synthKey',
  fileName: 'Synthetic',
  nodeId: '1:2',
  nodeName: 'Frame',
  exportedAt: '2026-01-02T03:04:05.000Z',
  summary: { totalNodes: 1, components: { total: 0, local: 0, remote: 0 } },
  node: { id: '1:2', name: 'Frame', type: 'FRAME' },
  components: [],
  remoteMasters: [],
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
};

function send(method, path, headers, data) {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        // A pooled socket would turn the probe after stop into a race on a dead connection.
        agent: false,
        headers: { Host: `localhost:${port}`, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            allowOrigin: res.headers['access-control-allow-origin'] ?? null,
            contentType: res.headers['content-type'] ?? null,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', (error) => resolve({ error: error.code }));
    if (data !== undefined) req.write(data);
    req.end();
  });
}

const json = { 'Content-Type': 'application/json' };
const nullOrigin = { Origin: 'null', ...json };
const post = (body, headers = nullOrigin) =>
  send('POST', '/sync', headers, typeof body === 'string' ? body : JSON.stringify(body));

const out = {};
out.health = await send('GET', '/', {});
out.preflight = await send('OPTIONS', '/sync', {
  Origin: 'null',
  'Access-Control-Request-Method': 'POST',
  'Access-Control-Request-Headers': 'content-type',
});
out.sync = await post(payload);
out.syncNoKey = await post({ ...payload, fileKey: undefined });
out.syncKeyIsName = await post({ ...payload, fileKey: 'Synthetic' });
out.syncCurrent = await post({ ...payload, fileKey: 'current' });
out.syncHostileNames = await post({
  ...payload,
  nodeName: '../../Ünï/' + 'x'.repeat(300),
  fileName: '..',
});
out.badOrigin = await post(payload, { Origin: 'https://evil.example', ...json });
out.noOrigin = await post(payload, json);
out.badOriginPreflight = await send('OPTIONS', '/sync', {
  Origin: 'https://evil.example',
  'Access-Control-Request-Method': 'POST',
});
out.badHost = await send(
  'POST',
  '/sync',
  { ...nullOrigin, Host: 'evil.example' },
  JSON.stringify(payload),
);
out.wrongType = await post(payload, { Origin: 'null', 'Content-Type': 'text/plain' });
out.badJson = await post('{nope');
out.notObject = await post([1, 2]);
out.nullBody = await post('null');
out.noNode = await post({ fileKey: 'k' });
out.badTop = await post({ node: [], fileKey: 5 });
out.badNested = await post({ ...payload, images: [{ name: 'n', base64: 5 }] });
out.multiBad = await post({ node: {}, fileKey: 1, fileName: 2 });
out.assetsBad = await post({ ...payload, assets: [{ name: 'a', base64: 'b' }, { name: 3 }] });
out.versionInfinity = await post('{"node":{},"contractVersion":1e309}');
const committedPath = JSON.parse(out.sync.body).path;
out.open = await send('POST', '/open', nullOrigin, JSON.stringify({ path: committedPath }));
out.openBadPath = await send('POST', '/open', nullOrigin, JSON.stringify({ path: 3 }));
out.openBadOrigin = await send(
  'POST',
  '/open',
  { Origin: 'https://evil.example', ...json },
  JSON.stringify({ path: committedPath }),
);
out.pickFolder = await send('GET', '/pick-folder', { Origin: 'null' });
out.unknownRoute = await send('GET', '/nope', { Origin: 'null' });

const committedFiles = (await readdir(committedPath, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name))
  .toSorted();
out.committedFiles = await Promise.all(
  committedFiles.map(async (file) => {
    const bytes = await readFile(file);
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    return `${relative(committedPath, file)} ${bytes.length} B sha256:${digest}`;
  }),
);
out.pathInsideScratch = committedPath.startsWith(base);

child.send({ type: 'stop' });
const exit = await exited;
out.exit = exit;
out.statuses = statuses;
out.calls = calls;
out.refusedAfterStop = await send('GET', '/', {});

let text = JSON.stringify(out, null, 1).replaceAll(base, '<base>');
for (const [id, label] of ids) text = text.replaceAll(id, label);
console.log(text.replaceAll(String(port), '<port>'));
