import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  artifactNames,
  isAppleMetadataEntry,
  parseReleaseMode,
  readReleaseVersion,
} from './release-artifacts.mjs';

const repoDir = fileURLToPath(new URL('..', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(repoDir, path), 'utf8'));

test('release-please bumps every app package.json exactly once', () => {
  const extraFiles = readJson('release-please-config.json').packages['.']['extra-files'];
  const appPackages = readdirSync(join(repoDir, 'apps'))
    .map((app) => `apps/${app}/package.json`)
    .filter((path) => existsSync(join(repoDir, path)));
  assert.ok(appPackages.length > 0, 'the repo has app packages');
  for (const path of appPackages) {
    const entries = extraFiles.filter((entry) => entry.path === path);
    assert.deepEqual(
      entries,
      [{ type: 'json', path, jsonpath: '$.version' }],
      `${path} needs one json extra-file at $.version`,
    );
  }
  for (const entry of extraFiles) {
    assert.ok(existsSync(join(repoDir, entry.path)), `extra-file ${entry.path} exists`);
  }
});

function withReleaseFixture(versions, use) {
  const {
    root,
    desktop = root,
    plugin = root,
    manifest = root,
    config = readJson('release-please-config.json'),
  } = versions;
  const dir = mkdtempSync(join(tmpdir(), 'figma-drop-release-test-'));
  try {
    const write = (path, value) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), JSON.stringify(value));
    };
    write('package.json', { version: root });
    write('apps/desktop/package.json', { version: desktop });
    write('apps/figma-plugin/package.json', { version: plugin });
    write('.release-please-manifest.json', { '.': manifest });
    write('release-please-config.json', config);
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('readReleaseVersion returns the version every file agrees on', () => {
  withReleaseFixture({ root: '1.2.3' }, (dir) => assert.equal(readReleaseVersion(dir), '1.2.3'));
});

test('readReleaseVersion names the package whose version disagrees', () => {
  withReleaseFixture({ root: '1.2.3', plugin: '1.2.4' }, (dir) =>
    assert.throws(() => readReleaseVersion(dir), /apps\/figma-plugin\/package\.json: "1\.2\.4"/),
  );
});

test('readReleaseVersion compares the release-please manifest', () => {
  withReleaseFixture({ root: '1.2.3', manifest: '1.2.4' }, (dir) =>
    assert.throws(() => readReleaseVersion(dir), /\.release-please-manifest\.json "\.": "1\.2\.4"/),
  );
});

test('readReleaseVersion rejects a shared version that is not X.Y.Z', () => {
  for (const version of ['1.2', 'v1.2.3', '1.2.3-rc.1', ' 1.2.3']) {
    withReleaseFixture({ root: version }, (dir) =>
      assert.throws(() => readReleaseVersion(dir), /one X\.Y\.Z value/, `rejects "${version}"`),
    );
  }
});

test('readReleaseVersion names the config when it lists no extra-files', () => {
  for (const config of [{}, { packages: {} }, { packages: { '.': {} } }]) {
    withReleaseFixture({ root: '1.2.3', config }, (dir) =>
      assert.throws(
        () => readReleaseVersion(dir),
        (error) => error.constructor === Error && /release-please-config\.json/.test(error.message),
        `rejects ${JSON.stringify(config)}`,
      ),
    );
  }
});

test('artifactNames for a release', () => {
  assert.deepEqual(artifactNames('1.2.3', { kind: 'release', tag: 'v1.2.3' }), {
    desktop: 'figma-drop-1.2.3-mac-arm64-unsigned.zip',
    plugin: 'figma-drop-figma-plugin-1.2.3.zip',
    checksums: 'SHA256SUMS.txt',
  });
});

test('artifactNames for a dry run mark every name', () => {
  const names = artifactNames('1.2.3', { kind: 'dry-run' });
  assert.deepEqual(names, {
    desktop: 'figma-drop-1.2.3-mac-arm64-unsigned-dry-run.zip',
    plugin: 'figma-drop-figma-plugin-1.2.3-dry-run.zip',
    checksums: 'SHA256SUMS-dry-run.txt',
  });
  for (const name of Object.values(names)) assert.match(name, /dry-run/);
});

test('parseReleaseMode accepts a dry run and both tag forms', () => {
  assert.deepEqual(parseReleaseMode(['--dry-run']), { kind: 'dry-run' });
  assert.deepEqual(parseReleaseMode(['--tag', 'v1.2.3']), { kind: 'release', tag: 'v1.2.3' });
  assert.deepEqual(parseReleaseMode(['--tag=v1.2.3']), { kind: 'release', tag: 'v1.2.3' });
});

test('parseReleaseMode rejects anything but one mode', () => {
  for (const argv of [
    [],
    ['--dry-run', '--tag', 'v1.2.3'],
    ['--tag', '1.2.3'],
    ['--tag', 'v1.2'],
    ['--tag'],
    ['--publish'],
    ['v1.2.3'],
  ]) {
    assert.throws(() => parseReleaseMode(argv), /Usage:/, `rejects ${JSON.stringify(argv)}`);
  }
});

test('isAppleMetadataEntry flags AppleDouble and Finder entries only', () => {
  for (const entry of [
    '._figma-drop.app',
    'figma-drop.app/Contents/._Info.plist',
    '__MACOSX/',
    '__MACOSX/figma-drop.app/._Contents',
    'figma-drop.app/.DS_Store',
    '.DS_Store',
  ]) {
    assert.equal(isAppleMetadataEntry(entry), true, `flags ${entry}`);
  }
  for (const entry of [
    'figma-drop.app/',
    'figma-drop.app/Contents/Info.plist',
    'figma-drop-figma-plugin/dist/ui.html',
    'figma-drop.app/Contents/Resources/app/dist/a._b.js',
    'figma-drop.app/Contents/Resources/x__MACOSX/y',
    'figma-drop.app/.DS_Store.bak',
  ]) {
    assert.equal(isAppleMetadataEntry(entry), false, `keeps ${entry}`);
  }
});
