// Idle CPU of a built app with no debugger client attached while sampling.
// usage: run.sh idle.mjs <appDir> <seedDir> <outJson> <seconds>
// Phases: window open and shown, then window closed (menu-bar only). CDP is used only to see the
// library render and to close the window, and every CDP socket is closed before a sample starts.
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { cpuDelta, launch, SIDEBAR_COUNT, sleep, waitUntil } from './rig.mjs';

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
  await app.receiverUp();
  const page = await app.page();
  await waitUntil(
    async () => (await page.evaluate(SIDEBAR_COUNT)) >= 1,
    'library in sidebar',
    60_000,
  );
  page.close();
  await sample('windowOpen');
  await sample('windowOpenSecondMinute');
  await sample('windowOpenThirdMinute');
  const main = await app.main();
  result.activeResources = await main.evaluate(`process.getActiveResourcesInfo()`);
  await main.evaluate(`${WINDOWS}[0].close()`);
  await waitUntil(async () => (await main.evaluate(`${WINDOWS}.length`)) === 0, 'window closed');
  result.activeResourcesClosed = await main.evaluate(`process.getActiveResourcesInfo()`);
  main.close();
  await sample('windowClosed');
  const health = await fetch(`http://127.0.0.1:${app.port}/`, {
    headers: { host: `localhost:${app.port}` },
  });
  if (!health.ok) result.errors.push('receiver not answering after idle');
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
} finally {
  await app.stop();
}
writeFileSync(outJson, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1));
