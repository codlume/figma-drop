import * as fsPromises from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  CommitResult,
  ExportLookup,
  Library,
  LibraryOptions,
  PreviewFile,
  StagedExport,
} from '../shared/integration';
import type {
  CommandError,
  CommandResult,
  LibrarySnapshot,
  RevisionId,
  StagingId,
} from '../shared/library';
import {
  addRevision,
  BLOCKED,
  bundleDir,
  decide,
  imagePreview,
  locate,
  planRevision,
  removeRevision,
  replay,
  replyPreview,
  toSnapshot,
  type Catalog,
  type CatalogRevision,
  type Decision,
} from './catalog';
import {
  commandError,
  contain,
  copyBundle,
  ensureLayout,
  ensureRealDirectory,
  errorFrom,
  fsyncAncestorsBestEffort,
  readStagedBundle,
  removeEmptyDir,
  resolveDestination,
  scanCatalog,
  STAGING_DIR,
  sweepStaging,
  writeReceipt,
  type LibraryFs,
} from './disk';
import { revisionIdOf, slug } from './names';
import {
  parseExportLookup,
  parseStagedExport,
  serializeWithinReadCap,
  type Receipt,
} from './receipt';

export type LibraryDeps = {
  fs: LibraryFs;
  now(): Date;
};

const MAX_REMEMBERED_OUTCOMES = 1024;
const UNREADABLE_MESSAGE = 'The library folder cannot be read.';

type OpenState = { state: 'unreadable' } | { state: 'ready'; catalog: Catalog };

function commitResult(
  status: 'committed' | 'skipped' | 'converged',
  revision: CatalogRevision,
): CommitResult {
  const preview = replyPreview(revision);
  return {
    ok: true,
    status,
    revisionId: revision.id,
    path: bundleDir(revision),
    ...(preview ? { preview } : {}),
  };
}

export async function openLibrary(
  options: LibraryOptions,
  deps: Partial<LibraryDeps> = {},
): Promise<Library> {
  const fs = deps.fs ?? fsPromises;
  const now = deps.now ?? (() => new Date());
  const root = resolve(options.root);
  const stagingDir = join(root, STAGING_DIR);
  const listeners = new Set<() => void>();
  const outcomes = new Map<StagingId, RevisionId>();
  let openState: OpenState = { state: 'unreadable' };
  let tail: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  }

  function command<T>(task: () => Promise<T | CommandError>): Promise<T | CommandError> {
    return enqueue(() => task().catch(errorFrom));
  }

  function readyCatalog(): Catalog | null {
    return openState.state === 'ready' ? openState.catalog : null;
  }

  async function load(): Promise<Catalog | null> {
    try {
      await ensureLayout(fs, root);
      const catalog = await scanCatalog(fs, root);
      openState = { state: 'ready', catalog };
      return catalog;
    } catch {
      openState = { state: 'unreadable' };
      return null;
    }
  }

  function notify(): void {
    for (const listener of listeners) {
      try {
        Promise.resolve(listener()).catch(() => {});
      } catch {}
    }
  }

  function remember(stagingId: StagingId, revisionId: RevisionId): void {
    outcomes.set(stagingId, revisionId);
    if (outcomes.size <= MAX_REMEMBERED_OUTCOMES) return;
    const [oldest] = outcomes.keys();
    if (oldest) outcomes.delete(oldest);
  }

  async function isLive(revision: CatalogRevision): Promise<boolean> {
    const where = await contain(fs, root, bundleDir(revision));
    return where.state === 'inside' && where.info.isDirectory();
  }

  async function decideLive(pick: (catalog: Catalog) => Decision): Promise<Decision> {
    const catalog = readyCatalog();
    if (!catalog) return BLOCKED;
    const first = pick(catalog);
    if (first.kind === 'add') return first;
    if (first.kind === 'existing' && (await isLive(first.revision))) return first;
    const rescanned = await load();
    if (!rescanned) return BLOCKED;
    const second = pick(rescanned);
    if (second.kind !== 'existing' || (await isLive(second.revision))) return second;
    return { kind: 'add' };
  }

  async function addExport(staged: StagedExport, catalog: Catalog): Promise<CommitResult> {
    const stagingPath = join(stagingDir, staged.stagingId);
    const files = await readStagedBundle(fs, stagingPath);
    if (!files) return commandError('failed');
    const receipt: Receipt = {
      schemaVersion: 1,
      revisionId: revisionIdOf(staged.stagingId),
      receivedAt: now().toISOString(),
      contentHash: staged.contentHash,
      exportedAt: staged.exportedAt,
      identity: staged.identity,
      fileName: staged.fileName,
      figmaNodeId: staged.figmaNodeId,
      nodeName: staged.nodeName,
      files,
    };
    const text = serializeWithinReadCap(receipt);
    if (!text) return commandError('failed');
    await writeReceipt(fs, stagingPath, text);
    const revision = planRevision(catalog, root, receipt);
    if (!(await ensureRealDirectory(fs, root, dirname(revision.dir)))) {
      return commandError('failed');
    }
    await fs.rename(stagingPath, revision.dir);
    await fsyncAncestorsBestEffort(fs, root, revision.dir);
    openState = { state: 'ready', catalog: addRevision(catalog, revision) };
    notify();
    return commitResult('committed', revision);
  }

  async function commitExport(staged: StagedExport): Promise<CommitResult> {
    if (!readyCatalog() && !(await load())) return commandError('unavailable');
    const earlierMatch = outcomes.get(staged.stagingId);
    const decision = await decideLive((catalog) => {
      const replayed = replay(catalog, staged.stagingId, earlierMatch);
      return replayed.kind === 'existing' ? replayed : decide(catalog, staged);
    });
    const catalog = readyCatalog();
    if (decision.kind === 'blocked' || !catalog) return commandError('unavailable');
    if (decision.kind === 'add') return addExport(staged, catalog);
    remember(staged.stagingId, decision.revision.id);
    await fs
      .rm(join(stagingDir, staged.stagingId), { recursive: true, force: true })
      .catch(() => {});
    return commitResult(decision.status, decision.revision);
  }

  async function findLookup(lookup: ExportLookup): Promise<CommitResult | null> {
    const decision = await decideLive((catalog) => decide(catalog, lookup));
    if (decision.kind === 'blocked') return commandError('unavailable');
    return decision.kind === 'existing' ? commitResult(decision.status, decision.revision) : null;
  }

  async function trashRevision(revisionId: RevisionId): Promise<CommandResult> {
    const catalog = readyCatalog();
    if (!catalog) return commandError('unavailable');
    const revision = catalog.revisions.get(revisionId);
    if (!revision) return commandError('not-found');
    const where = await contain(fs, root, revision.dir);
    if (where.state === 'vanished') {
      await load();
      return commandError('not-found');
    }
    if (where.state === 'refused' || !where.info.isDirectory()) return commandError('damaged');
    try {
      await options.trashItem(revision.dir);
    } catch {
      return commandError('failed');
    }
    const removedDirs = { node: false, project: false };
    if (revision.kind === 'project') {
      const nodeDir = dirname(revision.dir);
      removedDirs.node = await removeEmptyDir(fs, nodeDir);
      removedDirs.project = await removeEmptyDir(fs, dirname(nodeDir));
    }
    openState = { state: 'ready', catalog: removeRevision(catalog, revision, removedDirs) };
    notify();
    return { ok: true };
  }

  async function copyRevision(
    revisionId: RevisionId,
    destinationDir: string,
  ): Promise<CommandResult<{ path: string }>> {
    const catalog = readyCatalog();
    if (!catalog) return commandError('unavailable');
    const revision = catalog.revisions.get(revisionId);
    if (!revision) return commandError('not-found');
    if (revision.record.state === 'damaged') return commandError('damaged');
    const { receipt } = revision.record;
    const source = bundleDir(revision);
    const bundle = await contain(fs, root, source);
    if (bundle.state === 'vanished') return commandError('not-found');
    if (bundle.state === 'refused' || !bundle.info.isDirectory()) return commandError('damaged');
    for (const file of receipt.files) {
      const where = await contain(fs, root, join(source, file.path));
      if (where.state !== 'inside' || !where.info.isFile()) return commandError('damaged');
    }
    const destination = await resolveDestination(fs, root, destinationDir);
    if (!destination) return commandError('failed');
    const baseName = `${slug(receipt.nodeName || receipt.figmaNodeId)}-${revisionId.slice(0, 8)}`;
    try {
      const name = await copyBundle(fs, source, receipt.files, destination, baseName);
      return { ok: true, path: join(destinationDir, name) };
    } catch (cause) {
      // A failed copy says nothing about the library, which stays available.
      return commandError(errorFrom(cause).code === 'disk-full' ? 'disk-full' : 'failed');
    }
  }

  async function bundlePathOf(revisionId: RevisionId): Promise<CommandResult<{ path: string }>> {
    const catalog = readyCatalog();
    if (!catalog) return commandError('unavailable');
    const revision = catalog.revisions.get(revisionId);
    if (!revision) return commandError('not-found');
    const path = bundleDir(revision);
    const where = await contain(fs, root, path);
    if (where.state === 'vanished') return commandError('not-found');
    if (where.state === 'refused' || !where.info.isDirectory()) return commandError('damaged');
    return { ok: true, path };
  }

  async function previewOf(revisionId: RevisionId): Promise<PreviewFile | null> {
    const revision = readyCatalog()?.revisions.get(revisionId);
    if (revision?.record.state !== 'ok') return null;
    const image = imagePreview(revision.record.receipt);
    if (!image) return null;
    const path = join(bundleDir(revision), image.file);
    const where = await contain(fs, root, path);
    return where.state === 'inside' && where.info.isFile()
      ? { path, contentType: image.contentType }
      : null;
  }

  async function snapshot(): Promise<LibrarySnapshot> {
    const catalog = await load();
    return catalog
      ? toSnapshot(catalog)
      : { state: 'unreadable', message: UNREADABLE_MESSAGE, projects: [], unidentified: [] };
  }

  async function sweepBeforeReceiverStarts(): Promise<void> {
    await ensureLayout(fs, root)
      .then(() => sweepStaging(fs, stagingDir))
      .catch(() => {});
  }

  await enqueue(async () => {
    await sweepBeforeReceiverStarts();
    await load();
  });

  return {
    stagingDir,
    commit(staged) {
      const parsed = parseStagedExport(staged);
      if (!parsed) return Promise.resolve(commandError('failed'));
      return command(() => commitExport(parsed));
    },
    findExport(lookup) {
      const parsed = parseExportLookup(lookup);
      if (!parsed) return Promise.resolve(commandError('failed'));
      return command(() => findLookup(parsed));
    },
    getSnapshot: () => enqueue(snapshot),
    onChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bundlePath: (revisionId) => bundlePathOf(revisionId).catch(errorFrom),
    copyTo: (revisionId, destinationDir) =>
      copyRevision(revisionId, destinationDir).catch(errorFrom),
    trash: (revisionId) => command(() => trashRevision(revisionId)),
    previewFile: (revisionId) => previewOf(revisionId).catch(() => null),
    locate: async (path) => {
      const catalog = readyCatalog();
      return catalog ? locate(catalog, path) : null;
    },
  };
}
