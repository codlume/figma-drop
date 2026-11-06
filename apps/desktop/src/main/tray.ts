import { Menu, Tray } from 'electron';

import { receiverStatusText } from '../shared/receiver-text.ts';
import type { ReceiverSwitch } from './receiver-switch.ts';
import { createTrayIcon } from './tray-icon.ts';

export type AppTray = {
  menu(): Menu;
  isAlive(): boolean;
};

export function createAppTray({
  receiver,
  open,
  quit,
}: {
  receiver: ReceiverSwitch;
  open(): void;
  quit(): void;
}): AppTray {
  const tray = new Tray(createTrayIcon());
  tray.setToolTip('figma-drop');
  let menu: Menu;

  const rebuild = () => {
    menu = Menu.buildFromTemplate([
      { id: 'open', label: 'Open figma-drop', click: open },
      { id: 'status', label: receiverStatusText(receiver.status()), enabled: false },
      {
        id: 'receiver-on',
        label: 'Receiver on',
        type: 'checkbox',
        checked: receiver.enabled(),
        click: (item) => void receiver.setEnabled(item.checked),
      },
      { type: 'separator' },
      { id: 'quit', label: 'Quit', click: quit },
    ]);
    tray.setContextMenu(menu);
  };
  rebuild();
  receiver.onStatus(rebuild);

  return { menu: () => menu, isAlive: () => !tray.isDestroyed() };
}
