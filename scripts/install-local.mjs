import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const built = fileURLToPath(new URL('../apps/desktop/release/figma-drop.app', import.meta.url));
const applications = join(homedir(), 'Applications');
const installed = join(applications, 'figma-drop.app');
const staged = join(applications, '.figma-drop.app.installing');

const bundleId = (app) =>
  execFileSync(
    'plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Contents/Info.plist')],
    { encoding: 'utf8' },
  ).trim();

if (existsSync(installed) && bundleId(installed) !== bundleId(built)) {
  throw new Error(`${installed} is not a figma-drop bundle, so it stays in place.`);
}

mkdirSync(applications, { recursive: true });
rmSync(staged, { recursive: true, force: true });
// `ditto` keeps the framework symlinks and the signature that a plain recursive copy would break.
execFileSync('ditto', [built, staged]);
rmSync(installed, { recursive: true, force: true });
renameSync(staged, installed);
console.log(installed);
