import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { type FigmaDropApi, IPC } from '../shared/ipc.ts';
import type { FocusTarget, RevisionId } from '../shared/library.ts';

type Handler = (event: unknown, value: unknown) => void;

// Labelled fake: it stands in for Electron's preload bridge, which cannot run under Node.
const bridge = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  handlers: new Map<string, Set<Handler>>(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => bridge.exposed.set(key, api),
  },
  ipcRenderer: {
    on(channel: string, handler: Handler) {
      const handlers = bridge.handlers.get(channel) ?? new Set();
      bridge.handlers.set(channel, handlers.add(handler));
    },
    off: (channel: string, handler: Handler) => bridge.handlers.get(channel)?.delete(handler),
    invoke: async () => undefined,
  },
}));

const target = (id: string): FocusTarget => ({ kind: 'revision', revisionId: id as RevisionId });
const FIRST = target('first');
const SECOND = target('second');

const sendFromMain = (value: FocusTarget) => {
  for (const handler of bridge.handlers.get(IPC.appFocusExport) ?? []) handler({}, value);
};

// The buffer is module state, so each test loads the preload as a fresh page would.
async function loadPreload() {
  vi.resetModules();
  bridge.exposed.clear();
  bridge.handlers.clear();
  await import('./index.ts');
  const api = bridge.exposed.get('figmaDrop') as FigmaDropApi;
  return (listener: (value: FocusTarget) => void) => api.app.onFocusExport(listener);
}

let onFocusExport: Awaited<ReturnType<typeof loadPreload>>;

beforeEach(async () => {
  onFocusExport = await loadPreload();
});

describe('onFocusExport', () => {
  it('hands a target sent before any listener to the first subscriber, once', () => {
    sendFromMain(FIRST);
    const first = vi.fn();
    const second = vi.fn();
    onFocusExport(first);
    onFocusExport(second);
    expect(first.mock.calls).toEqual([[FIRST]]);
    expect(second).not.toHaveBeenCalled();
  });

  it('keeps only the latest of two buffered targets', () => {
    sendFromMain(FIRST);
    sendFromMain(SECOND);
    const listener = vi.fn();
    onFocusExport(listener);
    expect(listener.mock.calls).toEqual([[SECOND]]);
  });

  it('delivers directly to a listener and replays nothing to a later subscriber', () => {
    const present = vi.fn();
    onFocusExport(present);
    sendFromMain(FIRST);
    expect(present.mock.calls).toEqual([[FIRST]]);
    const later = vi.fn();
    onFocusExport(later);
    expect(later).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', () => {
    const unsubscribed = vi.fn();
    const unsubscribe = onFocusExport(unsubscribed);
    unsubscribe();
    sendFromMain(FIRST);
    expect(unsubscribed).not.toHaveBeenCalled();
  });

  it('buffers again once the last listener has gone', () => {
    onFocusExport(vi.fn())();
    sendFromMain(FIRST);
    const next = vi.fn();
    onFocusExport(next);
    expect(next.mock.calls).toEqual([[FIRST]]);
  });
});
