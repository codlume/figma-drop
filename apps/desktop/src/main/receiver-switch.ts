import { readJsonFile, writeJsonAtomic } from '../node/atomic-json.ts';
import type { ReceiverController } from '../shared/integration.ts';
import type { Unsubscribe } from '../shared/ipc.ts';
import type { ReceiverStatus } from '../shared/receiver.ts';

export type ReceiverSettings = { receiverEnabled: boolean };

export const DEFAULT_SETTINGS: ReceiverSettings = { receiverEnabled: true };

export function parseSettings(value: unknown): ReceiverSettings {
  const enabled = (value as Partial<ReceiverSettings> | null | undefined)?.receiverEnabled;
  return typeof enabled === 'boolean' ? { receiverEnabled: enabled } : DEFAULT_SETTINGS;
}

export type ReceiverSwitch = {
  enabled(): boolean;
  status(): ReceiverStatus;
  onStatus(listener: (status: ReceiverStatus) => void): Unsubscribe;
  setEnabled(enabled: boolean): Promise<ReceiverStatus>;
  // Starts the receiver if the persisted setting says so. Call once the library has opened.
  resume(): Promise<void>;
  // Stops for quit, leaving the persisted setting alone.
  stop(): Promise<void>;
};

export type ReceiverSwitchOptions = {
  settingsPath: string;
  // Null when the ingest build is absent, so no toggle can make anything listen.
  controller: ReceiverController | null;
  unavailableMessage: string;
};

export async function createReceiverSwitch({
  settingsPath,
  controller,
  unavailableMessage,
}: ReceiverSwitchOptions): Promise<ReceiverSwitch> {
  const settings = await readJsonFile(settingsPath, parseSettings);
  let enabled = (settings ?? DEFAULT_SETTINGS).receiverEnabled;
  const listeners = new Set<(status: ReceiverStatus) => void>();

  const status = (): ReceiverStatus => {
    if (controller) return controller.status();
    return enabled ? { state: 'unavailable', message: unavailableMessage } : { state: 'off' };
  };
  const publish = () => {
    const current = status();
    for (const listener of listeners) listener(current);
  };
  controller?.onStatus(publish);

  // One queue keeps the file and the controller on the last request when toggles overlap. Failures
  // stay inside it: a full disk or a refused start must not stop the next toggle from running.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (step: () => Promise<void>): Promise<void> => {
    const run = queue.then(step).catch((error: unknown) => {
      console.error('Receiver switch step failed', error);
    });
    queue = run;
    return run;
  };

  const persist = (next: boolean) =>
    writeJsonAtomic(settingsPath, { receiverEnabled: next } satisfies ReceiverSettings).catch(
      (error: unknown) => {
        console.error('Could not save the receiver setting', error);
      },
    );

  return {
    enabled: () => enabled,
    status,
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async setEnabled(next) {
      await enqueue(async () => {
        enabled = next;
        await persist(next);
        // Always start, even when already on: this is the retry from `port-conflict` or `failed`.
        if (next) await controller?.start();
        else await controller?.stop();
      });
      publish();
      return status();
    },
    resume: () =>
      enqueue(async () => {
        if (enabled) await controller?.start();
      }),
    stop: () =>
      enqueue(async () => {
        await controller?.stop();
      }),
  };
}
