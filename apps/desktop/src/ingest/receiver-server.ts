import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import { MAX_BODY_BYTES, REPLY_DEADLINE_MS } from '@figma-drop/export-contract';
import { parseOpenRequest } from '@figma-drop/export-contract/parser';
import type { OpenReply, SyncSuccess } from '@figma-drop/export-contract/parser';
import { Data, Effect, Fiber, Match } from 'effect';

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
  discardMs: number;
};

export const DEFAULT_LIMITS: ReceiverLimits = {
  maxBodyBytes: MAX_BODY_BYTES,
  maxOpenBodyBytes: 64 * 1024,
  maxOpenPathLength: 4096,
  deadlineMs: REPLY_DEADLINE_MS,
  discardMs: 5000,
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
  idle(): Promise<void>;
  // Sits above headers plus our deadline, so a stalled body gets our reply, not Node's.
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

class Rejection extends Data.TaggedError('Rejection')<{ code: RejectionCode }> {}
class UploadTooLarge extends Data.TaggedError('UploadTooLarge') {}
class ClientGone extends Data.TaggedError('ClientGone') {}

type Responder = ReturnType<typeof createResponder>;

export function createReceiverHandler(options: ReceiverHandlerOptions): ReceiverHandler {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const { backend, stagingDir, port } = options;
  const notify = options.notify ?? (() => {});
  let inFlight: Promise<void> | null = null;
  const refused = new WeakSet<Socket>();

  function handle(req: IncomingMessage, res: ServerResponse): void {
    // No reply can follow a refusal on this socket, and holding the request unanswered
    // would defeat Node's backpressure, so a sender that pipelines loses the connection.
    if (refused.has(req.socket)) {
      req.socket.destroy();
      return;
    }
    const { cors, outcome } = decideRequest(facts(req), port);
    const responder = createResponder(res, cors);
    if (outcome.kind === 'reject') return responder.reject(outcome.code, outcome.headers);
    if (outcome.kind === 'preflight') {
      return responder.send(204, preflightHeaders(outcome.privateNetwork));
    }
    switch (outcome.route) {
      case 'health':
        return responder.send(200, TEXT_HEADERS, 'figma-drop receiver\n');
      case 'pickFolder':
        return responder.reject('pickFolderUnsupported');
      case 'open':
        if (declaresMoreThan(req, limits.maxOpenBodyBytes)) return refuseUpload(req, responder);
        void answer(open(req), 'focusFailed', req, res, responder);
        return;
      case 'sync':
        if (inFlight) return responder.reject('busy');
        if (declaresMoreThan(req, limits.maxBodyBytes)) return refuseUpload(req, responder);
        inFlight = answer(sync(req), 'saveFailed', req, res, responder).then(() => {
          inFlight = null;
        });
    }
  }

  // The work runs on its own fiber, which the race never interrupts: a commit that
  // outlives its reply still discards what it staged.
  function answer(
    work: Effect.Effect<object, Rejection | UploadTooLarge | ClientGone>,
    fallback: RejectionCode,
    req: IncomingMessage,
    res: ServerResponse,
    responder: Responder,
  ) {
    const working = Effect.runFork(
      work.pipe(Effect.catchDefect(() => Effect.fail(new Rejection({ code: fallback })))),
    );
    return Effect.runPromiseExit(
      Fiber.join(working).pipe(
        Effect.timeout(limits.deadlineMs),
        Effect.raceFirst(closed(res)),
        Effect.match({
          onSuccess: (body) => responder.json(200, body),
          onFailure: (failure) =>
            Match.valueTags(failure, {
              Rejection: ({ code }) => responder.reject(code),
              TimeoutError: () => responder.reject('deadlineExceeded', CLOSE),
              UploadTooLarge: () => refuseUpload(req, responder),
              ClientGone: () => {},
            }),
        }),
      ),
    );
  }

  // Closing with body bytes unread makes the OS send a reset, which can wipe the
  // reply before a sender still uploading reads it, and the plugin then reports the
  // receiver as down. Node destroys the socket after a `Connection: close` reply, so
  // this one half-closes instead and throws the rest away for a bounded time.
  function refuseUpload(req: IncomingMessage, responder: Responder): void {
    const { socket } = req;
    refused.add(socket);
    socket.destroySoon = () => socket.end();
    responder.reject('bodyTooLarge', CLOSE);
    req.resume();
    const timer = setTimeout(() => socket.destroy(), limits.discardMs);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
  }

  const sync = Effect.fnUntraced(function* (req: IncomingMessage) {
    const body = yield* readBody(req, limits.maxBodyBytes);

    notify('parse-start');
    let prepared;
    try {
      prepared = prepareExport(body);
    } finally {
      notify('parse-end');
    }
    if (!prepared.ok) return yield* new Rejection({ code: prepared.rejection });
    const { lookup } = prepared.prepared;

    // A hit skips the disk, so a retry of a committed export succeeds on a full
    // disk. Anything else falls through, because commit is the authority.
    const known = yield* Effect.tryPromise(() => backend.findExport(lookup)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (known?.ok) return syncSuccess(known);

    const stage = yield* Effect.promise(() => stageExport(prepared.prepared, stagingDir));
    if (!stage.ok) return yield* new Rejection({ code: stage.rejection });
    const { staged } = stage;

    return yield* Effect.tryPromise({
      try: () => backend.commit(staged),
      catch: () => new Rejection({ code: 'libraryUnavailable' }),
    }).pipe(
      Effect.flatMap((committed) =>
        committed.ok
          ? Effect.succeed(syncSuccess(committed))
          : Effect.fail(new Rejection({ code: COMMIT_FAILURES[committed.code] })),
      ),
      Effect.tapError(() => Effect.promise(() => discardStaging(stagingDir, staged.stagingId))),
    );
  });

  const open = Effect.fnUntraced(function* (req: IncomingMessage) {
    const body = yield* readBody(req, limits.maxOpenBodyBytes);
    const value = yield* Effect.try({
      try: (): unknown => JSON.parse(body.toString('utf8')),
      catch: () => new Rejection({ code: 'malformedJson' }),
    });
    const parsed = parseOpenRequest(value);
    if (!parsed) return yield* new Rejection({ code: 'invalidOpenRequest' });
    if (parsed.path.length > limits.maxOpenPathLength) {
      return yield* new Rejection({ code: 'unknownExport' });
    }
    const found = yield* Effect.tryPromise({
      try: () => backend.focus(parsed.path),
      catch: () => new Rejection({ code: 'focusFailed' }),
    });
    if (!found) return yield* new Rejection({ code: 'unknownExport' });
    return { ok: true } satisfies OpenReply;
  });

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

function declaresMoreThan(req: IncomingMessage, cap: number): boolean {
  const declared = Number(header(req, 'content-length'));
  return Number.isFinite(declared) && declared > cap;
}

function readBody(
  req: IncomingMessage,
  cap: number,
): Effect.Effect<Buffer, UploadTooLarge | ClientGone> {
  return Effect.callback((resume) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= cap) {
        chunks.push(chunk);
        return;
      }
      // The socket outlives this during the discard, and so would these buffers.
      chunks.length = 0;
      req.off('data', onData);
      req.pause();
      resume(Effect.fail(new UploadTooLarge()));
    };
    req.on('data', onData);
    req.on('end', () => resume(Effect.succeed(Buffer.concat(chunks))));
    req.on('error', () => resume(Effect.fail(new ClientGone())));
    req.on('close', () => resume(Effect.fail(new ClientGone())));
  });
}

function closed(res: ServerResponse): Effect.Effect<never, ClientGone> {
  return Effect.callback((resume) => {
    const onClose = () => resume(Effect.fail(new ClientGone()));
    res.once('close', onClose);
    return Effect.sync(() => res.off('close', onClose));
  });
}

function createResponder(res: ServerResponse, cors: boolean) {
  const send = (status: number, headers: Record<string, string>, body?: string) => {
    if (res.destroyed) return;
    res.writeHead(status, { ...corsHeaders(cors), ...headers });
    res.end(body);
  };
  const json = (status: number, body: object, headers: Record<string, string> = {}) =>
    send(status, { ...JSON_HEADERS, ...headers }, JSON.stringify(body));
  const reject = (code: RejectionCode, headers: Record<string, string> = {}) => {
    const { status, error } = REJECTIONS[code];
    json(status, { error }, headers);
  };
  return { send, json, reject };
}
