type Brand<Name extends string> = string & { readonly __brand: Name };

export type ProjectId = Brand<'ProjectId'>;
export type ExportNodeId = Brand<'ExportNodeId'>;
export type RevisionId = Brand<'RevisionId'>;
export type StagingId = Brand<'StagingId'>;

export type Preview = { url: string; kind: 'image' };

export type Revision = {
  id: RevisionId;
  receivedAt: string;
  preview: Preview | null;
  state: 'ok' | 'damaged';
  // Display only. Commands take the id.
  bundlePath: string;
};

export type ExportNode = {
  id: ExportNodeId;
  figmaNodeId: string;
  name: string;
  // Newest first.
  revisions: readonly Revision[];
};

export type Project = {
  id: ProjectId;
  fileKey: string;
  // A display hint. Two files can share a name.
  fileName: string;
  nodes: readonly ExportNode[];
  updatedAt: string;
};

export type UnidentifiedEntry = Revision & {
  claimedName: string | null;
  claimedKey: string | null;
  figmaNodeId: string;
  name: string;
};

export type LibrarySnapshot =
  | { state: 'ready'; projects: readonly Project[]; unidentified: readonly UnidentifiedEntry[] }
  | { state: 'unreadable' | 'unavailable'; message: string; projects: readonly []; unidentified: readonly [] };

export type CommandErrorCode = 'not-found' | 'damaged' | 'disk-full' | 'unavailable' | 'failed';
export type CommandError = { ok: false; code: CommandErrorCode; message: string };
export type CommandResult<Success extends object = object> = ({ ok: true } & Success) | CommandError;

export type CopyToFolderResult = CommandResult<
  { status: 'copied'; path: string } | { status: 'cancelled' }
>;

export type FocusTarget =
  | { kind: 'revision'; revisionId: RevisionId }
  | { kind: 'project'; projectId: ProjectId };

export const PREVIEW_SCHEME = 'figma-drop-preview';

export function previewUrl(revisionId: RevisionId): string {
  return `${PREVIEW_SCHEME}://revision/${encodeURIComponent(revisionId)}`;
}
