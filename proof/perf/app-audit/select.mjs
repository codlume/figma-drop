// What opening a big project and a long history costs: 240 node cards, then 120 revision rows.
// usage: run.sh select.mjs <appDir> <seedDir> <outJson>
// Each step clicks the real row, waits until every image on the page has loaded or failed, and
// reports wall time, CPU per process, image count, and renderer memory.
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { cpuDelta, launch, SIDEBAR_COUNT, sleep, waitUntil } from './rig.mjs';

const [appDir, seedDir, outJson] = process.argv.slice(2);
const app = await launch({
  appDir,
  seedDir,
  scratchRoot: process.env.AUDIT_SCRATCH,
  electron: process.env.ELECTRON,
});
const result = { app: appDir.split('/').pop(), errors: [] };

const IMAGES = `(() => {
  const all = [...document.images];
  return {
    total: all.length,
    settled: all.filter((i) => i.complete).length,
    decoded: all.filter((i) => i.complete && i.naturalWidth > 0).length,
  };
})()`;
const click = (page, selector, text) =>
  page.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => e.textContent.includes(${JSON.stringify(text)}));
    if (!el) throw new Error('no element with ' + ${JSON.stringify(text)});
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  })()`);
const rss = (pid) => {
  const p = app.processes().find((x) => x.kind === 'renderer');
  return p ? p.pid : pid;
};

async function step(page, label, act, expectImages) {
  const before = app.processes();
  const t = performance.now();
  await act();
  const images = await waitUntil(
    async () => {
      const state = await page.evaluate(IMAGES);
      return state.total >= expectImages && state.settled === state.total ? state : null;
    },
    `${label} images`,
    60_000,
  );
  const wallMs = performance.now() - t;
  await sleep(1000);
  const cpu = cpuDelta(before, app.processes());
  const { usedSize } = await page.call('Runtime.getHeapUsage');
  result[label] = {
    wallMs: Math.round(wallMs),
    images,
    mainCpuMs: cpu.main?.cpuMs,
    rendererCpuMs: cpu.renderer?.cpuMs,
    gpuCpuMs: cpu['gpu-process']?.cpuMs,
    networkCpuMs: cpu['utility:network.mojom.NetworkService']?.cpuMs,
    rendererHeapMb: +(usedSize / 1e6).toFixed(1),
    domNodes: await page.evaluate(`document.querySelectorAll('*').length`),
    rendererRssMb: Math.round(
      Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${rss()}/status`, 'utf8'))[1]) / 1024,
    ),
  };
}

try {
  await app.receiverUp();
  const page = await app.page();
  await waitUntil(async () => (await page.evaluate(SIDEBAR_COUNT)) >= 1, 'library shown', 60_000);
  await sleep(2000);
  result.rendererPid = rss();
  const row = '[role=listbox][aria-label=Library] [role=option]';
  await step(page, 'openDesignSystem', () => click(page, row, 'Design System'), 240);
  await step(page, 'openCheckout', () => click(page, row, 'Checkout flow'), 12);
  await step(
    page,
    'openLongHistory',
    () => click(page, 'main [role=option]', 'Frame 0 / Checkout flow'),
    120,
  );
  page.close();
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
} finally {
  await app.stop();
}
writeFileSync(outJson, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
