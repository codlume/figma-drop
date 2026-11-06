import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as NodePath from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import type { ReceiverController } from '../shared/integration.ts';
import { createReceiverSwitch } from './receiver-switch.ts';
import { createAppTray } from './tray.ts';

type Item = { id?: string; label?: string; checked?: boolean; click?(item: Item): void };

// Labelled fakes: they stand in for Electron's menu bar objects, which cannot run under Node.
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (template: Item[]) => ({ items: template }) },
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    isDestroyed = () => false;
  },
}));
vi.mock('./tray-icon.ts', () => ({ createTrayIcon: () => ({}) }));

let settingsDir: string;

const openTray = async (controller: ReceiverController | null = null) => {
  const receiver = await createReceiverSwitch({
    settingsPath: NodePath.join(settingsDir, 'settings.json'),
    controller,
    unavailableMessage: 'Not installed.',
  });
  const tray = createAppTray({ receiver, open: () => {}, quit: () => {} });
  const item = (id: string) => {
    const items = tray.menu().items as unknown as Item[];
    const found = items.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`no ${id} item`);
    return found;
  };
  return { receiver, item };
};

beforeEach(async () => {
  settingsDir = await mkdtemp(NodePath.join(tmpdir(), 'tray-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('receiver items', () => {
  it('puts the checkbox back and says so when the setting cannot be saved', async () => {
    const { receiver, item } = await openTray();
    await chmod(settingsDir, 0o500);
    const seen = new Promise((resolve) => receiver.onStatus(resolve));
    const checkbox = item('receiver-on');
    checkbox.click?.({ ...checkbox, checked: false });
    await seen;
    await chmod(settingsDir, 0o700);
    expect(item('receiver-on').checked).toBe(true);
    expect(item('status').label).toMatch(/^Receiver problem: .*could not be saved/);
  });

  it('keeps the checkbox on and shows the cause when the receiver cannot start', async () => {
    const { receiver, item } = await openTray({
      start: () => Promise.reject(new Error('refused')),
      stop: async () => {},
      status: () => ({ state: 'off' }),
      onStatus: () => () => {},
    });
    await receiver.setEnabled(true);
    expect(item('receiver-on').checked).toBe(true);
    expect(item('status').label).toMatch(/^Receiver problem: .*refused/);
  });
});
