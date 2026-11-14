// usage: <runtime> pair.cjs <step> <body.json> <pairs> <bundleA> <bundleB>
// Runs one pipeline step from two builds back to back in one process, A then B, many times,
// so both sides see the same load. Prints each side's median and range and the paired gap.
const { readFileSync } = require('node:fs');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const [step, bodyPath, pairsArg, pathA, pathB] = process.argv.slice(2);
const libs = [require(path.resolve(pathA)), require(path.resolve(pathB))];
const body = readFileSync(bodyPath);
const raw = JSON.parse(body.toString('utf8'));
const steps = {
  digest: (lib) => lib.hashExport(raw),
  budget: (lib) => lib.exceedsValueBudget(body),
  prepare: (lib) => {
    const result = lib.prepareExport(body);
    return result.ok ? result.prepared.lookup.contentHash : result.rejection;
  },
  bundle: (lib) => {
    const parsed = lib.parseExportPayload(raw);
    const built =
      lib.buildBundleFiles.length === 2
        ? lib.buildBundleFiles(parsed.payload, raw.nodeId)
        : lib.buildBundleFiles({ ...parsed.payload });
    return built.ok ? built.files.length : built.rejection;
  },
};
const run = steps[step];
const pairs = Number(pairsArg);
const times = [[], []];
const outputs = [null, null];
for (let i = 0; i < pairs + 3; i += 1) {
  for (const side of i % 2 ? [1, 0] : [0, 1]) {
    const t0 = performance.now();
    outputs[side] = run(libs[side]);
    if (i >= 3) times[side].push(performance.now() - t0);
  }
}
const sorted = (values) => [...values].sort((a, b) => a - b);
const median = (values) => sorted(values)[values.length >> 1];
const show = (values) =>
  `median ${median(values).toFixed(1)} ms [${Math.min(...values).toFixed(1)}..${Math.max(...values).toFixed(1)}]`;
const gaps = times[0].map((a, i) => a - times[1][i]);
const wins = gaps.filter((gap) => gap > 0).length;
console.log(
  `${step} on ${path.basename(bodyPath)}, ${pairs} pairs after 3 warmups, v8 ${process.versions.v8}`,
);
console.log(`  A ${pathA}: ${show(times[0])}`);
console.log(`  B ${pathB}: ${show(times[1])}`);
console.log(
  `  paired A-B: median ${median(gaps).toFixed(1)} ms, B faster in ${wins}/${pairs} pairs; same output: ${String(outputs[0]) === String(outputs[1])} (${String(outputs[0]).slice(0, 16)})`,
);
