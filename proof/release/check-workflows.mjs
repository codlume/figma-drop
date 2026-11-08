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
const dry = parse(dryText);
const rel = parse(relText);

assert(!/\bwrite\b/.test(dryText), 'dry run mentions no write');
assert(!dryText.includes('secrets.'), 'dry run references no secrets');
assert(!dryText.includes('upload-artifact'), 'dry run uploads no artifacts');
assert(!dryText.includes('gh release'), 'dry run calls no gh release');
assert.deepEqual(dry.permissions, { contents: 'read', 'pull-requests': 'read' });
for (const [id, job] of Object.entries(dry.jobs))
  assert(!('permissions' in job), `dry-run job ${id} raises no permissions`);

assert.deepEqual(rel.permissions, { contents: 'read' }, 'release top-level is read-only');
assert(!relText.includes('secrets.'), 'release references no secrets');
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
    job.steps.some((s) => s.uses?.startsWith('googleapis/release-please-action@')),
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
for (const [id, job] of Object.entries({ ...rel.jobs, ...dry.jobs }))
  for (const step of job.steps)
    assert(!step.run?.includes('${{'), `${id} step interpolates no expression into run`);
for (const text of [relText, dryText]) {
  for (const m of text.matchAll(/uses: (\S+)/g))
    assert.match(m[1], /@[0-9a-f]{40}$/, `${m[1]} is pinned to a SHA`);
  assert(!text.includes('setup-vp'), 'no workflow uses setup-vp');
  for (const [line] of text.matchAll(/pnpm install\b.*/g))
    assert.match(line, /--frozen-lockfile/, `"${line.trim()}" keeps the lockfile frozen`);
}
for (const [id, job] of [
  ['build', rel.jobs.build],
  ['package', dry.jobs.package],
]) {
  const runs = job.steps.map((s) => s.run);
  assert(runs.includes('pnpm install --frozen-lockfile'), `${id} installs from the lockfile`);
  const node = job.steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
  assert.equal(node?.with['node-version-file'], '.node-version', `${id} reads .node-version`);
  assert.equal(node?.with['package-manager-cache'], false, `${id} restores no cache`);
}

const dir = mkdtempSync(join(tmpdir(), 'notice-'));
const body = join(dir, 'body.md');
const stubGh = join(dir, 'gh');
writeFileSync(
  stubGh,
  `#!/bin/bash
case "$1 $2" in
  "release view") cat "${body}" ;;
  "release edit") cp "$5" "${body}" ;;
  *) exit 1 ;;
esac
`,
);
chmodSync(stubGh, 0o755);
const step = (name) => rel.jobs.upload.steps.find((s) => s.name === name);
const notice = step('Add the install notice to the release notes').run;
const env = {
  ...process.env,
  PATH: `${dir}:${process.env.PATH}`,
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
assert.equal(once.split('<!-- figma-drop-unsigned-notice -->').length, 2, 'marker appears once');
assert(once.startsWith('## Changelog'), 'original notes kept');
assert(once.includes('`figma-drop-1.2.3-mac-arm64-unsigned.zip`'), 'version substituted');
assert(
  once.includes('shasum -a 256 -c --ignore-missing SHA256SUMS.txt'),
  'partial download checks',
);
assert(
  once.includes('https://github.com/codlume/figma-drop/blob/v1.2.3/RELEASING.md'),
  'link substituted',
);
assert(/^NOTICE$/m.test(notice), 'heredoc terminator at column 0');

writeFileSync(body, '* **fix:** a fix <!-- figma-drop-unsigned-notice --> ([#99](x))\n');
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
if (spawnSync('bash', ['-c', 'command -v sha256sum']).status !== 0) {
  writeFileSync(join(dir, 'sha256sum'), '#!/bin/bash\nexec shasum -a 256 "$@"\n');
  chmodSync(join(dir, 'sha256sum'), 0o755);
}
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
const zips = { 'a.zip': 'a', 'b.zip': 'b' };
const sums = ['a', 'b']
  .map((name) => `${createHash('sha256').update(name).digest('hex')}  ${name}.zip\n`)
  .join('');
assert.equal(verify('good', { ...zips, 'SHA256SUMS.txt': sums }), 0, 'verify accepts the artifact');
assert.notEqual(
  verify('tampered', { ...zips, 'b.zip': 'x', 'SHA256SUMS.txt': sums }),
  0,
  'verify rejects a changed zip',
);
assert.notEqual(
  verify('extra', { ...zips, 'c.zip': 'c', 'SHA256SUMS.txt': sums }),
  0,
  'verify rejects a file SHA256SUMS.txt does not list',
);
assert.notEqual(verify('missing', zips), 0, 'verify rejects an artifact without SHA256SUMS.txt');
assert.equal(
  step('Upload the release assets').run,
  'gh release upload "${TAG}" release-artifacts/* --clobber',
  'upload sends every verified file',
);
console.log(once);
console.log('all workflow checks passed');
