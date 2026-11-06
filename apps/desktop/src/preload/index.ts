import { contextBridge, ipcRenderer } from 'electron';

import { type FigmaDropApi, IPC } from '../shared/ipc.ts';
import type { FocusTarget } from '../shared/library.ts';
import { subscribe } from './subscribe.ts';

// A `/open` can recreate the window, and main's message then lands before the page has mounted a
// listener. Holding the latest target here hands it to the first listener instead of losing it.
const focusListeners = new Set<(target: FocusTarget) => void>();
let pendingFocus: FocusTarget | null = null;
subscribe<FocusTarget>(IPC.appFocusExport, (target) => {
  if (focusListeners.size === 0) pendingFocus = target;
  for (const listener of focusListeners) listener(target);
});

const api: FigmaDropApi = {
  library: {
    getSnapshot: () => ipcRenderer.invoke(IPC.librarySnapshot),
    onChanged: (listener) => subscribe<void>(IPC.libraryChanged, listener),
    reveal: (revisionId) => ipcRenderer.invoke(IPC.libraryReveal, revisionId),
    copyPath: (revisionId) => ipcRenderer.invoke(IPC.libraryCopyPath, revisionId),
    copyToFolder: (revisionId) => ipcRenderer.invoke(IPC.libraryCopyToFolder, revisionId),
    trash: (revisionId) => ipcRenderer.invoke(IPC.libraryTrash, revisionId),
  },
  receiver: {
    getStatus: () => ipcRenderer.invoke(IPC.receiverStatus),
    onStatus: (listener) => subscribe(IPC.receiverStatusChanged, listener),
    setEnabled: (enabled) => ipcRenderer.invoke(IPC.receiverSetEnabled, enabled),
  },
  app: {
    onFocusExport(listener) {
      focusListeners.add(listener);
      if (pendingFocus) listener(pendingFocus);
      pendingFocus = null;
      return () => focusListeners.delete(listener);
    },
  },
};

contextBridge.exposeInMainWorld('figmaDrop', api);
