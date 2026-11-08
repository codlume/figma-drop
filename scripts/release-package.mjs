import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  artifactNames,
  isAppleMetadataEntry,
  parseReleaseMode,
  readReleaseVersion,
} from './release-artifacts.mjs';

const APP_NAME = 'figma-drop';
const BUNDLE_ID = 'com.codlume.figma-drop';
const PLUGIN_FOLDER = 'figma-drop-figma-plugin';
const PLUGIN_FILES = ['manifest.json', 'dist/code.js', 'dist/ui.html'];
const SIGNING = 'ad-hoc signature, no Developer ID, not notarized';

const repoDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(repoDir, 'release-artifacts');
// Artifacts are written here and renamed to `outDir` only once complete, so an interrupted
// run never leaves a release-named zip in `outDir`.
const stagingDir = join(repoDir, 'release-artifacts.staging');
const builtApp = join(repoDir, 'apps/desktop/release', `${APP_NAME}.app`);
const pluginDir = join(repoDir, 'apps/figma-plugin');
const desktopBuildDir = join(repoDir, 'apps/desktop');
const BUNDLED_BUILDS = ['dist', 'dist-electron'];

const capture = (command, ...args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function withTempDir(prefix, use) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkList(artifact) {
  const passed = [];
  const expect = (ok, label, detail) => {
    if (!ok) throw new Error(`${artifact}: ${label} failed. ${detail}`);
    passed.push(label);
  };
  const equal = (label, actual, expected) =>
    expect(
      actual === expected,
      `${label} = ${expected}`,
      `Got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}.`,
    );
  const noAppleMetadata = (entries) => {
    const found = entries.filter(isAppleMetadataEntry);
    expect(
      found.length === 0,
      'zip holds no AppleDouble or Finder metadata entries',
      `Found ${found.length}, such as ${found.slice(0, 3).join(', ')}.`,
    );
  };
  return { passed, expect, equal, noAppleMetadata };
}

const zipEntries = (zipPath) => capture('zipinfo', '-1', zipPath).split('\n');

export function verifyDesktop(zipPath, version, buildDir = desktopBuildDir) {
  const { passed, expect, equal, noAppleMetadata } = checkList(zipPath);
  const entries = zipEntries(zipPath);
  noAppleMetadata(entries);
  const stray = entries.filter((entry) => !entry.startsWith(`${APP_NAME}.app/`));
  equal('zip entries outside figma-drop.app', stray.join(', '), '');
  withTempDir('figma-drop-verify-desktop-', (dir) => {
    execFileSync('ditto', ['-x', '-k', zipPath, dir]);
    equal('top entry', readdirSync(dir).join(', '), `${APP_NAME}.app`);
    const app = join(dir, `${APP_NAME}.app`);
    const plist = join(app, 'Contents/Info.plist');
    const plistValue = (key) => capture('plutil', '-extract', key, 'raw', '-o', '-', plist);
    equal('CFBundleShortVersionString', plistValue('CFBundleShortVersionString'), version);
    equal('CFBundleVersion', plistValue('CFBundleVersion'), version);
    equal('CFBundleIdentifier', plistValue('CFBundleIdentifier'), BUNDLE_ID);
    equal('CFBundleExecutable', plistValue('CFBundleExecutable'), APP_NAME);
    const executable = join(app, 'Contents/MacOS', APP_NAME);
    expect(existsSync(executable), 'bundle executable exists', `Missing ${executable}.`);
    equal('lipo -archs of the executable', capture('lipo', '-archs', executable), 'arm64');
    const appDir = join(app, 'Contents/Resources/app');
    const appPackage = JSON.parse(readFileSync(join(appDir, 'package.json')));
    equal('Contents/Resources/app/package.json version', appPackage.version, version);
    expect(
      typeof appPackage.main === 'string' && existsSync(join(appDir, appPackage.main)),
      'Contents/Resources/app/package.json main exists',
      `main is ${JSON.stringify(appPackage.main)}.`,
    );
    const rendererIndex = 'dist/renderer/index.html';
    expect(
      existsSync(join(appDir, rendererIndex)),
      `Contents/Resources/app/${rendererIndex} exists`,
      `Missing ${rendererIndex}.`,
    );
    for (const build of BUNDLED_BUILDS) {
      const diff = spawnSync('diff', ['-rq', join(buildDir, build), join(appDir, build)], {
        encoding: 'utf8',
      });
      expect(
        diff.status === 0,
        `Contents/Resources/app/${build} is byte-identical to apps/desktop/${build}`,
        `The bundle is stale. Run pnpm app:local.\n${diff.stdout}${diff.stderr}`.trim(),
      );
    }
    const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', app], {
      encoding: 'utf8',
    });
    expect(verify.status === 0, 'codesign --verify --deep --strict passes', verify.stderr.trim());
    // `codesign -dv` reports on stderr.
    const details = spawnSync('codesign', ['-dv', app], { encoding: 'utf8' }).stderr;
    expect(/^Signature=adhoc$/m.test(details), 'codesign reports Signature=adhoc', details.trim());
  });
  return passed;
}

export function verifyPlugin(zipPath) {
  const { passed, expect, equal, noAppleMetadata } = checkList(zipPath);
  const expected = PLUGIN_FILES.map((file) => `${PLUGIN_FOLDER}/${file}`).toSorted();
  // A zip entry such as `__MACOSX/` survives into Windows and non-ditto extractors, so the
  // archive listing is checked as well as the extracted tree.
  const entries = zipEntries(zipPath);
  noAppleMetadata(entries);
  const fileEntries = entries.filter((entry) => !entry.endsWith('/')).toSorted();
  equal('zip file entries', fileEntries.join(', '), expected.join(', '));
  withTempDir('figma-drop-verify-plugin-', (dir) => {
    execFileSync('ditto', ['-x', '-k', zipPath, dir]);
    const files = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
      .toSorted();
    equal('extracted files', files.join(', '), expected.join(', '));
    const root = join(dir, PLUGIN_FOLDER);
    const manifestBytes = readFileSync(join(root, 'manifest.json'));
    expect(
      manifestBytes.equals(readFileSync(join(pluginDir, 'manifest.json'))),
      'manifest.json is byte-identical to apps/figma-plugin/manifest.json',
      'The zipped manifest differs from the source.',
    );
    const manifest = JSON.parse(manifestBytes);
    for (const key of ['main', 'ui']) {
      expect(
        PLUGIN_FILES.includes(manifest[key]) && existsSync(join(root, manifest[key])),
        `manifest ${key} resolves to a zipped file`,
        `manifest.${key} is ${JSON.stringify(manifest[key])}.`,
      );
    }
    const artifactCheck = spawnSync(
      process.execPath,
      [join(pluginDir, 'scripts/check-artifacts.mjs'), join(root, 'dist')],
      { encoding: 'utf8' },
    );
    expect(
      artifactCheck.status === 0,
      'check-artifacts.mjs passes on the extracted dist',
      artifactCheck.stderr.trim(),
    );
  });
  return passed;
}

function zipPlugin(zipPath) {
  withTempDir('figma-drop-plugin-stage-', (dir) => {
    const stage = join(dir, PLUGIN_FOLDER);
    for (const file of PLUGIN_FILES) {
      mkdirSync(dirname(join(stage, file)), { recursive: true });
      cpSync(join(pluginDir, file), join(stage, file));
    }
    execFileSync('ditto', [
      '-c',
      '-k',
      '--norsrc',
      '--noextattr',
      '--noacl',
      '--keepParent',
      stage,
      zipPath,
    ]);
  });
}

function describe(name, checks) {
  const path = join(stagingDir, name);
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  return { name, bytes: statSync(path).size, sha256, checks };
}

function headline(mode, version) {
  const unsigned = `The desktop zip is unsigned (${SIGNING}).`;
  return mode.kind === 'dry-run'
    ? `Dry run of ${version}: this publishes nothing. ${unsigned}`
    : `Release ${mode.tag}: artifacts for GitHub release ${mode.tag}. ${unsigned}`;
}

function writeSummary(plan, title) {
  const lines = [
    title,
    ...plan.artifacts.map(
      (artifact) =>
        `  ${artifact.name}  ${artifact.bytes} bytes  sha256 ${artifact.sha256}  (${artifact.checks.length} checks passed)`,
    ),
    `Wrote ${outDir}`,
  ];
  console.log(lines.join('\n'));

  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const rows = plan.artifacts.map(
    (artifact) =>
      `| \`${artifact.name}\` | ${artifact.bytes} | \`${artifact.sha256}\` | ${artifact.checks.join('<br>')} |`,
  );
  const markdown = [
    '### figma-drop release artifacts',
    '',
    title,
    '',
    '| Artifact | Bytes | SHA-256 | Checks passed |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown.join('\n')}\n`);
}

function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(
      `Release packaging is macOS arm64 only, not ${process.platform} ${process.arch}.`,
    );
  }
  const mode = parseReleaseMode(process.argv.slice(2));
  const version = readReleaseVersion(repoDir);
  if (mode.kind === 'release' && mode.tag !== `v${version}`) {
    throw new Error(
      `Tag ${mode.tag} does not match the release version ${version}. Expected v${version}.`,
    );
  }
  for (const source of [builtApp, ...PLUGIN_FILES.map((file) => join(pluginDir, file))]) {
    if (!existsSync(source)) throw new Error(`Missing ${source}. Run pnpm app:local first.`);
  }

  const names = artifactNames(version, mode);
  for (const dir of [outDir, stagingDir]) rmSync(dir, { recursive: true, force: true });
  mkdirSync(stagingDir);
  try {
    const desktopZip = join(stagingDir, names.desktop);
    // `ditto` keeps the framework symlinks the signature seals, which `zip` without `-y` flattens.
    execFileSync('ditto', [
      '-c',
      '-k',
      '--norsrc',
      '--noextattr',
      '--noacl',
      '--keepParent',
      builtApp,
      desktopZip,
    ]);
    const desktopChecks = verifyDesktop(desktopZip, version);
    const pluginZip = join(stagingDir, names.plugin);
    zipPlugin(pluginZip);
    const pluginChecks = verifyPlugin(pluginZip);

    const artifacts = [
      describe(names.desktop, desktopChecks),
      describe(names.plugin, pluginChecks),
    ];
    const sums = artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}\n`).join('');
    writeFileSync(join(stagingDir, names.checksums), sums);
    const plan = {
      mode: mode.kind,
      version,
      tag: mode.kind === 'release' ? mode.tag : null,
      publishes: mode.kind === 'release' ? `GitHub release ${mode.tag}` : false,
      signing: SIGNING,
      artifacts,
    };
    writeFileSync(join(stagingDir, 'release-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    renameSync(stagingDir, outDir);
    writeSummary(plan, headline(mode, version));
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
