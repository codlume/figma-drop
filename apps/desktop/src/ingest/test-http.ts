import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CommitResult, ExportLookup, StagedExport } from '../shared/integration';
import type { RevisionId } from '../shared/library';
import type { ReceiverBackend } from './receiver-protocol';

// Test-only helpers. Real sockets, synthetic payloads, nothing near ~/figma-drop.

export type HttpReply = { status: number; headers: IncomingHttpHeaders; body: string };

export type RequestOptions = {
  host?: string;
  port: number;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
};

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return reject(new Error('no port'));
      probe.close(() => resolve(address.port));
    });
  });
}

export function request(options: RequestOptions): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: options.host ?? '127.0.0.1',
        port: options.port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.once('error', reject);
    req.end(options.body);
  });
}

export const PLUGIN_HEADERS = { Origin: 'null', 'Content-Type': 'application/json' };

export function syncRequest(port: number, body: string | Buffer, headers = {}): Promise<HttpReply> {
  return request({
    port,
    method: 'POST',
    path: '/sync',
    headers: { ...PLUGIN_HEADERS, ...headers },
    body,
  });
}

export function validPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    fileKey: 'abc123',
    fileName: 'Designs',
    nodeId: '1:2',
    nodeName: 'Frame',
    exportedAt: '2026-01-01T00:00:00.000Z',
    node: { id: '1:2', name: 'Frame', type: 'FRAME' },
    components: [],
    ...overrides,
  });
}

export async function scratchDir(): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'figma-drop-ingest-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export type FakeBackend = ReceiverBackend & {
  commits: StagedExport[];
  lookups: ExportLookup[];
  focused: string[];
};

export function committed(revision: string): CommitResult {
  return {
    ok: true,
    status: 'committed',
    revisionId: revision as RevisionId,
    path: `/library/${revision}/bundle`,
  };
}

// Records every call and answers from the overrides, defaulting to a clean commit.
export function fakeBackend(overrides: Partial<ReceiverBackend> = {}): FakeBackend {
  const backend: FakeBackend = {
    commits: [],
    lookups: [],
    focused: [],
    commit: async (staged) => {
      backend.commits.push(staged);
      return overrides.commit ? overrides.commit(staged) : committed('r1');
    },
    findExport: async (lookup) => {
      backend.lookups.push(lookup);
      return overrides.findExport ? overrides.findExport(lookup) : null;
    },
    focus: async (focusPath) => {
      backend.focused.push(focusPath);
      return overrides.focus ? overrides.focus(focusPath) : true;
    },
  };
  return backend;
}

export function listenOn(host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => res.end('foreign'));
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

export function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
