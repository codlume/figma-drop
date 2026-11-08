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
  requireReleaseSigning,
} from './release-artifacts.mjs';
import { readSigningMode, signingFromEnv } from './signing.mjs';

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

const release = { kind: 'release', tag: 'v1.2.3' };
const dryRun = { kind: 'dry-run' };

test('artifactNames for a Developer ID release name the desktop zip without unsigned', () => {
  assert.deepEqual(artifactNames('1.2.3', release, 'developer-id'), {
    desktop: 'figma-drop-1.2.3-mac-arm64.zip',
    plugin: 'figma-drop-figma-plugin-1.2.3.zip',
    checksums: 'SHA256SUMS.txt',
  });
});

test('artifactNames for an ad-hoc build mark the desktop zip unsigned', () => {
  assert.equal(
    artifactNames('1.2.3', release, 'ad-hoc').desktop,
    'figma-drop-1.2.3-mac-arm64-unsigned.zip',
  );
});

test('artifactNames for a dry run mark every name, in both signing modes', () => {
  for (const [signing, desktop] of [
    ['ad-hoc', 'figma-drop-1.2.3-mac-arm64-unsigned-dry-run.zip'],
    ['developer-id', 'figma-drop-1.2.3-mac-arm64-dry-run.zip'],
  ]) {
    const names = artifactNames('1.2.3', dryRun, signing);
    assert.deepEqual(names, {
      desktop,
      plugin: 'figma-drop-figma-plugin-1.2.3-dry-run.zip',
      checksums: 'SHA256SUMS-dry-run.txt',
    });
    for (const name of Object.values(names)) assert.match(name, /dry-run/);
  }
});

test('requireReleaseSigning refuses an ad-hoc release and accepts every dry run', () => {
  assert.throws(
    () => requireReleaseSigning(release, 'ad-hoc'),
    /Release v1\.2\.3 needs a Developer ID build.*FIGMA_DROP_SIGN_IDENTITY/,
  );
  assert.doesNotThrow(() => requireReleaseSigning(release, 'developer-id'));
  assert.doesNotThrow(() => requireReleaseSigning(dryRun, 'ad-hoc'));
  assert.doesNotThrow(() => requireReleaseSigning(dryRun, 'developer-id'));
});

const notary = {
  APPLE_ID: 'dev@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
  APPLE_TEAM_ID: 'TEAM123456',
};

test('signingFromEnv is ad-hoc without an identity, whatever else is set', () => {
  assert.deepEqual(signingFromEnv({}), { mode: 'ad-hoc' });
  assert.deepEqual(signingFromEnv(notary), { mode: 'ad-hoc' });
});

test('signingFromEnv with an identity carries the notary credentials', () => {
  const identity = 'Developer ID Application: Example (TEAM123456)';
  assert.deepEqual(signingFromEnv({ ...notary, FIGMA_DROP_SIGN_IDENTITY: identity }), {
    mode: 'developer-id',
    identity,
    notary: {
      appleId: notary.APPLE_ID,
      password: notary.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: notary.APPLE_TEAM_ID,
    },
  });
});

test('signingFromEnv names every missing variable instead of signing without notarizing', () => {
  const identity = { FIGMA_DROP_SIGN_IDENTITY: 'Developer ID Application: Example (TEAM123456)' };
  assert.throws(
    () => signingFromEnv({ ...identity, APPLE_ID: notary.APPLE_ID, APPLE_TEAM_ID: '' }),
    /Missing or empty: APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID\./,
  );
  assert.throws(
    () => signingFromEnv({ ...notary, FIGMA_DROP_SIGN_IDENTITY: '' }),
    /Missing or empty: FIGMA_DROP_SIGN_IDENTITY\./,
  );
});

const developerIdCodesign = [
  'Executable=/tmp/figma-drop.app/Contents/MacOS/figma-drop',
  'CodeDirectory v=20500 size=505 flags=0x10000(runtime) hashes=5+7 location=embedded',
  'Authority=Developer ID Application: Example (TEAM123456)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'Timestamp=8 Nov 2026 at 18:00:00',
  'TeamIdentifier=TEAM123456',
].join('\n');
const notarized = {
  codesign: developerIdCodesign,
  stapled: true,
  gatekeeper:
    '/tmp/figma-drop.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Example (TEAM123456)\n',
};

test('readSigningMode reads an ad-hoc signature', () => {
  assert.equal(
    readSigningMode({
      codesign:
        'CodeDirectory v=20400 size=303 flags=0x2(adhoc) hashes=3+3\nSignature=adhoc\nTeamIdentifier=not set',
      stapled: false,
      gatekeeper: '/tmp/figma-drop.app: rejected\n',
    }),
    'ad-hoc',
  );
});

test('readSigningMode reads a notarized Developer ID build', () => {
  assert.equal(readSigningMode(notarized), 'developer-id');
});

test('readSigningMode rejects each half-finished Developer ID build by what it lacks', () => {
  for (const [label, signature, lacks] of [
    ['not stapled', { stapled: false }, /a stapled notarization ticket/],
    [
      'not notarized',
      {
        stapled: false,
        gatekeeper: '/tmp/figma-drop.app: rejected\nsource=Unnotarized Developer ID\n',
      },
      /a stapled notarization ticket, Gatekeeper acceptance/,
    ],
    [
      'no hardened runtime',
      { codesign: developerIdCodesign.replace('flags=0x10000(runtime)', 'flags=0x0(none)') },
      /the hardened runtime/,
    ],
    [
      'no secure timestamp',
      { codesign: developerIdCodesign.replace(/^Timestamp=.*$/m, 'Signed Time=8 Nov 2026') },
      /a secure timestamp/,
    ],
    [
      'another kind of identity',
      { codesign: developerIdCodesign.replaceAll('Developer ID Application', 'Apple Development') },
      /a Developer ID Application authority/,
    ],
  ]) {
    assert.throws(() => readSigningMode({ ...notarized, ...signature }), lacks, label);
  }
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

const releaseWorkflow = readFileSync(join(repoDir, '.github/workflows/release.yml'), 'utf8');
const releaseNames = artifactNames('1.2.3', release, 'developer-id');

function jobText(job) {
  const lines = releaseWorkflow.split('\n');
  const start = lines.indexOf(`  ${job}:`);
  assert.ok(start >= 0, `release.yml has a ${job} job`);
  const end = lines.findIndex((line, index) => index > start && /^  \S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

test('release.yml install notice names the release artifacts', () => {
  const notice = jobText('upload').match(/<<NOTICE\n([\s\S]*?)\n\s*NOTICE\n/);
  assert.ok(notice, 'the upload job writes the notice with a NOTICE heredoc');
  const named = new Set(
    [...notice[1].matchAll(/\\`(figma-drop-[^`\\]+\.zip)\\`/g)].map(([, name]) =>
      name.replaceAll('${version}', '1.2.3'),
    ),
  );
  assert.deepEqual(named, new Set([releaseNames.desktop, releaseNames.plugin]));
});

test('release.yml build uploads every zip and the checksums file', () => {
  const build = jobText('build');
  const upload = build.match(
    /uses: actions\/upload-artifact@[\s\S]*?\n {10}path: \|\n((?: {12}.*\n)+)/,
  );
  assert.ok(upload, 'the build job uploads a workflow artifact with a path block');
  const patterns = upload[1]
    .trim()
    .split('\n')
    .map((line) => line.trim());
  assert.deepEqual(patterns, [
    'release-artifacts/*.zip',
    `release-artifacts/${releaseNames.checksums}`,
  ]);
});

test('release.yml names one checksums file, the one release-package.mjs writes', () => {
  const named = new Set(releaseWorkflow.match(/SHA256SUMS[\w.-]*/g));
  assert.deepEqual(named, new Set([releaseNames.checksums]));
  assert.match(jobText('upload'), new RegExp(`sha256sum -c ${releaseNames.checksums}`));
  assert.match(jobText('upload'), new RegExp(`--ignore-missing ${releaseNames.checksums}`));
});
