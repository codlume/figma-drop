import { FORBIDDEN_ERROR_TEXT } from '@figma-drop/export-contract';
import { describe, expect, it } from 'vite-plus/test';
import type { ExportTarget } from '../shared/messages.ts';
import { describePanel } from './panel.ts';
import type { FailureReason, Item, ItemState } from './run.ts';
import type { Panel } from './session.ts';

const target = (id: string, name = `Layer ${id}`): ExportTarget => ({ id, name, type: 'FRAME' });
const item = (id: string, state: ItemState): Item => ({ target: target(id), state });

const saved = (id: string): Item => item(id, { kind: 'saved', path: `/library/${id}` });
const failed = (id: string, reason: FailureReason): Item => item(id, { kind: 'failed', reason });

const panel = (overrides: Partial<Panel> = {}): Panel => ({
  selection: { targets: [target('a')], hasFileKey: true },
  receiver: 'online',
  run: { phase: 'idle' },
  ...overrides,
});

const finished = (...items: Item[]): Panel => panel({ run: { phase: 'finished', items } });

describe('selection', () => {
  it('waits for the sandbox before claiming anything', () => {
    const view = describePanel(panel({ selection: null }));
    expect(view.selection.title).toBe('Reading your selection');
    expect(view.primary.action).toBeNull();
  });

  it('asks for a selection and disables Export when nothing is selected', () => {
    const view = describePanel(panel({ selection: { targets: [], hasFileKey: true } }));
    expect(view.selection.title).toBe('Nothing selected');
    expect(view.primary).toEqual({ label: 'Export', action: null });
  });

  it('names a single layer', () => {
    const selection = {
      targets: [{ id: '1', name: 'Hero', type: 'COMPONENT_SET' }],
      hasFileKey: true,
    };
    const view = describePanel(panel({ selection }));
    expect(view.selection).toEqual({ title: 'Hero', detail: 'Component set' });
    expect(view.primary).toEqual({ label: 'Export layer', action: 'export' });
  });

  it('counts several layers', () => {
    const selection = { targets: [target('a', 'Hero'), target('b', 'Card')], hasFileKey: true };
    const view = describePanel(panel({ selection }));
    expect(view.selection).toEqual({ title: '2 layers selected', detail: 'Hero, Card' });
    expect(view.primary).toEqual({ label: 'Export 2 layers', action: 'export' });
  });
});

describe('a file with no key', () => {
  it('says the export goes to Unidentified and still allows it', () => {
    const view = describePanel(panel({ selection: { targets: [target('a')], hasFileKey: false } }));
    expect(view.unidentifiedNote).toContain('Unidentified');
    expect(view.primary.action).toBe('export');
  });

  it('stays quiet with a key, and with nothing selected', () => {
    expect(describePanel(panel()).unidentifiedNote).toBeNull();
    const empty = panel({ selection: { targets: [], hasFileKey: false } });
    expect(describePanel(empty).unidentifiedNote).toBeNull();
  });
});

describe('receiver status', () => {
  it('tells the user what to do when offline, and keeps Export available', () => {
    const view = describePanel(panel({ receiver: 'offline' }));
    expect(view.receiver.hint).toContain('Open figma-drop');
    expect(view.primary.action).toBe('export');
  });

  it('says ready only when online', () => {
    expect(describePanel(panel()).receiver.text).toBe('figma-drop is ready');
    expect(describePanel(panel({ receiver: 'checking' })).receiver.text).not.toContain('ready');
  });
});

describe('running', () => {
  const run: Panel['run'] = {
    phase: 'running',
    items: [saved('a'), item('b', { kind: 'sending' }), item('c', { kind: 'queued' })],
  };

  it('shows progress per row and blocks the action', () => {
    const view = describePanel(panel({ run }));
    expect(view.rows.map((row) => row.label)).toEqual(['Saved', 'Sending', 'Queued']);
    expect(view.primary).toEqual({ label: 'Exporting 2 of 3', action: null });
    expect(view.notice).toBeNull();
    expect(view.canDismiss).toBe(false);
  });

  it('shows the receipt path as soon as a row saves', () => {
    expect(describePanel(panel({ run })).rows[0]?.detail).toBe('/library/a');
  });
});

describe('saved', () => {
  it('confirms a single save', () => {
    const view = describePanel(finished(saved('a')));
    expect(view.notice).toEqual({ tone: 'success', text: 'Saved to figma-drop.' });
    expect(view.rows[0]?.detail).toBe('/library/a');
    expect(view.primary.action).toBe('export');
    expect(view.canDismiss).toBe(false);
  });

  it('confirms a batch', () => {
    const view = describePanel(finished(saved('a'), saved('b')));
    expect(view.notice?.text).toBe('All 2 saved to figma-drop.');
  });
});

describe('partial failure', () => {
  const reason: FailureReason = { kind: 'rejected', status: 500, message: 'disk is full' };

  it('counts what saved and offers a retry of the rest', () => {
    const view = describePanel(finished(saved('a'), failed('b', reason)));
    expect(view.notice).toMatchObject({ tone: 'warning' });
    expect(view.notice?.text).toContain('1 of 2 saved.');
    expect(view.primary).toEqual({ label: 'Retry 1 layer', action: 'retry' });
    expect(view.canDismiss).toBe(true);
  });

  it('counts not-sent rows in the retry', () => {
    const view = describePanel(
      finished(saved('a'), failed('b', { kind: 'unreachable' }), item('c', { kind: 'not-sent' })),
    );
    expect(view.primary.label).toBe('Retry 2 layers');
    expect(view.rows.map((row) => row.label)).toEqual(['Saved', 'Failed', 'Not sent']);
    expect(view.notice?.text).toContain('turn its receiver on');
  });
});

describe('all failed', () => {
  it('says nothing was saved', () => {
    const view = describePanel(finished(failed('a', { kind: 'unreachable' })));
    expect(view.notice).toMatchObject({ tone: 'danger' });
    expect(view.notice?.text).toContain('Nothing was saved.');
    expect(view.primary.action).toBe('retry');
  });

  it('warns that a timed-out export may have saved and that retrying is safe', () => {
    const view = describePanel(finished(failed('a', { kind: 'timed-out' })));
    expect(view.rows[0]?.detail).toContain('may still have been saved');
    expect(view.notice?.text).toContain('can add a second revision');
  });
});

describe('row failure text', () => {
  const detail = (reason: FailureReason) =>
    describePanel(finished(failed('a', reason))).rows[0]?.detail;

  it('shows the receiver error verbatim', () => {
    expect(detail({ kind: 'rejected', status: 500, message: 'disk is full' })).toBe('disk is full');
  });

  it('falls back on the status when the receiver gave no error', () => {
    expect(detail({ kind: 'rejected', status: 413, message: null })).toContain('too large');
    expect(detail({ kind: 'rejected', status: 503, message: null })).toContain('HTTP 503');
    expect(detail({ kind: 'rejected', status: 403, message: null })).toContain('refused');
  });

  it('explains a reply that confirmed nothing', () => {
    expect(detail({ kind: 'bad-reply', status: 200 })).toContain('port 3579');
  });

  it('keeps the sandbox message', () => {
    expect(detail({ kind: 'export-failed', message: 'Node not found' })).toContain(
      'Node not found',
    );
  });
});

describe('copy', () => {
  it('never offers a folder choice in any state', () => {
    const reasons: FailureReason[] = [
      { kind: 'export-failed', message: 'x' },
      { kind: 'rejected', status: 400, message: null },
      { kind: 'rejected', status: 413, message: null },
      { kind: 'rejected', status: 500, message: null },
      { kind: 'bad-reply', status: 200 },
      { kind: 'unreachable' },
      { kind: 'timed-out' },
    ];
    const views = reasons.map((reason) =>
      describePanel({ ...finished(failed('a', reason)), receiver: 'offline' }),
    );
    const text = JSON.stringify(views).toLowerCase();
    expect(text).not.toContain(FORBIDDEN_ERROR_TEXT);
    expect(text).not.toContain('browse');
    expect(text).not.toContain('folder');
  });
});
