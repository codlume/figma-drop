import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildDmg, dmgbuildMissingReason } from './dmg.mjs';
import { checksumsText, describeArtifact, verifyDesktopDmg } from './release-package.mjs';
import { entitlementProblems, readEntitlements } from './signing.mjs';

const repoDir = fileURLToPath(new URL('..', import.meta.url));
const VERSION = '1.2.3';
const hasCompiler = () => spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0;
const skip =
  process.platform !== 'darwin'
    ? 'DMGs are built on macOS only.'
    : (dmgbuildMissingReason() ?? (hasCompiler() ? false : 'cc is missing, so no fixture app.'));

// A minimal ad-hoc-signed figma-drop.app that passes the release checks, with the build output
// it bundles beside it.
function makeFixture(dir) {
  const buildDir = join(dir, 'build');
  const files = {
    'package.json': JSON.stringify({ version: VERSION, main: 'dist-electron/main.cjs' }),
    'dist/renderer/index.html': '<!doctype html><title>figma-drop</title>\n',
    'dist-electron/main.cjs': 'module.exports = {};\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(buildDir, path, '..'), { recursive: true });
    writeFileSync(join(buildDir, path), text);
  }
  const app = join(dir, 'app/figma-drop.app');
  const contents = join(app, 'Contents');
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  mkdirSync(join(contents, 'Resources'), { recursive: true });
  cpSync(buildDir, join(contents, 'Resources/app'), { recursive: true });
  writeFileSync(join(dir, 'main.c'), 'int main(void) { return 0; }\n');
  execFileSync('cc', [
    '-arch',
    'arm64',
    '-o',
    join(contents, 'MacOS/figma-drop'),
    join(dir, 'main.c'),
  ]);
  execFileSync(
    'sips',
    [
      '-z',
      '128',
      '128',
      join(repoDir, 'apps/desktop/dmg/background.png'),
      '--out',
      join(dir, 'icon.png'),
    ],
    { stdio: 'ignore' },
  );
  execFileSync(
    'sips',
    [
      '-s',
      'format',
      'icns',
      join(dir, 'icon.png'),
      '--out',
      join(contents, 'Resources/figma-drop.icns'),
    ],
    {
      stdio: 'ignore',
    },
  );
  const plist = {
    CFBundleExecutable: 'figma-drop',
    CFBundleIdentifier: 'com.codlume.figma-drop',
    CFBundleName: 'figma-drop',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: VERSION,
    CFBundleVersion: VERSION,
    CFBundleIconFile: 'figma-drop',
  };
  writeFileSync(join(contents, 'Info.plist'), JSON.stringify(plist));
  execFileSync('plutil', ['-convert', 'xml1', join(contents, 'Info.plist')]);
  execFileSync(
    'codesign',
    [
      '--force',
      '--sign',
      '-',
      '--entitlements',
      join(repoDir, 'apps/desktop/entitlements.mac.plist'),
      app,
    ],
    { stdio: 'ignore' },
  );
  return { app, buildDir };
}

function attached(dmg, flags, use) {
  const dir = mkdtempSync(join(tmpdir(), 'figma-drop-dmg-test-'));
  const volume = join(dir, 'volume');
  execFileSync(
    'hdiutil',
    ['attach', ...flags, '-nobrowse', '-noautoopen', '-mountpoint', volume, dmg],
    {
      stdio: 'ignore',
    },
  );
  try {
    return use(volume);
  } finally {
    execFileSync('hdiutil', ['detach', volume], { stdio: 'ignore' });
    rmdirSync(dir);
  }
}

// A skip in CI hides a regression, so CI must set up dmgbuild before the release tests.
if (skip && process.env.CI && process.platform === 'darwin') {
  test('CI runs the DMG integration tests', () => assert.fail(skip));
}

describe('ad-hoc DMG from a synthetic app', { skip }, () => {
  let dir;
  let fixture;
  let dmg;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'figma-drop-dmg-'));
    fixture = makeFixture(dir);
    mkdirSync(join(dir, 'out'));
    dmg = join(dir, 'out', `figma-drop-${VERSION}-mac-arm64-unsigned-dry-run.dmg`);
    buildDmg({
      app: fixture.app,
      dmg,
      volumeName: 'figma-drop',
      icon: join(fixture.app, 'Contents/Resources/figma-drop.icns'),
    });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('passes the release verification of the desktop DMG', () => {
    const checks = verifyDesktopDmg(dmg, {
      version: VERSION,
      signing: 'ad-hoc',
      buildDir: fixture.buildDir,
    });
    for (const label of [
      'Applications symlink target = /Applications',
      'hdiutil verify passes',
      'DMG carries no code signature',
      'signing mode of the app in the DMG = ad-hoc',
    ]) {
      assert.ok(checks.includes(label), label);
    }
  });

  test('is a read-only zlib UDIF image that hdiutil verifies', () => {
    const info = execFileSync('hdiutil', ['imageinfo', '-plist', dmg], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const format = execFileSync('plutil', ['-extract', 'Format', 'raw', '-o', '-', '-'], {
      input: info,
      encoding: 'utf8',
    });
    assert.equal(format.trim(), 'UDZO');
    assert.equal(spawnSync('hdiutil', ['verify', dmg], { stdio: 'ignore' }).status, 0);
    // Attached without -readonly, the volume still refuses writes because the image is.
    attached(dmg, [], (volume) =>
      assert.throws(() => writeFileSync(join(volume, 'probe'), 'x'), { code: 'EROFS' }),
    );
  });

  test('mounts with the app, an Applications link, and the hidden Finder layout', () => {
    attached(dmg, ['-readonly'], (volume) => {
      assert.deepEqual(readdirSync(volume).toSorted(), [
        '.DS_Store',
        '.VolumeIcon.icns',
        '.background.tiff',
        'Applications',
        'figma-drop.app',
      ]);
      assert.equal(readlinkSync(join(volume, 'Applications')), '/Applications');
      const app = join(volume, 'figma-drop.app');
      assert.equal(
        spawnSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore' }).status,
        0,
      );
      assert.deepEqual(
        entitlementProblems([{ path: app, app: true, entitlements: readEntitlements(app) }]),
        [],
      );
    });
  });

  test('SHA256SUMS written from the artifact matches the final file', () => {
    const artifact = describeArtifact(dmg, []);
    assert.equal(artifact.sha256, createHash('sha256').update(readFileSync(dmg)).digest('hex'));
    writeFileSync(join(dir, 'out/SHA256SUMS-dry-run.txt'), checksumsText([artifact]));
    const check = spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS-dry-run.txt'], {
      cwd: join(dir, 'out'),
      encoding: 'utf8',
    });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, new RegExp(`${artifact.name}: OK`));
  });

  test('verification rejects a DMG whose Applications link points elsewhere', () => {
    const source = join(dir, 'tampered-source');
    mkdirSync(source);
    execFileSync('ditto', [fixture.app, join(source, 'figma-drop.app')]);
    symlinkSync('/tmp', join(source, 'Applications'));
    for (const hidden of ['.DS_Store', '.background.tiff']) writeFileSync(join(source, hidden), '');
    cpSync(
      join(fixture.app, 'Contents/Resources/figma-drop.icns'),
      join(source, '.VolumeIcon.icns'),
    );
    const tampered = join(dir, 'tampered.dmg');
    execFileSync(
      'hdiutil',
      [
        'create',
        '-quiet',
        '-fs',
        'HFS+',
        '-format',
        'UDZO',
        '-volname',
        'figma-drop',
        '-srcfolder',
        source,
        tampered,
      ],
      { stdio: 'ignore' },
    );
    assert.throws(
      () =>
        verifyDesktopDmg(tampered, {
          version: VERSION,
          signing: 'ad-hoc',
          buildDir: fixture.buildDir,
        }),
      /Applications symlink target = \/Applications failed\. Got "\/tmp"/,
    );
  });
});
