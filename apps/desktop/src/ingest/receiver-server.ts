import type { IncomingMessage, ServerResponse } from 'node:http';

import { MAX_BODY_BYTES, REPLY_DEADLINE_MS } from '@figma-drop/export-contract';
import { openRequestSchema } from '@figma-drop/export-contract/parser';
import type { OpenReply, SyncSuccess } from '@figma-drop/export-contract/parser';

import type { CommitResult } from '../shared/integration';
import type { CommandErrorCode } from '../shared/library';
import { discardStaging, prepareExport, stageExport } from './export-pipeline';
import type { ReceiverBackend } from './receiver-protocol';
import { corsHeaders, decideRequest, preflightHeaders } from './request-policy';
import type { RequestFacts } from './request-policy';
import { REJECTIONS } from './rejections';
import type { RejectionCode } from './rejections';

export type ReceiverLimits = {
  maxBodyBytes: number;
  maxOpenBodyBytes: number;
  maxOpenPathLength: number;
  deadlineMs: number;
};

export const DEFAULT_LIMITS: ReceiverLimits = {
  maxBodyBytes: MAX_BODY_BYTES,
  maxOpenBodyBytes: 64 * 1024,
  maxOpenPathLength: 4096,
  deadlineMs: REPLY_DEADLINE_MS,
};

export type ReceiverHandlerOptions = {
  port: number;
  stagingDir: string;
  backend: ReceiverBackend;
  notify?: (event: 'parse-start' | 'parse-end') => void;
  limits?: Partial<ReceiverLimits>;
};

export type ReceiverHandler = {
  handle(req: IncomingMessage, res: ServerResponse): void;
  // Resolves once no /sync holds the in-flight slot.
  idle(): Promise<void>;
  // Node's own request timeout must fire after our deadline, so ours answers first.
  requestTimeoutMs: number;
};

// Library `message` text never reaches the client; the table picks the words.
const COMMIT_FAILURES: Record<CommandErrorCode, RejectionCode> = {
  'not-found': 'saveFailed',
  damaged: 'saveFailed',
  'disk-full': 'diskFull',
  unavailable: 'libraryUnavailable',
  failed: 'saveFailed',
};

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const TEXT_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8' };
const CLOSE = { Connection: 'close' };

type BodyRead = { kind: 'body'; body: Buffer } | { kind: 'too-large' } | { kind: 'aborted' };

type Responder = {
  send(status: number, headers: Record<string, string>, body?: string): void;
  json(status: number, body: object, headers?: Record<string, string>): void;
  reject(code: RejectionCode, headers?: Record<string, string>): void;
  // The client left before any reply, so the slot and timer go with nothing written.
  abandon(): void;
};

export function createReceiverHandler(options: ReceiverHandlerOptions): ReceiverHandler {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const { backend, stagingDir, port } = options;
  const notify = options.notify ?? (() => {});
  let inFlight: Promise<void> | null = null;

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const { cors, outcome } = decideRequest(facts(req), port);
    const plain = () => createResponder(res, cors, null, () => {});
    if (outcome.kind === 'reject') return plain().reject(outcome.code, outcome.headers);
    if (outcome.kind === 'preflight') {
      return plain().send(204, preflightHeaders(outcome.privateNetwork));
    }
    switch (outcome.route) {
      case 'health':
        return plain().send(200, TEXT_HEADERS, 'figma-drop receiver\n');
      case 'pickFolder':
        return plain().reject('pickFolderUnsupported');
      case 'open':
        return settle(
          open,
          req,
          createResponder(res, cors, limits.deadlineMs, () => {}),
          'focusFailed',
        );
      case 'sync': {
        if (inFlight) return plain().reject('busy');
        const slot = Promise.withResolvers<void>();
        inFlight = slot.promise;
        const responder = createResponder(res, cors, limits.deadlineMs, () => {
          if (inFlight === slot.promise) inFlight = null;
          slot.resolve();
        });
        return settle(sync, req, responder, 'saveFailed');
      }
    }
  }

  // An unhandled rejection would end the child, and the sender with no reply.
  function settle(
    run: (req: IncomingMessage, responder: Responder) => Promise<void>,
    req: IncomingMessage,
    responder: Responder,
    fallback: RejectionCode,
  ): void {
    run(req, responder).catch(() => responder.reject(fallback));
  }

  async function sync(req: IncomingMessage, responder: Responder): Promise<void> {
    if (declaresMoreThan(req, limits.maxBodyBytes)) return responder.reject('bodyTooLarge', CLOSE);
    const read = await readBody(req, limits.maxBodyBytes);
    if (read.kind === 'aborted') return responder.abandon();
    if (read.kind === 'too-large') return responder.reject('bodyTooLarge', CLOSE);

    notify('parse-start');
    let prepared;
    try {
      prepared = prepareExport(read.body);
    } finally {
      notify('parse-end');
    }
    if (!prepared.ok) return responder.reject(prepared.rejection);

    // A hit skips the disk, so a retry of a committed export succeeds on a full
    // disk. Anything else falls through, because commit is the authority.
    const known = await backend.findExport(prepared.prepared.lookup).catch(() => null);
    if (known?.ok) return responder.json(200, syncSuccess(known));

    const staged = await stageExport(prepared.prepared, stagingDir);
    if (!staged.ok) return responder.reject(staged.rejection);

    let committed: CommitResult;
    try {
      committed = await backend.commit(staged.staged);
    } catch {
      await discardStaging(stagingDir, staged.staged.stagingId);
      return responder.reject('libraryUnavailable');
    }
    if (committed.ok) return responder.json(200, syncSuccess(committed));
    await discardStaging(stagingDir, staged.staged.stagingId);
    responder.reject(COMMIT_FAILURES[committed.code]);
  }

  async function open(req: IncomingMessage, responder: Responder): Promise<void> {
    if (declaresMoreThan(req, limits.maxOpenBodyBytes)) {
      return responder.reject('bodyTooLarge', CLOSE);
    }
    const read = await readBody(req, limits.maxOpenBodyBytes);
    if (read.kind === 'aborted') return responder.abandon();
    if (read.kind === 'too-large') return responder.reject('bodyTooLarge', CLOSE);
    let value: unknown;
    try {
      value = JSON.parse(read.body.toString('utf8'));
    } catch {
      return responder.reject('malformedJson');
    }
    const parsed = openRequestSchema.safeParse(value);
    if (!parsed.success) return responder.reject('invalidOpenRequest');
    if (parsed.data.path.length > limits.maxOpenPathLength) {
      return responder.reject('unknownExport');
    }
    let found: boolean;
    try {
      found = await backend.focus(parsed.data.path);
    } catch {
      return responder.reject('focusFailed');
    }
    if (!found) return responder.reject('unknownExport');
    const reply: OpenReply = { ok: true };
    responder.json(200, reply);
  }

  return {
    handle,
    idle: () => inFlight ?? Promise.resolve(),
    requestTimeoutMs: limits.deadlineMs + 10_000,
  };
}

function facts(req: IncomingMessage): RequestFacts {
  return {
    method: req.method,
    url: req.url,
    host: header(req, 'host'),
    origin: header(req, 'origin'),
    contentType: header(req, 'content-type'),
    remoteAddress: req.socket.remoteAddress,
    privateNetworkPreflight: header(req, 'access-control-request-private-network') === 'true',
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function syncSuccess(result: Extract<CommitResult, { ok: true }>): SyncSuccess {
  return result.preview === undefined
    ? { path: result.path }
    : { path: result.path, preview: result.preview };
}

// A declared length over the cap is refused before a byte of body is read.
function declaresMoreThan(req: IncomingMessage, cap: number): boolean {
  const declared = Number(header(req, 'content-length'));
  return Number.isFinite(declared) && declared > cap;
}

// Every byte past the cap stops the read. The reply closes the connection and
// destroys the socket once flushed, so the rest of the body is never drained.
function readBody(req: IncomingMessage, cap: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: BodyRead) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > cap) {
        req.pause();
        finish({ kind: 'too-large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ kind: 'body', body: Buffer.concat(chunks) }));
    req.on('error', () => finish({ kind: 'aborted' }));
    req.on('close', () => finish({ kind: 'aborted' }));
  });
}

// The one way out of a request. CORS rides on every reply, the first reply
// wins, and a late result after the deadline or a client abort writes nothing.
function createResponder(
  res: ServerResponse,
  cors: boolean,
  deadlineMs: number | null,
  onSettled: () => void,
): Responder {
  let settled = false;
  const settle = () => {
    if (settled) return false;
    settled = true;
    if (timer) clearTimeout(timer);
    res.off('close', abandon);
    onSettled();
    return true;
  };
  const abandon = () => {
    settle();
  };
  const send = (status: number, headers: Record<string, string>, body?: string) => {
    if (!settle()) return;
    if (res.destroyed) return;
    const closing = headers.Connection === 'close';
    res.writeHead(status, { ...corsHeaders(cors), ...headers });
    res.end(body, () => {
      if (closing) res.socket?.destroy();
    });
  };
  const json = (status: number, body: object, headers: Record<string, string> = {}) =>
    send(status, { ...JSON_HEADERS, ...headers }, JSON.stringify(body));
  const reject = (code: RejectionCode, headers: Record<string, string> = {}) => {
    const { status, error } = REJECTIONS[code];
    json(status, { error }, headers);
  };
  const timer =
    deadlineMs === null ? null : setTimeout(() => reject('deadlineExceeded', CLOSE), deadlineMs);
  res.on('close', abandon);
  return { send, json, reject, abandon };
}
