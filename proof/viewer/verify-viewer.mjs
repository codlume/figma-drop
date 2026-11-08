import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

import {
  assert,
  clickAt,
  createLog,
  desktopDir,
  freePort,
  repoDir,
  stopTracked,
  waitUntil,
} from '../shell/driver.mjs';
import { decodePng, exportBody } from '../renderer/fixtures.mjs';
import { Session, encodeRecording, locate, run, startRecording } from '../renderer/harness.mjs';
import { COLOR, bannerFrame, colorName, desktopFrame, mobileFrame, nearest } from './frames.mjs';
import { PAGE_HELPERS } from './page-helpers.mjs';

const MODES = ['before', 'after'];
const mode =
  process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length) ?? 'after';
if (!MODES.includes(mode)) {
  console.error(`usage: node proof/viewer/verify-viewer.mjs --mode=${MODES.join('|')}`);
  process.exit(2);
}

const REAL_PORT = 3579;
const TRIGGER = 'Open image viewer';
// The viewer is driven by in-process UI, so anything slower than this is a missing feature, not a
// slow machine. It keeps a build without the viewer failing fast instead of hanging.
const VIEW_TIMEOUT = 4000;
const CHECK_TIMEOUT = 60_000;
const realLibrary = join(homedir(), 'figma-drop');
const outDir = join(repoDir, 'proof/viewer', mode);
const scratchBase = resolve(process.env.FIGMA_DROP_PROOF_SCRATCH ?? tmpdir());
const ffmpeg =
  process.env.FIGMA_DROP_PROOF_FFMPEG ??
  (await run('sh', ['-c', 'command -v ffmpeg']).then(
    ({ stdout }) => stdout.trim() || null,
    () => null,
  ));

const log = createLog();
const scratch = await mkdtemp(join(scratchBase, 'figma-drop-viewer-'));
const paths = {
  userData: join(scratch, 'user-data'),
  library: join(scratch, 'library'),
  port: await freePort(),
};
const { port } = paths;
const realLibraryBefore = existsSync(realLibrary) ? statSync(realLibrary).mtimeMs : null;
const session = new Session(paths);
const portsSeen = new Set();
const measurements = [];

function insideScratch(path) {
  const full = resolve(path);
  assert(full.startsWith(scratch + sep), `${full} is outside the scratch directory`);
  assert(full !== realLibrary && !full.startsWith(realLibrary + sep), 'never the real library');
  return full;
}

insideScratch(paths.library);
insideScratch(paths.userData);
assert(port !== REAL_PORT, 'never the real receiver port');
assert(basename(scratch).startsWith('figma-drop-viewer-'), `unexpected scratch ${scratch}`);

const FILE = { fileKey: 'VwSyntheticViewer0001', fileName: 'Synthetic Viewer' };
const MOBILE = {
  nodeId: '20:1',
  nodeName: 'Mobile Home',
  natural: [750, 1624],
  edges: { top: 'headerV2', bottom: 'tabBar' },
};
const LONG = {
  nodeId: '20:2',
  nodeName: 'Long Page',
  natural: [750, 4200],
  edges: { top: 'header', bottom: 'tabBar' },
};
const DESKTOP = {
  nodeId: '20:3',
  nodeName: 'Desktop Dashboard',
  natural: [2880, 1800],
  edges: { top: 'header', left: 'leftEdge', right: 'rightEdge' },
};
const BANNER = { nodeId: '20:4', nodeName: 'Wide Banner', natural: [1600, 400] };
const BARE = { nodeId: '20:5', nodeName: 'Empty Frame', natural: null };

let failures = 0;

async function check(id, label, verify, timeoutMs = CHECK_TIMEOUT) {
  let timer;
  try {
    await Promise.race([
      verify(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`gave up after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    log.write(`PASS ${id} ${label}`);
  } catch (error) {
    failures += 1;
    log.write(`FAIL ${id} ${label}`);
    log.write(`  ${error.message.split('\n')[0].slice(0, 400)}`);
    const shot = join(scratchBase, `figma-drop-viewer-fail-${id}.png`);
    if (
      await session.screenshot(shot).then(
        () => true,
        () => false,
      )
    )
      log.write(`  see ${shot}`);
  } finally {
    clearTimeout(timer);
  }
}

async function sync(body) {
  const response = await fetch(`http://localhost:${port}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'null' },
    body: JSON.stringify(body),
  });
  assert(response.status === 200, `POST /sync replied ${response.status} ${await response.text()}`);
}

const exportOf = (frame, png) =>
  exportBody({ ...FILE, nodeId: frame.nodeId, nodeName: frame.nodeName, png });

async function seedLibrary() {
  await waitUntil(
    async () => (await session.app.hook('receiverStatus()')).state === 'listening',
    'a listening receiver',
  );
  await sync(exportOf(MOBILE, mobileFrame(...MOBILE.natural)));
  await sync(exportOf(LONG, mobileFrame(...LONG.natural)));
  await sync(exportOf(DESKTOP, desktopFrame(...DESKTOP.natural)));
  await sync(exportOf(BANNER, bannerFrame(...BANNER.natural)));
  await sync(exportOf(BARE, undefined));
  await sync(exportOf(MOBILE, mobileFrame(...MOBILE.natural, COLOR.headerV2)));
}

async function openProject() {
  await session.waitFor(locate.row(FILE.fileName), 'the project row');
  await session.click(locate.row(FILE.fileName));
  await waitUntil(
    async () => (await session.eval(`document.querySelector('main h1')?.title`)) === FILE.fileName,
    'the project heading',
  );
  await waitUntil(
    () =>
      session.eval(`(() => {
        const cards = ${locate.cards};
        const images = cards.flatMap((card) => [...card.querySelectorAll('img')]);
        return cards.length === 5 && images.length === 4 && images.every((image) => image.complete && image.naturalWidth > 0);
      })()`),
    'five cards with four loaded previews',
  );
}

async function selectNode(frame) {
  await session.click(locate.cardNamed(frame.nodeName));
  await waitUntil(
    () =>
      session.eval(`(() => {
        const image = document.querySelector('aside img');
        return document.querySelector('aside h2')?.textContent === ${JSON.stringify(frame.nodeName)}
          && image?.complete && image.naturalWidth > 0;
      })()`),
    `the detail pane for ${frame.nodeName}`,
  );
}

async function setScene(width, height, scheme) {
  await session.resize(width, height);
  await session.setColorScheme(scheme);
  await waitUntil(
    () => session.eval(`matchMedia('(prefers-color-scheme: ${scheme})').matches`),
    `${scheme} scheme`,
  );
  await settle(`the ${width}x${height} layout settling`);
}

// Two equal reads of geometry, scroll, and running animations in a row mean the layout stopped.
async function settle(label = 'the layout settling') {
  let previous = null;
  await waitUntil(
    async () => {
      const now = await session.eval(`JSON.stringify((() => {
        const parts = proof.viewer();
        const target = parts?.image ?? document.querySelector('main [role=listbox]');
        const rect = target?.getBoundingClientRect();
        return [
          document.getAnimations().filter((animation) => animation.playState === 'running').length,
          rect && [rect.x, rect.y, rect.width, rect.height],
          parts?.stage && [parts.stage.scrollTop, parts.stage.scrollLeft],
          innerWidth,
          innerHeight,
        ];
      })())`);
      const still = now === previous && JSON.parse(now)[0] === 0;
      previous = now;
      return still;
    },
    label,
    VIEW_TIMEOUT,
  );
}

const fmt = (value) => (typeof value === 'number' ? value.toFixed(1) : String(value));
const size = (rect) => (rect ? `${fmt(rect.width)}x${fmt(rect.height)}` : '-');
const scene = (grid) => `${grid.viewport.width}x${grid.viewport.height}`;

function writeMeasurement(grid) {
  log.write(
    `  ${grid.viewport.width}x${grid.viewport.height} ${grid.scheme}: ${grid.columns} columns (tracks ${grid.tracks}, occupied ${grid.occupiedColumns}), grid ${fmt(grid.gridWidth)}px wide`,
  );
  const rows = [
    ...grid.cards.map((card) => [card.name, card]),
    ['detail preview', { image: grid.detail, cardWidth: null }],
  ];
  for (const [name, { image, cardWidth }] of rows) {
    if (!image) {
      log.write(`    ${name.padEnd(18)} card ${fmt(cardWidth)}  no image`);
      continue;
    }
    const fill = image.visible.width / image.frameWidth;
    log.write(
      `    ${name.padEnd(18)} card ${cardWidth === null ? '-' : fmt(cardWidth)}  frame ${fmt(image.frameWidth)}x${fmt(image.frameHeight)}  img box ${size(image.element)}  painted ${size(image.painted)}  visible ${size(image.visible)}  natural ${image.natural.width}x${image.natural.height}  fit ${image.objectFit}  fills ${(fill * 100).toFixed(0)}% of frame width`,
    );
  }
}

async function measureGrid(width, height, scheme) {
  await setScene(width, height, scheme);
  const grid = await session.eval('proof.measureGrid()');
  measurements.push(grid);
  writeMeasurement(grid);
  await session.screenshot(join(outDir, `grid-${width}x${height}-${scheme}.png`));
  return grid;
}

async function gridChecks() {
  const narrow = await measureGrid(800, 560, 'light');
  const wide = await measureGrid(1600, 1000, 'light');
  const dark = await measureGrid(1280, 800, 'dark');
  await session.setColorScheme('light');
  const scenes = [narrow, wide, dark];

  await check('G1', 'the grid gains columns from 800x560 to 1600x1000', async () => {
    assert(wide.columns > narrow.columns, `${narrow.columns} columns narrow, ${wide.columns} wide`);
  });

  await check('G2', 'every card preview keeps its natural aspect ratio', async () => {
    const bad = [];
    for (const grid of scenes) {
      for (const card of grid.cards.filter((candidate) => candidate.image)) {
        const { painted, natural } = card.image;
        const expected = natural.width / natural.height;
        const error = Math.abs(painted.width / painted.height - expected) / expected;
        if (error >= 0.01)
          bad.push(`${scene(grid)} ${card.name} off by ${(error * 100).toFixed(1)}%`);
      }
    }
    assert(bad.length === 0, bad.join('; '));
  });

  await check('G3', 'the tall mobile card preview fills the card preview width', async () => {
    const bad = [];
    for (const grid of scenes) {
      const { image } = grid.cards.find((card) => card.name === MOBILE.nodeName);
      const fill = image.visible.width / image.frameWidth;
      if (fill < 0.98) {
        bad.push(
          `${scene(grid)} shows ${fmt(image.visible.width)} of ${fmt(image.frameWidth)}px (${(fill * 100).toFixed(0)}%)`,
        );
      }
    }
    assert(bad.length === 0, bad.join('; '));
  });
}

const viewerState = () => session.eval('proof.viewerState()');

function waitViewer(predicate, label, timeoutMs = VIEW_TIMEOUT) {
  return waitUntil(
    async () => {
      const state = await viewerState();
      return predicate(state) && state;
    },
    label,
    timeoutMs,
  );
}

const TRIGGER_LOCATOR = `proof.find('button', ${JSON.stringify(TRIGGER)})`;
const part = (name) => `proof.viewer()?.${name}`;

async function ensureClosed() {
  if (!(await viewerState()).open) return;
  await session.press('Escape');
  await waitViewer((state) => !state.open, 'a leftover viewer to close');
}

async function openViewer(frame, { by = 'click' } = {}) {
  await ensureClosed();
  const selected = await session.eval(`document.querySelector('aside h2')?.textContent`);
  if (selected !== frame.nodeName) await selectNode(frame);
  await waitUntil(
    () => session.exists(TRIGGER_LOCATOR),
    `a button named "${TRIGGER}" in the detail pane`,
    VIEW_TIMEOUT,
  );
  if (by === 'Enter') await session.press('Enter');
  else await session.click(TRIGGER_LOCATOR);
  await waitViewer(
    (state) => state.open && state.image?.loaded,
    `a viewer dialog with a loaded image for ${frame.nodeName}`,
  );
  await settle('the viewer opening');
  const state = await viewerState();
  assert(state.missing.length === 0, `the viewer has no ${state.missing.join(', ')}`);
  assert(state.name === `Preview of ${frame.nodeName}`, `dialog is named "${state.name}"`);
  assert(state.openCount === 1, `${state.openCount} dialogs open`);
  return state;
}

async function press(name) {
  await session.click(part(name));
  await settle(`the viewer after ${name}`);
  return viewerState();
}

async function showActualSize() {
  await session.click(part('actual'));
  await waitViewer(
    (state) => state.actualPressed === 'true' && state.percent === 100,
    '100% pressed and the readout at 100%',
  );
  await settle('the viewer at 100%');
  return viewerState();
}

const scrollTarget = (target, max) => (target === 'max' ? max : target);
const assignScroll = (property, target, extent) =>
  target === undefined
    ? ''
    : `stage.${property} = ${target === 'max' ? `stage.${extent}` : target};`;

async function scrollStage({ top, left }) {
  await session.eval(`(() => {
    const stage = proof.viewer().stage;
    ${assignScroll('scrollTop', top, 'scrollHeight')}
    ${assignScroll('scrollLeft', left, 'scrollWidth')}
  })()`);
  await settle('the stage scrolling');
  const state = await viewerState();
  if (top !== undefined) {
    const want = scrollTarget(top, state.stage.maxTop);
    assert(
      Math.abs(state.stage.scrollTop - want) <= 1,
      `scrollTop ${state.stage.scrollTop}, wanted ${want}`,
    );
  }
  if (left !== undefined) {
    const want = scrollTarget(left, state.stage.maxLeft);
    assert(
      Math.abs(state.stage.scrollLeft - want) <= 1,
      `scrollLeft ${state.stage.scrollLeft}, wanted ${want}`,
    );
  }
  return state;
}

// A stage that grows past the window would hold any image, so the stage must fit the window too.
function stageInsideWindow(state) {
  const { box } = state.stage;
  const { width, height } = state.viewport;
  assert(
    box.left >= -1 && box.top >= -1 && box.right <= width + 1 && box.bottom <= height + 1,
    `stage ${JSON.stringify(box)} spills out of the ${width}x${height} window`,
  );
}

function wholeImageInside(state) {
  stageInsideWindow(state);
  const { painted } = state.image;
  const { box } = state.stage;
  const inside =
    painted.left >= box.left - 1 &&
    painted.top >= box.top - 1 &&
    painted.right <= box.right + 1 &&
    painted.bottom <= box.bottom + 1;
  assert(
    inside,
    `image ${JSON.stringify(painted)} spills out of stage ${JSON.stringify(box)} at ${state.readout}`,
  );
}

// Reads the painted pixel back from a screenshot, so an edge counts only if it is really on screen.
async function sampleColor(x, y) {
  const { data } = await session.page.call('Page.captureScreenshot', {
    format: 'png',
    clip: { x: x - 1, y: y - 1, width: 3, height: 3, scale: 1 },
  });
  const image = decodePng(Buffer.from(data, 'base64'));
  return colorName(nearest(image.pixel(image.width >> 1, image.height >> 1)));
}

const EDGES = {
  top: { axis: 'top', at: 0, inside: (p, b) => p.top >= b.top - 1 && p.top < b.bottom },
  bottom: {
    axis: 'top',
    at: 'max',
    inside: (p, b) => p.bottom <= b.bottom + 1 && p.bottom > b.top,
  },
  left: { axis: 'left', at: 0, inside: (p, b) => p.left >= b.left - 1 && p.left < b.right },
  right: { axis: 'left', at: 'max', inside: (p, b) => p.right <= b.right + 1 && p.right > b.left },
};

function edgePoint(edge, painted, box) {
  const midX = (Math.max(painted.left, box.left) + Math.min(painted.right, box.right)) / 2;
  const midY = (Math.max(painted.top, box.top) + Math.min(painted.bottom, box.bottom)) / 2;
  return {
    top: { x: midX, y: painted.top + 3 },
    bottom: { x: midX, y: painted.bottom - 3 },
    left: { x: painted.left + 3, y: midY },
    right: { x: painted.right - 3, y: midY },
  }[edge];
}

// At 100% each edge must be reachable by scrolling: the near edge at scroll 0, the far edge at
// the scroll maximum. An axis that does not scroll must fit whole.
async function assertEdgesReachable(frame, axes) {
  const notes = [];
  for (const axis of ['vertical', 'horizontal']) {
    const [near, far] = axis === 'vertical' ? ['top', 'bottom'] : ['left', 'right'];
    const state = await viewerState();
    stageInsideWindow(state);
    const max = axis === 'vertical' ? state.stage.maxTop : state.stage.maxLeft;
    if (axes.includes(axis)) {
      assert(max > 0, `the ${axis} axis does not scroll at 100%, so its edges prove nothing`);
    }
    if (max <= 1) {
      const { painted } = state.image;
      const { box } = state.stage;
      const fits =
        axis === 'vertical'
          ? painted.top >= box.top - 1 && painted.bottom <= box.bottom + 1
          : painted.left >= box.left - 1 && painted.right <= box.right + 1;
      assert(fits, `${axis} does not scroll yet the image is clipped`);
      notes.push(`${axis} fits`);
      continue;
    }
    for (const edge of [near, far]) {
      const { axis: property, at, inside } = EDGES[edge];
      const scrolled = await scrollStage({ [property]: at });
      const { painted } = scrolled.image;
      const { box } = scrolled.stage;
      assert(
        inside(painted, box),
        `${edge} edge not inside the stage at scroll ${property}=${at}: image ${JSON.stringify(painted)}, stage ${JSON.stringify(box)}`,
      );
      const expected = frame.edges?.[edge];
      if (expected) {
        const point = edgePoint(edge, painted, box);
        const seen = await sampleColor(point.x, point.y);
        assert(seen === expected, `${edge} edge painted ${seen}, expected ${expected}`);
      }
      notes.push(`${edge} reached`);
    }
  }
  return notes;
}

const KEYS = {
  '+': { code: 'Equal', windowsVirtualKeyCode: 187, modifiers: 8, unmodifiedText: '=' },
  '-': { code: 'Minus', windowsVirtualKeyCode: 189, modifiers: 0, unmodifiedText: '-' },
  0: { code: 'Digit0', windowsVirtualKeyCode: 48, modifiers: 0, unmodifiedText: '0' },
  1: { code: 'Digit1', windowsVirtualKeyCode: 49, modifiers: 0, unmodifiedText: '1' },
};

async function typeKey(key) {
  const event = { key, text: key, ...KEYS[key] };
  await session.page.call('Input.dispatchKeyEvent', { ...event, type: 'keyDown' });
  await session.page.call('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
}

async function drag(from, to, steps = 8) {
  const mouse = { button: 'left', clickCount: 1 };
  await session.page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
  await session.page.call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...from,
    ...mouse,
    buttons: 1,
  });
  for (let step = 1; step <= steps; step += 1) {
    const x = from.x + ((to.x - from.x) * step) / steps;
    const y = from.y + ((to.y - from.y) * step) / steps;
    await session.page.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'left',
      buttons: 1,
    });
  }
  await session.page.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...to,
    ...mouse,
    buttons: 0,
  });
}

function stageCenter(state) {
  const { box } = state.stage;
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}

async function closedWithFocusOnTrigger(how) {
  const state = await waitViewer(
    (current) => current.openCount === 0 && current.focus.name === TRIGGER,
    `zero open dialogs and focus on "${TRIGGER}" after ${how}`,
  ).catch(async (error) => {
    const current = await viewerState();
    throw new Error(
      `${error.message.split(', last saw')[0]}; ${current.openCount} open, focus on ${current.focus.tag} "${current.focus.name}"`,
    );
  });
  return state;
}

async function clickBackdrop() {
  const point = await session.eval('proof.backdropPoint()');
  assert(point, 'no point outside the panel lands on the dialog element');
  await clickAt(session.page, point);
}

async function axHas(role, name) {
  const { result } = await session.page.call('Runtime.evaluate', { expression: 'document' });
  const { nodes } = await session.page.call('Accessibility.queryAXTree', {
    objectId: result.objectId,
    role,
    accessibleName: name,
  });
  return nodes.some((node) => !node.ignored);
}

async function viewerChecks() {
  await setScene(1280, 800, 'light');

  await check(
    'V1',
    'the sidebar preview opens the viewer in Fit with the whole image inside',
    async () => {
      const state = await openViewer(MOBILE);
      assert(state.fitPressed === 'true', `Fit aria-pressed=${state.fitPressed}`);
      assert(state.actualPressed === 'false', `100% aria-pressed=${state.actualPressed}`);
      assert(state.percent !== null, `readout "${state.readout}" has no percentage`);
      assert(
        state.stageFocused,
        `focus is on ${state.focus.tag} "${state.focus.name}", not the stage`,
      );
      wholeImageInside(state);
      log.write(
        `  fit readout ${state.readout}, image ${size(state.image.painted)} in stage ${size(state.stage.box)}`,
      );
      await session.screenshot(join(outDir, 'viewer-fit-mobile.png'));
    },
  );

  await check(
    'V2',
    "Chrome's accessibility tree exposes the contract's roles and names",
    async () => {
      await openViewer(MOBILE);
      const wanted = [
        ['dialog', `Preview of ${MOBILE.nodeName}`],
        ['group', 'Image, scroll to pan'],
        ...['Zoom out', 'Zoom in', 'Fit', '100%', 'Close'].map((name) => ['button', name]),
      ];
      const missing = [];
      for (const [role, name] of wanted)
        if (!(await axHas(role, name))) missing.push(`${role} "${name}"`);
      assert(missing.length === 0, `not in the AX tree: ${missing.join(', ')}`);
    },
  );

  await check('V3', '100% renders the image at its natural CSS width and reads 100%', async () => {
    await openViewer(MOBILE);
    const state = await showActualSize();
    assert(state.fitPressed === 'false', `Fit still pressed`);
    const natural = state.image.natural.width;
    assert(
      Math.abs(state.image.cssWidth - natural) <= 1,
      `CSS width ${state.image.cssWidth}, natural ${natural}`,
    );
    assert(state.readout === '100%', `readout "${state.readout}"`);
  });

  await check(
    'V4',
    'zoom in and zoom out move the readout and image width monotonically',
    async () => {
      let previous = await openViewer(MOBILE);
      const trail = [`fit ${previous.readout}/${fmt(previous.image.cssWidth)}`];
      for (const [name, direction] of [
        ['zoomIn', 1],
        ['zoomIn', 1],
        ['zoomOut', -1],
        ['zoomOut', -1],
      ]) {
        await session.click(part(name));
        await waitViewer(
          (state) => state.percent !== previous.percent,
          `the readout to change after ${name}`,
        );
        await settle(`the viewer after ${name}`);
        const state = await viewerState();
        trail.push(`${name} ${state.readout}/${fmt(state.image.cssWidth)}`);
        assert(
          Math.sign(state.percent - previous.percent) === direction &&
            Math.sign(state.image.cssWidth - previous.image.cssWidth) === direction,
          trail.join(' -> '),
        );
        previous = state;
      }
      log.write(`  ${trail.join(' -> ')}`);
    },
  );

  for (const [id, frame, axes] of [
    ['V5', MOBILE, ['vertical']],
    ['V6', LONG, ['vertical']],
    ['V7', DESKTOP, ['horizontal']],
  ]) {
    await check(id, `at 100% every edge of ${frame.nodeName} scrolls into the stage`, async () => {
      if (frame === DESKTOP) {
        const fit = await openViewer(frame);
        wholeImageInside(fit);
        await session.screenshot(join(outDir, 'viewer-fit-wide.png'));
      } else {
        await openViewer(frame);
      }
      await showActualSize();
      const notes = await assertEdgesReachable(frame, axes);
      log.write(`  ${notes.join(', ')}`);
      if (frame === MOBILE) {
        const { stage } = await viewerState();
        await scrollStage({ top: Math.round(stage.maxTop / 2) });
        await session.screenshot(join(outDir, 'viewer-100-mobile-mid.png'));
      }
    });
  }

  await check('V8', 'dragging the image pans it and keeps the viewer open', async () => {
    await openViewer(MOBILE);
    await showActualSize();
    const before = await scrollStage({ top: 0 });
    const from = stageCenter(before);
    await drag(from, { x: from.x, y: from.y - 240 });
    await settle('the stage after the drag');
    const after = await viewerState();
    assert(after.open, 'the drag closed the viewer');
    const moved = after.stage.scrollTop - before.stage.scrollTop;
    assert(moved >= 100, `scrollTop moved ${moved}px for a 240px upward drag`);
    log.write(`  a 240px upward drag scrolled ${moved}px`);
  });

  await check('V14', 'repeating 100% leaves no stale anchor for a later render', async () => {
    await openViewer(MOBILE);
    await showActualSize();
    await scrollStage({ top: 300 });
    await typeKey('1');
    await settle('the viewer after a repeated 1');
    const scrolled = await scrollStage({ top: 900 });
    const center = stageCenter(scrolled);
    await drag(center, center, 0);
    await settle('the stage after a still press');
    const after = await viewerState();
    assert(
      Math.abs(after.stage.scrollTop - 900) <= 2,
      `scrollTop jumped to ${after.stage.scrollTop} after a press at 900`,
    );
  });

  await check('V9', 'keys + - 1 0 zoom in, zoom out, show 100%, and fit', async () => {
    const fit = await openViewer(MOBILE);
    assert(fit.stageFocused, `focus is on ${fit.focus.tag} "${fit.focus.name}", not the stage`);
    await typeKey('+');
    const zoomed = await waitViewer((state) => state.percent > fit.percent, '+ to zoom in');
    await settle('the viewer after +');
    await typeKey('-');
    await waitViewer((state) => state.percent < zoomed.percent, '- to zoom out');
    await settle('the viewer after -');
    await typeKey('1');
    const actual = await waitViewer(
      (state) => state.actualPressed === 'true' && state.readout === '100%',
      '1 to show 100%',
    );
    await settle('the viewer after 1');
    await typeKey('0');
    await waitViewer((state) => state.fitPressed === 'true', '0 to fit');
    await settle('the viewer after 0');
    wholeImageInside(await viewerState());
    log.write(`  fit ${fit.readout}, + ${zoomed.readout}, 1 ${actual.readout}, 0 back to fit`);
  });

  await check('V10', 'Escape closes the viewer and focus returns to the trigger', async () => {
    await openViewer(MOBILE);
    await session.press('Escape');
    await closedWithFocusOnTrigger('Escape');
  });

  await check(
    'V11',
    'a click on the backdrop closes the viewer and focus returns to the trigger',
    async () => {
      await openViewer(MOBILE);
      await clickBackdrop();
      await closedWithFocusOnTrigger('a backdrop click');
    },
  );

  await check(
    'V12',
    'five open and close cycles leave zero dialogs and focus on the trigger',
    async () => {
      const closers = ['Escape', 'Close', 'backdrop', 'Escape', 'Close'];
      for (const [index, closer] of closers.entries()) {
        const by = index % 2 === 1 ? 'Enter' : 'click';
        await openViewer(MOBILE, { by });
        if (closer === 'Escape') await session.press('Escape');
        else if (closer === 'Close') await session.click(part('close'));
        else await clickBackdrop();
        await closedWithFocusOnTrigger(`cycle ${index + 1}, opened by ${by}, closed by ${closer}`);
      }
    },
  );

  await check(
    'V13',
    'resizing the window in Fit keeps the whole image inside the stage',
    async () => {
      await openViewer(MOBILE);
      for (const [width, height] of [
        [1600, 1000],
        [800, 560],
      ]) {
        await session.resize(width, height);
        await settle(`the viewer at ${width}x${height}`);
        const state = await viewerState();
        assert(state.fitPressed === 'true', `Fit unpressed at ${width}x${height}`);
        wholeImageInside(state);
        log.write(
          `  ${width}x${height}: ${state.readout}, image ${size(state.image.painted)} in stage ${size(state.stage.box)}`,
        );
        await session.screenshot(join(outDir, `viewer-${width}x${height}.png`));
      }
      await session.resize(1280, 800);
      await ensureClosed();
    },
  );

  await ensureClosed().catch(() => {});
  await session.resize(1280, 800).catch(() => {});
  await recordInteraction();
}

async function recordInteraction() {
  if (!ffmpeg) {
    log.write('UNVERIFIED media interaction.mp4: no ffmpeg, set FIGMA_DROP_PROOF_FFMPEG');
    return;
  }
  const recording = startRecording(session.page);
  let recorded = false;
  await check(
    'M1',
    'the recorded flow: open, zoom in, 100%, drag down, Fit, Escape, reopen, backdrop',
    async () => {
      await ensureClosed();
      if (
        (await session.eval(`document.querySelector('aside h2')?.textContent`)) !== MOBILE.nodeName
      ) {
        await selectNode(MOBILE);
      }
      await recording.start();
      await recording.hold(1.5);
      await openViewer(MOBILE);
      await recording.hold(2);
      await press('zoomIn');
      await recording.hold(1.5);
      await showActualSize();
      await scrollStage({ top: 0 });
      await recording.hold(1.5);
      for (let step = 0; step < 4; step += 1) {
        const state = await viewerState();
        const from = stageCenter(state);
        await drag(from, { x: from.x, y: from.y - 220 }, 12);
        await settle('the stage after a drag');
        await recording.hold(0.8);
      }
      await press('fit');
      await recording.hold(1.5);
      await session.press('Escape');
      await closedWithFocusOnTrigger('Escape');
      await recording.hold(1.2);
      await openViewer(MOBILE);
      await recording.hold(1.5);
      await clickBackdrop();
      await closedWithFocusOnTrigger('a backdrop click');
      await recording.hold(2);
      recorded = true;
    },
    90_000,
  );
  await recording.stop().catch(() => {});
  if (!recorded) return;
  await check('M2', 'interaction.mp4 encodes at 12 to 30 seconds', async () => {
    const output = join(outDir, 'interaction.mp4');
    const seconds = await encodeRecording(recording, ffmpeg, join(scratch, 'frames'), output);
    const { size: bytes } = await stat(output);
    log.write(`  ${recording.frames.length} frames, ${seconds.toFixed(1)}s, ${bytes} bytes`);
    assert(seconds >= 12 && seconds <= 30, `duration ${seconds}s`);
  });
}

async function main() {
  log.write(
    `mode ${mode}: scratch library and user data, test port ${port}, synthetic exports only`,
  );
  assert(existsSync(join(desktopDir, 'dist-electron/main.cjs')), 'run pnpm build first');
  await mkdir(outDir, { recursive: true });
  await session.start();
  await session.eval(PAGE_HELPERS);
  await seedLibrary();
  await openProject();
  await selectNode(MOBILE);
  const history = await session.eval(`${locate.history}.length`);
  log.write(`seeded 5 exports, ${MOBILE.nodeName} has ${history} revisions in its history`);

  await gridChecks();

  const trigger = await session.exists(TRIGGER_LOCATOR);
  log.write(`a "${TRIGGER}" button is ${trigger ? 'present' : 'absent'} in this build`);
  if (mode === 'after') await viewerChecks();

  for (const seen of await session.app.listeningPorts()) portsSeen.add(seen);

  await check('Z1', 'no console errors, exceptions, or CSP violations over the run', async () => {
    assert(session.problems.length === 0, session.problems.slice(0, 6).join(' || '));
  });
  await check('Z2', 'quit exits cleanly', () => session.quit());
  await check('Z3', 'the real library and real port stayed untouched', async () => {
    const after = existsSync(realLibrary) ? statSync(realLibrary).mtimeMs : null;
    assert(after === realLibraryBefore, `before ${realLibraryBefore}, after ${after}`);
    assert(!portsSeen.has(REAL_PORT), `saw ${[...portsSeen].join(', ')}`);
  });
}

let crashed = null;
try {
  await main();
} catch (error) {
  crashed = error;
  log.write(`FAIL harness ${error.stack}`);
} finally {
  await stopTracked();
  await rm(insideScratch(paths.library), { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
  log.write(
    failures === 0 && !crashed
      ? 'ALL PASS'
      : `${failures} FAILED${crashed ? ', harness crashed' : ''}`,
  );
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'verify-viewer.txt'), `${log.lines.join('\n')}\n`);
  await writeFile(join(outDir, 'measurements.json'), `${JSON.stringify(measurements, null, 2)}\n`);
}
process.exit(failures === 0 && !crashed ? 0 : 1);
