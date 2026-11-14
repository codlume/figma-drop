// Byte identity of the POST body, before and after, for every fake document.
//   node identity.mjs --base <src> --work <src> --out <dir> [--docs a,b]
// Each side runs in its own process. The bodies are written to disk with exportedAt
// fixed, compared byte for byte, and hashed. The sandbox message is also passed
// through structuredClone, as figma.ui.postMessage would, and encoded again.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCUMENTS } from './docs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, index, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const out = args.out;
if (!args.base || !args.work || !out) throw new Error('pass --base <src> --work <src> --out <dir>');
mkdirSync(out, { recursive: true });
const docs = args.docs?.split(',') ?? Object.keys(DOCUMENTS).filter((doc) => doc !== 'deep3000');

let different = 0;
for (const doc of docs) {
  const files = {};
  const reports = {};
  for (const side of ['base', 'work']) {
    files[side] = join(out, `${doc}.${side}.json`);
    const stdout = execFileSync(
      process.execPath,
      [
        '--max-old-space-size=8192',
        join(here, 'bench.mjs'),
        '--src',
        args[side],
        '--doc',
        doc,
        '--mode',
        'dump',
        '--out',
        files[side],
      ],
      { encoding: 'utf8', maxBuffer: 1 << 26 },
    );
    reports[side] = JSON.parse(stdout.trim().split('\n').at(-1));
  }
  const base = readFileSync(files.base);
  const work = readFileSync(files.work);
  const same = base.equals(work);
  if (!same) different += 1;
  const sha = createHash('sha256').update(work).digest('hex');
  console.log(
    `${doc.padEnd(9)} ${String(reports.work.shape.totalNodes).padStart(5)} nodes  ${String(work.length).padStart(10)} B  ` +
      `${same ? 'IDENTICAL' : 'DIFFERENT'}  sha256 ${sha}  clone ${reports.base.cloneMatches && reports.work.cloneMatches ? 'ok' : 'MISMATCH'}`,
  );
}
console.log(different === 0 ? `all ${docs.length} bodies identical` : `${different} bodies differ`);
process.exitCode = different === 0 ? 0 : 1;
