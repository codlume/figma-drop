import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Every case fails before `notarytool` runs, and a stub `xcrun` proves it never does, so these
// tests never reach Apple. Keychains live in a temp folder and never touch the login keychain.

const script = fileURLToPath(new URL('./ci-import-signing.sh', import.meta.url));
const SECRET_NAMES = [
  'MACOS_CERTIFICATE_P12_BASE64',
  'MACOS_CERTIFICATE_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];
const TEAM = 'ABCDE12345';
const PASSWORD = 'sentinel-cert-password-7f3a';
const base64 = (text) => Buffer.from(text).toString('base64');
const secrets = {
  MACOS_CERTIFICATE_P12_BASE64: base64('sentinel p12 bytes that are not a certificate\n'),
  MACOS_CERTIFICATE_PASSWORD: PASSWORD,
  APPLE_ID: 'sentinel-apple-id@example.invalid',
  APPLE_APP_SPECIFIC_PASSWORD: 'sentinel-app-password-9c1d',
  APPLE_TEAM_ID: TEAM,
};

const searchList = () =>
  execFileSync('security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' });

function selfSignedDeveloperId(dir) {
  const config = join(dir, 'cert.cnf');
  writeFileSync(
    config,
    [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = ext',
      'prompt = no',
      '[dn]',
      `CN = Developer ID Application: Test (${TEAM})`,
      `OU = ${TEAM}`,
      'O = Test',
      '[ext]',
      'basicConstraints = critical, CA:FALSE',
      'keyUsage = critical, digitalSignature',
      'extendedKeyUsage = critical, codeSigning',
      '',
    ].join('\n'),
  );
  const openssl = (...args) => execFileSync('/usr/bin/openssl', args, { cwd: dir, stdio: 'pipe' });
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-config',
    config,
    '-keyout',
    'key.pem',
    '-out',
    'cert.pem',
  );
  openssl(
    'pkcs12',
    '-export',
    '-inkey',
    'key.pem',
    '-in',
    'cert.pem',
    '-out',
    'id.p12',
    '-passout',
    `pass:${PASSWORD}`,
  );
  return readFileSync(join(dir, 'id.p12')).toString('base64');
}

function run(overrides, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-import-signing-'));
  const runnerTemp = join(dir, 'runner');
  const githubEnv = join(dir, 'github_env');
  const stubs = join(dir, 'bin');
  const xcrunLog = join(dir, 'xcrun.log');
  mkdirSync(runnerTemp);
  mkdirSync(stubs);
  writeFileSync(githubEnv, '');
  writeFileSync(join(stubs, 'xcrun'), `#!/bin/sh\necho called >> '${xcrunLog}'\nexit 1\n`);
  chmodSync(join(stubs, 'xcrun'), 0o755);
  const env = {
    PATH: `${stubs}:${process.env.PATH}`,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    RUNNER_TEMP: runnerTemp,
    GITHUB_ENV: githubEnv,
    ...secrets,
    ...overrides,
  };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  const r = spawnSync('bash', [script, ...args], { env, encoding: 'utf8' });
  return {
    status: r.status,
    output: r.stdout + r.stderr,
    runnerTemp,
    githubEnv: readFileSync(githubEnv, 'utf8'),
    xcrunCalled: existsSync(xcrunLog),
    cleanup: () => spawnSync('bash', [script, '--cleanup'], { env, encoding: 'utf8' }),
  };
}

describe('ci-import-signing.sh', { skip: process.platform !== 'darwin' && 'needs macOS' }, () => {
  const original = searchList();
  after(() => {
    if (searchList() === original) return;
    const keychains = [...original.matchAll(/"(.*)"/g)].map((m) => m[1]);
    execFileSync('security', ['list-keychains', '-d', 'user', '-s', ...keychains]);
    assert.fail('a case changed the user keychain search list');
  });

  function assertRefused(overrides, expected) {
    const r = run(overrides);
    assert.notEqual(r.status, 0, 'the import fails');
    for (const text of expected) assert.ok(r.output.includes(text), `output names ${text}`);
    for (const value of Object.values({ ...secrets, ...overrides }))
      if (value) assert.ok(!r.output.includes(value), 'output prints no secret value');
    assert.deepEqual(readdirSync(r.runnerTemp), [], 'leaves no keychain, certificate, or list');
    assert.equal(r.githubEnv, '', 'exports nothing');
    assert.equal(r.xcrunCalled, false, 'never calls notarytool');
    assert.equal(searchList(), original, 'search list unchanged');
    for (let i = 0; i < 2; i += 1) assert.equal(r.cleanup().status, 0, 'cleanup is idempotent');
    assert.equal(searchList(), original, 'search list unchanged after cleanup');
    return r;
  }

  for (const name of SECRET_NAMES) {
    test(`refuses a missing ${name}`, () => {
      const r = assertRefused({ [name]: undefined }, [name]);
      for (const other of SECRET_NAMES.filter((n) => n !== name))
        assert.ok(!r.output.includes(other), `does not blame ${other}`);
    });
    test(`refuses an empty ${name}`, () => assertRefused({ [name]: '' }, [name]));
  }

  test('names every missing secret in one message', () => {
    const r = assertRefused(
      Object.fromEntries(SECRET_NAMES.map((n) => [n, undefined])),
      SECRET_NAMES,
    );
    assert.equal(r.output.trim().split('\n').length, 1, 'one message');
  });

  test('refuses without RUNNER_TEMP or GITHUB_ENV', () => {
    for (const name of ['RUNNER_TEMP', 'GITHUB_ENV']) {
      const r = run({ [name]: undefined });
      assert.notEqual(r.status, 0);
      assert.ok(r.output.includes(`${name} is not set`), `names ${name}`);
      assert.deepEqual(readdirSync(r.runnerTemp), []);
      assert.equal(searchList(), original);
    }
  });

  for (const team of ['abcde12345', 'ABCDE1234', 'ABCDE123456', 'ABCDE-1234'])
    test(`refuses the team ID shape ${team}`, () =>
      assertRefused({ APPLE_TEAM_ID: team }, ['APPLE_TEAM_ID must be the 10-character team ID']));

  // macOS `base64 --decode` accepts both of these and exits 0.
  for (const [label, value] of [
    ['non-base64 text', 'not base64!!'],
    ['truncated base64', 'aGVsbG8'],
  ])
    test(`refuses ${label}`, () =>
      assertRefused({ MACOS_CERTIFICATE_P12_BASE64: value }, [
        'MACOS_CERTIFICATE_P12_BASE64 is not valid base64',
      ]));

  test('refuses a blob that is not a .p12, and deletes the keychain it made', () =>
    assertRefused({}, [
      'did not import',
      'MACOS_CERTIFICATE_P12_BASE64',
      'MACOS_CERTIFICATE_PASSWORD',
    ]));

  test('refuses a self-signed Developer ID certificate the keychain does not trust', () => {
    const p12 = selfSignedDeveloperId(mkdtempSync(join(tmpdir(), 'ci-import-signing-cert-')));
    assertRefused({ MACOS_CERTIFICATE_P12_BASE64: p12 }, [
      'no valid Developer ID Application identity',
      'MACOS_CERTIFICATE_P12_BASE64',
      'APPLE_TEAM_ID',
    ]);
  });

  test('cleanup succeeds when nothing was created', () => {
    const r = run({}, ['--cleanup']);
    assert.equal(r.status, 0, r.output);
    assert.deepEqual(readdirSync(r.runnerTemp), []);
    assert.equal(searchList(), original);
  });
});
