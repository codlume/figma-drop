// A plugin-style batch into a large library with the window open: exports posted one at a time,
// each waiting for its reply.
// usage: run.sh batch.mjs <appDir> <seedDir> <outJson> <batch> <small|typical> [profileDir]
// Checks every reply, the revision count on disk, and that the window shows the whole batch.
// With profileDir, records a CPU profile of main during the batch; that run is not for timing.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  countRevisions,
  cpuDelta,
  launch,
  SIDEBAR_COUNT,
  sleep,
  smallExport,
  stats,
  waitUntil,
} from './rig.mjs';

const [appDir, seedDir, outJson, batchArg, profile, profileDir] = process.argv.slice(2);
const batch = Number(batchArg);
const app = await launch({
  appDir,
  seedDir,
  scratchRoot: process.env.AUDIT_SCRATCH,
  electron: process.env.ELECTRON,
  inspect: Boolean(profileDir),
});
const result = { appDir, batch, profile, errors: [] };

async function payloads() {
  if (profile === 'small') return Array.from({ length: batch }, (_, i) => smallExport(i));
  const { makePayload } = await import('../library-scan/payload.mjs');
  return Array.from({ length: batch }, (_, i) =>
    JSON.stringify(
      makePayload({
        seed: 1000 + i,
        fileKey: 'benchFileKey01',
        fileName: 'Bench File',
        nodeId: `900:${i + 1}`,
        profile,
      }),
    ),
  );
}

const BENCH_ROW = `(() => {
  const row = [...document.querySelectorAll('[role=listbox][aria-label=Library] [role=option]')]
    .find((r) => r.textContent.startsWith('Bench File'));
  return row ? Number(row.lastElementChild.textContent) : 0;
})()`;

try {
  result.launchToListeningMs = await app.receiverUp();
  const page = await app.page();
  await waitUntil(async () => (await page.evaluate(SIDEBAR_COUNT)) >= 1, 'library shown', 60_000);
  result.launchToLibraryShownMs = performance.now() - app.t0;
  const bodies = await payloads();
  result.bodyBytes = Math.round(bodies.reduce((n, b) => n + Buffer.byteLength(b), 0) / batch);
  const seeded = countRevisions(app.library);
  await sleep(2000);

  let main = null;
  if (profileDir) {
    main = await app.main();
    await main.call('Profiler.enable');
    await main.call('Profiler.start');
    await page.call('Profiler.enable');
    await page.call('Profiler.start');
  }
  const before = app.processes();
  const latencies = [];
  const t0 = performance.now();
  for (const body of bodies) {
    const r = await app.sync(body);
    latencies.push(r.ms);
    if (r.status !== 200 || typeof r.reply.path !== 'string') {
      result.errors.push({ status: r.status, reply: r.reply });
      continue;
    }
    const real = resolve(r.reply.path);
    if (
      !real.startsWith(app.library + sep) ||
      !statSync(real).isDirectory() ||
      !existsSync(join(real, 'node.json'))
    )
      result.errors.push({ badPath: r.reply.path });
  }
  result.batchMs = performance.now() - t0;
  await waitUntil(async () => (await page.evaluate(BENCH_ROW)) === batch, 'batch in the sidebar');
  result.batchUntilShownMs = performance.now() - t0;
  result.cpuUntilShown = cpuDelta(before, app.processes());
  if (main) {
    const { profile: cpuProfile } = await main.call('Profiler.stop');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'main-batch.cpuprofile'), JSON.stringify(cpuProfile));
    main.close();
    const renderer = await page.call('Profiler.stop');
    writeFileSync(join(profileDir, 'renderer-batch.cpuprofile'), JSON.stringify(renderer.profile));
  }
  result.perExportMs = stats(latencies);
  result.latencies = latencies.map((ms) => +ms.toFixed(1));
  const final = countRevisions(app.library);
  if (final !== seeded + batch) result.errors.push({ final, expected: seeded + batch });
  result.finalRevisions = final;
  page.close();
} catch (error) {
  result.errors.push({ thrown: String(error?.stack ?? error), lines: app.lines.slice(-20) });
} finally {
  await app.stop();
}
writeFileSync(outJson, JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    app: appDir.split('/').pop(),
    batchMs: Math.round(result.batchMs),
    untilShownMs: Math.round(result.batchUntilShownMs),
    perExport: result.perExportMs,
    mainCpuMs: result.cpuUntilShown?.main?.cpuMs,
    rendererCpuMs: result.cpuUntilShown?.renderer?.cpuMs,
    receiverCpuMs: result.cpuUntilShown?.['utility:node.mojom.NodeService']?.cpuMs,
    shownMs: Math.round(result.launchToLibraryShownMs),
    errors: result.errors.length,
  }),
);
