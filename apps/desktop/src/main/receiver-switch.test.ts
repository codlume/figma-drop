import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as NodePath from 'node:path';

import { beforeEach, describe, expect, it } from 'vite-plus/test';

import type { ReceiverController } from '../shared/integration.ts';
import type { ReceiverStatus } from '../shared/receiver.ts';
import { createReceiverSwitch, parseSettings } from './receiver-switch.ts';

const MESSAGE = 'Export receiving is not installed in this build.';
const UNAVAILABLE: ReceiverStatus = { state: 'unavailable', message: MESSAGE };

// Labelled fake: it stands in for A-INGEST's controller and exists only in this test.
function fakeController(initial: ReceiverStatus = { state: 'off' }) {
  const calls: string[] = [];
  const listeners = new Set<(status: ReceiverStatus) => void>();
  let current = initial;
  const set = (status: ReceiverStatus) => {
    current = status;
    for (const listener of listeners) listener(status);
  };
  const controller: ReceiverController = {
    async start() {
      calls.push('start');
      set({ state: 'listening', port: 13579 });
    },
    async stop() {
      calls.push('stop');
      set({ state: 'off' });
    },
    status: () => current,
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { controller, calls, set };
}

let settingsPath: string;
const persisted = async () => JSON.parse(await readFile(settingsPath, 'utf8'));
const open = (controller: ReceiverController | null) =>
  createReceiverSwitch({ settingsPath, controller, unavailableMessage: MESSAGE });

beforeEach(async () => {
  const dir = await mkdtemp(NodePath.join(tmpdir(), 'receiver-switch-'));
  settingsPath = NodePath.join(dir, 'settings.json');
});

describe('parseSettings', () => {
  it.each([[null], [1], ['true'], [[]], [{}], [{ receiverEnabled: 'no' }]])(
    'falls back to on for %j',
    (value) => {
      expect(parseSettings(value)).toEqual({ receiverEnabled: true });
    },
  );

  it('keeps a persisted false', () => {
    expect(parseSettings({ receiverEnabled: false })).toEqual({ receiverEnabled: false });
  });
});

describe('without the ingest build', () => {
  it('defaults to on and reports unavailable, never listening', async () => {
    const receiver = await open(null);
    expect(receiver.enabled()).toBe(true);
    expect(receiver.status()).toEqual(UNAVAILABLE);
  });

  it('reports off when disabled and unavailable when enabled again', async () => {
    const receiver = await open(null);
    expect(await receiver.setEnabled(false)).toEqual({ state: 'off' });
    expect(await persisted()).toEqual({ receiverEnabled: false });
    expect(await receiver.setEnabled(true)).toEqual(UNAVAILABLE);
    expect(await persisted()).toEqual({ receiverEnabled: true });
  });

  it('notifies listeners on each toggle', async () => {
    const receiver = await open(null);
    const seen: ReceiverStatus[] = [];
    receiver.onStatus((status) => seen.push(status));
    await receiver.setEnabled(false);
    await receiver.setEnabled(true);
    expect(seen).toEqual([{ state: 'off' }, UNAVAILABLE]);
  });
});

describe('persisted setting', () => {
  it('survives a relaunch', async () => {
    const first = await open(null);
    await first.setEnabled(false);
    const second = await open(null);
    expect(second.enabled()).toBe(false);
    expect(second.status()).toEqual({ state: 'off' });
  });

  it('falls back to on when settings.json is corrupt', async () => {
    await writeFile(settingsPath, '{ not json');
    const receiver = await open(null);
    expect(receiver.enabled()).toBe(true);
  });

  it('still toggles when the setting cannot be saved', async () => {
    const { controller, calls } = fakeController();
    settingsPath = NodePath.join(settingsPath, 'not-a-directory', 'settings.json');
    await writeFile(NodePath.dirname(NodePath.dirname(settingsPath)), '');
    const receiver = await open(controller);
    expect(await receiver.setEnabled(false)).toEqual({ state: 'off' });
    expect(calls).toEqual(['stop']);
    expect(receiver.enabled()).toBe(false);
  });
});

describe('with a controller', () => {
  it('starts on resume only when enabled', async () => {
    const on = fakeController();
    await (await open(on.controller)).resume();
    expect(on.calls).toEqual(['start']);

    await writeFile(settingsPath, JSON.stringify({ receiverEnabled: false }));
    const off = fakeController();
    await (await open(off.controller)).resume();
    expect(off.calls).toEqual([]);
  });

  it('retries with start even though the setting is already on', async () => {
    const { controller, calls, set } = fakeController();
    const receiver = await open(controller);
    set({ state: 'port-conflict', port: 13579 });
    expect(await receiver.setEnabled(true)).toEqual({ state: 'listening', port: 13579 });
    set({ state: 'failed', message: 'crashed' });
    expect(await receiver.setEnabled(true)).toEqual({ state: 'listening', port: 13579 });
    expect(calls).toEqual(['start', 'start']);
  });

  it('stops on disable and reports the controller status', async () => {
    const { controller, calls } = fakeController({ state: 'listening', port: 13579 });
    const receiver = await open(controller);
    expect(await receiver.setEnabled(false)).toEqual({ state: 'off' });
    expect(calls).toEqual(['stop']);
  });

  it('forwards controller status changes', async () => {
    const { controller, set } = fakeController();
    const receiver = await open(controller);
    const seen: ReceiverStatus[] = [];
    const unsubscribe = receiver.onStatus((status) => seen.push(status));
    set({ state: 'starting' });
    unsubscribe();
    set({ state: 'off' });
    expect(seen).toEqual([{ state: 'starting' }]);
  });

  it('ends on the last request when toggles overlap', async () => {
    const { controller, calls } = fakeController();
    const receiver = await open(controller);
    await Promise.all([
      receiver.setEnabled(false),
      receiver.setEnabled(true),
      receiver.setEnabled(false),
    ]);
    expect(calls).toEqual(['stop', 'start', 'stop']);
    expect(await persisted()).toEqual({ receiverEnabled: false });
  });

  it('keeps working after a start rejects', async () => {
    const { controller, calls } = fakeController();
    const refusing: ReceiverController = {
      ...controller,
      start: () => Promise.reject(new Error('refused')),
    };
    const receiver = await open(refusing);
    await receiver.setEnabled(true);
    await receiver.setEnabled(false);
    expect(calls).toEqual(['stop']);
  });

  it('stops for quit without changing the persisted setting', async () => {
    const { controller, calls } = fakeController();
    const receiver = await open(controller);
    await receiver.setEnabled(true);
    await receiver.stop();
    expect(calls).toEqual(['start', 'stop']);
    expect(await persisted()).toEqual({ receiverEnabled: true });
  });
});
