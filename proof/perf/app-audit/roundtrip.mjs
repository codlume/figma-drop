// One snapshot from the renderer's side: wall time and CPU per process for each source.
// usage: run.sh roundtrip.mjs <appDir> <seedDir> <outJson> [calls]
// Variants run in alternating blocks inside one app. `json` exists only in the prototype build.
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { cpuDelta, launch, SIDEBAR_COUNT, sleep, stats, waitUntil } from './rig.mjs';

const [appDir, seedDir, outJson, callsArg] = process.argv.slice(2);
const calls = Number(callsArg ?? 10);
const app = await launch({
  appDir,
  seedDir,
  scratchRoot: process.env.AUDIT_SCRATCH,
  electron: process.env.ELECTRON,
});
const result = { app: appDir.split('/').pop(), calls, errors: [] };
const VARIANTS = {
  memory: `await figmaDrop.library.getSnapshot('memory')`,
  disk: `await figmaDrop.library.getSnapshot('disk')`,
  json: `JSON.parse(await figmaDrop.library.getSnapshotJson('memory'))`,
};

try {
  await app.receiverUp();
  const page = await app.page();
  await waitUntil(async () => (await page.evaluate(SIDEBAR_COUNT)) >= 1, 'library shown', 60_000);
  result.launchToLibraryShownMs = performance.now() - app.t0;
  await sleep(2000);
  const hasJson = await page.evaluate(`typeof figmaDrop.library.getSnapshotJson === 'function'`);
  const names = Object.keys(VARIANTS).filter((name) => name !== 'json' || hasJson);
  const rows = Object.fromEntries(names.map((n) => [n, { wall: [], main: [], renderer: [] }]));
  for (let block = 0; block < 5; block += 1) {
    for (const name of block % 2 ? names.toReversed() : names) {
      const before = app.processes();
      const run = await page.evaluate(`(async () => {
        const times = [];
        let revisions = 0;
        for (let i = 0; i < ${calls}; i += 1) {
          const t = performance.now();
          const s = ${VARIANTS[name]};
          times.push(performance.now() - t);
          if (s.state !== 'ready') throw new Error(s.state);
          revisions = s.projects.reduce((n, p) => n + p.nodes.reduce((m, x) => m + x.revisions.length, 0), 0) + s.unidentified.length;
        }
        return { times, revisions };
      })()`);
      const cpu = cpuDelta(before, app.processes());
      if (run.revisions !== 4994) result.errors.push({ name, revisions: run.revisions });
      rows[name].wall.push(...run.times);
      rows[name].main.push(cpu.main.cpuMs / calls);
      rows[name].renderer.push(cpu.renderer.cpuMs / calls);
    }
  }
  result.focusRefreshMs = stats(rows.disk.wall).p50;
  result.focusMainCpuMs = stats(rows.disk.main).p50;
  for (const name of names) {
    result[name] = {
      wallMs: stats(rows[name].wall),
      mainCpuMsPerCall: stats(rows[name].main),
      rendererCpuMsPerCall: stats(rows[name].renderer),
    };
  }
  page.close();
  const main = await app.main();
  const WINDOWS = "process.mainModule.require('electron').BrowserWindow.getAllWindows()";
  const reopen = [];
  for (let i = 0; i < 3; i += 1) {
    await main.evaluate(WINDOWS + '[0].close()');
    await waitUntil(async () => (await main.evaluate(WINDOWS + '.length')) === 0, 'window closed');
    const t = performance.now();
    await main.evaluate("figmaDropTest.clickTray('open')");
    const again = await app.page();
    await waitUntil(
      async () => (await again.evaluate(SIDEBAR_COUNT)) >= 1,
      'library reshown',
      60_000,
    );
    reopen.push(performance.now() - t);
    again.close();
  }
  result.reopenToLibraryShownMs = reopen.toSorted((a, b) => a - b)[1];
  result.reopenAll = reopen;
  main.close();
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
} finally {
  await app.stop();
}
writeFileSync(outJson, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
