import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { BUNDLE_FILES } from '@figma-drop/export-contract';
import type {
  CommandError,
  CommandErrorCode,
  ExportNodeId,
  ProjectId,
  RevisionId,
} from '../shared/library';
import {
  FILES_DIR,
  UNIDENTIFIED_DIR,
  type Catalog,
  type CatalogRevision,
  type ProjectRevision,
  type RevisionRecord,
  type UnidentifiedRevision,
} from './catalog';
import {
  isSafeBundlePath,
  nodeIdFromHashes,
  parseHashedDir,
  parseRevisionDir,
  parseUnidentifiedDir,
  projectIdFromHash,
  type HashedDir,
} from './names';
import {
  MAX_RECEIPT_BYTES,
  parseReceipt,
  type BundleFile,
  type Receipt,
  type ReceiptHome,
} from './receipt';

export type LibraryFs = Pick<
  typeof fsPromises,
  | 'mkdir'
  | 'rename'
  | 'rm'
  | 'rmdir'
  | 'readdir'
  | 'readFile'
  | 'writeFile'
  | 'lstat'
  | 'stat'
  | 'realpath'
  | 'copyFile'
  | 'open'
>;

export const STAGING_DIR = '.staging';
const RECEIPT_FILE = 'receipt.json';
const OVERWRITE_WITHOUT_FOLLOWING_SYMLINK =
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
const REQUIRED_FILES = [BUNDLE_FILES.node, BUNDLE_FILES.components, BUNDLE_FILES.meta];

const ERRNO_CODES = new Map<string, CommandErrorCode>([
  ['ENOSPC', 'disk-full'],
  ['EDQUOT', 'disk-full'],
  ['EACCES', 'unavailable'],
  ['EPERM', 'unavailable'],
  ['EROFS', 'unavailable'],
  ['EIO', 'unavailable'],
  ['ENOTDIR', 'unavailable'],
]);

const ERROR_MESSAGES: Record<CommandErrorCode, string> = {
  'not-found': 'That export is no longer in the library.',
  damaged: 'That export is damaged.',
  'disk-full': 'The disk is full.',
  unavailable: 'The library is unavailable.',
  failed: 'The library could not finish that.',
};

export function commandError(code: CommandErrorCode): CommandError {
  return { ok: false, code, message: ERROR_MESSAGES[code] };
}

function errnoOf(cause: unknown): unknown {
  return typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
}

export function errorFrom(cause: unknown): CommandError {
  const errno = errnoOf(cause);
  return commandError((typeof errno === 'string' && ERRNO_CODES.get(errno)) || 'failed');
}

async function lstatOrNull(fs: LibraryFs, path: string): Promise<Stats | null> {
  try {
    return await fs.lstat(path);
  } catch (cause) {
    const errno = errnoOf(cause);
    if (errno === 'ENOENT' || errno === 'ENOTDIR') return null;
    throw cause;
  }
}

export type Containment =
  | { state: 'inside'; info: Stats }
  | { state: 'vanished' }
  | { state: 'refused' };

export async function contain(
  fs: LibraryFs,
  root: string,
  candidate: string,
): Promise<Containment> {
  let current = root;
  let info: Stats | null = null;
  for (const part of relative(root, candidate).split(sep)) {
    current = join(current, part);
    info = await lstatOrNull(fs, current);
    if (!info) return { state: 'vanished' };
    if (info.isSymbolicLink()) return { state: 'refused' };
  }
  if (!info) return { state: 'refused' };
  // `root` itself may sit under a symlink, as macOS `/tmp` does.
  const [realRoot, realCandidate] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  return realCandidate.startsWith(realRoot + sep)
    ? { state: 'inside', info }
    : { state: 'refused' };
}

export async function ensureLayout(fs: LibraryFs, root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  for (const name of [STAGING_DIR, FILES_DIR, UNIDENTIFIED_DIR]) {
    const dir = join(root, name);
    await fs.mkdir(dir, { recursive: true });
    if (!(await fs.lstat(dir)).isDirectory()) throw new Error('not a real directory');
  }
}

export async function sweepStaging(fs: LibraryFs, stagingDir: string): Promise<void> {
  for (const name of await fs.readdir(stagingDir)) {
    await fs.rm(join(stagingDir, name), { recursive: true, force: true });
  }
}

// A symlink's Dirent is not a directory, so scanning never enters one.
async function subdirectories(fs: LibraryFs, dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

// Null is a refusal, which blocks that one branch so other Figma files keep
// ingesting. Any other failure says nothing about the branch, so the scan fails.
async function subdirectoriesUnlessRefused(fs: LibraryFs, dir: string): Promise<string[] | null> {
  try {
    return await subdirectories(fs, dir);
  } catch (cause) {
    const errno = errnoOf(cause);
    if (errno === 'EACCES' || errno === 'EPERM') return null;
    throw cause;
  }
}

async function readReceipt(
  fs: LibraryFs,
  path: string,
  home: ReceiptHome,
): Promise<Receipt | null> {
  try {
    const info = await fs.lstat(path);
    if (!info.isFile() || info.size > MAX_RECEIPT_BYTES) return null;
    return parseReceipt(await fs.readFile(path, 'utf8'), home);
  } catch {
    return null;
  }
}

async function readRecord(fs: LibraryFs, dir: string, home: ReceiptHome): Promise<RevisionRecord> {
  const receipt = await readReceipt(fs, join(dir, RECEIPT_FILE), home);
  const bundle = await lstatOrNull(fs, join(dir, 'bundle')).catch(() => null);
  if (receipt && bundle?.isDirectory()) return { state: 'ok', receipt };
  const info = await lstatOrNull(fs, dir).catch(() => null);
  return { state: 'damaged', receivedAt: (info?.mtime ?? new Date(0)).toISOString() };
}

// Every snapshot rescans, and each step is a thread-pool round trip, so one-at-a-time
// I/O leaves the scan waiting on latency. The bound keeps file descriptors well below
// any limit, because a receipt read that fails reads as damaged.
const SCAN_CONCURRENCY = 32;

// Resolves in input order. After the first rejection no new item starts, though calls
// already in flight still settle.
async function mapConcurrently<Item, Result>(
  items: readonly Item[],
  run: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await run(items[index] as Item);
      } catch (cause) {
        failed = true;
        throw cause;
      }
    }
  };
  const workers = Math.min(SCAN_CONCURRENCY, items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

type ScannedProject = { path: string; dir: HashedDir; id: ProjectId };
type ScannedNode = { path: string; dir: HashedDir; id: ExportNodeId; project: ScannedProject };

// Order matters: when two directories claim one revision id, the first one listed wins.
export async function scanCatalog(fs: LibraryFs, root: string): Promise<Catalog> {
  const revisions = new Map<RevisionId, CatalogRevision>();
  const projectDirs = new Map<ProjectId, HashedDir>();
  const nodeDirs = new Map<ExportNodeId, HashedDir>();
  const blocked = new Set<ProjectId | ExportNodeId>();
  const keepFirst = (revision: CatalogRevision) => {
    if (!revisions.has(revision.id)) revisions.set(revision.id, revision);
  };
  const listAll = <Parent extends { path: string }>(parents: readonly Parent[]) =>
    mapConcurrently(parents, async (parent) => ({
      parent,
      names: await subdirectoriesUnlessRefused(fs, parent.path),
    }));

  const filesRoot = join(root, FILES_DIR);
  const projects: ScannedProject[] = [];
  for (const name of await subdirectories(fs, filesRoot)) {
    const dir = parseHashedDir(name);
    if (!dir) continue;
    const id = projectIdFromHash(dir.hash);
    if (!projectDirs.has(id)) projectDirs.set(id, dir);
    projects.push({ path: join(filesRoot, name), dir, id });
  }

  const nodes: ScannedNode[] = [];
  for (const { parent: project, names } of await listAll(projects)) {
    if (!names) blocked.add(project.id);
    for (const name of names ?? []) {
      const dir = parseHashedDir(name);
      if (!dir) continue;
      const id = nodeIdFromHashes(project.id, dir.hash);
      if (!nodeDirs.has(id)) nodeDirs.set(id, dir);
      nodes.push({ path: join(project.path, name), dir, id, project });
    }
  }

  const revisionDirs: { node: ScannedNode; seq: number; id: RevisionId; dir: string }[] = [];
  for (const { parent: node, names } of await listAll(nodes)) {
    if (!names) blocked.add(node.id);
    for (const name of names ?? []) {
      const parsed = parseRevisionDir(name);
      if (parsed) revisionDirs.push({ node, ...parsed, dir: join(node.path, name) });
    }
  }
  const projectRevisions = await mapConcurrently(
    revisionDirs,
    async ({ node, seq, id, dir }): Promise<ProjectRevision> => ({
      kind: 'project',
      seq,
      id,
      dir,
      projectId: node.project.id,
      nodeId: node.id,
      projectDir: node.project.dir,
      nodeDir: node.dir,
      record: await readRecord(fs, dir, { kind: 'project', revisionId: id, nodeId: node.id }),
    }),
  );
  for (const revision of projectRevisions) keepFirst(revision);

  const unidentifiedRoot = join(root, UNIDENTIFIED_DIR);
  const unidentifiedDirs = (await subdirectories(fs, unidentifiedRoot)).flatMap((name) => {
    const parsed = parseUnidentifiedDir(name);
    return parsed ? [{ ...parsed, dir: join(unidentifiedRoot, name) }] : [];
  });
  const unidentified = await mapConcurrently(
    unidentifiedDirs,
    async ({ slug, id, dir }): Promise<UnidentifiedRevision> => ({
      kind: 'unidentified',
      slug,
      id,
      dir,
      record: await readRecord(fs, dir, { kind: 'unidentified', revisionId: id }),
    }),
  );
  for (const revision of unidentified) keepFirst(revision);

  return { revisions, projectDirs, nodeDirs, blocked };
}

async function fsyncPath(fs: LibraryFs, path: string, flags: number): Promise<void> {
  const handle = await fs.open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncFile(fs: LibraryFs, path: string): Promise<void> {
  await fsyncPath(fs, path, constants.O_RDONLY | constants.O_NOFOLLOW);
}

async function fsyncDir(fs: LibraryFs, path: string): Promise<void> {
  try {
    await fsyncPath(fs, path, constants.O_RDONLY);
  } catch (cause) {
    const errno = errnoOf(cause);
    if (errno !== 'EINVAL' && errno !== 'ENOTSUP') throw cause;
  }
}

async function collectFiles(
  fs: LibraryFs,
  dir: string,
  prefix: string,
): Promise<BundleFile[] | null> {
  const files: BundleFile[] = [];
  for (const name of (await fs.readdir(dir)).toSorted()) {
    const path = `${prefix}${name}`;
    const absolute = join(dir, name);
    const info = await fs.lstat(absolute);
    if (info.isDirectory() && path === BUNDLE_FILES.previewAssetsDir) {
      const assets = await collectFiles(fs, absolute, `${path}/`);
      if (!assets) return null;
      files.push(...assets);
      continue;
    }
    if (!info.isFile() || !isSafeBundlePath(path)) return null;
    await fsyncFile(fs, absolute);
    files.push({ path, bytes: info.size });
  }
  await fsyncDir(fs, dir);
  return files;
}

export async function readStagedBundle(
  fs: LibraryFs,
  stagingPath: string,
): Promise<BundleFile[] | null> {
  const bundle = join(stagingPath, 'bundle');
  const [staging, bundleInfo] = [await lstatOrNull(fs, stagingPath), await lstatOrNull(fs, bundle)];
  if (!staging?.isDirectory() || !bundleInfo?.isDirectory()) return null;
  const files = await collectFiles(fs, bundle, '');
  if (!files) return null;
  const hasRequired = REQUIRED_FILES.every((name) => files.some((file) => file.path === name));
  return hasRequired ? files : null;
}

export async function writeReceipt(
  fs: LibraryFs,
  stagingPath: string,
  text: string,
): Promise<void> {
  const path = join(stagingPath, RECEIPT_FILE);
  await fs.writeFile(path, text, { flag: OVERWRITE_WITHOUT_FOLLOWING_SYMLINK });
  await fsyncFile(fs, path);
  await fsyncDir(fs, stagingPath);
}

// `mkdir -p` would follow a symlink and create directories outside the library.
export async function ensureRealDirectory(
  fs: LibraryFs,
  root: string,
  dir: string,
): Promise<boolean> {
  let current = root;
  for (const part of relative(root, dir).split(sep)) {
    current = join(current, part);
    const info = await lstatOrNull(fs, current);
    if (!info) await fs.mkdir(current);
    else if (!info.isDirectory()) return false;
  }
  return true;
}

export async function fsyncAncestorsBestEffort(
  fs: LibraryFs,
  root: string,
  dir: string,
): Promise<void> {
  for (let parent = dirname(dir); parent !== dirname(root); parent = dirname(parent)) {
    await fsyncDir(fs, parent).catch(() => {});
  }
}

export async function removeEmptyDir(fs: LibraryFs, dir: string): Promise<boolean> {
  try {
    await fs.rmdir(dir);
    return true;
  } catch {
    return false;
  }
}

export async function resolveDestination(
  fs: LibraryFs,
  root: string,
  destinationDir: string,
): Promise<string | null> {
  try {
    if (!isAbsolute(destinationDir)) return null;
    const [realRoot, destination] = await Promise.all([
      fs.realpath(root),
      fs.realpath(destinationDir),
    ]);
    const inLibrary = destination === realRoot || destination.startsWith(realRoot + sep);
    return !inLibrary && (await fs.stat(destination)).isDirectory() ? destination : null;
  } catch {
    return null;
  }
}

async function freeName(fs: LibraryFs, destination: string, baseName: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const name = attempt === 1 ? baseName : `${baseName} ${attempt}`;
    if (!(await lstatOrNull(fs, join(destination, name)))) return name;
  }
}

export async function copyBundle(
  fs: LibraryFs,
  source: string,
  files: readonly BundleFile[],
  destination: string,
  baseName: string,
): Promise<string> {
  const temp = join(destination, `.figma-drop-copy-${randomUUID()}`);
  await fs.mkdir(temp);
  try {
    if (files.some((file) => file.path.includes('/'))) {
      await fs.mkdir(join(temp, BUNDLE_FILES.previewAssetsDir));
    }
    for (const file of files) {
      await fs.copyFile(join(source, file.path), join(temp, file.path), constants.COPYFILE_EXCL);
    }
    const name = await freeName(fs, destination, baseName);
    await fs.rename(temp, join(destination, name));
    return name;
  } catch (cause) {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    throw cause;
  }
}
