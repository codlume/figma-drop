import { RECEIVER_PORT } from '@figma-drop/export-contract';
import type { ExportTarget } from '../shared/messages.ts';
import { retryableCount, type FailureReason, type Item, type ItemState, type Run } from './run.ts';
import type { Panel, ReceiverStatus, Selection } from './session.ts';

export type Tone = 'success' | 'warning' | 'danger';

export type RowView = {
  id: string;
  name: string;
  state: ItemState['kind'];
  label: string;
  // A receipt path or a failure explanation. Either may be received text.
  detail: string | null;
};

export type PanelView = {
  receiver: { status: ReceiverStatus; text: string; hint: string | null };
  selection: { title: string; detail: string | null };
  unidentifiedNote: string | null;
  rows: RowView[];
  notice: { tone: Tone; text: string } | null;
  primary: { label: string; action: 'export' | 'retry' | null };
  canDismiss: boolean;
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

const STATE_LABEL: Record<ItemState['kind'], string> = {
  queued: 'Queued',
  reading: 'Reading',
  sending: 'Sending',
  saved: 'Saved',
  failed: 'Failed',
  'not-sent': 'Not sent',
};

const RECEIVER_VIEW: Record<ReceiverStatus, PanelView['receiver']> = {
  checking: { status: 'checking', text: 'Looking for figma-drop', hint: null },
  online: { status: 'online', text: 'figma-drop is ready', hint: null },
  offline: {
    status: 'offline',
    text: 'figma-drop is not answering',
    hint: 'Open figma-drop and turn its receiver on.',
  },
};

function describeFailure(reason: FailureReason): string {
  switch (reason.kind) {
    case 'export-failed':
      return `This layer could not be exported: ${reason.message}`;
    case 'rejected':
      if (reason.message !== null) return reason.message;
      if (reason.status === 413) return 'This export is too large for figma-drop to accept.';
      return reason.status >= 500
        ? `figma-drop could not save this export (HTTP ${reason.status}).`
        : `figma-drop refused this export (HTTP ${reason.status}).`;
    case 'bad-reply':
      return `Something answered on port ${RECEIVER_PORT} without confirming a save. Check that figma-drop is the app using that port.`;
    case 'unreachable':
      return 'figma-drop could not be reached.';
    case 'timed-out':
      return 'figma-drop did not reply in time. This export may still have been saved.';
  }
}

function describeRow({ target, state }: Item): RowView {
  const detail =
    state.kind === 'saved'
      ? state.path
      : state.kind === 'failed'
        ? describeFailure(state.reason)
        : null;
  return {
    id: target.id,
    name: target.name,
    state: state.kind,
    label: STATE_LABEL[state.kind],
    detail,
  };
}

function describeSelection(selection: Selection | null): PanelView['selection'] {
  if (selection === null) return { title: 'Reading your selection', detail: null };
  const [first, ...rest] = selection.targets;
  if (first === undefined) {
    return { title: 'Nothing selected', detail: 'Select at least one layer to export it.' };
  }
  if (rest.length === 0) return { title: first.name, detail: typeLabel(first) };
  return {
    title: `${selection.targets.length} layers selected`,
    detail: selection.targets.map(({ name }) => name).join(', '),
  };
}

function typeLabel({ type }: ExportTarget): string {
  const words = type.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function failureKind(items: Item[], kind: FailureReason['kind']): boolean {
  return items.some(({ state }) => state.kind === 'failed' && state.reason.kind === kind);
}

function describeOutcome(items: Item[]): PanelView['notice'] {
  const total = items.length;
  const savedCount = items.filter(({ state }) => state.kind === 'saved').length;
  if (savedCount === total) {
    return {
      tone: 'success',
      text: total === 1 ? 'Saved to figma-drop.' : `All ${total} saved to figma-drop.`,
    };
  }

  const progress = savedCount === 0 ? 'Nothing was saved.' : `${savedCount} of ${total} saved.`;
  const tone: Tone = savedCount === 0 ? 'danger' : 'warning';
  if (failureKind(items, 'unreachable')) {
    return { tone, text: `${progress} Open figma-drop, turn its receiver on, then retry.` };
  }
  if (failureKind(items, 'timed-out')) {
    return {
      tone,
      text: `${progress} figma-drop stopped replying. Check that it is running, then retry. Retrying will not save a duplicate.`,
    };
  }
  return { tone, text: `${progress} See each row for the reason, then retry.` };
}

function exportAction(selection: Selection | null): PanelView['primary'] {
  const count = selection?.targets.length ?? 0;
  if (count === 0) return { label: 'Export', action: null };
  return { label: count === 1 ? 'Export layer' : `Export ${count} layers`, action: 'export' };
}

function runningLabel(items: Item[]): string {
  const position = items.findIndex(
    ({ state }) => state.kind === 'reading' || state.kind === 'sending',
  );
  return `Exporting ${position + 1} of ${items.length}`;
}

function describeAction(run: Run, selection: Selection | null): PanelView['primary'] {
  if (run.phase === 'running') return { label: runningLabel(run.items), action: null };
  const retryable = retryableCount(run);
  if (retryable > 0) return { label: `Retry ${plural(retryable, 'layer')}`, action: 'retry' };
  return exportAction(selection);
}

export function describePanel({ selection, receiver, run }: Panel): PanelView {
  const hasTargets = (selection?.targets.length ?? 0) > 0;
  return {
    receiver: RECEIVER_VIEW[receiver],
    selection: describeSelection(selection),
    unidentifiedNote:
      selection !== null && hasTargets && !selection.hasFileKey
        ? 'Figma gave no key for this file. Exports still save, but they go to Unidentified in figma-drop instead of a project.'
        : null,
    rows: run.phase === 'idle' ? [] : run.items.map(describeRow),
    notice: run.phase === 'finished' ? describeOutcome(run.items) : null,
    primary: describeAction(run, selection),
    canDismiss: retryableCount(run) > 0,
  };
}
