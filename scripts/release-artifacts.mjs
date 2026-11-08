import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { SIGNING_MODES, SIGNING_VARIABLES, signingFromEnv } from './signing.mjs';

export const USAGE = 'Usage: node scripts/release-package.mjs --dry-run | --tag vX.Y.Z';

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

const RELEASE_CONFIG = 'release-please-config.json';
const RELEASE_MANIFEST = '.release-please-manifest.json';

export function parseReleaseMode(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { 'dry-run': { type: 'boolean' }, tag: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new Error(`${error.message}\n${USAGE}`, { cause: error });
  }
  const dryRun = values['dry-run'] === true;
  const { tag } = values;
  if (dryRun && tag !== undefined) throw new Error(`Pass --dry-run or --tag, not both.\n${USAGE}`);
  if (dryRun) return { kind: 'dry-run' };
  if (tag === undefined) throw new Error(`Pass --dry-run or --tag.\n${USAGE}`);
  if (!TAG_PATTERN.test(tag)) throw new Error(`Tag "${tag}" is not vX.Y.Z.\n${USAGE}`);
  return { kind: 'release', tag };
}

export function readReleaseVersion(repoDir) {
  const readJson = (path) => JSON.parse(readFileSync(join(repoDir, path), 'utf8'));
  const extraFiles = readJson(RELEASE_CONFIG).packages?.['.']?.['extra-files'];
  if (!Array.isArray(extraFiles)) {
    throw new Error(`${RELEASE_CONFIG} must list packages["."]["extra-files"].`);
  }
  const versioned = ['package.json', ...extraFiles.map((file) => file.path)];
  const found = [
    ...versioned.map((path) => ({ source: path, version: readJson(path).version })),
    { source: `${RELEASE_MANIFEST} "."`, version: readJson(RELEASE_MANIFEST)['.'] },
  ];
  const [{ version }] = found;
  const agree = found.every((entry) => entry.version === version);
  if (!agree || typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    const listing = found.map((entry) => `  ${entry.source}: ${JSON.stringify(entry.version)}`);
    throw new Error(`Release versions must be one X.Y.Z value:\n${listing.join('\n')}`);
  }
  return version;
}

export function requireReleaseSigning(mode, signing) {
  if (mode.kind === 'release' && signing !== 'developer-id') {
    throw new Error(
      `Release ${mode.tag} needs a Developer ID build, notarized and stapled, and this app is ${signing}: ${SIGNING_MODES[signing].summary}. Set ${SIGNING_VARIABLES.identity} and ${SIGNING_VARIABLES.profile}, then run pnpm app:local.`,
    );
  }
}

// The DMG is signed the way the app inside it is. A Developer ID app goes only into a signed,
// notarized DMG, so its credentials must be present before any DMG is built.
export function dmgSigning(appSigning, env) {
  const signing = signingFromEnv(env);
  if (signing.mode === appSigning) return signing;
  const { identity, profile } = SIGNING_VARIABLES;
  throw new Error(
    appSigning === 'developer-id'
      ? `The app is a notarized Developer ID build, so its DMG is signed and notarized too, which needs ${identity} and ${profile}. ${identity} is not set.`
      : `${identity} is set, but the app is ad-hoc signed. Run pnpm app:local with the same environment, or unset ${identity}.`,
  );
}

export function artifactNames(version, mode, signing) {
  const suffix = mode.kind === 'dry-run' ? '-dry-run' : '';
  return {
    desktop: `figma-drop-${version}-mac-arm64${SIGNING_MODES[signing].assetSuffix}${suffix}.dmg`,
    plugin: `figma-drop-figma-plugin-${version}${suffix}.zip`,
    checksums: `SHA256SUMS${suffix}.txt`,
  };
}

// Notary logs are evidence for a Developer ID build. They are not release assets, so they are
// neither listed in the checksums file nor uploaded to the GitHub release.
export const NOTARY_DIR = 'notary';
export const NOTARY_LOGS = { app: 'notary-log-app.json', dmg: 'notary-log-dmg.json' };

export const isAppleMetadataEntry = (entry) => /(^|\/)(\._|__MACOSX\/|\.DS_Store$)/.test(entry);
