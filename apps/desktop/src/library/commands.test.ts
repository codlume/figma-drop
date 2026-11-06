import { chmod, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import {
  asRevisionId,
  expectFailure,
  expectOk,
  expectReady,
  exists,
  fileIdentity,
  idsOf,
  instrumentFs,
  nodeFor,
  projectFor,
  projectRevisions,
  revisionDirOf,
  SECRET,
  stagingIdFor,
  treeOf,
  unidentified,
  useSandboxes,
} from './fixtures';

const newSandbox = useSandboxes();

describe('copyTo', () => {
  it('writes a plain bundle with identical bytes and no receipt', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib, {
      nodeName: 'Hero Card',
      png: true,
      svg: true,
      html: true,
      assets: { 'img-1.png': 'one', 'icon.key.svg': 'two' },
      extraFiles: { 'variables.json': '{}' },
    });

    const copy = await lib.copyTo(result.revisionId, sb.dest);

    const target = path.join(sb.dest, `hero-card-${result.revisionId.slice(0, 8)}`);
    expect(copy).toEqual({ ok: true, path: target });
    expect(await treeOf(target)).toEqual(await treeOf(result.path));
    expect(await exists(path.join(target, 'receipt.json'))).toBe(false);
    expect(await readdir(sb.dest)).toEqual([path.basename(target)]);
  });

  it('names the copy from the figma node id when the node has no name', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib, { nodeName: null, figmaNodeId: '12:34' });

    const copy = expectOk(await lib.copyTo(result.revisionId, sb.dest));

    expect(path.basename(copy.path)).toBe(`12-34-${result.revisionId.slice(0, 8)}`);
  });

  it('copies an unidentified entry', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib, { identity: unidentified(null), nodeName: 'Loose' });

    const copy = expectOk(await lib.copyTo(result.revisionId, sb.dest));

    expect(path.basename(copy.path)).toBe(`loose-${result.revisionId.slice(0, 8)}`);
    expect(await treeOf(copy.path)).toEqual(await treeOf(result.path));
  });

  it('leaves an existing folder alone and uses the next suffix', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    const name = `hero-card-${result.revisionId.slice(0, 8)}`;
    await mkdir(path.join(sb.dest, name));
    await writeFile(path.join(sb.dest, name, 'mine.txt'), 'keep me');
    const before = await treeOf(path.join(sb.dest, name));

    const second = expectOk(await lib.copyTo(result.revisionId, sb.dest));
    const third = expectOk(await lib.copyTo(result.revisionId, sb.dest));

    expect(second.path).toBe(path.join(sb.dest, `${name} 2`));
    expect(third.path).toBe(path.join(sb.dest, `${name} 3`));
    expect(await treeOf(path.join(sb.dest, name))).toEqual(before);
    expect(await treeOf(second.path)).toEqual(await treeOf(result.path));
  });

  it('treats a file or a dangling link at the target name as taken', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    const name = `hero-card-${result.revisionId.slice(0, 8)}`;
    await writeFile(path.join(sb.dest, name), 'a file');
    await symlink(path.join(sb.outside, 'missing'), path.join(sb.dest, `${name} 2`));

    const copy = expectOk(await lib.copyTo(result.revisionId, sb.dest));

    expect(copy.path).toBe(path.join(sb.dest, `${name} 3`));
    expect(await readFile(path.join(sb.dest, name), 'utf8')).toBe('a file');
    expect(await exists(path.join(sb.outside, 'missing'))).toBe(false);
  });

  it('refuses every destination that resolves inside the library', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    const link = path.join(sb.dest, 'link-into-library');
    await symlink(path.join(sb.root, 'files'), link);
    const before = await treeOf(sb.root);

    for (const destination of [
      sb.root,
      path.join(sb.root, 'files'),
      lib.stagingDir,
      path.join(sb.root, 'unidentified'),
      result.path,
      link,
    ]) {
      expectFailure(await lib.copyTo(result.revisionId, destination), 'failed');
    }

    expect(await treeOf(sb.root)).toEqual(before);
  });

  it('accepts a sibling whose name only starts with the root path', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    const sibling = `${sb.root}-sibling`;
    await mkdir(sibling);

    const copy = expectOk(await lib.copyTo(result.revisionId, sibling));

    expect(path.dirname(copy.path)).toBe(sibling);
  });

  it('refuses a destination that is missing or not a directory', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    const file = path.join(sb.dest, 'a-file');
    await writeFile(file, 'x');

    expectFailure(await lib.copyTo(result.revisionId, path.join(sb.dest, 'missing')), 'failed');
    expectFailure(await lib.copyTo(result.revisionId, file), 'failed');
    expect(await exists(path.join(sb.dest, 'missing'))).toBe(false);
  });

  it('gives not-found for an unknown revision', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();

    expectFailure(await lib.copyTo(asRevisionId(stagingIdFor(901)), sb.dest), 'not-found');
    expect(await readdir(sb.dest)).toEqual([]);
  });

  it('refuses a damaged revision', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    await writeFile(path.join(revisionDirOf(result), 'receipt.json'), 'garbage');
    const relaunched = await sb.open();

    expectFailure(await relaunched.copyTo(result.revisionId, sb.dest), 'damaged');
    expect(await readdir(sb.dest)).toEqual([]);
  });

  it('refuses a revision whose manifest file is missing or not a regular file', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const missing = await sb.commit(lib, { content: 'A' });
    const replaced = await sb.commit(lib, { content: 'B' });
    await rm(path.join(missing.path, 'meta.json'));
    await rm(path.join(replaced.path, 'meta.json'));
    await mkdir(path.join(replaced.path, 'meta.json'));

    expectFailure(await lib.copyTo(missing.revisionId, sb.dest), 'damaged');
    expectFailure(await lib.copyTo(replaced.revisionId, sb.dest), 'damaged');
    expect(await readdir(sb.dest)).toEqual([]);
  });

  it('leaves only unrelated files behind at every failing write of a copy', async () => {
    const counter = await newSandbox();
    const counterFs = instrumentFs();
    const counterLib = await counter.open(counterFs.fs);
    const counted = await counter.commit(counterLib, { png: true, assets: { 'a.bin': 'x' } });
    counterFs.arm();
    expectOk(await counterLib.copyTo(counted.revisionId, counter.dest));
    const writes = counterFs.mutationCount();
    expect(writes).toBeGreaterThan(3);

    for (let at = 1; at <= writes; at += 1) {
      const sb = await newSandbox();
      const fs = instrumentFs();
      const lib = await sb.open(fs.fs);
      const result = await sb.commit(lib, { png: true, assets: { 'a.bin': 'x' } });
      await writeFile(path.join(sb.dest, 'unrelated.txt'), 'mine');
      const before = await treeOf(sb.dest);
      const library = await treeOf(sb.root);
      fs.arm({ kind: 'once', at, code: 'ENOSPC' });

      const copy = await lib.copyTo(result.revisionId, sb.dest);

      const label = `ENOSPC at write ${at}: ${fs.mutationLog()[at - 1]}`;
      expect(fs.fired(), label).toBe(true);
      expect(copy, label).toMatchObject({ ok: false, code: 'disk-full' });
      expect(await treeOf(sb.dest), label).toEqual(before);
      expect(await treeOf(sb.root), label).toEqual(library);
    }
  }, 60_000);

  it('reports a generic copy failure as a failure and cleans its temp child', async () => {
    const sb = await newSandbox();
    const fs = instrumentFs();
    const lib = await sb.open(fs.fs);
    const result = await sb.commit(lib);
    fs.arm({ kind: 'method', method: 'copyFile', nth: 2, code: 'EBUSY' });

    const copy = await lib.copyTo(result.revisionId, sb.dest);

    expect(copy.ok).toBe(false);
    expect(await readdir(sb.dest)).toEqual([]);
  });

  it('stages in a hidden temp child and leaves the commit queue free during a copy', async () => {
    const sb = await newSandbox();
    const fs = instrumentFs();
    const lib = await sb.open(fs.fs);
    const result = await sb.commit(lib, { content: 'A' });
    const gate = fs.hold('copyFile');

    const copying = lib.copyTo(result.revisionId, sb.dest);
    await gate.reached;
    try {
      const during = await readdir(sb.dest);
      expect(during).toHaveLength(1);
      expect(during[0]?.startsWith('.')).toBe(true);

      const committing = sb.commit(lib, { content: 'B' });
      const outcome = await Promise.race([
        committing.then(() => 'committed'),
        new Promise((resolve) => {
          setTimeout(() => resolve('blocked by the copy'), 2000);
        }),
      ]);
      expect(outcome).toBe('committed');
    } finally {
      gate.release();
    }

    const copy = expectOk(await copying);
    expect(await readdir(sb.dest)).toEqual([path.basename(copy.path)]);
  });

  it('never copies or reads through a symlink dropped into the bundle', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    await symlink(path.join(sb.outside, 'secret.txt'), path.join(result.path, 'dropped-link'));

    await lib.copyTo(result.revisionId, sb.dest);

    const tree = await treeOf(sb.dest);
    const copied = await Promise.all(
      Object.entries(tree)
        .filter(([, kind]) => kind.startsWith('file:'))
        .map(([file]) => readFile(path.join(sb.dest, file), 'utf8')),
    );
    expect(copied.join('')).not.toContain(SECRET);
    expect(Object.values(tree).filter((kind) => kind.startsWith('link:'))).toEqual([]);
  });
});

describe('trash', () => {
  it('calls the fake once with the revision directory and drops the revision', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const kept = await sb.commit(lib, { content: 'A' });
    const trashed = await sb.commit(lib, { content: 'B' });

    expect(await lib.trash(trashed.revisionId)).toEqual({ ok: true });

    expect(sb.trash.calls).toEqual([revisionDirOf(trashed)]);
    expect(await exists(revisionDirOf(trashed))).toBe(false);
    expect(idsOf(projectRevisions(expectReady(await lib.getSnapshot())))).toEqual([
      kept.revisionId,
    ]);
    expect(await lib.locate(trashed.path)).toBeNull();
    expect(await lib.previewFile(trashed.revisionId)).toBeNull();
  });

  it('calls the fake with an unidentified entry directory', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const entry = await sb.commit(lib, { identity: unidentified(null) });

    expectOk(await lib.trash(entry.revisionId));

    expect(sb.trash.calls).toEqual([revisionDirOf(entry)]);
    expect(expectReady(await lib.getSnapshot()).unidentified).toEqual([]);
    expect(await readdir(path.join(sb.root, 'unidentified'))).toEqual([]);
  });

  it('keeps catalog and files when the fake throws, and the retry works', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    const snapshot = await lib.getSnapshot();
    const tree = await treeOf(sb.root);
    sb.trash.mode = 'throw';

    expectFailure(await lib.trash(result.revisionId), 'failed');

    expect(sb.trash.calls).toHaveLength(1);
    expect(await lib.getSnapshot()).toEqual(snapshot);
    expect(await treeOf(sb.root)).toEqual(tree);
    expect(await lib.locate(result.path)).toEqual({
      kind: 'revision',
      revisionId: result.revisionId,
    });

    sb.trash.mode = 'move';
    expectOk(await lib.trash(result.revisionId));
  });

  it('removes node and project with the last revision', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);

    expectOk(await lib.trash(result.revisionId));

    expect(await lib.getSnapshot()).toEqual({ state: 'ready', projects: [], unidentified: [] });
    expect(await readdir(path.join(sb.root, 'files'))).toEqual([]);
  });

  it('keeps sibling nodes when one node empties', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const gone = await sb.commit(lib, { figmaNodeId: '1:1' });
    const kept = await sb.commit(lib, { figmaNodeId: '2:2' });

    expectOk(await lib.trash(gone.revisionId));

    const project = projectFor(expectReady(await lib.getSnapshot()), 'file-key-a');
    expect(project.nodes.map(({ figmaNodeId }) => figmaNodeId)).toEqual(['2:2']);
    expect(idsOf(nodeFor(project, '2:2').revisions)).toEqual([kept.revisionId]);
    expect(await exists(kept.path)).toBe(true);
  });

  it('leaves a stray file in an emptied node directory and still succeeds', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    const nodeDir = path.dirname(revisionDirOf(result));
    await writeFile(path.join(nodeDir, 'stray.txt'), 'mine');

    expectOk(await lib.trash(result.revisionId));

    expect(await readFile(path.join(nodeDir, 'stray.txt'), 'utf8')).toBe('mine');
    expect(await lib.getSnapshot()).toEqual({ state: 'ready', projects: [], unidentified: [] });
  });

  it('still succeeds when removing the empty directories fails', async () => {
    const sb = await newSandbox();
    const fs = instrumentFs();
    const lib = await sb.open(fs.fs);
    const result = await sb.commit(lib);
    fs.arm({ kind: 'method', method: 'rmdir', nth: 1, code: 'EACCES' });

    expect(await lib.trash(result.revisionId)).toEqual({ ok: true });
    expect(fs.fired()).toBe(true);
  });

  it('trashes a damaged revision', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    await writeFile(path.join(revisionDirOf(result), 'receipt.json'), 'garbage');
    const relaunched = await sb.open();

    expectOk(await relaunched.trash(result.revisionId));

    expect(sb.trash.calls).toEqual([revisionDirOf(result)]);
    expect(await relaunched.getSnapshot()).toEqual({
      state: 'ready',
      projects: [],
      unidentified: [],
    });
  });

  it('gives not-found for unknown ids, a second trash, and a vanished directory', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const once = await sb.commit(lib, { content: 'A' });
    const vanished = await sb.commit(lib, { content: 'B' });
    expectOk(await lib.trash(once.revisionId));
    await rm(revisionDirOf(vanished), { recursive: true });
    sb.trash.calls.length = 0;

    expectFailure(await lib.trash(asRevisionId(stagingIdFor(901))), 'not-found');
    expectFailure(await lib.trash(once.revisionId), 'not-found');
    expectFailure(await lib.trash(vanished.revisionId), 'not-found');

    expect(sb.trash.calls).toEqual([]);
  });

  it('runs in order with commits, so a commit queued behind a trash sees it', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    const staged = await sb.stage(lib);

    const [trashed, committed] = await Promise.all([
      lib.trash(result.revisionId),
      lib.commit(staged),
    ]);

    expect(trashed).toEqual({ ok: true });
    expect(committed).toMatchObject({
      ok: true,
      status: 'committed',
      revisionId: staged.stagingId,
    });
    expect(await exists(expectOk(committed).path)).toBe(true);
  });

  it('deletes nothing itself: a Trash that moves nothing leaves every file in place', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const project = await sb.commit(lib);
    const entry = await sb.commit(lib, { identity: unidentified(null) });
    const damaged = await sb.commit(lib, { identity: fileIdentity('key-b') });
    await writeFile(path.join(revisionDirOf(damaged), 'receipt.json'), 'garbage');
    const relaunched = await sb.open();
    const tree = await treeOf(sb.root);
    sb.trash.mode = 'keep';

    expectOk(await relaunched.trash(project.revisionId));
    expectOk(await relaunched.trash(entry.revisionId));
    expectOk(await relaunched.trash(damaged.revisionId));

    expect(await treeOf(sb.root)).toEqual(tree);
  });

  it('never aims a recursive or file remove at the catalog over a whole lifecycle', async () => {
    const sb = await newSandbox();
    const fs = instrumentFs();
    const lib = await sb.open(fs.fs);
    const staged = await sb.stage(lib, { content: 'failed-later', omit: ['meta.json'] });
    fs.arm();

    await lib.commit(staged);
    const a = await sb.commit(lib, { content: 'A', png: true });
    await sb.commit(lib, { content: 'A', png: true });
    const b = await sb.commit(lib, { content: 'B' });
    await sb.commit(lib, { identity: unidentified(null) });
    await sb.commit(lib, { identity: unidentified(null) });
    expectOk(await lib.copyTo(a.revisionId, sb.dest));
    await lib.copyTo(a.revisionId, path.join(sb.dest, 'missing'));
    expectOk(await lib.trash(b.revisionId));
    await writeFile(path.join(revisionDirOf(a), 'receipt.json'), 'garbage');
    await lib.getSnapshot();
    expectOk(await lib.trash(a.revisionId));

    const removals = fs.calls.filter(({ method }) => method === 'rm' || method === 'rmdir');
    expect(removals.length).toBeGreaterThan(0);
    const catalog = [path.join(sb.root, 'files'), path.join(sb.root, 'unidentified')];
    for (const { method, args } of removals) {
      const target = String(args[0]);
      const inCatalog = catalog.some(
        (dir) => target === dir || target.startsWith(`${dir}${path.sep}`),
      );
      if (method === 'rm') expect(inCatalog, `rm ${target}`).toBe(false);
      else expect(args[1], `rmdir ${target}`).not.toMatchObject({ recursive: true });
    }
  });
});

describe('bundlePath', () => {
  it('returns the bundle path of a revision and of an unidentified entry', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const project = await sb.commit(lib);
    const entry = await sb.commit(lib, { identity: unidentified(null) });

    expect(await lib.bundlePath(project.revisionId)).toEqual({ ok: true, path: project.path });
    expect(await lib.bundlePath(entry.revisionId)).toEqual({ ok: true, path: entry.path });
  });

  it('works for a damaged revision while its bundle is a real directory', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    await writeFile(path.join(revisionDirOf(result), 'receipt.json'), 'garbage');
    const relaunched = await sb.open();

    expect(await relaunched.bundlePath(result.revisionId)).toEqual({ ok: true, path: result.path });
  });

  it('gives not-found for an unknown id and for a vanished bundle', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    await rm(result.path, { recursive: true });

    expectFailure(await lib.bundlePath(asRevisionId(stagingIdFor(901))), 'not-found');
    expectFailure(await lib.bundlePath(result.revisionId), 'not-found');
  });
});

describe('a library under a symlinked root', () => {
  it('passes containment for commit, preview, bundlePath, copy and trash', async () => {
    const sb = await newSandbox();
    const real = path.join(sb.base, 'real-root');
    await mkdir(real);
    const linked = path.join(sb.base, 'linked-root');
    await symlink(real, linked);
    const { openLibrary } = await import('./library');
    const lib = await openLibrary(
      { root: linked, trashItem: sb.trash.trashItem },
      { now: sb.clock.now },
    );

    const result = await sb.commit(lib, { png: true });

    expect((await lstat(path.join(real, 'files'))).isDirectory()).toBe(true);
    expect(await lib.previewFile(result.revisionId)).toMatchObject({ contentType: 'image/png' });
    expectOk(await lib.bundlePath(result.revisionId));
    expectOk(await lib.copyTo(result.revisionId, sb.dest));
    expectFailure(await lib.copyTo(result.revisionId, path.join(real, 'files')), 'failed');
    expectOk(await lib.trash(result.revisionId));
    expect(sb.trash.calls).toHaveLength(1);
  });
});

describe('an unreadable bundle directory', () => {
  it('fails a copy without leaving a temp child', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    await chmod(path.join(result.path, 'meta.json'), 0o000);

    const copy = await lib.copyTo(result.revisionId, sb.dest);

    await chmod(path.join(result.path, 'meta.json'), 0o644);
    expect(copy.ok).toBe(false);
    expect(await readdir(sb.dest)).toEqual([]);
  });
});

describe('a read-only destination', () => {
  it('blames the destination, not the library, for a read-only folder', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib);
    await chmod(sb.dest, 0o500);

    try {
      expect(await lib.copyTo(first.revisionId, sb.dest)).toMatchObject({
        ok: false,
        code: 'failed',
      });
    } finally {
      await chmod(sb.dest, 0o755);
    }
    expect(await readdir(sb.dest)).toEqual([]);
  });
});
