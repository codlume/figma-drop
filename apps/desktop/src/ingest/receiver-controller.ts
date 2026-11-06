import type {
  CommitResult,
  CreateReceiverController,
  ExportLookup,
  ForkedProcess,
  ReceiverController,
  ReceiverControllerOptions,
  StagedExport,
} from '../shared/integration';
import type { Unsubscribe } from '../shared/ipc';
import type { StagingId } from '../shared/library';
import type { ReceiverStatus } from '../shared/receiver';
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
  // How long stop waits for the child to exit on its own before killing it.
  stopTimeoutMs?: number;
  restartWindowMs?: number;
  maxExitsInWindow?: number;
};

type Holder = { pid: number; command: string };

type Child = { process: ForkedProcess; exited: boolean; watchdog: NodeJS.Timeout | null };

// `off`, `port-conflict`, and `failed` hold no process. Every start forks anew.
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
      // The child stays alive until this kill, so its exit never reads as a crash.
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
        const exited = waitFor((current) => current.phase === 'off');
        await Promise.race([exited, delay(stopTimeoutMs)]);
        if (!child.exited) {
          child.process.kill();
          await Promise.race([exited, delay(stopTimeoutMs)]);
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

// A reply to a dead child is dropped. Electron throws on a closed port.
function post(child: Child, message: MainMessage): void {
  if (child.exited) return;
  try {
    child.process.postMessage(message);
  } catch {
    // The child went away between the exit check and the post.
  }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

// Child messages are untrusted: the child parses hostile bodies, so a message
// is rebuilt field by field and nothing unexpected reaches the library.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown): value is string | null =>
  value === null || isString(value);
const isPort = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) <= 65_535;

export function parseChildMessage(raw: unknown): ChildMessage | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case 'parse-start':
      return { type: 'parse-start' };
    case 'parse-end':
      return { type: 'parse-end' };
    case 'status': {
      const status = parseStatus(raw.status);
      return status ? { type: 'status', status } : null;
    }
    case 'call': {
      const call = parseCall(raw.call);
      return call && Number.isInteger(raw.callId)
        ? { type: 'call', callId: raw.callId as number, call }
        : null;
    }
    default:
      return null;
  }
}

function parseStatus(value: unknown): ChildStatus | null {
  if (!isRecord(value)) return null;
  switch (value.state) {
    case 'listening':
      return isPort(value.port) ? { state: 'listening', port: value.port } : null;
    case 'stopping':
      return { state: 'stopping' };
    case 'failed':
      return isString(value.message) ? { state: 'failed', message: value.message } : null;
    case 'port-conflict': {
      if (!isPort(value.port)) return null;
      if (value.holder === undefined) return { state: 'port-conflict', port: value.port };
      const holder = value.holder;
      if (!isRecord(holder) || !Number.isInteger(holder.pid) || !isString(holder.command)) {
        return null;
      }
      return {
        state: 'port-conflict',
        port: value.port,
        holder: { pid: holder.pid as number, command: holder.command },
      };
    }
    default:
      return null;
  }
}

function parseCall(value: unknown): BackendCall | null {
  if (!isRecord(value)) return null;
  switch (value.method) {
    case 'commit': {
      const staged = parseStaged(value.staged);
      return staged ? { method: 'commit', staged } : null;
    }
    case 'findExport': {
      const lookup = parseLookup(value.lookup);
      return lookup ? { method: 'findExport', lookup } : null;
    }
    case 'focus':
      return isString(value.path) ? { method: 'focus', path: value.path } : null;
    default:
      return null;
  }
}

function parseIdentity(value: unknown): StagedExport['identity'] | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'file' && isString(value.fileKey) && value.fileKey !== '') {
    return { kind: 'file', fileKey: value.fileKey };
  }
  if (value.kind === 'unidentified' && isNullableString(value.claimedKey)) {
    return { kind: 'unidentified', claimedKey: value.claimedKey };
  }
  return null;
}

function parseLookup(value: unknown): ExportLookup | null {
  if (!isRecord(value)) return null;
  const identity = parseIdentity(value.identity);
  if (!identity) return null;
  if (!isString(value.figmaNodeId) || value.figmaNodeId === '') return null;
  if (!isString(value.contentHash) || !SHA256_HEX.test(value.contentHash)) return null;
  return { identity, figmaNodeId: value.figmaNodeId, contentHash: value.contentHash };
}

function parseStaged(value: unknown): StagedExport | null {
  const lookup = parseLookup(value);
  if (!lookup || !isRecord(value)) return null;
  if (!isString(value.stagingId) || !UUID.test(value.stagingId)) return null;
  if (!isNullableString(value.fileName)) return null;
  if (!isNullableString(value.nodeName)) return null;
  if (!isNullableString(value.exportedAt)) return null;
  return {
    ...lookup,
    stagingId: value.stagingId as StagingId,
    fileName: value.fileName,
    nodeName: value.nodeName,
    exportedAt: value.exportedAt,
  };
}
