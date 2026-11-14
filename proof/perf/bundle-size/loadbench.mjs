// Interleaves load timings across builds so every side sees the same machine noise.
// usage: node loadbench.mjs <rounds> <node-binary> <samples.json> <label=dir[=node-flag]> ...
// Each dir holds main.cjs and receiver.cjs. The first side is the base the others are compared to.
// Set ELECTRON_RUN_AS_NODE=1 and pass the Electron binary to time under the Node that ships.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [roundsArg, node, samplesFile, ...sides] = process.argv.slice(2);
const rounds = Number(roundsArg);
const loader = new URL('./loadone.cjs', import.meta.url).pathname;
const variants = sides.map((side) => {
  const [label, dir, flag] = side.split('=');
  return { label, dir, flags: flag ? [flag] : [] };
});
const entries = ['main', 'receiver'];
const metrics = ['cpuMs', 'wallMs'];
const loadAverage = () => readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ');

const samples = {};
const failures = [];
const loadBefore = loadAverage();
for (let round = 0; round < rounds; round++) {
  // Rotating the order keeps any one side from always running first.
  const order = variants.map((_, i) => variants[(i + round) % variants.length]);
  for (const { label, dir, flags } of order) {
    for (const entry of entries) {
      const out = JSON.parse(
        execFileSync(node, [...flags, loader, join(dir, `${entry}.cjs`)], { encoding: 'utf8' }),
      );
      const key = `${label} ${entry}`;
      // main registers its listeners on the Electron stub, the receiver exactly one on the port.
      if (out.outcome !== 'loaded' || out.listeners !== (entry === 'receiver' ? 1 : 0))
        failures.push({ key, out });
      for (const metric of metrics) ((samples[metric] ??= {})[key] ??= []).push(out[metric]);
    }
  }
}
const version = execFileSync(
  node,
  ['-p', 'process.versions.node + " (V8 " + process.versions.v8 + ")"'],
  { encoding: 'utf8' },
).trim();
writeFileSync(samplesFile, `${JSON.stringify({ node: version, rounds, samples })}\n`);

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const sorted = (values) => values.toSorted((a, b) => a - b);
const ms = (value) => value.toFixed(1).padStart(7);
console.log(`node ${version}, ${rounds} rounds, ${failures.length} failed loads`);
console.log(`load average before ${loadBefore}, after ${loadAverage()}`);
// A bundle that failed to load returns in a millisecond or two, which would read as a speedup.
if (failures.length > 0) {
  console.log(JSON.stringify(failures.slice(0, 3)));
  process.exit(1);
}
const [base, ...others] = variants;
for (const metric of metrics) {
  console.log(`\n${metric.padEnd(29)} bytes     min     p25  median     p75     max`);
  for (const { label, dir } of variants) {
    for (const entry of entries) {
      const values = sorted(samples[metric][`${label} ${entry}`]);
      const cells = [0, 0.25, 0.5, 0.75].map((q) => quantile(values, q)).concat(values.at(-1));
      const bytes = statSync(join(dir, `${entry}.cjs`)).size;
      console.log(
        `${`${label} ${entry}`.padEnd(28)} ${String(bytes).padStart(7)} ${cells.map(ms).join(' ')}`,
      );
    }
  }
  // Each round ran every side back to back, so the per-round difference cancels slow drift.
  for (const { label } of others) {
    for (const entry of entries) {
      const saved = samples[metric][`${base.label} ${entry}`].map(
        (value, round) => value - samples[metric][`${label} ${entry}`][round],
      );
      const values = sorted(saved);
      console.log(
        `${label} ${entry}: below ${base.label} in ${saved.filter((d) => d > 0).length} of ${rounds} rounds, ` +
          `per-round saving median ${quantile(values, 0.5).toFixed(1)} ms ` +
          `[p25 ${quantile(values, 0.25).toFixed(1)}, p75 ${quantile(values, 0.75).toFixed(1)}]`,
      );
    }
  }
}
