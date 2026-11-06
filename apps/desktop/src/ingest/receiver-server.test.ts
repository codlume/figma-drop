import { readdir, watch } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import type { CommitResult } from '../shared/integration';
import type { CommandErrorCode } from '../shared/library';
import { bindListeners } from './listeners';
import type { Listeners } from './listeners';
import type { ReceiverBackend } from './receiver-protocol';
import { createReceiverHandler } from './receiver-server';
import type { ReceiverHandler, ReceiverHandlerOptions, ReceiverLimits } from './receiver-server';
import { REJECTIONS } from './rejections';
import {
  PLUGIN_HEADERS,
  committed,
  deferred,
  fakeBackend,
  freePort,
  request,
  scratchDir,
  syncRequest,
  validPayload,
} from './test-http';
import type { FakeBackend, HttpReply } from './test-http';

type Instance = {
  port: number;
  backend: FakeBackend;
  handler: ReceiverHandler;
  stagingDir: string;
};

const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()));
});

async function start(
  overrides: Partial<ReceiverBackend> = {},
  limits: Partial<ReceiverLimits> = {},
  notify?: ReceiverHandlerOptions['notify'],
): Promise<Instance> {
  const scratch = await scratchDir();
  const port = await freePort();
  const backend = fakeBackend(overrides);
  const handler = createReceiverHandler({
    port,
    stagingDir: scratch.dir,
    backend,
    limits,
    ...(notify && { notify }),
  });
  const bound = await bindListeners({
    port,
    handler: handler.handle,
    requestTimeoutMs: handler.requestTimeoutMs,
  });
  if (!bound.ok) throw new Error(`bind failed: ${bound.reason}`);
  const listeners: Listeners = bound.listeners;
  open.push(async () => {
    listeners.closeAllConnections();
    await listeners.close();
    await scratch.cleanup();
  });
  return { port, backend, handler, stagingDir: scratch.dir };
}

function expectRejection(reply: HttpReply, code: keyof typeof REJECTIONS): void {
  expect(reply.status).toBe(REJECTIONS[code].status);
  expect(JSON.parse(reply.body)).toEqual({ error: REJECTIONS[code].error });
}

function expectCors(reply: HttpReply): void {
  expect(reply.headers['access-control-allow-origin']).toBe('null');
  expect(reply.headers.vary).toBe('Origin');
}

async function waitForEntries(dir: string, count: number): Promise<void> {
  const controller = new AbortController();
  try {
    const changes = watch(dir, { signal: controller.signal })[Symbol.asyncIterator]();
    while ((await readdir(dir)).length !== count) await changes.next();
  } finally {
    controller.abort();
  }
}

describe('POST /sync', () => {
  it('reaches the receiver over IPv4, IPv6, and localhost', async () => {
    const { port, backend } = await start();
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      const reply = await request({
        host,
        port,
        method: 'POST',
        path: '/sync',
        headers: PLUGIN_HEADERS,
        body: validPayload(),
      });
      expect(reply.status, host).toBe(200);
      expect(JSON.parse(reply.body)).toEqual({ path: '/library/r1/bundle' });
      expectCors(reply);
    }
    expect(backend.commits).toHaveLength(3);
    expect(backend.commits[0]).toMatchObject({
      identity: { kind: 'file', fileKey: 'abc123' },
      figmaNodeId: '1:2',
    });
  });

  it('replies with the preview when the library reports one, and no ok field', async () => {
    const { port } = await start({
      commit: async () => ({ ...committed('r2'), preview: '/library/r2/bundle/preview.html' }),
    });
    const reply = await syncRequest(port, validPayload());
    expect(JSON.parse(reply.body)).toEqual({
      path: '/library/r2/bundle',
      preview: '/library/r2/bundle/preview.html',
    });
  });

  it('answers from findExport without staging or committing', async () => {
    const { port, backend, stagingDir } = await start({
      findExport: async () => ({ ...committed('known'), status: 'skipped' }),
    });
    const reply = await syncRequest(port, validPayload());
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ path: '/library/known/bundle' });
    expect(backend.commits).toHaveLength(0);
    expect(await readdir(stagingDir)).toEqual([]);
  });

  it('falls through to commit when findExport fails or throws', async () => {
    const failing = await start({
      findExport: async () => ({ ok: false, code: 'unavailable', message: 'x' }),
    });
    expect((await syncRequest(failing.port, validPayload())).status).toBe(200);
    expect(failing.backend.commits).toHaveLength(1);

    const throwing = await start({
      findExport: async () => {
        throw new Error('index down');
      },
    });
    expect((await syncRequest(throwing.port, validPayload())).status).toBe(200);
    expect(throwing.backend.commits).toHaveLength(1);
  });

  it('maps every commit failure code and keeps the library message private', async () => {
    const cases: Record<CommandErrorCode, keyof typeof REJECTIONS> = {
      'not-found': 'saveFailed',
      damaged: 'saveFailed',
      'disk-full': 'diskFull',
      unavailable: 'libraryUnavailable',
      failed: 'saveFailed',
    };
    for (const [code, rejection] of Object.entries(cases) as Array<
      [CommandErrorCode, keyof typeof REJECTIONS]
    >) {
      const { port, stagingDir } = await start({
        commit: async () => ({ ok: false, code, message: 'SECRET library detail' }),
      });
      const reply = await syncRequest(port, validPayload());
      expectRejection(reply, rejection);
      expect(reply.body).not.toContain('SECRET');
      expectCors(reply);
      await waitForEntries(stagingDir, 0);
    }
  });

  it('reports the library unavailable when commit throws, and discards staging', async () => {
    const { port, stagingDir } = await start({
      commit: async () => {
        throw new Error('ipc closed');
      },
    });
    expectRejection(await syncRequest(port, validPayload()), 'libraryUnavailable');
    await waitForEntries(stagingDir, 0);
  });

  it('still replies and keeps serving when the pipeline throws unexpectedly', async () => {
    const { port } = await start({}, {}, (event) => {
      if (event === 'parse-start') throw new Error('parent port closed');
    });

    const reply = await syncRequest(port, validPayload());
    expect(reply.status).toBe(REJECTIONS.saveFailed.status);
    expect(JSON.parse(reply.body)).toEqual({ error: REJECTIONS.saveFailed.error });

    const next = await request({ port, path: '/', headers: { Origin: 'null' } });
    expect(next.status).toBe(200);
  });

  it('rejects malformed JSON and a payload with no node', async () => {
    const { port, backend } = await start();
    const malformed = await syncRequest(port, '{"node":');
    expectRejection(malformed, 'malformedJson');
    expectCors(malformed);
    expectRejection(await syncRequest(port, '{"nodeId":"1:2"}'), 'invalidExport');
    expect(backend.commits).toHaveLength(0);
  });

  it('refuses an oversized Content-Length without reading the body', async () => {
    const { port, backend } = await start({}, { maxBodyBytes: 1024 });
    const reply = await new Promise<HttpReply>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/sync',
          headers: { ...PLUGIN_HEADERS, 'Content-Length': '4096' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on('error', reject);
      req.write('{');
    });
    expectRejection(reply, 'bodyTooLarge');
    expect(reply.headers.connection).toBe('close');
    expect(backend.commits).toHaveLength(0);
  });

  it('refuses a chunked body past the cap and frees the slot', async () => {
    const { port, backend } = await start({}, { maxBodyBytes: 1024 });
    const reply = await new Promise<HttpReply>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, method: 'POST', path: '/sync', headers: PLUGIN_HEADERS },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on('error', reject);
      req.write(Buffer.alloc(2048, 'x'));
    });
    expectRejection(reply, 'bodyTooLarge');
    expect(reply.headers.connection).toBe('close');
    expect(backend.commits).toHaveLength(0);
    expect((await syncRequest(port, validPayload())).status).toBe(200);
  });

  it('answers the deadline on a hung commit, frees the slot, and discards late', async () => {
    const hung = deferred<CommitResult>();
    let calls = 0;
    const { port, stagingDir, handler } = await start(
      { commit: () => (calls++ === 0 ? hung.promise : Promise.resolve(committed('r2'))) },
      { deadlineMs: 100 },
    );
    const reply = await syncRequest(port, validPayload());
    expectRejection(reply, 'deadlineExceeded');
    expectCors(reply);
    expect(reply.headers.connection).toBe('close');
    await handler.idle();

    const next = await syncRequest(port, validPayload());
    expect(next.status).toBe(200);

    // Two staged exports sit in the dir: the hung one and the committed one the
    // fake library never moved. The late failure removes only the hung one.
    expect(await readdir(stagingDir)).toHaveLength(2);
    hung.resolve({ ok: false, code: 'failed', message: 'late' });
    await waitForEntries(stagingDir, 1);
  });

  it('turns a second concurrent export away as busy before reading its body', async () => {
    const first = deferred<CommitResult>();
    const { port } = await start({ commit: () => first.promise });
    const inFlight = syncRequest(port, validPayload());
    const second = await syncRequest(port, validPayload());
    expectRejection(second, 'busy');
    expectCors(second);
    first.resolve(committed('r1'));
    expect((await inFlight).status).toBe(200);
  });

  it('frees the slot when the client disconnects mid-body', async () => {
    const { port, backend, handler } = await start();
    const partial = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/sync',
      headers: { ...PLUGIN_HEADERS, 'Content-Length': '1000' },
    });
    partial.on('error', () => {});
    await new Promise<void>((resolve) => partial.write('{"node":', () => resolve()));
    expectRejection(await syncRequest(port, validPayload()), 'busy');
    partial.destroy();
    await handler.idle();
    expect((await syncRequest(port, validPayload())).status).toBe(200);
    expect(backend.commits).toHaveLength(1);
  });
});

// Streams a body the way a plugin mid-upload does, and stops only on a reply or a dead socket.
function uploadUntilReply(port: number, head: string, frame: Buffer): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let reply = '';
    socket.on('data', (data) => {
      reply += data.toString('latin1');
      if (reply.includes('\r\n\r\n')) socket.destroy();
    });
    socket.once('close', () => resolve(reply));
    socket.once('error', () => {});
    socket.write(head);
    const pump = () => {
      while (!socket.destroyed) {
        if (!socket.write(frame)) {
          socket.once('drain', pump);
          return;
        }
      }
    };
    pump();
  });
}

describe('a plugin still uploading when the cap is reached', () => {
  const CAP = 1024 * 1024;
  const headers = (port: number, framing: string) =>
    `POST /sync HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: null\r\n` +
    `Content-Type: application/json\r\n${framing}\r\n\r\n`;

  it('reads the 413 after a declared oversize, instead of a reset', async () => {
    const { port } = await start({}, { maxBodyBytes: CAP });
    const frame = Buffer.alloc(256 * 1024, 0x20);
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const head = headers(port, `Content-Length: ${64 * CAP}`);
      expect((await uploadUntilReply(port, head, frame)).slice(0, 12)).toBe('HTTP/1.1 413');
    }
  });

  it('reads the 413 after a chunked overrun, instead of a reset', async () => {
    const { port } = await start({}, { maxBodyBytes: CAP });
    const size = 256 * 1024;
    const frame = Buffer.concat([
      Buffer.from(`${size.toString(16)}\r\n`),
      Buffer.alloc(size, 0x20),
      Buffer.from('\r\n'),
    ]);
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const head = headers(port, 'Transfer-Encoding: chunked');
      expect((await uploadUntilReply(port, head, frame)).slice(0, 12)).toBe('HTTP/1.1 413');
    }
  });
});

describe('a sender that never stops after the 413', () => {
  it('is cut off when the discard window ends', async () => {
    const { port } = await start({}, { maxBodyBytes: 1024, discardMs: 50 });
    const socket = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
    socket.on('error', () => {});
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.write(
      `POST /sync HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: null\r\n` +
        `Content-Type: application/json\r\nContent-Length: 1000000000\r\n\r\n`,
    );
    socket.resume();
    const sending = setInterval(() => socket.write(Buffer.alloc(1024, 0x20)), 1);
    await closed;
    clearInterval(sending);
  });
});

describe('a refused upload', () => {
  const CAP = 8 * 1024 * 1024;
  const head = (port: number, target: string, framing: string) =>
    `POST ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: null\r\n` +
    `Content-Type: application/json\r\n${framing}\r\n\r\n`;

  it('holds none of its body while the connection stays open', async () => {
    const { port } = await start({}, { maxBodyBytes: CAP, discardMs: 60_000 });
    setFlagsFromString('--expose-gc');
    const collect = runInNewContext('gc') as () => void;
    const size = 1024 * 1024;
    const frame = Buffer.concat([
      Buffer.from(`${size.toString(16)}\r\n`),
      Buffer.alloc(size, 0x20),
      Buffer.from('\r\n'),
    ]);
    collect();
    const before = process.memoryUsage().arrayBuffers;

    const held: Socket[] = [];
    for (let body = 0; body < 6; body += 1) {
      const socket = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
      socket.on('error', () => {});
      held.push(socket);
      await new Promise<void>((resolve) => {
        socket.once('data', () => resolve());
        socket.write(head(port, '/sync', 'Transfer-Encoding: chunked'));
        for (let sent = 0; sent <= CAP; sent += size) socket.write(frame);
      });
    }
    collect();
    const retained = process.memoryUsage().arrayBuffers - before;
    for (const socket of held) socket.destroy();

    // Six held bodies would be 48 MiB. Socket and test buffers account for the rest.
    expect(retained).toBeLessThan(3 * CAP);
  });

  it('reads and discards all a blocking chunked sender writes before it reads', async () => {
    const { port } = await start({}, { maxBodyBytes: 1024 });
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('error', () => {});
    socket.pause();
    const size = 64 * 1024 * 1024;
    const body = Buffer.concat([
      Buffer.from(`${size.toString(16)}\r\n`),
      Buffer.alloc(size, 0x20),
      Buffer.from('\r\n'),
    ]);
    const flushed = new Promise<boolean>((resolve) => {
      socket.once('close', () => resolve(false));
      socket.write(head(port, '/sync', 'Transfer-Encoding: chunked'));
      socket.write(body, () => resolve(true));
    });
    expect(await flushed).toBe(true);
    socket.destroy();
  });

  it.each([
    ['declared', (port: number) => head(port, '/open', 'Content-Length: 104857600')],
    ['chunked', (port: number) => head(port, '/open', 'Transfer-Encoding: chunked')],
  ])('lets a %s /open upload read its 413', async (framing, build) => {
    const { port } = await start({}, { maxOpenBodyBytes: 1024 });
    const size = 256 * 1024;
    const frame =
      framing === 'chunked'
        ? Buffer.concat([
            Buffer.from(`${size.toString(16)}\r\n`),
            Buffer.alloc(size, 0x20),
            Buffer.from('\r\n'),
          ])
        : Buffer.alloc(size, 0x20);
    for (let attempt = 0; attempt < 25; attempt += 1) {
      expect((await uploadUntilReply(port, build(port), frame)).slice(0, 12)).toBe('HTTP/1.1 413');
    }
  });

  it.each([
    ['in the same write', true],
    ['after the 413', false],
  ])(
    'ignores a /sync pipelined %s, so no export lands without a reply',
    async (_when, together) => {
      const { port, backend, handler } = await start(
        {},
        { maxOpenBodyBytes: 1024, discardMs: 100 },
      );
      const payload = validPayload();
      const refused = 'x'.repeat(2048);
      const first = head(port, '/open', `Content-Length: ${refused.length}`) + refused;
      const second = head(port, '/sync', `Content-Length: ${Buffer.byteLength(payload)}`) + payload;

      const reply = await new Promise<string>((resolve) => {
        const socket = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
        let received = '';
        socket.on('data', (data) => {
          const firstData = received === '';
          received += data.toString('latin1');
          if (firstData && !together) socket.end(second);
        });
        socket.once('close', () => resolve(received));
        socket.once('error', () => {});
        if (together) socket.end(first + second);
        else socket.write(first);
      });

      await handler.idle();
      expect(reply.slice(0, 12)).toBe('HTTP/1.1 413');
      expect(reply.match(/HTTP\/1\.1 /g)).toHaveLength(1);
      expect(backend.commits).toHaveLength(0);
    },
  );
});

describe('the deadline reply', () => {
  it('closes a stalled sender, which must not be left half-open', async () => {
    const { port } = await start({}, { deadlineMs: 50 });
    const socket = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
    socket.on('error', () => {});
    let reply = '';
    socket.on('data', (data) => {
      reply += data.toString('latin1');
    });
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.write(
      `POST /sync HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: null\r\n` +
        `Content-Type: application/json\r\nContent-Length: 100000000\r\n\r\n{`,
    );
    // Only a write can show a half-open client that the server really let go.
    socket.once('end', () => {
      const probing = setInterval(() => socket.write(' '), 1);
      socket.once('close', () => clearInterval(probing));
    });
    await closed;
    expect(reply.slice(0, 12)).toBe('HTTP/1.1 503');
  });
});

describe('guards', () => {
  it('rejects a bad Host, a foreign Origin, and a missing Origin on POST', async () => {
    const { port } = await start();
    const badHost = await syncRequest(port, validPayload(), { Host: 'evil.test' });
    expectRejection(badHost, 'hostNotAllowed');
    expectCors(badHost);
    const foreign = await syncRequest(port, validPayload(), { Origin: 'https://evil.test' });
    expectRejection(foreign, 'originNotAllowed');
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    const missing = await request({
      port,
      method: 'POST',
      path: '/sync',
      headers: { 'Content-Type': 'application/json' },
      body: validPayload(),
    });
    expectRejection(missing, 'originNotAllowed');
  });

  it('rejects text/plain with 415 and CORS', async () => {
    const { port, backend } = await start();
    const reply = await syncRequest(port, validPayload(), { 'Content-Type': 'text/plain' });
    expectRejection(reply, 'unsupportedMediaType');
    expectCors(reply);
    expect(backend.commits).toHaveLength(0);
  });

  it('answers the preflight the plugin needs', async () => {
    const { port } = await start();
    const reply = await request({
      port,
      method: 'OPTIONS',
      path: '/sync',
      headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' },
    });
    expect(reply.status).toBe(204);
    expectCors(reply);
    expect(reply.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
    expect(reply.headers['access-control-allow-headers']).toBe('content-type');
    expect(reply.headers['access-control-allow-private-network']).toBeUndefined();

    const privateNetwork = await request({
      port,
      method: 'OPTIONS',
      path: '/open',
      headers: { Origin: 'null', 'Access-Control-Request-Private-Network': 'true' },
    });
    expect(privateNetwork.status).toBe(204);
    expect(privateNetwork.headers['access-control-allow-private-network']).toBe('true');

    expectRejection(await request({ port, method: 'OPTIONS', path: '/sync' }), 'originNotAllowed');
  });

  it('serves GET / as the probe, with CORS only for the plugin Origin', async () => {
    const { port } = await start();
    const bare = await request({ port, path: '/' });
    expect(bare.status).toBe(200);
    expect(bare.headers['content-type']).toContain('text/plain');
    expect(bare.headers['access-control-allow-origin']).toBeUndefined();
    const probe = await request({ port, path: '/', headers: { Origin: 'null' } });
    expect(probe.status).toBe(200);
    expectCors(probe);
  });

  it('gives 404 to unknown and absolute-form paths and 405 with Allow to wrong methods', async () => {
    const { port } = await start();
    expectRejection(
      await request({ port, path: '/nope', headers: { Origin: 'null' } }),
      'notFound',
    );
    expectRejection(
      await request({ port, path: `http://localhost:${port}/`, headers: { Origin: 'null' } }),
      'notFound',
    );
    const wrong = await request({ port, path: '/sync', headers: { Origin: 'null' } });
    expectRejection(wrong, 'methodNotAllowed');
    expect(wrong.headers.allow).toBe('POST, OPTIONS');
    expectCors(wrong);
  });
});

describe('GET /pick-folder', () => {
  it('refuses to pick, with the text upstream will show', async () => {
    const { port } = await start();
    const reply = await request({ port, path: '/pick-folder', headers: { Origin: 'null' } });
    expectRejection(reply, 'pickFolderUnsupported');
    expectCors(reply);
  });
});

const openRequest = (port: number, body: string) =>
  request({ port, method: 'POST', path: '/open', headers: PLUGIN_HEADERS, body });

describe('POST /open', () => {
  it('focuses a known path and reports an unknown one', async () => {
    const { port, backend } = await start({ focus: async (path) => path === '/library/r1' });
    const found = await openRequest(port, JSON.stringify({ path: '/library/r1' }));
    expect(found.status).toBe(200);
    expect(JSON.parse(found.body)).toEqual({ ok: true });
    expectCors(found);
    expectRejection(
      await openRequest(port, JSON.stringify({ path: '/elsewhere' })),
      'unknownExport',
    );
    expect(backend.focused).toEqual(['/library/r1', '/elsewhere']);
  });

  it('reports a focus failure without exposing it', async () => {
    const { port } = await start({
      focus: async () => {
        throw new Error('window gone');
      },
    });
    const reply = await openRequest(port, JSON.stringify({ path: '/library/r1' }));
    expectRejection(reply, 'focusFailed');
    expect(reply.body).not.toContain('window gone');
  });

  it('never hands an oversized path or body to the backend', async () => {
    const { port, backend } = await start();
    const longPath = '/'.padEnd(5000, 'a');
    expectRejection(await openRequest(port, JSON.stringify({ path: longPath })), 'unknownExport');
    const huge = JSON.stringify({ path: 'x'.repeat(70 * 1024) });
    expectRejection(await openRequest(port, huge), 'bodyTooLarge');
    expectRejection(await openRequest(port, '{"nope":1}'), 'invalidOpenRequest');
    expectRejection(await openRequest(port, 'not json'), 'malformedJson');
    expect(backend.focused).toEqual([]);
  });
});
