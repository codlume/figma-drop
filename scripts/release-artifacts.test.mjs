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
  dmgSigning,
  isAppleMetadataEntry,
  NOTARY_DIR,
  NOTARY_LOGS,
  parseReleaseMode,
  readReleaseVersion,
  requireReleaseSigning,
} from './release-artifacts.mjs';
import {
  developerIdDmgChecks,
  entitlementProblems,
  readSigningMode,
  signingFromEnv,
} from './signing.mjs';

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

test('artifactNames for a Developer ID release name the desktop DMG without unsigned', () => {
  assert.deepEqual(artifactNames('1.2.3', release, 'developer-id'), {
    desktop: 'figma-drop-1.2.3-mac-arm64.dmg',
    plugin: 'figma-drop-figma-plugin-1.2.3.zip',
    checksums: 'SHA256SUMS.txt',
  });
});

test('artifactNames for an ad-hoc build mark the desktop DMG unsigned', () => {
  assert.equal(
    artifactNames('1.2.3', release, 'ad-hoc').desktop,
    'figma-drop-1.2.3-mac-arm64-unsigned.dmg',
  );
});

test('artifactNames for a dry run mark every name, in both signing modes', () => {
  for (const [signing, desktop] of [
    ['ad-hoc', 'figma-drop-1.2.3-mac-arm64-unsigned-dry-run.dmg'],
    ['developer-id', 'figma-drop-1.2.3-mac-arm64-dry-run.dmg'],
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
    /Release v1\.2\.3 needs a Developer ID build.*FIGMA_DROP_SIGN_IDENTITY and FIGMA_DROP_NOTARY_PROFILE/,
  );
  assert.doesNotThrow(() => requireReleaseSigning(release, 'developer-id'));
  assert.doesNotThrow(() => requireReleaseSigning(dryRun, 'ad-hoc'));
  assert.doesNotThrow(() => requireReleaseSigning(dryRun, 'developer-id'));
});

const identity = 'Developer ID Application: Example (TEAM123456)';
const developerIdEnv = {
  FIGMA_DROP_SIGN_IDENTITY: identity,
  FIGMA_DROP_NOTARY_PROFILE: 'figma-drop-notary',
};

test('signingFromEnv is ad-hoc without an identity, whatever else is set', () => {
  assert.deepEqual(signingFromEnv({}), { mode: 'ad-hoc' });
  const { FIGMA_DROP_SIGN_IDENTITY: _, ...notaryOnly } = developerIdEnv;
  assert.deepEqual(
    signingFromEnv({ ...notaryOnly, FIGMA_DROP_NOTARY_KEYCHAIN: '/tmp/k.keychain-db' }),
    { mode: 'ad-hoc' },
  );
});

test('signingFromEnv with an identity carries the notary profile, and the keychain if set', () => {
  assert.deepEqual(signingFromEnv(developerIdEnv), {
    mode: 'developer-id',
    identity,
    notary: { profile: 'figma-drop-notary' },
  });
  assert.deepEqual(
    signingFromEnv({ ...developerIdEnv, FIGMA_DROP_NOTARY_KEYCHAIN: '/tmp/k.keychain-db' }),
    {
      mode: 'developer-id',
      identity,
      notary: { profile: 'figma-drop-notary', keychain: '/tmp/k.keychain-db' },
    },
  );
});

test('signingFromEnv names each missing or empty variable instead of signing without notarizing', () => {
  for (const [env, named] of [
    [{ ...developerIdEnv, FIGMA_DROP_SIGN_IDENTITY: '' }, 'FIGMA_DROP_SIGN_IDENTITY'],
    [{ FIGMA_DROP_SIGN_IDENTITY: identity }, 'FIGMA_DROP_NOTARY_PROFILE'],
    [{ ...developerIdEnv, FIGMA_DROP_NOTARY_PROFILE: '' }, 'FIGMA_DROP_NOTARY_PROFILE'],
    [{ ...developerIdEnv, FIGMA_DROP_NOTARY_KEYCHAIN: '' }, 'FIGMA_DROP_NOTARY_KEYCHAIN'],
    [
      { FIGMA_DROP_SIGN_IDENTITY: '', FIGMA_DROP_NOTARY_PROFILE: '' },
      'FIGMA_DROP_SIGN_IDENTITY, FIGMA_DROP_NOTARY_PROFILE',
    ],
  ]) {
    assert.throws(
      () => signingFromEnv(env),
      new RegExp(`Missing or empty: ${named}\\.`),
      JSON.stringify(env),
    );
  }
});

test('signingFromEnv ignores the Apple ID variables the scripts no longer read', () => {
  const apple = { APPLE_ID: 'a@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'x', APPLE_TEAM_ID: 'T' };
  assert.throws(
    () => signingFromEnv({ ...apple, FIGMA_DROP_SIGN_IDENTITY: identity }),
    /Missing or empty: FIGMA_DROP_NOTARY_PROFILE\./,
  );
});

test('dmgSigning refuses a Developer ID app without the credentials to sign its DMG', () => {
  assert.throws(
    () => dmgSigning('developer-id', {}),
    /Developer ID build.*FIGMA_DROP_SIGN_IDENTITY is not set/,
  );
  assert.throws(
    () => dmgSigning('developer-id', { FIGMA_DROP_SIGN_IDENTITY: identity }),
    /Missing or empty: FIGMA_DROP_NOTARY_PROFILE\./,
  );
  assert.deepEqual(dmgSigning('developer-id', developerIdEnv), signingFromEnv(developerIdEnv));
});

test('dmgSigning keeps an ad-hoc app in an unsigned DMG and refuses mixed modes', () => {
  assert.deepEqual(dmgSigning('ad-hoc', {}), { mode: 'ad-hoc' });
  assert.throws(
    () => dmgSigning('ad-hoc', developerIdEnv),
    /FIGMA_DROP_SIGN_IDENTITY is set, but the app is ad-hoc signed/,
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

const developerIdDmg = {
  codesign: [
    'Executable=/tmp/figma-drop-1.2.3-mac-arm64.dmg',
    'Identifier=com.codlume.figma-drop.dmg',
    'Format=disk image',
    'CodeDirectory v=20100 size=179 flags=0x0(none) hashes=1+7 location=embedded',
    'Authority=Developer ID Application: Example (TEAM123456)',
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    'Timestamp=8 Nov 2026 at 18:00:00',
    'TeamIdentifier=TEAM123456',
  ].join('\n'),
  verified: true,
  stapled: true,
  gatekeeper:
    '/tmp/figma-drop-1.2.3-mac-arm64.dmg: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Example (TEAM123456)\n',
  identifier: 'com.codlume.figma-drop.dmg',
  teamId: 'TEAM123456',
};
const failedDmgChecks = (evidence) =>
  developerIdDmgChecks(evidence)
    .filter(({ ok }) => !ok)
    .map(({ label }) => label);

test('developerIdDmgChecks passes a signed, notarized, stapled DMG of the app team', () => {
  assert.deepEqual(failedDmgChecks(developerIdDmg), []);
});

test('developerIdDmgChecks names what an unfinished or foreign DMG lacks', () => {
  for (const [change, failed] of [
    [{ stapled: false }, ['xcrun stapler validate passes on the DMG']],
    [{ verified: false }, ['codesign --verify --strict passes on the DMG']],
    [
      { gatekeeper: '/tmp/x.dmg: rejected\nsource=Unnotarized Developer ID\n' },
      ['Gatekeeper accepts the DMG as Notarized Developer ID'],
    ],
    [{ teamId: 'OTHER12345' }, ["DMG TeamIdentifier = OTHER12345, the app's team"]],
    [
      { codesign: developerIdDmg.codesign.replace(/^Timestamp=.*$/m, 'Signed Time=today') },
      ['DMG signature has a secure timestamp'],
    ],
    [
      { codesign: developerIdDmg.codesign.replace('.figma-drop.dmg', '.figma-drop') },
      ['DMG signature identifier = com.codlume.figma-drop.dmg'],
    ],
    [
      { codesign: 'code object is not signed at all' },
      [
        'DMG codesign format is disk image',
        'DMG signature identifier = com.codlume.figma-drop.dmg',
        'DMG is signed by a Developer ID Application authority',
        "DMG TeamIdentifier = TEAM123456, the app's team",
        'DMG signature has a secure timestamp',
      ],
    ],
  ]) {
    assert.deepEqual(failedDmgChecks({ ...developerIdDmg, ...change }), failed);
  }
});

test('entitlementProblems allows only allow-jit, and only on app bundles', () => {
  const jit = { 'com.apple.security.cs.allow-jit': true };
  const helper = 'figma-drop.app/Contents/Frameworks/Electron Helper (Renderer).app';
  const framework = 'figma-drop.app/Contents/Frameworks/Electron Framework.framework';
  assert.deepEqual(
    entitlementProblems([
      { path: helper, app: true, entitlements: jit },
      { path: framework, app: false, entitlements: {} },
    ]),
    [],
  );
  for (const [item, problem] of [
    [{ path: helper, app: true, entitlements: {} }, /Renderer\)\.app has \{\}/],
    [
      {
        path: helper,
        app: true,
        entitlements: { ...jit, 'com.apple.security.get-task-allow': true },
      },
      /get-task-allow/,
    ],
    [{ path: framework, app: false, entitlements: jit }, /framework has .*expected none/],
  ]) {
    const problems = entitlementProblems([item]);
    assert.equal(problems.length, 1, item.path);
    assert.match(problems[0], problem);
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
    [...notice[1].matchAll(/\\`(figma-drop-[^`\\]+\.(?:zip|dmg))\\`/g)].map(([, name]) =>
      name.replaceAll('${version}', '1.2.3'),
    ),
  );
  assert.deepEqual(named, new Set([releaseNames.desktop, releaseNames.plugin]));
});

const glob = (pattern) =>
  new RegExp(`^${pattern.replaceAll('.', '\\.').replaceAll('*', '[^/]*')}$`);

// The build job's upload must carry exactly the release assets: no notary log, no plan.
test('release.yml build uploads every release asset and nothing else from the release run', () => {
  const build = jobText('build');
  const upload = build.match(
    /uses: actions\/upload-artifact@[\s\S]*?\n {10}path: \|\n((?: {12}.*\n)+)/,
  );
  assert.ok(upload, 'the build job uploads a workflow artifact with a path block');
  const patterns = upload[1]
    .trim()
    .split('\n')
    .map((line) => line.trim());
  const written = [
    ...Object.values(releaseNames),
    'release-plan.json',
    `${NOTARY_DIR}/${NOTARY_LOGS.app}`,
    `${NOTARY_DIR}/${NOTARY_LOGS.dmg}`,
  ].map((name) => `release-artifacts/${name}`);
  const uploaded = written.filter((path) => patterns.some((pattern) => glob(pattern).test(path)));
  assert.deepEqual(
    uploaded,
    Object.values(releaseNames).map((name) => `release-artifacts/${name}`),
  );
});

test('release.yml names one checksums file, the one release-package.mjs writes', () => {
  const named = new Set(releaseWorkflow.match(/SHA256SUMS[\w.-]*/g));
  assert.deepEqual(named, new Set([releaseNames.checksums]));
  assert.match(jobText('upload'), new RegExp(`sha256sum -c ${releaseNames.checksums}`));
  assert.match(jobText('upload'), new RegExp(`--ignore-missing ${releaseNames.checksums}`));
});
