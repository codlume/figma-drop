import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  assert,
  createLog,
  desktopDir,
  freePort,
  launchApp,
  repoDir,
  stopTracked,
  waitUntil,
} from './driver.mjs';

const execFileAsync = promisify(execFile);
const log = createLog();
const distDirs = [join(desktopDir, 'dist'), join(desktopDir, 'dist-electron')];
const pageFile = join(desktopDir, 'dist/renderer/index.html');
const QUIT_DEADLINE_MS = 4_000;

// A 1x1 opaque PNG. The SVG carries a script, which must not run when rendered as an image.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>document.title='ran'</script><rect width="4" height="4"/></svg>`;

// Throwaway stand-ins for the C-UI, B-LIBRARY, and A-INGEST seams. They exist only during this run.
const throwaway = {
  'src/renderer/style.css': `.throwaway-css { outline-style: dotted; }\n`,
  'src/renderer/App.tsx': `
import './style.css';
import * as stylex from '@stylexjs/stylex';
import { useEffect, useState } from 'react';
import { previewUrl, type RevisionId } from '../shared/library';
import { color } from './tokens.stylex';
const styles = stylex.create({ root: { backgroundColor: color.accent } });
export function App() {
  const [focus, setFocus] = useState('none');
  // Subscribes well after load, as a page that fetches its first snapshot before wiring focus would.
  useEffect(() => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe = window.figmaDrop.app.onFocusExport((target) => setFocus(JSON.stringify(target)));
    }, 500);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);
  return (
    <div id="throwaway-app" {...stylex.props(styles.root)}>
      <span id="focus" className="throwaway-css">{focus}</span>
      <img id="png" src={previewUrl('png' as RevisionId)} />
      <img id="svg" src={previewUrl('svg' as RevisionId)} />
      <img id="missing" src={previewUrl('missing' as RevisionId)} />
    </div>
  );
}
`,
  'src/library/index.ts': `
import { writeFileSync } from 'node:fs';
import * as NodePath from 'node:path';
import type { CreateLibrary } from '../shared/integration';
import type { RevisionId } from '../shared/library';

export const createLibrary: CreateLibrary = async ({ root, trashItem }) => {
  (globalThis as Record<string, unknown>).throwawayBoot = ['library-open:' + root];
  await new Promise((resolve) => setTimeout(resolve, 200));
  ((globalThis as Record<string, unknown>).throwawayBoot as string[]).push('library-ready');
  const file = (name: string) => NodePath.join(process.env.THROWAWAY_FILES ?? '', name);
  return {
    stagingDir: NodePath.join(root, 'staging'),
    commit: async () => ({ ok: false, code: 'failed', message: 'throwaway' }),
    findExport: async () => null,
    getSnapshot: async () => ({ state: 'ready', projects: [], unidentified: [] }),
    onChanged: () => () => {},
    bundlePath: async () => ({ ok: true, path: root }),
    copyTo: async () => ({ ok: false, code: 'failed', message: 'throwaway' }),
    trash: async () => {
      void trashItem;
      return { ok: true };
    },
    async previewFile(revisionId: RevisionId) {
      if (revisionId === ('png' as RevisionId)) return { path: file('p.png'), contentType: 'image/png' };
      if (revisionId === ('svg' as RevisionId)) return { path: file('s.svg'), contentType: 'image/svg+xml' };
      return null;
    },
    locate: async (path) =>
      path === '/known' ? { kind: 'revision', revisionId: 'png' as RevisionId } : null,
  };
};
void writeFileSync;
`,
  'src/ingest/receiver-controller.ts': `
import type { CreateReceiverController } from '../shared/integration';
import type { ReceiverStatus } from '../shared/receiver';

export const createReceiverController: CreateReceiverController = ({ entry, port, fork, onFocus }) => {
  const boot = (globalThis as Record<string, unknown>).throwawayBoot as string[];
  boot.push('controller-created');
  (globalThis as Record<string, unknown>).throwawayController = { entry, port, onFocus };
  const listeners = new Set<(status: ReceiverStatus) => void>();
  let status: ReceiverStatus = { state: 'off' };
  let child: ReturnType<typeof fork> | null = null;
  const set = (next: ReceiverStatus) => {
    status = next;
    for (const listener of listeners) listener(next);
  };
  return {
    start: () =>
      new Promise<void>((resolve, reject) => {
        if ((globalThis as Record<string, unknown>).throwawayRefuseStart) {
          reject(new Error('throwaway refusal'));
          return;
        }
        boot.push('start');
        set({ state: 'starting' });
        child = fork(entry);
        child.on('message', (message) => {
          if (message === 'throwaway-child-ready') {
            set({ state: 'listening', port });
            resolve();
          }
        });
      }),
    stop: async () => {
      child?.kill();
      child = null;
      set({ state: 'off' });
    },
    status: () => status,
    onStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
`,
  'src/ingest/receiver-process.ts': `process.parentPort.postMessage('throwaway-child-ready');\n`,
};

const seamPaths = Object.keys(throwaway).map((path) => join(desktopDir, path));
// Only files this run wrote are removed, so a refused run cannot touch a landed ticket's work.
const written = [];

async function build() {
  await Promise.all(distDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  await execFileAsync('pnpm', ['build'], { cwd: desktopDir });
}

function builtCss() {
  const html = readFileSync(join(desktopDir, 'dist/renderer/index.html'), 'utf8');
  const links = [...html.matchAll(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+)"/g)];
  const assets = readdirSync(join(desktopDir, 'dist/renderer/assets'));
  const cssFiles = assets.filter((name) => name.endsWith('.css'));
  assert(links.length === 1, `index.html links one stylesheet, got ${links.length}`);
  assert(cssFiles.length === 1, `no orphan CSS asset, got ${cssFiles.join(', ')}`);
  return readFileSync(join(desktopDir, 'dist/renderer', links[0][1]), 'utf8');
}

const builtMain = () => readFileSync(join(desktopDir, 'dist-electron/main.cjs'), 'utf8');

function pass(label) {
  log.write(`PASS ${label}`);
}

async function main() {
  for (const path of seamPaths) {
    assert(!existsSync(path), `${path} exists: this proof needs the seams empty`);
  }

  await build();
  const absentCss = builtCss();
  assert(absentCss.includes('@layer'), 'StyleX layers in the linked CSS');
  assert(absentCss.includes('#f6f6f4'), 'token values in the linked CSS');
  pass('absent: the linked CSS holds StyleX rules, with no App.tsx');
  assert(!existsSync(join(desktopDir, 'dist-electron/receiver.cjs')), 'no receiver bundle');
  assert(!builtMain().includes('throwaway'), 'no seam code in main');
  pass('absent: no receiver bundle and no seam code in main.cjs');

  for (const [path, source] of Object.entries(throwaway)) {
    const target = join(desktopDir, path);
    await mkdir(dirname(target), { recursive: true });
    written.push(target);
    await writeFile(target, source, { flag: 'wx' });
  }
  await execFileAsync('pnpm', ['exec', 'tsc', '--noEmit'], { cwd: desktopDir });
  pass('present: throwaway seams typecheck against integration.ts');

  await build();
  const presentCss = builtCss();
  assert(presentCss.includes('.throwaway-css'), "App's own CSS in the linked file");
  assert(presentCss.includes('#f6f6f4'), 'token values in the linked CSS');
  assert(presentCss.includes('@layer'), 'StyleX layers in the linked CSS');
  pass("present: one linked CSS holds App's stylesheet and the StyleX rules");
  assert(existsSync(join(desktopDir, 'dist-electron/receiver.cjs')), 'receiver bundle built');
  assert(builtMain().includes('throwawayBoot'), 'seam code bundled into main');
  pass('present: receiver.cjs is packed and the seams are bundled into main.cjs');

  const scratch = await mkdtemp(join(tmpdir(), 'figma-drop-seams-'));
  try {
    await writeFile(join(scratch, 'p.png'), Buffer.from(PNG_BASE64, 'base64'));
    await writeFile(join(scratch, 's.svg'), SVG);
    process.env.THROWAWAY_FILES = scratch;
    const port = await freePort();
    const paths = {
      userData: join(scratch, 'user-data'),
      library: join(scratch, 'library'),
      port,
    };
    const app = launchApp(paths);
    let page = await app.page();
    await waitUntil(() => page.evaluate(`!!document.querySelector('#throwaway-app')`), 'App');
    await app.waitForHooks();

    const appStyle = await page.evaluate(`(() => {
      const root = getComputedStyle(document.querySelector('#throwaway-app'));
      const span = getComputedStyle(document.querySelector('#focus'));
      return { background: root.backgroundColor, outline: span.outlineStyle };
    })()`);
    assert(
      ['rgb(51, 85, 221)', 'rgb(139, 163, 255)'].includes(appStyle.background),
      `accent token from StyleX, got ${appStyle.background}`,
    );
    assert(appStyle.outline === 'dotted', `App stylesheet, got ${appStyle.outline}`);
    pass('present: the running page applies both StyleX tokens and the App stylesheet');

    const boot = await waitUntil(async () => {
      const seen = await app.evaluateInMain('globalThis.throwawayBoot');
      return seen.includes('start') && seen;
    }, 'the boot sequence');
    assert(
      JSON.stringify(boot.map((entry) => entry.split(':')[0])) ===
        JSON.stringify(['library-open', 'library-ready', 'controller-created', 'start']),
      `boot order ${JSON.stringify(boot)}`,
    );
    assert(boot[0].endsWith(join(scratch, 'library')), `library root ${boot[0]}`);
    pass('present: library resolves, then the controller is created, then start runs');

    const controller = await app.evaluateInMain(
      'JSON.stringify({ entry: throwawayController.entry, port: throwawayController.port })',
    );
    const { entry, port: controllerPort } = JSON.parse(controller);
    assert(entry === join(desktopDir, 'dist-electron/receiver.cjs'), `entry ${entry}`);
    assert(controllerPort === port, `port ${controllerPort}`);
    pass('present: the controller gets the built receiver entry and the runtime port');

    const status = await waitUntil(async () => {
      const current = await page.evaluate('window.figmaDrop.receiver.getStatus()');
      return current.state === 'listening' && current;
    }, 'listening from the forked child');
    assert(status.port === port, `status ${JSON.stringify(status)}`);
    pass('present: utilityProcess runs receiver.cjs and its message reaches the status');

    const snapshot = await page.evaluate('window.figmaDrop.library.getSnapshot()');
    assert(snapshot.state === 'ready', `snapshot ${JSON.stringify(snapshot)}`);
    pass('present: getSnapshot reaches the library');

    const images = await waitUntil(async () => {
      const seen = await page.evaluate(`(() => {
        const read = (id) => {
          const image = document.getElementById(id);
          return { complete: image.complete, width: image.naturalWidth };
        };
        return { png: read('png'), svg: read('svg'), missing: read('missing'), title: document.title };
      })()`);
      return seen.png.complete && seen.svg.complete && seen.missing.complete && seen;
    }, 'images settled');
    assert(images.png.width === 1, `png ${JSON.stringify(images.png)}`);
    assert(images.svg.width === 4, `svg ${JSON.stringify(images.svg)}`);
    assert(images.missing.width === 0, `missing ${JSON.stringify(images.missing)}`);
    assert(images.title === 'figma-drop', `script in SVG ran: title ${images.title}`);
    pass('present: previews render as images under the page CSP, and SVG scripts stay inert');

    assert(
      (await app.evaluateInMain(`throwawayController.onFocus('/unknown')`)) === false,
      'an unknown path resolves false',
    );
    const closing = page.closed;
    void page.evaluate('window.close()').catch(() => {});
    await closing;
    await waitUntil(async () => (await app.hook('windows()')).length === 0, 'zero windows');
    assert((await app.hook('windows()')).length === 0, 'unknown path opened no window');
    pass('present: onFocus resolves false for an unknown path and opens no window');

    await rename(pageFile, `${pageFile}.hidden`);
    let focusedWithoutPage;
    let windowsAfterFailure;
    try {
      focusedWithoutPage = await app.evaluateInMain(`throwawayController.onFocus('/known')`);
      windowsAfterFailure = (await app.hook('windows()')).length;
    } finally {
      await rename(`${pageFile}.hidden`, pageFile);
    }
    assert(focusedWithoutPage === false, `a page that cannot load: got ${focusedWithoutPage}`);
    assert(windowsAfterFailure === 0, `a dead window stayed, got ${windowsAfterFailure}`);
    pass('present: onFocus resolves false and leaves no window when the page cannot load');

    assert(
      (await app.evaluateInMain(`throwawayController.onFocus('/known')`)) === true,
      'a known path resolves true',
    );
    page = await app.page();
    await waitUntil(
      () => page.evaluate(`document.querySelector('#focus')?.textContent.includes('revision')`),
      'the focus target to reach a window recreated for it',
    );
    pass('present: onFocus recreates a closed window and delivers the target to its page');

    for (const reloads of [1, 1, 1, 2]) {
      await page.evaluate('window.beforeReload = true');
      const focused = await app.evaluateInMain(`(async () => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const { webContents } = BrowserWindow.getAllWindows()[0];
        for (let reload = 0; reload < ${reloads}; reload += 1) webContents.reload();
        return throwawayController.onFocus('/known');
      })()`);
      assert(focused === true, `onFocus during ${reloads} reloads resolved ${focused}`);
      await waitUntil(
        () =>
          page.evaluate(
            `!window.beforeReload && document.querySelector('#focus')?.textContent.includes('revision')`,
          ),
        'the target to reach the reloaded page',
      );
    }
    pass('present: a target sent during a reload reaches the reloaded page');

    await page.evaluate('window.figmaDrop.receiver.setEnabled(false)');
    await app.evaluateInMain('globalThis.throwawayRefuseStart = true');
    const refused = await page.evaluate('window.figmaDrop.receiver.setEnabled(true)');
    assert(refused.message?.includes('throwaway refusal'), `refused ${JSON.stringify(refused)}`);
    const { items } = await app.hook('tray()');
    const trayLabel = items.find((item) => item.id === 'status').label;
    assert(trayLabel.startsWith('Receiver failed'), `tray status ${trayLabel}`);
    assert(items.find((item) => item.id === 'receiver-on').checked, 'the setting stays on');
    await app.evaluateInMain('globalThis.throwawayRefuseStart = false');
    const retried = await page.evaluate('window.figmaDrop.receiver.setEnabled(true)');
    assert(retried.state === 'listening', `retried ${JSON.stringify(retried)}`);
    pass('present: a refused start reads failed in the reply and tray, and Try again recovers');

    await app.hook(`clickTray('quit')`).catch(() => {});
    const exit = await app.exitWithin(QUIT_DEADLINE_MS);
    assert(exit?.code === 0, `exit ${JSON.stringify(exit)}`);
    pass('present: quit stops the controller and exits cleanly');

    const signalled = launchApp(paths);
    const signalledPage = await signalled.page();
    await waitUntil(async () => {
      const current = await signalledPage.evaluate('window.figmaDrop.receiver.getStatus()');
      return current.state === 'listening';
    }, 'a running receiver child');
    process.kill(signalled.child.pid, 'SIGTERM');
    const signalledExit = await signalled.exitWithin(QUIT_DEADLINE_MS);
    assert(signalledExit?.code === 0, `exit ${JSON.stringify(signalledExit)}`);
    await waitUntil(async () => {
      const { stdout } = await execFileAsync('pgrep', ['-g', String(signalled.child.pid)]).catch(
        (error) => ({ stdout: error.stdout ?? '' }),
      );
      return stdout.trim() === '';
    }, 'the receiver child and helpers to exit with the app');
    pass('present: SIGTERM with a window and a receiver child open leaves nothing running');
  } finally {
    await stopTracked();
    await rm(scratch, { recursive: true, force: true });
  }
}

let failure = null;
try {
  await main();
  log.write('ALL PASS');
} catch (error) {
  failure = error;
  log.write(`FAIL ${error.message}`);
} finally {
  const forced = await stopTracked();
  if (forced && !failure) {
    failure = new Error('a process outlived the run and needed SIGKILL');
    log.write(`FAIL ${failure.message}`);
  }
  for (const path of written) {
    await rm(path, { force: true });
    await rmdir(dirname(path)).catch(() => {});
  }
  if (written.length > 0) await build();
  await writeFile(join(repoDir, 'proof/shell/verify-seams.txt'), `${log.lines.join('\n')}\n`);
}
process.exit(failure ? 1 : 0);
