import { bindListeners } from './listeners';
import type { Listeners } from './listeners';
import { findPortHolder } from './port-holder';
import type { PortHolder } from './port-holder';
import type {
  BackendCall,
  BackendResult,
  ChildMessage,
  MainMessage,
  ReceiverBackend,
} from './receiver-protocol';
import { createReceiverHandler } from './receiver-server';
import type { ReceiverHandler, ReceiverLimits } from './receiver-server';

// Structural view of the parent port, so tests drive the loop in-process.
export type ChildHost = {
  post(message: ChildMessage): void;
  onMessage(listener: (message: MainMessage) => void): void;
  exit(code: number): void;
};

export type ChildOptions = {
  limits?: Partial<ReceiverLimits>;
  // How long `stop` waits for the in-flight request before cutting connections.
  stopGraceMs?: number;
};

export type ReceiverChild = {
  // Abrupt teardown with nothing posted, the in-process stand-in for a kill.
  close(): Promise<void>;
};

type Phase =
  | { phase: 'idle' }
  | { phase: 'binding'; stopRequested: boolean }
  | { phase: 'running'; listeners: Listeners; handler: ReceiverHandler }
  | { phase: 'stopping' };

export function runReceiverChild(host: ChildHost, options: ChildOptions = {}): ReceiverChild {
  const stopGraceMs = options.stopGraceMs ?? 5000;
  let phase: Phase = { phase: 'idle' };
  let nextCallId = 1;
  const pending = new Map<number, (result: BackendResult) => void>();

  function invoke(call: BackendCall): Promise<BackendResult> {
    return new Promise((resolve) => {
      const callId = nextCallId++;
      pending.set(callId, resolve);
      host.post({ type: 'call', callId, call });
    });
  }

  // A reply that answers a different method is main's bug, and surfaces as the
  // same libraryUnavailable a missing reply does.
  const backend: ReceiverBackend = {
    commit: async (staged) => {
      const reply = await invoke({ method: 'commit', staged });
      if (reply.method !== 'commit') throw new Error('mismatched reply');
      return reply.result;
    },
    findExport: async (lookup) => {
      const reply = await invoke({ method: 'findExport', lookup });
      if (reply.method !== 'findExport') throw new Error('mismatched reply');
      return reply.result;
    },
    focus: async (path) => {
      const reply = await invoke({ method: 'focus', path });
      if (reply.method !== 'focus' || reply.result === 'failed') throw new Error('focus failed');
      return reply.result === 'found';
    },
  };

  async function start(port: number, stagingDir: string): Promise<void> {
    if (phase.phase !== 'idle') return;
    const binding: Extract<Phase, { phase: 'binding' }> = {
      phase: 'binding',
      stopRequested: false,
    };
    phase = binding;
    const handler = createReceiverHandler({
      port,
      stagingDir,
      backend,
      notify: (event) => host.post({ type: event }),
      ...(options.limits ? { limits: options.limits } : {}),
    });
    const bound = await bindListeners({
      port,
      handler: handler.handle,
      requestTimeoutMs: handler.requestTimeoutMs,
    });
    if (!bound.ok) {
      if (bound.reason === 'port-in-use') {
        const holder = await findPortHolder(port);
        host.post({ type: 'status', status: portConflict(port, holder) });
      } else {
        host.post({ type: 'status', status: { state: 'failed', message: bound.message } });
      }
      // Main ends this process once it has the status. An exit here could
      // outrun the message on the port and read as a crash.
      phase = { phase: 'idle' };
      return;
    }
    phase = { phase: 'running', listeners: bound.listeners, handler };
    if (binding.stopRequested) {
      await stop();
      return;
    }
    host.post({ type: 'status', status: { state: 'listening', port } });
  }

  async function stop(): Promise<void> {
    if (phase.phase === 'binding') {
      phase.stopRequested = true;
      return;
    }
    if (phase.phase !== 'running') return;
    const { listeners, handler } = phase;
    phase = { phase: 'stopping' };
    host.post({ type: 'status', status: { state: 'stopping' } });
    const closed = listeners.close();
    await Promise.race([handler.idle(), delay(stopGraceMs)]);
    listeners.closeAllConnections();
    await closed;
    host.exit(0);
  }

  host.onMessage((message) => {
    switch (message.type) {
      case 'start':
        void start(message.port, message.stagingDir);
        return;
      case 'stop':
        void stop();
        return;
      case 'reply': {
        const resolve = pending.get(message.callId);
        if (!resolve) return;
        pending.delete(message.callId);
        resolve(message.result);
        return;
      }
    }
  });

  return {
    close: async () => {
      if (phase.phase !== 'running') return;
      const { listeners } = phase;
      phase = { phase: 'idle' };
      const closed = listeners.close();
      listeners.closeAllConnections();
      await closed;
    },
  };
}

function portConflict(
  port: number,
  holder: PortHolder | undefined,
): Extract<ChildMessage, { type: 'status' }>['status'] {
  return holder ? { state: 'port-conflict', port, holder } : { state: 'port-conflict', port };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
