import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { assert, launchApp, waitUntil } from '../shell/driver.mjs';
import { decodePng } from './fixtures.mjs';

export const run = promisify(execFile);
const quote = JSON.stringify;

export const locate = {
  switch: `document.querySelector('[role=switch]')`,
  largeImage: `document.querySelector('img[alt^="Preview of"]')`,
  rows: `[...document.querySelectorAll('nav [role=option]')]`,
  cards: `[...document.querySelectorAll('main [role=option]')]`,
  history: `[...document.querySelectorAll('aside [role=option]')]`,
  dialog: `document.querySelector('dialog[open]')`,
  alert: `document.querySelector('aside [role=alert]')`,
  row: (text) =>
    `[...document.querySelectorAll('nav [role=option]')].find((row) => row.textContent.includes(${quote(text)}))`,
  card: (text) =>
    `[...document.querySelectorAll('main [role=option]')].find((card) => card.textContent.includes(${quote(text)}))`,
  cardNamed: (name) =>
    `[...document.querySelectorAll('main [role=option]')].find((card) => card.querySelector('[title]').title === ${quote(name)})`,
  historyRow: (index) => `document.querySelectorAll('aside [role=option]')[${index}]`,
  button: (name, scope = 'document') =>
    `[...${scope}.querySelectorAll('button')].find((button) => button.textContent.trim() === ${quote(name)})`,
};

const KEYS = {
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  ' ': { code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  Home: { code: 'Home', windowsVirtualKeyCode: 36 },
  End: { code: 'End', windowsVirtualKeyCode: 35 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
};
const SHIFT = 8;

export const FOCUS = `(() => {
  const element = document.activeElement;
  const region = element === document.body ? 'body'
    : element.closest('dialog') ? 'dialog'
    : element.closest('section[aria-label=Receiver]') ? 'receiver'
    : element.closest('nav') ? 'sidebar'
    : element.closest('main') ? 'grid'
    : element.closest('aside [role=listbox]') ? 'history'
    : element.closest('aside') ? 'detail'
    : 'other';
  return {
    region,
    tag: element.tagName,
    role: element.getAttribute('role'),
    text: (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 80),
    outline: getComputedStyle(element).outlineStyle,
  };
})()`;

export class Session {
  app = null;
  page = null;
  problems = [];
  expectedProblems = [];
  #paths;
  #expecting = false;

  constructor(paths) {
    this.#paths = paths;
  }

  #report(text) {
    (this.#expecting ? this.expectedProblems : this.problems).push(text);
  }

  async attach() {
    const page = await this.app.page();
    page.on('Log.entryAdded', ({ entry }) => {
      if (entry.level === 'error')
        this.#report(`${entry.source}: ${entry.text} ${entry.url ?? ''}`);
    });
    page.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      this.#report(exceptionDetails.exception?.description ?? exceptionDetails.text);
    });
    page.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error' || type === 'assert') {
        this.#report(
          `console.${type}: ${args.map((arg) => arg.value ?? arg.description).join(' ')}`,
        );
      }
    });
    await page.call('Log.enable');
    await page.call('Runtime.enable');
    await page.call('Page.enable');
    await page.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    this.page = page;
    await waitUntil(() => this.exists(`document.querySelector('nav')`), 'the library shell');
  }

  async start() {
    this.app = launchApp(this.#paths);
    await this.attach();
    await this.app.waitForHooks();
  }

  async quit() {
    await this.app.hook(`clickTray('quit')`).catch(() => {});
    const exit = await this.app.exited;
    assert(exit.code === 0 && exit.signal === null, `clean exit, got ${JSON.stringify(exit)}`);
  }

  async closeWindow() {
    const closing = this.page.closed;
    void this.page.evaluate('window.close()').catch(() => {});
    await closing;
    await waitUntil(async () => (await this.app.hook('windows()')).length === 0, 'zero windows');
  }

  async reopenFromTray() {
    await this.app.hook(`clickTray('open')`);
    await this.attach();
  }

  async expecting(work) {
    this.#expecting = true;
    try {
      return await work();
    } finally {
      this.#expecting = false;
    }
  }

  eval(expression) {
    return this.page.evaluate(expression);
  }

  exists(locator) {
    return this.eval(`Boolean(${locator})`);
  }

  text() {
    return this.eval('document.body.innerText');
  }

  async waitText(text, timeoutMs) {
    await waitUntil(async () => (await this.text()).includes(text), `text "${text}"`, timeoutMs);
  }

  async waitGone(text) {
    await waitUntil(async () => !(await this.text()).includes(text), `"${text}" gone`);
  }

  waitFor(locator, label = locator) {
    return waitUntil(() => this.exists(locator), label);
  }

  snapshot() {
    return this.eval('window.figmaDrop.library.getSnapshot()');
  }

  async click(locator) {
    const point = await this.eval(`(() => {
      const element = ${locator};
      if (!element) return { missing: true };
      element.scrollIntoView({ block: 'nearest' });
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, covered: !element.contains(hit), by: hit?.outerHTML.slice(0, 120) };
    })()`);
    assert(!point.missing, `nothing to click at ${locator}`);
    assert(!point.covered, `${locator} is covered by ${point.by}`);
    const { x, y } = point;
    const mouse = { x, y, button: 'left', clickCount: 1 };
    await this.page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.page.call('Input.dispatchMouseEvent', { ...mouse, type: 'mousePressed' });
    await this.page.call('Input.dispatchMouseEvent', { ...mouse, type: 'mouseReleased' });
  }

  async press(key, { shift = false } = {}) {
    const { text, ...rest } = KEYS[key];
    const event = { key, modifiers: shift ? SHIFT : 0, ...rest };
    await this.page.call('Input.dispatchKeyEvent', {
      ...event,
      type: text ? 'keyDown' : 'rawKeyDown',
      ...(text ? { text, unmodifiedText: text } : {}),
    });
    await this.page.call('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
  }

  focus() {
    return this.eval(FOCUS);
  }

  async screenshot(path) {
    await waitUntil(
      () => this.eval(`document.getAnimations().every((a) => a.playState !== 'running')`),
      'transitions settling',
    );
    const { data } = await this.page.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path, Buffer.from(data, 'base64'));
  }

  async paintedColor(locator) {
    const rect = await this.eval(`(() => {
      const element = ${locator};
      element.scrollIntoView({ block: 'nearest' });
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    })()`);
    const { data } = await this.page.call('Page.captureScreenshot', {
      format: 'png',
      clip: { ...rect, scale: 1 },
    });
    const image = decodePng(Buffer.from(data, 'base64'));
    return image.pixel(image.width >> 1, image.height >> 1);
  }

  async resize(width, height) {
    await this.eval(`window.resizeTo(${width}, ${height})`);
    await waitUntil(
      () => this.eval(`innerWidth === ${width} && innerHeight === ${height}`),
      `a ${width}x${height} window`,
    );
  }

  setColorScheme(value) {
    return this.page.call('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value }],
    });
  }

  // Includes the native title bar and traffic lights, which CDP screenshots leave out.
  async nativeCapture(path) {
    const swift = fileURLToPath(new URL('window-id.swift', import.meta.url));
    const { stdout } = await run('swift', [swift, String(this.app.child.pid)]);
    const id = stdout.trim();
    assert(id, 'no on-screen window for the app');
    await run('screencapture', ['-x', '-o', `-l${id}`, path]);
    return decodePng(await readFile(path));
  }

  async receiverChildPid() {
    const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,command=']);
    const parent = this.app.child.pid;
    for (const line of stdout.split('\n')) {
      const [, pid, ppid, command] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? [];
      if (Number(ppid) === parent && command?.includes('node.mojom.NodeService')) {
        return Number(pid);
      }
    }
    return null;
  }
}

// Needs no Automation permission, unlike asking System Events.
export async function frontApp() {
  const { stdout: asn } = await run('lsappinfo', ['front']);
  const { stdout } = await run('lsappinfo', ['info', '-only', 'name', '-only', 'pid', asn.trim()]);
  return {
    name: stdout.match(/"LSDisplayName"="(.*)"/)?.[1] ?? 'unknown',
    pid: Number(stdout.match(/"pid"=(\d+)/)?.[1]),
  };
}

export async function readClipboard() {
  return (await run('pbpaste')).stdout;
}

export function writeClipboard(text) {
  return new Promise((resolve, reject) => {
    const child = spawn('pbcopy', { stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', reject);
    child.once('exit', resolve);
    child.stdin.end(text);
  });
}

// Screencast frames arrive only when pixels change, so each held moment is added at encode time
// rather than slept for during the run.
export function startRecording(page) {
  const frames = [];
  const recording = {
    frames,
    async start() {
      page.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
        frames.push({ data, at: metadata.timestamp, hold: 0 });
        void page.call('Page.screencastFrameAck', { sessionId }).catch(() => {});
      });
      await page.call('Page.startScreencast', { format: 'jpeg', quality: 82, everyNthFrame: 1 });
    },
    async hold(seconds) {
      const seen = frames.length;
      await waitUntil(() => frames.length > seen, 'a new frame', 1500).catch(() => {});
      const last = frames.at(-1);
      if (last) last.hold += seconds;
    },
    stop: () => page.call('Page.stopScreencast'),
  };
  return recording;
}

export async function encodeRecording({ frames }, ffmpeg, workDir, output) {
  await mkdir(workDir, { recursive: true });
  const lines = [];
  for (const [index, frame] of frames.entries()) {
    const name = `frame-${String(index).padStart(5, '0')}.jpg`;
    await writeFile(join(workDir, name), Buffer.from(frame.data, 'base64'));
    const gap = (frames[index + 1]?.at ?? frame.at + 0.04) - frame.at;
    lines.push(`file '${name}'`, `duration ${(Math.min(gap, 0.12) + frame.hold).toFixed(3)}`);
  }
  lines.push(`file 'frame-${String(frames.length - 1).padStart(5, '0')}.jpg'`);
  const list = join(workDir, 'frames.txt');
  await writeFile(list, `${lines.join('\n')}\n`);
  await run(ffmpeg, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-vf',
    'scale=1280:-2,fps=30',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '27',
    '-movflags',
    '+faststart',
    output,
  ]);
  const probe = await run(ffmpeg, ['-hide_banner', '-i', output]).catch((error) => error);
  const [, hours, minutes, seconds] = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.stderr) ?? [];
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}
