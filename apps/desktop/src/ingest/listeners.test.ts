import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { bindListeners } from './listeners';
import type { Listeners } from './listeners';
import { closeServer, freePort, listenOn, request } from './test-http';

const started: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((close) => close()));
});

async function foreign(host: string, port: number): Promise<Server> {
  const server = await listenOn(host, port);
  started.push(() => closeServer(server));
  return server;
}

async function bind(port: number) {
  const result = await bindListeners({
    port,
    handler: (_req, res) => res.end('ours'),
    requestTimeoutMs: 10_000,
  });
  if (result.ok) {
    const listeners: Listeners = result.listeners;
    started.push(async () => {
      listeners.closeAllConnections();
      await listeners.close();
    });
  }
  return result;
}

function connectRefused(host: string, port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code));
    socket.once('connect', () => {
      socket.destroy();
      resolve(undefined);
    });
  });
}

function externalIPv4(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;
}

describe('bindListeners', () => {
  it('answers on both loopback families once bound', async () => {
    const port = await freePort();
    expect((await bind(port)).ok).toBe(true);
    expect((await request({ host: '127.0.0.1', port })).body).toBe('ours');
    expect((await request({ host: '::1', port })).body).toBe('ours');
  });

  it.each(['127.0.0.1', '::1'])(
    'reports a conflict when %s is taken, releases the other, and leaves the holder alone',
    async (taken) => {
      const port = await freePort();
      await foreign(taken, port);
      expect(await bind(port)).toEqual({ ok: false, reason: 'port-in-use' });

      const other = taken === '127.0.0.1' ? '::1' : '127.0.0.1';
      expect(await connectRefused(other, port)).toBe('ECONNREFUSED');
      expect((await request({ host: taken, port })).body).toBe('foreign');
    },
  );

  it('frees the port fully on stop', async () => {
    const port = await freePort();
    const result = await bind(port);
    if (!result.ok) throw new Error(result.reason);
    await result.listeners.close();
    expect(await connectRefused('127.0.0.1', port)).toBe('ECONNREFUSED');
    expect(await connectRefused('::1', port)).toBe('ECONNREFUSED');
  });

  const external = externalIPv4();
  it.skipIf(!external)('refuses a connection on a non-loopback interface', async () => {
    const port = await freePort();
    expect((await bind(port)).ok).toBe(true);
    expect(await connectRefused(external ?? '', port)).toBe('ECONNREFUSED');
  });
});
