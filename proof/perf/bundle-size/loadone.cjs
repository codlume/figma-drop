// Times reading, compiling, and evaluating one Electron entry bundle in plain Node. The bundle's
// top level runs until it waits on Electron (main) or on the parent's first message (receiver).
// Reports wall time and the process's CPU time, which a busy machine inflates far less.
// usage: node loadone.cjs <bundle.cjs>
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { stubElectron } = require('./electron-stub.cjs');

stubElectron();
let listeners = 0;
process.parentPort = { postMessage() {}, on: () => void listeners++ };

const cpuStart = process.cpuUsage();
const start = performance.now();
let outcome = 'loaded';
try {
  require(path.resolve(process.argv[2]));
} catch (error) {
  outcome = `threw ${String(error?.message).slice(0, 80)}`;
}
const wallMs = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
console.log(
  JSON.stringify({
    wallMs: +wallMs.toFixed(3),
    cpuMs: +((cpu.user + cpu.system) / 1000).toFixed(3),
    outcome,
    listeners,
  }),
);
process.exit(0);
