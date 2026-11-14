// Splits a bundle load into read, compile, and evaluate, to show which one bounds the load.
// A profiling aid: its totals run higher than `loadone.cjs` measures, so these are not the reported
// load times.
// usage: node phases.cjs <rounds> <bundle.cjs> [<bundle.cjs> ...]
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const vm = require('node:vm');

const { stubElectron } = require('./electron-stub.cjs');

function measure(file) {
  stubElectron();
  process.parentPort = { postMessage() {}, on() {} };
  const t0 = performance.now();
  const source = fs.readFileSync(file, 'utf8');
  const t1 = performance.now();
  const script = new vm.Script(Module.wrap(source), { filename: file });
  const t2 = performance.now();
  const bundle = { exports: {} };
  const dir = path.dirname(file);
  script
    .runInThisContext()
    .call(bundle.exports, bundle.exports, Module.createRequire(file), bundle, file, dir);
  const t3 = performance.now();
  console.log(JSON.stringify({ read: t1 - t0, compile: t2 - t1, evaluate: t3 - t2 }));
  process.exit(0);
}

if (process.argv[2] === '--one') measure(path.resolve(process.argv[3]));

const [roundsArg, ...files] = process.argv.slice(2);
const runs = new Map(files.map((file) => [file, []]));
for (let round = 0; round < Number(roundsArg); round++) {
  for (const file of files) {
    const out = execFileSync(process.execPath, [__filename, '--one', file], { encoding: 'utf8' });
    runs.get(file).push(JSON.parse(out));
  }
}
for (const [file, samples] of runs) {
  const cells = ['read', 'compile', 'evaluate'].map((phase) => {
    const values = samples.map((sample) => sample[phase]).toSorted((a, b) => a - b);
    return `${phase} min ${values[0].toFixed(1)} median ${values[Math.floor(values.length / 2)].toFixed(1)}`;
  });
  console.log(`${file}: ${cells.join(', ')} (ms, ${samples.length} runs)`);
}
