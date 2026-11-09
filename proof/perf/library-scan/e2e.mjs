// End-to-end timing of the plugin's batch path against a built app.
// usage: BENCH_SCRATCH=<dir> node e2e.mjs <appDir> <seedDir> <batch> <profile> <outJson>
// Launches the built app on a clone of <seedDir>, waits for the renderer to show the library,
// posts <batch> distinct exports one at a time (the plugin waits for each reply), verifies every
// reply and the final library, and times renderer snapshots.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { desktopDir, freePort, Page, waitUntil } from '../../shell/driver.mjs';
import { makePayload } from './payload.mjs';

const [appDir, seedDir, batchArg, profile, outJson] = process.argv.slice(2);
const batch = Number(batchArg);
if (!process.env.BENCH_SCRATCH) throw new Error('set BENCH_SCRATCH to a disposable directory');
const scratch = mkdtempSync(join(process.env.BENCH_SCRATCH, 'run-'));
const library = join(scratch, 'library');
execFileSync('cp', ['-cR', seedDir, library]);
const seededRevisions = countRevisions(library);
const port = await freePort();
const electron = createRequire(join(desktopDir, 'package.json'))('electron');

function countRevisions(root) {
  let n = 0;
  const files = join(root, 'files');
  for (const p of readdirSync(files))
    for (const node of readdirSync(join(files, p))) n += readdirSync(join(files, p, node)).length;
  return n + readdirSync(join(root, 'unidentified')).length;
}

const env = {
  ...process.env,
  FIGMA_DROP_USER_DATA: join(scratch, 'user'),
  FIGMA_DROP_LIBRARY: library,
  FIGMA_DROP_PORT: String(port),
  FIGMA_DROP_TEST: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
const t0 = performance.now();
const child = spawn(
  electron,
  [resolve(appDir), '--remote-debugging-port=0', '-ApplePersistenceIgnoreState', 'YES'],
  { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let devtoolsPort = null;
const stderr = [];
for (const stream of [child.stdout, child.stderr]) {
  createInterface({ input: stream }).on('line', (line) => {
    const m = /^DevTools listening on ws:\/\/\S+?:(\d+)\//.exec(line);
    if (m) devtoolsPort = Number(m[1]);
    else stderr.push(line);
  });
}
const exited = new Promise((r) => child.once('exit', r));
const stop = async () => {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  const t = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, 5000);
  await exited;
  clearTimeout(t);
};

const result = { appDir, seedDir, seededRevisions, batch, profile, errors: [] };
try {
  const base = `http://127.0.0.1:${port}`;
  await waitUntil(
    async () => (await fetch(`${base}/`, { headers: { host: `localhost:${port}` } })).ok,
    'receiver',
    30_000,
  );
  result.launchToListeningMs = performance.now() - t0;
  const dp = await waitUntil(() => devtoolsPort, 'devtools', 30_000);
  const page = await Page.connect(dp, 'index.html');
  const expectedProjects = readdirSync(join(library, 'files')).length;
  const readyExpr = `(() => { const l = document.querySelector('[role=listbox][aria-label=Library]'); return l ? l.querySelectorAll('[role=option]').length : -1; })()`;
  await waitUntil(
    async () => (await page.evaluate(readyExpr)) >= Math.min(expectedProjects, 1),
    'library in sidebar',
    60_000,
  );
  result.launchToLibraryShownMs = performance.now() - t0;

  const payloads = Array.from({ length: batch }, (_, i) =>
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
  result.bodyBytes = payloads.reduce((n, p) => n + Buffer.byteLength(p), 0) / batch;
  const latencies = [];
  const tb = performance.now();
  for (const body of payloads) {
    const ts = performance.now();
    const res = await fetch(`${base}/sync`, {
      method: 'POST',
      headers: { host: `localhost:${port}`, origin: 'null', 'content-type': 'application/json' },
      body,
    });
    const reply = await res.json();
    latencies.push(performance.now() - ts);
    if (res.status !== 200 || typeof reply.path !== 'string') {
      result.errors.push({ status: res.status, reply });
      continue;
    }
    const real = resolve(reply.path);
    if (
      !real.startsWith(library + sep) ||
      !statSync(real).isDirectory() ||
      !existsSync(join(real, 'node.json'))
    )
      result.errors.push({ badPath: reply.path });
  }
  result.batchMs = performance.now() - tb;
  result.syncLatencyMs = latencies;
  const finalRevisions = countRevisions(library);
  if (finalRevisions !== seededRevisions + batch)
    result.errors.push({ finalRevisions, expected: seededRevisions + batch });
  result.finalRevisions = finalRevisions;

  // The renderer converges on a snapshot that holds every export of the batch.
  const benchNodesExpr = `figmaDrop.library.getSnapshot().then(s => (s.projects.find(p => p.fileKey === 'benchFileKey01')?.nodes.length ?? 0))`;
  const nodes = await page.evaluate(benchNodesExpr);
  if (nodes !== batch) result.errors.push({ rendererNodes: nodes, expected: batch });
  const snapshotMs = [];
  for (let i = 0; i < 5; i += 1) {
    snapshotMs.push(
      await page.evaluate(
        `(async () => { const t = performance.now(); const s = await figmaDrop.library.getSnapshot(); if (s.state !== 'ready') throw new Error(s.state); return performance.now() - t; })()`,
      ),
    );
  }
  result.snapshotMs = snapshotMs;
  page.close();
} catch (error) {
  result.errors.push({ thrown: String(error?.stack ?? error), stderr: stderr.slice(-20) });
} finally {
  await stop();
  rmSync(scratch, { recursive: true, force: true });
}
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
result.summary = {
  batchMs: result.batchMs,
  p50SyncMs: result.syncLatencyMs && med(result.syncLatencyMs),
  maxSyncMs: result.syncLatencyMs && Math.max(...result.syncLatencyMs),
  medSnapshotMs: result.snapshotMs && med(result.snapshotMs),
  launchToLibraryShownMs: result.launchToLibraryShownMs,
  errors: result.errors.length,
};
writeFileSync(outJson, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.summary));
