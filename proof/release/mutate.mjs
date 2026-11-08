import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = process.argv[2];
const setupNode =
  '      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n';
const mutations = {
  'build gets write': [
    'release.yml',
    'only release-please, release-pr, and upload write',
    (t) =>
      t.replace(
        '    permissions:\n      contents: read\n    env:\n      TAG',
        '    permissions:\n      contents: write\n    env:\n      TAG',
      ),
  ],
  'release-please loses issues write': [
    'release.yml',
    'release-please can label the release PR with issues: write',
    (t) => t.replace('      issues: write\n', ''),
  ],
  'release-pr loses issues write': [
    'release.yml',
    'release-pr can label the release PR with issues: write',
    (t) => t.replace(/(release-pr:[\s\S]*?)      issues: write\n/, '$1'),
  ],
  'release-please also opens the PR': [
    'release.yml',
    'release-please sets skip-github-pull-request: true',
    (t) => t.replace('          skip-github-pull-request: true\n', ''),
  ],
  'release-pr also creates releases': [
    'release.yml',
    'release-pr sets skip-github-release: true',
    (t) => t.replace('          skip-github-release: true\n', ''),
  ],
  'build waits for release-pr': [
    'release.yml',
    'build does not depend on release-pr',
    (t) =>
      t.replace(
        '  build:\n    needs: release-please',
        '  build:\n    needs: [release-please, release-pr]',
      ),
  ],
  'setup-vp returns': [
    'release-dry-run.yml',
    'no workflow uses setup-vp',
    (t) =>
      t.replace(
        setupNode,
        '      - uses: voidzero-dev/setup-vp@cab1ab9eaff52d4857875f4f2c016e36af8f2c76 # v1.22.0\n',
      ),
  ],
  'install not frozen': [
    'release.yml',
    'keeps the lockfile frozen',
    (t) => t.replace('pnpm install --frozen-lockfile', 'pnpm install'),
  ],
  'marker check removed': [
    'release.yml',
    'second run leaves the body unchanged',
    (t) => t.replace("if tr -d '\\r'", "if false && tr -d '\\r'"),
  ],
  'CRLF marker missed': [
    'release.yml',
    'a CRLF body that already carries the marker stays unchanged',
    (t) =>
      t.replace(
        `tr -d '\\r' < notes.md | grep -qxF -- "\${marker}"`,
        `grep -qxF -- "\${marker}" notes.md`,
      ),
  ],
  'marker matched anywhere': [
    'release.yml',
    'a marker inside a line keeps the notice',
    (t) => t.replace('grep -qxF', 'grep -qF'),
  ],
  'checksums not rechecked': [
    'release.yml',
    'verify rejects a changed zip',
    (t) => t.replace('          sha256sum -c SHA256SUMS.txt\n', ''),
  ],
  'extra files uploaded': [
    'release.yml',
    'verify rejects a file SHA256SUMS.txt does not list',
    (t) => t.replace('if [ "${present}" != "${listed}" ]', 'if false'),
  ],
  'dry run uploads': [
    'release-dry-run.yml',
    'dry run uploads no artifacts',
    (t) => t + '      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9\n',
  ],
};
let missed = 0;
for (const [label, [file, expected, mutate]] of Object.entries(mutations)) {
  const dir = mkdtempSync(join(tmpdir(), 'mut-'));
  cpSync(join(repo, '.github'), join(dir, '.github'), { recursive: true });
  const path = join(dir, '.github/workflows', file);
  const before = readFileSync(path, 'utf8');
  const after = mutate(before);
  if (after === before) throw new Error(`${label} did not apply`);
  writeFileSync(path, after);
  const r = spawnSync('node', [new URL('check-workflows.mjs', import.meta.url).pathname, dir], {
    encoding: 'utf8',
  });
  const caught = r.status !== 0 && r.stderr.includes(expected);
  if (!caught) missed += 1;
  console.log(
    `${label}: exit ${r.status} ${caught ? 'caught by' : 'NOT CAUGHT, expected'} "${expected}"`,
  );
}
process.exit(missed === 0 ? 0 : 1);
