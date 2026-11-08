import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = fileURLToPath(new URL('..', import.meta.url));
const requirementsFile = join(repoDir, 'scripts/dmgbuild-requirements.txt');
const artworkDir = join(repoDir, 'apps/desktop/dmg');
// node_modules is already ignored by git, the formatter, and the linter.
export const DMGBUILD_VENV = join(repoDir, 'node_modules/.cache/figma-drop-dmgbuild');
const venvPython = join(DMGBUILD_VENV, 'bin/python3');
const installedStamp = join(DMGBUILD_VENV, 'figma-drop-requirements.sha256');
const MIN_PYTHON = [3, 10];
export const SETUP_COMMAND = 'node scripts/dmg.mjs --setup';

export const DMG_FORMAT = 'UDZO';
export const APPLICATIONS_LINK = '/Applications';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const sha256File = (path) => sha256(readFileSync(path));

function dmgbuildInstalled() {
  if (!existsSync(installedStamp)) return false;
  if (readFileSync(installedStamp, 'utf8') !== sha256File(requirementsFile)) return false;
  return spawnSync(venvPython, ['-I', '-c', 'import dmgbuild'], { stdio: 'ignore' }).status === 0;
}

export function dmgbuildMissingReason() {
  return dmgbuildInstalled()
    ? null
    : `dmgbuild is not installed in ${DMGBUILD_VENV}. Run ${SETUP_COMMAND}.`;
}

// Installs the hash-pinned dmgbuild into a private venv. A run that finds the same requirements
// already installed touches nothing and needs no network, and the stamp is written last, so an
// interrupted install is redone from scratch.
export function setupDmgbuild() {
  if (dmgbuildInstalled()) {
    console.log(`dmgbuild is already installed in ${DMGBUILD_VENV}.`);
    return;
  }
  const python = spawnSync(
    'python3',
    ['-I', '-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'],
    { encoding: 'utf8' },
  );
  const [major, minor] = (python.stdout ?? '').trim().split(' ').map(Number);
  if (python.status !== 0 || major !== MIN_PYTHON[0] || minor < MIN_PYTHON[1]) {
    throw new Error(
      `dmgbuild needs python3 ${MIN_PYTHON.join('.')} or later on PATH. Found ${python.stdout?.trim() || 'none'}.`,
    );
  }
  rmSync(DMGBUILD_VENV, { recursive: true, force: true });
  execFileSync('python3', ['-I', '-m', 'venv', DMGBUILD_VENV], { stdio: 'inherit' });
  execFileSync(
    venvPython,
    [
      '-I',
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--no-input',
      '--require-hashes',
      '--only-binary=:all:',
      '--no-deps',
      '-r',
      requirementsFile,
    ],
    { stdio: 'inherit' },
  );
  writeFileSync(installedStamp, sha256File(requirementsFile));
  if (!dmgbuildInstalled()) throw new Error(`dmgbuild did not import from ${DMGBUILD_VENV}.`);
  console.log(`Installed dmgbuild into ${DMGBUILD_VENV}.`);
}

const layout = JSON.parse(readFileSync(join(artworkDir, 'layout.json'), 'utf8'));

// dmgbuild takes Python tuples where JSON has arrays, and its settings file form would execute
// Python, so the settings travel as JSON on stdin.
const BUILD_PROGRAM = `
import json, sys
from dmgbuild import build_dmg
spec = json.load(sys.stdin)
settings = spec["settings"]
settings["window_rect"] = tuple(tuple(pair) for pair in settings["window_rect"])
settings["icon_locations"] = {name: tuple(xy) for name, xy in settings["icon_locations"].items()}
build_dmg(spec["filename"], spec["volume_name"], settings=settings)
`;

// Builds a read-only compressed image holding the app, an Applications link, and the Finder
// layout. dmgbuild copies the app with ditto and ignores its exit status, so callers verify the
// result with verifyDesktopDmg.
export function buildDmg({ app, dmg, volumeName, icon }) {
  const missing = dmgbuildMissingReason();
  if (missing) throw new Error(missing);
  const { width, height } = layout.window;
  const appName = basename(app);
  const icons = {
    [appName]: layout.icons['figma-drop.app'],
    Applications: layout.icons.Applications,
  };
  const spec = {
    filename: dmg,
    volume_name: volumeName,
    settings: {
      format: DMG_FORMAT,
      filesystem: 'HFS+',
      files: [app],
      symlinks: { Applications: APPLICATIONS_LINK },
      icon: icon ?? null,
      background: join(artworkDir, 'background.png'),
      window_rect: [
        [200, 120],
        [width, height],
      ],
      default_view: 'icon-view',
      icon_size: layout.iconSize,
      text_size: layout.textSize,
      icon_locations: Object.fromEntries(
        Object.entries(icons).map(([name, { x, y }]) => [name, [x, y]]),
      ),
      show_status_bar: false,
      show_tab_view: false,
      show_toolbar: false,
      show_pathbar: false,
      show_sidebar: false,
    },
  };
  rmSync(dmg, { force: true });
  // DITTONORSRC would make dmgbuild's ditto drop extended attributes from the copied app.
  const { DITTONORSRC: _, ...env } = process.env;
  execFileSync(venvPython, ['-I', '-c', BUILD_PROGRAM], {
    input: JSON.stringify(spec),
    stdio: ['pipe', 'inherit', 'inherit'],
    env,
  });
}

const plistJson = (bytes) =>
  JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: bytes }));

export function dmgFormat(dmg) {
  const info = execFileSync('hdiutil', ['imageinfo', '-plist', dmg], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return plistJson(info).Format;
}

// Attaches the image read-only at a private mountpoint, hidden from Finder, and always detaches.
// The temporary directory is removed with rmdir, which can never recurse into a volume that is
// still mounted.
export function withAttachedDmg(dmg, use) {
  const dir = mkdtempSync(join(tmpdir(), 'figma-drop-dmg-'));
  const volume = join(dir, 'volume');
  try {
    execFileSync(
      'hdiutil',
      ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', volume, dmg],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const result = use(volume);
    if (!release(volume, dir)) {
      throw new Error(`Could not detach ${volume}. Run hdiutil detach -force on it.`);
    }
    return result;
  } catch (error) {
    release(volume, dir);
    throw error;
  }
}

// Detaches the volume, forcing it if a plain detach fails, then removes the empty mountpoint and
// its directory. Returns false while the volume stays mounted.
function release(volume, dir) {
  const mounted = () => existsSync(volume) && statSync(volume).dev !== statSync(dir).dev;
  for (const args of [
    ['detach', volume],
    ['detach', '-force', volume],
  ]) {
    if (!mounted()) break;
    spawnSync('hdiutil', args, { stdio: 'ignore' });
  }
  if (mounted()) return false;
  if (existsSync(volume)) rmdirSync(volume);
  if (existsSync(dir)) rmdirSync(dir);
  return true;
}

if (import.meta.main) {
  try {
    if (process.argv[2] !== '--setup' || process.argv.length !== 3) {
      throw new Error(`Usage: ${SETUP_COMMAND}`);
    }
    setupDmgbuild();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
