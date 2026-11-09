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

import { createReceiverController } from '../ingest/receiver-controller.ts';
import { createLibrary } from '../library/index.ts';
import { IPC } from '../shared/ipc.ts';
import { PREVIEW_SCHEME } from '../shared/library.ts';
import { type Commands, createCommands } from './commands.ts';
import { focusExport } from './focus.ts';
import { denyPermissions, lockNavigation, pageUrl } from './lockdown.ts';
import { previewResponse } from './preview.ts';
import { createReceiverSwitch } from './receiver-switch.ts';
import { resolveRuntime } from './runtime.ts';
import { exposeTestHooks } from './test-hooks.ts';
import { createAppTray } from './tray.ts';
import { createWindows } from './windows.ts';

const QUIT_TIMEOUT_MS = 5_000;

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
  const library = await createLibrary({
    root: runtime.library,
    trashItem: (path) => shell.trashItem(path),
  });

  const windows = createWindows({
    url: pageUrl(runtime.devServerUrl, NodePath.join(__dirname, '../dist/renderer')),
    preload: NodePath.join(__dirname, 'preload.cjs'),
    onCreated: (contents) => registerCommands(contents, commands),
  });

  const controller = createReceiverController({
    entry: NodePath.join(__dirname, 'receiver.cjs'),
    port: runtime.port,
    library,
    fork: (entry) =>
      utilityProcess.fork(entry, [], {
        serviceName: 'figma-drop receiver',
        stdio: 'inherit',
      }),
    onFocus: (path) => focusExport(path, { library, windows }),
  });

  const receiver = await createReceiverSwitch({
    settingsPath: NodePath.join(runtime.userData, 'settings.json'),
    controller,
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
  library.onChanged(() => windows.send(IPC.libraryChanged));
  receiver.onStatus((status) => windows.send(IPC.receiverStatusChanged, status));

  const show = () => void windows.show();
  const tray = createAppTray({ receiver, open: show, quit: () => app.quit() });
  if (runtime.testMode) exposeTestHooks(tray, receiver);
  app.on('activate', show);
  app.on('second-instance', show);

  // Exits rather than calling `app.quit()` again: a quit that began as SIGTERM, SIGHUP, or SIGINT
  // never finishes a second `app.quit()` while a window is open, and the process would hang.
  let quitting = false;
  app.on('before-quit', (event) => {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    const timeout = new Promise((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS));
    const stopped = receiver.stop().catch((error: unknown) => {
      console.error('Could not stop the receiver', error);
    });
    void Promise.race([stopped, timeout]).then(() => app.exit(0));
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
