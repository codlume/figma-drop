import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  App,
  assert,
  createLog,
  desktopDir,
  freePort,
  launchBundle,
  refusesConnection,
  repoDir,
  stopTracked,
  waitUntil,
} from './driver.mjs';

// A packaged app reads no environment, so nothing but the home directory can move its library, and
// `app.getPath('home')` ignores HOME on macOS and follows CFFIXED_USER_HOME. The real bundle runs
// only after a probe on the same binary shows that both variables together keep it in scratch.
const PROBE_TIMEOUT_MS = 30_000;
const QUIT_DEADLINE_MS = 4_000;
const REAL_PORT = 3579;
const SIDE_EFFECT_DEPTH = 3;
const HOSTS = ['127.0.0.1', '::1'];
const RENDERED = `!!document.querySelector('[role=switch]') && !!document.querySelector('nav [role=listbox]')`;

// Everything the app could write under a home it failed to leave. Each is only ever stat'ed.
const REAL_STATE = [
  'figma-drop',
  'Library/Application Support/figma-drop',
  'Library/Caches/com.codlume.figma-drop',
  'Library/Caches/figma-drop',
  'Library/HTTPStorages/com.codlume.figma-drop',
  'Library/Preferences/com.codlume.figma-drop.plist',
  'Library/Saved Application State/com.codlume.figma-drop.savedState',
];

const execFileAsync = promisify(execFile);
const log = createLog();
const appOutput = [];
App.log = (line) => appOutput.push(line);
const bundle = join(desktopDir, 'release/figma-drop.app');
const bundleBinary = join(bundle, 'Contents/MacOS/figma-drop');
const appDir = join(bundle, 'Contents/Resources/app');
const electronPath = createRequire(join(desktopDir, 'package.json'))('electron');
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'figma-drop-bundle-')));
// The account's home, which a HOME set around this script would hide.
const realHome = userInfo().homedir;

// The receiver lands separately, and with it a launched app reads differently.
const hasIngest = existsSync(join(desktopDir, 'src/ingest/receiver-controller.ts'));

const PROBE = `
const { app, BrowserWindow, utilityProcess } = require('electron');
const { join } = require('node:path');

app.setPath('userData', process.env.PROBE_USER_DATA);
const report = {
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  home: app.getPath('home'),
  appData: app.getPath('appData'),
};
const finish = () => {
  console.log('PROBE ' + JSON.stringify(report));
  app.exit(0);
};

if (process.env.PROBE_PATHS_ONLY) finish();
else app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(__dirname, 'dist-electron/preload.cjs') },
  });
  await window.loadFile(join(__dirname, 'dist/renderer/index.html'));
  report.page = await window.webContents.executeJavaScript(\`({
    rendered: document.getElementById('root').childElementCount > 0,
    bridge: typeof window.figmaDrop,
    sheets: document.styleSheets.length,
  })\`);
  const child = utilityProcess.fork(join(__dirname, 'probe-utility.cjs'));
  report.utility = await new Promise((resolve) => child.once('message', resolve));
  finish();
});
`;

async function step(label, run) {
  await run();
  log.write(`PASS ${label}`);
}

async function preflight(label, run) {
  try {
    await step(`preflight: ${label}`, run);
  } catch (error) {
    throw new Error(`preflight aborted, nothing launched: ${error.message}`);
  }
}

const realState = () =>
  Object.fromEntries(
    REAL_STATE.map((path) => [
      path,
      statSync(join(realHome, path), { throwIfNoEntry: false })?.mtimeMs ?? null,
    ]),
  );

const staysInScratch = async (seen, home) =>
  (await realpath(seen.home)) === home &&
  seen.appData === join(seen.home, 'Library/Application Support');

async function sideEffects(home) {
  const entries = await readdir(home, { recursive: true, withFileTypes: true });
  const paths = entries.map((entry) =>
    join(entry.parentPath, entry.name).slice(home.length + sep.length),
  );
  const shallow = paths.filter((path) => path.split(sep).length <= SIDE_EFFECT_DEPTH);
  return { shallow: shallow.toSorted(), total: paths.length };
}

async function runProbe(binary, args, env) {
  const clean = { ...process.env, ...env, PROBE_USER_DATA: join(scratch, 'probe-user-data') };
  delete clean.ELECTRON_RUN_AS_NODE;
  const { stdout } = await execFileAsync(binary, args, { env: clean, timeout: PROBE_TIMEOUT_MS });
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('PROBE '));
  assert(line, `the probe reported, got ${stdout}`);
  return JSON.parse(line.slice('PROBE '.length));
}

async function main() {
  assert(existsSync(bundle), 'run pnpm app:local first');

  await step('Info.plist names figma-drop and the renamed executable', async () => {
    const { stdout } = await execFileAsync('plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      join(bundle, 'Contents/Info.plist'),
    ]);
    const info = JSON.parse(stdout);
    assert(info.CFBundleName === 'figma-drop', `name ${info.CFBundleName}`);
    assert(info.CFBundleDisplayName === 'figma-drop', `display ${info.CFBundleDisplayName}`);
    assert(info.CFBundleIdentifier === 'com.codlume.figma-drop', info.CFBundleIdentifier);
    assert(info.CFBundleExecutable === 'figma-drop', `executable ${info.CFBundleExecutable}`);
    const { version } = JSON.parse(await readFile(join(desktopDir, 'package.json'), 'utf8'));
    assert(info.CFBundleShortVersionString === version, info.CFBundleShortVersionString);
    assert(info.CFBundleVersion === version, info.CFBundleVersion);
    assert(!('ElectronAsarIntegrity' in info), 'no hash for the removed default_app.asar');
  });

  await step('the bundle holds the current build and no default app', async () => {
    const resources = join(bundle, 'Contents/Resources');
    assert(!existsSync(join(resources, 'default_app.asar')), 'default_app.asar removed');
    for (const name of ['package.json', 'dist-electron/main.cjs', 'dist-electron/preload.cjs']) {
      const [packaged, built] = await Promise.all([
        readFile(join(appDir, name)),
        readFile(join(desktopDir, name)),
      ]);
      assert(packaged.equals(built), `${name} matches the current build`);
    }
    const packed = existsSync(join(appDir, 'dist-electron/receiver.cjs'));
    assert(packed === hasIngest, `receiver.cjs ${packed}, src/ingest ${hasIngest}`);
  });

  await step('the binary is arm64 with a valid ad-hoc signature and no identity', async () => {
    const { stdout: archs } = await execFileAsync('lipo', ['-archs', bundleBinary]);
    assert(archs.trim() === 'arm64', `archs ${archs}`);
    await execFileAsync('codesign', ['--verify', '--deep', '--strict', bundle]);
    const { stderr } = await execFileAsync('codesign', ['-dv', bundle]);
    assert(stderr.includes('Signature=adhoc'), `signature ${stderr}`);
    assert(stderr.includes('TeamIdentifier=not set'), `team ${stderr}`);
  });

  const copy = join(scratch, 'probe.app');
  const copyApp = join(copy, 'Contents/Resources/app');
  const copyBinary = join(copy, 'Contents/MacOS/figma-drop');
  await execFileAsync('ditto', [bundle, copy]);
  const manifest = JSON.parse(await readFile(join(copyApp, 'package.json'), 'utf8'));
  await writeFile(
    join(copyApp, 'package.json'),
    JSON.stringify({ ...manifest, main: 'probe.cjs', type: 'commonjs' }),
  );
  await writeFile(join(copyApp, 'probe.cjs'), PROBE);
  await writeFile(
    join(copyApp, 'probe-utility.cjs'),
    `process.parentPort.postMessage('utility ran');\n`,
  );

  await step('RECORDED: whether HOME alone moves app.getPath, on unbundled Electron', async () => {
    const home = join(scratch, 'home-only');
    await mkdir(home);
    const seen = await runProbe(electronPath, [copyApp], { HOME: home, PROBE_PATHS_ONLY: '1' });
    log.write(`  HOME alone moved app.getPath('home'): ${seen.home.startsWith(home)}`);
    log.write(`  HOME alone moved app.getPath('appData'): ${seen.appData.startsWith(home)}`);
    assert(!(await staysInScratch(seen, home)), 'the preflight check rejects HOME alone');
  });

  await step('a scratch copy of the bundle launches a probe with app.isPackaged true', async () => {
    const home = join(scratch, 'home');
    await mkdir(home);
    const seen = await runProbe(copyBinary, [], {
      HOME: home,
      CFFIXED_USER_HOME: home,
    });
    log.write(
      `  probe saw ${JSON.stringify({ ...seen, execPath: undefined, home: undefined, appData: undefined })}`,
    );
    assert(seen.isPackaged === true, `isPackaged ${seen.isPackaged}`);
    assert(seen.execPath.startsWith(copy), 'the copy ran, not another Electron');
    assert((await realpath(seen.home)) === home, 'the probe stayed in the scratch home');
    assert(seen.page.rendered, 'the real page rendered under its CSP from the bundle layout');
    assert(seen.page.bridge === 'object', 'the real preload exposed the bridge');
    assert(seen.page.sheets > 0, 'the real stylesheet loaded');
    assert(seen.utility === 'utility ran', `utilityProcess replied ${seen.utility}`);
  });

  await launchTheRealBundle(copyBinary);

  log.write('NOT RUN a Finder double-click: the proof executes the binary directly');
}

async function launchTheRealBundle(copyBinary) {
  const home = join(scratch, 'launch-home');
  const library = join(home, 'figma-drop');
  const userData = join(home, 'Library/Application Support/figma-drop');
  const planted = {
    library: join(scratch, 'planted-library'),
    userData: join(scratch, 'planted-user-data'),
    port: await freePort(),
  };
  const env = {
    HOME: home,
    CFFIXED_USER_HOME: home,
    FIGMA_DROP_LIBRARY: planted.library,
    FIGMA_DROP_USER_DATA: planted.userData,
    FIGMA_DROP_PORT: String(planted.port),
    FIGMA_DROP_TEST: '1',
  };
  await mkdir(home);
  const realBefore = realState();

  await preflight('the probe copy runs the same binary as the bundle', async () => {
    const [copied, shipped] = await Promise.all([readFile(copyBinary), readFile(bundleBinary)]);
    assert(copied.equals(shipped), 'the probe binary differs from the bundle binary');
  });
  await preflight("that env moves app.getPath('home') and 'appData' into scratch", async () => {
    const seen = await runProbe(copyBinary, [], { ...env, PROBE_PATHS_ONLY: '1' });
    assert(seen.isPackaged === true, `isPackaged ${seen.isPackaged}`);
    assert(await staysInScratch(seen, home), 'app.getPath left the scratch home');
  });
  await preflight(`nothing listens on ${REAL_PORT}`, async () => {
    for (const host of HOSTS) {
      assert(await refusesConnection(host, REAL_PORT), `${host}:${REAL_PORT} is taken`);
    }
  });

  const app = launchBundle(bundleBinary, env);
  const page = await app.page();
  const errors = await page.collectErrors();
  const receiverStatus = () => page.evaluate('window.figmaDrop.receiver.getStatus()');

  await step("the running process is the bundle's own binary", async () => {
    const { stdout } = await execFileAsync('lsof', [
      '-nP',
      '-a',
      '-p',
      String(app.child.pid),
      '-d',
      'txt',
      '-Fn',
    ]);
    const image = stdout.split('\n').find((line) => line.startsWith('n'));
    assert(image === `n${bundleBinary}`, `the process image is ${image}`);
  });

  await step('the real App rendered from the bundle with no CSP or page errors', async () => {
    await waitUntil(() => page.evaluate(RENDERED), 'the library list and the receiver switch');
    // The first load began before the collector attached, so a load runs again in full view of it.
    await page.evaluate('window.beforeReload = true');
    await page.call('Page.reload');
    await waitUntil(
      () => page.evaluate(`!window.beforeReload && ${RENDERED}`),
      'the reloaded page to render',
    );
    const url = pathToFileURL(join(appDir, 'dist/renderer/index.html')).href;
    assert((await page.evaluate('location.href')) === url, 'the page is the bundled index.html');
    assert(errors.length === 0, `page errors: ${errors.join(' | ')}`);
  });

  await step('the CSP is live, so the empty error list above means something', async () => {
    await page.evaluate(`(() => {
      const script = document.createElement('script');
      script.textContent = 'window.cspLetThisRun = true';
      document.head.append(script);
    })()`);
    await waitUntil(() => errors.length > 0, 'the CSP to report the inline script');
    assert(errors[0].includes('Content Security Policy'), `reported: ${errors[0]}`);
    assert((await page.evaluate('window.cspLetThisRun')) === undefined, 'the inline script ran');
  });

  await step('main opened the library at <scratch>/figma-drop, not the planted root', async () => {
    const snapshot = await page.evaluate('window.figmaDrop.library.getSnapshot()');
    assert(snapshot.state === 'ready', `library ${snapshot.state}`);
    assert(existsSync(library), 'the library root exists in the scratch home');
    assert(existsSync(userData), 'user data is in the scratch home');
    assert(!existsSync(planted.library), 'FIGMA_DROP_LIBRARY was honoured');
    assert(!existsSync(planted.userData), 'FIGMA_DROP_USER_DATA was honoured');
  });

  const expected = hasIngest ? 'listening' : 'unavailable';
  await step(`the receiver reads ${expected}, as src/ingest decides`, async () => {
    await waitUntil(async () => (await receiverStatus()).state === expected, expected);
    const ports = await app.listeningPorts();
    assert(!ports.includes(planted.port), 'FIGMA_DROP_PORT was honoured');
    if (!hasIngest) {
      assert(!ports.includes(REAL_PORT), `port ${REAL_PORT} is bound without a receiver`);
      return;
    }
    assert((await receiverStatus()).port === REAL_PORT, 'the receiver is on the real port');
    assert(ports.includes(REAL_PORT), `the app holds port ${REAL_PORT}`);
    for (const host of ['127.0.0.1', '[::1]']) {
      const reply = await fetch(`http://${host}:${REAL_PORT}/`);
      assert(reply.ok, `GET / on ${host} replied ${reply.status}`);
      log.write(`  GET / on ${host} replied ${reply.status}: ${await reply.text()}`);
    }
  });

  page.close();
  await step('quit exits 0 by itself, with no process left and no SIGKILL', async () => {
    process.kill(app.child.pid, 'SIGTERM');
    const exit = await app.exitWithin(QUIT_DEADLINE_MS);
    assert(exit?.code === 0 && exit.signal === null, `exit ${JSON.stringify(exit)}`);
    await waitUntil(() => {
      try {
        process.kill(-app.child.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 'the helper processes to exit');
    assert((await stopTracked()) === false, 'a process needed SIGKILL');
  });

  await step('the real home is unchanged and the bundle still verifies', async () => {
    const realAfter = realState();
    for (const path of REAL_STATE) {
      assert(realAfter[path] === realBefore[path], `~/${path} changed`);
    }
    await execFileAsync('codesign', ['--verify', '--deep', '--strict', bundle]);
  });

  const { shallow, total } = await sideEffects(home);
  log.write(`  the run left ${total} entries in the scratch home, to depth ${SIDE_EFFECT_DEPTH}:`);
  for (const path of shallow) log.write(`    ${path}`);
}

let failure = null;
try {
  await main();
  log.write('ALL PASS for the steps that ran');
} catch (error) {
  failure = error;
  log.write(`FAIL ${error.message}`);
  console.error(appOutput.join('\n'));
} finally {
  await stopTracked();
  await rm(scratch, { recursive: true, force: true });
  await writeFile(join(repoDir, 'proof/shell/verify-bundle.txt'), `${log.lines.join('\n')}\n`);
}
process.exit(failure ? 1 : 0);
