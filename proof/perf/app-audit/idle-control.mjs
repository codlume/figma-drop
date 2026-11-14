// The same idle sample as idle.mjs, for the blank control app.
// usage: run.sh idle-control.mjs <controlAppDir> <emptyDir> <outJson> <seconds>
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { cpuDelta, launch, sleep, waitUntil } from './rig.mjs';

const [appDir, seedDir, outJson, secondsArg] = process.argv.slice(2);
const seconds = Number(secondsArg ?? 60);
const app = await launch({
  appDir,
  seedDir,
  scratchRoot: process.env.AUDIT_SCRATCH,
  electron: process.env.ELECTRON,
});
const result = { seconds, errors: [] };
const WINDOWS = `process.mainModule.require('electron').BrowserWindow.getAllWindows()`;

async function sample(label) {
  await sleep(5000);
  const before = app.processes();
  const t = performance.now();
  await sleep(seconds * 1000);
  const after = app.processes();
  const wall = performance.now() - t;
  const byProcess = cpuDelta(before, after);
  const totalCpuMs = Object.values(byProcess).reduce((n, p) => n + p.cpuMs, 0);
  const wakeups = Object.values(byProcess).reduce((n, p) => n + p.wakeups, 0);
  result[label] = {
    wallMs: Math.round(wall),
    totalCpuMs,
    percentOfOneCore: +((totalCpuMs / wall) * 100).toFixed(3),
    wakeupsPerSecond: +(wakeups / (wall / 1000)).toFixed(1),
    byProcess,
  };
}

try {
  const main = await app.main();
  await waitUntil(async () => (await main.evaluate(`${WINDOWS}.length`)) === 1, 'window');
  main.close();
  await sample('windowOpen');
  const again = await app.main();
  await again.evaluate(`${WINDOWS}[0].close()`);
  await waitUntil(async () => (await again.evaluate(`${WINDOWS}.length`)) === 0, 'closed');
  again.close();
  await sample('windowClosed');
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
} finally {
  await app.stop();
}
writeFileSync(outJson, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
