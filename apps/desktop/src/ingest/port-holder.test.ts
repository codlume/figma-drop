import { afterEach, describe, expect, it } from 'vite-plus/test';
import type { Server } from 'node:http';

import { findPortHolder, parseHolder } from './port-holder';
import { closeServer, freePort, listenOn } from './test-http';

let server: Server | null = null;

afterEach(async () => {
  if (server) await closeServer(server);
  server = null;
});

describe('findPortHolder', () => {
  it('names this process when it holds the port', async () => {
    const port = await freePort();
    server = await listenOn('127.0.0.1', port);
    const holder = await findPortHolder(port);
    expect(holder?.pid).toBe(process.pid);
    expect(holder?.command).not.toBe('');
  });

  it('reports no holder for a free port', async () => {
    expect(await findPortHolder(await freePort())).toBeUndefined();
  });
});

describe('parseHolder', () => {
  it('reads the first pid and its command from -F output', () => {
    expect(parseHolder('p4242\ncnode\nf12\np4300\ncother\n')).toEqual({
      pid: 4242,
      command: 'node',
    });
    expect(parseHolder('')).toBeUndefined();
    expect(parseHolder('p4242\n')).toBeUndefined();
  });
});
