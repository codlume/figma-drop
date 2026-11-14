import { Effect, Option, Schema } from 'effect';

import type {
  CommitResult,
  CreateReceiverController,
  ForkedProcess,
  ReceiverController,
  ReceiverControllerOptions,
} from '../shared/integration';
import type { Unsubscribe } from '../shared/ipc';
import type { StagingId } from '../shared/library';
import type { ReceiverStatus } from '../shared/receiver';
import { MAX_IDENTITY_CHARS } from './receiver-protocol';
import type {
  BackendCall,
  BackendResult,
  ChildMessage,
  ChildStatus,
  MainMessage,
} from './receiver-protocol';

export type ControllerTuning = {
  // JSON.parse cannot be interrupted, so a parse that outlives this kills the child.
  parseDeadlineMs?: number;
  stopTimeoutMs?: number;
  restartWindowMs?: number;
  maxExitsInWindow?: number;
};

type Holder = { pid: number; command: string };

type Child = { process: ForkedProcess; exited: boolean; watchdog: NodeJS.Timeout | null };

// `off`, `port-conflict`, and `failed` hold no process.
type Phase =
  | { phase: 'off' }
  | { phase: 'starting'; child: Child }
  | { phase: 'listening'; child: Child; port: number }
  | { phase: 'stopping'; child: Child }
  | { phase: 'port-conflict'; port: number; holder?: Holder }
  | { phase: 'failed'; message: string };

export const createReceiverController = ((
  options: ReceiverControllerOptions,
  tuning: ControllerTuning = {},
): ReceiverController => {
  const parseDeadlineMs = tuning.parseDeadlineMs ?? 30_000;
  const stopTimeoutMs = tuning.stopTimeoutMs ?? 7000;
  const restartWindowMs = tuning.restartWindowMs ?? 60_000;
  const maxExitsInWindow = tuning.maxExitsInWindow ?? 3;

  let phase: Phase = { phase: 'off' };
  let lastEmitted = JSON.stringify(toStatus(phase));
  let exitTimes: number[] = [];
  let queue: Promise<void> = Promise.resolve();
  const listeners = new Set<(status: ReceiverStatus) => void>();
  const waiters = new Set<{ until: (phase: Phase) => boolean; resolve: () => void }>();

  function setPhase(next: Phase): void {
    phase = next;
    const status = toStatus(next);
    const encoded = JSON.stringify(status);
    if (encoded !== lastEmitted) {
      lastEmitted = encoded;
      for (const listener of listeners) listener(status);
    }
    for (const waiter of waiters) {
      if (waiter.until(next)) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  function waitFor(until: (phase: Phase) => boolean): Promise<void> {
    if (until(phase)) return Promise.resolve();
    return new Promise((resolve) => waiters.add({ until, resolve }));
  }

  function isCurrent(child: Child): boolean {
    return 'child' in phase && phase.child === child;
  }

  function launch(): void {
    let process: ForkedProcess;
    try {
      process = options.fork(options.entry);
    } catch (error) {
      setPhase({ phase: 'failed', message: `The receiver could not start: ${describe(error)}` });
      return;
    }
    const child: Child = { process, exited: false, watchdog: null };
    setPhase({ phase: 'starting', child });
    process.on('message', (raw) => onMessage(child, raw));
    process.on('exit', () => onExit(child));
    post(child, { type: 'start', port: options.port, stagingDir: options.library.stagingDir });
  }

  function onMessage(child: Child, raw: unknown): void {
    if (!isCurrent(child)) return;
    const message = parseChildMessage(raw);
    if (!message) return;
    switch (message.type) {
      case 'status':
        onStatus(child, message.status);
        return;
      case 'parse-start':
        clearWatchdog(child);
        child.watchdog = setTimeout(() => child.process.kill(), parseDeadlineMs);
        return;
      case 'parse-end':
        clearWatchdog(child);
        return;
      case 'call':
        void answer(message.call).then((result) => {
          post(child, { type: 'reply', callId: message.callId, result });
        });
        return;
    }
  }

  function onStatus(child: Child, status: ChildStatus): void {
    if (phase.phase !== 'starting' && phase.phase !== 'listening') return;
    switch (status.state) {
      case 'listening':
        if (phase.phase === 'starting') setPhase({ phase: 'listening', child, port: status.port });
        return;
      // setPhase first, so the child is no longer current and its exit is no crash.
      case 'port-conflict':
        setPhase(
          status.holder
            ? { phase: 'port-conflict', port: status.port, holder: status.holder }
            : { phase: 'port-conflict', port: status.port },
        );
        child.process.kill();
        return;
      case 'failed':
        setPhase({ phase: 'failed', message: status.message });
        child.process.kill();
        return;
      case 'stopping':
        return;
    }
  }

  function onExit(child: Child): void {
    child.exited = true;
    clearWatchdog(child);
    if (!isCurrent(child)) return;
    if (phase.phase === 'stopping') {
      setPhase({ phase: 'off' });
      return;
    }
    const now = Date.now();
    exitTimes = exitTimes.filter((time) => now - time < restartWindowMs).concat(now);
    if (exitTimes.length >= maxExitsInWindow) {
      setPhase({
        phase: 'failed',
        message: `The receiver stopped ${exitTimes.length} times in a row. Turn it off and on again.`,
      });
      return;
    }
    launch();
  }

  async function answer(call: BackendCall): Promise<BackendResult> {
    switch (call.method) {
      case 'commit':
        return { method: 'commit', result: await guard(() => options.library.commit(call.staged)) };
      case 'findExport':
        return {
          method: 'findExport',
          result: await guard(() => options.library.findExport(call.lookup)),
        };
      case 'focus':
        try {
          return {
            method: 'focus',
            result: (await options.onFocus(call.path)) ? 'found' : 'unknown',
          };
        } catch {
          return { method: 'focus', result: 'failed' };
        }
    }
  }

  async function doStart(): Promise<void> {
    if (phase.phase === 'listening') return;
    if (phase.phase !== 'starting') {
      exitTimes = [];
      launch();
    }
    await waitFor((current) => current.phase !== 'starting');
  }

  async function doStop(): Promise<void> {
    switch (phase.phase) {
      case 'off':
        return;
      case 'port-conflict':
      case 'failed':
        setPhase({ phase: 'off' });
        return;
      case 'stopping':
        return;
      case 'starting':
      case 'listening': {
        const { child } = phase;
        setPhase({ phase: 'stopping', child });
        post(child, { type: 'stop' });
        const exited = Effect.promise(() => waitFor((current) => current.phase === 'off')).pipe(
          Effect.timeoutOption(stopTimeoutMs),
        );
        await Effect.runPromise(exited);
        if (!child.exited) {
          child.process.kill();
          await Effect.runPromise(exited);
        }
        // A kill that emits no exit still ends here at off.
        if (isCurrent(child)) setPhase({ phase: 'off' });
      }
    }
  }

  function enqueue(operation: () => Promise<void>): Promise<void> {
    const run = queue.then(operation).catch(() => {});
    queue = run;
    return run;
  }

  return {
    start: () => enqueue(doStart),
    stop: () => enqueue(doStop),
    status: () => toStatus(phase),
    onStatus: (listener): Unsubscribe => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}) satisfies CreateReceiverController;

function toStatus(phase: Phase): ReceiverStatus {
  switch (phase.phase) {
    case 'off':
      return { state: 'off' };
    case 'starting':
      return { state: 'starting' };
    case 'listening':
      return { state: 'listening', port: phase.port };
    case 'stopping':
      return { state: 'stopping' };
    case 'port-conflict':
      return phase.holder
        ? { state: 'port-conflict', port: phase.port, holder: phase.holder }
        : { state: 'port-conflict', port: phase.port };
    case 'failed':
      return { state: 'failed', message: phase.message };
  }
}

// Electron drops a message to a closed port without throwing.
function post(child: Child, message: MainMessage): void {
  child.process.postMessage(message);
}

function clearWatchdog(child: Child): void {
  if (child.watchdog) clearTimeout(child.watchdog);
  child.watchdog = null;
}

async function guard<T>(operation: () => Promise<T>): Promise<T | CommitResult> {
  try {
    return await operation();
  } catch (error) {
    return { ok: false, code: 'failed', message: describe(error) };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const identityString = Schema.String.check(Schema.isMaxLength(MAX_IDENTITY_CHARS));
const nonEmpty = identityString.check(Schema.isNonEmpty());
const port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));
const stagingId = Schema.String.pipe(
  Schema.refine((value): value is StagingId =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value),
  ),
);

const lookup = {
  identity: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('file'), fileKey: nonEmpty }),
    Schema.Struct({
      kind: Schema.Literal('unidentified'),
      claimedKey: Schema.NullOr(identityString),
    }),
  ]),
  figmaNodeId: nonEmpty,
  contentHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
};

const call = Schema.Union([
  Schema.Struct({
    method: Schema.Literal('commit'),
    staged: Schema.Struct({
      ...lookup,
      stagingId,
      fileName: Schema.NullOr(identityString),
      nodeName: Schema.NullOr(identityString),
      exportedAt: Schema.NullOr(identityString),
    }),
  }),
  Schema.Struct({ method: Schema.Literal('findExport'), lookup: Schema.Struct(lookup) }),
  Schema.Struct({ method: Schema.Literal('focus'), path: identityString }),
]);

const status = Schema.Union([
  Schema.Struct({ state: Schema.Literal('listening'), port }),
  Schema.Struct({ state: Schema.Literal('stopping') }),
  Schema.Struct({ state: Schema.Literal('failed'), message: Schema.String }),
  Schema.Struct({
    state: Schema.Literal('port-conflict'),
    port,
    holder: Schema.optionalKey(Schema.Struct({ pid: Schema.Int, command: Schema.String })),
  }),
]);

const decodeChildMessage = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal('parse-start') }),
    Schema.Struct({ type: Schema.Literal('parse-end') }),
    Schema.Struct({ type: Schema.Literal('status'), status }),
    Schema.Struct({ type: Schema.Literal('call'), callId: Schema.Int, call }),
  ]),
);

// Child messages are untrusted because the child parses hostile bodies.
export function parseChildMessage(raw: unknown): ChildMessage | null {
  return Option.getOrNull(decodeChildMessage(raw));
}
