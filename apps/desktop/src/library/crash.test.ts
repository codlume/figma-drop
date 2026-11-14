import { chmod, mkdir, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import type { Library, StagedExport } from '../shared/integration';
import {
  asRevisionId,
  catalogRows,
  contentHashOf,
  expectFailure,
  expectOk,
  expectReady,
  expectSafeMessage,
  exists,
  fileIdentity,
  idsOf,
  instrumentFs,
  nodeFor,
  projectFor,
  projectRevisions,
  readReceipt,
  revisionDirOf,
  SECRET,
  stagingIdFor,
  treeOf,
  unidentified,
  useSandboxes,
  type Identity,
  type InstrumentedFs,
  type ReadySnapshot,
  type Sandbox,
  type StageOptions,
  type Tree,
} from './fixtures';

const newSandbox = useSandboxes();

type Scenario = {
  name: string;
  options: StageOptions;
  retryStatus: 'skipped' | 'converged';
};

const IDENTIFIED: Identity = fileIdentity('file-key-crash');

const SCENARIOS: Scenario[] = [
  {
    name: 'the first revision of a new project',
    options: { identity: IDENTIFIED, content: 'new', png: true, assets: { 'a.bin': 'x' } },
    retryStatus: 'skipped',
  },
  {
    name: 'a later revision of an existing node',
    options: { identity: fileIdentity('file-key-seed'), content: 'next', svg: true },
    retryStatus: 'skipped',
  },
  {
    name: 'an unidentified export',
    options: { identity: unidentified('claimed'), content: 'loose', png: true },
    retryStatus: 'converged',
  },
];

type Rig = {
  sb: Sandbox;
  fs: InstrumentedFs;
  lib: Library;
  staged: StagedExport;
  stagedBundle: Tree;
  baseline: ReadySnapshot;
  disk: Tree;
};

async function rig(scenario: Scenario): Promise<Rig> {
  const sb = await newSandbox();
  const fs = instrumentFs();
  const lib = await sb.open(fs.fs);
  await sb.commit(lib, { identity: fileIdentity('file-key-seed'), content: 'seed', png: true });
  await sb.commit(lib, { identity: fileIdentity('file-key-other'), content: 'other' });
  await sb.commit(lib, { identity: unidentified('other-claim'), content: 'other' });
  const staged = await sb.stage(lib, scenario.options);
  return {
    sb,
    fs,
    lib,
    staged,
    stagedBundle: await treeOf(path.join(lib.stagingDir, staged.stagingId, 'bundle')),
    baseline: expectReady(await lib.getSnapshot()),
    disk: await catalogFiles(sb),
  };
}

async function catalogFiles(sb: Sandbox, excludeId?: string): Promise<Tree> {
  const tree = {
    ...(await treeOf(path.join(sb.root, 'files'))),
    ...(await treeOf(path.join(sb.root, 'unidentified'))),
  };
  return Object.fromEntries(
    Object.entries(tree).filter(
      ([entry, kind]) => kind !== 'dir' && (excludeId === undefined || !entry.includes(excludeId)),
    ),
  );
}

async function mutationsInCleanCommit(scenario: Scenario): Promise<number> {
  const { fs, lib, staged } = await rig(scenario);
  fs.arm();
  expect(await lib.commit(staged)).toMatchObject({ ok: true, status: 'committed' });
  const count = fs.mutationCount();
  expect(count).toBeGreaterThanOrEqual(3);
  return count;
}

const renameLanded = (fs: InstrumentedFs, stagingId: string): boolean =>
  fs.calls.some(
    ({ method, args, landed }) =>
      method === 'rename' && landed && path.basename(String(args[1])).endsWith(stagingId),
  );

async function expectConsistentAfterRelaunch(
  { sb, staged, stagedBundle, baseline, disk }: Rig,
  scenario: Scenario,
  label: string,
): Promise<void> {
  const reopened = await sb.open();
  const snapshot = expectReady(await reopened.getSnapshot());
  const rows = catalogRows(snapshot);
  const { [staged.stagingId]: landedRow, ...others } = rows;

  expect(others, `${label}: other revisions`).toEqual(catalogRows(baseline));
  expect(await catalogFiles(sb, staged.stagingId), `${label}: other files`).toEqual(disk);
  expect(await readdir(reopened.stagingDir), `${label}: staging`).toEqual([]);

  const landed = [...projectRevisions(snapshot), ...snapshot.unidentified].find(
    ({ id }) => String(id) === staged.stagingId,
  );
  if (landed === undefined) {
    expect(landedRow, label).toBeUndefined();
    const leftovers = Object.keys({
      ...(await treeOf(path.join(sb.root, 'files'))),
      ...(await treeOf(path.join(sb.root, 'unidentified'))),
    }).filter((entry) => entry.includes(staged.stagingId));
    expect(leftovers, `${label}: nothing half published`).toEqual([]);
  } else {
    expect(landed.state, `${label}: receipt`).toBe('ok');
    expect(await treeOf(landed.bundlePath), `${label}: bundle`).toEqual(stagedBundle);
    expect(await readReceipt(path.dirname(landed.bundlePath)), label).toMatchObject({
      schemaVersion: 1,
      revisionId: staged.stagingId,
      contentHash: staged.contentHash,
    });
    expect(await reopened.commit(staged), `${label}: replay`).toMatchObject({
      ok: true,
      status: 'converged',
      revisionId: staged.stagingId,
      path: landed.bundlePath,
    });
  }

  const retried = await sb.stage(reopened, scenario.options);
  const reply = expectOk(await reopened.commit(retried));

  expect(reply.status, `${label}: retry`).toBe(
    landed === undefined ? 'committed' : scenario.retryStatus,
  );
  expect(reply.revisionId, label).toBe(landed === undefined ? retried.stagingId : staged.stagingId);
  expect(await exists(reply.path), label).toBe(true);

  const final = expectReady(await (await sb.open()).getSnapshot());
  expect(Object.keys(catalogRows(final)).toSorted(), `${label}: exactly one revision`).toEqual(
    [...Object.keys(catalogRows(baseline)), reply.revisionId].toSorted(),
  );
}

describe.each(SCENARIOS)('commit of $name', (scenario) => {
  it('survives process death at every mutating call', async () => {
    const total = await mutationsInCleanCommit(scenario);

    for (let at = 1; at <= total; at += 1) {
      const context = await rig(scenario);
      context.fs.arm({ kind: 'die', at });

      await expect(context.lib.commit(context.staged)).resolves.toBeDefined();

      const label = `death at call ${at} of ${total}: ${context.fs.mutationLog()[at - 1]}`;
      expect(context.fs.fired(), label).toBe(true);
      await expectConsistentAfterRelaunch(context, scenario, label);
    }
  }, 120_000);

  it('reports a one-off ENOSPC truthfully at every mutating call', async () => {
    const total = await mutationsInCleanCommit(scenario);

    for (let at = 1; at <= total; at += 1) {
      const context = await rig(scenario);
      const { fs, lib, staged } = context;
      fs.arm({ kind: 'once', at, code: 'ENOSPC' });

      const result = await lib.commit(staged);

      const label = `ENOSPC at call ${at} of ${total}: ${fs.mutationLog()[at - 1]}`;
      expect(fs.fired(), label).toBe(true);
      if (renameLanded(fs, staged.stagingId)) {
        expect(result, label).toMatchObject({
          ok: true,
          status: 'committed',
          revisionId: staged.stagingId,
        });
        expect(await exists(expectOk(result).path), label).toBe(true);
      } else {
        expect(result, label).toMatchObject({ ok: false, code: 'disk-full' });
        if (!result.ok) expectSafeMessage(result.message);
        const rows = catalogRows(expectReady(await lib.getSnapshot()));
        expect(rows, label).toEqual(catalogRows(context.baseline));
      }
      await expectConsistentAfterRelaunch(context, scenario, label);
    }
  }, 120_000);
});

describe('a matched commit', () => {
  it('still replies skipped when removing the staging directory fails', async () => {
    const counter = await newSandbox();
    const counterFs = instrumentFs();
    const counterLib = await counter.open(counterFs.fs);
    await counter.commit(counterLib);
    const probe = await counter.stage(counterLib);
    counterFs.arm();
    await counterLib.commit(probe);
    const total = counterFs.mutationCount();
    expect(total).toBeGreaterThan(0);

    for (let at = 1; at <= total; at += 1) {
      const sb = await newSandbox();
      const fs = instrumentFs();
      const lib = await sb.open(fs.fs);
      const first = await sb.commit(lib);
      const staged = await sb.stage(lib);
      fs.arm({ kind: 'once', at, code: 'EIO' });

      expect(await lib.commit(staged)).toMatchObject({
        ok: true,
        status: 'skipped',
        revisionId: first.revisionId,
      });

      await sb.open();
      expect(await readdir(lib.stagingDir)).toEqual([]);
    }
  });
});

describe('error mapping', () => {
  const codes: [string, string][] = [
    ['ENOSPC', 'disk-full'],
    ['EDQUOT', 'disk-full'],
    ['EACCES', 'unavailable'],
    ['EPERM', 'unavailable'],
    ['EROFS', 'unavailable'],
    ['EIO', 'unavailable'],
    ['ENOTDIR', 'unavailable'],
    ['EBUSY', 'failed'],
    ['EMFILE', 'failed'],
  ];

  it.each(codes)('maps %s on a write to %s', async (code, expected) => {
    const sb = await newSandbox();
    const fs = instrumentFs();
    const lib = await sb.open(fs.fs);
    const staged = await sb.stage(lib);
    fs.arm({ kind: 'once', at: 1, code });

    expectFailure(await lib.commit(staged), expected);
    expect(fs.fired()).toBe(true);
  });

  it('commits the same staging id again after a one-off failure', async () => {
    const sb = await newSandbox();
    const fs = instrumentFs();
    const lib = await sb.open(fs.fs);
    const staged = await sb.stage(lib);
    fs.arm({ kind: 'once', at: 1, code: 'ENOSPC' });
    expectFailure(await lib.commit(staged), 'disk-full');

    if (!(await exists(path.join(lib.stagingDir, staged.stagingId, 'bundle')))) {
      await sb.stage(lib, { stagingId: staged.stagingId });
    }

    expect(await lib.commit(staged)).toMatchObject({
      ok: true,
      status: 'committed',
      revisionId: staged.stagingId,
    });
  });

  it('keeps running queued commands after one of them fails', async () => {
    const sb = await newSandbox();
    const fs = instrumentFs();
    const lib = await sb.open(fs.fs);
    const doomed = await sb.stage(lib, { content: 'A' });
    const next = await sb.stage(lib, { content: 'B', figmaNodeId: '2:2' });
    fs.arm({ kind: 'once', at: 1, code: 'EBUSY' });

    const [failed, committed, snapshot] = await Promise.all([
      lib.commit(doomed),
      lib.commit(next),
      lib.getSnapshot(),
    ]);

    expectFailure(failed, 'failed');
    expect(committed).toMatchObject({ ok: true, status: 'committed', revisionId: next.stagingId });
    expect(idsOf(projectRevisions(expectReady(snapshot)))).toEqual([next.stagingId]);
  });

  it('never rejects when every filesystem call fails', async () => {
    const sb = await newSandbox();
    const fs = instrumentFs();
    const lib = await sb.open(fs.fs);
    const staged = await sb.stage(lib);
    fs.arm({ kind: 'all', code: 'EIO' });

    expectFailure(await lib.commit(staged), 'unavailable');
  });

  it('keeps the OS path and the forbidden words out of messages from hostile input', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await sb.stage(lib, {
      nodeName: 'output folder',
      fileName: '/etc/output folder',
    });
    const bad = '/etc/output folder' as StagedExport['stagingId'];

    expectFailure(await lib.commit({ ...staged, stagingId: bad }), 'failed');
    expectFailure(await lib.commit({ ...staged, contentHash: 'output folder' }), 'failed');
    expectFailure(await lib.copyTo(asRevisionId('/etc/output folder'), sb.dest), 'not-found');
  });
});

describe('an oversized export', () => {
  it('refuses a receipt over the read cap, so a saved export never reads back damaged', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await sb.stage(lib, { nodeName: 'x'.repeat(2 * 1024 * 1024) });

    expect(await lib.commit(staged)).toMatchObject({ ok: false, code: 'failed' });

    expect(expectReady(await lib.getSnapshot()).projects).toEqual([]);
  });
});

describe('listeners', () => {
  it('does not fail a commit or a trash when a listener throws', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    lib.onChanged(() => {
      throw new Error('listener bug');
    });

    const committed = await sb.commit(lib);
    expect(committed.status).toBe('committed');

    expect(await lib.trash(committed.revisionId)).toEqual({ ok: true });
  });
});

async function expectUnreadable(lib: Library, sb: Sandbox): Promise<void> {
  const snapshot = await lib.getSnapshot();
  expect(snapshot).toMatchObject({ state: 'unreadable', projects: [], unidentified: [] });
  if (snapshot.state !== 'ready') expectSafeMessage(snapshot.message);

  const id = asRevisionId(stagingIdFor(901));
  const staged = {
    stagingId: stagingIdFor(901),
    identity: fileIdentity('k'),
    fileName: null,
    figmaNodeId: '1:2',
    nodeName: null,
    contentHash: contentHashOf('A'),
    exportedAt: null,
  };
  expectFailure(await lib.commit(staged), 'unavailable');
  expectFailure(await lib.bundlePath(id), 'unavailable');
  expectFailure(await lib.copyTo(id, sb.dest), 'unavailable');
  expectFailure(await lib.trash(id), 'unavailable');
  expect(await lib.previewFile(id)).toBeNull();
  expect(await lib.locate('/etc/passwd')).toBeNull();
  const found = await lib.findExport(staged);
  expect(found === null || !found.ok).toBe(true);
}

describe('an unreadable library', () => {
  it('resolves with a working library when the root is a file, and recovers', async () => {
    const sb = await newSandbox();
    await writeFile(sb.root, 'not a directory');

    const lib = await sb.open();
    await expectUnreadable(lib, sb);

    await rm(sb.root);
    expect(await lib.getSnapshot()).toEqual({ state: 'ready', projects: [], unidentified: [] });
    expect(await sb.commit(lib)).toMatchObject({ status: 'committed' });
  });

  it('resolves when the root cannot be read, and recovers with its catalog', async () => {
    const sb = await newSandbox();
    const seeded = await sb.open();
    const first = await sb.commit(seeded);
    await chmod(sb.root, 0o000);

    try {
      const lib = await sb.open();
      await expectUnreadable(lib, sb);

      await chmod(sb.root, 0o755);
      expect(idsOf(projectRevisions(expectReady(await lib.getSnapshot())))).toEqual([
        first.revisionId,
      ]);
      expect(await lib.locate(first.path)).toEqual({
        kind: 'revision',
        revisionId: first.revisionId,
      });
    } finally {
      await chmod(sb.root, 0o755);
    }
  });

  it('recovers from commit and keeps the export that triggered the recovery', async () => {
    const sb = await newSandbox();
    await writeFile(sb.root, 'not a directory');
    const lib = await sb.open();
    await rm(sb.root);
    const staged = await sb.stage(lib);

    const first = expectOk(await lib.commit(staged));

    expect(first).toMatchObject({ status: 'committed', revisionId: staged.stagingId });
    expect(await exists(path.join(first.path, 'node.json'))).toBe(true);
  });

  it('never sweeps staging after the open call, so recovery spares exports in flight', async () => {
    const sb = await newSandbox();
    await writeFile(sb.root, 'not a directory');
    const lib = await sb.open();
    await rm(sb.root);
    const inFlight = await sb.stage(lib, { content: 'in flight' });

    expectReady(await lib.getSnapshot());
    await sb.commit(lib, { content: 'other' });

    expect(await lib.commit(inFlight)).toMatchObject({ ok: true, status: 'committed' });
  });

  it.each([
    ['unreadable', 0o000],
    ['unsearchable', 0o400],
  ])('keeps ingesting when one node directory is %s, and recovers it', async (_name, mode) => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const blocked = await sb.commit(lib, { identity: fileIdentity('blocked') });
    const nodeDir = path.dirname(revisionDirOf(blocked));
    await chmod(nodeDir, mode);

    try {
      for (const opened of [lib, await sb.open()]) {
        expectReady(await opened.getSnapshot());
        expect(
          await sb.commit(opened, { identity: fileIdentity('other'), content: `f${mode}` }),
        ).toMatchObject({ status: expect.stringMatching(/committed|skipped/) });
        expect(
          await sb.commit(opened, { identity: unidentified(null), content: `u${mode}` }),
        ).toMatchObject({ status: expect.stringMatching(/committed|converged/) });
      }
      const sameNode = await lib.commit(
        await sb.stage(lib, { identity: fileIdentity('blocked'), content: 'B' }),
      );
      expect(sameNode).toMatchObject({ ok: false, code: 'unavailable' });
    } finally {
      await chmod(nodeDir, 0o755);
    }

    const snapshot = expectReady(await lib.getSnapshot());
    expect(idsOf(nodeFor(projectFor(snapshot, 'blocked'), '1:2').revisions)).toEqual([
      blocked.revisionId,
    ]);
  });

  it.each([
    ['listing refused, writing allowed', 'node', 0o300],
    ['project listing refused, writing allowed', 'project', 0o300],
  ])('refuses a commit into a hidden branch: %s', async (_name, level, mode) => {
    const sb = await newSandbox();
    const seeded = await sb.open();
    await sb.commit(seeded, { content: 'A' });
    const b = await sb.commit(seeded, { content: 'B' });
    const nodeDir = path.dirname(revisionDirOf(b));
    const hidden = level === 'node' ? nodeDir : path.dirname(nodeDir);
    await chmod(hidden, mode);

    const lib = await sb.open();
    const staged = await sb.stage(lib, { content: 'C' });
    try {
      expect(await lib.commit(staged)).toMatchObject({ ok: false, code: 'unavailable' });
      expect(await lib.findExport(staged)).toMatchObject({ ok: false, code: 'unavailable' });
    } finally {
      await chmod(hidden, 0o755);
    }

    const c = expectOk(await lib.commit(staged));
    expect(path.basename(path.dirname(c.path)).slice(0, 6)).toBe('000003');
    const revert = await sb.commit(lib, { content: 'B' });
    expect(revert).toMatchObject({ status: 'committed' });
    const node = nodeFor(projectFor(expectReady(await lib.getSnapshot()), 'file-key-a'), '1:2');
    expect(node.revisions[0]?.id).toBe(revert.revisionId);
    expect(node.revisions).toHaveLength(4);
  });

  it('rescans a branch that was hidden at open and has since been restored', async () => {
    const sb = await newSandbox();
    const seeded = await sb.open();
    await sb.commit(seeded, { content: 'A' });
    const b = await sb.commit(seeded, { content: 'B' });
    const nodeDir = path.dirname(revisionDirOf(b));
    await chmod(nodeDir, 0o000);
    const lib = await sb.open();
    await chmod(nodeDir, 0o755);

    const c = await sb.commit(lib, { content: 'C' });

    expect(path.basename(path.dirname(c.path)).slice(0, 6)).toBe('000003');
  });

  it('fails a whole scan on a transient error rather than guessing a branch is empty', async () => {
    const sb = await newSandbox();
    const instrumented = instrumentFs();
    const lib = await sb.open(instrumented.fs);
    await sb.commit(lib, { content: 'A' });
    await sb.commit(lib, { content: 'B' });
    instrumented.arm({ kind: 'method', method: 'readdir', nth: 3, code: 'EMFILE' });

    expect((await lib.getSnapshot()).state).toBe('unreadable');

    const c = await sb.commit(lib, { content: 'C' });
    expect(path.basename(path.dirname(c.path)).slice(0, 6)).toBe('000003');
  });

  it('keeps ingesting when one project directory is unreadable', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const blocked = await sb.commit(lib, { identity: fileIdentity('blocked') });
    const projectDir = path.dirname(path.dirname(revisionDirOf(blocked)));
    await chmod(projectDir, 0o000);

    try {
      const relaunched = await sb.open();
      expectReady(await relaunched.getSnapshot());
      expect(
        await sb.commit(relaunched, { identity: fileIdentity('other'), content: 'after' }),
      ).toMatchObject({ status: 'committed' });
    } finally {
      await chmod(projectDir, 0o755);
    }
    expect(projectFor(expectReady(await lib.getSnapshot()), 'blocked').nodes).toHaveLength(1);
  });

  it('treats a file at files/ as unreadable', async () => {
    const sb = await newSandbox();
    await mkdir(sb.root);
    await writeFile(path.join(sb.root, 'files'), 'not a directory');

    const lib = await sb.open();
    await expectUnreadable(lib, sb);

    await rm(path.join(sb.root, 'files'));
    expectReady(await lib.getSnapshot());
  });

  it('does not sweep through a .staging symlink, and recovers once it is gone', async () => {
    const sb = await newSandbox();
    await mkdir(sb.root);
    await symlink(sb.outside, path.join(sb.root, '.staging'));
    const outside = await treeOf(sb.outside);

    const lib = await sb.open();

    await expectUnreadable(lib, sb);
    expect(await treeOf(sb.outside)).toEqual(outside);

    await rm(path.join(sb.root, '.staging'));
    expectReady(await lib.getSnapshot());
    expect((await stat(path.join(sb.root, '.staging'))).isDirectory()).toBe(true);
    expect(await treeOf(sb.outside)).toEqual(outside);
    expect(await sb.commit(lib)).toMatchObject({ status: 'committed' });
  });

  it('treats a file at .staging as unreadable and leaves it alone', async () => {
    const sb = await newSandbox();
    await mkdir(sb.root);
    await writeFile(path.join(sb.root, '.staging'), SECRET);

    const lib = await sb.open();

    await expectUnreadable(lib, sb);
    expect(await treeOf(sb.root)).toMatchObject({ '.staging': expect.stringMatching(/^file:/) });
  });

  it('degrades and recovers mid-session without sweeping in-flight staging', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib);
    const inFlight = await sb.stage(lib, { content: 'B' });
    await chmod(sb.root, 0o000);

    try {
      const snapshot = await lib.getSnapshot();
      expect(snapshot.state).not.toBe('ready');
      expect(snapshot).toMatchObject({ projects: [], unidentified: [] });
      expectFailure(await lib.commit(inFlight), 'unavailable');
    } finally {
      await chmod(sb.root, 0o755);
    }

    expect(idsOf(projectRevisions(expectReady(await lib.getSnapshot())))).toEqual([
      first.revisionId,
    ]);
    expect(await lib.commit(inFlight)).toMatchObject({ ok: true, status: 'committed' });
  });
});

describe('changes behind the library', () => {
  it('commits a new revision when the matched revision was deleted in Finder', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib);
    await rm(revisionDirOf(first), { recursive: true });
    const staged = await sb.stage(lib);

    const repeat = expectOk(await lib.commit(staged));

    expect(repeat).toMatchObject({ status: 'committed', revisionId: staged.stagingId });
    expect(await exists(repeat.path)).toBe(true);
    const snapshot = expectReady(await lib.getSnapshot());
    expect(idsOf(projectRevisions(snapshot))).toEqual([staged.stagingId]);
  });

  it('commits a new revision when only the bundle was deleted and the receipt remains', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib);
    await rm(first.path, { recursive: true });
    const staged = await sb.stage(lib);

    const repeat = expectOk(await lib.commit(staged));

    expect(repeat).toMatchObject({ status: 'committed', revisionId: staged.stagingId });
    expect(path.basename(path.dirname(repeat.path))).toBe(`000002-${staged.stagingId}`);
    expect(await exists(repeat.path)).toBe(true);
    expect(await exists(path.join(revisionDirOf(first), 'receipt.json'))).toBe(true);
  });

  it('shows a revision whose bundle was deleted as damaged, with its receipt left alone', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib, { png: true });
    await rm(first.path, { recursive: true });
    const receipt = await readReceipt(revisionDirOf(first));

    const [revision] = projectRevisions(expectReady(await lib.getSnapshot()));

    expect(revision).toMatchObject({ id: first.revisionId, state: 'damaged', preview: null });
    expect(await lib.previewFile(first.revisionId)).toBeNull();
    expect(await readReceipt(revisionDirOf(first))).toEqual(receipt);
  });

  it('commits a new entry when a matched unidentified bundle was deleted', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib, { identity: unidentified(null) });
    await rm(first.path, { recursive: true });
    const staged = await sb.stage(lib, { identity: unidentified(null) });

    const repeat = expectOk(await lib.commit(staged));

    expect(repeat).toMatchObject({ status: 'committed', revisionId: staged.stagingId });
    expect(await exists(repeat.path)).toBe(true);
  });

  it('commits a new entry when a matched unidentified directory was deleted', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib, { identity: unidentified(null) });
    await rm(revisionDirOf(first), { recursive: true });
    const staged = await sb.stage(lib, { identity: unidentified(null) });

    const repeat = expectOk(await lib.commit(staged));

    expect(repeat).toMatchObject({ status: 'committed', revisionId: staged.stagingId });
    expect(idsOf(expectReady(await lib.getSnapshot()).unidentified)).toEqual([staged.stagingId]);
  });

  it('finds nothing when only the bundle was deleted and the receipt remains', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib);
    await rm(first.path, { recursive: true });

    const found = await lib.findExport({
      identity: fileIdentity('file-key-a'),
      figmaNodeId: '1:2',
      contentHash: contentHashOf('A'),
    });

    expect(found).toBeNull();
  });

  it('never replays a staging id into a path that was deleted', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await sb.stage(lib);
    const first = expectOk(await lib.commit(staged));
    await rm(revisionDirOf(first), { recursive: true });

    expect(await lib.commit(staged)).toMatchObject({ ok: false, code: 'failed' });
  });

  it('fails a replay whose bundle was deleted, never naming the missing path', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await sb.stage(lib);
    const first = expectOk(await lib.commit(staged));
    await rm(first.path, { recursive: true });

    expect(await lib.commit(staged)).toMatchObject({ ok: false, code: 'failed' });
  });

  it('never replies with a matched bundle that became a symlink', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib);
    const copy = path.join(sb.outside, 'bundle-copy');
    await rename(first.path, copy);
    await symlink(copy, first.path);
    const staged = await sb.stage(lib);

    const repeat = expectOk(await lib.commit(staged));

    expect(repeat).toMatchObject({ status: 'committed', revisionId: staged.stagingId });
    expect(repeat.path).not.toBe(first.path);
  });

  it('adds to a node whose older revision was deleted, keeping seq above what remains', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib, { content: 'A' });
    const second = await sb.commit(lib, { content: 'B' });
    await rm(revisionDirOf(first), { recursive: true });

    const third = await sb.commit(lib, { content: 'C' });

    expect(path.basename(path.dirname(third.path)).slice(0, 6)).toBe('000003');
    const node = nodeFor(projectFor(expectReady(await lib.getSnapshot()), 'file-key-a'), '1:2');
    expect(idsOf(node.revisions)).toEqual([third.revisionId, second.revisionId]);
  });
});
