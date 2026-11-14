// Alternates base and work processes (A, B, A, B, ...) and compares their medians.
//   node ab.mjs --base <src> --work <src> --docs screen,page --rounds 7 [--iters 7] [--warmup 3] [--engine qjs]
// Each process reports the median wall time of its timed exports. The verdict line
// gives the median and range of those process medians per side, and whether the
// normalized wire bodies hash the same.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, index, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const sides = { base: args.base, work: args.work };
if (!sides.base || !sides.work || !args.docs)
  throw new Error('pass --base <src> --work <src> --docs a,b');
const rounds = Number(args.rounds ?? 7);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const show = (values) =>
  `${median(values).toFixed(1)} [${Math.min(...values).toFixed(1)}..${Math.max(...values).toFixed(1)}]`;

function once(side, doc) {
  const node = (script, extra) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['--max-old-space-size=8192', script, '--src', sides[side], '--doc', doc, ...extra],
        { encoding: 'utf8', maxBuffer: 1 << 26 },
      )
        .trim()
        .split('\n')
        .at(-1),
    );
  if (args.engine === 'qjs') {
    const result = node(join(here, 'qjs/run.mjs'), [
      '--iters',
      args.iters ?? '3',
      '--warmup',
      args.warmup ?? '1',
    ]);
    return {
      wallMs: { median: result.medianMs },
      cpuMs: { median: result.cpuMedianMs },
      cpuMinMs: result.cpuMinMs,
      sha256: `${result.fnv}-${result.chars}`,
      shape: result,
    };
  }
  return node(join(here, 'bench.mjs'), [
    '--mode',
    'export',
    '--iters',
    args.iters ?? '7',
    '--warmup',
    args.warmup ?? '3',
  ]);
}

for (const doc of args.docs.split(',')) {
  const wall = { base: [], work: [] };
  const cpu = { base: [], work: [] };
  const best = { base: [], work: [] };
  const hashes = { base: new Set(), work: new Set() };
  let shape;
  for (let round = 0; round < rounds; round += 1) {
    for (const side of round % 2 === 0 ? ['base', 'work'] : ['work', 'base']) {
      const result = once(side, doc);
      wall[side].push(result.wallMs.median);
      cpu[side].push(result.cpuMs.median);
      best[side].push(result.cpuMinMs);
      hashes[side].add(result.sha256);
      shape = result.shape;
    }
  }
  const same =
    hashes.base.size === 1 && hashes.work.size === 1 && [...hashes.base][0] === [...hashes.work][0];
  const line = (label, samples) => {
    const delta = (median(samples.work) / median(samples.base) - 1) * 100;
    const disjoint =
      Math.max(...samples.work) < Math.min(...samples.base) ||
      Math.min(...samples.work) > Math.max(...samples.base);
    return `${label} base ${show(samples.base)}  work ${show(samples.work)}  ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% ${disjoint ? 'disjoint' : 'OVERLAP'}`;
  };
  const faster = cpu.work.filter((value, round) => value < cpu.base[round]).length;
  const ratios = cpu.work.map((value, round) => value / cpu.base[round]);
  const paired = `paired cpu ratio ${median(ratios).toFixed(3)} [${Math.min(...ratios).toFixed(3)}..${Math.max(...ratios).toFixed(3)}], work faster in ${faster}/${rounds} rounds`;
  const floor = (side) => Math.min(...best[side]);
  const fastest = `fastest cpu ${floor('base').toFixed(1)} -> ${floor('work').toFixed(1)} ms (${((floor('work') / floor('base') - 1) * 100).toFixed(1)}%)`;
  console.log(
    `${doc.padEnd(9)} nodes ${String(shape.totalNodes).padStart(5)}  ${line('cpu ms', cpu)}  |  ${line('wall ms', wall)}  |  ` +
      `${paired}  |  ${fastest}  |  payload ${same ? 'IDENTICAL' : 'DIFFERENT'} ${[...hashes.work][0].slice(0, 12)}  (${args.engine ?? 'node'}, ${rounds} processes per side)`,
  );
}
