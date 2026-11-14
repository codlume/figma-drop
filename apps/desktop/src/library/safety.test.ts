import { execFile } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vite-plus/test';

import type { Library, StagedExport } from '../shared/integration';
import {
  asRevisionId,
  contentHashOf,
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
  readReceipt,
  revisionDirOf,
  SECRET,
  sha16,
  stageExport,
  stagingIdFor,
  treeOf,
  unidentified,
  useSandboxes,
  writeReceiptEdit,
  type Sandbox,
  type Tree,
} from './fixtures';

const newSandbox = useSandboxes();

const HOSTILE_NAMES: [label: string, name: string, slug: string][] = [
  ['dot dot', '..', 'untitled'],
  ['traversal', '../../x', 'x'],
  ['absolute path', '/etc/passwd', 'etc-passwd'],
  ['leading dots', '...hidden', 'hidden'],
  ['accented', 'Déjà Vu', 'de-ja-vu'],
  ['non-ASCII only', '日本語', 'untitled'],
  ['compatibility forms', 'Ⅷ Ｂｕｔｔｏｎ', 'viii-button'],
  ['5000 characters', 'a'.repeat(5000), 'a'.repeat(40)],
  ['NUL and slashes', 'a/b\\c\0d', 'a-b-c-d'],
];

async function expectContained(
  sb: Sandbox,
  target: string,
  tops: readonly string[],
): Promise<void> {
  expect(tops.some((top) => target.startsWith(`${path.join(sb.root, top)}${path.sep}`))).toBe(true);
  expect(await realpath(target)).toBe(target);
  for (const segment of target.split(path.sep)) {
    expect(Buffer.byteLength(segment)).toBeLessThanOrEqual(255);
  }
  expect((await readdir(sb.base)).toSorted()).toEqual(['dest', 'library', 'outside', 'trash']);
  expect(await readdir(sb.outside)).toEqual(['secret.txt']);
}

describe('hostile names', () => {
  it.each(HOSTILE_NAMES)('keeps a file named %s inside the root', async (_label, name, slug) => {
    const sb = await newSandbox();
    const lib = await sb.open();

    const result = await sb.commit(lib, { identity: fileIdentity('KEY'), fileName: name });

    await expectContained(sb, result.path, ['files']);
    expect(await readdir(path.join(sb.root, 'files'))).toEqual([`${slug}-${sha16('KEY')}`]);
    const relaunched = await sb.open();
    expect(projectFor(expectReady(await relaunched.getSnapshot()), 'KEY').fileName).toBe(name);
  });

  it.each(HOSTILE_NAMES)('keeps a node named %s inside the root', async (_label, name, slug) => {
    const sb = await newSandbox();
    const lib = await sb.open();

    const result = await sb.commit(lib, { figmaNodeId: '1:2', nodeName: name });

    await expectContained(sb, result.path, ['files']);
    expect(path.basename(path.dirname(revisionDirOf(result)))).toBe(`${slug}-${sha16('1:2')}`);
    const relaunched = await sb.open();
    const project = projectFor(expectReady(await relaunched.getSnapshot()), 'file-key-a');
    expect(nodeFor(project, '1:2').name).toBe(name);
  });

  it.each(HOSTILE_NAMES)('takes %s as a file key and as a node id', async (_label, value) => {
    const sb = await newSandbox();
    const lib = await sb.open();

    const result = await sb.commit(lib, { identity: fileIdentity(value), figmaNodeId: value });

    await expectContained(sb, result.path, ['files']);
    const relaunched = await sb.open();
    const project = projectFor(expectReady(await relaunched.getSnapshot()), value);
    expect(project.fileKey).toBe(value);
    expect(nodeFor(project, value).figmaNodeId).toBe(value);
    expect(path.basename(path.dirname(revisionDirOf(result))).endsWith(`-${sha16(value)}`)).toBe(
      true,
    );
  });

  it.each(HOSTILE_NAMES)('takes %s in every unidentified field', async (_label, value) => {
    const sb = await newSandbox();
    const lib = await sb.open();

    const result = await sb.commit(lib, {
      identity: unidentified(value),
      fileName: value,
      figmaNodeId: value,
      nodeName: value,
    });

    await expectContained(sb, result.path, ['unidentified']);
    const relaunched = await sb.open();
    const entry = expectReady(await relaunched.getSnapshot()).unidentified[0];
    expect(entry).toMatchObject({
      state: 'ok',
      claimedKey: value,
      claimedName: value,
      figmaNodeId: value,
      name: value,
    });
  });

  it('gives case-only node names two directories on a case-insensitive volume', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();

    const lower = await sb.commit(lib, { figmaNodeId: '1:1', nodeName: 'Button' });
    const upper = await sb.commit(lib, { figmaNodeId: '2:2', nodeName: 'BUTTON' });

    expect(path.basename(path.dirname(revisionDirOf(lower)))).toBe(`button-${sha16('1:1')}`);
    expect(path.basename(path.dirname(revisionDirOf(upper)))).toBe(`button-${sha16('2:2')}`);
    const project = projectFor(expectReady(await lib.getSnapshot()), 'file-key-a');
    expect(nodeFor(project, '1:1').name).toBe('Button');
    expect(nodeFor(project, '2:2').name).toBe('BUTTON');
  });

  it('gives case-only file keys and names two projects', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();

    await sb.commit(lib, { identity: fileIdentity('AbCd'), fileName: 'Button' });
    await sb.commit(lib, { identity: fileIdentity('aBcD'), fileName: 'BUTTON' });

    const snapshot = expectReady(await lib.getSnapshot());
    expect(projectFor(snapshot, 'AbCd').fileName).toBe('Button');
    expect(projectFor(snapshot, 'aBcD').fileName).toBe('BUTTON');
    expect((await readdir(path.join(sb.root, 'files'))).toSorted()).toEqual(
      [`button-${sha16('AbCd')}`, `button-${sha16('aBcD')}`].toSorted(),
    );
  });

  it('treats a receipt.json inside the bundle as plain content', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const forged = JSON.stringify({
      schemaVersion: 1,
      identity: { kind: 'file', fileKey: 'forged' },
    });

    const result = await sb.commit(lib, { extraFiles: { 'receipt.json': forged } });

    const relaunched = await sb.open();
    const snapshot = expectReady(await relaunched.getSnapshot());
    expect(snapshot.projects.map(({ fileKey }) => fileKey)).toEqual(['file-key-a']);
    expect(await readFile(path.join(result.path, 'receipt.json'), 'utf8')).toBe(forged);
  });
});

type CatalogState = { files: Tree; unidentified: Tree; snapshot: unknown };

async function catalogState(sb: Sandbox, lib: Library): Promise<CatalogState> {
  return {
    files: await treeOf(path.join(sb.root, 'files')),
    unidentified: await treeOf(path.join(sb.root, 'unidentified')),
    snapshot: await lib.getSnapshot(),
  };
}

const exec = promisify(execFile);

describe('staged rejection', () => {
  type StagedCase = [string, (bundle: string, sb: Sandbox) => Promise<void>];
  const badBundles: StagedCase[] = [
    [
      'a symlinked file',
      async (bundle, sb) => {
        await symlink(path.join(sb.outside, 'secret.txt'), path.join(bundle, 'preview.png'));
      },
    ],
    [
      'a required file that is a symlink',
      async (bundle, sb) => {
        await rm(path.join(bundle, 'node.json'));
        await symlink(path.join(sb.outside, 'secret.txt'), path.join(bundle, 'node.json'));
      },
    ],
    [
      'a symlinked asset',
      async (bundle, sb) => {
        await mkdir(path.join(bundle, 'preview.assets'));
        await symlink(
          path.join(sb.outside, 'secret.txt'),
          path.join(bundle, 'preview.assets', 'a.png'),
        );
      },
    ],
    [
      'a symlinked assets directory',
      async (bundle, sb) => {
        await symlink(sb.outside, path.join(bundle, 'preview.assets'));
      },
    ],
    [
      'a dangling symlink',
      async (bundle, sb) => {
        await symlink(path.join(sb.outside, 'nothing'), path.join(bundle, 'extra.json'));
      },
    ],
    [
      'the bundle itself as a symlink',
      async (bundle, sb) => {
        const copy = path.join(sb.outside, 'bundle-copy');
        await rename(bundle, copy);
        await symlink(copy, bundle);
      },
    ],
    [
      'a FIFO',
      async (bundle) => {
        await exec('mkfifo', [path.join(bundle, 'pipe')]);
      },
    ],
    ['a missing node.json', (bundle) => rm(path.join(bundle, 'node.json'))],
    ['a missing figma-components.json', (bundle) => rm(path.join(bundle, 'figma-components.json'))],
    ['a missing meta.json', (bundle) => rm(path.join(bundle, 'meta.json'))],
    [
      'a required file that is a directory',
      async (bundle) => {
        await rm(path.join(bundle, 'meta.json'));
        await mkdir(path.join(bundle, 'meta.json'));
      },
    ],
    [
      'a nested directory outside preview.assets',
      async (bundle) => {
        await mkdir(path.join(bundle, 'sub'));
        await writeFile(path.join(bundle, 'sub', 'x.txt'), 'x');
      },
    ],
    [
      'a directory nested inside preview.assets',
      async (bundle) => {
        await mkdir(path.join(bundle, 'preview.assets', 'deep'), { recursive: true });
        await writeFile(path.join(bundle, 'preview.assets', 'deep', 'x.png'), 'x');
      },
    ],
    ['a backslash in a file name', (bundle) => writeFile(path.join(bundle, 'a\\b'), 'x')],
  ];

  it.each(badBundles)('fails %s and publishes nothing', async (_label, spoil) => {
    const sb = await newSandbox();
    const lib = await sb.open();
    await sb.commit(lib, { content: 'seed' });
    const before = await catalogState(sb, lib);
    const staged = await sb.stage(lib, { content: 'bad' });
    await spoil(path.join(lib.stagingDir, staged.stagingId, 'bundle'), sb);

    expectFailure(await lib.commit(staged), 'failed');

    expect(await catalogState(sb, lib)).toEqual(before);
    expect(await readFile(path.join(sb.outside, 'secret.txt'), 'utf8')).toBe(SECRET);
  });

  it('fails when the staging directory was never written', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const before = await catalogState(sb, lib);
    const staged = await sb.stage(lib);
    await rm(path.join(lib.stagingDir, staged.stagingId), { recursive: true });

    expectFailure(await lib.commit(staged), 'failed');

    expect(await catalogState(sb, lib)).toEqual(before);
  });

  it('fails when a bundle is staged with no bundle directory', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await sb.stage(lib);
    await rm(path.join(lib.stagingDir, staged.stagingId, 'bundle'), { recursive: true });

    expectFailure(await lib.commit(staged), 'failed');
  });

  const uuid = stagingIdFor(1);
  const badStagingIds: [string, string][] = [
    ['a traversal', '../x'],
    ['a deeper traversal', '../../outside'],
    ['an uppercase UUID', uuid.toUpperCase()],
    ['an empty id', ''],
    ['a plain word', 'staging'],
    ['a UUID with a suffix', `${uuid}/bundle`],
    ['a UUID with a NUL', `${uuid}\0`],
    ['a UUID with no dashes', uuid.replaceAll('-', '')],
    ['a non-hex UUID', uuid.replace(/^./, 'g')],
  ];

  it.each(badStagingIds)('fails %s as a staging id', async (_label, stagingId) => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const valid = await sb.stage(lib);
    await stageExport(sb.root, 'x');
    await stageExport(sb.base, 'outside-stage');
    const before = await catalogState(sb, lib);
    const planted = await treeOf(path.join(sb.root, 'x'));

    expectFailure(
      await lib.commit({ ...valid, stagingId: stagingId as StagedExport['stagingId'] }),
      'failed',
    );

    expect(await catalogState(sb, lib)).toEqual(before);
    expect(await treeOf(path.join(sb.root, 'x'))).toEqual(planted);
  });

  const hash = contentHashOf('A');
  const badFields: [string, (staged: StagedExport) => unknown][] = [
    ['a short hash', (s) => ({ ...s, contentHash: hash.slice(1) })],
    ['a long hash', (s) => ({ ...s, contentHash: `${hash}0` })],
    [
      'an uppercase hash',
      (s) => ({ ...s, contentHash: hash.replace(/[a-f]/g, 'A').padEnd(64, 'A') }),
    ],
    ['a non-hex hash', (s) => ({ ...s, contentHash: 'z'.repeat(64) })],
    ['an empty hash', (s) => ({ ...s, contentHash: '' })],
    ['a non-string hash', (s) => ({ ...s, contentHash: 42 })],
    ['an empty fileKey', (s) => ({ ...s, identity: { kind: 'file', fileKey: '' } })],
    ['a missing fileKey', (s) => ({ ...s, identity: { kind: 'file' } })],
    ['a non-string fileKey', (s) => ({ ...s, identity: { kind: 'file', fileKey: 7 } })],
    [
      'a non-string claimedKey',
      (s) => ({ ...s, identity: { kind: 'unidentified', claimedKey: 7 } }),
    ],
    ['an unknown identity kind', (s) => ({ ...s, identity: { kind: 'team', fileKey: 'k' } })],
    ['a missing identity', ({ identity: _identity, ...s }) => s],
    ['an empty figmaNodeId', (s) => ({ ...s, figmaNodeId: '' })],
    ['a non-string figmaNodeId', (s) => ({ ...s, figmaNodeId: 9 })],
    ['a missing claimedKey', (s) => ({ ...s, identity: { kind: 'unidentified' } })],
    ['a null identity', (s) => ({ ...s, identity: null })],
    ['a missing stagingId', ({ stagingId: _stagingId, ...s }) => s],
    ['a non-string fileName', (s) => ({ ...s, fileName: 1 })],
    ['a missing nodeName', ({ nodeName: _nodeName, ...s }) => s],
    ['a non-string exportedAt', (s) => ({ ...s, exportedAt: 0 })],
    ['an array argument', (s) => Object.assign([], s)],
    ['a null argument', () => null],
    ['an undefined argument', () => undefined],
    ['a string argument', () => 'staged'],
  ];

  it.each(badFields)('fails %s without rejecting', async (_label, spoil) => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await sb.stage(lib);
    const before = await catalogState(sb, lib);

    expectFailure(await lib.commit(spoil(staged) as StagedExport), 'failed');

    expect(await catalogState(sb, lib)).toEqual(before);
  });

  it('accepts extra safe files and asset names at the 255-byte limit', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const longName = `${'a'.repeat(251)}.png`;

    const result = await sb.commit(lib, {
      assets: { [longName]: 'x' },
      extraFiles: { 'remote-masters.json': '[]', 'review-notes.md': 'added by a script' },
    });

    expect(await exists(path.join(result.path, 'preview.assets', longName))).toBe(true);
    expect(await exists(path.join(result.path, 'review-notes.md'))).toBe(true);
    const relaunched = await sb.open();
    expect(projectRevisions(expectReady(await relaunched.getSnapshot()))[0]?.state).toBe('ok');
  });
});

type Corruption = [string, (revisionDir: string, sb: Sandbox) => Promise<void>];

const receiptPath = (revisionDir: string): string => path.join(revisionDir, 'receipt.json');
const editReceipt =
  (edit: (receipt: Record<string, unknown>) => Record<string, unknown>) =>
  (revisionDir: string): Promise<void> =>
    writeReceiptEdit(revisionDir, edit);

const UNSAFE_PATHS: [string, unknown][] = [
  ['a traversal', '../receipt.json'],
  ['an absolute path', '/etc/passwd'],
  ['a nested path', 'a/b'],
  ['an escape from preview.assets', 'preview.assets/../../x'],
  ['a deep assets path', 'preview.assets/a/b'],
  ['an empty asset segment', 'preview.assets/'],
  ['an empty path', ''],
  ['a dot', '.'],
  ['a dot dot', '..'],
  ['a backslash', 'a\\b'],
  ['a NUL', 'a\0b'],
  ['a 256-byte segment', 'a'.repeat(256)],
  ['a non-string path', 7],
];

const CORRUPTIONS: Corruption[] = [
  ['a missing receipt', (dir) => rm(receiptPath(dir))],
  ['an empty receipt', (dir) => writeFile(receiptPath(dir), '')],
  ['unparseable JSON', (dir) => writeFile(receiptPath(dir), '{ nope')],
  ['JSON of the wrong shape', (dir) => writeFile(receiptPath(dir), '{}')],
  ['a JSON array', (dir) => writeFile(receiptPath(dir), '[]')],
  [
    'a directory in place of the receipt',
    async (dir) => {
      await rm(receiptPath(dir));
      await mkdir(receiptPath(dir));
    },
  ],
  [
    'a receipt over 1 MiB',
    async (dir) => {
      const text = await readFile(receiptPath(dir), 'utf8');
      await writeFile(receiptPath(dir), text + ' '.repeat(1024 * 1024 + 1));
    },
  ],
  ['a wrong revisionId', editReceipt((r) => ({ ...r, revisionId: stagingIdFor(902) }))],
  ['schemaVersion 2', editReceipt((r) => ({ ...r, schemaVersion: 2 }))],
  [
    'a fileKey for another directory',
    editReceipt((r) => ({ ...r, identity: { kind: 'file', fileKey: 'other' } })),
  ],
  ['a figmaNodeId for another directory', editReceipt((r) => ({ ...r, figmaNodeId: '9:9' }))],
  [
    'an unidentified identity inside files/',
    editReceipt((r) => ({ ...r, identity: { kind: 'unidentified', claimedKey: 'file-key-a' } })),
  ],
  [
    'a symlinked receipt that would otherwise be valid',
    async (dir, sb) => {
      const planted = path.join(sb.outside, 'receipt.json');
      await copyFile(receiptPath(dir), planted);
      await rm(receiptPath(dir));
      await symlink(planted, receiptPath(dir));
    },
  ],
  ...UNSAFE_PATHS.map(([label, unsafe]): Corruption => [
    `an unsafe files[] entry: ${label}`,
    editReceipt((r) => ({
      ...r,
      files: [...(r['files'] as unknown[]), { path: unsafe, bytes: 1 }],
    })),
  ]),
];

describe('damaged revisions', () => {
  it.each(CORRUPTIONS)('shows %s as damaged and leaves it untouched', async (_label, corrupt) => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib, { content: 'A', png: true });
    const revisionDir = revisionDirOf(first);
    await corrupt(revisionDir, sb);
    const tree = await treeOf(revisionDir);
    const mtime = (await stat(revisionDir)).mtime.toISOString();

    const relaunched = await sb.open();
    expect(await treeOf(revisionDir)).toEqual(tree);

    const snapshot = expectReady(await relaunched.getSnapshot());
    expect(projectRevisions(snapshot)).toEqual([
      {
        id: first.revisionId,
        receivedAt: mtime,
        preview: null,
        state: 'damaged',
        bundlePath: first.path,
      },
    ]);
    expect(await treeOf(revisionDir)).toEqual(tree);
    expect(await relaunched.previewFile(first.revisionId)).toBeNull();

    const staged = await sb.stage(relaunched, { content: 'A', png: true });
    const repeat = expectOk(await relaunched.commit(staged));

    expect(repeat.status).toBe('committed');
    expect(path.basename(path.dirname(repeat.path))).toBe(`000002-${staged.stagingId}`);
    expect(await treeOf(revisionDir)).toEqual(tree);
    const after = expectReady(await relaunched.getSnapshot());
    expect(projectRevisions(after).map(({ id, state }) => ({ id, state }))).toEqual([
      { id: staged.stagingId, state: 'ok' },
      { id: first.revisionId, state: 'damaged' },
    ]);
  });

  it('reports a project with only damaged revisions by its directory slugs', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib, {
      identity: fileIdentity('KEY'),
      fileName: 'Display File',
      figmaNodeId: '1:2',
      nodeName: 'Display Node',
    });
    await writeFile(receiptPath(revisionDirOf(first)), 'garbage');

    const snapshot = expectReady(await lib.getSnapshot());

    expect(snapshot.projects).toHaveLength(1);
    const project = snapshot.projects[0];
    expect(project).toMatchObject({ id: sha16('KEY'), fileKey: '', fileName: 'display-file' });
    expect(project?.nodes[0]).toMatchObject({
      id: `${sha16('KEY')}-${sha16('1:2')}`,
      figmaNodeId: '',
      name: 'display-node',
    });
  });

  it('takes project fields from the newest valid receipt past a damaged latest', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const good = await sb.commit(lib, {
      content: 'A',
      fileName: 'Good Name',
      nodeName: 'Good Node',
    });
    const bad = await sb.commit(lib, { content: 'B', fileName: 'Bad Name', nodeName: 'Bad Node' });
    await writeFile(receiptPath(revisionDirOf(bad)), 'garbage');

    const project = projectFor(expectReady(await lib.getSnapshot()), 'file-key-a');

    expect(project.fileName).toBe('Good Name');
    expect(nodeFor(project, '1:2').name).toBe('Good Node');
    expect(idsOf(nodeFor(project, '1:2').revisions)).toEqual([bad.revisionId, good.revisionId]);
  });

  it('compares only with the damaged latest, not the valid revision under it', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    await sb.commit(lib, { content: 'A' });
    const bad = await sb.commit(lib, { content: 'B' });
    await writeFile(receiptPath(revisionDirOf(bad)), 'garbage');
    const relaunched = await sb.open();

    const repeat = await sb.commit(relaunched, { content: 'A' });

    expect(repeat.status).toBe('committed');
  });

  it('continues the sequence from the damaged directory name', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib);
    const nodeDir = path.dirname(revisionDirOf(first));
    const renumbered = path.join(nodeDir, `000041-${first.revisionId}`);
    await rename(revisionDirOf(first), renumbered);
    await writeFile(receiptPath(renumbered), 'garbage');
    const relaunched = await sb.open();

    const next = await sb.commit(relaunched, { content: 'B' });

    expect(path.basename(path.dirname(next.path)).slice(0, 6)).toBe('000042');
  });

  const withField = (key: string, value: unknown) => editReceipt((r) => ({ ...r, [key]: value }));
  const withExtraFile = (entry: unknown) =>
    editReceipt((r) => ({ ...r, files: [...(r['files'] as unknown[]), entry] }));
  const RECEIPT_KEYS = [
    'schemaVersion',
    'revisionId',
    'receivedAt',
    'contentHash',
    'exportedAt',
    'identity',
    'fileName',
    'figmaNodeId',
    'nodeName',
    'files',
  ];

  const unidentifiedCorruptions: Corruption[] = [
    ['unparseable JSON', (dir) => writeFile(receiptPath(dir), '{ nope')],
    ['JSON null', (dir) => writeFile(receiptPath(dir), 'null')],
    ['a JSON string', (dir) => writeFile(receiptPath(dir), '"receipt"')],
    ['a wrong revisionId', editReceipt((r) => ({ ...r, revisionId: stagingIdFor(902) }))],
    [
      'a file identity under unidentified/',
      editReceipt((r) => ({ ...r, identity: { kind: 'file', fileKey: 'k' } })),
    ],
    ...RECEIPT_KEYS.map((key): Corruption => [
      `no ${key}`,
      editReceipt(({ [key]: _omitted, ...r }) => r),
    ]),
    ['schemaVersion as a string', withField('schemaVersion', '1')],
    ['a numeric receivedAt', withField('receivedAt', Date.UTC(2026, 0, 1))],
    ['an unparseable receivedAt', withField('receivedAt', 'yesterday')],
    ['a short contentHash', withField('contentHash', 'abc')],
    ['an uppercase contentHash', withField('contentHash', 'A'.repeat(64))],
    ['a null identity', withField('identity', null)],
    ['an unknown identity kind', withField('identity', { kind: 'team', claimedKey: 'k' })],
    ['no claimedKey', withField('identity', { kind: 'unidentified' })],
    ['a numeric claimedKey', withField('identity', { kind: 'unidentified', claimedKey: 7 })],
    ['an empty figmaNodeId', withField('figmaNodeId', '')],
    ['a numeric figmaNodeId', withField('figmaNodeId', 12)],
    ['a numeric exportedAt', withField('exportedAt', 0)],
    ['a numeric fileName', withField('fileName', 1)],
    ['a boolean nodeName', withField('nodeName', true)],
    ['files as an object', withField('files', {})],
    ['a null files[] entry', withExtraFile(null)],
    ['a files[] entry with no path', withExtraFile({ bytes: 1 })],
    ['a files[] entry with no bytes', withExtraFile({ path: 'extra.json' })],
    ['negative bytes', withExtraFile({ path: 'extra.json', bytes: -1 })],
    ['fractional bytes', withExtraFile({ path: 'extra.json', bytes: 1.5 })],
    ['bytes as a string', withExtraFile({ path: 'extra.json', bytes: '1' })],
    ['bytes past the safe integer range', withExtraFile({ path: 'extra.json', bytes: 2 ** 53 })],
  ];

  it.each(unidentifiedCorruptions)(
    'shows an unidentified entry with %s as damaged',
    async (_label, corrupt) => {
      const sb = await newSandbox();
      const lib = await sb.open();
      const first = await sb.commit(lib, {
        identity: unidentified('k'),
        fileName: 'Hint',
        nodeName: 'Loose Node',
      });
      const revisionDir = revisionDirOf(first);
      await corrupt(revisionDir, sb);
      const tree = await treeOf(revisionDir);
      const slug = path.basename(revisionDir).slice(0, -(first.revisionId.length + 1));

      const relaunched = await sb.open();
      const snapshot = expectReady(await relaunched.getSnapshot());

      expect(snapshot.unidentified).toEqual([
        {
          id: first.revisionId,
          receivedAt: (await stat(revisionDir)).mtime.toISOString(),
          preview: null,
          state: 'damaged',
          bundlePath: first.path,
          claimedName: null,
          claimedKey: null,
          figmaNodeId: '',
          name: slug,
        },
      ]);

      const repeat = await sb.commit(relaunched, { identity: unidentified('k') });

      expect(repeat.status).toBe('committed');
      expect(await treeOf(revisionDir)).toEqual(tree);
    },
  );

  it('shows a project revision moved to another node directory as damaged', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const moved = await sb.commit(lib, { figmaNodeId: '1:1' });
    const stays = await sb.commit(lib, { figmaNodeId: '2:2' });
    const target = path.join(path.dirname(revisionDirOf(stays)), `000005-${moved.revisionId}`);
    await rename(revisionDirOf(moved), target);

    const snapshot = expectReady(await (await sb.open()).getSnapshot());

    const revision = projectRevisions(snapshot).find(({ id }) => id === moved.revisionId);
    expect(revision).toMatchObject({ state: 'damaged', bundlePath: path.join(target, 'bundle') });
  });

  it('shows a project revision moved under unidentified/ as damaged', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const moved = await sb.commit(lib);
    const target = path.join(sb.root, 'unidentified', `moved-${moved.revisionId}`);
    await rename(revisionDirOf(moved), target);

    const snapshot = expectReady(await (await sb.open()).getSnapshot());

    expect(snapshot.unidentified).toHaveLength(1);
    expect(snapshot.unidentified[0]).toMatchObject({ id: moved.revisionId, state: 'damaged' });
  });

  it('shows an unidentified entry moved under files/ as damaged', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const anchor = await sb.commit(lib);
    const moved = await sb.commit(lib, { identity: unidentified('file-key-a') });
    const target = path.join(path.dirname(revisionDirOf(anchor)), `000002-${moved.revisionId}`);
    await rename(revisionDirOf(moved), target);

    const snapshot = expectReady(await (await sb.open()).getSnapshot());

    expect(snapshot.unidentified).toEqual([]);
    expect(projectRevisions(snapshot).find(({ id }) => id === moved.revisionId)?.state).toBe(
      'damaged',
    );
  });

  it('never converges on a damaged unidentified entry', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const first = await sb.commit(lib, { identity: unidentified(null) });
    await writeFile(receiptPath(revisionDirOf(first)), 'garbage');
    const relaunched = await sb.open();

    const repeat = await sb.commit(relaunched, { identity: unidentified(null) });

    expect(repeat.status).toBe('committed');
    expect(repeat.revisionId).not.toBe(first.revisionId);
  });
});

describe('scan boundaries', () => {
  it('ignores symlinks and names outside the layout, and touches none of them', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const real = await sb.commit(lib);
    const nodeDir = path.dirname(revisionDirOf(real));
    const projectDir = path.dirname(nodeDir);
    const decoy = await sb.commit(lib, { identity: fileIdentity('decoy') });
    const decoyProject = path.dirname(path.dirname(revisionDirOf(decoy)));
    await rename(decoyProject, path.join(sb.outside, 'project'));
    const orphanId = stagingIdFor(903);

    await writeFile(path.join(sb.root, 'files', 'README.txt'), 'x');
    await mkdir(path.join(sb.root, 'files', 'not-a-project'));
    await symlink(
      path.join(sb.outside, 'project'),
      path.join(sb.root, 'files', `linked-${sha16('decoy')}`),
    );
    await writeFile(path.join(projectDir, 'notes.txt'), 'x');
    await mkdir(path.join(projectDir, 'not-a-node'));
    await mkdir(path.join(nodeDir, `not-a-seq-${orphanId}`));
    await mkdir(path.join(nodeDir, `000099-${orphanId.toUpperCase()}`));
    await mkdir(path.join(nodeDir, '000099-short'));
    await mkdir(path.join(sb.root, 'unidentified', 'no-uuid-here'));
    await symlink(sb.outside, path.join(sb.root, 'unidentified', `linked-${orphanId}`));
    const tree = await treeOf(sb.root);
    const outside = await treeOf(sb.outside);

    const relaunched = await sb.open();
    const snapshot = expectReady(await relaunched.getSnapshot());

    expect(idsOf(projectRevisions(snapshot))).toEqual([real.revisionId]);
    expect(snapshot.unidentified).toEqual([]);
    expect(await treeOf(sb.root)).toEqual(tree);
    expect(await treeOf(sb.outside)).toEqual(outside);
  });
});

async function swapForLink(target: string, outsidePath: string): Promise<void> {
  await rm(target, { recursive: true });
  await symlink(outsidePath, target);
}

function readsThrough(fs: ReturnType<typeof instrumentFs>, link: string): string[] {
  return fs.calls
    .filter(({ method }) => ['readFile', 'copyFile', 'open'].includes(method))
    .filter(({ args }) => args[0] === link)
    .map(({ method }) => method);
}

describe('containment', () => {
  const hostileIds = ['', '..', '../../etc/passwd', '/etc/passwd', stagingIdFor(901)];

  it.each(hostileIds)('treats %j as an unknown id everywhere', async (id) => {
    const sb = await newSandbox();
    const lib = await sb.open();
    await sb.commit(lib);
    const revisionId = asRevisionId(id);

    expectFailure(await lib.bundlePath(revisionId), 'not-found');
    expectFailure(await lib.copyTo(revisionId, sb.dest), 'not-found');
    expectFailure(await lib.trash(revisionId), 'not-found');
    expect(await lib.previewFile(revisionId)).toBeNull();
    expect(sb.trash.calls).toEqual([]);
    expect(await readdir(sb.dest)).toEqual([]);
  });

  it('refuses a bundle file replaced by a symlink to outside', async () => {
    const sb = await newSandbox();
    const fs = instrumentFs();
    const lib = await sb.open(fs.fs);
    const result = await sb.commit(lib, { png: true });
    const link = path.join(result.path, 'preview.png');
    await swapForLink(link, path.join(sb.outside, 'secret.txt'));
    fs.arm();

    expect(await lib.previewFile(result.revisionId)).toBeNull();
    expectFailure(await lib.copyTo(result.revisionId, sb.dest), 'damaged');

    expect(await readdir(sb.dest)).toEqual([]);
    expect(readsThrough(fs, link)).toEqual([]);
  });

  it('refuses a required file replaced by a symlink even when it is not the preview', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    await swapForLink(path.join(result.path, 'node.json'), path.join(sb.outside, 'secret.txt'));

    expectFailure(await lib.copyTo(result.revisionId, sb.dest), 'damaged');
    expect(await readdir(sb.dest)).toEqual([]);
  });

  it('refuses an assets directory replaced by a symlink', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib, { assets: { 'a.bin': 'x' } });
    await writeFile(path.join(sb.outside, 'a.bin'), SECRET);
    await swapForLink(path.join(result.path, 'preview.assets'), sb.outside);

    expectFailure(await lib.copyTo(result.revisionId, sb.dest), 'damaged');
    expect(await readdir(sb.dest)).toEqual([]);
  });

  it('refuses a bundle directory replaced by a symlink', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib, { png: true });
    const copy = path.join(sb.outside, 'bundle-copy');
    await rename(result.path, copy);
    await symlink(copy, result.path);

    const bundle = await lib.bundlePath(result.revisionId);

    expect(bundle.ok).toBe(false);
    expect(await lib.previewFile(result.revisionId)).toBeNull();
    expectFailure(await lib.copyTo(result.revisionId, sb.dest), 'damaged');
    expect(await readdir(sb.dest)).toEqual([]);
  });

  it('hands nothing out when a revision directory is replaced by a symlink', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib, { png: true });
    const revisionDir = revisionDirOf(result);
    const copy = path.join(sb.outside, 'revision-copy');
    await rename(revisionDir, copy);
    await symlink(copy, revisionDir);
    const outside = await treeOf(sb.outside);

    expect((await lib.bundlePath(result.revisionId)).ok).toBe(false);
    expect(await lib.previewFile(result.revisionId)).toBeNull();
    expect((await lib.copyTo(result.revisionId, sb.dest)).ok).toBe(false);
    expect((await lib.trash(result.revisionId)).ok).toBe(false);

    expect(sb.trash.calls).toEqual([]);
    expect(await readdir(sb.dest)).toEqual([]);
    expect(await treeOf(sb.outside)).toEqual(outside);
  });

  it('hands nothing out when a parent directory escapes through a symlink', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib, { png: true });
    const projectDir = path.dirname(path.dirname(revisionDirOf(result)));
    const copy = path.join(sb.outside, 'project-copy');
    await rename(projectDir, copy);
    await symlink(copy, projectDir);
    const outside = await treeOf(sb.outside);

    expect((await lib.bundlePath(result.revisionId)).ok).toBe(false);
    expect(await lib.previewFile(result.revisionId)).toBeNull();
    expect((await lib.copyTo(result.revisionId, sb.dest)).ok).toBe(false);
    expect((await lib.trash(result.revisionId)).ok).toBe(false);

    expect(sb.trash.calls).toEqual([]);
    expect(await treeOf(sb.outside)).toEqual(outside);
  });

  it('refuses a symlink even when it stays inside the library', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const donor = await sb.commit(lib, { content: 'donor', png: true });
    const fileLink = await sb.commit(lib, { content: 'file-link', png: true });
    const dirLink = await sb.commit(lib, { content: 'dir-link', png: true });
    await swapForLink(
      path.join(fileLink.path, 'preview.png'),
      path.join(donor.path, 'preview.png'),
    );
    await swapForLink(dirLink.path, donor.path);

    expect(await lib.previewFile(fileLink.revisionId)).toBeNull();
    expectFailure(await lib.copyTo(fileLink.revisionId, sb.dest), 'damaged');
    expect((await lib.bundlePath(dirLink.revisionId)).ok).toBe(false);
    expect(await lib.previewFile(dirLink.revisionId)).toBeNull();
    expectFailure(await lib.copyTo(dirLink.revisionId, sb.dest), 'damaged');
    expect(await readdir(sb.dest)).toEqual([]);
  });

  it('never hands out html through previewFile', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib, { html: true });

    expect(await lib.previewFile(result.revisionId)).toBeNull();
  });

  it('refuses a damaged revision through previewFile even with its image on disk', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib, { png: true });
    await writeFile(receiptPath(revisionDirOf(result)), 'garbage');
    const relaunched = await sb.open();

    expect(await relaunched.previewFile(result.revisionId)).toBeNull();
    expect((await lstat(path.join(result.path, 'preview.png'))).isFile()).toBe(true);
  });
});

describe('locate', () => {
  it('maps the reply path, the reply preview and manifest files to the revision', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib, { png: true });
    const target = { kind: 'revision', revisionId: result.revisionId };

    expect(await lib.locate(result.path)).toEqual(target);
    expect(await lib.locate(result.preview ?? '')).toEqual(target);
    expect(await lib.locate(path.join(result.path, 'node.json'))).toEqual(target);
  });

  it('maps a project revision directory to its project', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib, { identity: fileIdentity('KEY') });

    expect(await lib.locate(revisionDirOf(result))).toEqual({
      kind: 'project',
      projectId: sha16('KEY'),
    });
  });

  it('maps an unidentified directory, bundle and preview to the entry', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib, { identity: unidentified(null), html: true });
    const target = { kind: 'revision', revisionId: result.revisionId };

    expect(await lib.locate(revisionDirOf(result))).toEqual(target);
    expect(await lib.locate(result.path)).toEqual(target);
    expect(await lib.locate(result.preview ?? '')).toEqual(target);
  });

  it('matches exact strings only', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib, { png: true, assets: { 'a.bin': 'x' } });
    const revisionDir = revisionDirOf(result);

    const misses = [
      '/etc/passwd',
      '',
      'bundle',
      sb.root,
      path.dirname(revisionDir),
      `${result.path}-sibling`,
      `${revisionDir}-sibling`,
      `${result.path}/../bundle`,
      `${result.path}/`,
      `${revisionDir}/`,
      `${result.path}/./node.json`,
      result.path.toUpperCase(),
      path.join(revisionDir, 'receipt.json'),
      path.join(result.path, 'not-in-the-manifest.json'),
      path.join(result.path, 'preview.assets', 'a.bin'),
    ];

    for (const miss of misses) expect(await lib.locate(miss), miss).toBeNull();
  });

  it('never touches the filesystem', async () => {
    const sb = await newSandbox();
    const fs = instrumentFs();
    const lib = await sb.open(fs.fs);
    const result = await sb.commit(lib, { png: true });
    fs.arm();

    await lib.locate(result.path);
    await lib.locate(result.preview ?? '');
    await lib.locate(revisionDirOf(result));
    await lib.locate('/etc/passwd');
    await lib.locate(`${result.path}/../bundle`);
    expect(fs.calls).toEqual([]);

    await lib.getSnapshot();
    expect(fs.calls.length).toBeGreaterThan(0);
  });

  it('follows the catalog through commit and trash', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    expect(await lib.locate(result.path)).not.toBeNull();

    expectOk(await lib.trash(result.revisionId));

    expect(await lib.locate(result.path)).toBeNull();
    expect(await lib.locate(revisionDirOf(result))).toBeNull();
  });

  it('answers for a damaged revision bundle path', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib);
    await writeFile(receiptPath(revisionDirOf(result)), 'garbage');
    const relaunched = await sb.open();

    expect(await relaunched.locate(result.path)).toEqual({
      kind: 'revision',
      revisionId: result.revisionId,
    });
  });
});

describe('receipt round trip', () => {
  it('reads back null fields as valid', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib, {
      identity: unidentified(null),
      fileName: null,
      nodeName: null,
      exportedAt: null,
    });

    expect(await readReceipt(revisionDirOf(result))).toMatchObject({
      exportedAt: null,
      fileName: null,
      nodeName: null,
    });
    const relaunched = await sb.open();
    expect(expectReady(await relaunched.getSnapshot()).unidentified[0]?.state).toBe('ok');
  });

  it('reads a receipt carrying keys it does not know as valid', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const result = await sb.commit(lib, { png: true });
    await writeReceiptEdit(revisionDirOf(result), (r) => ({
      ...r,
      addedLater: { by: 'a newer build' },
      identity: { ...(r['identity'] as object), source: 'plugin' },
      files: (r['files'] as object[]).map((file) => Object.assign(file, { sha256: 'unknown' })),
    }));

    const relaunched = await sb.open();

    const revisions = projectRevisions(expectReady(await relaunched.getSnapshot()));
    expect(revisions).toMatchObject([{ id: result.revisionId, state: 'ok' }]);
    expect(await relaunched.previewFile(result.revisionId)).toEqual({
      path: path.join(result.path, 'preview.png'),
      contentType: 'image/png',
    });
  });

  it('does not follow a receipt symlink planted in staging', async () => {
    const sb = await newSandbox();
    const lib = await sb.open();
    const staged = await sb.stage(lib);
    const target = path.join(sb.outside, 'secret.txt');
    await symlink(target, path.join(lib.stagingDir, staged.stagingId, 'receipt.json'));

    expect(await lib.commit(staged)).toMatchObject({ ok: false });

    expect(await readFile(target, 'utf8')).toBe(SECRET);
    expect(expectReady(await lib.getSnapshot()).projects).toEqual([]);
  });
});
