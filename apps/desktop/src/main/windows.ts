import { app, BrowserWindow, nativeTheme, type WebContents } from 'electron';

// BrowserWindow rejects the token syntax and cannot import tokens, so these repeat `color.background`.
const BACKGROUND = { light: '#f6f6f4', dark: '#1b1b1d' };

export type Windows = {
  // Opens or raises the window, resolving once its page has loaded.
  show(): Promise<void>;
  send(channel: string, ...args: unknown[]): void;
  current(): BrowserWindow | null;
};

export function createWindows({
  url,
  preload,
  onCreated,
}: {
  url: string;
  preload: string;
  onCreated(contents: WebContents): void;
}): Windows {
  let open: { window: BrowserWindow; loaded: Promise<void> } | null = null;

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
      open = null;
    });
    const loaded = window.loadURL(url).catch((error: unknown) => {
      console.error('Could not load the window', error);
    });
    return { window, loaded };
  };

  return {
    async show() {
      open ??= create();
      const { window, loaded } = open;
      if (window.isMinimized()) window.restore();
      window.show();
      app.focus({ steal: true });
      await loaded;
    },
    send(channel, ...args) {
      open?.window.webContents.send(channel, ...args);
    },
    current: () => open?.window ?? null,
  };
}
