import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

import {
  assert,
  createLog,
  desktopDir,
  freePort,
  refusesConnection,
  repoDir,
  stopTracked,
  waitUntil,
} from '../shell/driver.mjs';
import {
  BLUE,
  GREEN,
  RED,
  TEAL,
  exportBody,
  hostileSvg,
  nearestColor,
  plainSvg,
  solidPng,
  styledSvg,
} from './fixtures.mjs';
import {
  Session,
  encodeRecording,
  frontApp,
  locate,
  readClipboard,
  run,
  startRecording,
  writeClipboard,
} from './harness.mjs';

const REAL_PORT = 3579;
const realLibrary = join(homedir(), 'figma-drop');
const proofDir = join(repoDir, 'proof/renderer');
const scratchBase = resolve(process.env.FIGMA_DROP_PROOF_SCRATCH ?? tmpdir());
const ffmpeg = process.env.FIGMA_DROP_PROOF_FFMPEG;
const osEffects = process.env.FIGMA_DROP_PROOF_OS_EFFECTS === '1';

const log = createLog();
const scratch = await mkdtemp(join(scratchBase, 'figma-drop-renderer-'));
const paths = {
  userData: join(scratch, 'user-data'),
  library: join(scratch, 'library'),
  port: await freePort(),
};
const { port, library } = paths;
const settingsPath = join(paths.userData, 'settings.json');
const realLibraryBefore = existsSync(realLibrary) ? statSync(realLibrary).mtimeMs : null;
const session = new Session(paths);
const portsSeen = new Set();
const trashed = [];

function insideScratch(path) {
  const full = resolve(path);
  assert(full.startsWith(scratch + sep), `${full} is outside the scratch directory`);
  assert(full !== realLibrary && !full.startsWith(realLibrary + sep), 'never the real library');
  return full;
}

insideScratch(library);
insideScratch(paths.userData);
assert(port !== REAL_PORT, 'never the real receiver port');

const clipboardBefore = osEffects ? await readClipboard() : null;

const canaryHits = [];
const canary = createHttpServer((request, response) => {
  canaryHits.push(request.url);
  response.writeHead(204).end();
});
await new Promise((ready) => canary.listen(0, '127.0.0.1', ready));
const canaryPort = canary.address().port;

let failures = 0;
const unverified = [];

async function check(id, label, verify) {
  try {
    await verify();
    log.write(`PASS ${id} ${label}`);
  } catch (error) {
    failures += 1;
    log.write(`FAIL ${id} ${label}`);
    log.write(`  ${error.message.split('\n')[0].slice(0, 400)}`);
    await session
      .screenshot(join(scratchBase, `figma-drop-renderer-fail-${id}.png`))
      .catch(() => {});
  }
}

function notProven(id, label, reason) {
  unverified.push(id);
  log.write(`UNVERIFIED ${id} ${label}`);
  log.write(`  ${reason}`);
}

async function send(route, body, headers = {}) {
  const response = await fetch(`http://localhost:${port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'null', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function sync(body) {
  const reply = await send('/sync', body);
  assert(reply.status === 200, `POST /sync replied ${reply.status} ${JSON.stringify(reply.body)}`);
  return reply.body;
}

async function pressTab(options) {
  await session.press('Tab', options);
  return session.focus();
}

const hook = (expression) => session.app.hook(expression);
const status = () => hook('receiverStatus()');
const trayItem = async (id) => (await hook('tray()')).items.find((item) => item.id === id);
const persisted = async () => JSON.parse(await readFile(settingsPath, 'utf8'));
const bundleOf = (revision) => revision.bundlePath;
const revisionDirOf = (revision) => dirname(bundleOf(revision));

function revisionIds({ projects }) {
  const ids = projects.flatMap(({ nodes }) => nodes.flatMap((node) => node.revisions));
  return ids
    .map(({ id }) => id)
    .toSorted()
    .join();
}

function projectOf(snapshot, fileKey) {
  const project = snapshot.projects.find((candidate) => candidate.fileKey === fileKey);
  assert(project, `no project for ${fileKey}`);
  return project;
}

function nodeOf(snapshot, fileKey, figmaNodeId) {
  const node = projectOf(snapshot, fileKey).nodes.find((n) => n.figmaNodeId === figmaNodeId);
  assert(node, `no node ${figmaNodeId} in ${fileKey}`);
  return node;
}

async function sidebarSettled() {
  await waitUntil(async () => {
    const { projects } = await session.snapshot();
    const rows = await session.eval(`${locate.rows}.map((row) => row.textContent)`);
    return (
      rows.length === projects.length + 1 &&
      projects.every((project, index) => rows[index].startsWith(project.fileName.slice(0, 20)))
    );
  }, 'the sidebar matching the library');
}

async function openProject(row, heading) {
  await sidebarSettled();
  await session.click(locate.row(row));
  await waitUntil(
    async () => (await session.eval(`document.querySelector('main h1')?.title`)) === heading,
    `project heading "${heading}"`,
  );
}

async function openNode(name) {
  await session.click(locate.cardNamed(name));
  await waitUntil(
    async () => (await session.eval(`document.querySelector('aside h2')?.textContent`)) === name,
    `detail for "${name}"`,
  );
}

async function imageLoaded(locator) {
  return waitUntil(
    () =>
      session.eval(`(() => {
        const image = ${locator};
        return image?.complete && image.naturalWidth > 0
          ? { width: image.naturalWidth, src: image.src }
          : null;
      })()`),
    `a loaded image at ${locator}`,
  );
}

// CDP screenshots come back in the display's colour space, so exact sRGB values shift.
function assertColor(actual, expected, what) {
  assert(
    nearestColor(actual) === expected,
    `${what} painted ${actual}, expected about ${expected}`,
  );
}

async function digestTree(root) {
  const lines = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const hash = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
    lines.push(`${file} ${hash}`);
  }
  return lines.toSorted().join('\n');
}

async function recordPorts() {
  for (const seen of await session.app.listeningPorts()) portsSeen.add(seen);
}

async function waitListening() {
  const live = await waitUntil(async () => {
    const current = await status();
    return current.state === 'listening' && current;
  }, 'a listening receiver');
  await session.waitText(`Listening on port ${port}`);
  return live;
}

async function confirmTrash(expectedCopy) {
  await session.click(locate.button('Move to Trash'));
  await session.waitFor(locate.dialog, 'the Trash dialog');
  const copy = await session.eval(`${locate.dialog}.innerText`);
  assert(copy.includes(expectedCopy), `dialog says: ${copy}`);
  await session.click(locate.button('Move to Trash', locate.dialog));
}

const RECEIVER_SECTION = `document.querySelector('section[aria-label=Receiver]')`;
const FILE_ONE = { fileKey: 'ZqSyntheticFileOne0001', fileName: 'Synthetic Untitled' };
const FILE_TWO = { fileKey: 'KmSyntheticFileTwo0002', fileName: 'Synthetic Untitled' };
const TWIN_A = { fileKey: 'SharedPrefix-A-Synthetic', fileName: 'Synthetic Twin' };
const TWIN_B = { fileKey: 'SharedPrefix-B-Synthetic', fileName: 'Synthetic Twin' };
const HISTORY = { fileKey: 'HxSyntheticHistory0003', fileName: 'Synthetic History' };
const NAMES = { fileKey: 'NmSyntheticNames0004', fileName: 'Synthetic 日本語 ñandú 🎨' };
const LONG_NAME = `Synthetic ${'very long name '.repeat(20)}`.trim();
const LONG_FILE = { fileKey: 'LgSyntheticLong0005', fileName: LONG_NAME };
const BLANK_FILE = { fileKey: 'BlSyntheticBlank0006', fileName: '' };
const PREVIEWS = { fileKey: 'PvSyntheticPreviews0007', fileName: 'Synthetic Previews' };
const STALE = { fileKey: 'StSyntheticStale0008', fileName: 'Synthetic Stale' };
const FRAGILE = { fileKey: 'FrSyntheticFragile0009', fileName: 'Synthetic Fragile' };
const DAMAGE = { fileKey: 'DmSyntheticDamage0010', fileName: 'Synthetic Damage' };
const DEMO = { fileKey: 'DeSyntheticDemo0011', fileName: 'Synthetic Demo' };
const SENTINEL = { fileKey: 'SnSyntheticSentinel0012', fileName: 'Synthetic Sentinel' };

let sentinelCount = 0;

async function sentinel() {
  sentinelCount += 1;
  const nodeName = `Synthetic Sentinel ${sentinelCount}`;
  await sync(exportBody({ ...SENTINEL, nodeId: `9:${sentinelCount}`, nodeName }));
  await waitUntil(
    async () =>
      (await session.eval(`${locate.row('Synthetic Sentinel')}?.textContent`))?.endsWith(
        String(sentinelCount),
      ),
    `sentinel ${sentinelCount} on screen`,
  );
  return nodeName;
}

async function emptyAndIngest() {
  await check('1a', 'an empty library shows the empty state', async () => {
    await session.waitText('No exports yet');
    const text = await session.text();
    assert(text.includes('None yet'), `sidebar says: ${text}`);
    assert((await session.eval('document.images.length')) === 0, 'no images in an empty library');
  });

  await check('1b', 'the receiver text agrees with figmaDropTest.receiverStatus()', async () => {
    const live = await waitListening();
    assert(live.port === port, `status port ${live.port}, test port ${port}`);
    assert(
      (await session.eval(`${locate.switch}.getAttribute('aria-checked')`)) === 'true',
      'switch reads on',
    );
    const tray = await trayItem('status');
    assert(tray.label === `Receiver listening on port ${port}`, `tray says ${tray.label}`);
  });

  await check('1c', 'an empty library with the receiver off offers to turn it on', async () => {
    await session.click(locate.switch);
    await session.waitText('The receiver is off');
    await session.click(locate.button('Turn on receiver'));
    await waitListening();
    await session.waitText('No exports yet');
  });

  await check('2a', 'a POSTed export appears with no reload', async () => {
    await session.eval(`window.proofSameDocument = true`);
    await sync(
      exportBody({
        ...FILE_ONE,
        nodeId: '1:1',
        nodeName: 'Synthetic Card One',
        png: solidPng(64, 48, RED),
      }),
    );
    await session.waitFor(locate.card('Synthetic Card One'));
    assert(await session.eval('window.proofSameDocument === true'), 'the page reloaded');
  });

  await check('2b', 'two files with one display name stay two tellable groups', async () => {
    await sync(
      exportBody({
        ...FILE_TWO,
        nodeId: '1:1',
        nodeName: 'Synthetic Card Two',
        png: solidPng(64, 48, BLUE),
      }),
    );
    const hintOne = FILE_ONE.fileKey.slice(0, 8);
    const hintTwo = FILE_TWO.fileKey.slice(0, 8);
    await session.waitFor(locate.row(hintOne));
    await session.waitFor(locate.row(hintTwo));
    const rows = await session.eval(`${locate.rows}.map((row) => row.textContent)`);
    assert(rows.filter((row) => row.includes('Synthetic Untitled')).length === 2, rows.join(' | '));
    await openProject(hintOne, 'Synthetic Untitled');
    await session.waitFor(locate.card('Synthetic Card One'));
    assert((await session.text()).includes(FILE_ONE.fileKey), 'full key shown for file one');
    assert(!(await session.exists(locate.card('Synthetic Card Two'))), 'groups stayed apart');
    await openProject(hintTwo, 'Synthetic Untitled');
    await session.waitFor(locate.card('Synthetic Card Two'));
    assert((await session.text()).includes(FILE_TWO.fileKey), 'full key shown for file two');
    assert(!(await session.exists(locate.card('Synthetic Card One'))), 'groups stayed apart');
  });

  await check('2c', 'two same-named files whose keys share a prefix stay tellable', async () => {
    await sync(exportBody({ ...TWIN_A, nodeId: '1:1', nodeName: 'Synthetic Twin Card A' }));
    await sync(exportBody({ ...TWIN_B, nodeId: '1:1', nodeName: 'Synthetic Twin Card B' }));
    const rows = await waitUntil(async () => {
      const seen = await session.eval(
        `${locate.rows}.map((row) => row.textContent).filter((text) => text.includes('Synthetic Twin'))`,
      );
      return seen.length === 2 && seen;
    }, 'both twin rows');
    assert(rows[0] !== rows[1], `sidebar rows read the same: "${rows[0]}" and "${rows[1]}"`);
    const clipped = await session.eval(
      `[...document.querySelectorAll('nav [title^="SharedPrefix"]')].filter((hint) => hint.scrollWidth > hint.clientWidth).length`,
    );
    assert(clipped === 0, `${clipped} hint(s) clipped back to the shared part`);
  });

  await check('2d', 'every fallback form lands in Unidentified, never a group', async () => {
    const before = await session.snapshot();
    const fallbacks = [
      { fileKey: undefined, fileName: 'Synthetic Missing Key File', nodeName: 'Synthetic Missing' },
      { fileKey: '', fileName: 'Synthetic Empty Key File', nodeName: 'Synthetic Empty' },
      { fileKey: 'current', fileName: '', nodeName: 'Synthetic Literal Current' },
      {
        fileKey: 'Synthetic Named Fallback',
        fileName: 'Synthetic Named Fallback',
        nodeName: 'Synthetic Name Equals Key',
      },
    ];
    for (const [index, fallback] of fallbacks.entries()) {
      await sync(exportBody({ nodeId: `8:${index}`, png: solidPng(40, 40, GREEN), ...fallback }));
    }
    await session.waitFor(locate.row('Unidentified'));
    await waitUntil(
      async () => (await session.eval(`${locate.row('Unidentified')}.textContent`)).endsWith('4'),
      'an Unidentified count of 4',
    );
    const after = await session.snapshot();
    assert(after.projects.length === before.projects.length, 'no project gained');
    assert(after.unidentified.length === 4, `${after.unidentified.length} entries`);
    await session.click(locate.row('Unidentified'));
    for (const { nodeName } of fallbacks) await session.waitFor(locate.card(nodeName));
    const sidebar = await session.eval(`document.querySelector('nav').textContent`);
    assert(!/Synthetic (Missing|Empty|Named|Literal)/.test(sidebar), `sidebar has ${sidebar}`);
    await session.click(locate.card('Synthetic Literal Current'));
    await session.waitText('Claimed key');
    const detail = await session.eval(`document.querySelector('aside').innerText`);
    assert(detail.includes('current'), `detail says ${detail}`);
    assert(!detail.includes('History'), 'an unidentified entry has no history');
    assert(
      (
        await session.eval(`[...document.querySelectorAll('aside dd')].map((d) => d.textContent)`)
      ).every(Boolean),
      'no blank fact',
    );
  });
  await session.screenshot(join(proofDir, 'after-unidentified.png'));

  await check('2e', 'A/B/A keeps three revisions', async () => {
    const node = { ...HISTORY, nodeId: '2:1', nodeName: 'Synthetic History Node' };
    await sync(exportBody({ ...node, png: solidPng(64, 48, RED) }));
    await sync(exportBody({ ...node, png: solidPng(96, 48, BLUE) }));
    await sync(exportBody({ ...node, png: solidPng(64, 48, RED) }));
    await session.waitFor(locate.row('Synthetic History'));
    await openProject('Synthetic History', 'Synthetic History');
    await waitUntil(
      async () =>
        (await session.eval(`${locate.card('Synthetic History Node')}?.textContent`))?.includes(
          '3 revisions',
        ),
      'a card reading 3 revisions',
    );
    await openNode('Synthetic History Node');
    assert((await session.eval(`${locate.history}.length`)) === 3, 'three history rows');
  });

  await check('2f', 'a repeat adds no revision, by hash and with a new exportedAt', async () => {
    const before = await session.snapshot();
    const latest = nodeOf(before, HISTORY.fileKey, '2:1').revisions[0];
    const node = { ...HISTORY, nodeId: '2:1', nodeName: 'Synthetic History Node' };
    const repeat = exportBody({ ...node, png: solidPng(64, 48, RED) });
    const first = await sync(repeat);
    const second = await sync(repeat);
    assert(first.path === latest.bundlePath, `reply ${first.path}`);
    assert(second.path === latest.bundlePath, `exact repeat reply ${second.path}`);
    const name = await sentinel();
    const after = await session.snapshot();
    assert(nodeOf(after, HISTORY.fileKey, '2:1').revisions.length === 3, 'still three revisions');
    assert((await session.eval(`${locate.history}.length`)) === 3, 'still three history rows');
    assert(nodeOf(after, SENTINEL.fileKey, '9:1').name === name, 'the sentinel landed');
  });

  await check('2g', 'non-ASCII, dot-dot, case-pair, and long names all render', async () => {
    const hostile = ['Synthetic 日本語 ñandú 🎨', '..', '../../Synthetic', LONG_NAME];
    for (const [index, nodeName] of hostile.entries()) {
      await sync(exportBody({ ...NAMES, nodeId: `3:${index}`, nodeName }));
    }
    await sync(exportBody({ ...NAMES, nodeId: '3:10', nodeName: 'Synthetic Case' }));
    await sync(exportBody({ ...NAMES, nodeId: '3:11', nodeName: 'SYNTHETIC CASE' }));
    await sync(exportBody({ ...LONG_FILE, nodeId: '3:20', nodeName: 'Synthetic In Long File' }));
    await session.waitFor(locate.row(NAMES.fileName));
    await openProject(NAMES.fileName, NAMES.fileName);
    await waitUntil(
      async () => (await session.eval(`${locate.cards}.length`)) === 6,
      'six cards, none merged',
    );
    const titles = await session.eval(
      `${locate.cards}.map((card) => card.querySelector('[title]').title)`,
    );
    for (const name of [...hostile, 'Synthetic Case', 'SYNTHETIC CASE']) {
      assert(titles.includes(name), `no card titled ${name.slice(0, 40)}`);
    }
    await openNode(LONG_NAME);
    const overflow = await session.eval(`(() => {
      const main = document.querySelector('main');
      const aside = document.querySelector('aside');
      const h2 = aside.querySelector('h2');
      return {
        page: document.documentElement.scrollWidth > innerWidth,
        main: main.scrollWidth > main.clientWidth,
        aside: aside.scrollWidth > aside.clientWidth,
        titleInside: h2.getBoundingClientRect().right <= aside.getBoundingClientRect().right,
      };
    })()`);
    assert(!overflow.page && !overflow.main && !overflow.aside, JSON.stringify(overflow));
    assert(overflow.titleInside, 'long title stays inside the pane');
    await openNode('..');
    await session.waitText('3:1');
  });

  await check('2h', 'a real key with an empty file name still gets a named row', async () => {
    await sync(exportBody({ ...BLANK_FILE, nodeId: '3:30', nodeName: 'Synthetic In Blank File' }));
    await session.waitFor(locate.row('Synthetic Sentinel'));
    const project = await waitUntil(async () => {
      const snapshot = await session.snapshot();
      return snapshot.projects.find((p) => p.fileKey === BLANK_FILE.fileKey);
    }, 'the blank-name project');
    await session.waitFor(locate.row(project.fileName));
    assert(project.fileName.trim() !== '', 'a non-empty display name');
    await openProject(project.fileName, project.fileName);
    await session.waitFor(locate.card('Synthetic In Blank File'));
  });
}

async function previews() {
  await check('3a', 'a real PNG preview loads and paints', async () => {
    await sync(
      exportBody({
        ...PREVIEWS,
        nodeId: '4:1',
        nodeName: 'Synthetic Png',
        png: solidPng(64, 48, RED),
      }),
    );
    await session.waitFor(locate.row('Synthetic Previews'));
    await openProject('Synthetic Previews', 'Synthetic Previews');
    await openNode('Synthetic Png');
    const large = await imageLoaded(locate.largeImage);
    assert(large.width === 64, `naturalWidth ${large.width}`);
    assert(large.src.startsWith('figma-drop-preview://'), `src ${large.src}`);
    await imageLoaded(`${locate.card('Synthetic Png')}.querySelector('img')`);
    assertColor(await session.paintedColor(locate.largeImage), RED, 'the PNG preview');
  });

  await check('3b', 'a real SVG preview loads and paints', async () => {
    await sync(
      exportBody({
        ...PREVIEWS,
        nodeId: '4:2',
        nodeName: 'Synthetic Svg',
        svg: plainSvg(120, 80, '#2850dc'),
      }),
    );
    await session.waitFor(locate.card('Synthetic Svg'));
    await openNode('Synthetic Svg');
    const large = await imageLoaded(locate.largeImage);
    assert(large.width === 120, `naturalWidth ${large.width}`);
    assertColor(await session.paintedColor(locate.largeImage), BLUE, 'the SVG preview');
  });

  await check('3c', 'an SVG that carries a <style> block still paints it', async () => {
    await sync(
      exportBody({ ...PREVIEWS, nodeId: '4:3', nodeName: 'Synthetic Styled', svg: styledSvg() }),
    );
    await session.waitFor(locate.card('Synthetic Styled'));
    await openNode('Synthetic Styled');
    await imageLoaded(locate.largeImage);
    assertColor(await session.paintedColor(locate.largeImage), TEAL, 'the styled SVG');
  });

  await check('3d', 'a scripted SVG renders as an inert image in the app', async () => {
    await sync(
      exportBody({
        ...PREVIEWS,
        nodeId: '4:4',
        nodeName: 'Synthetic Hostile',
        svg: hostileSvg(canaryPort),
      }),
    );
    await session.waitFor(locate.card('Synthetic Hostile'));
    await openNode('Synthetic Hostile');
    await imageLoaded(locate.largeImage);
    assertColor(await session.paintedColor(locate.largeImage), GREEN, 'the hostile SVG');
    const dom = await session.eval(`({
      active: document.querySelectorAll('iframe, object, embed, svg script, foreignObject').length,
      title: document.title,
      tag: ${locate.largeImage}.tagName,
    })`);
    assert(dom.active === 0, `${dom.active} active elements in the page`);
    assert(dom.tag === 'IMG', `preview is a ${dom.tag}`);
    assert(dom.title === 'figma-drop', `title is ${dom.title}`);
    assert(canaryHits.length === 0, `canary saw ${canaryHits.join(', ')}`);
  });

  await check('3e', 'an export with no preview shows the no-preview state', async () => {
    await sync(exportBody({ ...PREVIEWS, nodeId: '4:5', nodeName: 'Synthetic Bare' }));
    await session.waitFor(locate.card('Synthetic Bare'));
    await openNode('Synthetic Bare');
    await session.waitText('No preview in this export');
    assert(
      (await session.eval(`${locate.card('Synthetic Bare')}.textContent`)).includes('No preview'),
      'the card says no preview',
    );
    assert(!(await session.exists(locate.largeImage)), 'no large image');
  });
}

async function history() {
  await openProject('Synthetic History', 'Synthetic History');
  await openNode('Synthetic History Node');
  const snapshot = await session.snapshot();
  const [latest, older] = nodeOf(snapshot, HISTORY.fileKey, '2:1').revisions;

  await check('4a', 'picking an older revision changes the painted image', async () => {
    const before = await imageLoaded(locate.largeImage);
    assert(before.width === 64, `latest width ${before.width}`);
    assertColor(await session.paintedColor(locate.largeImage), RED, 'the latest revision');
    await session.click(locate.historyRow(1));
    await session.waitText('Actions apply to the older revision');
    const after = await imageLoaded(locate.largeImage);
    assert(after.src !== before.src, 'the image source changed');
    assert(after.src.endsWith(older.id), `src ${after.src}, older ${older.id}`);
    assert(after.width === 96, `older width ${after.width}`);
    assertColor(await session.paintedColor(locate.largeImage), BLUE, 'the older revision');
  });
  await session.screenshot(join(proofDir, 'after-history.png'));

  if (!osEffects) {
    notProven('4b', 'Copy path targets the picked revision', 'OS effects are off for this run');
    notProven('5a', 'Copy path reaches the system clipboard', 'OS effects are off for this run');
    notProven('5b', 'Reveal in Finder', 'OS effects are off for this run');
    notProven('5c', 'Trash of one revision of three', 'OS effects are off for this run');
    return;
  }

  await check('4b', 'Copy path acts on the picked revision, not the latest', async () => {
    await session.click(locate.button('Copy path'));
    await session.waitText('Path copied');
    const copied = await readClipboard();
    assert(copied === bundleOf(older), `clipboard holds ${copied}`);
    assert(copied !== bundleOf(latest), 'clipboard holds the latest');
    insideScratch(copied);
  });

  await check('5a', 'Copy path reaches the real system clipboard for the latest', async () => {
    await session.click(locate.historyRow(0));
    await session.waitText('Actions apply to the latest revision');
    await session.click(locate.button('Copy path'));
    await waitUntil(async () => (await readClipboard()) === bundleOf(latest), 'clipboard update');
    await session.waitText('Path copied');
  });

  await check('5b', 'Reveal in Finder hands off to Finder and reports it', async () => {
    const before = await frontApp();
    await session.click(locate.button('Reveal in Finder'));
    await session.waitText('Shown in Finder');
    if (before.pid === session.app.child.pid) {
      await waitUntil(async () => (await frontApp()).name === 'Finder', 'Finder in front');
    } else {
      notProven(
        '5b-front',
        'Finder came to the front',
        `${before.name} (pid ${before.pid}) held the front already`,
      );
    }
    await hook(`clickTray('open')`);
    await waitUntil(async () => (await hook('windows()'))[0].focused, 'the window focused again');
  });

  await check('5c', 'Trash of one revision of three keeps the node and focus', async () => {
    await session.click(locate.historyRow(1));
    await session.waitText('Actions apply to the older revision');
    const directory = insideScratch(revisionDirOf(older));
    await confirmTrash('Other revisions stay in the library.');
    await session.waitText('Moved to Trash');
    await waitUntil(async () => (await session.eval(`${locate.history}.length`)) === 2, 'two rows');
    trashed.push(basename(directory));
    assert(!existsSync(directory), 'the revision left the library');
    assert(existsSync(revisionDirOf(latest)), 'the latest revision stayed');
    await session.waitText('Actions apply to the latest revision');
    await waitUntil(async () => (await session.focus()).region !== 'body', 'focus held');
    assert((await session.focus()).region === 'grid', 'focus moved to the grid');
  });
}

async function staleAndFailed() {
  const nodes = [
    { nodeId: '5:1', nodeName: 'Synthetic Vanishing Copy' },
    { nodeId: '5:2', nodeName: 'Synthetic Vanishing Trash' },
  ];
  for (const node of nodes) {
    await sync(exportBody({ ...STALE, ...node, png: solidPng(40, 40, GREEN) }));
  }
  await sync(
    exportBody({
      ...FRAGILE,
      nodeId: '5:9',
      nodeName: 'Synthetic Fragile Node',
      png: solidPng(40, 40, RED),
    }),
  );
  await session.waitFor(locate.row('Synthetic Stale'));
  await session.waitFor(locate.row('Synthetic Fragile'));

  await check(
    '5d',
    'a revision removed behind the app reads as missing and leaves the UI',
    async () => {
      await openProject('Synthetic Stale', 'Synthetic Stale');
      await openNode('Synthetic Vanishing Copy');
      const snapshot = await session.snapshot();
      const revision = nodeOf(snapshot, STALE.fileKey, '5:1').revisions[0];
      await rm(insideScratch(revisionDirOf(revision)), { recursive: true });
      await session.click(locate.button('Copy path'));
      await session.waitText("That revision's files are missing.");
      await waitUntil(
        async () => !(await session.exists(locate.card('Synthetic Vanishing Copy'))),
        'the card leaving',
      );
      await session.waitFor(locate.card('Synthetic Vanishing Trash'));
      assert(!(await session.exists(locate.button('Retry'))), 'no Retry for a gone revision');
    },
  );

  await check(
    '5e',
    'Trash of a vanished revision reports gone and empties the project',
    async () => {
      await openNode('Synthetic Vanishing Trash');
      const snapshot = await session.snapshot();
      const revision = nodeOf(snapshot, STALE.fileKey, '5:2').revisions[0];
      await rm(insideScratch(revisionDirOf(revision)), { recursive: true });
      await confirmTrash("It's the only revision, so this node leaves the library.");
      await session.waitText('That revision is already gone');
      await waitUntil(
        async () => !(await session.exists(locate.row('Synthetic Stale'))),
        'the project row leaving',
      );
      assert(!(await session.exists(locate.alert)), 'no failure alert');
      assert((await session.focus()).region !== 'body', 'focus not lost to body');
    },
  );

  await check('5f', 'a failed command shows an alert, Retry, and Dismiss', async () => {
    await openProject('Synthetic Fragile', 'Synthetic Fragile');
    await openNode('Synthetic Fragile Node');
    const snapshot = await session.snapshot();
    const bundle = insideScratch(bundleOf(nodeOf(snapshot, FRAGILE.fileKey, '5:9').revisions[0]));
    const moved = `${bundle}.moved`;
    await rename(bundle, moved);
    await writeFile(bundle, 'Synthetic stand-in where the bundle folder was');
    try {
      await session.click(locate.button('Reveal in Finder'));
      await session.waitFor(locate.alert, 'the failure alert');
      assert(
        (await session.eval(`${locate.alert}.innerText`)).includes("Couldn't reveal in Finder"),
        'the alert names the action',
      );
      await session.click(locate.button('Retry'));
      await session.waitFor(locate.alert, 'the alert again after a failing Retry');
      await session.click(locate.button('Dismiss'));
      await waitUntil(async () => !(await session.exists(locate.alert)), 'the alert dismissed');
      await session.click(locate.button('Copy to folder').replace('Copy to folder', 'Copy path'));
      await session.waitFor(locate.alert, 'a second failure');
    } finally {
      await rm(bundle);
      await rename(moved, bundle);
    }
    if (!osEffects) return;
    await session.click(locate.button('Retry'));
    await session.waitText('Path copied');
    assert(!(await session.exists(locate.alert)), 'Retry cleared the alert');
  });

  await check('5g', 'Copy to folder is offered on a healthy revision', async () => {
    assert(await session.exists(locate.button('Copy to folder')), 'the button exists');
    assert(
      (await session.eval(`${locate.button('Copy to folder')}.getAttribute('aria-disabled')`)) ===
        null,
      'it is enabled',
    );
  });
  notProven(
    '5h',
    'Copy to folder through the native dialog',
    'dialog.showOpenDialog has no injected seam and CDP cannot drive a native sheet',
  );
}

async function keyboard() {
  await openProject('Synthetic Previews', 'Synthetic Previews');
  await openNode('Synthetic Png');

  await check('10a', 'Tab reaches the sidebar, receiver, grid, detail, and history', async () => {
    await session.eval('document.activeElement.blur()');
    const order = [];
    for (let presses = 0; presses < 14; presses += 1) {
      const { region, outline } = await pressTab();
      assert(region !== 'body' && region !== 'other', `Tab ${presses + 1} landed on ${region}`);
      assert(outline === 'solid', `no visible focus ring on ${region}`);
      if (order.at(-1) !== region) order.push(region);
    }
    // `blur()` keeps Chromium's sequential start point, so the walk starts mid-cycle.
    const start = order.indexOf('sidebar');
    const cycle = [...order.slice(start), ...order.slice(0, start)].slice(0, 5);
    const expected = ['sidebar', 'receiver', 'grid', 'detail', 'history'];
    assert(
      expected.every((region, index) => cycle[index] === region),
      `order was ${order.join(' > ')}`,
    );
  });

  await check('10b', 'Shift+Tab walks back', async () => {
    await session.eval('document.activeElement.blur()');
    await pressTab();
    const first = await session.focus();
    await pressTab();
    const second = await session.focus();
    assert(second.region !== first.region || second.text !== first.text, 'Tab moved');
    const back = await pressTab({ shift: true });
    assert(back.text === first.text, `Shift+Tab landed on ${back.text}`);
  });

  await check('10c', 'arrows move focus through the grid and Enter selects', async () => {
    await session.eval(`${locate.card('Synthetic Png')}.focus()`);
    const start = await session.focus();
    await session.press('Home');
    const home = await session.focus();
    await session.press('ArrowRight');
    const right = await session.focus();
    assert(right.region === 'grid' && right.text !== home.text, `ArrowRight on ${right.text}`);
    const selectedBefore = await session.eval(`document.querySelector('aside h2').textContent`);
    await session.press('Enter');
    await waitUntil(
      async () =>
        (await session.eval(`document.querySelector('aside h2').textContent`)) !== selectedBefore ||
        right.text.includes(selectedBefore),
      'Enter selecting the focused card',
    );
    assert(
      right.text.includes(await session.eval(`document.querySelector('aside h2').textContent`)),
      'detail follows Enter',
    );
    assert(
      (await session.eval(`document.activeElement.getAttribute('aria-selected')`)) === 'true',
      'the focused card is selected',
    );
    await session.press('ArrowLeft');
    await session.press(' ');
    await waitUntil(
      () => session.eval(`document.activeElement.getAttribute('aria-selected') === 'true'`),
      'Space selecting',
    );
    assert(start.region === 'grid', 'started in the grid');
  });

  await check('10d', 'arrows and Enter move between sidebar rows', async () => {
    await session.eval(`${locate.row('Synthetic Previews')}.focus()`);
    await session.press('End');
    const last = await session.focus();
    assert(last.text.startsWith('Unidentified'), `End landed on ${last.text}`);
    await session.press('Enter');
    await waitUntil(
      async () =>
        (await session.eval(`document.querySelector('main h1')?.title`)) === 'Unidentified',
      'the Unidentified inbox',
    );
    await session.press('ArrowUp');
    const up = await session.focus();
    assert(up.region === 'sidebar' && !up.text.startsWith('Unidentified'), `ArrowUp on ${up.text}`);
  });

  await openProject('Synthetic Previews', 'Synthetic Previews');
  await openNode('Synthetic Png');

  await check('10e', 'the Trash dialog traps focus and Escape cancels', async () => {
    const before = await session.snapshot();
    await session.eval(`${locate.button('Move to Trash')}.focus()`);
    await session.press('Enter');
    await session.waitFor(locate.dialog, 'the dialog');
    const opened = await session.focus();
    assert(opened.region === 'dialog' && opened.text === 'Cancel', `opened on ${opened.text}`);
    const seen = new Set();
    for (let presses = 0; presses < 6; presses += 1) {
      const { region, text } = await pressTab({ shift: presses % 3 === 2 });
      assert(region === 'dialog', `Tab ${presses + 1} left the dialog for ${region}`);
      seen.add(text);
    }
    assert(seen.has('Cancel') && seen.has('Move to Trash'), `saw ${[...seen].join(', ')}`);
    await session.press('Escape');
    await waitUntil(async () => !(await session.exists(locate.dialog)), 'the dialog closing');
    const after = await session.focus();
    assert(after.text === 'Move to Trash', `focus returned to ${after.region}/${after.text}`);
    const now = await session.snapshot();
    assert(
      nodeOf(now, PREVIEWS.fileKey, '4:1').revisions.length ===
        nodeOf(before, PREVIEWS.fileKey, '4:1').revisions.length,
      'Escape trashed nothing',
    );
  });
}

async function look() {
  const dragCheck = `(() => {
    const dragAt = (x, y) => {
      const element = document.elementFromPoint(x, y);
      return element && getComputedStyle(element).webkitAppRegion === 'drag';
    };
    const xs = [8, 40, 76, 200, innerWidth / 2, innerWidth - 200, innerWidth - 8];
    const undraggable = xs.flatMap((x) => [8, 20, 34].filter((y) => !dragAt(x, y)).map((y) => [x, y]));
    const focusable = [...document.querySelectorAll('button, [tabindex]')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.height > 0 && rect.top < 38 && element.tagName !== 'H2' && element.tagName !== 'MAIN';
      })
      .map((element) => element.outerHTML.slice(0, 80));
    return { undraggable, focusable };
  })()`;
  const layoutCheck = `(() => {
    const aside = document.querySelector('aside');
    const main = document.querySelector('main');
    const nav = document.querySelector('nav');
    return {
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
      rights: [nav, main, aside].map((pane) => pane.getBoundingClientRect().right),
      mainWidth: main.getBoundingClientRect().width,
    };
  })()`;

  await openProject('Synthetic Previews', 'Synthetic Previews');
  await openNode('Synthetic Png');

  for (const [width, height] of [
    [1000, 640],
    [800, 560],
  ]) {
    await session.resize(width, height);
    for (const scheme of ['light', 'dark']) {
      await session.setColorScheme(scheme);
      await waitUntil(
        () => session.eval(`matchMedia('(prefers-color-scheme: ${scheme})').matches`),
        `${scheme} scheme`,
      );
      await check(
        `11-${width}-${scheme}`,
        `${width}x${height} ${scheme} fits and every action is reachable`,
        async () => {
          const layout = await session.eval(layoutCheck);
          assert(!layout.pageOverflow, 'the page overflows');
          assert(
            Math.max(...layout.rights) <= width,
            `a pane ends past the window: ${layout.rights}`,
          );
          assert(layout.mainWidth >= 200, `the grid is only ${layout.mainWidth}px wide`);
          for (const name of ['Reveal in Finder', 'Copy path', 'Copy to folder', 'Move to Trash']) {
            await session.eval(`${locate.button(name)}.scrollIntoView({ block: 'nearest' })`);
            const covered = await session.eval(`(() => {
            const element = ${locate.button(name)};
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return !element.contains(hit);
          })()`);
            assert(!covered, `${name} is covered once scrolled to`);
          }
        },
      );
      await session.screenshot(join(proofDir, `after-look-${width}x${height}-${scheme}.png`));
    }
  }

  await session.resize(1000, 640);
  await session.setColorScheme('dark');
  await session.screenshot(join(proofDir, 'after-dark.png'));
  await session.setColorScheme('light');
  await session.screenshot(join(proofDir, 'after-library.png'));

  await check('11a', 'the top strip is a drag region clear of every control', async () => {
    const { undraggable, focusable } = await session.eval(dragCheck);
    assert(undraggable.length === 0, `not draggable at ${JSON.stringify(undraggable)}`);
    assert(focusable.length === 0, `controls in the strip: ${focusable.join(' | ')}`);
  });

  const native = osEffects
    ? await session
        .nativeCapture(join(proofDir, 'after-traffic-lights.png'))
        .catch((error) => error)
    : new Error('OS effects are off for this run');
  if (native instanceof Error) {
    notProven(
      '11b',
      'traffic lights seen in a native capture',
      `${native.message.split('\n')[0]}. CDP screenshots omit native chrome`,
    );
  } else {
    log.write('PASS 11b native capture saved, read after-traffic-lights.png');
  }
  notProven(
    '11c',
    'dragging the strip moves the window',
    'CDP mouse events stop at the renderer, and an OS drag would take the real pointer',
  );
}

async function damaged() {
  const node = { ...DAMAGE, nodeId: '6:1', nodeName: 'Synthetic Damaged Node' };
  await sync(exportBody({ ...node, png: solidPng(40, 40, RED) }));
  await sync(exportBody({ ...node, png: solidPng(44, 40, BLUE) }));
  await sync(
    exportBody({
      ...DAMAGE,
      nodeId: '6:2',
      nodeName: 'Synthetic Damaged Solo',
      png: solidPng(40, 40, GREEN),
    }),
  );
  await sync(
    exportBody({
      fileKey: undefined,
      fileName: 'Synthetic Damaged Inbox File',
      nodeId: '6:3',
      nodeName: 'Synthetic Damaged Inbox',
      png: solidPng(40, 40, GREEN),
    }),
  );
  await session.waitFor(locate.row('Synthetic Damage'));
  const snapshot = await session.snapshot();
  const latest = nodeOf(snapshot, DAMAGE.fileKey, '6:1').revisions[0];
  const solo = nodeOf(snapshot, DAMAGE.fileKey, '6:2').revisions[0];
  const inbox = snapshot.unidentified.find((entry) => entry.name === 'Synthetic Damaged Inbox');
  assert(inbox, 'the inbox entry landed');
  const receipts = [latest, solo, inbox].map((revision) =>
    insideScratch(join(revisionDirOf(revision), 'receipt.json')),
  );
  const corrupt = '{ synthetic corrupted receipt';
  for (const receipt of receipts) await writeFile(receipt, corrupt);
  const digests = await Promise.all(
    [latest, solo, inbox].map((revision) => digestTree(revisionDirOf(revision))),
  );

  await check(
    '8a',
    'a corrupt receipt shows damaged on the card, detail, and history',
    async () => {
      await sentinel();
      await openProject('Synthetic Damage', 'Synthetic Damage');
      await waitUntil(
        async () =>
          (await session.eval(`${locate.card('Synthetic Damaged Node')}?.textContent`))?.startsWith(
            'Damaged',
          ),
        'a Damaged notice on the card after the next change',
      );
      await openNode('Synthetic Damaged Node');
      await session.waitText("This revision's receipt can't be read");
      const row = await session.eval(`${locate.historyRow(0)}.textContent`);
      assert(row.includes('Damaged') && row.includes('Latest'), `history row says ${row}`);
      assert(!(await session.exists(locate.largeImage)), 'no image for a damaged revision');
    },
  );

  await check('8b', 'a damaged revision hides Copy to folder and keeps the others', async () => {
    assert(!(await session.exists(locate.button('Copy to folder'))), 'Copy to folder hidden');
    for (const name of ['Reveal in Finder', 'Copy path', 'Move to Trash']) {
      assert(await session.exists(locate.button(name)), `${name} still offered`);
    }
    await session.click(locate.historyRow(1));
    await session.waitText('Actions apply to the older revision');
    await imageLoaded(locate.largeImage);
    assert(await session.exists(locate.button('Copy to folder')), 'healthy revision offers it');
  });

  await check(
    '8c',
    'a node with only a damaged revision still appears, with a readable name',
    async () => {
      await session.waitFor(locate.card('synthetic-damaged-solo'));
      await openNode('synthetic-damaged-solo');
      await session.waitText("This revision's receipt can't be read");
      assert(!(await session.exists(locate.button('Copy to folder'))), 'Copy to folder hidden');
    },
  );

  await check('8d', 'a damaged inbox entry shows damaged and hides Copy to folder', async () => {
    await session.click(locate.row('Unidentified'));
    await session.waitFor(locate.card('synthetic-damaged-inbox'));
    await openNode('synthetic-damaged-inbox');
    await session.waitText("This revision's receipt can't be read");
    assert(!(await session.exists(locate.button('Copy to folder'))), 'Copy to folder hidden');
  });

  await check('8e', 'the trash dialog names a damaged revision by its folder', async () => {
    await session.click(locate.button('Move to Trash'));
    await session.waitFor(locate.dialog, 'the dialog');
    const copy = await session.eval(`${locate.dialog}.innerText`);
    assert(copy.includes('bundle'), `dialog says ${copy}`);
    await session.press('Escape');
    await waitUntil(async () => !(await session.exists(locate.dialog)), 'the dialog closing');
  });

  await check('8f', 'the damaged revisions keep their files across a restart', async () => {
    await session.quit();
    await session.start();
    await session.waitFor(locate.row('Synthetic Damage'));
    await openProject('Synthetic Damage', 'Synthetic Damage');
    await session.waitFor(locate.card('Synthetic Damaged Node'));
    const after = await Promise.all(
      [latest, solo, inbox].map((revision) => digestTree(revisionDirOf(revision))),
    );
    assert(
      after.every((digest, index) => digest === digests[index]),
      'a file changed',
    );
    for (const receipt of receipts) {
      assert((await readFile(receipt, 'utf8')) === corrupt, 'the corrupt receipt was rewritten');
    }
  });
}

async function hold(host) {
  const server = createTcpServer();
  await new Promise((listening, failed) => {
    server.once('error', failed);
    server.listen(port, host, listening);
  });
  return server;
}

function release(server) {
  return new Promise((closed) => server.close(closed));
}

async function receiver() {
  await session.waitFor(locate.switch);

  await check('6a', 'the switch turns the receiver off and the socket really closes', async () => {
    await session.click(locate.switch);
    await session.waitText('Receiver off');
    await waitUntil(async () => (await status()).state === 'off', 'off status');
    assert(await refusesConnection('127.0.0.1', port), '127.0.0.1 refused');
    assert(await refusesConnection('::1', port), '::1 refused');
    assert((await persisted()).receiverEnabled === false, 'off persisted');
    const tray = await hook('tray()');
    const label = tray.items.find((item) => item.id === 'status').label;
    assert(label === 'Receiver off', `tray says ${label}`);
    assert(
      tray.items.find((item) => item.id === 'receiver-on').checked === false,
      'tray unchecked',
    );
    assert(
      (await session.eval(`${locate.switch}.getAttribute('aria-checked')`)) === 'false',
      'switch reads off',
    );
  });

  await check('6b', 'the switch turns it back on and exports land', async () => {
    await session.click(locate.switch);
    await waitListening();
    const name = await sentinel();
    assert((await trayItem('receiver-on')).checked === true, 'tray checked');
    assert((await session.snapshot()).projects.length > 0, `landed ${name}`);
  });

  await check('6c', 'the tray toggle updates the window', async () => {
    await hook(`clickTray('receiver-on')`);
    await session.waitText('Receiver off');
    assert(
      (await session.eval(`${locate.switch}.getAttribute('aria-checked')`)) === 'false',
      'switch followed the tray',
    );
    await hook(`clickTray('receiver-on')`);
    await waitListening();
  });

  await check('6d', 'off persists across a restart, and exports survive it', async () => {
    const before = await session.snapshot();
    await session.click(locate.switch);
    await session.waitText('Receiver off');
    await session.quit();
    await session.start();
    await session.waitText('Receiver off');
    assert((await status()).state === 'off', 'off after restart');
    assert(await refusesConnection('127.0.0.1', port), 'nothing listening after restart');
    assert((await trayItem('receiver-on')).checked === false, 'tray unchecked after restart');
    const after = await session.snapshot();
    assert(revisionIds(after) === revisionIds(before), 'the same revisions after restart');
    await session.click(locate.switch);
    await waitListening();
  });

  await check('6e', 'a taken port shows a visible conflict, and Try again recovers', async () => {
    await session.click(locate.switch);
    await session.waitText('Receiver off');
    const server = await hold('127.0.0.1');
    try {
      await session.click(locate.switch);
      await session.waitText(`Port ${port} is in use`);
      const live = await status();
      assert(live.state === 'port-conflict', `status ${JSON.stringify(live)}`);
      const sidebar = await session.eval(`${RECEIVER_SECTION}.innerText`);
      assert(sidebar.includes('Another app is using this port'), `sidebar says ${sidebar}`);
      assert(sidebar.includes(`pid ${process.pid}`), `no holder named: ${sidebar}`);
      const tray = await trayItem('status');
      assert(tray.label.startsWith(`Port ${port} is in use`), `tray says ${tray.label}`);
      await session.screenshot(join(proofDir, 'after-receiver-conflict.png'));
      await session.eval(`
        window.proofStatuses = [];
        window.figmaDrop.receiver.onStatus((next) => window.proofStatuses.push(next.state));
      `);
      await session.click(locate.button('Try again', RECEIVER_SECTION));
      await waitUntil(
        () =>
          session.eval(
            `proofStatuses.includes('starting') && proofStatuses.at(-1) === 'port-conflict'`,
          ),
        'a second conflict while the port stays held',
      );
      await session.waitFor(locate.button('Try again', RECEIVER_SECTION));
      assert(server.listening, 'the proof listener was left alone');
    } finally {
      await release(server);
    }
    await session.click(locate.button('Try again', RECEIVER_SECTION));
    await waitListening();
    await sentinel();
  });

  await check('6f', 'a holder on ::1 alone also conflicts and releases 127.0.0.1', async () => {
    await session.click(locate.switch);
    await session.waitText('Receiver off');
    const server = await hold('::1');
    try {
      await session.click(locate.switch);
      await session.waitText(`Port ${port} is in use`);
      assert(await refusesConnection('127.0.0.1', port), '127.0.0.1 released');
    } finally {
      await release(server);
    }
    await session.click(locate.button('Try again', RECEIVER_SECTION));
    await waitListening();
  });

  await check(
    '6g',
    'a receiver crash restarts on its own, then fails visibly and recovers',
    async () => {
      for (let crash = 1; crash <= 2; crash += 1) {
        const pid = await waitUntil(() => session.receiverChildPid(), 'the receiver child');
        process.kill(pid, 'SIGKILL');
        await waitUntil(async () => {
          const next = await session.receiverChildPid();
          return next && next !== pid && (await status()).state === 'listening';
        }, `recovery from crash ${crash}`);
      }
      await session.waitText(`Listening on port ${port}`);
      process.kill(await session.receiverChildPid(), 'SIGKILL');
      await session.waitText('Receiver problem');
      const live = await status();
      assert(live.state === 'failed', `status ${JSON.stringify(live)}`);
      assert((await trayItem('status')).label.startsWith('Receiver failed'), 'tray says failed');
      await session.click(locate.button('Try again', RECEIVER_SECTION));
      await waitListening();
    },
  );
  await recordPorts();
}

async function lifecycle() {
  let reply;

  await check(
    '9a',
    'a closed window keeps the receiver, and reopening shows what arrived',
    async () => {
      await session.closeWindow();
      assert(session.app.child.exitCode === null, 'the app stays alive');
      assert((await hook('tray()')).alive, 'the tray stays alive');
      reply = await sync(
        exportBody({
          ...FILE_ONE,
          nodeId: '7:1',
          nodeName: 'Synthetic While Closed',
          png: solidPng(40, 40, GREEN),
        }),
      );
      await session.reopenFromTray();
      await session.waitFor(locate.row('Synthetic Untitled'));
      await session.waitFor(locate.card('Synthetic While Closed'));
      await session.waitText(`Listening on port ${port}`);
      await imageLoaded(`${locate.card('Synthetic While Closed')}.querySelector('img')`);
    },
  );

  const focusedTitle = () =>
    session.eval(
      `document.activeElement.tagName === 'H2' ? document.activeElement.textContent : null`,
    );

  await check('9b', 'POST /open focuses the export in the open window', async () => {
    await openProject('Synthetic History', 'Synthetic History');
    const opened = await send('/open', { path: reply.path });
    assert(opened.status === 200, `POST /open replied ${opened.status}`);
    await waitUntil(
      async () => (await focusedTitle()) === 'Synthetic While Closed',
      'the export focused',
    );
    await session.waitText(FILE_ONE.fileKey);
  });

  await check('9c', 'POST /open selects an older revision by its path', async () => {
    const snapshot = await session.snapshot();
    const older = nodeOf(snapshot, HISTORY.fileKey, '2:1').revisions.at(-1);
    const opened = await send('/open', { path: bundleOf(older) });
    assert(opened.status === 200, `POST /open replied ${opened.status}`);
    await session.waitText('Actions apply to the older revision');
    assert(
      (await session.eval(`document.querySelector('main h1').title`)) === 'Synthetic History',
      'project',
    );
  });

  await check('9d', 'POST /open with a batch parent opens the project', async () => {
    const opened = await send('/open', { path: dirname(reply.path) });
    assert(opened.status === 200, `POST /open replied ${opened.status}`);
    await waitUntil(
      async () =>
        (await session.eval(`document.querySelector('main h1')?.title`)) === 'Synthetic Untitled',
      'the file one project',
    );
    await session.waitText(FILE_ONE.fileKey);
  });

  await check('9e', 'POST /open reaches an Unidentified entry', async () => {
    const snapshot = await session.snapshot();
    const entry = snapshot.unidentified.find((candidate) => candidate.name === 'Synthetic Missing');
    const opened = await send('/open', { path: bundleOf(entry) });
    assert(opened.status === 200, `POST /open replied ${opened.status}`);
    await waitUntil(
      async () => (await focusedTitle()) === 'Synthetic Missing',
      'the entry focused',
    );
    assert(
      (await session.eval(`document.querySelector('main h1').title`)) === 'Unidentified',
      'inbox',
    );
  });

  await check('9f', 'POST /open reopens a closed window onto the export', async () => {
    await session.closeWindow();
    const opened = await send('/open', { path: reply.path });
    assert(opened.status === 200, `POST /open replied ${opened.status}`);
    await session.attach();
    await waitUntil(
      async () => (await focusedTitle()) === 'Synthetic While Closed',
      'the export focused in the new window',
    );
  });

  await check('9g', 'POST /open refuses a path outside the library', async () => {
    const opened = await send('/open', { path: '/etc/hosts' });
    assert(opened.status === 404, `POST /open replied ${opened.status}`);
    assert(!JSON.stringify(opened.body).toLowerCase().includes('output folder'), 'error wording');
  });
}

async function degraded() {
  const root = insideScratch(library);
  const hide = () => chmod(root, 0o000);
  const restore = () => chmod(root, 0o755);

  if (osEffects) {
    await check('7a', 'coming back to an open window shows an unreadable library', async () => {
      await session.page.call('Emulation.setFocusEmulationEnabled', { enabled: false });
      await run('open', ['-a', 'Finder']);
      await waitUntil(
        async () => (await hook('windows()'))[0].focused === false,
        'the window losing focus',
      );
      await hide();
      try {
        await hook(`clickTray('open')`);
        await session.waitText("Can't open the library");
      } finally {
        await restore();
        await session.page.call('Emulation.setFocusEmulationEnabled', { enabled: true });
      }
      await session.click(locate.button('Try again'));
      await session.waitFor(locate.row('Synthetic Previews'));
    });
  } else {
    notProven('7a', 'coming back to an open window', 'OS effects are off for this run');
  }

  await check('7b', 'a reopened window shows the failed screen', async () => {
    await session.closeWindow();
    await hide();
    try {
      await session.reopenFromTray();
      await session.waitText("Can't open the library");
      await session.waitFor(locate.button('Try again'));
      await session.screenshot(join(proofDir, 'after-failed.png'));
    } catch (error) {
      await restore();
      throw error;
    }
  });

  await check('7c', 'the receiver control still works on the failed screen', async () => {
    await session.waitText(`Listening on port ${port}`);
    await session.click(locate.switch);
    await session.waitText('Receiver off');
    assert(await refusesConnection('127.0.0.1', port), 'off while failed');
    await session.click(locate.switch);
    await waitUntil(async () => {
      const { state } = await status();
      return state === 'listening' || state === 'failed';
    }, 'a settled receiver');
    assert((await status()).state === 'listening', `status ${JSON.stringify(await status())}`);
    await session.waitText(`Listening on port ${port}`);
  });

  await check(
    '7d',
    'a POST while unreadable replies a clear error within the deadline',
    async () => {
      const reply = await send('/sync', exportBody({ ...SENTINEL, nodeId: '9:901' }));
      assert(reply.status === 503 || reply.status >= 500, `status ${reply.status}`);
      assert(typeof reply.body.error === 'string', `body ${JSON.stringify(reply.body)}`);
      assert(!reply.body.error.toLowerCase().includes('output folder'), 'error wording');
    },
  );

  await restore();

  await check('7e', 'Try again recovers without a restart', async () => {
    const pid = session.app.child.pid;
    await session.click(locate.button('Try again'));
    await session.waitFor(locate.row('Synthetic Previews'));
    await session.waitGone("Can't open the library");
    assert(session.app.child.pid === pid, 'same process');
    assert((await stat(root)).mode & 0o700, 'library readable again');
    await sentinel();
  });
}

async function interaction() {
  const demoOne = { ...DEMO, nodeId: '7:10', nodeName: 'Synthetic Demo Hero' };
  await sync(exportBody({ ...demoOne, png: solidPng(320, 240, BLUE) }));
  await sync(exportBody({ ...demoOne, png: solidPng(320, 240, RED) }));
  await session.waitFor(locate.row('Synthetic Demo'));
  await openProject('Synthetic Demo', 'Synthetic Demo');
  await openNode('Synthetic Demo Hero');
  const recording = startRecording(session.page);
  await recording.start();
  await recording.hold(1.5);

  await check('5i', 'the recorded flow: arrival, browse, history, toggle, Trash', async () => {
    await sync(
      exportBody({
        ...DEMO,
        nodeId: '7:11',
        nodeName: 'Synthetic Live Arrival',
        png: solidPng(320, 240, GREEN),
      }),
    );
    await session.waitFor(locate.card('Synthetic Live Arrival'));
    await recording.hold(2.5);
    await openNode('Synthetic Live Arrival');
    await recording.hold(2);
    await openNode('Synthetic Demo Hero');
    await recording.hold(1.5);
    await session.click(locate.historyRow(1));
    await session.waitText('Actions apply to the older revision');
    await recording.hold(2.5);
    await session.click(locate.switch);
    await session.waitText('Receiver off');
    await recording.hold(2);
    await session.click(locate.switch);
    await waitListening();
    await recording.hold(1.5);
    await openNode('Synthetic Live Arrival');
    await recording.hold(1);
    if (!osEffects) return;
    const snapshot = await session.snapshot();
    const revision = nodeOf(snapshot, DEMO.fileKey, '7:11').revisions[0];
    const directory = insideScratch(revisionDirOf(revision));
    await session.click(locate.button('Move to Trash'));
    await session.waitFor(locate.dialog, 'the dialog');
    await recording.hold(2.5);
    await session.click(locate.button('Move to Trash', locate.dialog));
    await session.waitText('Moved to Trash');
    await waitUntil(
      async () => !(await session.exists(locate.card('Synthetic Live Arrival'))),
      'the node leaving',
    );
    trashed.push(basename(directory));
    await recording.hold(2.5);
    assert(!existsSync(directory), 'the revision left the library');
    await waitUntil(async () => (await session.focus()).region === 'grid', 'focus on the grid');
    await session.waitFor(locate.card('Synthetic Demo Hero'));
  });

  await recording.stop();
  if (!ffmpeg) {
    notProven('media', 'interaction.mp4', 'set FIGMA_DROP_PROOF_FFMPEG to encode it');
    return;
  }
  await check('media', 'interaction.mp4 encodes under 30 seconds', async () => {
    const seconds = await encodeRecording(
      recording,
      ffmpeg,
      join(scratch, 'frames'),
      join(proofDir, 'interaction.mp4'),
    );
    const { size } = await stat(join(proofDir, 'interaction.mp4'));
    log.write(`  ${recording.frames.length} frames`);
    assert(seconds > 5 && seconds < 31, `duration ${seconds}s`);
    assert(size < 8_000_000, `size ${size}`);
  });
}

async function documentControls() {
  const snapshot = await session.snapshot();
  const hostile = nodeOf(snapshot, PREVIEWS.fileKey, '4:4').revisions[0];
  const appUrl = await session.eval('location.href');

  await check(
    '3f',
    'the scripted SVG stays inert even when navigated to as a document',
    async () => {
      await session.expecting(async () => {
        await session.page.call('Page.navigate', { url: hostile.preview.url });
        await waitUntil(
          () =>
            session.eval(
              `location.protocol === 'figma-drop-preview:' && document.readyState === 'complete'`,
            ),
          'the preview document',
        );
      });
      assert(canaryHits.length === 0, `canary saw ${canaryHits.join(', ')}`);
    },
  );

  await check(
    '3g',
    'control: the same SVG does run as an open document, so 3d and 3f can fail',
    async () => {
      await session.expecting(async () => {
        const svg = hostileSvg(canaryPort);
        await session.page.call('Page.navigate', {
          url: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
        });
        await waitUntil(() => canaryHits.includes('/script'), 'the canary firing');
        await session.page.call('Page.navigate', { url: appUrl });
        await session.waitFor(`document.querySelector('nav')`);
      });
    },
  );
}

async function main() {
  log.write('scratch library and user data, free test port, synthetic exports only');
  assert(existsSync(join(desktopDir, 'dist-electron/main.cjs')), 'run pnpm build first');
  await mkdir(proofDir, { recursive: true });
  await session.start();
  await recordPorts();

  await emptyAndIngest();
  await previews();
  await history();
  await staleAndFailed();
  await keyboard();
  await look();
  await damaged();
  await receiver();
  await lifecycle();
  await degraded();
  await interaction();

  await check(
    '3h',
    'no console errors, exceptions, or CSP violations over the whole run',
    async () => {
      assert(session.problems.length === 0, session.problems.slice(0, 6).join(' || '));
    },
  );

  await documentControls();
  await recordPorts();

  await check('12a', 'quit exits cleanly', () => session.quit());

  await check('12b', 'the real library and real port stayed untouched', async () => {
    const after = existsSync(realLibrary) ? statSync(realLibrary).mtimeMs : null;
    assert(after === realLibraryBefore, `before ${realLibraryBefore}, after ${after}`);
    assert(!portsSeen.has(REAL_PORT), `saw ${[...portsSeen].join(', ')}`);
  });

  if (session.expectedProblems.length > 0) {
    log.write(
      `  ${session.expectedProblems.length} provoked error(s) during 3f and 3g, not the app's`,
    );
  }
  if (trashed.length > 0) {
    log.write(`real Trash received: ${trashed.join(', ')}`);
    await appendFile(join(scratchBase, 'trash-ledger.txt'), `${trashed.join('\n')}\n`);
  }
}

let crashed = null;
try {
  await main();
} catch (error) {
  crashed = error;
  log.write(`FAIL harness ${error.stack}`);
} finally {
  await chmod(library, 0o755).catch(() => {});
  await stopTracked();
  // A non-text clipboard reads back empty and cannot be restored from here.
  if (clipboardBefore) await writeClipboard(clipboardBefore);
  else if (osEffects) log.write('note: the clipboard held no text, so it keeps a scratch path');
  canary.close();
  await rm(insideScratch(join(scratch, 'library')), { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
  log.write(
    failures === 0 && !crashed
      ? `ALL PASS, ${unverified.length} unverified`
      : `${failures} FAILED, ${unverified.length} unverified`,
  );
  await writeFile(join(proofDir, 'verify-renderer.txt'), `${log.lines.join('\n')}\n`);
}
process.exit(failures === 0 && !crashed ? 0 : 1);
