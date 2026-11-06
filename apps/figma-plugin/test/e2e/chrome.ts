import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_BINARY = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

type CdpMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
  sessionId?: string;
};

type Pending = { resolve: (result: unknown) => void; reject: (cause: Error) => void };

type CdpEventListener = (message: CdpMessage) => void;

export class Cdp {
  #socket: WebSocket;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #listeners = new Set<CdpEventListener>();

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', ({ data }) => {
      const message: CdpMessage = JSON.parse(String(data));
      if (message.id === undefined) {
        for (const listener of this.#listeners) listener(message);
        return;
      }
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result);
    });
  }

  send<Result>(method: string, params: object = {}, sessionId?: string): Promise<Result> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (result) => resolve(result as Result),
        reject: (cause) => reject(new Error(`${method}: ${cause.message}`)),
      });
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  listen(listener: CdpEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

function devtoolsUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    child.once('exit', () => reject(new Error(`Chrome exited before DevTools: ${output}`)));
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const url = /DevTools listening on (ws:\S+)/.exec(output)?.[1];
      if (url !== undefined) resolve(url);
    });
  });
}

export type Chrome = { cdp: Cdp; majorVersion: string; stop: () => Promise<void> };

export async function launchChrome(): Promise<Chrome> {
  const profile = await mkdtemp(join(tmpdir(), 'figma-drop-e2e-'));
  const child = spawn(
    CHROME_BINARY,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await rm(profile, { recursive: true, force: true });
  }

  try {
    const socket = new WebSocket(await devtoolsUrl(child));
    await once(socket, 'open');
    const cdp = new Cdp(socket);
    const { product } = await cdp.send<{ product: string }>('Browser.getVersion');
    const majorVersion = /\/(\d+)\./.exec(product)?.[1] ?? product;
    return { cdp, majorVersion, stop };
  } catch (cause) {
    await stop();
    throw cause;
  }
}
