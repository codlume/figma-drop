import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { createWindows } from './windows.ts';

// Labelled fake: it stands in for Electron's BrowserWindow, which cannot run under Node. Like the
// real one, it throws when touched after destruction.
const { FakeWindow } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  class Fake {
    static created: Fake[] = [];
    static load: () => Promise<void> = async () => {};

    sent: unknown[][] = [];
    crashed = false;
    loading = false;
    destroyed = false;
    #closed = () => {};
    #contents = new EventEmitter();

    constructor() {
      Fake.created.push(this);
    }

    get webContents() {
      this.#assertAlive();
      return {
        send: (...args: unknown[]) => this.sent.push(args),
        isCrashed: () => this.crashed,
        isLoading: () => this.loading,
        on: (event: string, listener: () => void) => this.#contents.on(event, listener),
        off: (event: string, listener: () => void) => this.#contents.off(event, listener),
      };
    }

    // Chromium reports a main-frame failure, if any, then stops loading.
    finishLoad(failure?: { code: number }) {
      this.loading = false;
      if (failure) this.#contents.emit('did-fail-load', {}, failure.code, '', 'page', true);
      this.#contents.emit('did-stop-loading');
    }

    on(_event: 'closed', listener: () => void) {
      this.#closed = listener;
    }

    loadURL() {
      return Fake.load();
    }

    isMinimized() {
      this.#assertAlive();
      return false;
    }

    show() {
      this.#assertAlive();
    }

    isDestroyed() {
      return this.destroyed;
    }

    destroy() {
      this.#assertAlive();
      this.destroyed = true;
      this.#contents.emit('destroyed');
      this.#closed();
    }

    #assertAlive() {
      if (this.destroyed) throw new TypeError('Object has been destroyed');
    }
  }
  return { FakeWindow: Fake };
});

vi.mock('electron', () => ({
  app: { focus: () => {} },
  BrowserWindow: FakeWindow,
  nativeTheme: { shouldUseDarkColors: false },
}));

const open = () => createWindows({ url: 'page', preload: 'preload', onCreated: () => {} });
const windowAt = (index: number) => {
  const window = FakeWindow.created[index];
  if (!window) throw new Error(`no window ${index}`);
  return window;
};

beforeEach(() => {
  FakeWindow.created = [];
  FakeWindow.load = async () => {};
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('show', () => {
  it('resolves true once the page has loaded', async () => {
    expect(await open().show()).toBe(true);
  });

  it('resolves false when the page cannot load', async () => {
    FakeWindow.load = () => Promise.reject(new Error('ERR_FILE_NOT_FOUND'));
    expect(await open().show()).toBe(false);
  });

  it('destroys a failed window and builds a fresh one on the next show', async () => {
    FakeWindow.load = () => Promise.reject(new Error('ERR_FILE_NOT_FOUND'));
    const windows = open();
    await windows.show();
    expect(windowAt(0).destroyed).toBe(true);
    expect(windows.current()).toBeNull();

    FakeWindow.load = async () => {};
    expect(await windows.show()).toBe(true);
    expect(FakeWindow.created).toHaveLength(2);
    expect(windows.current()).toBe(windowAt(1));
  });

  it('resolves false when the user closes the window before it loads', async () => {
    const load = Promise.withResolvers<void>();
    FakeWindow.load = () => load.promise;
    const windows = open();
    const shown = windows.show();
    windowAt(0).destroy();
    load.reject(new Error('gone'));
    expect(await shown).toBe(false);
  });

  it('reuses a window that loaded', async () => {
    const windows = open();
    await windows.show();
    expect(await windows.show()).toBe(true);
    expect(FakeWindow.created).toHaveLength(1);
  });
});

describe('show during a reload', () => {
  async function reloading() {
    const windows = open();
    await windows.show();
    windowAt(0).loading = true;
    let resolved = false;
    const shown = windows.show().then((loaded) => {
      resolved = true;
      return loaded;
    });
    await new Promise((resolve) => setImmediate(resolve));
    return { windows, shown, resolved: () => resolved };
  }

  it('waits for the reload to finish', async () => {
    const { shown, resolved } = await reloading();
    expect(resolved()).toBe(false);
    windowAt(0).finishLoad();
    expect(await shown).toBe(true);
  });

  it('counts a load replaced by a newer one as finished', async () => {
    const { shown } = await reloading();
    windowAt(0).finishLoad({ code: -3 });
    expect(await shown).toBe(true);
  });

  it('resolves false and rebuilds after a failed reload', async () => {
    const { windows, shown } = await reloading();
    windowAt(0).finishLoad({ code: -6 });
    expect(await shown).toBe(false);
    expect(windowAt(0).destroyed).toBe(true);
    expect(await windows.show()).toBe(true);
    expect(FakeWindow.created).toHaveLength(2);
  });

  it('resolves false when the window closes during the reload', async () => {
    const { shown } = await reloading();
    windowAt(0).destroy();
    expect(await shown).toBe(false);
  });
});

describe('send', () => {
  it('returns true and delivers to a live window', async () => {
    const windows = open();
    await windows.show();
    expect(windows.send('channel', 'value')).toBe(true);
    expect(windowAt(0).sent).toEqual([['channel', 'value']]);
  });

  it('returns false before any window exists', () => {
    expect(open().send('channel')).toBe(false);
  });

  it('returns false once the window has closed', async () => {
    const windows = open();
    await windows.show();
    windowAt(0).destroy();
    expect(windows.send('channel')).toBe(false);
  });

  it('returns false after a failed load', async () => {
    FakeWindow.load = () => Promise.reject(new Error('ERR_FILE_NOT_FOUND'));
    const windows = open();
    await windows.show();
    expect(windows.send('channel')).toBe(false);
  });

  it('returns false when the renderer has crashed, because nothing will read the message', async () => {
    const windows = open();
    await windows.show();
    windowAt(0).crashed = true;
    expect(windows.send('channel')).toBe(false);
    expect(windowAt(0).sent).toEqual([]);
  });
});
