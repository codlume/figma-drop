import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as NodePath from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import type { ReceiverController } from '../shared/integration.ts';
import type { ReceiverStatus } from '../shared/receiver.ts';
import { createReceiverSwitch, parseSettings } from './receiver-switch.ts';

const MESSAGE = 'Export receiving is not installed in this build.';
const UNAVAILABLE: ReceiverStatus = { state: 'unavailable', message: MESSAGE };

// Labelled fake: it stands in for A-INGEST's controller and exists only in this test.
function fakeController(initial: ReceiverStatus = { state: 'off' }) {
  const calls: string[] = [];
  const listeners = new Set<(status: ReceiverStatus) => void>();
  const refuse: { start: Error | null; stop: Error | null } = { start: null, stop: null };
  let current = initial;
  const set = (status: ReceiverStatus) => {
    current = status;
    for (const listener of listeners) listener(status);
  };
  const controller: ReceiverController = {
    async start() {
      calls.push('start');
      if (refuse.start) throw refuse.start;
      set({ state: 'listening', port: 13579 });
    },
    async stop() {
      calls.push('stop');
      if (refuse.stop) throw refuse.stop;
      set({ state: 'off' });
    },
    status: () => current,
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { controller, calls, set, refuse };
}

let settingsDir: string;
let settingsPath: string;
const persisted = async () => JSON.parse(await readFile(settingsPath, 'utf8'));
const open = (controller: ReceiverController | null) =>
  createReceiverSwitch({ settingsPath, controller, unavailableMessage: MESSAGE });

beforeEach(async () => {
  settingsDir = await mkdtemp(NodePath.join(tmpdir(), 'receiver-switch-'));
  settingsPath = NodePath.join(settingsDir, 'settings.json');
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

  it('keeps running toggles after a listener throws', async () => {
    const { controller, calls } = fakeController();
    const receiver = await open(controller);
    const unsubscribe = receiver.onStatus(() => {
      throw new Error('listener');
    });
    await expect(receiver.setEnabled(true)).rejects.toThrow('listener');
    unsubscribe();
    expect(await receiver.setEnabled(false)).toEqual({ state: 'off' });
    expect(calls).toEqual(['start', 'stop']);
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

describe('when the controller rejects', () => {
  const failedWith = (cause: string) => ({
    state: 'failed',
    message: expect.stringContaining(cause),
  });

  it('reports a refused start instead of the stale status, keeping the setting on', async () => {
    const { controller, refuse } = fakeController({ state: 'off' });
    refuse.start = new Error('refused');
    const receiver = await open(controller);
    expect(await receiver.setEnabled(true)).toEqual(failedWith('refused'));
    expect(receiver.status()).toEqual(failedWith('refused'));
    expect(receiver.enabled()).toBe(true);
    expect(await persisted()).toEqual({ receiverEnabled: true });
  });

  it('reports a refused stop instead of the stale status, keeping the setting off', async () => {
    const { controller, refuse } = fakeController({ state: 'listening', port: 13579 });
    refuse.stop = new Error('stuck');
    const receiver = await open(controller);
    expect(await receiver.setEnabled(false)).toEqual(failedWith('stuck'));
    expect(receiver.enabled()).toBe(false);
    expect(await persisted()).toEqual({ receiverEnabled: false });
  });

  it('publishes the failure', async () => {
    const { controller, refuse } = fakeController();
    refuse.start = new Error('refused');
    const receiver = await open(controller);
    const seen: ReceiverStatus[] = [];
    receiver.onStatus((status) => seen.push(status));
    await receiver.setEnabled(true);
    expect(seen.at(-1)).toEqual(failedWith('refused'));
  });

  it('reports and publishes a refused start on resume', async () => {
    const { controller, refuse } = fakeController();
    refuse.start = new Error('refused');
    const receiver = await open(controller);
    const seen: ReceiverStatus[] = [];
    receiver.onStatus((status) => seen.push(status));
    await receiver.resume();
    expect(receiver.status()).toEqual(failedWith('refused'));
    expect(seen.at(-1)).toEqual(failedWith('refused'));
  });

  it('retries on Try again and reports the recovered status', async () => {
    const { controller, calls, refuse } = fakeController();
    refuse.start = new Error('refused');
    const receiver = await open(controller);
    await receiver.setEnabled(true);
    refuse.start = null;
    expect(await receiver.setEnabled(true)).toEqual({ state: 'listening', port: 13579 });
    expect(receiver.status()).toEqual({ state: 'listening', port: 13579 });
    expect(calls).toEqual(['start', 'start']);
  });

  // The first start refuses. Later ones stay pending and report nothing, so only the switch itself
  // can have dropped the failure.
  function refusesOnce() {
    const { controller } = fakeController();
    let attempts = 0;
    let finish = () => {};
    const flaky: ReceiverController = {
      ...controller,
      start() {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error('refused'));
        return new Promise<void>((resolve) => (finish = resolve));
      },
    };
    return { flaky, attempts: () => attempts, finish: () => finish() };
  }

  it('stops reporting the failure once the next toggle begins', async () => {
    const { flaky, attempts, finish } = refusesOnce();
    const receiver = await open(flaky);
    await receiver.setEnabled(true);
    const retry = receiver.setEnabled(true);
    await vi.waitFor(() => expect(attempts()).toBe(2));
    expect(receiver.status()).toEqual({ state: 'off' });
    finish();
    await retry;
  });

  it('stops reporting the failure once resume begins', async () => {
    const { flaky, attempts, finish } = refusesOnce();
    const receiver = await open(flaky);
    await receiver.setEnabled(true);
    const resumed = receiver.resume();
    await vi.waitFor(() => expect(attempts()).toBe(2));
    expect(receiver.status()).toEqual({ state: 'off' });
    finish();
    await resumed;
  });

  it('gives way to the next status the controller reports', async () => {
    const { controller, refuse, set } = fakeController();
    refuse.start = new Error('refused');
    const receiver = await open(controller);
    await receiver.setEnabled(true);
    const seen: ReceiverStatus[] = [];
    receiver.onStatus((status) => seen.push(status));
    set({ state: 'port-conflict', port: 13579 });
    expect(receiver.status()).toEqual({ state: 'port-conflict', port: 13579 });
    expect(seen).toEqual([{ state: 'port-conflict', port: 13579 }]);
  });
});

describe('when the setting cannot be saved', () => {
  const notSaved = {
    state: 'failed',
    message: expect.stringMatching(/could not be saved.*unchanged/),
  };

  const refuseWrites = () => chmod(settingsDir, 0o500);
  const allowWrites = () => chmod(settingsDir, 0o700);

  it('leaves the setting and a running controller as they were', async () => {
    await writeFile(settingsPath, JSON.stringify({ receiverEnabled: true }));
    const { controller, calls } = fakeController({ state: 'listening', port: 13579 });
    const receiver = await open(controller);
    await refuseWrites();
    expect(await receiver.setEnabled(false)).toEqual(notSaved);
    await allowWrites();
    expect(calls).toEqual([]);
    expect(receiver.enabled()).toBe(true);
    expect(await persisted()).toEqual({ receiverEnabled: true });
  });

  it('does not start a stopped controller', async () => {
    await writeFile(settingsPath, JSON.stringify({ receiverEnabled: false }));
    const { controller, calls } = fakeController();
    const receiver = await open(controller);
    await refuseWrites();
    expect(await receiver.setEnabled(true)).toEqual(notSaved);
    await allowWrites();
    expect(calls).toEqual([]);
    expect(receiver.enabled()).toBe(false);
  });

  it('agrees with what a relaunch reads', async () => {
    await writeFile(settingsPath, JSON.stringify({ receiverEnabled: true }));
    const receiver = await open(null);
    await refuseWrites();
    await receiver.setEnabled(false);
    await allowWrites();
    const relaunched = await open(null);
    expect(receiver.enabled()).toBe(relaunched.enabled());
  });

  it('publishes the failure without a controller too', async () => {
    const receiver = await open(null);
    const seen: ReceiverStatus[] = [];
    receiver.onStatus((status) => seen.push(status));
    await refuseWrites();
    expect(await receiver.setEnabled(false)).toEqual(notSaved);
    await allowWrites();
    expect(seen).toEqual([notSaved]);
  });

  it('applies the toggle once saving works again', async () => {
    const { controller, calls } = fakeController({ state: 'listening', port: 13579 });
    const receiver = await open(controller);
    await refuseWrites();
    await receiver.setEnabled(false);
    await allowWrites();
    expect(await receiver.setEnabled(false)).toEqual({ state: 'off' });
    expect(calls).toEqual(['stop']);
    expect(await persisted()).toEqual({ receiverEnabled: false });
  });

  it('saves before it drives the controller', async () => {
    const { controller } = fakeController();
    let savedAtStart: unknown;
    const receiver = await open({
      ...controller,
      async start() {
        savedAtStart = await persisted();
        await controller.start();
      },
    });
    await receiver.setEnabled(true);
    expect(savedAtStart).toEqual({ receiverEnabled: true });
  });
});

describe('after stop', () => {
  it('ignores a later toggle, leaving the controller and the setting alone', async () => {
    await writeFile(settingsPath, JSON.stringify({ receiverEnabled: false }));
    const { controller, calls } = fakeController();
    const receiver = await open(controller);
    await receiver.stop();
    expect(await receiver.setEnabled(true)).toEqual({ state: 'off' });
    expect(calls).toEqual(['stop']);
    expect(await persisted()).toEqual({ receiverEnabled: false });
    expect(receiver.enabled()).toBe(false);
  });

  it('ignores a toggle issued while stop is still running', async () => {
    const { controller, calls } = fakeController();
    const receiver = await open(controller);
    await Promise.all([receiver.stop(), receiver.setEnabled(true)]);
    expect(calls).toEqual(['stop']);
  });

  it('ignores a later resume', async () => {
    const { controller, calls } = fakeController();
    const receiver = await open(controller);
    await receiver.stop();
    await receiver.resume();
    expect(calls).toEqual(['stop']);
  });

  it('still runs a toggle requested before stop', async () => {
    const { controller, calls } = fakeController();
    const receiver = await open(controller);
    await Promise.all([receiver.setEnabled(false), receiver.stop()]);
    expect(calls).toEqual(['stop', 'stop']);
    expect(await persisted()).toEqual({ receiverEnabled: false });
  });
});
