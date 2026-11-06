import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  App,
  assert,
  createLog,
  desktopDir,
  freePort,
  launchApp,
  refusesConnection,
  repoDir,
  stopTracked,
  waitUntil,
} from './driver.mjs';

const REAL_PORT = 3579;
const QUIT_DEADLINE_MS = 4_000;
const realLibrary = join(homedir(), 'figma-drop');
const proofDir = join(repoDir, 'proof/shell');
const log = createLog();
const appOutput = [];
App.log = (line) => appOutput.push(line);

const scratch = await mkdtemp(join(tmpdir(), 'figma-drop-shell-'));
const paths = { userData: join(scratch, 'user-data'), library: join(scratch, 'library') };
const settingsPath = join(paths.userData, 'settings.json');
const port = await freePort();
const launch = () => launchApp({ ...paths, port });
const realLibraryBefore = existsSync(realLibrary) ? statSync(realLibrary).mtimeMs : null;
const portsSeen = new Set();

// The receiver lands separately, and with it a switched-on app reads differently.
const hasIngest = existsSync(join(desktopDir, 'src/ingest/receiver-controller.ts'));
const switchedOn = hasIngest
  ? { state: 'listening', text: `Listening on port ${port}` }
  : { state: 'unavailable', text: 'No receiver' };

const persisted = async () => JSON.parse(await readFile(settingsPath, 'utf8'));

async function step(label, run) {
  await run();
  log.write(`PASS ${label}`);
}

async function recordPorts(app) {
  for (const seen of await app.listeningPorts()) portsSeen.add(seen);
}

// The switch appears once the receiver answers, and the list once the library has.
const RENDERED = `!!document.querySelector('[role=switch]') && !!document.querySelector('nav [role=listbox]')`;

async function waitForWindow(app) {
  const page = await app.page();
  const errors = await page.collectErrors();
  await waitUntil(() => page.evaluate(RENDERED), 'the library list and the receiver switch');
  return { page, errors };
}

const pageText = (page) => page.evaluate('document.body.innerText');

async function waitForText(page, text) {
  await waitUntil(async () => (await pageText(page)).includes(text), `page text "${text}"`);
}

const exitedCleanly = (exit) => exit !== null && exit.code === 0 && exit.signal === null;

const clickTrayQuit = (app) => app.hook(`clickTray('quit')`).catch(() => {});

async function quit(app) {
  await clickTrayQuit(app);
  const exit = await app.exitWithin(QUIT_DEADLINE_MS);
  assert(exitedCleanly(exit), `clean exit, got ${JSON.stringify(exit)}`);
}

// The signal goes to the main process alone, as `kill <pid>` would. A group signal also ends the
// renderer, which is not the state under test. Every path runs even after one fails, so a capture
// shows them all.
const quitPaths = [
  ...['SIGTERM', 'SIGHUP', 'SIGINT'].map((signal) => ({
    label: signal,
    trigger: async (app) => process.kill(app.child.pid, signal),
  })),
  {
    label: 'app.quit(), which Cmd+Q calls',
    trigger: (app) =>
      app.evaluateInMain(`process.mainModule.require('electron').app.quit()`).catch(() => {}),
  },
  { label: 'tray Quit', trigger: clickTrayQuit },
  {
    // The tray rebuilds its menu on every status, so a throw here makes `receiver.stop()` reject.
    label: 'tray Quit while stopping the receiver rejects',
    trigger: async (app) => {
      await app.evaluateInMain(`(() => {
        process.mainModule.require('electron').Menu.buildFromTemplate = () => {
          throw new Error('proof: status listener threw');
        };
      })()`);
      await clickTrayQuit(app);
    },
  },
];

async function exitsByItselfWithAWindowOpen({ label, trigger }) {
  const app = launch();
  await waitForWindow(app);
  await app.waitForHooks();
  const windows = await app.hook('windows()');
  assert(windows.length === 1 && windows[0].visible, `one open window, got ${windows.length}`);
  const startedAt = Date.now();
  await trigger(app);
  const exit = await app.exitWithin(QUIT_DEADLINE_MS);
  const elapsed = Date.now() - startedAt;
  // Runs only once the outcome above is fixed, so this SIGKILL fallback cannot turn a hang into a pass.
  if (exit === null) await stopTracked();
  return {
    passed: exitedCleanly(exit),
    line: exit
      ? `${label} with a window open exits by itself: ${JSON.stringify(exit)} after ${elapsed} ms`
      : `${label} with a window open is still running after ${QUIT_DEADLINE_MS} ms`,
  };
}

function builtCss() {
  const rendererDir = join(desktopDir, 'dist/renderer');
  const html = readFileSync(join(rendererDir, 'index.html'), 'utf8');
  const links = [...html.matchAll(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+)"/g)];
  const cssFiles = readdirSync(join(rendererDir, 'assets')).filter((name) => name.endsWith('.css'));
  assert(links.length === 1, `index.html links one stylesheet, got ${links.length}`);
  assert(cssFiles.length === 1, `no orphan CSS asset, got ${cssFiles.join(', ')}`);
  return readFileSync(join(rendererDir, links[0][1]), 'utf8');
}

const trayItem = async (app, id) => (await app.hook('tray()')).items.find((i) => i.id === id);

async function main() {
  log.write('scratch library and user data under the system temp dir, free test port');
  assert(existsSync(join(desktopDir, 'dist-electron/main.cjs')), 'run pnpm build first');

  await step('one linked CSS file holds the StyleX rules and the App stylesheet', async () => {
    const css = builtCss();
    assert(css.includes('@layer'), 'StyleX layers in the linked CSS');
    assert(css.includes('#f6f6f4'), 'token values in the linked CSS');
    assert(css.includes('color-scheme'), "App's own style.css in the linked CSS");
  });

  await step('the receiver bundle is packed exactly when src/ingest exists', async () => {
    const packed = existsSync(join(desktopDir, 'dist-electron/receiver.cjs'));
    assert(packed === hasIngest, `receiver.cjs ${packed}, src/ingest ${hasIngest}`);
  });

  let app = launch();
  let { page, errors } = await waitForWindow(app);
  await app.waitForHooks();

  await step('a window loads and renders the real library view', async () => {
    assert((await app.hook('windows()')).length === 1, 'one window');
    await waitForText(page, 'Figma files');
    await waitForText(page, 'Unidentified');
    await waitForText(page, switchedOn.text);
  });

  await step('StyleX CSS is linked and token colors reach the page', async () => {
    const style = await page.evaluate(`(() => {
      const sidebar = getComputedStyle(document.querySelector('nav').parentElement);
      return {
        links: document.querySelectorAll('link[rel=stylesheet]').length,
        background: sidebar.backgroundColor,
        bodyMargin: getComputedStyle(document.body).marginTop,
      };
    })()`);
    assert(style.links === 1, `one stylesheet, got ${style.links}`);
    assert(
      ['rgb(246, 246, 244)', 'rgb(27, 27, 29)'].includes(style.background),
      `token background, got ${style.background}`,
    );
    assert(style.bodyMargin === '0px', `reset applied, got ${style.bodyMargin}`);
  });

  await step('window.figmaDrop is frozen and matches the API, with no require', async () => {
    const shape = await page.evaluate(`(() => {
      const api = window.figmaDrop;
      return {
        frozen: [api, api.library, api.receiver, api.app].every(Object.isFrozen),
        keys: {
          api: Object.keys(api).sort(),
          library: Object.keys(api.library).sort(),
          receiver: Object.keys(api.receiver).sort(),
          app: Object.keys(api.app),
        },
        require: typeof require,
        process: typeof process,
      };
    })()`);
    assert(shape.frozen, 'api and namespaces frozen');
    assert(shape.require === 'undefined', `require is ${shape.require}`);
    assert(shape.process === 'undefined', `process is ${shape.process}`);
    assert(
      JSON.stringify(shape.keys) ===
        JSON.stringify({
          api: ['app', 'library', 'receiver'],
          library: ['copyPath', 'copyToFolder', 'getSnapshot', 'onChanged', 'reveal', 'trash'],
          receiver: ['getStatus', 'onStatus', 'setEnabled'],
          app: ['onFocusExport'],
        }),
      `api shape, got ${JSON.stringify(shape.keys)}`,
    );
  });

  await step(`status reads ${switchedOn.state} and the test port agrees`, async () => {
    const status = await waitUntil(async () => {
      const current = await page.evaluate('window.figmaDrop.receiver.getStatus()');
      return current.state === switchedOn.state && current;
    }, `status ${switchedOn.state}`);
    if (hasIngest) assert(status.port === port, `status ${JSON.stringify(status)}`);
    const refused = !hasIngest;
    assert(
      (await refusesConnection('127.0.0.1', port)) === refused,
      `127.0.0.1 refused ${!refused}`,
    );
    assert((await refusesConnection('::1', port)) === refused, `::1 refused ${!refused}`);
    const held = (await app.listeningPorts()).includes(port);
    assert(held === hasIngest, `the app holds the test port: ${held}`);
    await recordPorts(app);
  });

  if (!hasIngest) {
    await step('a build with no receiver never implies exports are being received', async () => {
      await waitForText(page, "This build can't receive exports");
      const text = await pageText(page);
      assert(!/listening|ready to receive|waiting for exports/i.test(text), `page says: ${text}`);
      const status = await trayItem(app, 'status');
      assert(!/listening/i.test(status.label), `tray says: ${status.label}`);
    });
  }

  await step('the library opens empty and refuses an unknown revision', async () => {
    const snapshot = await page.evaluate('window.figmaDrop.library.getSnapshot()');
    assert(snapshot.state === 'ready', `snapshot ${JSON.stringify(snapshot)}`);
    assert(snapshot.projects.length === 0, `projects ${snapshot.projects.length}`);
    assert(snapshot.unidentified.length === 0, `unidentified ${snapshot.unidentified.length}`);
    assert(existsSync(paths.library), 'the library root is the scratch path');
    const result = await page.evaluate(`window.figmaDrop.library.trash('anything')`);
    assert(result.ok === false && result.code === 'not-found', JSON.stringify(result));
  });

  await step('IPC refuses a non-boolean setEnabled', async () => {
    const outcome = await page.evaluate(
      `window.figmaDrop.receiver.setEnabled('yes').then(() => 'resolved', () => 'rejected')`,
    );
    assert(outcome === 'rejected', `setEnabled('yes') ${outcome}`);
  });

  await writeFile(join(proofDir, 'after-shell.png'), await screenshot(page));
  log.write('saved proof/shell/after-shell.png');

  await step('setEnabled(false) writes settings.json and status reads off', async () => {
    const status = await page.evaluate('window.figmaDrop.receiver.setEnabled(false)');
    assert(status.state === 'off', `status ${JSON.stringify(status)}`);
    assert((await persisted()).receiverEnabled === false, 'false persisted');
    await waitForText(page, 'Receiver off');
    await waitForText(page, 'The receiver is off');
    const tray = await trayItem(app, 'status');
    assert(tray.label === 'Receiver off', `tray status ${tray.label}`);
    assert((await trayItem(app, 'receiver-on')).checked === false, 'tray checkbox off');
  });

  await step('closing the window leaves the process and tray alive with zero windows', async () => {
    const closing = page.closed;
    void page.evaluate('window.close()').catch(() => {});
    await closing;
    await waitUntil(async () => (await app.hook('windows()')).length === 0, 'zero windows');
    assert(app.child.exitCode === null, 'process alive');
    assert((await app.hook('tray()')).alive, 'tray alive');
  });

  await step('reopening from the tray action creates a working window', async () => {
    await app.hook(`clickTray('open')`);
    ({ page, errors } = await waitForWindow(app));
    await waitForText(page, 'Receiver off');
    assert((await app.hook('windows()')).length === 1, 'one window');
  });

  await step('a second launch exits and focuses the first', async () => {
    const closing = page.closed;
    void page.evaluate('window.close()').catch(() => {});
    await closing;
    await waitUntil(async () => (await app.hook('windows()')).length === 0, 'zero windows');
    const second = launch();
    const exit = await second.exited;
    assert(exit.code === 0, `second launch exit ${JSON.stringify(exit)}`);
    ({ page, errors } = await waitForWindow(app));
    const windows = await waitUntil(async () => {
      const current = await app.hook('windows()');
      return current.length === 1 && current[0].visible && current[0].focused && current;
    }, 'the first instance window visible and focused');
    assert(windows.length === 1, 'still one window');
    assert(app.child.exitCode === null, 'first instance alive');
  });

  await step('page and CSP errors stay empty across this launch', async () => {
    assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
  });

  await recordPorts(app);
  await step('quit from the tray exits cleanly', () => quit(app));

  app = launch();
  ({ page, errors } = await waitForWindow(app));
  await app.waitForHooks();

  await step('relaunch keeps the persisted false', async () => {
    await waitForText(page, 'Receiver off');
    const status = await app.hook('receiverStatus()');
    assert(status.state === 'off', `status ${JSON.stringify(status)}`);
  });

  await step('toggling through the tray menu persists and updates the window', async () => {
    await app.hook(`clickTray('receiver-on')`);
    await waitForText(page, switchedOn.text);
    assert((await persisted()).receiverEnabled === true, 'true persisted');
    assert((await trayItem(app, 'receiver-on')).checked === true, 'checkbox on');
    await app.hook(`clickTray('receiver-on')`);
    await waitForText(page, 'Receiver off');
    assert((await persisted()).receiverEnabled === false, 'false persisted');
    assert((await trayItem(app, 'receiver-on')).checked === false, 'checkbox off');
  });

  await step('a setting that cannot be saved reads failed and changes nothing', async () => {
    await chmod(paths.userData, 0o500);
    let status;
    try {
      status = await page.evaluate('window.figmaDrop.receiver.setEnabled(true)');
    } finally {
      await chmod(paths.userData, 0o700);
    }
    assert(status.state === 'failed', `status ${JSON.stringify(status)}`);
    await waitForText(page, 'could not be saved');
    await waitForText(page, 'Receiver problem');
    assert((await persisted()).receiverEnabled === false, 'the file keeps false');
    assert((await trayItem(app, 'receiver-on')).checked === false, 'the checkbox keeps false');
    const tray = await trayItem(app, 'status');
    assert(tray.label.startsWith('Receiver problem'), `tray status ${tray.label}`);
    const recovered = await page.evaluate('window.figmaDrop.receiver.setEnabled(false)');
    assert(recovered.state === 'off', `recovered ${JSON.stringify(recovered)}`);
    await waitForText(page, 'Receiver off');
  });

  await step('the tray toggle persists with no window open', async () => {
    const closing = page.closed;
    void page.evaluate('window.close()').catch(() => {});
    await closing;
    await waitUntil(async () => (await app.hook('windows()')).length === 0, 'zero windows');
    await app.hook(`clickTray('receiver-on')`);
    await waitUntil(async () => (await persisted()).receiverEnabled === true, 'true persisted');
    await app.hook(`clickTray('receiver-on')`);
    await waitUntil(async () => (await persisted()).receiverEnabled === false, 'false persisted');
  });

  await recordPorts(app);
  await quit(app);

  await step('relaunch after a tray toggle reads the tray value', async () => {
    app = launch();
    ({ page } = await waitForWindow(app));
    await waitForText(page, 'Receiver off');
    await recordPorts(app);
    await quit(app);
  });

  await step('a corrupt settings.json falls back to on', async () => {
    await writeFile(settingsPath, '{ not json');
    app = launch();
    ({ page } = await waitForWindow(app));
    await app.waitForHooks();
    await waitForText(page, switchedOn.text);
    assert((await trayItem(app, 'receiver-on')).checked === true, 'tray checkbox on');
    await recordPorts(app);
  });

  await step('quit exits cleanly', () => quit(app));

  const outcomes = [];
  for (const path of quitPaths) {
    const outcome = await exitsByItselfWithAWindowOpen(path);
    outcomes.push(outcome);
    log.write(`${outcome.passed ? 'PASS' : 'FAIL'} ${outcome.line}`);
  }
  assert(
    outcomes.every((outcome) => outcome.passed),
    'every quit path exits by itself',
  );

  await step('a rejected receiver stop is logged, not swallowed', async () => {
    const logged = appOutput.some((line) => line.includes('Could not stop the receiver'));
    assert(logged, 'the app logged the failed stop');
  });

  await step('~/figma-drop was not created or touched', async () => {
    const after = existsSync(realLibrary) ? statSync(realLibrary).mtimeMs : null;
    assert(after === realLibraryBefore, `before ${realLibraryBefore}, after ${after}`);
  });

  await step(
    'the app never bound port 3579, and bound the test port only with a receiver',
    async () => {
      assert(portsSeen.size > 0, 'lsof saw the app listeners, so an absent port means something');
      assert(!portsSeen.has(REAL_PORT), `saw ${[...portsSeen].join(', ')}`);
      assert(portsSeen.has(port) === hasIngest, `saw ${[...portsSeen].join(', ')}`);
      log.write(`  ${portsSeen.size} app listeners sampled across checkpoints`);
    },
  );
}

async function screenshot(page) {
  const { data } = await page.call('Page.captureScreenshot', { format: 'png' });
  return Buffer.from(data, 'base64');
}

let failure = null;
try {
  await main();
  log.write('ALL PASS');
} catch (error) {
  failure = error;
  log.write(`FAIL ${error.message}`);
} finally {
  const forced = await stopTracked();
  if (forced && !failure) {
    failure = new Error('a process outlived the run and needed SIGKILL');
    log.write(`FAIL ${failure.message}`);
  }
  await rm(scratch, { recursive: true, force: true });
  await mkdir(proofDir, { recursive: true });
  await writeFile(join(proofDir, 'verify-shell.txt'), `${log.lines.join('\n')}\n`);
}
process.exit(failure ? 1 : 0);
