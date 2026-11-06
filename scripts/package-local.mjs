import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_NAME = 'figma-drop';
const BUNDLE_ID = 'com.codlume.figma-drop';

const repoDir = fileURLToPath(new URL('..', import.meta.url));
const desktopDir = join(repoDir, 'apps/desktop');
const releaseDir = join(desktopDir, 'release');
const stagingDir = join(releaseDir, '.staging');
const stagedApp = join(stagingDir, `${APP_NAME}.app`);
const finalApp = join(releaseDir, `${APP_NAME}.app`);

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`The local app is macOS arm64 only, not ${process.platform} ${process.arch}.`);
}

const run = (command, ...args) => execFileSync(command, args, { stdio: 'inherit' });
const plist = join(stagedApp, 'Contents/Info.plist');
const setPlistString = (key, value) => run('plutil', '-replace', key, '-string', value, plist);

// Requiring `electron` under Node returns the binary path, and downloads the binary if it is absent.
const electronBinary = createRequire(join(desktopDir, 'package.json'))('electron');
const electronApp = dirname(dirname(dirname(electronBinary)));

rmSync(stagingDir, { recursive: true, force: true });
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
// This hash describes the `default_app.asar` removed above.
run('plutil', '-remove', 'ElectronAsarIntegrity', plist);

// Ad-hoc, for local arm64 execution: no identity and no notarization. Electron ships a linker
// signature with no sealed resources, which `codesign --verify` rejects even before these edits.
run('codesign', '--force', '--deep', '--sign', '-', stagedApp);
run('codesign', '--verify', '--deep', '--strict', stagedApp);

rmSync(finalApp, { recursive: true, force: true });
renameSync(stagedApp, finalApp);
rmSync(stagingDir, { recursive: true, force: true });
console.log(`Built ${finalApp}`);
