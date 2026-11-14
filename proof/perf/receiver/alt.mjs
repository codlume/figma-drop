// usage: ELECTRON=<electron binary> RECEIVER_WORK=<work dir> node alt.mjs <mode> <rounds> <iterations> <body> <nameA> <nameB> [...]
// Reads $RECEIVER_WORK/bodies/<body>.json and $RECEIVER_WORK/built/<name>/, and appends every run to $RECEIVER_WORK/results.jsonl.
// mode "phase" runs phase.cjs in-process timings, mode "e2e" drives receiver.cjs over HTTP.
// Sides alternate A, B, A, B so drift and other load hit both. Each run is a fresh process;
// its first iteration is dropped as warmup. Prints the median and range per metric per side.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, roundsArg, iterArg, body, ...names] = process.argv.slice(2);
const rounds = Number(roundsArg);
const iterations = Number(iterArg);
const here = dirname(fileURLToPath(import.meta.url));
const work = process.env.RECEIVER_WORK;
const electron = process.env.ELECTRON;
if (!work || !electron)
  throw new Error('set RECEIVER_WORK to the work directory and ELECTRON to the Electron binary');
const samples = Object.fromEntries(names.map((name) => [name, Object.create(null)]));
const identities = {};
const failures = [];
const statuses = Object.fromEntries(names.map((name) => [name, {}]));
const loadBefore = execFileSync('cat', ['/proc/loadavg']).toString().trim();

function run(name) {
  const args =
    mode === 'phase'
      ? [
          '--expose-gc',
          `${here}/phase.cjs`,
          `${work}/built/${name}/phase.cjs`,
          `${work}/bodies/${body}.json`,
          String(iterations),
          `${work}/runs/staging-${process.pid}`,
        ]
      : [
          `${here}/e2e.mjs`,
          electron,
          `${work}/built/${name}/receiver.cjs`,
          `${work}/bodies/${body}.json`,
          String(iterations),
        ];
  const binary = mode === 'phase' ? electron : process.execPath;
  const text = execFileSync(binary, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString();
  const line = text.trim().split('\n').pop();
  appendFileSync(
    `${work}/results.jsonl`,
    `${JSON.stringify({ at: new Date().toISOString(), mode, name, ...JSON.parse(line) })}\n`,
  );
  return JSON.parse(line);
}

for (let round = 0; round < rounds; round += 1) {
  for (const name of names) {
    const result = run(name);
    if (result.failure) failures.push({ name, ...result.failure });
    identities[name] = JSON.stringify(result.identity);
    const rows = result.rows.length > 1 ? result.rows.slice(1) : result.rows;
    for (const row of rows) {
      if (row.status !== undefined)
        statuses[name][row.status] = (statuses[name][row.status] ?? 0) + 1;
      for (const [metric, value] of Object.entries(row)) (samples[name][metric] ??= []).push(value);
    }
    const peak =
      mode === 'phase' ? result.maxRssMb : Math.max(...result.rows.map((row) => row.hwmMb));
    (samples[name].peakRssMb ??= []).push(peak);
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};
const show = (values) => `${median(values)} [${Math.min(...values)}..${Math.max(...values)}]`;
console.log(
  `# ${mode} ${body}: ${rounds} alternating rounds x ${iterations} iterations (first dropped), load before ${loadBefore}, after ${execFileSync('cat', ['/proc/loadavg']).toString().trim()}`,
);
const metrics = Object.keys(samples[names[0]]).filter((metric) => metric !== 'status');
for (const metric of metrics) {
  console.log(
    metric.padEnd(12),
    names
      .map(
        (name) =>
          `${name}: ${show(samples[name][metric] ?? [NaN])} n=${samples[name][metric]?.length ?? 0}`,
      )
      .join('   '),
  );
}
const same = new Set(Object.values(identities)).size === 1;
console.log(
  `identity (hash, file count, bytes digest) ${same ? 'identical across sides' : 'DIFFERS'}: ${identities[names[0]]}`,
);
if (!same) console.log(identities);
console.log(failures.length ? `FAILURES ${JSON.stringify(failures)}` : 'no transport failures');
if (mode === 'e2e') console.log(`reply statuses after warmup ${JSON.stringify(statuses)}`);
