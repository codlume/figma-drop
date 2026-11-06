import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { LOOPBACK_BIND_ADDRESSES } from '@figma-drop/export-contract';

export type Listeners = {
  // Stops accepting. In-flight connections stay until closeAllConnections.
  close(): Promise<void>;
  closeAllConnections(): void;
};

export type BindResult =
  | { ok: true; listeners: Listeners }
  | { ok: false; reason: 'port-in-use' }
  | { ok: false; reason: 'failed'; message: string };

export type BindOptions = {
  port: number;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  requestTimeoutMs: number;
};

type Attempt =
  | { ok: true; server: Server }
  | { ok: false; code: string | undefined; message: string };

// Must stay under the margin in requestTimeoutMs. Node enforces it on its 30 s
// connection check, and no slot is held until headers complete.
const HEADERS_TIMEOUT_MS = 5000;

// A family can be absent from this machine, and the client falls back to the
// family that answers, so one bound address is enough.
const MISSING_FAMILY_CODES = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

// `localhost` may resolve to either family, so EADDRINUSE on one is a conflict for
// the whole port. It never signals or kills whatever holds the port.
export async function bindListeners(options: BindOptions): Promise<BindResult> {
  const attempts = await Promise.all(
    LOOPBACK_BIND_ADDRESSES.map((address) => bindOne(address, options)),
  );
  const bound = attempts.flatMap((attempt) => (attempt.ok ? [attempt.server] : []));
  const failures = attempts.flatMap((attempt) => (attempt.ok ? [] : [attempt]));
  const listeners = createListeners(bound);

  if (failures.some((failure) => failure.code === 'EADDRINUSE')) {
    await listeners.close();
    return { ok: false, reason: 'port-in-use' };
  }
  if (
    bound.length > 0 &&
    failures.every((failure) => MISSING_FAMILY_CODES.has(failure.code ?? ''))
  ) {
    return { ok: true, listeners };
  }
  await listeners.close();
  const message = failures.map((failure) => failure.message).join('; ') || 'no address bound';
  return { ok: false, reason: 'failed', message };
}

function bindOne(address: string, options: BindOptions): Promise<Attempt> {
  return new Promise((resolve) => {
    const server = createServer(
      {
        requestTimeout: options.requestTimeoutMs,
        headersTimeout: HEADERS_TIMEOUT_MS,
      },
      options.handler,
    );
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve({ ok: false, code: error.code, message: `${address}: ${error.message}` });
    });
    server.listen({ port: options.port, host: address }, () => resolve({ ok: true, server }));
  });
}

function createListeners(servers: readonly Server[]): Listeners {
  return {
    close: async () => {
      await Promise.all(
        servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
    },
    closeAllConnections: () => {
      for (const server of servers) server.closeAllConnections();
    },
  };
}
