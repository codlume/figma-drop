import { execFile } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';

import { MAX_JSON_VALUES } from '../../apps/desktop/src/ingest/json-budget.ts';
import {
  assert,
  createLog,
  freePort,
  launchApp,
  refusesConnection,
  repoDir,
  stopTracked,
  waitUntil,
} from '../shell/driver.mjs';

const execFileAsync = promisify(execFile);
const log = createLog();
const pass = (label) => log.write(`PASS ${label}`);

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

function exportBody(overrides = {}) {
  return JSON.stringify({
    outputDir: '',
    fileKey: 'SyntheticKeyA1',
    fileName: 'Synthetic file',
    nodeId: '1:2',
    nodeName: 'Card',
    exportedAt: '2026-01-01T00:00:00.000Z',
    summary: { totalNodes: 1, truncated: false },
    node: { id: '1:2', name: 'Card', type: 'FRAME', revision: 'a' },
    components: [],
    remoteMasters: [],
    png: PNG_BASE64,
    ...overrides,
  });
}

function send({ host = 'localhost', port, method = 'POST', path = '/sync', headers, body }) {
  const finalHeaders = headers ?? { Origin: 'null', 'Content-Type': 'application/json' };
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, method, path, headers: finalHeaders }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function filesUnder(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

const snapshot = (page) => page.evaluate(`window.figmaDrop.library.getSnapshot()`);

async function revisionCount(page) {
  const { projects, unidentified } = await snapshot(page);
  const inProjects = projects
    .flatMap((project) => project.nodes)
    .reduce((total, node) => total + node.revisions.length, 0);
  return inProjects + unidentified.length;
}

const status = (app) => app.hook('receiverStatus()');
const waitForState = (app, state, timeoutMs) =>
  waitUntil(
    async () => {
      const current = await status(app);
      return current.state === state ? current : null;
    },
    `receiver state ${state}`,
    timeoutMs,
  );

const hostHeader = (host) => ({ Host: host, Origin: 'null', 'Content-Type': 'application/json' });

async function listenerPids(port) {
  const { stdout } = await execFileAsync('lsof', [
    '-nP',
    `-iTCP:${port}`,
    '-sTCP:LISTEN',
    '-t',
  ]).catch((error) => ({ stdout: error.stdout ?? '' }));
  return [...new Set(stdout.trim().split('\n').filter(Boolean).map(Number))];
}

async function assertOnlyMyChild(pid, app) {
  const { stdout } = await execFileAsync('ps', ['-o', 'pgid=', '-p', String(pid)]);
  assert(
    Number(stdout.trim()) === app.child.pid,
    'the listener belongs to the app this run started',
  );
}

function overrunByChunks(port) {
  return new Promise((resolve) => {
    const size = 4 * 1024 * 1024;
    const frame = Buffer.concat([
      Buffer.from(`${size.toString(16)}\r\n`),
      Buffer.alloc(size, 0x20),
      Buffer.from('\r\n'),
    ]);
    let sent = 0;
    const socket = connect({ host: '127.0.0.1', port });
    let reply = '';
    socket.on('data', (data) => {
      reply += data.toString('latin1');
      if (reply.includes('\r\n\r\n')) socket.destroy();
    });
    const finish = () => resolve({ reply, sent });
    socket.once('close', finish);
    socket.once('error', () => {});
    socket.write(
      `POST /sync HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: null\r\n` +
        `Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`,
    );
    const pump = () => {
      while (!socket.destroyed && sent <= MAX_BODY_BYTES * 2) {
        sent += size;
        if (!socket.write(frame)) {
          socket.once('drain', pump);
          return;
        }
      }
    };
    pump();
  });
}

function blockingOverrun(port) {
  return new Promise((resolve) => {
    const size = 4 * 1024 * 1024;
    const frame = Buffer.concat([
      Buffer.from(`${size.toString(16)}\r\n`),
      Buffer.alloc(size, 0x20),
      Buffer.from('\r\n'),
    ]);
    const frames = (MAX_BODY_BYTES + 64 * 1024 * 1024) / size;
    const socket = connect({ host: '127.0.0.1', port });
    let reply = '';
    let flushed = false;
    socket.on('error', () => {});
    socket.once('close', () => resolve({ reply, flushed }));
    socket.on('data', (data) => {
      reply += data.toString('latin1');
      if (reply.includes('\r\n\r\n')) socket.destroy();
    });
    socket.pause();
    socket.write(
      `POST /sync HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: null\r\n` +
        `Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`,
    );
    for (let sent = 1; sent < frames; sent += 1) socket.write(frame);
    socket.write(frame, () => {
      flushed = true;
      socket.resume();
    });
  });
}

async function main() {
  const scratch = realpathSync(await mkdtemp(join(tmpdir(), 'figma-drop-receiver-')));
  const library = join(scratch, 'library');
  const userData = join(scratch, 'user-data');
  const outside = join(scratch, 'outside');
  await mkdir(outside);
  const port = await freePort();
  const options = { userData, library, port };

  try {
    let app = launchApp(options);
    let page = await app.page();
    await app.waitForHooks();

    const listening = await waitForState(app, 'listening');
    assert(listening.port === port, 'listening reports the bound port');
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      const probe = await send({
        host,
        port,
        method: 'GET',
        path: '/',
        headers: { Origin: 'null' },
      });
      assert(probe.status === 200, `${host} answers`);
      assert(probe.headers['access-control-allow-origin'] === 'null', `${host} sends CORS`);
    }
    pass('real utilityProcess listens on IPv4, IPv6, and localhost, with CORS on the probe');

    const first = await send({ port, body: exportBody() });
    assert(first.status === 200, `valid export saved, got ${first.status} ${first.text}`);
    assert(first.json.path.startsWith(`${library}${sep}`), 'reply path is inside the library');
    assert(first.json.ok === undefined, 'reply is {path, preview?}');
    for (const name of ['node.json', 'figma-components.json', 'meta.json', 'preview.png']) {
      assert(existsSync(join(first.json.path, name)), `${name} committed`);
    }
    assert(existsSync(join(dirname(first.json.path), 'receipt.json')), 'receipt beside the bundle');
    const saved = await snapshot(page);
    assert(saved.projects.length === 1, 'one project');
    assert(saved.projects[0].fileKey === 'SyntheticKeyA1', 'project is the real file key');
    pass('valid export crosses HTTP, stages, and commits through the real library');

    const repeat = await send({
      port,
      body: exportBody({
        exportedAt: '2026-02-02T00:00:00.000Z',
        outputDir: outside,
        folderName: 'renamed-by-batch',
      }),
    });
    assert(
      repeat.status === 200 && repeat.json.path === first.json.path,
      'repeat replies same path',
    );
    assert((await revisionCount(page)) === 1, 'repeat adds no revision');
    assert((await readdir(outside)).length === 0, 'outputDir is ignored');
    pass('repeat differing only in exportedAt, outputDir, folderName is skipped');

    const changed = (revision) =>
      exportBody({ node: { id: '1:2', name: 'Card', type: 'FRAME', revision } });
    const second = await send({ port, body: changed('b') });
    const third = await send({ port, body: changed('a') });
    assert(second.json.path !== first.json.path, 'changed content adds a revision');
    assert(third.json.path !== first.json.path, 'a revert to older content keeps its own revision');
    assert((await revisionCount(page)) === 3, 'A, B, A is three revisions');
    pass('A/B/A keeps three revisions');

    const fallbacks = [
      { fileKey: 'current', fileName: '', nodeId: '2:1' },
      { fileKey: 'Untitled', fileName: 'Untitled', nodeId: '2:2' },
      { fileKey: 'Untitled', fileName: 'Untitled', nodeId: '2:3' },
      { fileKey: undefined, fileName: 'No key', nodeId: '2:4' },
    ];
    for (const fallback of fallbacks) {
      const reply = await send({ port, body: exportBody(fallback) });
      assert(reply.status === 200, `fallback ${fallback.nodeId} kept`);
    }
    const sorted = await snapshot(page);
    assert(sorted.projects.length === 1, 'no fallback made or joined a project');
    assert(sorted.unidentified.length === 4, 'every fallback stands alone in Unidentified');
    pass('unknown sources go to Unidentified and never merge by name');

    const before = (await readdir(scratch)).toSorted().join();
    const hostile = await send({
      port,
      body: exportBody({
        fileKey: '../../../escaped',
        fileName: '../escaped',
        nodeId: '../../escaped:1',
        nodeName: '../../escaped',
        outputDir: outside,
        folderName: '../../escaped',
        assets: [
          { name: '../../escaped.png', base64: PNG_BASE64 },
          { name: '/etc/escaped.png', base64: PNG_BASE64 },
        ],
      }),
    });
    assert(hostile.status === 200, `traversal names are kept as data, got ${hostile.text}`);
    assert(hostile.json.path.startsWith(`${library}${sep}`), 'traversal stays in the library');
    assert((await readdir(scratch)).toSorted().join() === before, 'nothing new beside the library');
    assert((await readdir(outside)).length === 0, 'nothing in outputDir');
    assert(
      filesUnder(scratch).every(
        (path) => path.startsWith(`${library}${sep}`) || path.startsWith(`${userData}${sep}`),
      ),
      'every file is inside the library or app data',
    );
    assert(existsSync(join(hostile.json.path, 'preview.assets')), 'assets landed in the bundle');
    pass('path traversal in key, names, folderName, outputDir, and assets stays contained');

    const counted = await revisionCount(page);
    const refusals = [
      ['malformed JSON', { body: '{"node":' }, 400],
      ['no node', { body: JSON.stringify({ nodeId: '1:1' }) }, 400],
      ['no node id', { body: exportBody({ nodeId: '' }) }, 400],
      ['bad base64', { body: exportBody({ png: 'not base64!' }) }, 400],
      ['bad Host', { headers: hostHeader('evil.example'), body: exportBody() }, 403],
      ['rebinding Host', { headers: hostHeader(`evil.example:${port}`), body: exportBody() }, 403],
      [
        'foreign Origin',
        {
          headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
          body: exportBody(),
        },
        403,
      ],
      [
        'missing Origin',
        { headers: { 'Content-Type': 'application/json' }, body: exportBody() },
        403,
      ],
      [
        'text/plain',
        { headers: { Origin: 'null', 'Content-Type': 'text/plain' }, body: exportBody() },
        415,
      ],
      [
        'declared oversize',
        {
          headers: {
            Origin: 'null',
            'Content-Type': 'application/json',
            'Content-Length': String(MAX_BODY_BYTES + 1),
          },
        },
        413,
      ],
    ];
    for (const [label, request, expected] of refusals) {
      const reply = await send({ port, ...request }).catch((error) => ({ status: error.code }));
      assert(reply.status === expected, `${label} gave ${reply.status}, wanted ${expected}`);
      if (reply.json) {
        assert(typeof reply.json.error === 'string', `${label} replies {error}`);
        assert(!/output folder/i.test(reply.json.error), `${label} avoids the plugin's trigger`);
      }
    }
    const preflight = await send({
      port,
      method: 'OPTIONS',
      headers: {
        Origin: 'null',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert(preflight.status === 204, 'plugin preflight accepted');
    assert(
      /content-type/i.test(preflight.headers['access-control-allow-headers']),
      'preflight allows content-type',
    );
    const overrun = await overrunByChunks(port);
    assert(
      overrun.reply.startsWith('HTTP/1.1 413'),
      `chunked overrun gets 413, got ${overrun.reply.slice(0, 40)}`,
    );
    assert(/access-control-allow-origin: null/i.test(overrun.reply), 'the 413 carries CORS');
    assert(
      overrun.sent < MAX_BODY_BYTES + 64 * 1024 * 1024,
      `overrun cut near the cap, sent ${overrun.sent}`,
    );
    const blocking = await blockingOverrun(port);
    assert(blocking.flushed, 'a sender that writes before it reads is drained');
    assert(blocking.reply.startsWith('HTTP/1.1 413'), 'and then reads its 413');
    assert((await revisionCount(page)) === counted, 'no refused request reached the library');
    assert(
      (await readdir(join(library, '.staging'))).length === 0,
      'refusals leave no staging entry',
    );
    pass('malformed, oversized, bad Host, bad Origin, and wrong content type are refused');

    const open = (path) => send({ port, path: '/open', body: JSON.stringify({ path }) });
    assert((await open(first.json.path)).status === 200, '/open accepts a reply path');
    assert((await open(dirname(dirname(first.json.path)))).json !== null, '/open answers a parent');
    const unknown = await open('/etc/passwd');
    assert(
      unknown.status === 404 && unknown.json.error,
      '/open refuses a path outside the catalog',
    );
    const pick = await send({
      port,
      method: 'GET',
      path: '/pick-folder',
      headers: { Origin: 'null' },
    });
    assert(
      pick.json.error && !/output folder/i.test(pick.json.error),
      '/pick-folder only replies {error}',
    );
    pass('/open stays inside the catalog and /pick-folder opens nothing');

    const off = (await app.hook('tray()')).items.find((item) => item.id === 'receiver-on');
    assert(off.checked === true, 'tray shows the receiver on');
    await app.hook(`clickTray('receiver-on')`);
    await waitForState(app, 'off');
    assert(await refusesConnection('127.0.0.1', port), 'IPv4 closed when off');
    assert(await refusesConnection('::1', port), 'IPv6 closed when off');
    await waitUntil(async () => (await listenerPids(port)).length === 0, 'no listener when off');
    await app.hook(`clickTray('receiver-on')`);
    await waitForState(app, 'listening');
    const afterToggle = await send({ port, body: exportBody({ nodeId: '3:1' }) });
    assert(afterToggle.status === 200, 'export works after stop and start');
    pass('toggle stops both listeners, then starts cleanly');

    const [receiverPid] = await listenerPids(port);
    await assertOnlyMyChild(receiverPid, app);
    process.kill(receiverPid, 'SIGKILL');
    await waitUntil(async () => {
      const pids = await listenerPids(port);
      return pids.length > 0 && !pids.includes(receiverPid);
    }, 'a replacement receiver');
    await waitForState(app, 'listening');
    const afterCrash = await send({ port, body: exportBody({ nodeId: '3:2' }) });
    assert(afterCrash.status === 200, 'export works after a receiver crash');
    pass('a killed receiver restarts itself and keeps receiving');

    // These abort V8 inside JSON.parse with a fatal out-of-memory no catch can contain.
    const fatalBodies = {
      nested: `{"node":${'['.repeat(120_000_000)}${']'.repeat(120_000_000)},"nodeId":"9:9"}`,
      wide: `{"node":{"a":[${'[],'.repeat(85_000_000)}[]]},"nodeId":"9:9"}`,
      numbers: `{"node":{"a":[${'0,'.repeat(120_000_000)}0]},"nodeId":"9:9"}`,
    };
    const [steadyPid] = await listenerPids(port);
    for (const [shape, body] of Object.entries(fatalBodies)) {
      const reply = await send({ port, body });
      assert(reply.status === 413, `${shape} body gets 413, got ${reply.status}`);
      assert(reply.headers['access-control-allow-origin'] === 'null', `${shape} 413 carries CORS`);
    }
    assert((await listenerPids(port)).includes(steadyPid), 'the same receiver survived all three');
    assert((await status(app)).state === 'listening', 'the receiver never left listening');
    const afterHostile = await send({ port, body: exportBody({ nodeId: '3:3' }) });
    assert(afterHostile.status === 200, 'export works after the hostile bodies');
    pass(
      'bodies that abort V8 in JSON.parse are refused before parsing, and the receiver stays up',
    );

    // The worst bodies the budget admits. Unique keys cost the most heap per value.
    const budget = MAX_JSON_VALUES - 10_000;
    const worstBodies = {
      'unique keys': () => {
        const keys = Array.from({ length: budget }, (_, index) => `"k${index}":0`);
        return `{"node":{${keys.join(',')}},"nodeId":"8:1"}`;
      },
      // Each `{},` costs two values, the brace and the comma.
      'empty objects': () => `{"node":{"a":[${'{},'.repeat(budget / 2)}{}]},"nodeId":"8:2"}`,
    };
    for (const [shape, build] of Object.entries(worstBodies)) {
      const [pidBefore] = await listenerPids(port);
      const reply = await send({ port, body: build() });
      assert(reply.status === 200, `${shape} at the budget is handled, got ${reply.status}`);
      assert((await listenerPids(port)).includes(pidBefore), `${shape} did not kill the receiver`);
    }
    pass('the worst bodies under the value budget finish without killing the receiver');

    const total = await revisionCount(page);
    await app.hook(`clickTray('receiver-on')`);
    await waitForState(app, 'off');
    page.close();
    await app.hook(`clickTray('quit')`).catch(() => {});
    await app.exited;

    app = launchApp(options);
    page = await app.page();
    await app.waitForHooks();
    await waitUntil(async () => (await snapshot(page)).state === 'ready', 'library after restart');
    assert((await revisionCount(page)) === total, 'every revision survives restart');
    assert((await status(app)).state === 'off', 'the off toggle survives restart');
    assert(await refusesConnection('127.0.0.1', port), 'off after restart really is off');
    await app.hook(`clickTray('receiver-on')`);
    await waitForState(app, 'listening');
    pass('revisions and the toggle survive a restart');

    const slow = connect({ host: '127.0.0.1', port });
    await new Promise((resolve) => slow.once('connect', resolve));
    slow.on('error', () => {});
    slow.write(
      `POST /sync HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: null\r\n` +
        `Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`,
    );
    page.close();
    await app.hook(`clickTray('quit')`).catch(() => {});
    const quit = await Promise.race([
      app.exited,
      new Promise((resolve) => setTimeout(() => resolve('hung'), 12_000)),
    ]);
    slow.destroy();
    assert(quit !== 'hung', 'quit finishes during a stalled receive');
    assert((await listenerPids(port)).length === 0, 'quit leaves no receiver behind');
    pass('quit during a stalled receive exits and leaves no listener');

    const foreign = createServer((socket) => socket.end('foreign'));
    await new Promise((resolve) => foreign.listen(port, '127.0.0.1', resolve));
    app = launchApp(options);
    page = await app.page();
    await app.waitForHooks();
    const conflict = await waitForState(app, 'port-conflict');
    assert(conflict.port === port, 'conflict names the port');
    assert(conflict.holder?.pid === process.pid, 'conflict names the process that holds it');
    assert(await refusesConnection('::1', port), 'the IPv6 side was released');
    const answer = await new Promise((resolve, reject) => {
      const client = connect({ host: '127.0.0.1', port });
      client.once('data', (data) => resolve(data.toString()));
      client.once('error', reject);
    });
    assert(answer === 'foreign', 'the foreign listener is alive and untouched');
    await new Promise((resolve) => foreign.close(resolve));
    await app.hook(`clickTray('receiver-on')`);
    await app.hook(`clickTray('receiver-on')`);
    await waitForState(app, 'listening');
    const afterConflict = await send({ port, body: exportBody({ nodeId: '3:4' }) });
    assert(afterConflict.status === 200, 'export works once the port is free');
    pass('an occupied port shows a conflict, kills nothing, and recovers by toggle');
  } finally {
    await stopTracked();
    await rm(scratch, { recursive: true, force: true });
  }
}

let failure;
try {
  await main();
  log.write('ALL PASS');
} catch (error) {
  failure = error;
  log.write(`FAIL ${error.message || error}`);
} finally {
  await stopTracked();
  await writeFile(join(repoDir, 'proof/ingest/verify-receiver.txt'), `${log.lines.join('\n')}\n`);
}
process.exit(failure ? 1 : 0);
