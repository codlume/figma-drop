import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const execFileAsync = promisify(execFile);

// The library uses bundler-style imports, and Node's type stripping needs the extension.
registerHooks({
  resolve(specifier, context, next) {
    const extensionless = specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier);
    return next(extensionless ? `${specifier}.ts` : specifier, context);
  },
});

const librarySource = join(repo, 'apps/desktop/src/library');
const { createLibrary } = await import(join(librarySource, 'index.ts'));
const { openLibrary } = await import(join(librarySource, 'library.ts'));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const HOSTILE_SVG = `<svg xmlns="http://www.w3.org/2000/svg"><script>document.title='ran'</script></svg>`;

const uuid = (n) => {
  const hex = createHash('sha256').update(`proof:${n}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const hashOf = (content) => createHash('sha256').update(content).digest('hex');

async function stage(library, n, { identity, node = '1:2', content = 'A', fileName, files = {} }) {
  const bundle = join(library.stagingDir, uuid(n), 'bundle');
  await fsp.mkdir(bundle, { recursive: true });
  const all = {
    'node.json': JSON.stringify({ id: node, content }),
    'figma-components.json': '[]',
    'meta.json': '{}',
    ...files,
  };
  for (const [name, bytes] of Object.entries(all)) await fsp.writeFile(join(bundle, name), bytes);
  return {
    stagingId: uuid(n),
    identity,
    fileName: fileName ?? null,
    figmaNodeId: node,
    nodeName: 'Hero Card',
    contentHash: hashOf(content),
    exportedAt: '2026-01-01T00:00:00.000Z',
  };
}

const die = () => process.kill(process.pid, 'SIGKILL');

// Child mode: dies by SIGKILL at one real step of a commit.
if (process.argv[2] === '--die') {
  const [, , , root, point] = process.argv;
  const fs = {
    ...fsp,
    async writeFile(path, ...rest) {
      if (point === 'receipt-write' && String(path).endsWith('receipt.json')) die();
      return fsp.writeFile(path, ...rest);
    },
    async rename(from, to) {
      if (point === 'before-rename') die();
      await fsp.rename(from, to);
      if (point === 'after-rename') die();
    },
  };
  const library = await openLibrary({ root, trashItem: async () => {} }, { fs });
  await library.commit(await stage(library, 500, { identity: { kind: 'file', fileKey: 'crash' } }));
  process.exit(0);
}

const lines = [];
function pass(claim, ok) {
  if (!ok) {
    console.error(`FAIL ${claim}`);
    process.exit(1);
  }
  lines.push(`PASS ${claim}`);
  console.log(`PASS ${claim}`);
}

const realLibrary = join(homedir(), 'figma-drop');
const realLibraryBefore = existsSync(realLibrary) ? statSync(realLibrary).mtimeMs : null;

const base = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'figma-drop-proof-')));
const root = join(base, 'library');
const fakeTrash = join(base, 'fake-trash');
const dest = join(base, 'dest');
await fsp.mkdir(fakeTrash);
await fsp.mkdir(dest);
const trashed = [];
const trashItem = async (path) => {
  trashed.push(path);
  await fsp.rename(path, join(fakeTrash, String(trashed.length)));
};
const open = () => createLibrary({ root, trashItem });
const fileA = { kind: 'file', fileKey: 'key-a' };
const fileB = { kind: 'file', fileKey: 'key-b' };

try {
  let library = await open();
  let n = 0;
  const send = async (options) => library.commit(await stage(library, (n += 1), options));

  const first = await send({
    identity: fileA,
    fileName: 'Untitled',
    files: { 'preview.png': PNG },
  });
  pass('a synthetic export commits as a new revision', first.ok && first.status === 'committed');
  pass('the reply path is a real bundle', existsSync(join(first.path, 'node.json')));
  pass('the reply preview is inside the bundle', first.preview === join(first.path, 'preview.png'));

  await send({ identity: fileB, fileName: 'Untitled', content: 'other file' });
  let snapshot = await library.getSnapshot();
  pass('two files with one name stay two projects', snapshot.projects.length === 2);

  const repeat = await send({ identity: fileA, fileName: 'Untitled' });
  pass(
    'a byte-identical repeat is skipped and replies with the first path',
    repeat.status === 'skipped' && repeat.path === first.path,
  );

  await send({ identity: fileA, content: 'B' });
  const revert = await send({ identity: fileA, content: 'A' });
  snapshot = await library.getSnapshot();
  const projectA = snapshot.projects.find((project) => project.fileKey === 'key-a');
  pass(
    'A/B/A keeps three revisions, newest first',
    revert.status === 'committed' &&
      projectA.nodes[0].revisions.length === 3 &&
      projectA.nodes[0].revisions[0].id === revert.revisionId,
  );

  const fallback = { kind: 'unidentified', claimedKey: 'Untitled' };
  const lost = await send({ identity: fallback, fileName: 'Untitled', node: '9:9', content: 'U' });
  const again = await send({ identity: fallback, fileName: 'Untitled', node: '9:9', content: 'U' });
  snapshot = await library.getSnapshot();
  pass(
    'a fallback export lands in Unidentified and joins no project',
    snapshot.unidentified.length === 1 && snapshot.projects.length === 2,
  );
  pass(
    'an identical Unidentified re-send converges',
    again.status === 'converged' && again.revisionId === lost.revisionId,
  );

  const staged = await stage(library, (n += 1), { identity: fileA, content: 'replay' });
  const replayFirst = await library.commit(staged);
  const replaySecond = await library.commit(staged);
  pass(
    'replaying a staging id returns the first revision',
    replaySecond.status === 'converged' && replaySecond.path === replayFirst.path,
  );

  const before = JSON.stringify(await library.getSnapshot());
  library = await open();
  pass(
    'the whole catalog survives a relaunch',
    JSON.stringify(await library.getSnapshot()) === before,
  );
  const afterRelaunch = await library.commit(staged);
  pass(
    'a replay still converges after a relaunch',
    afterRelaunch.status === 'converged' && afterRelaunch.path === replayFirst.path,
  );

  const preview = await library.previewFile(first.revisionId);
  pass(
    'a preview is a contained image path',
    preview.contentType === 'image/png' && preview.path.startsWith(`${root}/`),
  );
  const htmlOnly = await send({
    identity: fileB,
    content: 'html',
    files: { 'preview.html': HOSTILE_SVG },
  });
  pass(
    'HTML never comes back as a preview',
    (await library.previewFile(htmlOnly.revisionId)) === null,
  );
  pass(
    'an unknown id reaches no path',
    (await library.bundlePath('../../etc/passwd')).code === 'not-found' &&
      (await library.previewFile('../../etc/passwd')) === null &&
      (await library.locate('/etc/passwd')) === null,
  );

  const copied = await library.copyTo(first.revisionId, dest);
  const copiedNames = readdirSync(copied.path).toSorted();
  pass(
    'Copy to folder writes a plain bundle with no receipt',
    copiedNames.join() === 'figma-components.json,meta.json,node.json,preview.png',
  );
  const copiedAgain = await library.copyTo(first.revisionId, dest);
  pass('a second copy never reuses the first folder', copiedAgain.path !== copied.path);
  pass(
    'a destination inside the library is refused',
    (await library.copyTo(first.revisionId, join(root, 'files'))).ok === false,
  );

  const victim = dirname(first.path);
  const trashResult = await library.trash(first.revisionId);
  pass(
    'Trash goes through the injected adapter with the revision directory',
    trashResult.ok && trashed.length === 1 && trashed[0] === victim && !existsSync(victim),
  );
  pass(
    'the bytes are still in the fake Trash',
    existsSync(join(fakeTrash, '1', 'bundle', 'node.json')),
  );

  for (const [point, retryStatus] of [
    ['receipt-write', 'committed'],
    ['before-rename', 'committed'],
    ['after-rename', 'skipped'],
  ]) {
    const crashRoot = join(base, `crash-${point}`);
    const code = await new Promise((resolve) => {
      spawn(process.execPath, [fileURLToPath(import.meta.url), '--die', crashRoot, point], {
        stdio: 'ignore',
      }).on('exit', (_code, signal) => resolve(signal));
    });
    pass(`the child really died by SIGKILL at ${point}`, code === 'SIGKILL');
    const reopened = await createLibrary({ root: crashRoot, trashItem });
    const left = readdirSync(join(crashRoot, '.staging'));
    const retry = await reopened.commit(
      await stage(reopened, 600, { identity: { kind: 'file', fileKey: 'crash' } }),
    );
    const after = await reopened.getSnapshot();
    pass(
      `after a kill at ${point} staging is swept and a retry leaves one revision`,
      left.length === 0 &&
        retry.status === retryStatus &&
        after.projects[0].nodes[0].revisions.length === 1 &&
        after.projects[0].nodes[0].revisions[0].state === 'ok',
    );
  }

  const { stdout } = await execFileAsync(
    'pnpm',
    ['--filter', '@figma-drop/desktop', 'exec', 'vp', 'test', 'run', 'src/library'],
    { cwd: repo, maxBuffer: 1 << 26 },
  );
  const count = /Tests\s+(\d+) passed \(\1\)/.exec(stripVTControlCharacters(stdout));
  pass(`the focused suite passes, ${count?.[1]} tests`, count !== null);

  const realLibraryAfter = existsSync(realLibrary) ? statSync(realLibrary).mtimeMs : null;
  pass('~/figma-drop was not touched', realLibraryAfter === realLibraryBefore);
  pass(
    'every path the fake Trash saw was inside the temp sandbox',
    trashed.every((path) => !relative(base, path).startsWith('..')),
  );
  lines.push('ALL PASS');
  console.log('ALL PASS');
  await fsp.writeFile(join(here, 'verify-library.txt'), `${lines.join('\n')}\n`);
} finally {
  if (base.includes('figma-drop-proof-')) await fsp.rm(base, { recursive: true, force: true });
}
