import { BrowserWindow } from 'electron';

import type { ReceiverSwitch } from './receiver-switch.ts';
import type { AppTray } from './tray.ts';

// Exposed only when `Runtime.testMode` is on, which a packaged app can never be. CDP cannot reach
// the tray, so the proof script drives it from here, through the real menu items.
export function exposeTestHooks(tray: AppTray, receiver: ReceiverSwitch) {
  Object.assign(globalThis, {
    figmaDropTest: {
      windows: () =>
        BrowserWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          focused: window.isFocused(),
        })),
      tray: () => ({
        alive: tray.isAlive(),
        items: tray.menu().items.map(({ id, label, type, checked, enabled }) => ({
          id,
          label,
          type,
          checked,
          enabled,
        })),
      }),
      clickTray: (id: string) => tray.menu().getMenuItemById(id)?.click(),
      receiverStatus: () => receiver.status(),
    },
  });
}
