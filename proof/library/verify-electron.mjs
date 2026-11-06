import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assert,
  createLog,
  freePort,
  launchApp,
  stopTracked,
  waitUntil,
} from '../shell/driver.mjs';

// The built app must already exist: `pnpm --filter @figma-drop/desktop build`.
// This proof never calls trash, reveal, or copy with a real id. In the real app those reach the
// real Trash, Finder, and clipboard.
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const log = createLog();

registerHooks({
  resolve(specifier, context, next) {
    const extensionless = specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier);
    return next(extensionless ? `${specifier}.ts` : specifier, context);
  },
});
const { createLibrary } = await import(join(repo, 'apps/desktop/src/library/index.ts'));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>document.title='ran'</script><rect width="4" height="4"/></svg>`;
const HTML = `<!doctype html><script>document.title='ran'</script>`;

async function seed(library, { identity, content, node = '1:2', files }) {
  const stagingId = randomUUID();
  const bundle = join(library.stagingDir, stagingId, 'bundle');
  await fsp.mkdir(bundle, { recursive: true });
  const all = { 'node.json': '{}', 'figma-components.json': '[]', 'meta.json': '{}', ...files };
  for (const [name, bytes] of Object.entries(all)) await fsp.writeFile(join(bundle, name), bytes);
  const result = await library.commit({
    stagingId,
    identity,
    fileName: 'Untitled',
    figmaNodeId: node,
    nodeName: 'Hero Card',
    contentHash: createHash('sha256').update(content).digest('hex'),
    exportedAt: null,
  });
  assert(result.ok, 'seeded export commits');
  return result;
}

async function step(label, run) {
  await run();
  log.write(`PASS ${label}`);
}

const realLibrary = join(homedir(), 'figma-drop');
const realLibraryBefore = existsSync(realLibrary) ? statSync(realLibrary).mtimeMs : null;
const scratch = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'figma-drop-electron-')));
const paths = { userData: join(scratch, 'user-data'), library: join(scratch, 'library') };
const port = await freePort();

const imageLoads = (page, url) =>
  page.evaluate(`new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth > 0);
    image.onerror = () => resolve(false);
    image.src = ${JSON.stringify(url)};
  })`);

const readySnapshot = async (page) =>
  waitUntil(async () => {
    const snapshot = await page.evaluate('window.figmaDrop.library.getSnapshot()');
    return snapshot.state === 'ready' ? snapshot : null;
  }, 'a ready snapshot');

async function quit(app) {
  await app.hook(`clickTray('quit')`).catch(() => {});
  const exit = await app.exitWithin(4_000);
  assert(exit?.code === 0, 'the app quits cleanly');
}

try {
  const seeder = await createLibrary({ root: paths.library, trashItem: async () => {} });
  const fileA = { kind: 'file', fileKey: 'key-a' };
  await seed(seeder, { identity: fileA, content: 'A', files: { 'preview.png': PNG } });
  const latest = await seed(seeder, {
    identity: fileA,
    content: 'B',
    files: { 'preview.png': PNG },
  });
  const svg = await seed(seeder, {
    identity: { kind: 'file', fileKey: 'key-b' },
    content: 'svg',
    files: { 'preview.svg': SVG },
  });
  const damaged = await seed(seeder, {
    identity: { kind: 'file', fileKey: 'key-c' },
    content: 'd',
  });
  await fsp.writeFile(join(dirname(damaged.path), 'receipt.json'), 'not json');
  const html = await seed(seeder, {
    identity: { kind: 'unidentified', claimedKey: 'Untitled' },
    content: 'html',
    files: { 'preview.html': HTML },
  });
  const leftover = join(seeder.stagingDir, randomUUID());
  await fsp.mkdir(leftover);

  let app = launchApp({ ...paths, port });
  let page = await app.page();
  let snapshot = await readySnapshot(page);

  await step('the built app loads the real library and reports ready', async () => {
    assert(snapshot.projects.length === 3, 'three projects');
    assert(snapshot.unidentified.length === 1, 'one Unidentified entry');
  });
  await step('history reaches the renderer newest first', async () => {
    const project = snapshot.projects.find((candidate) => candidate.fileKey === 'key-a');
    assert(project.nodes[0].revisions.length === 2, 'two revisions');
    assert(project.nodes[0].revisions[0].id === latest.revisionId, 'newest first');
  });
  await step('a damaged revision reaches the renderer as damaged, files untouched', async () => {
    const revisions = snapshot.projects.flatMap((p) => p.nodes.flatMap((n) => n.revisions));
    const found = revisions.find((revision) => revision.id === damaged.revisionId);
    assert(found.state === 'damaged' && found.preview === null, 'damaged');
    assert(existsSync(join(damaged.path, 'node.json')), 'bundle kept');
  });
  await step('opening the app sweeps a staging leftover', async () => {
    assert(!existsSync(leftover), 'leftover swept');
  });
  await step('a PNG preview renders through the preview scheme', async () => {
    const project = snapshot.projects.find((candidate) => candidate.fileKey === 'key-a');
    const url = project.nodes[0].revisions[0].preview.url;
    assert(await imageLoads(page, url), 'PNG rendered');
  });
  await step('an SVG preview renders as an image through the preview scheme', async () => {
    const project = snapshot.projects.find((candidate) => candidate.fileKey === 'key-b');
    const revision = project.nodes[0].revisions[0];
    assert(revision.id === svg.revisionId, 'the SVG revision');
    assert(await imageLoads(page, revision.preview.url), 'SVG rendered');
  });
  await step('an HTML-only export has no preview in the renderer', async () => {
    const entry = snapshot.unidentified.find((item) => item.id === html.revisionId);
    assert(entry.preview === null, 'no preview');
  });
  await step('a well-formed unknown id reaches the library and comes back not-found', async () => {
    const unknown = JSON.stringify(randomUUID());
    for (const command of ['reveal', 'copyPath', 'trash']) {
      const result = await page.evaluate(`window.figmaDrop.library.${command}(${unknown})`);
      assert(result.ok === false && result.code === 'not-found', `${command} is not-found`);
    }
  });

  const before = JSON.stringify(snapshot);
  await quit(app);
  app = launchApp({ ...paths, port });
  page = await app.page();
  snapshot = await readySnapshot(page);
  await step('the catalog survives a real app restart unchanged', async () => {
    assert(JSON.stringify(snapshot) === before, 'identical snapshot');
  });
  await quit(app);

  await step('~/figma-drop was not touched', async () => {
    const after = existsSync(realLibrary) ? statSync(realLibrary).mtimeMs : null;
    assert(after === realLibraryBefore, 'real library unchanged');
    assert(readdirSync(join(paths.library, '.staging')).length === 0, 'staging empty');
  });
  log.write('ALL PASS');
  await fsp.writeFile(join(here, 'verify-electron.txt'), `${log.lines.join('\n')}\n`);
} finally {
  await stopTracked();
  if (scratch.includes('figma-drop-electron-')) {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}
