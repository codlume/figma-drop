import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const repoDir = fileURLToPath(new URL('../..', import.meta.url));
export const desktopDir = join(repoDir, 'apps/desktop');
const electronPath = createRequire(join(desktopDir, 'package.json'))('electron');

export function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

// Retries a read of real state until it holds, because the state changes in another process.
export async function waitUntil(read, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}, last saw ${JSON.stringify(last)}`);
}

export class Page {
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #gone = null;

  static async connect(port, urlPart) {
    const target = await waitUntil(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      return targets.find((t) => t.type === 'page' && t.url.includes(urlPart));
    }, `a ${urlPart} page on CDP port ${port}`);
    return Page.open(target.webSocketDebuggerUrl);
  }

  static open(url) {
    const ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(new Page(ws)), { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.closed = new Promise((resolve) => ws.addEventListener('close', resolve, { once: true }));
    // A closed socket never answers, as when the app exits mid-call, so every waiting call fails.
    const drop = (reason) => {
      this.#gone ??= reason;
      for (const { method, reject } of this.#pending.values())
        reject(new Error(`${reason} before ${method} answered`));
      this.#pending.clear();
    };
    ws.addEventListener('close', () => drop('CDP socket closed'), { once: true });
    ws.addEventListener('error', () => drop('CDP socket failed'), { once: true });
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id === undefined) {
        this.#listeners.get(message.method)?.(message.params);
        return;
      }
      const settle = this.#pending.get(message.id);
      if (!settle) return;
      this.#pending.delete(message.id);
      if (message.error) settle.reject(new Error(message.error.message));
      else settle.resolve(message.result);
    });
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (this.#gone) throw new Error(`${this.#gone}; cannot call ${method}`);
      const id = this.#nextId++;
      this.#pending.set(id, { method, resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    this.#listeners.set(method, listener);
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      const reason = exceptionDetails.exception?.description ?? exceptionDetails.text;
      throw new Error(`page threw: ${reason}`);
    }
    return result.value;
  }

  // Collects page errors and CSP violations, which the page itself would swallow.
  async collectErrors() {
    const errors = [];
    this.on('Log.entryAdded', ({ entry }) => {
      if (entry.level === 'error') errors.push(entry.text);
    });
    this.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text);
    });
    await this.call('Log.enable');
    await this.call('Runtime.enable');
    return errors;
  }

  close() {
    this.ws.close();
  }
}

export class App {
  child;
  exited;
  #ports = new Map();

  constructor(child) {
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        tracked.delete(child);
        resolve({ code, signal });
      });
    });
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', (line) => {
        const match = /^(\w+) listening on ws:\/\/\S+?:(\d+)\//.exec(line);
        if (match) this.#ports.set(match[1], Number(match[2]));
        App.log?.(line);
      });
    }
  }

  async page(urlPart = 'index.html') {
    const port = await waitUntil(() => this.#ports.get('DevTools'), 'the DevTools port');
    return Page.connect(port, urlPart);
  }

  async evaluateInMain(expression) {
    const port = await waitUntil(() => this.#ports.get('Debugger'), 'the inspector port');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const main = await Page.open(targets[0].webSocketDebuggerUrl);
    try {
      return await main.evaluate(expression);
    } finally {
      main.close();
    }
  }

  hook(expression) {
    return this.evaluateInMain(`figmaDropTest.${expression}`);
  }

  async waitForHooks() {
    await waitUntil(() => this.evaluateInMain(`typeof figmaDropTest === 'object'`), 'test hooks');
  }

  // Resolves the exit, or null if the process is still running at the deadline. Waiting here, not in
  // `stopTracked`, is what proves an exit: `stopTracked` ends a hung app by force.
  async exitWithin(deadlineMs) {
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), deadlineMs);
    });
    const exit = await Promise.race([this.exited, deadline]);
    clearTimeout(timer);
    return exit;
  }

  async listeningPorts() {
    const { stdout } = await execFileAsync('lsof', [
      '-nP',
      '-a',
      '-g',
      String(this.child.pid),
      '-iTCP',
      '-sTCP:LISTEN',
      '-Fn',
    ]).catch((error) => ({ stdout: error.stdout ?? '' }));
    return [...stdout.matchAll(/^n.*:(\d+)$/gm)].map((match) => Number(match[1]));
  }
}

const execFileAsync = promisify(execFile);
const tracked = new Set();
let forced = false;

export function launchApp({ userData, library, port }) {
  const env = {
    ...process.env,
    FIGMA_DROP_USER_DATA: userData,
    FIGMA_DROP_LIBRARY: library,
    FIGMA_DROP_PORT: String(port),
    FIGMA_DROP_TEST: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  const args = [
    '.',
    '--remote-debugging-port=0',
    '--inspect=0',
    '-ApplePersistenceIgnoreState',
    'YES',
  ];
  const child = spawn(electronPath, args, {
    cwd: desktopDir,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tracked.add(child);
  return new App(child);
}

// Stops only what this run launched, by process group. Resolves true once any process in this run
// has needed the SIGKILL fallback, which a passing run must never rely on.
export async function stopTracked() {
  const exits = [...tracked].map((child) => new Promise((resolve) => child.once('exit', resolve)));
  for (const child of tracked) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  }
  const force = setTimeout(() => {
    forced ||= tracked.size > 0;
    for (const child of tracked) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
  }, 3000);
  await Promise.all(exits);
  clearTimeout(force);
  return forced;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function refusesConnection(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

export function createLog() {
  const lines = [];
  return {
    lines,
    write(line) {
      lines.push(line);
      console.log(line);
    },
  };
}
