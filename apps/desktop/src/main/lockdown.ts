import * as NodePath from 'node:path';
import { pathToFileURL } from 'node:url';

export function pageUrl(devServerUrl: string | null, rendererDir: string): string {
  if (devServerUrl) return new URL('index.html', devServerUrl).href;
  return pathToFileURL(NodePath.join(rendererDir, 'index.html')).href;
}

interface Lockable {
  getURL(): string;
  on(
    event: 'will-navigate',
    listener: (event: { preventDefault(): void; url: string }) => void,
  ): unknown;
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
}

// Vite's full reload in development re-requests the window's own URL, the one navigation that
// stays allowed.
export function lockNavigation(contents: Lockable) {
  contents.on('will-navigate', (event) => {
    if (event.url !== contents.getURL()) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

interface PermissionSession {
  setPermissionRequestHandler(
    handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void,
  ): void;
  setPermissionCheckHandler(handler: () => boolean): void;
}

// Without a handler Electron grants media and notifications to any page that asks.
export function denyPermissions(session: PermissionSession) {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}
