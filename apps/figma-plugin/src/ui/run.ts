import type { ExportTarget } from '../shared/messages.ts';
import type { SendOutcome } from './transport.ts';

export type FailureReason =
  | Exclude<SendOutcome, { kind: 'saved' }>
  | { kind: 'export-failed'; message: string };

export type ItemState =
  | { kind: 'queued' }
  | { kind: 'reading' }
  | { kind: 'sending' }
  | Extract<SendOutcome, { kind: 'saved' }>
  | { kind: 'failed'; reason: FailureReason }
  | { kind: 'not-sent' };

export type Item = { target: ExportTarget; state: ItemState };

export type Run =
  | { phase: 'idle' }
  | { phase: 'running'; items: Item[] }
  | { phase: 'finished'; items: Item[] };

export type RunEvent =
  | { type: 'started'; targets: ExportTarget[] }
  | { type: 'retried' }
  | { type: 'dismissed' }
  | { type: 'node-read'; nodeId: string }
  | { type: 'node-failed'; nodeId: string; message: string }
  | { type: 'send-finished'; nodeId: string; outcome: SendOutcome };

const isRetryable = ({ state }: Item) => state.kind === 'failed' || state.kind === 'not-sent';

function advance(items: Item[]): Run {
  const next = items.findIndex(({ state }) => state.kind === 'queued');
  if (next === -1) return { phase: 'finished', items };
  return {
    phase: 'running',
    items: items.map((item, index) =>
      index === next ? { ...item, state: { kind: 'reading' } } : item,
    ),
  };
}

const replaceState = (items: Item[], nodeId: string, state: ItemState) =>
  items.map((item) => (item.target.id === nodeId ? { ...item, state } : item));

const markRestNotSent = (items: Item[]) =>
  items.map((item): Item =>
    item.state.kind === 'queued' ? { ...item, state: { kind: 'not-sent' } } : item,
  );

// The running items when `nodeId` is in one of `kinds`. Anything else is a stale
// event, and null tells the reducer to change nothing.
function itemsAwaiting(run: Run, nodeId: string, kinds: ItemState['kind'][]): Item[] | null {
  if (run.phase !== 'running') return null;
  const item = run.items.find(({ target }) => target.id === nodeId);
  return item !== undefined && kinds.includes(item.state.kind) ? run.items : null;
}

export function reduce(run: Run, event: RunEvent): Run {
  switch (event.type) {
    case 'started': {
      if (run.phase === 'running' || event.targets.length === 0) return run;
      return advance(event.targets.map((target) => ({ target, state: { kind: 'queued' } })));
    }
    case 'retried': {
      if (run.phase !== 'finished' || !run.items.some(isRetryable)) return run;
      return advance(
        run.items.map((item) =>
          isRetryable(item) ? { ...item, state: { kind: 'queued' } } : item,
        ),
      );
    }
    case 'dismissed':
      return run.phase === 'finished' ? { phase: 'idle' } : run;
    case 'node-read': {
      const items = itemsAwaiting(run, event.nodeId, ['reading']);
      if (items === null) return run;
      return { phase: 'running', items: replaceState(items, event.nodeId, { kind: 'sending' }) };
    }
    case 'node-failed': {
      const items = itemsAwaiting(run, event.nodeId, ['reading', 'sending']);
      if (items === null) return run;
      const reason = { kind: 'export-failed', message: event.message } as const;
      return advance(replaceState(items, event.nodeId, { kind: 'failed', reason }));
    }
    case 'send-finished': {
      const items = itemsAwaiting(run, event.nodeId, ['sending']);
      if (items === null) return run;
      const { outcome } = event;
      if (outcome.kind === 'saved') return advance(replaceState(items, event.nodeId, outcome));
      const settled = replaceState(items, event.nodeId, { kind: 'failed', reason: outcome });
      // Later POSTs would fail the same way, so they are not attempted.
      const receiverGone = outcome.kind === 'unreachable' || outcome.kind === 'timed-out';
      return advance(receiverGone ? markRestNotSent(settled) : settled);
    }
  }
}

export function readingNodeId(run: Run): string | null {
  if (run.phase !== 'running') return null;
  return run.items.find(({ state }) => state.kind === 'reading')?.target.id ?? null;
}

export function retryableCount(run: Run): number {
  return run.phase === 'finished' ? run.items.filter(isRetryable).length : 0;
}
