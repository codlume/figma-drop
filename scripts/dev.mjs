import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, watch } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = fileURLToPath(new URL('..', import.meta.url));
const desktopDir = join(repoDir, 'apps/desktop');
const distDir = join(desktopDir, 'dist-electron');
const scratchDir = join(desktopDir, '.dev');
const bundles = ['main.cjs', 'preload.cjs'];
const devServerUrl = 'http://localhost:5791/';
const electronArgs = process.argv.slice(2).filter((arg) => arg !== '--');

const electronPath = createRequire(join(desktopDir, 'package.json'))('electron');
const children = new Set();
let electron = null;
let stopping = false;

// Each child leads its own process group so shutdown can signal the tools it spawns too,
// and a terminal Ctrl+C reaches only this script.
function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: desktopDir,
    stdio: 'inherit',
    detached: true,
    ...options,
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {}
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) signalGroup(child, 'SIGTERM');
  const forceKill = setTimeout(() => {
    for (const child of children) signalGroup(child, 'SIGKILL');
  }, 3000);
  const exitWhenDone = setInterval(() => {
    if (children.size > 0) return;
    clearInterval(exitWhenDone);
    clearTimeout(forceKill);
    process.exit(code);
  }, 50);
}

function launchElectron() {
  // A development run stays away from `~/figma-drop` and port 3579 unless the caller names them.
  const env = {
    ...process.env,
    VITE_DEV_SERVER_URL: devServerUrl,
    FIGMA_DROP_USER_DATA: process.env.FIGMA_DROP_USER_DATA ?? join(scratchDir, 'user-data'),
    FIGMA_DROP_LIBRARY: process.env.FIGMA_DROP_LIBRARY ?? join(scratchDir, 'library'),
    FIGMA_DROP_PORT: process.env.FIGMA_DROP_PORT ?? '13579',
  };
  // Set when the dev loop itself runs under Electron (for example inside an Electron-based IDE).
  delete env.ELECTRON_RUN_AS_NODE;
  const child = start(electronPath, ['.', ...electronArgs], { env });
  electron = child;
  child.on('exit', (code) => {
    if (electron === child) stop(code ?? 0);
  });
}

async function restartElectron() {
  const previous = electron;
  electron = null;
  if (previous && previous.exitCode === null && previous.signalCode === null) {
    const exited = new Promise((resolve) => previous.once('exit', resolve));
    signalGroup(previous, 'SIGTERM');
    await exited;
  }
  if (!stopping) launchElectron();
}

async function waitForDevServer() {
  for (;;) {
    try {
      if ((await fetch(new URL('index.html', devServerUrl))).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));

mkdirSync(distDir, { recursive: true });
for (const args of [['dev'], ['pack', '--watch']]) {
  start('vp', args).on('exit', (code) => stop(code ?? 1));
}

const devServerReady = waitForDevServer();
let settleTimer = null;
let relaunch = Promise.resolve();
watch(distDir, () => {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    if (!bundles.every((file) => existsSync(join(distDir, file)))) return;
    relaunch = relaunch.then(() => devServerReady).then(restartElectron);
  }, 300);
});
