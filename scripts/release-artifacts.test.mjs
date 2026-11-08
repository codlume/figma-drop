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

import { artifactNames, parseReleaseMode, readReleaseVersion } from './release-artifacts.mjs';

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

test('readReleaseVersion returns the release-please manifest version', () => {
  assert.equal(readReleaseVersion(repoDir), readJson('.release-please-manifest.json')['.']);
});

test('readReleaseVersion names the package whose version disagrees', () => {
  const dir = mkdtempSync(join(tmpdir(), 'figma-drop-release-test-'));
  try {
    const write = (path, value) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), JSON.stringify(value));
    };
    write('package.json', { version: '1.2.3' });
    write('apps/desktop/package.json', { version: '1.2.3' });
    write('apps/figma-plugin/package.json', { version: '1.2.4' });
    write('.release-please-manifest.json', { '.': '1.2.3' });
    assert.throws(() => readReleaseVersion(dir), /apps\/figma-plugin\/package\.json: "1\.2\.4"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
