import * as NodePath from 'node:path';

import {
  app,
  clipboard,
  dialog,
  type OpenDialogOptions,
  protocol,
  session,
  shell,
  utilityProcess,
  type WebContents,
} from 'electron';

import { IPC } from '../shared/ipc.ts';
import { PREVIEW_SCHEME } from '../shared/library.ts';
import { type Commands, createCommands } from './commands.ts';
import { createLibrary, createReceiverController, receiverEntry } from './integrations.ts';
import { denyPermissions, lockNavigation, pageUrl } from './lockdown.ts';
import { previewResponse } from './preview.ts';
import { createReceiverSwitch } from './receiver-switch.ts';
import { resolveRuntime } from './runtime.ts';
import { exposeTestHooks } from './test-hooks.ts';
import { createAppTray } from './tray.ts';
import { createWindows } from './windows.ts';

const QUIT_TIMEOUT_MS = 5_000;
const RECEIVER_UNAVAILABLE_MESSAGE = 'Export receiving is not installed in this build.';

const runtime = resolveRuntime(process.env, {
  isPackaged: app.isPackaged,
  home: app.getPath('home'),
  appData: app.getPath('appData'),
});

app.setName('figma-drop');
app.setPath('userData', runtime.userData);
protocol.registerSchemesAsPrivileged([
  { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true } },
]);
app.on('web-contents-created', (_event, contents) => lockNavigation(contents));
// The app and its receiver outlive the window. Closing it destroys the renderer, so idle holds none.
app.on('window-all-closed', () => {});

function registerCommands(contents: WebContents, commands: Commands) {
  const handlers = Object.entries<(...args: unknown[]) => Promise<unknown>>(commands);
  for (const [channel, handler] of handlers) {
    contents.ipc.handle(channel, (_event, ...args: unknown[]) => handler(...args));
  }
}

async function main() {
  await app.whenReady();
  denyPermissions(session.defaultSession);

  // Opening sweeps staging, so the receiver must not start before this resolves.
  const library =
    (await createLibrary?.({
      root: runtime.library,
      trashItem: (path) => shell.trashItem(path),
    })) ?? null;

  const windows = createWindows({
    url: pageUrl(runtime.devServerUrl, NodePath.join(__dirname, '../dist/renderer')),
    preload: NodePath.join(__dirname, 'preload.cjs'),
    onCreated: (contents) => registerCommands(contents, commands),
  });

  const controller =
    library && createReceiverController
      ? createReceiverController({
          entry: receiverEntry,
          port: runtime.port,
          library,
          fork: (entry) =>
            utilityProcess.fork(entry, [], {
              serviceName: 'figma-drop receiver',
              stdio: 'inherit',
            }),
          // `path` is client-supplied. It only ever reaches `library.locate`, never `shell` or the OS.
          async onFocus(path) {
            const target = await library.locate(path);
            if (!target) return false;
            await windows.show();
            windows.send(IPC.appFocusExport, target);
            return true;
          },
        })
      : null;

  const receiver = await createReceiverSwitch({
    settingsPath: NodePath.join(runtime.userData, 'settings.json'),
    controller,
    unavailableMessage: RECEIVER_UNAVAILABLE_MESSAGE,
  });
  const commands = createCommands({
    library,
    receiver,
    desktop: {
      showInFolder: (path) => shell.showItemInFolder(path),
      copyText: (text) => clipboard.writeText(text),
      async chooseFolder() {
        const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
        const window = windows.current();
        const { canceled, filePaths } = await (window
          ? dialog.showOpenDialog(window, options)
          : dialog.showOpenDialog(options));
        return canceled ? null : (filePaths[0] ?? null);
      },
    },
  });

  protocol.handle(PREVIEW_SCHEME, (request) => previewResponse(request.url, library));
  library?.onChanged(() => windows.send(IPC.libraryChanged));
  receiver.onStatus((status) => windows.send(IPC.receiverStatusChanged, status));

  const show = () => void windows.show();
  const tray = createAppTray({ receiver, open: show, quit: () => app.quit() });
  if (runtime.testMode) exposeTestHooks(tray, receiver);
  app.on('activate', show);
  app.on('second-instance', show);

  let lifecycle: 'running' | 'stopping' | 'stopped' = 'running';
  app.on('before-quit', (event) => {
    if (lifecycle === 'stopped') return;
    event.preventDefault();
    if (lifecycle === 'stopping') return;
    lifecycle = 'stopping';
    const timeout = new Promise((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS));
    void Promise.race([receiver.stop(), timeout]).then(() => {
      lifecycle = 'stopped';
      app.quit();
    });
  });

  show();
  await receiver.resume();
}

if (app.requestSingleInstanceLock()) {
  main().catch((error: unknown) => {
    console.error('figma-drop could not start', error);
    app.exit(1);
  });
} else {
  app.exit(0);
}
