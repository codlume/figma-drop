import type { ExportPayload } from '@figma-drop/export-contract/parser';
import type { ExportTarget, RawExport, SandboxToUi, UiToSandbox } from '../shared/messages.ts';
import { encodeExport } from './payload.ts';
import { readingNodeId, reduce, type Run, type RunEvent } from './run.ts';
import type { ReceiverProbe, SendOutcome } from './transport.ts';

export type ReceiverStatus = 'checking' | ReceiverProbe;

export type Selection = { targets: ExportTarget[]; hasFileKey: boolean };

export type Panel = {
  // Null until the sandbox reports its first selection.
  selection: Selection | null;
  receiver: ReceiverStatus;
  run: Run;
};

export type SessionDeps = {
  postToSandbox: (message: UiToSandbox) => void;
  sendExport: (payload: ExportPayload) => Promise<SendOutcome>;
  probeReceiver: () => Promise<ReceiverProbe>;
  onChange: (panel: Panel) => void;
};

function receiverAfter(outcome: SendOutcome, status: ReceiverStatus): ReceiverStatus {
  switch (outcome.kind) {
    case 'saved':
    case 'rejected':
    case 'bad-reply':
      return 'online';
    case 'unreachable':
      return 'offline';
    case 'timed-out':
      return status;
  }
}

// The one owner of plugin state. Figma, the DOM and the network stay behind deps.
export function createSession(deps: SessionDeps) {
  let panel: Panel = { selection: null, receiver: 'checking', run: { phase: 'idle' } };
  let latestReceiverReport = 0;

  function update(change: Partial<Panel>) {
    panel = { ...panel, ...change };
    deps.onChange(panel);
  }

  function apply(event: RunEvent) {
    const wasReading = readingNodeId(panel.run);
    update({ run: reduce(panel.run, event) });
    const reading = readingNodeId(panel.run);
    if (reading !== null && reading !== wasReading) {
      deps.postToSandbox({ type: 'export-node', nodeId: reading });
    }
  }

  async function checkReceiver() {
    latestReceiverReport += 1;
    const report = latestReceiverReport;
    update({ receiver: 'checking' });
    const receiver = await deps.probeReceiver();
    if (report === latestReceiverReport) update({ receiver });
  }

  async function deliver(nodeId: string, raw: RawExport) {
    apply({ type: 'node-read', nodeId });
    let outcome: SendOutcome;
    try {
      outcome = await deps.sendExport(encodeExport(raw));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      apply({ type: 'node-failed', nodeId, message });
      return;
    }
    // A send outcome is newer evidence than a probe still in flight.
    latestReceiverReport += 1;
    update({ receiver: receiverAfter(outcome, panel.receiver) });
    apply({ type: 'send-finished', nodeId, outcome });
  }

  return {
    start() {
      deps.onChange(panel);
      deps.postToSandbox({ type: 'ui-ready' });
      void checkReceiver();
    },
    checkReceiver,
    exportSelection() {
      apply({ type: 'started', targets: panel.selection?.targets ?? [] });
    },
    retry() {
      apply({ type: 'retried' });
    },
    dismiss() {
      apply({ type: 'dismissed' });
    },
    receive(message: SandboxToUi) {
      switch (message.type) {
        case 'selection': {
          const { targets, hasFileKey } = message;
          update({ selection: { targets, hasFileKey } });
          return;
        }
        case 'node-exported':
          if (readingNodeId(panel.run) === message.nodeId)
            void deliver(message.nodeId, message.raw);
          return;
        case 'node-failed':
          apply({ type: 'node-failed', nodeId: message.nodeId, message: message.message });
          return;
      }
    },
  };
}
