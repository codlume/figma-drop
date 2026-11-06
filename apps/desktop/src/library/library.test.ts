import { mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { previewUrl } from '../shared/library';
import {
  contentHashOf,
  expectFailure,
  expectOk,
  expectReady,
  fileIdentity,
  HOSTILE_HTML,
  HOSTILE_SVG,
  idsOf,
  nodeFor,
  PNG_BYTES,
  projectFor,
  projectRevisions,
  readReceipt,
  revisionDirOf,
  sha16,
  stageExport,
  stagingIdFor,
  treeOf,
  unidentified,
  useSandboxes,
  asRevisionId,
  type Sandbox,
} from './fixtures';

const newSandbox = useSandboxes();

const seqOf = (result: { path: string }): string =>
  path.basename(revisionDirOf(result)).slice(0, 6);

const fileDirName = (slug: string, key: string): string => `${slug}-${sha16(key)}`;

describe('disk layout', () => {
  it('opens with the staging directory inside the root and creates the skeleton', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();

    expect(lib.stagingDir).toBe(path.join(sb.root, '.staging'));
    expect((await readdir(sb.root)).toSorted()).toEqual(['.staging', 'files', 'unidentified']);
    expect(await lib.getSnapshot()).toEqual({ state: 'ready', projects: [], unidentified: [] });
  });

  it('publishes a project revision at the promised path with its bytes intact', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await sb.stage(lib, {
      identity: fileIdentity('KEY'),
      fileName: 'Design System',
      figmaNodeId: '1:2',
      nodeName: 'Hero Card',
      png: true,
      svg: true,
      html: true,
      assets: { 'img-1.png': 'asset-bytes' },
    });
    const stagedTree = await treeOf(path.join(lib.stagingDir, staged.stagingId, 'bundle'));

    const result = await lib.commit(staged);

    const revisionDir = path.join(
      sb.root,
      'files',
      fileDirName('design-system', 'KEY'),
      `hero-card-${sha16('1:2')}`,
      `000001-${staged.stagingId}`,
    );
    const bundle = path.join(revisionDir, 'bundle');
    expect(result).toStrictEqual({
      ok: true,
      status: 'committed',
      revisionId: staged.stagingId,
      path: bundle,
      preview: path.join(bundle, 'preview.png'),
    });
    expect(await treeOf(bundle)).toEqual(stagedTree);
    expect(await readdir(lib.stagingDir)).toEqual([]);
  });

  it('writes a receipt carrying every promised field', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    sb.clock.set('2026-05-05T05:05:05.005Z');
    const staged = await sb.stage(lib, {
      identity: fileIdentity('KEY'),
      fileName: 'File',
      figmaNodeId: '7:7',
      nodeName: 'Node',
      content: 'receipt',
      exportedAt: '2026-04-04T04:04:04.004Z',
      png: true,
      assets: { 'a.bin': 'xyz' },
    });

    const result = expectOk(await lib.commit(staged));

    const bundle = result.path;
    const sizes = await Promise.all(
      [
        'figma-components.json',
        'meta.json',
        'node.json',
        'preview.assets/a.bin',
        'preview.png',
      ].map(async (file) => ({ path: file, bytes: (await stat(path.join(bundle, file))).size })),
    );
    const receipt = await readReceipt(revisionDirOf(result));
    const files = receipt['files'] as { path: string; bytes: number }[];
    expect([...files].toSorted((a, b) => a.path.localeCompare(b.path))).toEqual(sizes);
    expect({ ...receipt, files: [] }).toEqual({
      schemaVersion: 1,
      revisionId: staged.stagingId,
      receivedAt: '2026-05-05T05:05:05.005Z',
      contentHash: contentHashOf('receipt'),
      exportedAt: '2026-04-04T04:04:04.004Z',
      identity: { kind: 'file', fileKey: 'KEY' },
      fileName: 'File',
      figmaNodeId: '7:7',
      nodeName: 'Node',
      files: [],
    });
  });

  it('publishes an unidentified export as a standalone slug-uuid directory', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await sb.stage(lib, {
      identity: unidentified('claimed'),
      nodeName: 'Hero Card',
    });

    const result = expectOk(await lib.commit(staged));

    const directory = revisionDirOf(result);
    expect(path.dirname(directory)).toBe(path.join(sb.root, 'unidentified'));
    expect(path.basename(directory)).toMatch(new RegExp(`^[a-z0-9-]{1,40}-${staged.stagingId}$`));
    expect(result.path).toBe(path.join(directory, 'bundle'));
    expect(await readReceipt(directory)).toMatchObject({
      revisionId: staged.stagingId,
      identity: { kind: 'unidentified', claimedKey: 'claimed' },
    });
    expect(await readdir(path.join(sb.root, 'files'))).toEqual([]);
  });

  it('numbers revisions max(existing)+1, so a gap stays and a trashed top is reused', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib, { content: 'A' });
    const second = await sb.commit(lib, { content: 'B' });
    const third = await sb.commit(lib, { content: 'C' });
    expect([first, second, third].map(seqOf)).toEqual(['000001', '000002', '000003']);

    expectOk(await lib.trash(second.revisionId));
    const fourth = await sb.commit(lib, { content: 'D' });
    expect(seqOf(fourth)).toBe('000004');

    expectOk(await lib.trash(fourth.revisionId));
    const reused = await sb.commit(lib, { content: 'E' });
    expect(seqOf(reused)).toBe('000004');
  });

  it('createLibrary from the package entry opens a working library', async () => {
    const sb = await newSandbox();
    const { createLibrary } = await import('./index');
    const lib = await createLibrary({ root: sb.root, trashItem: sb.trash.trashItem });

    const result = await lib.commit(await sb.stage(lib));

    expect(result).toMatchObject({ ok: true, status: 'committed' });
  });
});

describe('grouping', () => {
  it('keeps two file keys in two projects', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const a = await sb.commit(lib, { identity: fileIdentity('key-a'), fileName: 'Alpha' });
    const b = await sb.commit(lib, { identity: fileIdentity('key-b'), fileName: 'Beta' });

    const snapshot = expectReady(await lib.getSnapshot());

    expect(snapshot.projects).toHaveLength(2);
    expect(projectFor(snapshot, 'key-a')).toMatchObject({ fileKey: 'key-a', fileName: 'Alpha' });
    expect(projectFor(snapshot, 'key-b')).toMatchObject({ fileKey: 'key-b', fileName: 'Beta' });
    expect(idsOf(nodeFor(projectFor(snapshot, 'key-a'), '1:2').revisions)).toEqual([a.revisionId]);
    expect(idsOf(nodeFor(projectFor(snapshot, 'key-b'), '1:2').revisions)).toEqual([b.revisionId]);
  });

  it('keeps two files with one name apart, even with identical content', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const a = await sb.commit(lib, { identity: fileIdentity('key-a'), fileName: 'Untitled' });
    const staged = await sb.stage(lib, { identity: fileIdentity('key-b'), fileName: 'Untitled' });

    const b = await lib.commit(staged);

    expect(b).toMatchObject({ ok: true, status: 'committed', revisionId: staged.stagingId });
    const snapshot = expectReady(await lib.getSnapshot());
    expect(snapshot.projects.map(({ fileName }) => fileName)).toEqual(['Untitled', 'Untitled']);
    expect(projectRevisions(snapshot)).toHaveLength(2);
    expect(revisionDirOf(a)).not.toBe(revisionDirOf(expectOk(b)));
    expect((await readdir(path.join(sb.root, 'files'))).toSorted()).toEqual(
      [fileDirName('untitled', 'key-a'), fileDirName('untitled', 'key-b')].toSorted(),
    );
  });

  it('keeps a project and reuses its directories when the names change later', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    await sb.commit(lib, { content: 'A', fileName: 'Old File', nodeName: 'Old Node' });
    const second = await sb.commit(lib, {
      content: 'B',
      fileName: 'New File',
      nodeName: 'New Node',
    });

    const snapshot = expectReady(await lib.getSnapshot());

    expect(snapshot.projects).toHaveLength(1);
    const project = projectFor(snapshot, 'file-key-a');
    expect(project.fileName).toBe('New File');
    expect(project.nodes).toHaveLength(1);
    expect(nodeFor(project, '1:2').name).toBe('New Node');
    expect(nodeFor(project, '1:2').revisions).toHaveLength(2);
    expect(await readdir(path.join(sb.root, 'files'))).toEqual([
      fileDirName('old-file', 'file-key-a'),
    ]);
    expect(path.basename(path.dirname(revisionDirOf(second)))).toBe(`old-node-${sha16('1:2')}`);
  });

  it('keeps one node id in two files as two nodes', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    await sb.commit(lib, { identity: fileIdentity('key-a') });
    await sb.commit(lib, { identity: fileIdentity('key-b') });

    const snapshot = expectReady(await lib.getSnapshot());

    expect(nodeFor(projectFor(snapshot, 'key-a'), '1:2').id).toBe(
      `${sha16('key-a')}-${sha16('1:2')}`,
    );
    expect(nodeFor(projectFor(snapshot, 'key-b'), '1:2').id).toBe(
      `${sha16('key-b')}-${sha16('1:2')}`,
    );
  });

  it('never joins unidentified to a project, even when claimedKey equals a real fileKey', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const real = await sb.commit(lib, { identity: fileIdentity('shared-key'), content: 'A' });
    const staged = await sb.stage(lib, { identity: unidentified('shared-key'), content: 'A' });

    const claimed = await lib.commit(staged);

    expect(claimed).toMatchObject({ ok: true, status: 'committed', revisionId: staged.stagingId });
    expect(path.dirname(revisionDirOf(expectOk(claimed)))).toBe(path.join(sb.root, 'unidentified'));
    const snapshot = expectReady(await lib.getSnapshot());
    expect(idsOf(projectRevisions(snapshot))).toEqual([real.revisionId]);
    expect(idsOf(snapshot.unidentified)).toEqual([staged.stagingId]);
  });

  it('does not treat an earlier unidentified entry as a match for a real file', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    await sb.commit(lib, { identity: unidentified('shared-key'), content: 'A' });
    const staged = await sb.stage(lib, { identity: fileIdentity('shared-key'), content: 'A' });

    expect(await lib.commit(staged)).toMatchObject({ ok: true, status: 'committed' });
    const snapshot = expectReady(await lib.getSnapshot());
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.unidentified).toHaveLength(1);
  });

  it('takes the identity classification as given, with no fallback or key-shape logic', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    await sb.commit(lib, { identity: fileIdentity('current'), fileName: 'current' });

    const snapshot = expectReady(await lib.getSnapshot());

    expect(projectFor(snapshot, 'current').fileKey).toBe('current');
    expect(snapshot.unidentified).toEqual([]);
  });
});

describe('revision history', () => {
  it('skips an identical repeat with the original path and adds nothing', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib, { png: true });
    const tree = await treeOf(path.join(sb.root, 'files'));
    const staged = await sb.stage(lib, { png: true });

    const repeat = await lib.commit(staged);

    expect(repeat).toStrictEqual({
      ok: true,
      status: 'skipped',
      revisionId: first.revisionId,
      path: first.path,
      preview: path.join(first.path, 'preview.png'),
    });
    expect(await treeOf(path.join(sb.root, 'files'))).toEqual(tree);
    expect(await readdir(lib.stagingDir)).toEqual([]);
  });

  it('skips a repeat that differs only in exportedAt and keeps the original receipt', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib, { exportedAt: '2026-01-01T00:00:00.000Z' });
    const staged = await sb.stage(lib, { exportedAt: '2026-09-09T09:09:09.000Z' });

    const repeat = await lib.commit(staged);

    expect(repeat).toMatchObject({ ok: true, status: 'skipped', revisionId: first.revisionId });
    expect(await readReceipt(revisionDirOf(first))).toMatchObject({
      exportedAt: '2026-01-01T00:00:00.000Z',
    });
    const node = nodeFor(projectFor(expectReady(await lib.getSnapshot()), 'file-key-a'), '1:2');
    expect(node.revisions).toHaveLength(1);
  });

  it('keeps A, B, A as three revisions, newest first', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const a1 = await sb.commit(lib, { content: 'A' });
    const b = await sb.commit(lib, { content: 'B' });
    const a2 = await sb.commit(lib, { content: 'A' });

    expect([a1.status, b.status, a2.status]).toEqual(['committed', 'committed', 'committed']);
    const node = nodeFor(projectFor(expectReady(await lib.getSnapshot()), 'file-key-a'), '1:2');
    expect(idsOf(node.revisions)).toEqual([a2.revisionId, b.revisionId, a1.revisionId]);
  });

  it('adds a revision for a stale A resent after B, then skips the next A', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    await sb.commit(lib, { content: 'A', exportedAt: '2026-02-02T00:00:00.000Z' });
    await sb.commit(lib, { content: 'B', exportedAt: '2026-03-03T00:00:00.000Z' });

    const stale = await sb.commit(lib, { content: 'A', exportedAt: '2026-01-01T00:00:00.000Z' });
    const again = await sb.commit(lib, { content: 'A' });

    expect(stale.status).toBe('committed');
    expect(again).toMatchObject({ status: 'skipped', revisionId: stale.revisionId });
  });

  it('compares the next commit with the new latest after the latest is trashed', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const a = await sb.commit(lib, { content: 'A' });
    const b = await sb.commit(lib, { content: 'B' });
    expectOk(await lib.trash(b.revisionId));

    const repeatA = await sb.commit(lib, { content: 'A' });
    const repeatB = await sb.commit(lib, { content: 'B' });

    expect(repeatA).toMatchObject({ status: 'skipped', revisionId: a.revisionId, path: a.path });
    expect(repeatB.status).toBe('committed');
    expect(repeatB.revisionId).not.toBe(b.revisionId);
  });

  it('compares per node, so equal content on another node is its own revision', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    await sb.commit(lib, { figmaNodeId: '1:2' });

    const other = await sb.commit(lib, { figmaNodeId: '3:4' });

    expect(other.status).toBe('committed');
  });
});

describe('unidentified convergence', () => {
  const cases: [string, string | null][] = [
    ['the same claimedKey', 'claimed'],
    ['a null claimedKey on both', null],
  ];

  it.each(cases)('converges on %s, node, and hash', async (_label, claimedKey) => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib, { identity: unidentified(claimedKey), svg: true });
    const staged = await sb.stage(lib, { identity: unidentified(claimedKey), svg: true });

    const repeat = await lib.commit(staged);

    expect(repeat).toStrictEqual({
      ok: true,
      status: 'converged',
      revisionId: first.revisionId,
      path: first.path,
      preview: path.join(first.path, 'preview.svg'),
    });
    expect(idsOf(expectReady(await lib.getSnapshot()).unidentified)).toEqual([first.revisionId]);
    expect(await readdir(lib.stagingDir)).toEqual([]);
  });

  it('converges on any entry, not just the newest', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const a = await sb.commit(lib, { identity: unidentified('k'), content: 'A' });
    await sb.commit(lib, { identity: unidentified('k'), content: 'B' });

    const repeat = await sb.commit(lib, { identity: unidentified('k'), content: 'A' });

    expect(repeat).toMatchObject({ status: 'converged', revisionId: a.revisionId });
    expect(expectReady(await lib.getSnapshot()).unidentified).toHaveLength(2);
  });

  it.each<[string, { claimedKey: string | null; figmaNodeId: string; content: string }]>([
    ['a different hash', { claimedKey: 'k', figmaNodeId: '1:2', content: 'B' }],
    ['a different claimedKey', { claimedKey: 'other', figmaNodeId: '1:2', content: 'A' }],
    [
      'a null claimedKey against a real one',
      { claimedKey: null, figmaNodeId: '1:2', content: 'A' },
    ],
    ['a different node', { claimedKey: 'k', figmaNodeId: '9:9', content: 'A' }],
  ])('stays a separate entry for %s', async (_label, { claimedKey, figmaNodeId, content }) => {
    const sb = await newSandbox();
    const lib = await sb.open();
    await sb.commit(lib, { identity: unidentified('k'), figmaNodeId: '1:2', content: 'A' });

    const other = await sb.commit(lib, {
      identity: unidentified(claimedKey),
      figmaNodeId,
      content,
    });

    expect(other.status).toBe('committed');
    expect(expectReady(await lib.getSnapshot()).unidentified).toHaveLength(2);
  });
});

describe('idempotent commit', () => {
  it('replays a committed staging id as converged, with the same revision, path and preview', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await sb.stage(lib, { png: true });
    const first = expectOk(await lib.commit(staged));

    const replay = await lib.commit(staged);

    expect(replay).toStrictEqual({ ...first, status: 'converged' });
    const after = expectReady(await lib.getSnapshot());
    expect(idsOf(projectRevisions(after))).toEqual([first.revisionId]);
  });

  it('replays a committed staging id after relaunch', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await sb.stage(lib, { png: true });
    const first = expectOk(await lib.commit(staged));

    const relaunched = await sb.open();
    const replay = await relaunched.commit(staged);

    expect(replay).toStrictEqual({ ...first, status: 'converged' });
    expect(projectRevisions(expectReady(await relaunched.getSnapshot()))).toHaveLength(1);
  });

  it('replays the staging id of an older revision without touching the newer one', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await sb.stage(lib, { content: 'A' });
    const a = expectOk(await lib.commit(staged));
    const b = await sb.commit(lib, { content: 'B' });

    const replay = await lib.commit(staged);

    expect(replay).toMatchObject({ ok: true, status: 'converged', revisionId: a.revisionId });
    const node = nodeFor(projectFor(expectReady(await lib.getSnapshot()), 'file-key-a'), '1:2');
    expect(idsOf(node.revisions)).toEqual([b.revisionId, a.revisionId]);
  });

  it('replays a staging id by id alone, even if the claimed hash has changed', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await sb.stage(lib, { content: 'A' });
    const first = expectOk(await lib.commit(staged));

    const replay = await lib.commit({ ...staged, contentHash: contentHashOf('tampered') });

    expect(replay).toMatchObject({ status: 'converged', revisionId: first.revisionId });
  });

  it('replays a skipped staging id as converged with the matched revision', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib);
    const staged = await sb.stage(lib);
    expect(await lib.commit(staged)).toMatchObject({ status: 'skipped' });

    const replay = await lib.commit(staged);

    expect(replay).toMatchObject({
      ok: true,
      status: 'converged',
      revisionId: first.revisionId,
      path: first.path,
    });
  });

  it('answers a skipped staging id after relaunch with the same revision and adds nothing', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib);
    const staged = await sb.stage(lib);
    await lib.commit(staged);

    const relaunched = await sb.open();
    const replay = await relaunched.commit(staged);

    expect(replay).toMatchObject({ ok: true, revisionId: first.revisionId, path: first.path });
    expect(projectRevisions(expectReady(await relaunched.getSnapshot()))).toHaveLength(1);
  });

  it('replays a converged unidentified staging id', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib, { identity: unidentified(null) });
    const staged = await sb.stage(lib, { identity: unidentified(null) });
    await lib.commit(staged);

    const replay = await lib.commit(staged);

    expect(replay).toMatchObject({ ok: true, status: 'converged', revisionId: first.revisionId });
  });

  it('never replies with a path a memoised outcome no longer has', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib);
    const staged = await sb.stage(lib);
    await lib.commit(staged);
    expectOk(await lib.trash(first.revisionId));

    expect(await lib.commit(staged)).toMatchObject({ ok: false, code: 'failed' });
  });

  it('yields one revision from concurrent commits of the same content', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await Promise.all([1, 2, 3, 4, 5].map(() => sb.stage(lib)));

    const results = (await Promise.all(staged.map((item) => lib.commit(item)))).map(expectOk);

    expect(results.map(({ status }) => status).toSorted()).toEqual([
      'committed',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(new Set(results.map(({ revisionId }) => revisionId)).size).toBe(1);
    expect(new Set(results.map(({ path: reply }) => reply)).size).toBe(1);
    expect(projectRevisions(expectReady(await lib.getSnapshot()))).toHaveLength(1);
    expect(await readdir(lib.stagingDir)).toEqual([]);
  });

  it('yields one entry from concurrent unidentified commits of the same content', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await Promise.all(
      [1, 2, 3].map(() => sb.stage(lib, { identity: unidentified(null) })),
    );

    const results = (await Promise.all(staged.map((item) => lib.commit(item)))).map(expectOk);

    expect(results.map(({ status }) => status).toSorted()).toEqual([
      'committed',
      'converged',
      'converged',
    ]);
    expect(expectReady(await lib.getSnapshot()).unidentified).toHaveLength(1);
  });

  it('yields one revision when one staging id is committed twice at once', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await sb.stage(lib);

    const results = (await Promise.all([lib.commit(staged), lib.commit(staged)])).map(expectOk);

    expect(results.map(({ status }) => status).toSorted()).toEqual(['committed', 'converged']);
    expect(results[0]?.revisionId).toBe(results[1]?.revisionId);
  });

  it('gives concurrent distinct revisions of one node distinct sequence numbers', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
    const staged = await Promise.all(labels.map((content) => sb.stage(lib, { content })));

    const results = (await Promise.all(staged.map((item) => lib.commit(item)))).map(expectOk);

    const seqs = results.map(({ path: reply }) => path.basename(path.dirname(reply)).slice(0, 6));
    expect(seqs.toSorted()).toEqual(['000001', '000002', '000003', '000004', '000005', '000006']);
  });

  it('does not memoise a failure: the same staging id commits once its bundle exists', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const stagingId = stagingIdFor(900);
    const probe = await stageExport(lib.stagingDir, stagingId);
    await rm(path.join(lib.stagingDir, stagingId), { recursive: true });

    expectFailure(await lib.commit(probe), 'failed');
    await stageExport(lib.stagingDir, stagingId);

    expect(await lib.commit(probe)).toMatchObject({
      ok: true,
      status: 'committed',
      revisionId: stagingId,
    });
  });
});

describe('findExport', () => {
  it('finds the latest revision of a node as skipped, without staging anything', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib, { png: true });

    const found = await lib.findExport({
      identity: fileIdentity('file-key-a'),
      figmaNodeId: '1:2',
      contentHash: contentHashOf('A'),
    });

    expect(found).toStrictEqual({
      ok: true,
      status: 'skipped',
      revisionId: first.revisionId,
      path: first.path,
      preview: path.join(first.path, 'preview.png'),
    });
    expect(await readdir(lib.stagingDir)).toEqual([]);
  });

  it('finds an unidentified entry as converged', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib, { identity: unidentified(null) });

    const found = await lib.findExport({
      identity: unidentified(null),
      figmaNodeId: '1:2',
      contentHash: contentHashOf('A'),
    });

    expect(found).toMatchObject({ ok: true, status: 'converged', revisionId: first.revisionId });
    expect(found).not.toHaveProperty('preview');
  });

  it('returns null for no match, a superseded revision, and the other identity kind', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    await sb.commit(lib, { content: 'A' });
    await sb.commit(lib, { content: 'B' });
    const tree = await treeOf(sb.root);

    expect(
      await lib.findExport({
        identity: fileIdentity('file-key-a'),
        figmaNodeId: '1:2',
        contentHash: contentHashOf('A'),
      }),
    ).toBeNull();
    expect(
      await lib.findExport({
        identity: fileIdentity('file-key-a'),
        figmaNodeId: '1:2',
        contentHash: contentHashOf('unknown'),
      }),
    ).toBeNull();
    expect(
      await lib.findExport({
        identity: unidentified('file-key-a'),
        figmaNodeId: '1:2',
        contentHash: contentHashOf('B'),
      }),
    ).toBeNull();
    expect(await treeOf(sb.root)).toEqual(tree);
  });

  it('returns null when the matched bundle has vanished', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib);
    await rm(revisionDirOf(first), { recursive: true });

    const found = await lib.findExport({
      identity: fileIdentity('file-key-a'),
      figmaNodeId: '1:2',
      contentHash: contentHashOf('A'),
    });

    expect(found).toBeNull();
  });
});

async function seedCatalog(sb: Sandbox): Promise<void> {
  const lib = await sb.open();
  await sb.commit(lib, {
    identity: fileIdentity('key-a'),
    fileName: 'Alpha',
    content: 'A',
    png: true,
  });
  await sb.commit(lib, {
    identity: fileIdentity('key-a'),
    fileName: 'Alpha',
    content: 'B',
    svg: true,
  });
  await sb.commit(lib, {
    identity: fileIdentity('key-a'),
    figmaNodeId: '5:5',
    nodeName: null,
    html: true,
  });
  await sb.commit(lib, { identity: fileIdentity('key-b'), fileName: null, nodeName: 'Beta Node' });
  await sb.commit(lib, { identity: unidentified('claimed'), fileName: 'Hint', png: true });
  await sb.commit(lib, { identity: unidentified(null), fileName: null, nodeName: null });
  const damaged = await sb.commit(lib, { identity: fileIdentity('key-c'), fileName: 'Gamma' });
  await writeFile(path.join(revisionDirOf(damaged), 'receipt.json'), '{ not json');
}

describe('relaunch', () => {
  it('rebuilds an equal catalog from disk alone', async () => {
    const sb = await newSandbox();
    await seedCatalog(sb);
    const first = await sb.open();
    const before = await first.getSnapshot();
    expect(expectReady(before).projects).toHaveLength(3);

    const relaunched = await sb.open();

    expect(await relaunched.getSnapshot()).toEqual(before);
  });

  it('keeps no index or project file beside the revision directories', async () => {
    const sb = await newSandbox();
    await seedCatalog(sb);

    const tree = await treeOf(path.join(sb.root, 'files'));

    const stray = Object.keys(tree).filter((entry) => {
      const depth = entry.split(path.sep).length;
      return depth <= 3 && tree[entry] !== 'dir';
    });
    expect(stray).toEqual([]);
    expect((await readdir(sb.root)).toSorted()).toEqual(['.staging', 'files', 'unidentified']);
  });

  it('answers locate right after open, with no snapshot first', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib);

    const relaunched = await sb.open();

    expect(await relaunched.locate(first.path)).toEqual({
      kind: 'revision',
      revisionId: first.revisionId,
    });
  });

  it('sweeps every leftover in .staging on open, without following links', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await sb.stage(lib);
    await writeFile(path.join(lib.stagingDir, 'stray.txt'), 'junk');
    await mkdir(path.join(lib.stagingDir, 'not-a-uuid', 'deep'), { recursive: true });
    await symlink(sb.outside, path.join(lib.stagingDir, 'link-to-outside'));
    await symlink(sb.outside, path.join(lib.stagingDir, staged.stagingId, 'bundle', 'inner-link'));
    const outside = await treeOf(sb.outside);

    await sb.open();

    expect(await readdir(lib.stagingDir)).toEqual([]);
    expect(await treeOf(sb.outside)).toEqual(outside);
  });

  it('never sweeps .staging after open, because the receiver may be writing there', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const inFlight = await sb.stage(lib, { content: 'in-flight' });
    const inFlightDir = path.join(lib.stagingDir, inFlight.stagingId);
    const before = await treeOf(inFlightDir);

    await lib.getSnapshot();
    const other = await sb.commit(lib, { content: 'other', figmaNodeId: '2:2' });
    await sb.commit(lib, { content: 'other', figmaNodeId: '2:2' });
    expectOk(await lib.copyTo(other.revisionId, sb.dest));
    expectOk(await lib.trash(other.revisionId));
    await lib.getSnapshot();

    expect(await treeOf(inFlightDir)).toEqual(before);
    expect(await lib.commit(inFlight)).toMatchObject({ ok: true, status: 'committed' });
  });

  it('keeps revision order when the clock moves backwards', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const commitAt = async (iso: string, content: string): Promise<string> => {
      sb.clock.set(iso);
      const staged = await sb.stage(lib, { content });
      return expectOk(await lib.commit(staged)).revisionId;
    };
    const a = await commitAt('2026-03-01T00:00:00.000Z', 'A');
    const b = await commitAt('2026-02-01T00:00:00.000Z', 'B');
    const c = await commitAt('2026-01-01T00:00:00.000Z', 'C');

    const relaunched = await sb.open();
    const node = nodeFor(
      projectFor(expectReady(await relaunched.getSnapshot()), 'file-key-a'),
      '1:2',
    );

    expect(idsOf(node.revisions)).toEqual([c, b, a]);
    expect(node.revisions.map(({ receivedAt }) => receivedAt)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
    ]);
    const repeat = await sb.commit(relaunched, { content: 'C' });
    expect(repeat).toMatchObject({ status: 'skipped', revisionId: c });
    const repeatOfOlder = await sb.commit(relaunched, { content: 'A' });
    expect(repeatOfOlder.status).toBe('committed');
  });
});

describe('snapshot', () => {
  it('reports a full project with exact fields', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    sb.clock.set('2026-06-06T06:06:06.000Z');
    const staged = await sb.stage(lib, {
      identity: fileIdentity('KEY'),
      fileName: 'File',
      figmaNodeId: '1:2',
      nodeName: 'Node',
      png: true,
    });
    const result = expectOk(await lib.commit(staged));

    expect(await lib.getSnapshot()).toEqual({
      state: 'ready',
      unidentified: [],
      projects: [
        {
          id: sha16('KEY'),
          fileKey: 'KEY',
          fileName: 'File',
          updatedAt: '2026-06-06T06:06:06.000Z',
          nodes: [
            {
              id: `${sha16('KEY')}-${sha16('1:2')}`,
              figmaNodeId: '1:2',
              name: 'Node',
              revisions: [
                {
                  id: result.revisionId,
                  receivedAt: '2026-06-06T06:06:06.000Z',
                  preview: { url: previewUrl(result.revisionId), kind: 'image' },
                  state: 'ok',
                  bundlePath: result.path,
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('reports an unidentified entry with exact fields', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    sb.clock.set('2026-06-06T06:06:06.000Z');
    const staged = await sb.stage(lib, {
      identity: unidentified('claimed'),
      fileName: 'Hint',
      figmaNodeId: '1:2',
      nodeName: 'Node',
    });
    const result = expectOk(await lib.commit(staged));

    expect(await lib.getSnapshot()).toEqual({
      state: 'ready',
      projects: [],
      unidentified: [
        {
          id: result.revisionId,
          receivedAt: '2026-06-06T06:06:06.000Z',
          preview: null,
          state: 'ok',
          bundlePath: result.path,
          claimedName: 'Hint',
          claimedKey: 'claimed',
          figmaNodeId: '1:2',
          name: 'Node',
        },
      ],
    });
  });

  it('orders projects and nodes newest first, and sets updatedAt to the newest revision', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    await sb.commit(lib, { identity: fileIdentity('key-a'), figmaNodeId: '1:1', content: 'A' });
    await sb.commit(lib, { identity: fileIdentity('key-b'), figmaNodeId: '1:1' });
    await sb.commit(lib, { identity: fileIdentity('key-a'), figmaNodeId: '2:2' });
    await sb.commit(lib, { identity: fileIdentity('key-a'), figmaNodeId: '1:1', content: 'B' });

    const snapshot = expectReady(await lib.getSnapshot());

    expect(snapshot.projects.map(({ fileKey }) => fileKey)).toEqual(['key-a', 'key-b']);
    expect(snapshot.projects[0]?.updatedAt).toBe(sb.clock.iso());
    expect(snapshot.projects[0]?.nodes.map(({ figmaNodeId }) => figmaNodeId)).toEqual([
      '1:1',
      '2:2',
    ]);
  });

  it('orders unidentified newest first with damaged entries last', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const oldest = await sb.commit(lib, { identity: unidentified('a') });
    const broken = await sb.commit(lib, { identity: unidentified('b') });
    const newest = await sb.commit(lib, { identity: unidentified('c') });
    await writeFile(path.join(revisionDirOf(broken), 'receipt.json'), 'garbage');

    const snapshot = expectReady(await lib.getSnapshot());

    expect(idsOf(snapshot.unidentified)).toEqual([
      newest.revisionId,
      oldest.revisionId,
      broken.revisionId,
    ]);
  });

  it('takes names from the newest receipt that has them', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    await sb.commit(lib, { content: 'A', fileName: 'Named File', nodeName: 'Named Node' });
    await sb.commit(lib, { content: 'B', fileName: null, nodeName: null });

    const project = projectFor(expectReady(await lib.getSnapshot()), 'file-key-a');

    expect(project.fileName).toBe('Named File');
    expect(nodeFor(project, '1:2').name).toBe('Named Node');
  });

  it('falls back to the figma node id when no receipt has a node name', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    await sb.commit(lib, { nodeName: null, figmaNodeId: '12:34' });
    await sb.commit(lib, { identity: unidentified(null), nodeName: null, figmaNodeId: '56:78' });

    const snapshot = expectReady(await lib.getSnapshot());

    expect(nodeFor(projectFor(snapshot, 'file-key-a'), '12:34').name).toBe('12:34');
    expect(snapshot.unidentified[0]).toMatchObject({ name: '56:78', figmaNodeId: '56:78' });
  });

  it('shows changes made in Finder on the next call without firing onChanged', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const gone = await sb.commit(lib, { content: 'A' });
    const kept = await sb.commit(lib, { content: 'B' });
    let changes = 0;
    lib.onChanged(() => {
      changes += 1;
    });
    await rename(revisionDirOf(gone), path.join(sb.outside, 'moved-away'));

    const snapshot = expectReady(await lib.getSnapshot());

    expect(idsOf(projectRevisions(snapshot))).toEqual([kept.revisionId]);
    expect(changes).toBe(0);
  });

  it('hides project and node directories that hold no revisions', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const empty = path.join(sb.root, 'files', `empty-${sha16('nothing')}`);
    await mkdir(path.join(empty, `node-${sha16('1:1')}`), { recursive: true });

    expect(await lib.getSnapshot()).toEqual({ state: 'ready', projects: [], unidentified: [] });
  });
});

describe('previews', () => {
  type PreviewCase = {
    label: string;
    options: { png?: boolean; svg?: boolean; html?: boolean };
    replyFile: string | null;
    image: { file: string; contentType: string } | null;
  };
  const cases: PreviewCase[] = [
    {
      label: 'png, svg and html',
      options: { png: true, svg: true, html: true },
      replyFile: 'preview.png',
      image: { file: 'preview.png', contentType: 'image/png' },
    },
    {
      label: 'svg and html',
      options: { svg: true, html: true },
      replyFile: 'preview.svg',
      image: { file: 'preview.svg', contentType: 'image/svg+xml' },
    },
    { label: 'html only', options: { html: true }, replyFile: 'preview.html', image: null },
    { label: 'no preview', options: {}, replyFile: null, image: null },
  ];

  it.each(cases)('resolves $label', async ({ options, replyFile, image }) => {
    const sb = await newSandbox();
    const lib = await sb.open();

    const result = await sb.commit(lib, options);

    if (replyFile === null) expect(result).not.toHaveProperty('preview');
    else expect(result.preview).toBe(path.join(result.path, replyFile));

    const revision = projectRevisions(expectReady(await lib.getSnapshot()))[0];
    expect(revision?.preview).toEqual(
      image === null ? null : { url: previewUrl(result.revisionId), kind: 'image' },
    );
    expect(await lib.previewFile(result.revisionId)).toEqual(
      image === null
        ? null
        : { path: path.join(result.path, image.file), contentType: image.contentType },
    );
  });

  it('gives an unidentified entry the same preview rules', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();

    const result = await sb.commit(lib, { identity: unidentified(null), svg: true });

    expect(expectReady(await lib.getSnapshot()).unidentified[0]?.preview).toEqual({
      url: previewUrl(result.revisionId),
      kind: 'image',
    });
    expect(await lib.previewFile(result.revisionId)).toEqual({
      path: path.join(result.path, 'preview.svg'),
      contentType: 'image/svg+xml',
    });
  });

  it('stores exported SVG and HTML byte for byte and exposes only images', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();

    const result = await sb.commit(lib, { png: true, svg: true, html: true });

    expect(await readFile(path.join(result.path, 'preview.svg'), 'utf8')).toBe(HOSTILE_SVG);
    expect(await readFile(path.join(result.path, 'preview.html'), 'utf8')).toBe(HOSTILE_HTML);
    expect(await readFile(path.join(result.path, 'preview.png'))).toEqual(PNG_BYTES);
  });

  it('returns null for an unknown revision and for a preview file that vanished', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib, { png: true });
    await rm(path.join(result.path, 'preview.png'));

    expect(await lib.previewFile(asRevisionId(stagingIdFor(901)))).toBeNull();
    expect(await lib.previewFile(result.revisionId)).toBeNull();
  });
});

describe('onChanged', () => {
  it('fires once per commit, after the revision is visible', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const seen: Promise<unknown>[] = [];
    lib.onChanged(() => {
      seen.push(lib.getSnapshot());
    });

    const result = await sb.commit(lib);

    expect(seen).toHaveLength(1);
    const snapshot = expectReady((await seen[0]) as Awaited<ReturnType<typeof lib.getSnapshot>>);
    expect(idsOf(projectRevisions(snapshot))).toEqual([result.revisionId]);
  });

  it('fires only once the new revision answers commands', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await sb.stage(lib);
    const answers: Promise<unknown>[] = [];
    lib.onChanged(() => {
      answers.push(lib.bundlePath(asRevisionId(staged.stagingId)));
    });

    const result = expectOk(await lib.commit(staged));

    expect(await Promise.all(answers)).toEqual([{ ok: true, path: result.path }]);
  });

  it('fires on trash, and not for skipped, converged, failed or read calls', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib);
    await sb.commit(lib, { identity: unidentified(null) });
    let changes = 0;
    lib.onChanged(() => {
      changes += 1;
    });

    await sb.commit(lib);
    await sb.commit(lib, { identity: unidentified(null) });
    await lib.getSnapshot();
    sb.trash.mode = 'throw';
    await lib.trash(first.revisionId);
    expect(changes).toBe(0);

    sb.trash.mode = 'move';
    expectOk(await lib.trash(first.revisionId));
    expect(changes).toBe(1);
  });

  it('stops firing after unsubscribe', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    let changes = 0;
    const unsubscribe = lib.onChanged(() => {
      changes += 1;
    });
    unsubscribe();

    await sb.commit(lib);

    expect(changes).toBe(0);
  });
});
