import { describe, expect, it, vi } from 'vite-plus/test';

import type { Library } from '../shared/integration.ts';
import { IPC } from '../shared/ipc.ts';
import { createCommands, type DesktopActions } from './commands.ts';
import type { ReceiverSwitch } from './receiver-switch.ts';

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

  it.each([[undefined], [null], [1], [''], [{}], [['revision-1']]])(
    'answers not-found for the id %j without asking the library',
    async (revisionId) => {
      const library = fakeLibrary();
      const commands = createCommands({ library, receiver, desktop: fakeDesktop() });
      expect(await commands[IPC.libraryTrash](revisionId)).toMatchObject({
        ok: false,
        code: 'not-found',
      });
      expect(library.trash).not.toHaveBeenCalled();
    },
  );
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
