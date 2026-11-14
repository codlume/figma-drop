import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect } from 'vite-plus/test';

import type { CommitResult, Library, StagedExport } from '../shared/integration';
import type {
  ExportNode,
  LibrarySnapshot,
  Project,
  Revision,
  RevisionId,
  StagingId,
} from '../shared/library';
import { openLibrary, type LibraryDeps } from './library';

export type Identity = StagedExport['identity'];
export type CommitSuccess = Extract<CommitResult, { ok: true }>;
export type ReadySnapshot = Extract<LibrarySnapshot, { state: 'ready' }>;

export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
export const HOSTILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
export const HOSTILE_HTML = '<!doctype html><title>x</title><script>alert(1)</script>';
export const SECRET = 'outside-the-library-secret';

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export const sha16 = (value: string): string => sha256(value).slice(0, 16);
export const contentHashOf = (label: string): string => sha256(`content:${label}`);

export const fileIdentity = (fileKey: string): Identity => ({ kind: 'file', fileKey });
export const unidentified = (claimedKey: string | null): Identity => ({
  kind: 'unidentified',
  claimedKey,
});

export const asRevisionId = (id: string): RevisionId => id as RevisionId;

export function stagingIdFor(index: number): StagingId {
  const hex = sha256(`staging:${index}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}` as StagingId;
}

export type StageOptions = {
  stagingId?: string;
  identity?: Identity;
  fileName?: string | null;
  figmaNodeId?: string;
  nodeName?: string | null;
  content?: string;
  exportedAt?: string | null;
  png?: boolean;
  svg?: boolean;
  html?: boolean;
  assets?: Readonly<Record<string, string>>;
  extraFiles?: Readonly<Record<string, string>>;
  omit?: readonly string[];
};

export async function stageExport(
  stagingDir: string,
  stagingId: string,
  options: StageOptions = {},
): Promise<StagedExport> {
  const content = options.content ?? 'A';
  const figmaNodeId = options.figmaNodeId ?? '1:2';
  const exportedAt =
    options.exportedAt === undefined ? '2026-01-01T00:00:00.000Z' : options.exportedAt;
  const files = new Map<string, string | Uint8Array>([
    ['node.json', JSON.stringify({ id: figmaNodeId, content }, null, 2)],
    ['figma-components.json', JSON.stringify([{ content }], null, 2)],
    ['meta.json', JSON.stringify({ nodeId: figmaNodeId, exportedAt }, null, 2)],
  ]);
  if (options.png === true) files.set('preview.png', PNG_BYTES);
  if (options.svg === true) files.set('preview.svg', HOSTILE_SVG);
  if (options.html === true) files.set('preview.html', HOSTILE_HTML);
  for (const [name, text] of Object.entries(options.assets ?? {})) {
    files.set(`preview.assets/${name}`, text);
  }
  for (const [name, text] of Object.entries(options.extraFiles ?? {})) files.set(name, text);
  for (const name of options.omit ?? []) files.delete(name);

  const bundle = path.join(stagingDir, stagingId, 'bundle');
  await fsp.mkdir(bundle, { recursive: true });
  for (const [name, bytes] of files) {
    await fsp.mkdir(path.dirname(path.join(bundle, name)), { recursive: true });
    await fsp.writeFile(path.join(bundle, name), bytes);
  }

  return {
    stagingId: stagingId as StagingId,
    identity: options.identity ?? fileIdentity('file-key-a'),
    fileName: options.fileName === undefined ? 'Design System' : options.fileName,
    figmaNodeId,
    nodeName: options.nodeName === undefined ? 'Hero Card' : options.nodeName,
    contentHash: contentHashOf(content),
    exportedAt,
  };
}

export type FakeTrash = {
  readonly dir: string;
  readonly calls: string[];
  mode: 'move' | 'throw' | 'keep';
  trashItem(target: string): Promise<void>;
};

export function createFakeTrash(dir: string): FakeTrash {
  const trash: FakeTrash = {
    dir,
    calls: [],
    mode: 'move',
    async trashItem(target) {
      trash.calls.push(target);
      if (trash.mode === 'throw') throw new Error(`could not trash ${target}`);
      if (trash.mode === 'keep') return;
      await fsp.rename(target, path.join(dir, `${trash.calls.length}-${path.basename(target)}`));
    },
  };
  return trash;
}

export type FakeClock = {
  now(): Date;
  iso(): string;
  set(iso: string): void;
  advance(ms: number): void;
};

export function createFakeClock(start = '2026-01-01T10:00:00.000Z'): FakeClock {
  let current = Date.parse(start);
  return {
    now: () => new Date(current),
    iso: () => new Date(current).toISOString(),
    set: (iso) => {
      current = Date.parse(iso);
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

export type FsCall = {
  readonly method: string;
  readonly args: readonly unknown[];
  readonly mutating: boolean;
  landed: boolean;
};

type FaultPlan =
  | { kind: 'none' }
  | { kind: 'die'; at: number }
  | { kind: 'once'; at: number; code: string }
  | { kind: 'method'; method: string; nth: number; code: string }
  | { kind: 'all'; code: string };

export type Gate = { reached: Promise<void>; release(): void };

export type InstrumentedFs = {
  readonly fs: LibraryDeps['fs'];
  readonly calls: FsCall[];
  arm(plan?: FaultPlan): void;
  mutationCount(): number;
  fired(): boolean;
  mutationLog(): string[];
  peakInFlight(): number;
  hold(method: string): Gate;
};

const HANDLE_MUTATORS = new Set([
  'sync',
  'datasync',
  'write',
  'writev',
  'writeFile',
  'appendFile',
  'truncate',
  'chmod',
  'chown',
  'utimes',
]);
const HANDLE_READERS = new Set(['read', 'readv', 'readFile', 'stat']);
const FS_MUTATORS = new Set([
  'mkdir',
  'rename',
  'rm',
  'rmdir',
  'writeFile',
  'copyFile',
  'unlink',
  'appendFile',
  'symlink',
  'link',
  'truncate',
  'chmod',
  'utimes',
  'cp',
]);

function opensForWriting(flags: unknown): boolean {
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  if (typeof flags !== 'number') return false;
  return (flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR | fsConstants.O_CREAT)) !== 0;
}

function describeCall(call: FsCall): string {
  return `${call.method}(${call.args.filter((arg) => typeof arg === 'string').join(', ')})`;
}

// Like a real fs error, the message carries the path. It must never reach a user.
function fsError(code: string, call: FsCall): Error {
  return Object.assign(new Error(`${code}: simulated, ${describeCall(call)}`), { code });
}

export function instrumentFs(): InstrumentedFs {
  const calls: FsCall[] = [];
  const gates = new Map<string, { reached(): void; released: Promise<void> }>();
  let plan: FaultPlan = { kind: 'none' };
  let mutations = 0;
  let methodHits = 0;
  let dead = false;
  let fired = false;
  let inFlight = 0;
  let peakInFlight = 0;

  async function run<T>(call: FsCall, real: () => Promise<T>): Promise<T> {
    calls.push(call);
    if (dead) throw fsError('EIO', call);
    if (plan.kind === 'all') throw fsError(plan.code, call);
    if (call.mutating) mutations += 1;
    if (call.mutating && plan.kind === 'die' && mutations === plan.at) {
      dead = true;
      fired = true;
      throw fsError('EIO', call);
    }
    if (call.mutating && plan.kind === 'once' && mutations === plan.at) {
      fired = true;
      throw fsError(plan.code, call);
    }
    if (plan.kind === 'method' && call.method === plan.method) {
      methodHits += 1;
      if (methodHits === plan.nth) {
        fired = true;
        throw fsError(plan.code, call);
      }
    }
    const gate = gates.get(call.method);
    if (gate !== undefined) {
      gates.delete(call.method);
      gate.reached();
      await gate.released;
    }
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      const result = await real();
      call.landed = true;
      return result;
    } finally {
      inFlight -= 1;
    }
  }

  function wrapHandle(handle: FileHandle): FileHandle {
    return new Proxy(handle, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        const method = String(prop);
        const invoke = (args: unknown[]): Promise<unknown> =>
          Reflect.apply(value, target, args) as Promise<unknown>;
        if (method === 'close') {
          return async () => {
            await target.close();
            if (dead) throw new Error('simulated death');
          };
        }
        if (HANDLE_MUTATORS.has(method) || HANDLE_READERS.has(method)) {
          return (...args: unknown[]) =>
            run(
              {
                method: `handle.${method}`,
                args,
                mutating: HANDLE_MUTATORS.has(method),
                landed: false,
              },
              () => invoke(args),
            );
        }
        return value.bind(target);
      },
    });
  }

  const fs = new Proxy(fsp, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return async (...args: unknown[]) => {
        const mutating = FS_MUTATORS.has(prop) || (prop === 'open' && opensForWriting(args[1]));
        const result = await run(
          { method: prop, args, mutating, landed: false },
          () => Reflect.apply(value, target, args) as Promise<unknown>,
        );
        return prop === 'open' ? wrapHandle(result as FileHandle) : result;
      };
    },
  }) as LibraryDeps['fs'];

  return {
    fs,
    calls,
    arm(next = { kind: 'none' }) {
      plan = next;
      calls.length = 0;
      mutations = 0;
      methodHits = 0;
      fired = false;
      peakInFlight = inFlight;
    },
    mutationCount: () => mutations,
    fired: () => fired,
    mutationLog: () => calls.filter((call) => call.mutating).map(describeCall),
    peakInFlight: () => peakInFlight,
    hold(method) {
      const reached = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      gates.set(method, { reached: reached.resolve, released: released.promise });
      return { reached: reached.promise, release: released.resolve };
    },
  };
}

export type Sandbox = {
  readonly base: string;
  readonly root: string;
  readonly outside: string;
  readonly dest: string;
  readonly trash: FakeTrash;
  readonly clock: FakeClock;
  open(fs?: LibraryDeps['fs']): Promise<Library>;
  stage(library: Library, options?: StageOptions): Promise<StagedExport>;
  commit(library: Library, options?: StageOptions): Promise<CommitSuccess>;
};

async function makeWritable(target: string): Promise<void> {
  const info = await fsp.lstat(target).catch(() => null);
  if (info === null || !info.isDirectory()) return;
  await fsp.chmod(target, 0o755).catch(() => {});
  const entries = await fsp.readdir(target).catch(() => []);
  await Promise.all(entries.map((entry) => makeWritable(path.join(target, entry))));
}

export function useSandboxes(): () => Promise<Sandbox> {
  const created: string[] = [];

  afterEach(async () => {
    const tmp = await fsp.realpath(os.tmpdir());
    for (const dir of created.splice(0)) {
      if (!dir.startsWith(`${tmp}${path.sep}figma-drop-library-`)) {
        throw new Error('refusing to clean a directory outside the temp root');
      }
      await makeWritable(dir);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  return async () => {
    const base = await fsp.realpath(
      await fsp.mkdtemp(path.join(os.tmpdir(), 'figma-drop-library-')),
    );
    created.push(base);
    const outside = path.join(base, 'outside');
    const dest = path.join(base, 'dest');
    const trashDir = path.join(base, 'trash');
    await Promise.all([outside, dest, trashDir].map((dir) => fsp.mkdir(dir)));
    await fsp.writeFile(path.join(outside, 'secret.txt'), SECRET);

    const root = path.join(base, 'library');
    const trash = createFakeTrash(trashDir);
    const clock = createFakeClock();
    let stagedCount = 0;

    const sandbox: Sandbox = {
      base,
      root,
      outside,
      dest,
      trash,
      clock,
      open: (fs) =>
        openLibrary(
          { root, trashItem: trash.trashItem },
          fs === undefined ? { now: clock.now } : { fs, now: clock.now },
        ),
      stage(library, options = {}) {
        stagedCount += 1;
        return stageExport(
          library.stagingDir,
          options.stagingId ?? stagingIdFor(stagedCount),
          options,
        );
      },
      async commit(library, options = {}) {
        clock.advance(1000);
        return expectOk(await library.commit(await sandbox.stage(library, options)));
      },
    };
    return sandbox;
  };
}

export function expectOk<Result extends { ok: boolean }>(
  result: Result | null,
): Extract<Result, { ok: true }> {
  expect(result).toMatchObject({ ok: true });
  return result as Extract<Result, { ok: true }>;
}

export function expectFailure(
  result: { ok: true } | { ok: false; code: string; message: string } | null,
  code: string,
): void {
  expect(result).toMatchObject({ ok: false, code });
  if (result !== null && !result.ok) expectSafeMessage(result.message);
}

export function expectSafeMessage(message: string): void {
  expect(message.length).toBeGreaterThan(0);
  expect(message.toLowerCase()).not.toContain('output folder');
  expect(message).not.toMatch(/(^|[\s'"(:=])\/[^\s]/);
}

export function expectReady(snapshot: LibrarySnapshot): ReadySnapshot {
  expect(snapshot.state).toBe('ready');
  return snapshot as ReadySnapshot;
}

export function projectFor(snapshot: ReadySnapshot, fileKey: string): Project {
  const project = snapshot.projects.find((candidate) => candidate.id === sha16(fileKey));
  expect(project, `project for ${fileKey}`).toBeDefined();
  return project as Project;
}

export function nodeFor(project: Project, figmaNodeId: string): ExportNode {
  const node = project.nodes.find(
    (candidate) => candidate.id === `${project.id}-${sha16(figmaNodeId)}`,
  );
  expect(node, `node ${figmaNodeId}`).toBeDefined();
  return node as ExportNode;
}

export const idsOf = (revisions: readonly Revision[]): string[] => revisions.map(({ id }) => id);

export function projectRevisions(snapshot: ReadySnapshot): Revision[] {
  return snapshot.projects.flatMap((project) =>
    project.nodes.flatMap((node) => [...node.revisions]),
  );
}

export function catalogRows(snapshot: ReadySnapshot): Record<string, unknown> {
  const rows: Record<string, unknown> = {};
  for (const project of snapshot.projects) {
    for (const node of project.nodes) {
      for (const revision of node.revisions) {
        rows[revision.id] = {
          project: project.id,
          fileKey: project.fileKey,
          node: node.id,
          revision,
        };
      }
    }
  }
  for (const entry of snapshot.unidentified) rows[entry.id] = { entry };
  return rows;
}

export type Tree = Record<string, string>;

export async function treeOf(dir: string): Promise<Tree> {
  const tree: Tree = {};
  async function walk(current: string): Promise<void> {
    for (const name of (await fsp.readdir(current)).toSorted()) {
      const full = path.join(current, name);
      const relative = path.relative(dir, full);
      const info = await fsp.lstat(full);
      if (info.isSymbolicLink()) {
        tree[relative] = `link:${await fsp.readlink(full)}`;
      } else if (info.isDirectory()) {
        tree[relative] = 'dir';
        await walk(full);
      } else {
        tree[relative] = `file:${createHash('sha256')
          .update(await fsp.readFile(full))
          .digest('hex')}`;
      }
    }
  }
  await walk(dir);
  return tree;
}

export const exists = (target: string): Promise<boolean> =>
  fsp.lstat(target).then(
    () => true,
    () => false,
  );

export const readReceipt = async (revisionDir: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fsp.readFile(path.join(revisionDir, 'receipt.json'), 'utf8')) as Record<
    string,
    unknown
  >;

export async function writeReceiptEdit(
  revisionDir: string,
  edit: (receipt: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const receipt = await readReceipt(revisionDir);
  await fsp.writeFile(path.join(revisionDir, 'receipt.json'), JSON.stringify(edit(receipt)));
}

export const revisionDirOf = (result: { path: string }): string => path.dirname(result.path);
