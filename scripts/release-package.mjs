import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APPLICATIONS_LINK,
  buildDmg,
  DMG_FORMAT,
  dmgFormat,
  sha256File,
  withAttachedDmg,
} from './dmg.mjs';
import { notarize, readNotaryLog } from './notary.mjs';
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
import { developerIdDmgChecks, inspectSigning, SIGNING_MODES, teamIdentifier } from './signing.mjs';

const APP_NAME = 'figma-drop';
const BUNDLE_ID = 'com.codlume.figma-drop';
const DMG_IDENTIFIER = `${BUNDLE_ID}.dmg`;
const PLUGIN_FOLDER = 'figma-drop-figma-plugin';
const PLUGIN_FILES = ['manifest.json', 'dist/code.js', 'dist/ui.html'];
// The hidden entries are the Finder layout dmgbuild writes: window settings, volume icon, and
// background picture.
const VOLUME_ENTRIES = [
  '.DS_Store',
  '.VolumeIcon.icns',
  '.background.tiff',
  'Applications',
  `${APP_NAME}.app`,
].toSorted();
// fseventsd may create its log while the image is mounted writable during the build.
const OPTIONAL_VOLUME_ENTRIES = new Set(['.fseventsd']);

const repoDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(repoDir, 'release-artifacts');
// Artifacts are written here and renamed to `outDir` only once complete, so an interrupted
// run never leaves a release-named artifact in `outDir`.
const stagingDir = join(repoDir, 'release-artifacts.staging');
const builtApp = join(repoDir, 'apps/desktop/release', `${APP_NAME}.app`);
const builtAppNotaryLog = join(repoDir, 'apps/desktop/release', NOTARY_LOGS.app);
const pluginDir = join(repoDir, 'apps/figma-plugin');
const desktopBuildDir = join(repoDir, 'apps/desktop');
const BUNDLED_BUILDS = ['dist', 'dist-electron'];

const capture = (command, ...args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const output = (command, ...args) => spawnSync(command, args, { encoding: 'utf8' });

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

export function appIcon(app) {
  const plist = join(app, 'Contents/Info.plist');
  const name = capture('plutil', '-extract', 'CFBundleIconFile', 'raw', '-o', '-', plist);
  return join(app, 'Contents/Resources', name.endsWith('.icns') ? name : `${name}.icns`);
}

function verifyApp(app, version, buildDir, signing, { expect, equal }) {
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
    const diff = output('diff', '-rq', join(buildDir, build), join(appDir, build));
    expect(
      diff.status === 0,
      `Contents/Resources/app/${build} is byte-identical to apps/desktop/${build}`,
      `The bundle is stale. Run pnpm app:local.\n${diff.stdout}${diff.stderr}`.trim(),
    );
  }
  const verify = output('codesign', '--verify', '--deep', '--strict', app);
  expect(verify.status === 0, 'codesign --verify --deep --strict passes', verify.stderr.trim());
  // For a Developer ID app this requires the app's own stapled ticket and Gatekeeper's
  // Notarized Developer ID verdict, independent of the DMG's ticket.
  equal('signing mode of the app in the DMG', inspectSigning(app), signing);
}

function inspectDmgSignature(dmg, teamId) {
  return {
    codesign: output('codesign', '-dv', '--verbose=4', dmg).stderr,
    verified: output('codesign', '--verify', '--strict', dmg).status === 0,
    stapled: output('xcrun', 'stapler', 'validate', dmg).status === 0,
    gatekeeper: output(
      'spctl',
      '-a',
      '-t',
      'open',
      '--context',
      'context:primary-signature',
      '-vv',
      dmg,
    ).stderr,
    identifier: DMG_IDENTIFIER,
    teamId,
  };
}

// Only reads the image. Its SHA-256 before and after proves that.
export function verifyDesktopDmg(dmg, { version, signing, buildDir = desktopBuildDir }) {
  const check = checkList(dmg);
  const { expect, equal } = check;
  const before = sha256File(dmg);
  equal('hdiutil imageinfo Format', dmgFormat(dmg), DMG_FORMAT);
  const verify = output('hdiutil', 'verify', dmg);
  expect(verify.status === 0, 'hdiutil verify passes', `${verify.stdout}${verify.stderr}`.trim());
  const appTeam = withAttachedDmg(dmg, (volume) => {
    const entries = readdirSync(volume).filter((entry) => !OPTIONAL_VOLUME_ENTRIES.has(entry));
    equal('volume entries', entries.toSorted().join(', '), VOLUME_ENTRIES.join(', '));
    const link = join(volume, 'Applications');
    expect(lstatSync(link).isSymbolicLink(), 'Applications is a symlink', 'It is not a symlink.');
    equal('Applications symlink target', readlinkSync(link), APPLICATIONS_LINK);
    const app = join(volume, `${APP_NAME}.app`);
    expect(
      readFileSync(join(volume, '.VolumeIcon.icns')).equals(readFileSync(appIcon(app))),
      "volume icon is the app's icon",
      `.VolumeIcon.icns differs from ${relative(volume, appIcon(app))}.`,
    );
    verifyApp(app, version, buildDir, signing, check);
    return teamIdentifier(app);
  });
  if (signing === 'developer-id') {
    const evidence = inspectDmgSignature(dmg, appTeam);
    for (const { ok, label } of developerIdDmgChecks(evidence)) {
      expect(ok, label, `${evidence.codesign.trim()}\n${evidence.gatekeeper.trim()}`);
    }
  } else {
    const codesign = output('codesign', '-dv', dmg).stderr;
    expect(
      codesign.includes('code object is not signed at all'),
      'DMG carries no code signature',
      codesign.trim(),
    );
  }
  equal('DMG SHA-256 after verification', sha256File(dmg), before);
  return check.passed;
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

// Hashes the file as it is now, so it runs after the last write to the artifact.
export function describeArtifact(path, checks) {
  return { name: basename(path), bytes: statSync(path).size, sha256: sha256File(path), checks };
}

export const checksumsText = (artifacts) =>
  artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}\n`).join('');

function readAppNotaryLog() {
  if (!existsSync(builtAppNotaryLog)) {
    throw new Error(
      `The app is a Developer ID build, but ${builtAppNotaryLog} is missing. Run pnpm app:local.`,
    );
  }
  const { id, status } = readNotaryLog(builtAppNotaryLog);
  return { id, status };
}

// Signs the DMG with the app's identity, notarizes it, and staples it. Both notary logs land in
// `notaryDir`, which a failed run keeps as evidence.
function signAndNotarizeDmg(dmg, { identity, notary }, notaryDir) {
  mkdirSync(notaryDir, { recursive: true });
  cpSync(builtAppNotaryLog, join(notaryDir, NOTARY_LOGS.app));
  execFileSync(
    'codesign',
    ['--sign', identity, '--timestamp', '--identifier', DMG_IDENTIFIER, dmg],
    { stdio: 'inherit' },
  );
  const { id, status } = notarize({
    submission: dmg,
    stapleTarget: dmg,
    notary,
    logPath: join(notaryDir, NOTARY_LOGS.dmg),
  });
  return { id, status };
}

function headline(mode, version, signing, notary) {
  const notarized = notary
    ? ` Notary submissions: app ${notary.app.id} ${notary.app.status}, DMG ${notary.dmg.id} ${notary.dmg.status}.`
    : '';
  const desktop = `Desktop signing mode ${signing}: ${SIGNING_MODES[signing].summary}.${notarized}`;
  return mode.kind === 'dry-run'
    ? `Dry run of ${version}: this publishes nothing. ${desktop}`
    : `Release ${mode.tag}: artifacts for GitHub release ${mode.tag}. ${desktop}`;
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

  const appSigning = inspectSigning(builtApp);
  requireReleaseSigning(mode, appSigning);
  const signing = dmgSigning(appSigning, process.env);
  const appNotary = signing.mode === 'developer-id' ? readAppNotaryLog() : null;
  const names = artifactNames(version, mode, appSigning);
  for (const dir of [outDir, stagingDir]) rmSync(dir, { recursive: true, force: true });
  mkdirSync(stagingDir);
  const notaryDir = join(stagingDir, NOTARY_DIR);
  try {
    const dmg = join(stagingDir, names.desktop);
    buildDmg({ app: builtApp, dmg, volumeName: APP_NAME, icon: appIcon(builtApp) });
    const notary =
      signing.mode === 'developer-id'
        ? { app: appNotary, dmg: signAndNotarizeDmg(dmg, signing, notaryDir) }
        : null;
    // Nothing writes the DMG after this point, so its checksum covers the released bytes.
    const desktopChecks = verifyDesktopDmg(dmg, { version, signing: appSigning });
    const pluginZip = join(stagingDir, names.plugin);
    zipPlugin(pluginZip);
    const pluginChecks = verifyPlugin(pluginZip);

    const artifacts = [
      describeArtifact(dmg, desktopChecks),
      describeArtifact(pluginZip, pluginChecks),
    ];
    writeFileSync(join(stagingDir, names.checksums), checksumsText(artifacts));
    const plan = {
      mode: mode.kind,
      version,
      tag: mode.kind === 'release' ? mode.tag : null,
      publishes: mode.kind === 'release' ? `GitHub release ${mode.tag}` : false,
      signing: appSigning,
      notary,
      artifacts,
    };
    writeFileSync(join(stagingDir, 'release-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    renameSync(stagingDir, outDir);
    writeSummary(plan, headline(mode, version, appSigning, notary));
  } catch (error) {
    if (existsSync(notaryDir)) {
      mkdirSync(outDir, { recursive: true });
      renameSync(notaryDir, join(outDir, NOTARY_DIR));
      console.error(`Kept the notary logs in ${join(outDir, NOTARY_DIR)}`);
    }
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
