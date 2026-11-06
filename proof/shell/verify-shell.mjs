import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
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
const realLibrary = join(homedir(), 'figma-drop');
const proofDir = join(repoDir, 'proof/shell');
const log = createLog();

const scratch = await mkdtemp(join(tmpdir(), 'figma-drop-shell-'));
const paths = { userData: join(scratch, 'user-data'), library: join(scratch, 'library') };
const settingsPath = join(paths.userData, 'settings.json');
const port = await freePort();
const launch = () => launchApp({ ...paths, port });
const realLibraryBefore = existsSync(realLibrary) ? statSync(realLibrary).mtimeMs : null;
const portsSeen = new Set();

const persisted = async () => JSON.parse(await readFile(settingsPath, 'utf8'));

async function step(label, run) {
  await run();
  log.write(`PASS ${label}`);
}

async function recordPorts(app) {
  for (const seen of await app.listeningPorts()) portsSeen.add(seen);
}

async function waitForWindow(app) {
  const page = await app.page();
  const errors = await page.collectErrors();
  await waitUntil(() => page.evaluate(`document.body.innerText.includes('figma-drop')`), 'content');
  return { page, errors };
}

const pageText = (page) => page.evaluate('document.body.innerText');

async function waitForText(page, text) {
  await waitUntil(async () => (await pageText(page)).includes(text), `page text "${text}"`);
}

async function quit(app) {
  await app.hook(`clickTray('quit')`).catch(() => {});
  const exit = await app.exited;
  assert(exit.code === 0 && exit.signal === null, `clean exit, got ${JSON.stringify(exit)}`);
}

const trayItem = async (app, id) => (await app.hook('tray()')).items.find((i) => i.id === id);

async function main() {
  log.write(`scratch library and user data under the system temp dir, test port ${port}`);
  assert(existsSync(join(desktopDir, 'dist-electron/main.cjs')), 'run pnpm build first');

  let app = launch();
  let { page, errors } = await waitForWindow(app);
  await app.waitForHooks();

  await step('a window loads and renders the status view', async () => {
    await waitForText(page, 'The library interface is not installed yet.');
    assert((await app.hook('windows()')).length === 1, 'one window');
  });

  await step('StyleX CSS is linked and token colors reach the page', async () => {
    const style = await page.evaluate(`(() => {
      const main = getComputedStyle(document.querySelector('main'));
      return {
        links: document.querySelectorAll('link[rel=stylesheet]').length,
        background: main.backgroundColor,
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

  await step('status reads unavailable and nothing listens on the test port', async () => {
    const status = await page.evaluate('window.figmaDrop.receiver.getStatus()');
    assert(status.state === 'unavailable', `status ${JSON.stringify(status)}`);
    await waitForText(page, 'Receiver unavailable');
    assert(await refusesConnection('127.0.0.1', port), 'nothing on 127.0.0.1');
    assert(await refusesConnection('::1', port), 'nothing on ::1');
    assert(!(await app.listeningPorts()).includes(port), 'the app holds no test port listener');
    await recordPorts(app);
  });

  await step('the placeholder never implies exports are being received', async () => {
    const text = await pageText(page);
    assert(!/listening|ready to receive|waiting for exports/i.test(text), `page says: ${text}`);
    const status = await trayItem(app, 'status');
    assert(!/listening/i.test(status.label), `tray says: ${status.label}`);
  });

  await step('library commands answer unavailable without the library', async () => {
    const snapshot = await page.evaluate('window.figmaDrop.library.getSnapshot()');
    assert(snapshot.state === 'unavailable', `snapshot ${JSON.stringify(snapshot)}`);
    const result = await page.evaluate(`window.figmaDrop.library.trash('anything')`);
    assert(result.ok === false && result.code === 'unavailable', JSON.stringify(result));
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
    await waitForText(page, 'Receiver unavailable');
    assert((await persisted()).receiverEnabled === true, 'true persisted');
    assert((await trayItem(app, 'receiver-on')).checked === true, 'checkbox on');
    await app.hook(`clickTray('receiver-on')`);
    await waitForText(page, 'Receiver off');
    assert((await persisted()).receiverEnabled === false, 'false persisted');
    assert((await trayItem(app, 'receiver-on')).checked === false, 'checkbox off');
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
    await waitForText(page, 'Receiver unavailable');
    assert((await trayItem(app, 'receiver-on')).checked === true, 'tray checkbox on');
    await recordPorts(app);
  });

  await step('quit exits cleanly', () => quit(app));

  await step('~/figma-drop was not created or touched', async () => {
    const after = existsSync(realLibrary) ? statSync(realLibrary).mtimeMs : null;
    assert(after === realLibraryBefore, `before ${realLibraryBefore}, after ${after}`);
  });

  await step('neither port 3579 nor the test port was ever bound by the app', async () => {
    assert(portsSeen.size > 0, 'lsof saw the app listeners, so an absent port means something');
    assert(!portsSeen.has(REAL_PORT), `saw ${[...portsSeen].join(', ')}`);
    assert(!portsSeen.has(port), `saw ${[...portsSeen].join(', ')}`);
    log.write(`  listeners sampled at each checkpoint: ${[...portsSeen].join(', ')}`);
  });
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
  await stopTracked();
  await rm(scratch, { recursive: true, force: true });
  await mkdir(proofDir, { recursive: true });
  await writeFile(join(proofDir, 'verify-shell.txt'), `${log.lines.join('\n')}\n`);
}
process.exit(failure ? 1 : 0);
