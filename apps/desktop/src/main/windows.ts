import { app, BrowserWindow, nativeTheme, type WebContents } from 'electron';

// BrowserWindow rejects the token syntax and cannot import tokens, so these repeat `color.background`.
const BACKGROUND = { light: '#f6f6f4', dark: '#1b1b1d' };

export type Windows = {
  // Opens or raises the window, resolving whether its page has loaded and is not reloading.
  show(): Promise<boolean>;
  // Returns whether a live window took the message. That says nothing about the page handling it.
  send(channel: string, ...args: unknown[]): boolean;
  current(): BrowserWindow | null;
};

// A newer load replacing this one reports this code, and the newer load decides the outcome.
const ERR_ABORTED = -3;

// A message sent mid-reload reaches the page being torn down and is lost, even to the preload's
// buffer, so a load in flight has to end first. `isLoading` also stays true for a moment after
// `did-finish-load`, so only `did-stop-loading` means it ended.
function loadSettled(contents: WebContents): Promise<boolean> {
  if (!contents.isLoading()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let failed = false;
    const settle = (loaded: boolean) => {
      contents.off('did-fail-load', noteFailure);
      contents.off('did-stop-loading', stopped);
      contents.off('destroyed', destroyed);
      resolve(loaded);
    };
    const noteFailure = (
      _event: unknown,
      code: number,
      _description: string,
      _url: string,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame && code !== ERR_ABORTED) failed = true;
    };
    const stopped = () => settle(!failed);
    const destroyed = () => settle(false);
    contents.on('did-fail-load', noteFailure);
    contents.on('did-stop-loading', stopped);
    contents.on('destroyed', destroyed);
  });
}

export function createWindows({
  url,
  preload,
  onCreated,
}: {
  url: string;
  preload: string;
  onCreated(contents: WebContents): void;
}): Windows {
  let open: { window: BrowserWindow; loaded: Promise<boolean> } | null = null;

  // A window with a dead load must not be reused, so the next show builds a fresh one.
  const discard = (window: BrowserWindow) => {
    if (open?.window === window) open = null;
    if (!window.isDestroyed()) window.destroy();
  };

  const create = () => {
    const window = new BrowserWindow({
      width: 1040,
      height: 680,
      minWidth: 800,
      minHeight: 560,
      titleBarStyle: 'hiddenInset',
      backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
      webPreferences: { preload },
    });
    onCreated(window.webContents);
    window.on('closed', () => {
      if (open?.window === window) open = null;
    });
    const loaded = window.loadURL(url).then(
      () => true,
      (error: unknown) => {
        console.error('Could not load the window', error);
        discard(window);
        return false;
      },
    );
    return { window, loaded };
  };

  return {
    async show() {
      open ??= create();
      const { window, loaded } = open;
      if (window.isMinimized()) window.restore();
      window.show();
      app.focus({ steal: true });
      if (!(await loaded) || window.isDestroyed()) return false;
      if (await loadSettled(window.webContents)) return true;
      console.error('Could not reload the window');
      discard(window);
      return false;
    },
    send(channel, ...args) {
      const contents = open?.window.webContents;
      if (!contents || contents.isCrashed()) return false;
      contents.send(channel, ...args);
      return true;
    },
    current: () => open?.window ?? null,
  };
}
