import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

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

export function artifactNames(version, mode) {
  const suffix = mode.kind === 'dry-run' ? '-dry-run' : '';
  return {
    desktop: `figma-drop-${version}-mac-arm64-unsigned${suffix}.zip`,
    plugin: `figma-drop-figma-plugin-${version}${suffix}.zip`,
    checksums: `SHA256SUMS${suffix}.txt`,
  };
}

export const isAppleMetadataEntry = (entry) => /(^|\/)(\._|__MACOSX\/|\.DS_Store$)/.test(entry);
