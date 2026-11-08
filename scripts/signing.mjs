import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

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

export const MACH_O_MAGICS = new Set([0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface, 0xcafebabe]);

export const SIGNING_VARIABLES = {
  identity: 'FIGMA_DROP_SIGN_IDENTITY',
  profile: 'FIGMA_DROP_NOTARY_PROFILE',
  keychain: 'FIGMA_DROP_NOTARY_KEYCHAIN',
};

// The only entitlement any signed bundle carries, and so its main executable too. Other code gets
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

// codesign treats a bundle's main executable as the bundle itself and stores the bundle's
// signature there, so both paths report the same entitlements. @electron/osx-sign matches main executables with
// the same path pattern, though only to order signing.
export const isBundleMainExecutable = (path) => /\.app\/Contents\/MacOS\/[^/]+$/.test(path);

function expectedEntitlements({ path, app }) {
  if (app) return { entitlements: APP_ENTITLEMENTS, rule: 'an .app bundle' };
  if (isBundleMainExecutable(path)) {
    return {
      entitlements: APP_ENTITLEMENTS,
      rule: "the main executable of an .app bundle, which carries the bundle's signature",
    };
  }
  return { entitlements: {}, rule: 'code that is neither an .app bundle nor its main executable' };
}

// Each problem with the entitlements of signed code. `code` lists {path, app, entitlements}.
export function entitlementProblems(code) {
  return code.flatMap((item) => {
    const expected = expectedEntitlements(item);
    if (canonical(item.entitlements) === canonical(expected.entitlements)) return [];
    const want = Object.keys(expected.entitlements).length
      ? JSON.stringify(expected.entitlements)
      : 'none';
    return [
      `${item.path} has ${JSON.stringify(item.entitlements)}, expected ${want} for ${expected.rule}.`,
    ];
  });
}

// `codesign --deep` skips Mach-O files outside the standard nested-code locations, such as
// Squirrel's ShipIt and Electron's bundled dylibs, and notarization rejects them unsigned. So each
// one is signed on its own, deepest first, and every bundle after everything inside it.
export function signInsideOut(app, identity, entitlementsPath) {
  const nested = readdirSync(app, { recursive: true, withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory()
        ? /\.(app|framework)$/.test(entry.name)
        : entry.isFile() && isMachO(join(entry.parentPath, entry.name)),
    )
    .map((entry) => ({
      path: join(entry.parentPath, entry.name),
      app: entry.name.endsWith('.app'),
    }))
    .toSorted((a, b) => b.path.split('/').length - a.path.split('/').length);
  const code = [...nested, { path: app, app: true }];
  for (const { path, app: isApp } of code) {
    execFileSync(
      'codesign',
      [
        '--force',
        '--options',
        'runtime',
        '--timestamp',
        ...(isApp ? ['--entitlements', entitlementsPath] : []),
        '--sign',
        identity,
        path,
      ],
      { stdio: 'inherit' },
    );
  }
  return code;
}

export function isMachO(path) {
  const header = Buffer.alloc(4);
  const fd = openSync(path, 'r');
  try {
    return readSync(fd, header, 0, 4, 0) === 4 && MACH_O_MAGICS.has(header.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
}
