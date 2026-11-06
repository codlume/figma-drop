import type {
  CommandResult,
  CopyToFolderResult,
  FocusTarget,
  LibrarySnapshot,
  RevisionId,
} from './library';
import type { ReceiverStatus } from './receiver';

export type Unsubscribe = () => void;

// The whole renderer surface, exposed frozen as `window.figmaDrop`.
export interface FigmaDropApi {
  library: {
    getSnapshot(): Promise<LibrarySnapshot>;
    onChanged(listener: () => void): Unsubscribe;
    reveal(revisionId: RevisionId): Promise<CommandResult>;
    copyPath(revisionId: RevisionId): Promise<CommandResult>;
    copyToFolder(revisionId: RevisionId): Promise<CopyToFolderResult>;
    trash(revisionId: RevisionId): Promise<CommandResult>;
  };
  receiver: {
    getStatus(): Promise<ReceiverStatus>;
    onStatus(listener: (status: ReceiverStatus) => void): Unsubscribe;
    setEnabled(enabled: boolean): Promise<ReceiverStatus>;
  };
  app: {
    onFocusExport(listener: (target: FocusTarget) => void): Unsubscribe;
  };
}

declare global {
  interface Window {
    figmaDrop: FigmaDropApi;
  }
}

export const IPC = {
  librarySnapshot: 'library:snapshot',
  libraryChanged: 'library:changed',
  libraryReveal: 'library:reveal',
  libraryCopyPath: 'library:copy-path',
  libraryCopyToFolder: 'library:copy-to-folder',
  libraryTrash: 'library:trash',
  receiverStatus: 'receiver:status',
  receiverStatusChanged: 'receiver:status-changed',
  receiverSetEnabled: 'receiver:set-enabled',
  appFocusExport: 'app:focus-export',
} as const;
