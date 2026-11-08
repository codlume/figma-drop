import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
assert.deepEqual(writers, ['release-please', 'upload'], 'only release-please and upload write');
const rpUsers = Object.entries(rel.jobs)
  .filter(([, job]) =>
    job.steps.some((s) => s.uses?.startsWith('googleapis/release-please-action@')),
  )
  .map(([id]) => id);
assert.deepEqual(rpUsers, ['release-please'], 'only release-please runs the action');
assert.equal(rel.jobs['release-please'].steps.length, 1, 'release-please job runs only the action');
assert(
  !rel.jobs.upload.steps.some((s) => s.uses?.startsWith('actions/checkout')),
  'upload checks out no code',
);
for (const [id, job] of Object.entries({ ...rel.jobs, ...dry.jobs }))
  for (const step of job.steps)
    assert(!step.run?.includes('${{'), `${id} step interpolates no expression into run`);
for (const text of [relText, dryText])
  for (const m of text.matchAll(/uses: (\S+)/g))
    assert.match(m[1], /@[0-9a-f]{40}$/, `${m[1]} is pinned to a SHA`);

// Run the notice step twice against a stub gh that stores the release body in a file.
const dir = mkdtempSync(join(tmpdir(), 'notice-'));
const body = join(dir, 'body.md');
writeFileSync(body, '## Changelog\n\n* a fix\n');
const gh = join(dir, 'gh');
writeFileSync(
  gh,
  `#!/bin/bash
case "$1 $2" in
  "release view") cat "${body}" ;;
  "release edit") cp "$5" "${body}" ;;
  *) exit 1 ;;
esac
`,
);
chmodSync(gh, 0o755);
const notice = rel.jobs.upload.steps.find(
  (s) => s.name === 'Add the install notice to the release notes',
).run;
const env = {
  ...process.env,
  PATH: `${dir}:${process.env.PATH}`,
  TAG: 'v1.2.3',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'codlume/figma-drop',
};
execFileSync('bash', ['-eo', 'pipefail', '-c', notice], { cwd: dir, env });
const once = readFileSync(body, 'utf8');
execFileSync('bash', ['-eo', 'pipefail', '-c', notice], { cwd: dir, env });
assert.equal(readFileSync(body, 'utf8'), once, 'second run leaves the body unchanged');
assert.equal(once.split('<!-- figma-drop-unsigned-notice -->').length, 2, 'marker appears once');
assert(once.startsWith('## Changelog'), 'original notes kept');
assert(once.includes('`figma-drop-1.2.3-mac-arm64-unsigned.zip`'), 'version substituted');
assert(
  once.includes('https://github.com/codlume/figma-drop/blob/v1.2.3/RELEASING.md'),
  'link substituted',
);
assert(/^NOTICE$/m.test(notice), 'heredoc terminator at column 0');
console.log(once);
console.log('all workflow checks passed');
