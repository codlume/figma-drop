import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assert,
  createLog,
  freePort,
  launchApp,
  repoDir,
  stopTracked,
  waitUntil,
} from './driver.mjs';
import { seedLibrary } from './fixture-library.mjs';

// Style and geometry evidence only. A synthetic CDP mouse never reaches AppKit's window drag, so
// nothing here moves the window, and macOS exposes no rectangle for the inset traffic lights.
const STRIP_HEIGHT = 38;
const PANE_BORDER_WIDTH = 1;
const TRAFFIC_LIGHT_BOX = { width: 80, height: STRIP_HEIGHT };
const SIZES = [
  { width: 1040, height: 680 },
  { width: 800, height: 560 },
];

const log = createLog();
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'figma-drop-chrome-')));
const paths = { userData: join(scratch, 'user-data'), library: join(scratch, 'library') };

async function step(label, run) {
  await run();
  log.write(`PASS ${label}`);
}

// `electron.BrowserWindow` is a fixed getter, so the options are caught where the bundle requires it.
const RECORD_WINDOW_OPTIONS = `(() => {
  const Module = process.getBuiltinModule('node:module');
  const load = Module._load;
  Module._load = function (request, ...rest) {
    const loaded = load.call(this, request, ...rest);
    if (request !== 'electron') return loaded;
    const BrowserWindow = new Proxy(loaded.BrowserWindow, {
      construct(target, args, newTarget) {
        const { webPreferences, ...options } = args[0];
        globalThis.proofWindowOptions = options;
        return Reflect.construct(target, args, newTarget);
      },
    });
    return new Proxy(loaded, {
      get: (target, key) => (key === 'BrowserWindow' ? BrowserWindow : target[key]),
    });
  };
})()`;

function stripSeams({ strips, width }) {
  const seams = [];
  let edge = 0;
  for (const strip of strips.toSorted((a, b) => a.left - b.left)) {
    if (strip.left > edge) seams.push({ left: edge, width: strip.left - edge });
    edge = Math.max(edge, strip.left + strip.width);
  }
  if (edge < width) seams.push({ left: edge, width: width - edge });
  return seams;
}

const firstWindow = `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]`;

const SURVEY = `(() => {
  const regionAt = (x, y) => {
    for (let node = document.elementFromPoint(x, y); node; node = node.parentElement) {
      const region = getComputedStyle(node).getPropertyValue('-webkit-app-region');
      if (region === 'drag' || region === 'no-drag') return region;
    }
    return 'none';
  };
  const interactive = 'button, a, input, select, textarea, [role=option], [role=switch], [tabindex]';
  const inStrip = [...document.querySelectorAll(interactive)]
    .map((node) => ({ node, rect: node.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && rect.top < ${STRIP_HEIGHT})
    .filter(({ node }) => node.tagName !== 'MAIN')
    .map(({ node, rect }) => ({
      name: node.getAttribute('aria-label') ?? node.textContent.slice(0, 40),
      region: getComputedStyle(node).getPropertyValue('-webkit-app-region'),
      left: rect.left,
      top: rect.top,
    }));
  const samples = [];
  for (let x = 1; x < innerWidth; x += 7) {
    for (const y of [1, 19, ${STRIP_HEIGHT - 1}]) samples.push({ x, y, region: regionAt(x, y) });
  }
  const strips = [...document.querySelectorAll('div')]
    .filter((node) => getComputedStyle(node).getPropertyValue('-webkit-app-region') === 'drag')
    .map((node) => {
      const { left, top, width, height } = node.getBoundingClientRect();
      return { left, top, width, height };
    });
  return {
    width: innerWidth,
    height: innerHeight,
    samples,
    strips,
    inStrip,
    below: regionAt(innerWidth / 2, ${STRIP_HEIGHT + 2}),
  };
})()`;

async function main() {
  await seedLibrary(paths.library);
  const app = launchApp({ ...paths, port: await freePort(), inspectBrk: true });
  await app.evaluateBeforeMain(RECORD_WINDOW_OPTIONS);
  const page = await app.page();
  await waitUntil(
    () => page.evaluate(`document.body.innerText.includes('Copy to folder')`),
    'the detail pane of the fixture export',
  );

  await step('the window is built with hiddenInset and an 800x560 minimum', async () => {
    const options = await app.evaluateInMain('globalThis.proofWindowOptions');
    log.write(`  constructor options ${JSON.stringify(options)}`);
    assert(options.titleBarStyle === 'hiddenInset', `titleBarStyle ${options.titleBarStyle}`);
    assert(options.minWidth === 800 && options.minHeight === 560, 'minimum in the options');
  });

  await step(
    'the native window reports that minimum and a content area under the title bar',
    async () => {
      const native = await app.evaluateInMain(`(() => {
      const window = ${firstWindow};
      return {
        minimum: window.getMinimumSize(),
        frame: window.getBounds(),
        content: window.getContentBounds(),
      };
    })()`);
      log.write(`  native ${JSON.stringify(native)}`);
      assert(native.minimum[0] === 800 && native.minimum[1] === 560, 'native minimum size');
      assert(native.content.height === native.frame.height, 'the content runs under the title bar');
    },
  );

  for (const size of SIZES) {
    await app.evaluateInMain(`${firstWindow}.setContentSize(${size.width}, ${size.height})`);
    const survey = await waitUntil(async () => {
      const seen = await page.evaluate(SURVEY);
      return seen.width === size.width && seen.height === size.height && seen;
    }, `a ${size.width}x${size.height} page`);
    const at = `at ${size.width}x${size.height}`;

    await step(`the drag region covers the top strip but for pane borders ${at}`, async () => {
      const seams = stripSeams(survey);
      log.write(`  drag strips ${JSON.stringify(survey.strips)}`);
      log.write(`  non-drag seams ${JSON.stringify(seams)}`);
      const tall = survey.strips.every(({ top, height }) => top === 0 && height === STRIP_HEIGHT);
      assert(tall, `every strip spans the top ${STRIP_HEIGHT}px`);
      assert(
        seams.every(({ width }) => width <= PANE_BORDER_WIDTH),
        `a seam wider than a pane border: ${JSON.stringify(seams)}`,
      );
      const inSeam = ({ x }) => seams.some(({ left, width }) => x >= left && x < left + width);
      const gaps = survey.samples.filter((sample) => sample.region !== 'drag' && !inSeam(sample));
      assert(gaps.length === 0, `not drag: ${JSON.stringify(gaps.slice(0, 8))}`);
      assert(survey.below !== 'drag', `the region stops at the strip, got ${survey.below}`);
    });

    await step(`no control sits under the traffic lights ${at}`, async () => {
      const blocked = survey.inStrip.filter(
        ({ left, top }) => left < TRAFFIC_LIGHT_BOX.width && top < TRAFFIC_LIGHT_BOX.height,
      );
      assert(blocked.length === 0, `under the lights: ${JSON.stringify(blocked)}`);
    });

    await step(`every control inside the strip is no-drag ${at}`, async () => {
      log.write(`  ${survey.inStrip.length} interactive elements intersect the strip`);
      const draggable = survey.inStrip.filter(({ region }) => region !== 'no-drag');
      assert(draggable.length === 0, `drag on a control: ${JSON.stringify(draggable)}`);
    });
  }

  await app.hook(`clickTray('quit')`).catch(() => {});
  const exit = await app.exitWithin(4_000);
  assert(exit?.code === 0, `the app quits cleanly, got ${JSON.stringify(exit)}`);
}

let failure = null;
try {
  await main();
  log.write('ALL PASS');
} catch (error) {
  failure = error;
  log.write(`FAIL ${error.message}`);
} finally {
  await stopTracked();
  await rm(scratch, { recursive: true, force: true });
  await writeFile(join(repoDir, 'proof/shell/verify-chrome.txt'), `${log.lines.join('\n')}\n`);
}
process.exit(failure ? 1 : 0);
