import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const repo = process.argv[2];
const read = (name) => readFileSync(join(repo, '.github/workflows', name), 'utf8');
const dryText = read('release-dry-run.yml');
const relText = read('release.yml');
const pkgText = read('package-macos.yml');
const dry = parse(dryText);
const rel = parse(relText);
const pkgWorkflow = parse(pkgText);
const SECRETS = [
  'MACOS_CERTIFICATE_P12_BASE64',
  'MACOS_CERTIFICATE_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];
const byName = Object.fromEntries(SECRETS.map((name) => [name, `\${{ secrets.${name} }}`]));
const stepLabel = (step) => step.name ?? step.run ?? step.uses;
const indexOf = (steps, predicate, what) => {
  const i = steps.findIndex(predicate);
  assert.notEqual(i, -1, `${what} exists`);
  return i;
};

assert(!/\bwrite\b/.test(dryText), 'dry run mentions no write');
assert(!dryText.includes('secrets.'), 'dry run references no secrets');
assert(!dryText.includes('upload-artifact'), 'dry run uploads no artifacts');
assert(!dryText.includes('gh release'), 'dry run calls no gh release');
assert(!dryText.includes('package-macos.yml'), 'dry run never calls the signed package workflow');
assert.deepEqual(dry.permissions, { contents: 'read', 'pull-requests': 'read' });
for (const [id, job] of Object.entries(dry.jobs))
  assert(!('permissions' in job), `dry-run job ${id} raises no permissions`);
const dryRuns = dry.jobs.package.steps.map((s) => s.run);
assert(
  dryRuns.indexOf('node scripts/dmg.mjs --setup') !== -1 &&
    dryRuns.indexOf('node scripts/dmg.mjs --setup') < dryRuns.indexOf('pnpm release:dry-run'),
  'package installs dmgbuild before the dry run',
);
assert(
  dry.jobs.package.steps.some((s) => s.name === 'Release mode refuses the ad-hoc build'),
  'dry run checks that release mode refuses the ad-hoc build',
);

assert.deepEqual(rel.permissions, { contents: 'read' }, 'release top-level is read-only');
const secretReaders = Object.entries(rel.jobs)
  .filter(([, job]) => JSON.stringify(job).includes('secrets.'))
  .map(([id]) => id);
assert.deepEqual(secretReaders, ['build'], 'only build reads secrets');
for (const [id, job] of Object.entries(rel.jobs))
  assert(!('environment' in job), `release job ${id} names no environment`);
const build = rel.jobs.build;
assert.equal(build.uses, './.github/workflows/package-macos.yml', 'build calls package-macos.yml');
assert.deepEqual(build.permissions, { contents: 'read' }, 'build calls it with contents: read');
assert.deepEqual(
  build.with,
  {
    tag: '${{ needs.release-please.outputs.tag_name }}',
    sha: '${{ needs.release-please.outputs.sha }}',
  },
  'build passes the tag and the tagged commit',
);
assert.deepEqual(build.secrets, byName, 'build passes exactly the five secrets by name');
const writers = Object.entries(rel.jobs)
  .filter(([, job]) => Object.values(job.permissions ?? {}).includes('write'))
  .map(([id]) => id);
assert.deepEqual(
  writers,
  ['release-please', 'release-pr', 'upload'],
  'only release-please, release-pr, and upload write',
);
const rpUsers = Object.entries(rel.jobs)
  .filter(([, job]) =>
    (job.steps ?? []).some((s) => s.uses?.startsWith('googleapis/release-please-action@')),
  )
  .map(([id]) => id);
assert.deepEqual(
  rpUsers,
  ['release-please', 'release-pr'],
  'only the two release-please jobs run the action',
);
const rpWrite = { contents: 'write', 'pull-requests': 'write', issues: 'write' };
for (const [id, skip] of [
  ['release-please', 'skip-github-pull-request'],
  ['release-pr', 'skip-github-release'],
]) {
  const job = rel.jobs[id];
  assert.deepEqual(job.permissions, rpWrite, `${id} can label the release PR with issues: write`);
  assert.equal(job.steps.length, 1, `${id} job runs only the action`);
  assert.equal(job.steps[0].with[skip], true, `${id} sets ${skip}: true`);
  assert.equal(job.concurrency?.['cancel-in-progress'], false, `${id} never cancels a run`);
}
assert.notEqual(
  rel.jobs['release-please'].concurrency.group,
  rel.jobs['release-pr'].concurrency.group,
  'release-please and release-pr queue apart',
);
for (const [id, job] of Object.entries(rel.jobs))
  assert(![job.needs ?? []].flat().includes('release-pr'), `${id} does not depend on release-pr`);
assert(
  !rel.jobs.upload.steps.some((s) => s.uses?.startsWith('actions/checkout')),
  'upload checks out no code',
);
const download = rel.jobs.upload.steps.find((s) =>
  s.uses?.startsWith('actions/download-artifact@'),
);
assert.equal(
  download?.with.name,
  'release-${{ needs.release-please.outputs.tag_name }}',
  'upload downloads the release artifact',
);

assert.deepEqual(
  Object.keys(pkgWorkflow.on).sort(),
  ['workflow_call', 'workflow_dispatch'],
  'package-macos runs only when called or dispatched',
);
assert.equal(pkgWorkflow.on.workflow_dispatch, null, 'dispatch takes no inputs');
assert.deepEqual(
  Object.keys(pkgWorkflow.on.workflow_call.inputs).sort(),
  ['sha', 'tag'],
  'package-macos takes a tag and a commit',
);
assert.deepEqual(
  pkgWorkflow.on.workflow_call.secrets,
  Object.fromEntries(SECRETS.map((name) => [name, { required: true }])),
  'package-macos requires the caller to pass each secret',
);
assert.deepEqual(pkgWorkflow.permissions, { contents: 'read' }, 'package-macos top is read-only');
assert(!/\bwrite\b/.test(pkgText), 'package-macos grants no write');
assert(!/\bgh release\b/.test(pkgText), 'package-macos calls no gh release');
assert.deepEqual(Object.keys(pkgWorkflow.jobs), ['package'], 'package-macos has one job');
const pkg = pkgWorkflow.jobs.package;
assert.equal(pkg.environment, 'release', 'package reads secrets from the release environment');
assert.deepEqual(pkg.permissions, { contents: 'read' }, 'package job is read-only');
assert.equal(pkg.steps[0].with.ref, '${{ inputs.sha }}', 'package checks out the given commit');
assert.equal(pkg.steps[0].with['persist-credentials'], false, 'package keeps no git token');
assert(
  !JSON.stringify({ ...pkg, steps: [] }).includes('secrets.'),
  'package hands no secret to the whole job',
);
const credentialSteps = pkg.steps.filter((s) => JSON.stringify(s).includes('secrets.'));
assert.deepEqual(
  credentialSteps.map(stepLabel),
  ['Import the signing and notary credentials'],
  'secrets only in the credential step env',
);
const [credentials] = credentialSteps;
assert.deepEqual(credentials.env, byName, 'the credential step env holds exactly the five secrets');
assert.equal(credentials.run, 'bash scripts/ci-import-signing.sh', 'the credential step imports');
const steps = pkg.steps;
const at = {
  credentials: steps.indexOf(credentials),
  dmgSetup: indexOf(steps, (s) => s.run === 'node scripts/dmg.mjs --setup', 'dmgbuild setup'),
  build: indexOf(steps, (s) => s.run === 'pnpm build', 'pnpm build'),
  app: indexOf(steps, (s) => s.run === 'node scripts/package-local.mjs', 'app packaging'),
  release: indexOf(steps, (s) => s.run?.includes('scripts/release-package.mjs'), 'DMG packaging'),
  cleanup: indexOf(
    steps,
    (s) => s.run === 'bash scripts/ci-import-signing.sh --cleanup',
    'keychain cleanup',
  ),
};
for (const gate of ['pnpm typecheck', 'pnpm test', 'pnpm test:release'])
  assert(
    indexOf(steps, (s) => s.run === gate, gate) < at.credentials,
    `${gate} runs before the secrets`,
  );
assert(at.build < at.credentials, 'the build runs before the secrets');
assert(at.dmgSetup < at.credentials, 'dmgbuild setup precedes the credential step');
assert(at.credentials < at.app && at.app < at.release, 'packaging runs after the credential step');
assert(at.release < at.cleanup, 'cleanup runs after packaging');
assert.equal(steps[at.cleanup].if, 'always()', 'package deletes the keychain after a failure too');
assert.equal(pkg.env.TAG, '${{ inputs.tag }}', 'package reads the tag from its input');

const uploads = steps.filter((s) => s.uses?.startsWith('actions/upload-artifact@'));
const uploadOf = (name) => uploads.find((s) => s.with.name === name);
const v = '${{ steps.version.outputs.version }}';
const lines = (text) => text.trim().split('\n');
const releaseUpload = uploadOf('release-${{ inputs.tag }}');
assert.equal(releaseUpload?.if, "inputs.tag != ''", 'the release artifact is for a tag only');
assert.deepEqual(
  lines(releaseUpload.with.path),
  [
    `release-artifacts/figma-drop-${v}-mac-arm64.dmg`,
    `release-artifacts/figma-drop-figma-plugin-${v}.zip`,
    'release-artifacts/SHA256SUMS.txt',
  ],
  'release artifact holds exactly the DMG, plugin zip, and SHA256SUMS.txt',
);
assert.equal(releaseUpload.with['retention-days'], 7, 'the release artifact lasts 7 days');
const notaryUpload = uploadOf('notary-logs-${{ inputs.tag }}');
assert.equal(notaryUpload?.if, "inputs.tag != ''", 'tag notary logs are a separate artifact');
assert.equal(notaryUpload.with.path, 'release-artifacts/notary/', 'notary logs hold only logs');
const testUpload = uploadOf('package-test-${{ github.run_id }}');
assert.equal(testUpload?.if, "inputs.tag == ''", 'the package test artifact is for dispatch only');
assert.deepEqual(
  lines(testUpload.with.path),
  [
    `release-artifacts/figma-drop-${v}-mac-arm64-dry-run.dmg`,
    `release-artifacts/figma-drop-figma-plugin-${v}-dry-run.zip`,
    'release-artifacts/SHA256SUMS-dry-run.txt',
    'release-artifacts/release-plan.json',
    'release-artifacts/notary/',
  ],
  'package test artifact holds the dry-run DMG, zip, sums, plan, and notary logs',
);
assert(testUpload.with['retention-days'] <= 3, 'the package test artifact expires within 3 days');
assert.equal(uploads.length, 3, 'package uploads only those three artifacts');

const workflows = [
  ['release.yml', relText, rel],
  ['release-dry-run.yml', dryText, dry],
  ['package-macos.yml', pkgText, pkgWorkflow],
];
for (const [file, text, workflow] of workflows) {
  for (const [id, job] of Object.entries(workflow.jobs))
    for (const step of job.steps ?? [])
      assert(!step.run?.includes('${{'), `${file} ${id} step interpolates no expression into run`);
  for (const m of text.matchAll(/uses: (\S+)/g))
    if (!m[1].startsWith('./')) assert.match(m[1], /@[0-9a-f]{40}$/, `${m[1]} is pinned to a SHA`);
  assert(!text.includes('setup-vp'), 'no workflow uses setup-vp');
  assert(!text.includes('secrets: inherit'), `${file} inherits no secrets`);
  for (const [line] of text.matchAll(/pnpm install\b.*/g))
    assert.match(line, /--frozen-lockfile/, `"${line.trim()}" keeps the lockfile frozen`);
}
for (const [id, job] of [
  ['package-macos', pkg],
  ['release dry run', dry.jobs.package],
]) {
  const runs = job.steps.map((s) => s.run);
  assert(runs.includes('pnpm install --frozen-lockfile'), `${id} installs from the lockfile`);
  const node = job.steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
  assert.equal(node?.with['node-version-file'], '.node-version', `${id} reads .node-version`);
  assert.equal(node?.with['package-manager-cache'], false, `${id} restores no cache`);
}

const dir = mkdtempSync(join(tmpdir(), 'notice-'));
const stub = (name, body) => {
  writeFileSync(join(dir, name), `#!/bin/bash\n${body}`);
  chmodSync(join(dir, name), 0o755);
};
const stubEnv = { ...process.env, PATH: `${dir}:${process.env.PATH}` };

const releaseStep = steps[at.release];
stub('node', 'echo "node $*"\n');
const packageArgs = (tag) =>
  execFileSync('bash', ['-eo', 'pipefail', '-c', releaseStep.run], {
    cwd: dir,
    env: { ...stubEnv, TAG: tag },
    encoding: 'utf8',
  }).trim();
assert.equal(
  packageArgs('v1.2.3'),
  'node scripts/release-package.mjs --tag v1.2.3',
  'a tag runs release mode',
);
assert.equal(
  packageArgs(''),
  'node scripts/release-package.mjs --dry-run',
  'no tag runs a dry run',
);

const body = join(dir, 'body.md');
stub(
  'gh',
  `case "$1 $2" in
  "release view") cat "${body}" ;;
  "release edit") cp "$5" "${body}" ;;
  *) exit 1 ;;
esac
`,
);
const step = (name) => rel.jobs.upload.steps.find((s) => s.name === name);
const notice = step('Add the install notice to the release notes').run;
const env = {
  ...stubEnv,
  TAG: 'v1.2.3',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'codlume/figma-drop',
};
const runNotice = () => execFileSync('bash', ['-eo', 'pipefail', '-c', notice], { cwd: dir, env });
writeFileSync(body, '## Changelog\n\n* a fix\n');
runNotice();
const once = readFileSync(body, 'utf8');
runNotice();
assert.equal(readFileSync(body, 'utf8'), once, 'second run leaves the body unchanged');
assert.equal(once.split('<!-- figma-drop-install-notice -->').length, 2, 'marker appears once');
assert(once.startsWith('## Changelog'), 'original notes kept');
assert(once.includes('`figma-drop-1.2.3-mac-arm64.dmg`'), 'notice names the DMG');
assert(!once.includes('mac-arm64.zip'), 'notice no longer names a desktop zip');
assert(
  /Open it, drag `figma-drop` to Applications, and eject/.test(once),
  'notice says to open the DMG, drag figma-drop to Applications, and eject',
);
assert(once.includes('`figma-drop-figma-plugin-1.2.3.zip`'), 'notice names the plugin zip');
assert(
  once.includes('shasum -a 256 -c --ignore-missing SHA256SUMS.txt'),
  'partial download checks',
);
assert(
  once.includes('https://github.com/codlume/figma-drop/blob/v1.2.3/RELEASING.md'),
  'link substituted',
);
assert(/^NOTICE$/m.test(notice), 'heredoc terminator at column 0');

writeFileSync(body, '* **fix:** a fix <!-- figma-drop-install-notice --> ([#99](x))\n');
runNotice();
const inline = readFileSync(body, 'utf8');
assert.equal(inline.match(/^## Install$/gm)?.length, 1, 'a marker inside a line keeps the notice');

writeFileSync(body, once.replaceAll('\n', '\r\n'));
runNotice();
assert.equal(
  readFileSync(body, 'utf8'),
  once.replaceAll('\n', '\r\n'),
  'a CRLF body that already carries the marker stays unchanged',
);

const verifyStep = step('Verify the downloaded assets');
assert.equal(verifyStep['working-directory'], 'release-artifacts', 'verify runs in the artifact');
if (spawnSync('bash', ['-c', 'command -v sha256sum']).status !== 0)
  stub('sha256sum', 'exec shasum -a 256 "$@"\n');
const verify = (name, files) => {
  const artifact = join(dir, name);
  mkdirSync(artifact);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(artifact, file), text);
  return spawnSync('bash', ['-eo', 'pipefail', '-c', verifyStep.run], {
    cwd: artifact,
    env,
    encoding: 'utf8',
  }).status;
};
const assets = {
  'figma-drop-1.2.3-mac-arm64.dmg': 'dmg',
  'figma-drop-figma-plugin-1.2.3.zip': 'zip',
};
const sums = Object.entries(assets)
  .map(([name, text]) => `${createHash('sha256').update(text).digest('hex')}  ${name}\n`)
  .join('');
assert.equal(
  verify('good', { ...assets, 'SHA256SUMS.txt': sums }),
  0,
  'verify accepts the artifact',
);
assert.notEqual(
  verify('tampered', { ...assets, 'figma-drop-1.2.3-mac-arm64.dmg': 'x', 'SHA256SUMS.txt': sums }),
  0,
  'verify rejects a changed DMG',
);
assert.notEqual(
  verify('extra', { ...assets, 'notary-log-app.json': '{}', 'SHA256SUMS.txt': sums }),
  0,
  'verify rejects a file SHA256SUMS.txt does not list',
);
assert.notEqual(verify('missing', assets), 0, 'verify rejects an artifact without SHA256SUMS.txt');
assert.equal(
  step('Upload the release assets').run,
  'gh release upload "${TAG}" release-artifacts/* --clobber',
  'upload sends every verified file',
);
console.log(once);
console.log('all workflow checks passed');
