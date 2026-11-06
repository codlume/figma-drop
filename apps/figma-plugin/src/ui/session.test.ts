import type { ExportPayload } from '@figma-drop/export-contract/parser';
import { describe, expect, it } from 'vite-plus/test';
import type { ExportTarget, RawExport, UiToSandbox } from '../shared/messages.ts';
import { createSession, type Panel } from './session.ts';
import type { ReceiverProbe, SendOutcome } from './transport.ts';

const target = (id: string): ExportTarget => ({ id, name: `Layer ${id}`, type: 'FRAME' });

const raw = (id: string): RawExport => ({
  node: { id },
  nodeId: id,
  nodeName: `Layer ${id}`,
  icons: [],
  images: [],
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function harness(options: {
  send?: (payload: ExportPayload) => Promise<SendOutcome>;
  probe?: () => Promise<ReceiverProbe>;
}) {
  const posted: UiToSandbox[] = [];
  const sent: ExportPayload[] = [];
  let panel: Panel | undefined;
  const session = createSession({
    postToSandbox: (message) => posted.push(message),
    sendExport: (payload) => {
      sent.push(payload);
      return options.send?.(payload) ?? Promise.resolve({ kind: 'saved', path: '/library/a' });
    },
    probeReceiver: options.probe ?? (() => Promise.resolve('online')),
    onChange: (next) => {
      panel = next;
    },
  });
  return {
    session,
    posted,
    sent,
    panel: () => {
      if (panel === undefined) throw new Error('no panel yet');
      return panel;
    },
    exportRequests: () =>
      posted.flatMap((message) => (message.type === 'export-node' ? [message.nodeId] : [])),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function select(session: ReturnType<typeof harness>['session'], ...targets: ExportTarget[]) {
  session.receive({ type: 'selection', targets, hasFileKey: true });
}

async function reply(session: ReturnType<typeof harness>['session'], id: string) {
  session.receive({ type: 'node-exported', nodeId: id, raw: raw(id) });
  await flush();
}

describe('start', () => {
  it('announces the UI and probes the receiver', async () => {
    const h = harness({ probe: () => Promise.resolve('offline') });
    h.session.start();
    expect(h.posted).toEqual([{ type: 'ui-ready' }]);
    expect(h.panel().receiver).toBe('checking');
    await flush();
    expect(h.panel().receiver).toBe('offline');
  });

  it('keeps Check again in the checking state until the probe lands', async () => {
    const probe = deferred<ReceiverProbe>();
    const h = harness({ probe: () => probe.promise });
    void h.session.checkReceiver();
    expect(h.panel().receiver).toBe('checking');
    probe.resolve('online');
    await flush();
    expect(h.panel().receiver).toBe('online');
  });
});

describe('a batch', () => {
  it('requests one node at a time and posts each in order', async () => {
    const h = harness({});
    select(h.session, target('a'), target('b'));
    h.session.exportSelection();
    expect(h.exportRequests()).toEqual(['a']);

    await reply(h.session, 'a');
    expect(h.exportRequests()).toEqual(['a', 'b']);
    await reply(h.session, 'b');

    expect(h.sent.map((payload) => payload.nodeId)).toEqual(['a', 'b']);
    expect(h.panel().run.phase).toBe('finished');
  });

  it('does not ask for the next node until the POST settles', async () => {
    const send = deferred<SendOutcome>();
    const h = harness({ send: () => send.promise });
    select(h.session, target('a'), target('b'));
    h.session.exportSelection();
    await reply(h.session, 'a');
    expect(h.exportRequests()).toEqual(['a']);
    send.resolve({ kind: 'saved', path: '/library/a' });
    await flush();
    expect(h.exportRequests()).toEqual(['a', 'b']);
  });

  it('runs the targets captured at the start when the selection moves', async () => {
    const h = harness({});
    select(h.session, target('a'), target('b'));
    h.session.exportSelection();
    select(h.session, target('z'));
    await reply(h.session, 'a');
    await reply(h.session, 'b');
    expect(h.exportRequests()).toEqual(['a', 'b']);
    expect(h.panel().selection?.targets).toEqual([target('z')]);
  });

  it('does nothing with no selection', () => {
    const h = harness({});
    h.session.exportSelection();
    expect(h.exportRequests()).toEqual([]);
  });

  it('skips a node that fails in the sandbox', async () => {
    const h = harness({});
    select(h.session, target('a'), target('b'));
    h.session.exportSelection();
    h.session.receive({ type: 'node-failed', nodeId: 'a', message: 'Node not found' });
    await reply(h.session, 'b');
    expect(h.sent.map((payload) => payload.nodeId)).toEqual(['b']);
    expect(h.panel().run.phase).toBe('finished');
  });

  it('ignores a late reply for a node it is not reading', async () => {
    const h = harness({});
    select(h.session, target('a'));
    h.session.exportSelection();
    await reply(h.session, 'other');
    expect(h.sent).toEqual([]);
  });
});

describe('an exception while encoding or sending', () => {
  it('fails the item when encoding throws, and the run still ends', async () => {
    const h = harness({});
    select(h.session, target('a'), target('b'));
    h.session.exportSelection();
    const broken = { ...raw('a'), icons: null } as unknown as RawExport;
    h.session.receive({ type: 'node-exported', nodeId: 'a', raw: broken });
    await flush();
    await reply(h.session, 'b');

    const { run } = h.panel();
    expect(run.phase).toBe('finished');
    expect(run.phase !== 'idle' && run.items[0]?.state).toMatchObject({
      kind: 'failed',
      reason: { kind: 'export-failed' },
    });
    expect(h.sent.map((payload) => payload.nodeId)).toEqual(['b']);
  });

  it('fails the item when sending throws', async () => {
    const h = harness({ send: () => Promise.reject(new RangeError('Invalid string length')) });
    select(h.session, target('a'));
    h.session.exportSelection();
    await reply(h.session, 'a');

    const { run } = h.panel();
    expect(run.phase !== 'idle' && run.items[0]?.state).toEqual({
      kind: 'failed',
      reason: { kind: 'export-failed', message: 'Invalid string length' },
    });
  });
});

describe('receiver status follows send outcomes', () => {
  it.each<[SendOutcome, Panel['receiver']]>([
    [{ kind: 'saved', path: '/library/a' }, 'online'],
    [{ kind: 'rejected', status: 500, message: null }, 'online'],
    [{ kind: 'bad-reply', status: 200 }, 'online'],
    [{ kind: 'unreachable' }, 'offline'],
  ])('%j sets %s', async (outcome, expected) => {
    const start: ReceiverProbe = expected === 'online' ? 'offline' : 'online';
    const h = harness({
      send: () => Promise.resolve(outcome),
      probe: () => Promise.resolve(start),
    });
    await h.session.checkReceiver();
    select(h.session, target('a'));
    h.session.exportSelection();
    await reply(h.session, 'a');
    expect(h.panel().receiver).toBe(expected);
  });

  it('leaves the status alone on a timeout', async () => {
    const h = harness({ send: () => Promise.resolve({ kind: 'timed-out' }) });
    await h.session.checkReceiver();
    select(h.session, target('a'));
    h.session.exportSelection();
    await reply(h.session, 'a');
    expect(h.panel().receiver).toBe('online');
  });

  it('never gates Export on an offline status', async () => {
    const h = harness({ probe: () => Promise.resolve('offline') });
    await h.session.checkReceiver();
    select(h.session, target('a'));
    h.session.exportSelection();
    await reply(h.session, 'a');
    expect(h.sent).toHaveLength(1);
    expect(h.panel().receiver).toBe('online');
  });

  it('lets a send outcome win over a probe still in flight', async () => {
    const probe = deferred<ReceiverProbe>();
    const h = harness({ probe: () => probe.promise });
    void h.session.checkReceiver();
    select(h.session, target('a'));
    h.session.exportSelection();
    await reply(h.session, 'a');
    probe.resolve('offline');
    await flush();
    expect(h.panel().receiver).toBe('online');
  });
});

describe('retry and dismiss', () => {
  it('asks the sandbox again only for what did not save', async () => {
    let attempts = 0;
    const h = harness({
      send: () => {
        attempts += 1;
        return Promise.resolve(
          attempts === 2 ? { kind: 'unreachable' } : { kind: 'saved', path: `/l/${attempts}` },
        );
      },
    });
    select(h.session, target('a'), target('b'), target('c'));
    h.session.exportSelection();
    await reply(h.session, 'a');
    await reply(h.session, 'b');
    h.session.retry();
    await reply(h.session, 'b');
    await reply(h.session, 'c');

    expect(h.exportRequests()).toEqual(['a', 'b', 'b', 'c']);
    const { run } = h.panel();
    expect(run.phase).toBe('finished');
    expect(run.phase !== 'idle' && run.items.map((item) => item.state.kind)).toEqual([
      'saved',
      'saved',
      'saved',
    ]);
  });

  it('clears a finished run', async () => {
    const h = harness({ send: () => Promise.resolve({ kind: 'timed-out' }) });
    select(h.session, target('a'));
    h.session.exportSelection();
    await reply(h.session, 'a');
    h.session.dismiss();
    expect(h.panel().run).toEqual({ phase: 'idle' });
  });
});
