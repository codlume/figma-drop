// Shared rig for the app audit: launches a built app on a hard-linked clone of a seeded library,
// and reads CPU time for every process the app owns.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(read, label, timeoutMs = 30_000, everyMs = 10) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${label}, last saw ${JSON.stringify(last)}`);
}

export function freePort() {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

export class Cdp {
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();

  static open(url) {
    const ws = new WebSocket(url);
    return new Promise((done, reject) => {
      ws.addEventListener('open', () => done(new Cdp(ws)), { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
  }

  constructor(ws) {
    this.ws = ws;
    ws.addEventListener('close', () => {
      for (const { reject, method } of this.#pending.values())
        reject(new Error(`CDP closed before ${method} answered`));
      this.#pending.clear();
    });
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id === undefined) {
        for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params);
        return;
      }
      const settle = this.#pending.get(message.id);
      if (!settle) return;
      this.#pending.delete(message.id);
      if (message.error) settle.reject(new Error(`${settle.method}: ${message.error.message}`));
      else settle.resolve(message.result);
    });
  }

  call(method, params = {}) {
    return new Promise((done, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, { method, resolve: done, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const list = this.#listeners.get(method) ?? [];
    list.push(listener);
    this.#listeners.set(method, list);
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails)
      throw new Error(
        `page threw: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
      );
    return result.value;
  }

  close() {
    this.ws.close();
  }
}

export function countRevisions(root) {
  let n = 0;
  const files = join(root, 'files');
  for (const p of readdirSync(files))
    for (const node of readdirSync(join(files, p))) n += readdirSync(join(files, p, node)).length;
  return n + readdirSync(join(root, 'unidentified')).length;
}

const TICK_MS = 10;

function statOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(/[\0 ]/);
    const type = cmdline.find((a) => a.startsWith('--type='))?.slice(7) ?? 'main';
    const sub = cmdline.find((a) => a.startsWith('--utility-sub-type='))?.slice(19);
    let wakeups = 0;
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      try {
        const status = readFileSync(`/proc/${pid}/task/${tid}/status`, 'utf8');
        wakeups += Number(/voluntary_ctxt_switches:\s+(\d+)/.exec(status)?.[1] ?? 0);
      } catch {}
    }
    return {
      pid,
      pgrp: Number(fields[2]),
      kind: sub ? `${type}:${sub}` : type,
      cpuMs: (Number(fields[11]) + Number(fields[12])) * TICK_MS,
      wakeups,
    };
  } catch {
    return null;
  }
}

// Every process in the app's process group: main, zygotes, GPU, network, renderer, receiver.
export function processes(pgid) {
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map((name) => statOf(Number(name)))
    .filter((p) => p && p.pgrp === pgid);
}

export function cpuDelta(before, after) {
  const byPid = new Map(before.map((p) => [p.pid, p]));
  const out = {};
  for (const p of after) {
    const b = byPid.get(p.pid);
    const key = p.kind;
    out[key] ??= { cpuMs: 0, wakeups: 0, processes: 0 };
    out[key].cpuMs += p.cpuMs - (b?.cpuMs ?? 0);
    out[key].wakeups += p.wakeups - (b?.wakeups ?? 0);
    out[key].processes += 1;
  }
  return out;
}

// `relaunchIn` is the scratch directory of an earlier launch stopped with `stop(true)`.
export async function launch({
  appDir,
  seedDir,
  scratchRoot,
  electron,
  inspect = true,
  relaunchIn,
}) {
  const scratch = relaunchIn ?? mkdtempSync(join(scratchRoot, 'r'));
  const library = join(scratch, 'L');
  if (!relaunchIn) {
    // Hard links are safe here: the library never rewrites a committed file in place.
    execFileSync('cp', ['-al', seedDir, library]);
    // Linking stamps every file with a fresh change time. A real library's files are old, so
    // wait past the app's settle window before launch.
    await sleep(6000);
  }
  const port = await freePort();
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
  const args = [resolve(appDir), '--no-sandbox', '--remote-debugging-port=0'];
  if (inspect) args.push('--inspect=0');
  const child = spawn(electron, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const ports = new Map();
  const lines = [];
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      const m = /^(\w+) listening on ws:\/\/\S+?:(\d+)\//.exec(line);
      if (m) ports.set(m[1], Number(m[2]));
      else lines.push(line);
    });
  }
  const exited = new Promise((r) => child.once('exit', r));
  const base = `http://127.0.0.1:${port}`;
  const headers = { host: `localhost:${port}`, origin: 'null', 'content-type': 'application/json' };

  const app = {
    t0,
    pid: child.pid,
    library,
    scratch,
    port,
    lines,
    async receiverUp() {
      await waitUntil(
        async () => (await fetch(`${base}/`, { headers: { host: `localhost:${port}` } })).ok,
        'receiver',
      );
      return performance.now() - t0;
    },
    async page() {
      const dp = await waitUntil(() => ports.get('DevTools'), 'devtools port');
      const target = await waitUntil(async () => {
        const targets = await (await fetch(`http://127.0.0.1:${dp}/json`)).json();
        return targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
      }, 'renderer page');
      return Cdp.open(target.webSocketDebuggerUrl);
    },
    async main() {
      const ip = await waitUntil(() => ports.get('Debugger'), 'inspector port');
      const targets = await (await fetch(`http://127.0.0.1:${ip}/json`)).json();
      return Cdp.open(targets[0].webSocketDebuggerUrl);
    },
    async sync(body) {
      const ts = performance.now();
      const res = await fetch(`${base}/sync`, { method: 'POST', headers, body });
      const reply = await res.json();
      return { ms: performance.now() - ts, status: res.status, reply };
    },
    processes: () => processes(child.pid),
    async stop(keepScratch = false) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      const t = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 8000);
      await exited;
      clearTimeout(t);
      if (!keepScratch) rmSync(scratch, { recursive: true, force: true });
    },
  };
  return app;
}

export const SIDEBAR_COUNT = `(() => { const l = document.querySelector('[role=listbox][aria-label=Library]'); return l ? l.querySelectorAll('[role=option]').length : -1; })()`;

export function stats(values) {
  const s = values.filter((v) => typeof v === 'number').toSorted((a, b) => a - b);
  if (s.length === 0) return { n: 0 };
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    min: +s[0].toFixed(2),
    p50: +q(0.5).toFixed(2),
    p90: +q(0.9).toFixed(2),
    max: +s[s.length - 1].toFixed(2),
  };
}

// Small exports isolate what main and the renderer add, apart from the receiver's parse and decode.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
export function smallExport(i, { fileKey = 'benchFileKey01', fileName = 'Bench File' } = {}) {
  return JSON.stringify({
    fileKey,
    fileName,
    nodeId: `900:${i + 1}`,
    nodeName: `Bench ${i + 1}`,
    exportedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    summary: { totalNodes: 1 },
    node: { id: `900:${i + 1}`, name: `Bench ${i + 1}`, type: 'FRAME', seed: i },
    components: [],
    remoteMasters: [],
    png: TINY_PNG,
  });
}
