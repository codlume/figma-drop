import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as NodePath from 'node:path';

import { describe, expect, it, vi } from 'vite-plus/test';

import type { Library, ReceiverController } from '../shared/integration.ts';
import { IPC } from '../shared/ipc.ts';
import type { ReceiverStatus } from '../shared/receiver.ts';
import { createCommands, type DesktopActions } from './commands.ts';
import { createReceiverSwitch, type ReceiverSwitch } from './receiver-switch.ts';

const REVISION = 'revision-1';
const BUNDLE = '/library/bundle';

// Labelled fakes: they stand in for B-LIBRARY and the desktop shell in this test only.
function fakeLibrary(overrides: Partial<Library> = {}) {
  return {
    bundlePath: vi.fn(async () => ({ ok: true, path: BUNDLE }) as const),
    copyTo: vi.fn(async (_id, destination: string) => ({
      ok: true as const,
      path: `${destination}/bundle`,
    })),
    trash: vi.fn(async () => ({ ok: true }) as const),
    ...overrides,
  } as unknown as Library;
}

function fakeDesktop(folder: string | null = '/picked'): DesktopActions {
  return {
    showInFolder: vi.fn(),
    copyText: vi.fn(),
    chooseFolder: vi.fn(async () => folder),
  };
}

const receiver = {
  status: () => ({ state: 'off' }),
  setEnabled: vi.fn(async () => ({ state: 'off' })),
} as unknown as ReceiverSwitch;

describe('without the library', () => {
  const commands = createCommands({ library: null, receiver, desktop: fakeDesktop() });

  it('returns the unavailable snapshot', async () => {
    expect(await commands[IPC.librarySnapshot]()).toEqual({
      state: 'unavailable',
      message: expect.any(String),
      projects: [],
      unidentified: [],
    });
  });

  it.each([IPC.libraryReveal, IPC.libraryCopyPath, IPC.libraryCopyToFolder, IPC.libraryTrash])(
    '%s answers unavailable',
    async (channel) => {
      expect(await commands[channel](REVISION)).toEqual({
        ok: false,
        code: 'unavailable',
        message: expect.any(String),
      });
    },
  );

  it('opens no folder picker', async () => {
    const desktop = fakeDesktop();
    const absent = createCommands({ library: null, receiver, desktop });
    await absent[IPC.libraryCopyToFolder](REVISION);
    expect(desktop.chooseFolder).not.toHaveBeenCalled();
  });
});

describe('with the library', () => {
  it('reveals the path the library names', async () => {
    const desktop = fakeDesktop();
    const commands = createCommands({ library: fakeLibrary(), receiver, desktop });
    expect(await commands[IPC.libraryReveal](REVISION)).toEqual({ ok: true });
    expect(desktop.showInFolder).toHaveBeenCalledWith(BUNDLE);
  });

  it('copies the path the library names', async () => {
    const desktop = fakeDesktop();
    const commands = createCommands({ library: fakeLibrary(), receiver, desktop });
    expect(await commands[IPC.libraryCopyPath](REVISION)).toEqual({ ok: true });
    expect(desktop.copyText).toHaveBeenCalledWith(BUNDLE);
  });

  it('passes a library error through without touching the desktop', async () => {
    const desktop = fakeDesktop();
    const error = { ok: false, code: 'damaged', message: 'Damaged.' } as const;
    const library = fakeLibrary({ bundlePath: async () => error });
    const commands = createCommands({ library, receiver, desktop });
    expect(await commands[IPC.libraryReveal](REVISION)).toEqual(error);
    expect(desktop.showInFolder).not.toHaveBeenCalled();
  });

  it('copies to the chosen folder', async () => {
    const library = fakeLibrary();
    const commands = createCommands({ library, receiver, desktop: fakeDesktop() });
    expect(await commands[IPC.libraryCopyToFolder](REVISION)).toEqual({
      ok: true,
      status: 'copied',
      path: '/picked/bundle',
    });
  });

  it('reports a cancelled picker and copies nothing', async () => {
    const library = fakeLibrary();
    const commands = createCommands({ library, receiver, desktop: fakeDesktop(null) });
    expect(await commands[IPC.libraryCopyToFolder](REVISION)).toEqual({
      ok: true,
      status: 'cancelled',
    });
    expect(library.copyTo).not.toHaveBeenCalled();
  });

  it('keeps accepting an id of any other shape', async () => {
    const library = fakeLibrary();
    const commands = createCommands({ library, receiver, desktop: fakeDesktop() });
    expect(await commands[IPC.libraryTrash]('rev 1 é.2')).toEqual({ ok: true });
    expect(library.trash).toHaveBeenCalledWith('rev 1 é.2');
  });

  it.each([
    [undefined],
    [null],
    [1],
    [''],
    [{}],
    [['revision-1']],
    ['a/b'],
    ['a\\b'],
    ['..'],
    ['a..b'],
    ['../../etc'],
  ])('answers not-found for the id %j without asking the library', async (revisionId) => {
    const library = fakeLibrary();
    const commands = createCommands({ library, receiver, desktop: fakeDesktop() });
    expect(await commands[IPC.libraryTrash](revisionId)).toMatchObject({
      ok: false,
      code: 'not-found',
    });
    expect(library.trash).not.toHaveBeenCalled();
  });
});

describe('receiver commands', () => {
  const commands = createCommands({ library: null, receiver, desktop: fakeDesktop() });

  it('reads the status', async () => {
    expect(await commands[IPC.receiverStatus]()).toEqual({ state: 'off' });
  });

  it('forwards a boolean to the switch', async () => {
    await commands[IPC.receiverSetEnabled](false);
    expect(receiver.setEnabled).toHaveBeenCalledWith(false);
  });

  it.each([['true'], [1], [null], [undefined]])('rejects %j', async (value) => {
    await expect(commands[IPC.receiverSetEnabled](value)).rejects.toThrow(TypeError);
  });
});

// The renderer applies pushes and replies to one state, so a reply must never disagree with the
// push it follows. This runs the real switch in one process. It says nothing about the order
// Electron delivers a `webContents.send` and an `invoke` reply to the renderer.
describe('push and reply through the real switch', () => {
  const LISTENING: ReceiverStatus = { state: 'listening', port: 13579 };

  // Labelled fake: it stands in for A-INGEST's controller in this test only.
  function fakeController(start: (report: (status: ReceiverStatus) => void) => Promise<void>) {
    const listeners = new Set<(status: ReceiverStatus) => void>();
    let current: ReceiverStatus = { state: 'off' };
    const report = (status: ReceiverStatus) => {
      current = status;
      for (const listener of listeners) listener(status);
    };
    const controller: ReceiverController = {
      start: () => start(report),
      async stop() {
        report({ state: 'off' });
      },
      status: () => current,
      onStatus(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return controller;
  }

  async function open(controller: ReceiverController) {
    const dir = await mkdtemp(NodePath.join(tmpdir(), 'commands-'));
    const realReceiver = await createReceiverSwitch({
      settingsPath: NodePath.join(dir, 'settings.json'),
      controller,
      unavailableMessage: 'Not installed.',
    });
    const pushed: ReceiverStatus[] = [];
    realReceiver.onStatus((status) => pushed.push(status));
    const commands = createCommands({
      library: null,
      receiver: realReceiver,
      desktop: fakeDesktop(),
    });
    // Reads the pushes at the moment the reply resolves, not once every toggle has ended.
    const toggle = async (enabled: boolean) => {
      const reply = await commands[IPC.receiverSetEnabled](enabled);
      return { reply, lastPush: pushed.at(-1) };
    };
    return { toggle, pushed };
  }

  const starts = async (report: (status: ReceiverStatus) => void) => report(LISTENING);

  it('pushes the replied status before the reply resolves', async () => {
    const { toggle } = await open(fakeController(starts));
    expect(await toggle(true)).toEqual({ reply: LISTENING, lastPush: LISTENING });
    expect(await toggle(false)).toEqual({ reply: { state: 'off' }, lastPush: { state: 'off' } });
  });

  it('keeps each reply equal to the last push when toggles overlap', async () => {
    const { toggle, pushed } = await open(fakeController(starts));
    const outcomes = await Promise.all([toggle(true), toggle(false), toggle(true)]);
    for (const { reply, lastPush } of outcomes) expect(lastPush).toEqual(reply);
    expect(outcomes.map(({ reply }) => reply)).toEqual([LISTENING, { state: 'off' }, LISTENING]);
    expect(pushed.at(-1)).toEqual(LISTENING);
  });

  it('replies with the final status when the controller reports during start', async () => {
    const conflict: ReceiverStatus = { state: 'port-conflict', port: 13579 };
    const { toggle, pushed } = await open(
      fakeController(async (report) => {
        report({ state: 'starting' });
        await new Promise((resolve) => setImmediate(resolve));
        report(conflict);
      }),
    );
    expect(await toggle(true)).toEqual({ reply: conflict, lastPush: conflict });
    expect(pushed[0]).toEqual({ state: 'starting' });
  });

  it('pushes the failure it replies with when start rejects', async () => {
    const { toggle } = await open(fakeController(() => Promise.reject(new Error('refused'))));
    const { reply, lastPush } = await toggle(true);
    expect(reply).toEqual({ state: 'failed', message: expect.stringContaining('refused') });
    expect(lastPush).toEqual(reply);
  });
});
