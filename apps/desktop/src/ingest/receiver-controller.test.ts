import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import type { ForkedProcess, ReceiverLibrary } from '../shared/integration';
import type { ReceiverStatus } from '../shared/receiver';
import { runReceiverChild } from './receiver-child';
import type { ChildOptions, ReceiverChild } from './receiver-child';
import { createReceiverController, parseChildMessage } from './receiver-controller';
import type { ControllerTuning } from './receiver-controller';
import { MAX_IDENTITY_CHARS } from './receiver-protocol';
import type { ChildMessage, MainMessage } from './receiver-protocol';
import {
  PLUGIN_HEADERS,
  closeServer,
  committed,
  deferred,
  freePort,
  listenOn,
  request,
  scratchDir,
  syncRequest,
  validPayload,
} from './test-http';

type Listener<T> = (value: T) => void;

// Runs the real child loop in this process, with messages delivered on a later
// tick as a real port would, and `kill` as an abrupt close followed by exit.
class InProcessFork implements ForkedProcess {
  private readonly messageListeners: Listener<unknown>[] = [];
  private readonly exitListeners: Listener<number>[] = [];
  private readonly childListeners: Listener<MainMessage>[] = [];
  readonly child: ReceiverChild;
  exited = false;

  constructor(options: ChildOptions) {
    this.child = runReceiverChild(
      {
        post: (message) => setImmediate(() => this.emitMessage(message)),
        onMessage: (listener) => this.childListeners.push(listener),
        exit: (code) => this.emitExit(code),
      },
      options,
    );
  }

  postMessage(message: unknown): void {
    if (this.exited) return;
    setImmediate(() => {
      for (const listener of this.childListeners) listener(message as MainMessage);
    });
  }

  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'message' | 'exit', listener: Listener<never>): unknown {
    if (event === 'message') this.messageListeners.push(listener as Listener<unknown>);
    else this.exitListeners.push(listener as Listener<number>);
    return this;
  }

  kill(): boolean {
    void this.child.close().then(() => this.emitExit(137));
    return true;
  }

  private emitMessage(message: ChildMessage): void {
    for (const listener of this.messageListeners) listener(message);
  }

  private emitExit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(code);
  }
}

class ScriptedFork implements ForkedProcess {
  readonly posted: MainMessage[] = [];
  private readonly messageListeners: Listener<unknown>[] = [];
  private readonly exitListeners: Listener<number>[] = [];
  readonly killed = deferred<void>();
  kills = 0;
  exited = false;
  exitOnKill: boolean;

  constructor(exitOnKill = true) {
    this.exitOnKill = exitOnKill;
  }

  postMessage(message: unknown): void {
    if (this.exited) return;
    this.posted.push(message as MainMessage);
  }

  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'message' | 'exit', listener: Listener<never>): unknown {
    if (event === 'message') this.messageListeners.push(listener as Listener<unknown>);
    else this.exitListeners.push(listener as Listener<number>);
    return this;
  }

  kill(): boolean {
    this.kills += 1;
    this.killed.resolve();
    if (this.exitOnKill) this.exit(137);
    return true;
  }

  send(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }

  exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(code);
  }

  lastReply(): Extract<MainMessage, { type: 'reply' }> | undefined {
    return this.posted.findLast((m) => m.type === 'reply') as
      | Extract<MainMessage, { type: 'reply' }>
      | undefined;
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function fakeLibrary(
  stagingDir: string,
  overrides: Partial<ReceiverLibrary> = {},
): ReceiverLibrary & { commits: number } {
  const library = {
    stagingDir,
    commits: 0,
    commit: async () => {
      library.commits += 1;
      return committed('r1');
    },
    findExport: async () => null,
    ...overrides,
  };
  return library;
}

async function realController(
  options: {
    library?: Partial<ReceiverLibrary>;
    tuning?: ControllerTuning;
    child?: ChildOptions;
    port?: number;
  } = {},
) {
  const scratch = await scratchDir();
  const port = options.port ?? (await freePort());
  const forks: InProcessFork[] = [];
  const library = fakeLibrary(scratch.dir, options.library);
  const statuses: ReceiverStatus[] = [];
  const controller = createReceiverController(
    {
      entry: 'in-process',
      port,
      library,
      fork: () => {
        const fork = new InProcessFork(options.child ?? {});
        forks.push(fork);
        return fork;
      },
      onFocus: async (path) => path === '/library/r1/bundle',
    },
    options.tuning,
  );
  controller.onStatus((status) => statuses.push(status));
  cleanups.push(async () => {
    await controller.stop();
    await Promise.all(forks.map((fork) => fork.child.close()));
    await scratch.cleanup();
  });
  return { controller, port, library, forks, statuses };
}

function scriptedController(tuning: ControllerTuning | 'defaults' = {}, exitOnKill = true) {
  const forks: ScriptedFork[] = [];
  const forkWaiters: Array<() => void> = [];
  // Operations run on the serialized queue, so a fork lands on a later tick.
  const forked = (index: number) =>
    new Promise<ScriptedFork>((resolve) => {
      const check = () => {
        const fork = forks[index];
        if (fork) resolve(fork);
        else forkWaiters.push(check);
      };
      check();
    });
  const statuses: ReceiverStatus[] = [];
  const library = {
    stagingDir: '/nowhere',
    commits: [] as unknown[],
    commit: async (staged: unknown) => {
      library.commits.push(staged);
      return committed('r1');
    },
    findExport: async () => null,
  };
  const controller = createReceiverController(
    {
      entry: 'scripted',
      port: 4000,
      library,
      fork: () => {
        const fork = new ScriptedFork(exitOnKill);
        forks.push(fork);
        for (const waiter of forkWaiters.splice(0)) waiter();
        return fork;
      },
      onFocus: async (path) => {
        if (path === 'boom') throw new Error('focus exploded');
        return path === 'known';
      },
    },
    tuning === 'defaults' ? undefined : { stopTimeoutMs: 50, ...tuning },
  );
  controller.onStatus((status) => statuses.push(status));
  return { controller, forks, forked, statuses, library };
}

function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('error', () => resolve(true));
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('controller with the real child', () => {
  it('starts, serves /sync through main, stops, and frees the port', async () => {
    const { controller, port, library, statuses } = await realController();
    await controller.start();
    expect(controller.status()).toEqual({ state: 'listening', port });

    const reply = await syncRequest(port, validPayload());
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ path: '/library/r1/bundle' });
    expect(library.commits).toBe(1);

    const open = await request({
      port,
      method: 'POST',
      path: '/open',
      headers: PLUGIN_HEADERS,
      body: JSON.stringify({ path: '/library/r1/bundle' }),
    });
    expect(open.status).toBe(200);

    await controller.stop();
    expect(controller.status()).toEqual({ state: 'off' });
    expect(await refused(port)).toBe(true);
    expect(statuses.map((status) => status.state)).toEqual([
      'starting',
      'listening',
      'stopping',
      'off',
    ]);
  });

  it('turns a library throw into a save failure for the client', async () => {
    const { controller, port } = await realController({
      library: {
        commit: async () => {
          throw new Error('library exploded');
        },
      },
    });
    await controller.start();
    const reply = await syncRequest(port, validPayload());
    expect(reply.status).toBe(500);
    expect(reply.body).not.toContain('exploded');
  });

  it('reports a port conflict with the holder and leaves it running', async () => {
    const port = await freePort();
    const foreign = await listenOn('127.0.0.1', port);
    cleanups.push(() => closeServer(foreign));
    const { controller, forks } = await realController({ port });
    await controller.start();
    expect(controller.status()).toMatchObject({
      state: 'port-conflict',
      port,
      holder: { pid: process.pid },
    });
    expect((await request({ port })).body).toBe('foreign');
    await controller.stop();
    expect(controller.status()).toEqual({ state: 'off' });
    expect(forks).toHaveLength(1);
  });

  it('converges on the last request under rapid toggling and treats start while listening as a no-op', async () => {
    const { controller, port, forks } = await realController();
    void controller.start();
    void controller.stop();
    await controller.start();
    expect(controller.status()).toEqual({ state: 'listening', port });
    expect((await request({ port, path: '/' })).status).toBe(200);
    const forkCount = forks.length;
    await controller.start();
    expect(forks).toHaveLength(forkCount);
    expect(controller.status()).toEqual({ state: 'listening', port });

    void controller.stop();
    void controller.start();
    await controller.stop();
    expect(controller.status()).toEqual({ state: 'off' });
    expect(await refused(port)).toBe(true);
  });

  it('waits for the in-flight export on stop and then cuts the rest', async () => {
    const hung = deferred<ReturnType<typeof committed>>();
    const { controller, port } = await realController({
      library: { commit: () => hung.promise },
      child: { stopGraceMs: 100 },
      tuning: { stopTimeoutMs: 2000 },
    });
    await controller.start();
    const inFlight = syncRequest(port, validPayload()).catch((error: Error) => error);
    await settle();
    await controller.stop();
    expect(controller.status()).toEqual({ state: 'off' });
    expect(await inFlight).toBeInstanceOf(Error);
    hung.resolve(committed('r1'));
  });
});

describe('controller with a scripted child', () => {
  it('forks again on a crash and gives up after the third exit in the window', async () => {
    const { controller, forks, forked, statuses } = scriptedController({
      restartWindowMs: 60_000,
      maxExitsInWindow: 3,
    });
    const starting = controller.start();
    await forked(0);
    forks[0]!.send({ type: 'status', status: { state: 'listening', port: 4000 } });
    forks[0]!.exit(1);
    await forked(1);
    expect(controller.status()).toEqual({ state: 'starting' });
    forks[1]!.exit(1);
    await forked(2);
    forks[2]!.exit(1);
    await starting;
    expect(controller.status()).toMatchObject({ state: 'failed' });
    expect(forks).toHaveLength(3);
    expect(statuses.map((status) => status.state)).toEqual([
      'starting',
      'listening',
      'starting',
      'failed',
    ]);

    const again = controller.start();
    await forked(3);
    forks[3]!.send({ type: 'status', status: { state: 'listening', port: 4000 } });
    await again;
    expect(controller.status()).toEqual({ state: 'listening', port: 4000 });
  });

  it('does not restart after a reported conflict or failure', async () => {
    const { controller, forks, forked } = scriptedController();
    const starting = controller.start();
    await forked(0);
    forks[0]!.send({ type: 'status', status: { state: 'port-conflict', port: 4000 } });
    forks[0]!.exit(0);
    await starting;
    expect(controller.status()).toEqual({ state: 'port-conflict', port: 4000 });
    expect(forks).toHaveLength(1);
    await controller.stop();
    expect(controller.status()).toEqual({ state: 'off' });
  });

  it('kills a child whose parse never ends', async () => {
    const { controller, forks, forked } = scriptedController({ parseDeadlineMs: 30 });
    const starting = controller.start();
    await forked(0);
    forks[0]!.send({ type: 'status', status: { state: 'listening', port: 4000 } });
    await starting;
    forks[0]!.send({ type: 'parse-start' });
    forks[0]!.send({ type: 'parse-end' });
    forks[0]!.send({ type: 'parse-start' });
    await forks[0]!.killed.promise;
    await forked(1);
    expect(controller.status()).toEqual({ state: 'starting' });
  });

  it('kills a child that ignores stop', async () => {
    const { controller, forks, forked } = scriptedController({ stopTimeoutMs: 20 }, false);
    const starting = controller.start();
    await forked(0);
    forks[0]!.send({ type: 'status', status: { state: 'listening', port: 4000 } });
    await starting;
    await controller.stop();
    await forks[0]!.killed.promise;
    expect(controller.status()).toEqual({ state: 'off' });
  });

  it('answers calls from the library and drops malformed messages before they reach it', async () => {
    const { controller, forks, forked, library } = scriptedController();
    const starting = controller.start();
    await forked(0);
    const fork = forks[0]!;
    fork.send({ type: 'status', status: { state: 'listening', port: 4000 } });
    await starting;

    const staged = {
      stagingId: '123e4567-e89b-12d3-a456-426614174000',
      identity: { kind: 'file', fileKey: 'abc' },
      figmaNodeId: '1:2',
      contentHash: 'a'.repeat(64),
      fileName: null,
      nodeName: 'Frame',
      exportedAt: null,
    };
    for (const junk of [
      null,
      'string',
      {
        type: 'call',
        callId: 1,
        call: { method: 'commit', staged: { ...staged, stagingId: '../etc' } },
      },
      {
        type: 'call',
        callId: 2,
        call: { method: 'commit', staged: { ...staged, contentHash: 'zz' } },
      },
      {
        type: 'call',
        callId: 3,
        call: { method: 'commit', staged: { ...staged, identity: { kind: 'file', fileKey: '' } } },
      },
      { type: 'call', callId: 'x', call: { method: 'commit', staged } },
      { type: 'call', callId: 4, call: { method: 'trash', path: '/' } },
      { type: 'status', status: { state: 'listening', port: 'none' } },
      { type: 'status', status: { state: 'off' } },
    ]) {
      fork.send(junk);
    }
    await settle();
    expect(library.commits).toEqual([]);
    expect(fork.lastReply()).toBeUndefined();
    expect(controller.status()).toEqual({ state: 'listening', port: 4000 });

    fork.send({
      type: 'call',
      callId: 7,
      call: { method: 'commit', staged: { ...staged, __proto__: { extra: 1 }, extra: 'dropped' } },
    });
    await settle();
    expect(library.commits).toEqual([staged]);
    expect(fork.lastReply()).toEqual({
      type: 'reply',
      callId: 7,
      result: { method: 'commit', result: committed('r1') },
    });

    fork.send({ type: 'call', callId: 8, call: { method: 'focus', path: 'known' } });
    await settle();
    expect(fork.lastReply()).toEqual({
      type: 'reply',
      callId: 8,
      result: { method: 'focus', result: 'found' },
    });
    fork.send({ type: 'call', callId: 9, call: { method: 'focus', path: 'boom' } });
    await settle();
    expect(fork.lastReply()).toEqual({
      type: 'reply',
      callId: 9,
      result: { method: 'focus', result: 'failed' },
    });
  });

  it('emits a status only when it changes', async () => {
    const { controller, forks, forked, statuses } = scriptedController();
    const starting = controller.start();
    await forked(0);
    forks[0]!.send({ type: 'status', status: { state: 'listening', port: 4000 } });
    forks[0]!.send({ type: 'status', status: { state: 'listening', port: 4000 } });
    await starting;
    expect(statuses).toEqual([{ state: 'starting' }, { state: 'listening', port: 4000 }]);
  });
});

describe('parseChildMessage', () => {
  it('accepts each message shape and rebuilds it without extra fields', () => {
    expect(parseChildMessage({ type: 'parse-start', extra: 1 })).toEqual({ type: 'parse-start' });
    expect(
      parseChildMessage({
        type: 'status',
        status: {
          state: 'port-conflict',
          port: 3579,
          holder: { pid: 12, command: 'node', junk: true },
        },
      }),
    ).toEqual({
      type: 'status',
      status: { state: 'port-conflict', port: 3579, holder: { pid: 12, command: 'node' } },
    });
    expect(
      parseChildMessage({
        type: 'call',
        callId: 3,
        call: {
          method: 'findExport',
          lookup: {
            identity: { kind: 'unidentified', claimedKey: null },
            figmaNodeId: '1:2',
            contentHash: 'b'.repeat(64),
          },
        },
      }),
    ).toEqual({
      type: 'call',
      callId: 3,
      call: {
        method: 'findExport',
        lookup: {
          identity: { kind: 'unidentified', claimedKey: null },
          figmaNodeId: '1:2',
          contentHash: 'b'.repeat(64),
        },
      },
    });
  });

  it('rejects statuses the child must not report and malformed holders', () => {
    expect(parseChildMessage({ type: 'status', status: { state: 'starting' } })).toBeNull();
    expect(
      parseChildMessage({
        type: 'status',
        status: { state: 'port-conflict', port: 1, holder: { pid: 'x' } },
      }),
    ).toBeNull();
    expect(parseChildMessage({ type: 'status', status: { state: 'failed' } })).toBeNull();
  });
});

async function listeningScripted(exitOnKill = true) {
  const scripted = scriptedController('defaults', exitOnKill);
  const starting = scripted.controller.start();
  const fork = await scripted.forked(0);
  fork.send({ type: 'status', status: { state: 'listening', port: 4000 } });
  await starting;
  return { ...scripted, fork };
}

function fakeClock(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

function fireNextTimer(): number {
  const before = Date.now();
  vi.advanceTimersToNextTimer();
  return Date.now() - before;
}

describe('controller timing at the default tuning', () => {
  fakeClock();

  it('kills a child 30 s into a parse', async () => {
    const { controller, fork, forked } = await listeningScripted();
    fork.send({ type: 'parse-start' });
    expect(fork.kills).toBe(0);
    expect(fireNextTimer()).toBe(30_000);
    expect(fork.kills).toBe(1);
    await forked(1);
    expect(controller.status()).toEqual({ state: 'starting' });
  });

  it('disarms the watchdog at parse-end and gives the next parse a full 30 s', async () => {
    const { fork } = await listeningScripted();
    fork.send({ type: 'parse-start' });
    vi.advanceTimersByTime(29_999);
    fork.send({ type: 'parse-end' });
    expect(vi.getTimerCount()).toBe(0);
    fork.send({ type: 'parse-start' });
    expect(fireNextTimer()).toBe(30_000);
    expect(fork.kills).toBe(1);
  });

  it('kills a child that ignores stop after 7 s and ends at off 7 s after the kill', async () => {
    const { controller, fork } = await listeningScripted(false);
    const stopping = controller.stop();
    await settle();
    expect(fork.posted.at(-1)).toEqual({ type: 'stop' });
    expect(fork.kills).toBe(0);
    expect(fireNextTimer()).toBe(7000);
    await fork.killed.promise;
    expect(controller.status()).toEqual({ state: 'stopping' });
    expect(fireNextTimer()).toBe(7000);
    await stopping;
    expect(controller.status()).toEqual({ state: 'off' });
    expect(fork.kills).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends the stop when the killed child exits, with no timer left', async () => {
    const { controller, fork } = await listeningScripted();
    const stopping = controller.stop();
    await settle();
    expect(fireNextTimer()).toBe(7000);
    await stopping;
    expect(controller.status()).toEqual({ state: 'off' });
    expect(fork.kills).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends the stop when the child exits on its own, with no kill and no timer left', async () => {
    const { controller, fork } = await listeningScripted();
    const stopping = controller.stop();
    await settle();
    fork.exit(0);
    await stopping;
    expect(controller.status()).toEqual({ state: 'off' });
    expect(fork.kills).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops with no timer when no child is running', async () => {
    const { controller, forked } = scriptedController('defaults');
    await controller.stop();
    expect(vi.getTimerCount()).toBe(0);
    const starting = controller.start();
    const fork = await forked(0);
    fork.send({ type: 'status', status: { state: 'port-conflict', port: 4000 } });
    await starting;
    expect(controller.status()).toEqual({ state: 'port-conflict', port: 4000 });
    await controller.stop();
    expect(controller.status()).toEqual({ state: 'off' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up on the third exit inside 60 s', async () => {
    const { controller, forks } = await listeningScripted();
    forks[0]!.exit(1);
    vi.advanceTimersByTime(1);
    forks[1]!.exit(1);
    vi.advanceTimersByTime(59_998);
    expect(controller.status()).toEqual({ state: 'starting' });
    forks[2]!.exit(1);
    expect(controller.status()).toMatchObject({ state: 'failed' });
    expect(forks).toHaveLength(3);
  });

  it('forgets an exit once it is 60 s old', async () => {
    const { controller, forks } = await listeningScripted();
    forks[0]!.exit(1);
    vi.advanceTimersByTime(1);
    forks[1]!.exit(1);
    vi.advanceTimersByTime(59_999);
    forks[2]!.exit(1);
    expect(controller.status()).toEqual({ state: 'starting' });
    forks[3]!.exit(1);
    expect(controller.status()).toMatchObject({ state: 'failed' });
    expect(forks).toHaveLength(4);
  });
});

async function listeningChild() {
  const scratch = await scratchDir();
  const port = await freePort();
  const listening = deferred<void>();
  const committing = deferred<void>();
  const exit = deferred<number>();
  let deliver!: (message: MainMessage) => void;
  const child = runReceiverChild({
    post: (message) => {
      if (message.type === 'status' && message.status.state === 'listening') listening.resolve();
      if (message.type !== 'call') return;
      if (message.call.method === 'commit') return committing.resolve();
      deliver({
        type: 'reply',
        callId: message.callId,
        result: { method: 'findExport', result: null },
      });
    },
    onMessage: (listener) => {
      deliver = listener;
    },
    exit: (code) => exit.resolve(code),
  });
  cleanups.push(async () => {
    await child.close();
    await scratch.cleanup();
  });
  deliver({ type: 'start', port, stagingDir: scratch.dir });
  await listening.promise;
  return { port, deliver, committing, exit };
}

describe('child stop grace at the default tuning', () => {
  fakeClock();

  it('exits 0 at once when nothing is in flight, with no timer left', async () => {
    const { deliver, exit } = await listeningChild();
    deliver({ type: 'stop' });
    expect(await exit.promise).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives a hung commit 5 s, then cuts the request and exits 0', async () => {
    const { port, deliver, committing, exit } = await listeningChild();
    const inFlight = syncRequest(port, validPayload()).catch((error: Error) => error);
    await committing.promise;
    deliver({ type: 'stop' });
    expect(fireNextTimer()).toBe(5000);
    expect(await exit.promise).toBe(0);
    expect(await inFlight).toBeInstanceOf(Error);
  });
});

describe('child stop during a bind', () => {
  it('exits when the bind fails after a stop arrived, rather than idling until killed', async () => {
    const port = await freePort();
    const foreign = await listenOn('127.0.0.1', port);
    const exit = deferred<number>();
    let deliver: (message: MainMessage) => void = () => {};
    runReceiverChild({
      post: () => {},
      onMessage: (listener) => {
        deliver = listener;
      },
      exit: (code) => exit.resolve(code),
    });

    deliver({ type: 'start', port, stagingDir: '/nonexistent' });
    deliver({ type: 'stop' });

    expect(await exit.promise).toBe(0);
    await closeServer(foreign);
  });
});

const staged = {
  stagingId: '00000000-0000-4000-8000-000000000000',
  identity: { kind: 'file', fileKey: 'key' },
  figmaNodeId: '1:2',
  contentHash: 'a'.repeat(64),
  fileName: 'File',
  nodeName: 'Node',
  exportedAt: null,
};
const commit = (overrides: Record<string, unknown>) => ({
  type: 'call',
  callId: 1,
  call: { method: 'commit', staged: { ...staged, ...overrides } },
});

describe('parseChildMessage on hostile shapes', () => {
  const lookup = {
    identity: { kind: 'file', fileKey: 'key' },
    figmaNodeId: '1:2',
    contentHash: 'a'.repeat(64),
  };
  const find = (overrides: Record<string, unknown>) => ({
    type: 'call',
    callId: 1,
    call: { method: 'findExport', lookup: { ...lookup, ...overrides } },
  });

  it.each([
    ['an array carrying a type', Object.assign([], { type: 'parse-start' })],
    ['an unknown type', { type: 'restart' }],
    ['a fractional call id', { ...find({}), callId: 1.5 }],
    ['a call with no body', { type: 'call', callId: 1 }],
    ['port zero', { type: 'status', status: { state: 'listening', port: 0 } }],
    ['a port past the range', { type: 'status', status: { state: 'listening', port: 65_536 } }],
    ['a fractional port', { type: 'status', status: { state: 'port-conflict', port: 80.5 } }],
    [
      'a fractional holder pid',
      {
        type: 'status',
        status: { state: 'port-conflict', port: 80, holder: { pid: 1.5, command: 'n' } },
      },
    ],
    ['an empty node id', find({ figmaNodeId: '' })],
    ['an uppercase hash', find({ contentHash: 'A'.repeat(64) })],
    ['a long hash', find({ contentHash: 'a'.repeat(65) })],
    ['an unknown identity kind', find({ identity: { kind: 'team', fileKey: 'key' } })],
    ['a file identity with a null key', find({ identity: { kind: 'file', fileKey: null } })],
    ['an unidentified export with no claimed key', find({ identity: { kind: 'unidentified' } })],
    ['a numeric focus path', { type: 'call', callId: 1, call: { method: 'focus', path: 7 } }],
    ['an undefined display name', commit({ fileName: undefined })],
    ['an uppercase staging id', commit({ stagingId: staged.stagingId.replace('0', 'A') })],
    ['a staging id wrapped in an array', commit({ stagingId: [staged.stagingId] })],
  ])('drops %s', (_label, message) => {
    expect(parseChildMessage(message)).toBeNull();
  });

  it('keeps values at their bounds', () => {
    const atLimit = 'x'.repeat(MAX_IDENTITY_CHARS);
    for (const message of [
      { type: 'status', status: { state: 'listening', port: 1 } },
      { type: 'status', status: { state: 'port-conflict', port: 65_535 } },
      { type: 'status', status: { state: 'failed', message: 'x'.repeat(MAX_IDENTITY_CHARS + 1) } },
      { type: 'call', callId: 1, call: { method: 'focus', path: '' } },
      find({ identity: { kind: 'unidentified', claimedKey: '' } }),
      commit({ fileName: atLimit, nodeName: '', figmaNodeId: atLimit }),
    ]) {
      expect(parseChildMessage(message)).toEqual(message);
    }
  });
});

describe('parseChildMessage length bounds', () => {
  const oversized = 'x'.repeat(MAX_IDENTITY_CHARS + 1);

  it('accepts a well-formed commit', () => {
    expect(parseChildMessage(commit({}))).not.toBeNull();
  });

  it.each([
    ['figmaNodeId', { figmaNodeId: oversized }],
    ['fileName', { fileName: oversized }],
    ['nodeName', { nodeName: oversized }],
    ['exportedAt', { exportedAt: oversized }],
    ['fileKey', { identity: { kind: 'file', fileKey: oversized } }],
    ['claimedKey', { identity: { kind: 'unidentified', claimedKey: oversized } }],
  ])('drops an oversized %s from a child that bypassed its own checks', (_field, overrides) => {
    expect(parseChildMessage(commit(overrides))).toBeNull();
  });

  it('drops an oversized focus path', () => {
    const focus = { type: 'call', callId: 1, call: { method: 'focus', path: oversized } };
    expect(parseChildMessage(focus)).toBeNull();
  });
});
