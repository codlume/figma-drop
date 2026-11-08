import { execFileSync, spawnSync } from 'node:child_process';

// A Developer ID build is always notarized and stapled, so "signed but not notarized" has no mode.
export const SIGNING_MODES = {
  'ad-hoc': {
    assetSuffix: '-unsigned',
    summary: 'ad-hoc signature, no Developer ID, not notarized',
  },
  'developer-id': {
    assetSuffix: '',
    summary: 'Developer ID signature with the hardened runtime, notarized and stapled',
  },
};

export const SIGNING_VARIABLES = {
  identity: 'FIGMA_DROP_SIGN_IDENTITY',
  profile: 'FIGMA_DROP_NOTARY_PROFILE',
  keychain: 'FIGMA_DROP_NOTARY_KEYCHAIN',
};

// The only entitlement any signed bundle carries. Plain executables, dylibs, and frameworks get
// none, and nothing gets get-task-allow, which notarization rejects.
export const APP_ENTITLEMENTS = { 'com.apple.security.cs.allow-jit': true };

// Scripts never see an Apple password: notarytool reads the credentials from a keychain profile
// that the caller stored beforehand.
export function signingFromEnv(env) {
  const { identity, profile, keychain } = SIGNING_VARIABLES;
  if (env[identity] === undefined) return { mode: 'ad-hoc' };
  const missing = [identity, profile].filter((name) => !env[name]);
  if (env[keychain] === '') missing.push(keychain);
  if (missing.length > 0) {
    throw new Error(
      `A Developer ID build is notarized, so it needs ${identity} and ${profile}, and ${keychain} if the profile is not in the default keychain. Missing or empty: ${missing.join(', ')}. Unset ${identity} for an ad-hoc build.`,
    );
  }
  return {
    mode: 'developer-id',
    identity: env[identity],
    notary: { profile: env[profile], ...(env[keychain] ? { keychain: env[keychain] } : {}) },
  };
}

// `codesign` is the stderr of `codesign -dv --verbose=2`, `stapled` whether `xcrun stapler
// validate` passed, and `gatekeeper` the stderr of `spctl -a -vv -t exec`.
export function readSigningMode({ codesign, stapled, gatekeeper }) {
  if (/^Signature=adhoc$/m.test(codesign)) return 'ad-hoc';
  const missing = [
    [
      /^Authority=Developer ID Application: /m.test(codesign),
      'a Developer ID Application authority',
    ],
    [/^CodeDirectory .*flags=\S*\(.*\bruntime\b.*\)/m.test(codesign), 'the hardened runtime'],
    [/^Timestamp=/m.test(codesign), 'a secure timestamp'],
    [stapled, 'a stapled notarization ticket'],
    [
      /: accepted\nsource=Notarized Developer ID$/m.test(gatekeeper),
      'Gatekeeper acceptance as Notarized Developer ID',
    ],
  ]
    .filter(([present]) => !present)
    .map(([, label]) => label);
  if (missing.length > 0) {
    throw new Error(
      `The app is neither ad-hoc signed nor a notarized Developer ID build. It lacks ${missing.join(', ')}.\n${codesign.trim()}\n${gatekeeper.trim()}`,
    );
  }
  return 'developer-id';
}

const output = (command, ...args) => spawnSync(command, args, { encoding: 'utf8' });

export function inspectSigning(app) {
  return readSigningMode({
    codesign: output('codesign', '-dv', '--verbose=2', app).stderr,
    stapled: output('xcrun', 'stapler', 'validate', app).status === 0,
    gatekeeper: output('spctl', '-a', '-vv', '-t', 'exec', app).stderr,
  });
}

export const teamIdentifier = (path) =>
  /^TeamIdentifier=(.+)$/m.exec(output('codesign', '-dv', '--verbose=2', path).stderr)?.[1] ?? null;

// Every check a notarized Developer ID disk image must pass, from `codesign -dv --verbose=4`
// stderr, `codesign --verify --strict`, `xcrun stapler validate`, and the stderr of
// `spctl -a -t open --context context:primary-signature -vv`. `teamId` is the app's team.
export function developerIdDmgChecks({
  codesign,
  verified,
  stapled,
  gatekeeper,
  identifier,
  teamId,
}) {
  const lines = codesign.split('\n');
  return [
    [lines.includes('Format=disk image'), 'DMG codesign format is disk image'],
    [lines.includes(`Identifier=${identifier}`), `DMG signature identifier = ${identifier}`],
    [
      lines.some((line) => line.startsWith('Authority=Developer ID Application: ')),
      'DMG is signed by a Developer ID Application authority',
    ],
    [lines.includes(`TeamIdentifier=${teamId}`), `DMG TeamIdentifier = ${teamId}, the app's team`],
    [lines.some((line) => line.startsWith('Timestamp=')), 'DMG signature has a secure timestamp'],
    [verified, 'codesign --verify --strict passes on the DMG'],
    [stapled, 'xcrun stapler validate passes on the DMG'],
    [
      /: accepted\nsource=Notarized Developer ID$/m.test(gatekeeper),
      'Gatekeeper accepts the DMG as Notarized Developer ID',
    ],
  ].map(([ok, label]) => ({ ok, label }));
}

// The entitlements embedded in one piece of signed code, as a plain object; {} when it has none.
export function readEntitlements(path) {
  const xml = execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', path], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (xml.length === 0) return {};
  return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml }));
}

const canonical = (entitlements) => JSON.stringify(Object.entries(entitlements).toSorted());

// Each problem with the entitlements of signed code. `code` lists {path, app, entitlements}.
export function entitlementProblems(code) {
  return code
    .filter(
      ({ app, entitlements }) => canonical(entitlements) !== canonical(app ? APP_ENTITLEMENTS : {}),
    )
    .map(
      ({ path, app, entitlements }) =>
        `${path} has ${JSON.stringify(entitlements)}, expected ${app ? JSON.stringify(APP_ENTITLEMENTS) : 'none'}.`,
    );
}
