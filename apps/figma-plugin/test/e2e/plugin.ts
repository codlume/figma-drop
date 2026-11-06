import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { types } from 'node:util';
import vm from 'node:vm';
import { RECEIVER_PORT } from '@figma-drop/export-contract';
import type { FakeFigma } from '../../src/sandbox/testing/fake-figma.ts';
import type { Cdp, Chrome } from './chrome.ts';

const DIST = join(import.meta.dirname, '../../dist');

export type Theme = 'light' | 'dark';

// Figma injects its own values at runtime. These stand in for them so the theme
// path through ui.css runs, and they prove nothing about Figma's real palette.
const THEME_VARIABLES: Record<Theme, Record<string, string>> = {
  light: {
    bg: '#ffffff',
    'bg-secondary': '#f5f5f5',
    'bg-brand': '#0d99ff',
    'bg-brand-hover': '#007be5',
    'bg-disabled': '#d9d9d9',
    'bg-hover': '#f5f5f5',
    'bg-warning-tertiary': '#fff1c2',
    'bg-danger-tertiary': '#ffe2e0',
    'bg-success-tertiary': '#dcf5e4',
    text: '#1e1e1e',
    'text-secondary': '#6b6b6b',
    'text-tertiary': '#8a8a8a',
    'text-brand': '#007be5',
    'text-onbrand': '#ffffff',
    'text-disabled': '#8a8a8a',
    'text-danger': '#dc3412',
    'text-success': '#14ae5c',
    'text-warning': '#b86200',
    border: '#e6e6e6',
    'border-selected': '#0d99ff',
  },
  dark: {
    bg: '#2c2c2c',
    'bg-secondary': '#383838',
    'bg-brand': '#0c8ce9',
    'bg-brand-hover': '#0a6dc2',
    'bg-disabled': '#444444',
    'bg-hover': '#383838',
    'bg-warning-tertiary': '#4d3a0b',
    'bg-danger-tertiary': '#4d1f19',
    'bg-success-tertiary': '#17402a',
    text: '#ffffff',
    'text-secondary': '#b3b3b3',
    'text-tertiary': '#8c8c8c',
    'text-brand': '#7cc4f8',
    'text-onbrand': '#ffffff',
    'text-disabled': '#7a7a7a',
    'text-danger': '#fca397',
    'text-success': '#79d297',
    'text-warning': '#f7d15f',
    border: '#444444',
    'border-selected': '#0c8ce9',
  },
};

export type RowSnapshot = {
  name: string | null;
  state: string | undefined;
  label: string | null;
  detail: string | null;
};

export type PanelSnapshot = {
  receiver: { status: string | undefined; text: string | null; hint: string | null };
  checkAgain: string | null;
  selection: { title: string | null; detail: string | null };
  unidentified: string | null;
  intro: string | null;
  rows: RowSnapshot[];
  notice: { tone: string | undefined; text: string } | null;
  primary: { label: string | null; disabled: boolean };
  dismiss: string | null;
};

// Runs in an isolated world of the iframe, so the plugin's own script cannot see it.
const PANEL_READER = `
  globalThis.harness = (() => {
    let version = 0;
    const wakers = new Set();
    new MutationObserver(() => {
      version += 1;
      for (const wake of wakers) wake();
    }).observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
    });
    const byId = (id) => document.getElementById(id);
    const shown = (element) => (element?.checkVisibility() ? element.textContent : null);
    const text = (id) => shown(byId(id));
    return {
      read() {
        const notice = text('notice');
        return {
          version,
          panel: {
            receiver: {
              status: byId('receiver').dataset.status,
              text: text('receiver-text'),
              hint: text('receiver-hint'),
            },
            checkAgain: text('check-again'),
            selection: { title: text('selection-title'), detail: text('selection-detail') },
            unidentified: text('unidentified'),
            intro: text('intro'),
            rows: [...document.querySelectorAll('#rows .row')].map((row) => ({
              name: shown(row.querySelector('.row-name')),
              state: row.dataset.state,
              label: shown(row.querySelector('.row-label')),
              detail: shown(row.querySelector('.row-detail')),
            })),
            notice: notice === null ? null : { tone: byId('notice').dataset.tone, text: notice },
            primary: { label: text('primary'), disabled: byId('primary').disabled },
            dismiss: text('dismiss'),
          },
        };
      },
      changedAfter(seen, timeoutMs) {
        if (version !== seen) return Promise.resolve();
        return new Promise((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            wakers.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, timeoutMs);
          wakers.add(wake);
        });
      },
      centerOf(selector) {
        const element = document.querySelector(selector);
        element.scrollIntoView({ block: 'nearest' });
        const { x, y, width, height } = element.getBoundingClientRect();
        const center = { x: x + width / 2, y: y + height / 2 };
        const hit = document.elementFromPoint(center.x, center.y);
        return { ...center, hittable: hit === element, disabled: element.disabled === true };
      },
      count: (selector) => document.querySelectorAll(selector).length,
      // Chrome skips layout in a cross-origin frame until it knows the frame is on
      // screen. Before that, every element reads as hidden and nothing can be hit.
      rendered: () =>
        new Promise((resolve) => {
          const check = () =>
            byId('primary').checkVisibility() ? resolve() : requestAnimationFrame(check);
          requestAnimationFrame(check);
        }),
    };
  })();
`;

// The relay Figma's host performs. postMessage gives the iframe a real structured
// clone, so Uint8Array arrives as Uint8Array.
const hostPage = (html: string, width: number, height: number) => `
  new Promise((resolve) => {
    document.body.style.margin = '0';
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'border:0;display:block;width:${width}px;height:${height}px';
    const revive = (_key, value) =>
      typeof value?.bytes === 'string'
        ? Uint8Array.from(atob(value.bytes), (char) => char.charCodeAt(0))
        : value;
    globalThis.deliverToPlugin = (encoded) =>
      frame.contentWindow.postMessage({ pluginMessage: JSON.parse(encoded, revive) }, '*');
    addEventListener('message', ({ source, data }) => {
      if (source === frame.contentWindow && data?.pluginMessage !== undefined) {
        pluginToSandbox(JSON.stringify(data.pluginMessage));
      }
    });
    frame.addEventListener('load', () => resolve(), { once: true });
    frame.srcdoc = ${JSON.stringify(html)};
    document.body.append(frame);
  })
`;

const encodeMessage = (message: unknown) =>
  JSON.stringify(message, (_key, value: unknown) =>
    types.isUint8Array(value) ? { bytes: Buffer.from(value).toString('base64') } : value,
  );

// The bundle keeps the port as a lone number and builds the URL from it, so there is
// no `localhost:3579` text to replace. The port is the only change to the artifact.
function retargetPort(html: string, port: number): string {
  const literal = String(RECEIVER_PORT);
  const occurrences = html.split(literal).length - 1;
  if (occurrences !== 1) {
    throw new Error(`expected one ${literal} in dist/ui.html, found ${occurrences}`);
  }
  return html.replace(literal, String(port));
}

function applyFigmaTheme(html: string, theme: Theme): string {
  const variables = Object.entries(THEME_VARIABLES[theme])
    .map(([name, value]) => `--figma-color-${name}:${value};`)
    .join('');
  const themed = html
    .replace('<html lang="en">', `<html lang="en" class="figma-${theme}">`)
    .replace('<head>', `<head><style id="figma-style">:root{${variables}}</style>`);
  if (!themed.includes(`class="figma-${theme}"`) || !themed.includes('id="figma-style"')) {
    throw new Error('dist/ui.html has no <html lang="en"> or <head> to theme');
  }
  return themed;
}

function runSandbox(fake: FakeFigma, code: string, html: string) {
  const context = vm.createContext({
    figma: fake.figma,
    __html__: html,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  const forbidden = ['TextDecoder', 'TextEncoder', 'btoa', 'atob', 'document', 'structuredClone'];
  for (const name of forbidden) {
    if (vm.runInContext(`typeof ${name}`, context) !== 'undefined') {
      throw new Error(`the sandbox must not expose ${name}`);
    }
  }
  new vm.Script(code, { filename: 'code.js' }).runInContext(context);
}

type ShowUiOptions = { width: number; height: number; themeColors?: boolean };

type Target = { sessionId: string; targetInfo: { type: string; targetId: string } };

function nextIframeTarget(cdp: Cdp, page: string): Promise<Target> {
  return new Promise((resolve) => {
    const stop = cdp.listen(({ method, params, sessionId }) => {
      if (method !== 'Target.attachedToTarget' || sessionId !== page) return;
      const target = params as Target;
      if (target.targetInfo.type !== 'iframe') return;
      stop();
      resolve(target);
    });
  });
}

export type Plugin = Awaited<ReturnType<typeof openPlugin>>;

export async function openPlugin({
  chrome,
  fake,
  port,
  theme = 'light',
  reducedMotion = false,
}: {
  chrome: Chrome;
  fake: FakeFigma;
  port: number;
  theme?: Theme;
  reducedMotion?: boolean;
}) {
  const { cdp } = chrome;
  const [code, html] = await Promise.all([
    readFile(join(DIST, 'code.js'), 'utf8'),
    readFile(join(DIST, 'ui.html'), 'utf8'),
  ]);

  let open = true;
  const { ui } = fake.figma;
  const queueUntilPageIsReady: string[] = [];
  let toPage = (encoded: string) => void queueUntilPageIsReady.push(encoded);
  const clonedPost = ui.postMessage.bind(ui);
  ui.postMessage = (message: unknown) => {
    clonedPost(message);
    toPage(encodeMessage(fake.posted.at(-1)));
  };

  runSandbox(fake, code, retargetPort(html, port));
  const shown = fake.shownUi[0];
  if (shown === undefined) throw new Error('code.js never called figma.showUI');
  const { width, height, themeColors } = shown.options as ShowUiOptions;

  const { browserContextId } = await cdp.send<{ browserContextId: string }>(
    'Target.createBrowserContext',
    { disposeOnDetach: true },
  );
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    browserContextId,
  });
  const { sessionId: page } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });

  const stopRelay = cdp.listen(({ method, params, sessionId }) => {
    if (method !== 'Runtime.bindingCalled' || sessionId !== page) return;
    const { payload } = params as { payload: string };
    fake.fromUi(JSON.parse(payload));
  });

  await cdp.send('Runtime.enable', {}, page);
  await cdp.send('Runtime.addBinding', { name: 'pluginToSandbox' }, page);
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 2, mobile: false },
    page,
  );
  const iframeTarget = nextIframeTarget(cdp, page);
  await cdp.send(
    'Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    page,
  );
  const panelHtml = themeColors ? applyFigmaTheme(shown.html, theme) : shown.html;
  await cdp.send(
    'Runtime.evaluate',
    { expression: hostPage(panelHtml, width, height), awaitPromise: true },
    page,
  );

  toPage = (encoded) => {
    if (!open) return;
    const expression = `deliverToPlugin(${JSON.stringify(encoded)})`;
    void cdp.send('Runtime.evaluate', { expression }, page);
  };
  for (const encoded of queueUntilPageIsReady.splice(0)) toPage(encoded);

  // Sandboxed frames run out of process in Chrome, so the frame has its own target.
  const { sessionId: frame, targetInfo } = await iframeTarget;
  if (reducedMotion) {
    const features = [{ name: 'prefers-reduced-motion', value: 'reduce' }];
    await cdp.send('Emulation.setEmulatedMedia', { features }, frame);
  }
  const { executionContextId: contextId } = await cdp.send<{ executionContextId: number }>(
    'Page.createIsolatedWorld',
    { frameId: targetInfo.targetId, worldName: 'harness' },
    frame,
  );

  async function evaluate<Result>(expression: string): Promise<Result> {
    const { result, exceptionDetails } = await cdp.send<{
      result: { value: Result };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>(
      'Runtime.evaluate',
      { expression, contextId, returnByValue: true, awaitPromise: true },
      frame,
    );
    if (exceptionDetails) {
      const reason = exceptionDetails.exception?.description ?? exceptionDetails.text;
      throw new Error(`panel evaluate failed: ${reason}`);
    }
    return result.value;
  }
  await evaluate(PANEL_READER);
  await evaluate('harness.rendered()');

  const read = () => evaluate<{ version: number; panel: PanelSnapshot }>('harness.read()');

  // Sent to the frame's own target. Routed through the page, a click on a frame that
  // has just appeared can land on the host's <iframe> element instead of the button.
  async function mouse(type: string, x: number, y: number) {
    const buttons = type === 'mousePressed' ? 1 : 0;
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type, x, y, button: 'left', buttons, clickCount: 1 },
      frame,
    );
  }

  return {
    snapshot: async () => (await read()).panel,

    async until(
      label: string,
      reached: (panel: PanelSnapshot) => boolean,
      timeoutMs = 10_000,
    ): Promise<PanelSnapshot> {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const { version, panel } = await read();
        if (reached(panel)) return panel;
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          throw new Error(`panel never reached: ${label}\n${JSON.stringify(panel, null, 2)}`);
        }
        await evaluate(`harness.changedAfter(${version}, ${Math.ceil(remaining)})`);
      }
    },

    async click(selector: string) {
      const { x, y, hittable, disabled } = await evaluate<{
        x: number;
        y: number;
        hittable: boolean;
        disabled: boolean;
      }>(`harness.centerOf(${JSON.stringify(selector)})`);
      if (!hittable) throw new Error(`${selector} is covered at its centre`);
      if (disabled) throw new Error(`${selector} is disabled`);
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y);
      await mouse('mouseReleased', x, y);
    },

    count: (selector: string) => evaluate<number>(`harness.count(${JSON.stringify(selector)})`),

    /** Parses markup inside the iframe, proving a hostile string would run if parsed. */
    parseAsMarkup: (markup: string) =>
      evaluate<void>(
        `document.body.append(Object.assign(document.createElement('div'), { innerHTML: ${JSON.stringify(markup)} }))`,
      ),

    async screenshot(): Promise<Buffer> {
      const { data } = await cdp.send<{ data: string }>(
        'Page.captureScreenshot',
        { format: 'png', optimizeForSpeed: false },
        page,
      );
      return Buffer.from(data, 'base64');
    },

    async close() {
      open = false;
      stopRelay();
      await cdp.send('Target.disposeBrowserContext', { browserContextId });
    },
  };
}
