import { spawnSync } from 'node:child_process';

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

const NOTARY_VARIABLES = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];

export function signingFromEnv(env) {
  const identity = env.FIGMA_DROP_SIGN_IDENTITY;
  if (identity === undefined) return { mode: 'ad-hoc' };
  const missing = [
    ...(identity === '' ? ['FIGMA_DROP_SIGN_IDENTITY'] : []),
    ...NOTARY_VARIABLES.filter((name) => !env[name]),
  ];
  if (missing.length > 0) {
    throw new Error(
      `A Developer ID build is notarized, so it needs FIGMA_DROP_SIGN_IDENTITY and ${NOTARY_VARIABLES.join(', ')}. Missing or empty: ${missing.join(', ')}. Unset FIGMA_DROP_SIGN_IDENTITY for an ad-hoc build.`,
    );
  }
  return {
    mode: 'developer-id',
    identity,
    notary: {
      appleId: env.APPLE_ID,
      password: env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: env.APPLE_TEAM_ID,
    },
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
