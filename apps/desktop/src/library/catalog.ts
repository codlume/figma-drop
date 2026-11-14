import { join } from 'node:path';
import { BUNDLE_FILES } from '@figma-drop/export-contract';
import type { ExportLookup, PreviewFile } from '../shared/integration';
import {
  previewUrl,
  type ExportNode,
  type ExportNodeId,
  type FocusTarget,
  type LibrarySnapshot,
  type Project,
  type ProjectId,
  type Revision,
  type RevisionId,
  type StagingId,
  type UnidentifiedEntry,
} from '../shared/library';
import {
  hashedDir,
  nodeHashOf,
  nodeIdFromHashes,
  projectIdOf,
  revisionDirName,
  revisionIdOf,
  slug,
  type HashedDir,
} from './names';
import type { Receipt } from './receipt';

export const FILES_DIR = 'files';
export const UNIDENTIFIED_DIR = 'unidentified';

export type RevisionRecord =
  | { state: 'ok'; receipt: Receipt }
  | { state: 'damaged'; receivedAt: string };

type RevisionBase = { id: RevisionId; dir: string; record: RevisionRecord };

export type ProjectRevision = RevisionBase & {
  kind: 'project';
  projectId: ProjectId;
  nodeId: ExportNodeId;
  seq: number;
  projectDir: HashedDir;
  nodeDir: HashedDir;
};

export type UnidentifiedRevision = RevisionBase & { kind: 'unidentified'; slug: string };

export type CatalogRevision = ProjectRevision | UnidentifiedRevision;

export type Catalog = {
  revisions: ReadonlyMap<RevisionId, CatalogRevision>;
  projectDirs: ReadonlyMap<ProjectId, HashedDir>;
  nodeDirs: ReadonlyMap<ExportNodeId, HashedDir>;
  blocked: ReadonlySet<ProjectId | ExportNodeId>;
};

export type Decision =
  | { kind: 'existing'; status: 'skipped' | 'converged'; revision: CatalogRevision }
  | { kind: 'add' }
  | { kind: 'blocked' };

const ADD: Decision = { kind: 'add' };
export const BLOCKED: Decision = { kind: 'blocked' };

const IMAGE_PREVIEWS = [
  { file: BUNDLE_FILES.previewPng, contentType: 'image/png' },
  { file: BUNDLE_FILES.previewSvg, contentType: 'image/svg+xml' },
] as const satisfies readonly { file: string; contentType: PreviewFile['contentType'] }[];

const REPLY_PREVIEWS = [
  BUNDLE_FILES.previewPng,
  BUNDLE_FILES.previewSvg,
  BUNDLE_FILES.previewHtml,
] as const;

export function bundleDir(revision: CatalogRevision): string {
  return join(revision.dir, 'bundle');
}

function hasFile(receipt: Receipt, path: string): boolean {
  return receipt.files.some((file) => file.path === path);
}

export function imagePreview(receipt: Receipt): (typeof IMAGE_PREVIEWS)[number] | null {
  return IMAGE_PREVIEWS.find((preview) => hasFile(receipt, preview.file)) ?? null;
}

export function replyPreview(revision: CatalogRevision): string | null {
  if (revision.record.state !== 'ok') return null;
  const { receipt } = revision.record;
  const file = REPLY_PREVIEWS.find((name) => hasFile(receipt, name));
  return file ? join(bundleDir(revision), file) : null;
}

function receiptOf(revision: CatalogRevision): Receipt | null {
  return revision.record.state === 'ok' ? revision.record.receipt : null;
}

function receivedAtOf(revision: CatalogRevision): string {
  const { record } = revision;
  return record.state === 'ok' ? record.receipt.receivedAt : record.receivedAt;
}

function projectRevisions(catalog: Catalog): ProjectRevision[] {
  return [...catalog.revisions.values()].filter((revision) => revision.kind === 'project');
}

function nodeRevisions(catalog: Catalog, nodeId: ExportNodeId): ProjectRevision[] {
  return projectRevisions(catalog).filter((revision) => revision.nodeId === nodeId);
}

function latestOf(revisions: readonly ProjectRevision[]): ProjectRevision | null {
  return revisions.reduce<ProjectRevision | null>(
    (latest, revision) => (latest && latest.seq >= revision.seq ? latest : revision),
    null,
  );
}

function isSameUnidentified(revision: CatalogRevision, lookup: ExportLookup): boolean {
  const receipt = receiptOf(revision);
  return (
    revision.kind === 'unidentified' &&
    receipt?.identity.kind === 'unidentified' &&
    lookup.identity.kind === 'unidentified' &&
    receipt.identity.claimedKey === lookup.identity.claimedKey &&
    receipt.figmaNodeId === lookup.figmaNodeId &&
    receipt.contentHash === lookup.contentHash
  );
}

export function decide(catalog: Catalog, lookup: ExportLookup): Decision {
  if (lookup.identity.kind === 'file') {
    const projectId = projectIdOf(lookup.identity.fileKey);
    const nodeId = nodeIdFromHashes(projectId, nodeHashOf(lookup.figmaNodeId));
    if (catalog.blocked.has(projectId) || catalog.blocked.has(nodeId)) return BLOCKED;
    const latest = latestOf(nodeRevisions(catalog, nodeId));
    return latest && receiptOf(latest)?.contentHash === lookup.contentHash
      ? { kind: 'existing', status: 'skipped', revision: latest }
      : ADD;
  }
  for (const revision of catalog.revisions.values()) {
    if (isSameUnidentified(revision, lookup)) {
      return { kind: 'existing', status: 'converged', revision };
    }
  }
  return ADD;
}

export function replay(
  catalog: Catalog,
  stagingId: StagingId,
  earlierMatch: RevisionId | undefined,
): Decision {
  const revision =
    catalog.revisions.get(revisionIdOf(stagingId)) ??
    (earlierMatch && catalog.revisions.get(earlierMatch));
  return revision ? { kind: 'existing', status: 'converged', revision } : ADD;
}

export function planRevision(catalog: Catalog, root: string, receipt: Receipt): CatalogRevision {
  const id = receipt.revisionId;
  const record: RevisionRecord = { state: 'ok', receipt };
  const nodeSlug = slug(receipt.nodeName || receipt.figmaNodeId);
  if (receipt.identity.kind === 'unidentified') {
    const dir = join(root, UNIDENTIFIED_DIR, `${nodeSlug}-${id}`);
    return { kind: 'unidentified', id, dir, slug: nodeSlug, record };
  }
  const projectId = projectIdOf(receipt.identity.fileKey);
  const nodeHash = nodeHashOf(receipt.figmaNodeId);
  const nodeId = nodeIdFromHashes(projectId, nodeHash);
  const projectDir =
    catalog.projectDirs.get(projectId) ?? hashedDir(slug(receipt.fileName ?? ''), projectId);
  const nodeDir = catalog.nodeDirs.get(nodeId) ?? hashedDir(nodeSlug, nodeHash);
  const seq = (latestOf(nodeRevisions(catalog, nodeId))?.seq ?? 0) + 1;
  const dir = join(root, FILES_DIR, projectDir.name, nodeDir.name, revisionDirName(seq, id));
  return { kind: 'project', id, dir, projectId, nodeId, seq, projectDir, nodeDir, record };
}

export function addRevision(catalog: Catalog, revision: CatalogRevision): Catalog {
  const revisions = new Map(catalog.revisions).set(revision.id, revision);
  if (revision.kind === 'unidentified') return { ...catalog, revisions };
  return {
    ...catalog,
    revisions,
    projectDirs: new Map(catalog.projectDirs).set(revision.projectId, revision.projectDir),
    nodeDirs: new Map(catalog.nodeDirs).set(revision.nodeId, revision.nodeDir),
  };
}

export function removeRevision(
  catalog: Catalog,
  revision: CatalogRevision,
  removedDirs: { node: boolean; project: boolean },
): Catalog {
  const revisions = new Map(catalog.revisions);
  revisions.delete(revision.id);
  const projectDirs = new Map(catalog.projectDirs);
  const nodeDirs = new Map(catalog.nodeDirs);
  if (revision.kind === 'project') {
    if (removedDirs.node) nodeDirs.delete(revision.nodeId);
    if (removedDirs.project) projectDirs.delete(revision.projectId);
  }
  return { ...catalog, revisions, projectDirs, nodeDirs };
}

export function locate(catalog: Catalog, path: string): FocusTarget | null {
  for (const revision of catalog.revisions.values()) {
    const target: FocusTarget = { kind: 'revision', revisionId: revision.id };
    if (path === revision.dir) {
      return revision.kind === 'project'
        ? { kind: 'project', projectId: revision.projectId }
        : target;
    }
    const bundle = bundleDir(revision);
    if (path === bundle) return target;
    const topLevelFiles = receiptOf(revision)?.files.filter((file) => !file.path.includes('/'));
    if (topLevelFiles?.some((file) => path === join(bundle, file.path))) return target;
  }
  return null;
}

function newestFirst(a: string, b: string): number {
  return Date.parse(b) - Date.parse(a);
}

function toRevision(revision: CatalogRevision): Revision {
  const receipt = receiptOf(revision);
  return {
    id: revision.id,
    receivedAt: receivedAtOf(revision),
    preview:
      receipt && imagePreview(receipt) ? { url: previewUrl(revision.id), kind: 'image' } : null,
    state: revision.record.state,
    bundlePath: bundleDir(revision),
  };
}

function toUnidentifiedEntry(revision: UnidentifiedRevision): UnidentifiedEntry {
  const base = toRevision(revision);
  const receipt = receiptOf(revision);
  if (receipt?.identity.kind !== 'unidentified') {
    return { ...base, claimedName: null, claimedKey: null, figmaNodeId: '', name: revision.slug };
  }
  return {
    ...base,
    claimedName: receipt.fileName,
    claimedKey: receipt.identity.claimedKey,
    figmaNodeId: receipt.figmaNodeId,
    name: receipt.nodeName || receipt.figmaNodeId,
  };
}

function toExportNode(
  nodeId: ExportNodeId,
  nodeDir: HashedDir,
  revisions: readonly ProjectRevision[],
): ExportNode {
  const newest = revisions.toSorted((a, b) => b.seq - a.seq);
  const receipts = newest.flatMap((revision) => receiptOf(revision) ?? []);
  const figmaNodeId = receipts[0]?.figmaNodeId;
  return {
    id: nodeId,
    figmaNodeId: figmaNodeId ?? '',
    name: receipts.find((receipt) => receipt.nodeName)?.nodeName ?? figmaNodeId ?? nodeDir.slug,
    revisions: newest.map(toRevision),
  };
}

function fileKeyOf(receipt: Receipt): string {
  return receipt.identity.kind === 'file' ? receipt.identity.fileKey : '';
}

function toProject(
  projectId: ProjectId,
  projectDir: HashedDir,
  revisions: readonly ProjectRevision[],
): Project {
  const byNode = new Map<ExportNodeId, ProjectRevision[]>();
  for (const revision of revisions) {
    const group = byNode.get(revision.nodeId);
    if (group) group.push(revision);
    else byNode.set(revision.nodeId, [revision]);
  }
  const nodes = [...byNode.values()]
    .flatMap((group) => {
      const latest = latestOf(group);
      return latest ? [toExportNode(latest.nodeId, latest.nodeDir, group)] : [];
    })
    .toSorted((a, b) =>
      newestFirst(a.revisions[0]?.receivedAt ?? '', b.revisions[0]?.receivedAt ?? ''),
    );
  const receipts = revisions
    .flatMap((revision) => receiptOf(revision) ?? [])
    .toSorted((a, b) => newestFirst(a.receivedAt, b.receivedAt));
  const times = revisions.map(receivedAtOf).toSorted(newestFirst);
  return {
    id: projectId,
    fileKey: receipts[0] ? fileKeyOf(receipts[0]) : '',
    fileName: receipts.find((receipt) => receipt.fileName)?.fileName ?? projectDir.slug,
    nodes,
    updatedAt: times[0] ?? '',
  };
}

export function toSnapshot(catalog: Catalog): LibrarySnapshot {
  const byProject = new Map<ProjectId, ProjectRevision[]>();
  const unidentified: UnidentifiedRevision[] = [];
  for (const revision of catalog.revisions.values()) {
    if (revision.kind === 'unidentified') {
      unidentified.push(revision);
      continue;
    }
    const group = byProject.get(revision.projectId);
    if (group) group.push(revision);
    else byProject.set(revision.projectId, [revision]);
  }
  const projects = [...byProject.values()]
    .flatMap((group) => {
      const latest = latestOf(group);
      return latest ? [toProject(latest.projectId, latest.projectDir, group)] : [];
    })
    .toSorted((a, b) => newestFirst(a.updatedAt, b.updatedAt));
  const entries = unidentified.map(toUnidentifiedEntry).toSorted((a, b) => {
    if (a.state !== b.state) return a.state === 'damaged' ? 1 : -1;
    return newestFirst(a.receivedAt, b.receivedAt);
  });
  return { state: 'ready', projects, unidentified: entries };
}
