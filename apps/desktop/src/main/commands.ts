import type { Library } from '../shared/integration.ts';
import { type FigmaDropApi, IPC } from '../shared/ipc.ts';
import type { CommandError, LibrarySnapshot, RevisionId } from '../shared/library.ts';
import type { ReceiverSwitch } from './receiver-switch.ts';

type Api = FigmaDropApi;

// Each handler takes `unknown`, because everything crossing IPC is parsed here.
export type Commands = {
  [IPC.librarySnapshot]: Api['library']['getSnapshot'];
  [IPC.libraryReveal]: (revisionId: unknown) => ReturnType<Api['library']['reveal']>;
  [IPC.libraryCopyPath]: (revisionId: unknown) => ReturnType<Api['library']['copyPath']>;
  [IPC.libraryCopyToFolder]: (revisionId: unknown) => ReturnType<Api['library']['copyToFolder']>;
  [IPC.libraryTrash]: (revisionId: unknown) => ReturnType<Api['library']['trash']>;
  [IPC.receiverStatus]: Api['receiver']['getStatus'];
  [IPC.receiverSetEnabled]: (enabled: unknown) => ReturnType<Api['receiver']['setEnabled']>;
};

export type DesktopActions = {
  showInFolder(path: string): void;
  copyText(text: string): void;
  // Resolves null when the user cancels.
  chooseFolder(): Promise<string | null>;
};

export const LIBRARY_UNAVAILABLE_MESSAGE = 'The library is not installed in this build.';

const UNAVAILABLE: CommandError = {
  ok: false,
  code: 'unavailable',
  message: LIBRARY_UNAVAILABLE_MESSAGE,
};
const UNAVAILABLE_SNAPSHOT: LibrarySnapshot = {
  state: 'unavailable',
  message: LIBRARY_UNAVAILABLE_MESSAGE,
  projects: [],
  unidentified: [],
};

export function createCommands({
  library,
  receiver,
  desktop,
}: {
  library: Library | null;
  receiver: ReceiverSwitch;
  desktop: DesktopActions;
}): Commands {
  const onRevision =
    <Result>(run: (library: Library, revisionId: RevisionId) => Promise<Result>) =>
    async (revisionId: unknown): Promise<Result | CommandError> => {
      if (!library) return UNAVAILABLE;
      if (typeof revisionId !== 'string' || revisionId === '') {
        return { ok: false, code: 'not-found', message: 'No such revision.' };
      }
      return run(library, revisionId as RevisionId);
    };

  return {
    [IPC.librarySnapshot]: async () => (library ? library.getSnapshot() : UNAVAILABLE_SNAPSHOT),
    [IPC.libraryReveal]: onRevision(async (open, revisionId) => {
      const bundle = await open.bundlePath(revisionId);
      if (!bundle.ok) return bundle;
      desktop.showInFolder(bundle.path);
      return { ok: true };
    }),
    [IPC.libraryCopyPath]: onRevision(async (open, revisionId) => {
      const bundle = await open.bundlePath(revisionId);
      if (!bundle.ok) return bundle;
      desktop.copyText(bundle.path);
      return { ok: true };
    }),
    [IPC.libraryCopyToFolder]: onRevision(async (open, revisionId) => {
      const destination = await desktop.chooseFolder();
      if (destination === null) return { ok: true, status: 'cancelled' };
      const copied = await open.copyTo(revisionId, destination);
      return copied.ok ? { ok: true, status: 'copied', path: copied.path } : copied;
    }),
    [IPC.libraryTrash]: onRevision((open, revisionId) => open.trash(revisionId)),
    [IPC.receiverStatus]: async () => receiver.status(),
    [IPC.receiverSetEnabled]: async (enabled) => {
      if (typeof enabled !== 'boolean') throw new TypeError('setEnabled takes a boolean.');
      return receiver.setEnabled(enabled);
    },
  };
}
