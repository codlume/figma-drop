import type { CommandResult, FocusTarget, LibrarySnapshot, RevisionId, StagingId } from './library';
import type { Unsubscribe } from './ipc';
import type { ReceiverStatus } from './receiver';

// Everything the receiver learned at staging. `claimedKey` and the names are
// untrusted display data. Staged bytes live at `<stagingDir>/<stagingId>/`.
export type StagedExport = {
  stagingId: StagingId;
  identity: { kind: 'file'; fileKey: string } | { kind: 'unidentified'; claimedKey: string | null };
  fileName: string | null;
  figmaNodeId: string;
  nodeName: string | null;
  contentHash: string;
  exportedAt: string | null;
};

export type ExportLookup = {
  identity: StagedExport['identity'];
  figmaNodeId: string;
  contentHash: string;
};

// `status` stays inside the app: committed adds a revision, skipped matched the
// latest revision, and converged replayed a known staging id or entry. It never
// goes on the wire, whose success reply stays `{path, preview?}`.
export type CommitResult = CommandResult<{
  status: 'committed' | 'skipped' | 'converged';
  revisionId: RevisionId;
  path: string;
  preview?: string;
}>;

export interface ReceiverLibrary {
  readonly stagingDir: string;
  commit(staged: StagedExport): Promise<CommitResult>;
  findExport(lookup: ExportLookup): Promise<CommitResult | null>;
}

export type PreviewFile = { path: string; contentType: 'image/png' | 'image/svg+xml' };

// Revision ids are untrusted catalog keys. Look them up, and never build a path from one.
export interface Library extends ReceiverLibrary {
  getSnapshot(): Promise<LibrarySnapshot>;
  onChanged(listener: () => void): Unsubscribe;
  bundlePath(revisionId: RevisionId): Promise<CommandResult<{ path: string }>>;
  copyTo(revisionId: RevisionId, destinationDir: string): Promise<CommandResult<{ path: string }>>;
  trash(revisionId: RevisionId): Promise<CommandResult>;
  previewFile(revisionId: RevisionId): Promise<PreviewFile | null>;
  // Maps a `/open` path back to catalog ids: a reply `path`, a reply `preview`, or
  // the parent of a reply `path`, which a batch sends. It never reaches the OS.
  locate(path: string): Promise<FocusTarget | null>;
}

export type LibraryOptions = {
  root: string;
  trashItem(path: string): Promise<void>;
};

// Resolves before the receiver starts, because opening sweeps staging. It never
// rejects: an unreadable library resolves with an `unreadable` snapshot.
export type CreateLibrary = (options: LibraryOptions) => Promise<Library>;

// `start` is idempotent. A failure surfaces through `status` or a rejection.
export interface ReceiverController {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): ReceiverStatus;
  onStatus(listener: (status: ReceiverStatus) => void): Unsubscribe;
}

// Structural slice of Electron's UtilityProcess, so ingest imports no electron.
export interface ForkedProcess {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
}

export type ReceiverControllerOptions = {
  entry: string;
  port: number;
  library: ReceiverLibrary;
  fork(entry: string): ForkedProcess;
  // Resolves false when the path matches nothing or no loaded window took the target,
  // so `/open` never reports a delivery that did not happen.
  onFocus(path: string): Promise<boolean>;
};

export type CreateReceiverController = (options: ReceiverControllerOptions) => ReceiverController;
