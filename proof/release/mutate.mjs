import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = process.argv[2];
const mutations = {
  'build gets write': [
    'release.yml',
    (t) =>
      t.replace(
        '    permissions:\n      contents: read\n    env:\n      TAG',
        '    permissions:\n      contents: write\n    env:\n      TAG',
      ),
  ],
  'marker check removed': ['release.yml', (t) => t.replace('if grep -qF', 'if false && grep -qF')],
  'dry run uploads': [
    'release-dry-run.yml',
    (t) => t + '      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9\n',
  ],
};
for (const [label, [file, mutate]] of Object.entries(mutations)) {
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
  const msg = (r.stderr.match(/message: '([^']+)'|AssertionError[^\n]*/) ?? ['none'])[0];
  console.log(`${label}: exit ${r.status} ${msg}`);
}
