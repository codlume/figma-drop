import { describe, expect, it } from 'vite-plus/test';
import type { ExportTarget } from '../shared/messages.ts';
import {
  readingNodeId,
  reduce,
  retryableCount,
  type Item,
  type ItemState,
  type Run,
  type RunEvent,
} from './run.ts';
import type { SendOutcome } from './transport.ts';

const target = (id: string): ExportTarget => ({ id, name: `Layer ${id}`, type: 'FRAME' });
const targets = [target('a'), target('b'), target('c')];

const idle: Run = { phase: 'idle' };
const saved = (id: string): SendOutcome => ({ kind: 'saved', path: `/library/${id}` });

const play = (run: Run, ...events: RunEvent[]) => events.reduce(reduce, run);
const start = (...list: ExportTarget[]) => reduce(idle, { type: 'started', targets: list });
const read = (nodeId: string): RunEvent => ({ type: 'node-read', nodeId });
const sent = (nodeId: string, outcome: SendOutcome): RunEvent => ({
  type: 'send-finished',
  nodeId,
  outcome,
});
const unreadable = (nodeId: string): RunEvent => ({
  type: 'node-failed',
  nodeId,
  message: 'gone',
});

const items = (run: Run): Item[] => (run.phase === 'idle' ? [] : run.items);
const kinds = (run: Run) => items(run).map(({ state }) => state.kind);
const stateOf = (run: Run, id: string): ItemState | undefined =>
  items(run).find(({ target: { id: itemId } }) => itemId === id)?.state;

describe('starting', () => {
  it('queues every target and reads the first', () => {
    const run = start(...targets);
    expect(run.phase).toBe('running');
    expect(kinds(run)).toEqual(['reading', 'queued', 'queued']);
    expect(readingNodeId(run)).toBe('a');
  });

  it('stays idle with no targets', () => {
    expect(start()).toEqual(idle);
  });

  it('ignores a start while running', () => {
    const run = start(target('a'));
    expect(reduce(run, { type: 'started', targets })).toBe(run);
  });

  it('replaces a finished run', () => {
    const finished = play(start(target('a')), read('a'), sent('a', saved('a')));
    const run = reduce(finished, { type: 'started', targets: [target('b')] });
    expect(items(run).map((item) => item.target.id)).toEqual(['b']);
  });
});

describe('one item at a time', () => {
  it('moves from reading to sending', () => {
    expect(kinds(play(start(...targets), read('a')))).toEqual(['sending', 'queued', 'queued']);
  });

  it('starts the next item when one is saved', () => {
    const run = play(start(...targets), read('a'), sent('a', saved('a')));
    expect(stateOf(run, 'a')).toEqual({ kind: 'saved', path: '/library/a' });
    expect(readingNodeId(run)).toBe('b');
  });

  it('keeps the preview path of a saved item', () => {
    const outcome: SendOutcome = { kind: 'saved', path: '/l/a', preview: '/l/a/preview.png' };
    const run = play(start(target('a')), read('a'), sent('a', outcome));
    expect(stateOf(run, 'a')).toEqual(outcome);
  });

  it('finishes after the last item', () => {
    const run = play(start(target('a')), read('a'), sent('a', saved('a')));
    expect(run.phase).toBe('finished');
    expect(readingNodeId(run)).toBeNull();
  });
});

describe('failures that leave the receiver working', () => {
  const rejected: SendOutcome = { kind: 'rejected', status: 500, message: 'disk is full' };
  const badReply: SendOutcome = { kind: 'bad-reply', status: 200 };

  it.each([
    ['rejected', rejected],
    ['bad-reply', badReply],
  ])('fails the item on %s and continues', (_name, outcome) => {
    const run = play(start(...targets), read('a'), sent('a', outcome));
    expect(stateOf(run, 'a')).toEqual({ kind: 'failed', reason: outcome });
    expect(readingNodeId(run)).toBe('b');
  });

  it('fails the item when the sandbox cannot read it and continues', () => {
    const run = play(start(...targets), unreadable('a'));
    expect(stateOf(run, 'a')).toEqual({
      kind: 'failed',
      reason: { kind: 'export-failed', message: 'gone' },
    });
    expect(readingNodeId(run)).toBe('b');
  });

  it('fails the item when encoding throws during sending and continues', () => {
    const run = play(start(...targets), read('a'), unreadable('a'));
    expect(stateOf(run, 'a')).toMatchObject({ kind: 'failed' });
    expect(readingNodeId(run)).toBe('b');
  });

  it('finishes when the last item fails', () => {
    expect(play(start(target('a')), unreadable('a')).phase).toBe('finished');
  });
});

describe('failures that mean the receiver is gone', () => {
  it.each<[string, SendOutcome]>([
    ['unreachable', { kind: 'unreachable' }],
    ['timed-out', { kind: 'timed-out' }],
  ])('fails the item on %s and stops the rest', (_name, outcome) => {
    const run = play(
      start(...targets),
      read('a'),
      sent('a', saved('a')),
      read('b'),
      sent('b', outcome),
    );
    expect(run.phase).toBe('finished');
    expect(kinds(run)).toEqual(['saved', 'failed', 'not-sent']);
    expect(stateOf(run, 'b')).toEqual({ kind: 'failed', reason: outcome });
  });

  it('marks every remaining item when the first one fails', () => {
    const run = play(start(...targets), read('a'), sent('a', { kind: 'unreachable' }));
    expect(kinds(run)).toEqual(['failed', 'not-sent', 'not-sent']);
  });
});

describe('every item ends terminal', () => {
  const terminal = ['saved', 'failed', 'not-sent'];
  const outcomes: SendOutcome[] = [
    saved('x'),
    { kind: 'rejected', status: 400, message: null },
    { kind: 'bad-reply', status: 204 },
    { kind: 'unreachable' },
    { kind: 'timed-out' },
  ];

  it.each(outcomes.flatMap((first) => outcomes.map((second) => [first, second] as const)))(
    'after %j then %j',
    (first, second) => {
      let run = start(...targets);
      const replies = [first, second, saved('last')];
      for (const reply of replies) {
        const nodeId = readingNodeId(run);
        if (nodeId === null) break;
        run = play(run, read(nodeId), sent(nodeId, reply));
      }
      expect(run.phase).toBe('finished');
      for (const kind of kinds(run)) expect(terminal).toContain(kind);
    },
  );
});

describe('stale events', () => {
  it('ignores a reply for an item that is not active', () => {
    const run = play(start(...targets), read('a'));
    expect(reduce(run, sent('b', saved('b')))).toBe(run);
    expect(reduce(run, read('b'))).toBe(run);
    expect(reduce(run, unreadable('c'))).toBe(run);
  });

  it('ignores a send result before the node was read', () => {
    const run = start(target('a'));
    expect(reduce(run, sent('a', saved('a')))).toBe(run);
  });

  it('ignores a repeated reply after the item settled', () => {
    const run = play(start(...targets), read('a'), sent('a', saved('a')));
    expect(reduce(run, unreadable('a'))).toBe(run);
  });

  it('ignores node events once the run is over', () => {
    const run = play(start(target('a')), unreadable('a'));
    expect(reduce(run, read('a'))).toBe(run);
    expect(reduce(idle, unreadable('a'))).toBe(idle);
  });
});

describe('retrying', () => {
  const partial = play(
    start(...targets),
    read('a'),
    sent('a', saved('a')),
    read('b'),
    sent('b', { kind: 'unreachable' }),
  );

  it('counts failed and not-sent items', () => {
    expect(retryableCount(partial)).toBe(2);
    expect(retryableCount(start(...targets))).toBe(0);
    expect(retryableCount(idle)).toBe(0);
  });

  it('keeps saved items and re-runs the rest in order', () => {
    const run = reduce(partial, { type: 'retried' });
    expect(run.phase).toBe('running');
    expect(kinds(run)).toEqual(['saved', 'reading', 'queued']);
    expect(stateOf(run, 'a')).toEqual({ kind: 'saved', path: '/library/a' });
  });

  it('ends with everything saved after a good retry', () => {
    const run = play(
      partial,
      { type: 'retried' },
      read('b'),
      sent('b', saved('b')),
      read('c'),
      sent('c', saved('c')),
    );
    expect(run.phase).toBe('finished');
    expect(kinds(run)).toEqual(['saved', 'saved', 'saved']);
    expect(retryableCount(run)).toBe(0);
  });

  it('does nothing when nothing is retryable', () => {
    const run = play(start(target('a')), read('a'), sent('a', saved('a')));
    expect(reduce(run, { type: 'retried' })).toBe(run);
  });

  it('does nothing while running or idle', () => {
    const running = start(target('a'));
    expect(reduce(running, { type: 'retried' })).toBe(running);
    expect(reduce(idle, { type: 'retried' })).toBe(idle);
  });
});

describe('dismissing', () => {
  it('returns a finished run to idle', () => {
    const run = play(start(target('a')), unreadable('a'));
    expect(reduce(run, { type: 'dismissed' })).toEqual(idle);
  });

  it('does not abandon a running export', () => {
    const run = start(target('a'));
    expect(reduce(run, { type: 'dismissed' })).toBe(run);
  });
});
