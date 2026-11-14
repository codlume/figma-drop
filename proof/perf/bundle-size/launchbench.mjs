// Times a real launch of the built app, from spawn to the receiver answering GET /, alternating
// the sides. Each side is a directory holding package.json, dist, and dist-electron.
// usage: node launchbench.mjs <rounds> <electron-binary> <scratchDir> <label=appDir> <label=appDir>
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const [roundsArg, electron, scratchRoot, ...sides] = process.argv.slice(2);
const rounds = Number(roundsArg);
const variants = sides.map((side) => {
  const [label, dir] = side.split('=');
  return { label, dir };
});
const loadAverage = () => readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ');

function freePort() {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

async function launch(appDir) {
  const scratch = mkdtempSync(join(scratchRoot, 'launch-'));
  const port = await freePort();
  const env = {
    ...process.env,
    FIGMA_DROP_USER_DATA: join(scratch, 'user-data'),
    FIGMA_DROP_LIBRARY: join(scratch, 'library'),
    FIGMA_DROP_PORT: String(port),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  const start = performance.now();
  const child = spawn(electron, [resolve(appDir)], { env, detached: true, stdio: 'ignore' });
  const exited = new Promise((done) => child.once('exit', done));
  let ms = null;
  try {
    const deadline = start + 60_000;
    while (performance.now() < deadline && child.exitCode === null) {
      const ok = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { host: `localhost:${port}` },
      }).then(
        async (res) => res.status === 200 && (await res.text()).includes('figma-drop receiver'),
        () => false,
      );
      if (ok) {
        ms = performance.now() - start;
        break;
      }
      await new Promise((done) => setTimeout(done, 2));
    }
  } finally {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
    const force = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, 8000);
    await exited;
    clearTimeout(force);
    rmSync(scratch, { recursive: true, force: true });
  }
  return ms;
}

const samples = Object.fromEntries(variants.map(({ label }) => [label, []]));
let failures = 0;
const loadBefore = loadAverage();
for (let round = 0; round < rounds; round++) {
  const order = round % 2 === 0 ? variants : variants.toReversed();
  for (const { label, dir } of order) {
    const ms = await launch(dir);
    if (ms === null) failures++;
    else samples[label].push(ms);
  }
}
console.log(`${rounds} rounds, ${failures} launches never answered`);
console.log(`load average before ${loadBefore}, after ${loadAverage()}`);
for (const [label, values] of Object.entries(samples)) {
  const sorted = values.toSorted((a, b) => a - b);
  console.log(
    `${label.padEnd(8)} launch to receiver answering: min ${sorted[0].toFixed(0)} ms, median ${sorted[Math.floor(sorted.length / 2)].toFixed(0)} ms, max ${sorted.at(-1).toFixed(0)} ms (${sorted.length} launches)`,
  );
}
