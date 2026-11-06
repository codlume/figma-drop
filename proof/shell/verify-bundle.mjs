import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { assert, createLog, desktopDir, repoDir } from './driver.mjs';

// The real bundle is never launched here. `app.getPath('home')` ignores HOME on macOS, so its
// `main.cjs` would open the real `~/figma-drop`. A scratch copy runs a probe entry point instead,
// which proves the runtime and layout around that code and runs none of it.
const PROBE_TIMEOUT_MS = 30_000;

const execFileAsync = promisify(execFile);
const log = createLog();
const bundle = join(desktopDir, 'release/figma-drop.app');
const appDir = join(bundle, 'Contents/Resources/app');
const electronPath = createRequire(join(desktopDir, 'package.json'))('electron');
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'figma-drop-bundle-')));

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
  });

  await step('the binary is arm64 with a valid ad-hoc signature and no identity', async () => {
    const binary = join(bundle, 'Contents/MacOS/figma-drop');
    const { stdout: archs } = await execFileAsync('lipo', ['-archs', binary]);
    assert(archs.trim() === 'arm64', `archs ${archs}`);
    await execFileAsync('codesign', ['--verify', '--deep', '--strict', bundle]);
    const { stderr } = await execFileAsync('codesign', ['-dv', bundle]);
    assert(stderr.includes('Signature=adhoc'), `signature ${stderr}`);
    assert(stderr.includes('TeamIdentifier=not set'), `team ${stderr}`);
  });

  const copy = join(scratch, 'probe.app');
  const copyApp = join(copy, 'Contents/Resources/app');
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
  });

  await step('a scratch copy of the bundle launches a probe with app.isPackaged true', async () => {
    const home = join(scratch, 'home');
    await mkdir(home);
    const seen = await runProbe(join(copy, 'Contents/MacOS/figma-drop'), [], {
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

  log.write("NOT RUN the bundle's own main.cjs: it was never launched from the bundle");
  log.write('NOT RUN so resolveRuntime picking ~/figma-drop and 3579 is proven by unit test only');
}

let failure = null;
try {
  await main();
  log.write('ALL PASS for the steps that ran');
} catch (error) {
  failure = error;
  log.write(`FAIL ${error.message}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
  await writeFile(join(repoDir, 'proof/shell/verify-bundle.txt'), `${log.lines.join('\n')}\n`);
}
process.exit(failure ? 1 : 0);
