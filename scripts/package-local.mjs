import { execFileSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { notarize } from './notary.mjs';
import { NOTARY_LOGS } from './release-artifacts.mjs';
import { entitlementProblems, readEntitlements, signingFromEnv } from './signing.mjs';

const APP_NAME = 'figma-drop';
const BUNDLE_ID = 'com.codlume.figma-drop';
const MACH_O_MAGICS = new Set([0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface, 0xcafebabe]);

const repoDir = fileURLToPath(new URL('..', import.meta.url));
const desktopDir = join(repoDir, 'apps/desktop');
const releaseDir = join(desktopDir, 'release');
const stagingDir = join(releaseDir, '.staging');
const stagedApp = join(stagingDir, `${APP_NAME}.app`);
const finalApp = join(releaseDir, `${APP_NAME}.app`);
const entitlements = join(desktopDir, 'entitlements.mac.plist');
const appNotaryLog = join(releaseDir, NOTARY_LOGS.app);
const { version } = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'));

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`The local app is macOS arm64 only, not ${process.platform} ${process.arch}.`);
}
const signing = signingFromEnv(process.env);

const run = (command, ...args) => execFileSync(command, args, { stdio: 'inherit' });
const plist = join(stagedApp, 'Contents/Info.plist');
const setPlistString = (key, value) => run('plutil', '-replace', key, '-string', value, plist);

// Requiring `electron` under Node returns the binary path, and downloads the binary if it is absent.
const electronBinary = createRequire(join(desktopDir, 'package.json'))('electron');
const electronApp = dirname(dirname(dirname(electronBinary)));

// A failed build leaves no app and no notary log behind, so neither can be mistaken for this one.
for (const path of [stagingDir, finalApp, appNotaryLog]) {
  rmSync(path, { recursive: true, force: true });
}
mkdirSync(stagingDir, { recursive: true });
// `ditto` keeps the framework symlinks that a plain recursive copy would flatten.
run('ditto', electronApp, stagedApp);

const resources = join(stagedApp, 'Contents/Resources');
rmSync(join(resources, 'default_app.asar'));
const appDir = join(resources, 'app');
mkdirSync(appDir);
cpSync(join(desktopDir, 'package.json'), join(appDir, 'package.json'));
cpSync(join(desktopDir, 'dist'), join(appDir, 'dist'), { recursive: true });
cpSync(join(desktopDir, 'dist-electron'), join(appDir, 'dist-electron'), { recursive: true });

// Electron derives `app.isPackaged` from this file name. Left as `Electron`, the app reads as a
// development build and uses the development library and port.
renameSync(join(stagedApp, 'Contents/MacOS/Electron'), join(stagedApp, 'Contents/MacOS', APP_NAME));
setPlistString('CFBundleExecutable', APP_NAME);
setPlistString('CFBundleName', APP_NAME);
setPlistString('CFBundleDisplayName', APP_NAME);
setPlistString('CFBundleIdentifier', BUNDLE_ID);
setPlistString('CFBundleShortVersionString', version);
setPlistString('CFBundleVersion', version);
// This hash describes the `default_app.asar` removed above.
run('plutil', '-remove', 'ElectronAsarIntegrity', plist);

// Electron ships a linker signature with no sealed resources, which `codesign --verify` rejects
// even before these edits, so the whole bundle is signed again.
if (signing.mode === 'ad-hoc') {
  run('codesign', '--force', '--deep', '--sign', '-', stagedApp);
  run('codesign', '--verify', '--deep', '--strict', stagedApp);
} else {
  const code = signInsideOut(stagedApp, signing.identity);
  const problems = entitlementProblems(
    code.map(({ path, app }) => ({ path, app, entitlements: readEntitlements(path) })),
  );
  if (problems.length > 0) throw new Error(`Wrong entitlements:\n${problems.join('\n')}`);
  run('codesign', '--verify', '--deep', '--strict', stagedApp);
  notarizeApp(stagedApp, signing.notary);
}

renameSync(stagedApp, finalApp);
rmSync(stagingDir, { recursive: true, force: true });
console.log(`Built ${finalApp}`);

// `codesign --deep` skips Mach-O files outside the standard nested-code locations, such as
// Squirrel's ShipIt and Electron's bundled dylibs, and notarization rejects them unsigned. So each
// one is signed on its own, deepest first, and every bundle after everything inside it.
function signInsideOut(app, identity) {
  const nested = readdirSync(app, { recursive: true, withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory()
        ? /\.(app|framework)$/.test(entry.name)
        : entry.isFile() && isMachO(join(entry.parentPath, entry.name)),
    )
    .map((entry) => ({
      path: join(entry.parentPath, entry.name),
      app: entry.name.endsWith('.app'),
    }))
    .toSorted((a, b) => b.path.split('/').length - a.path.split('/').length);
  const code = [...nested, { path: app, app: true }];
  for (const { path, app: isApp } of code) {
    run(
      'codesign',
      '--force',
      '--options',
      'runtime',
      '--timestamp',
      ...(isApp ? ['--entitlements', entitlements] : []),
      '--sign',
      identity,
      path,
    );
  }
  return code;
}

function isMachO(path) {
  const header = Buffer.alloc(4);
  const fd = openSync(path, 'r');
  try {
    return readSync(fd, header, 0, 4, 0) === 4 && MACH_O_MAGICS.has(header.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
}

// Apple notarizes a zip of the app. The ticket is stapled to the app itself.
function notarizeApp(app, notary) {
  const dir = mkdtempSync(join(tmpdir(), 'figma-drop-notarize-'));
  try {
    const zip = join(dir, `${APP_NAME}.zip`);
    run('ditto', '-c', '-k', '--keepParent', app, zip);
    notarize({ submission: zip, stapleTarget: app, notary, logPath: appNotaryLog });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
