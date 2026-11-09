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
  // Stops for quit, leaving the persisted setting alone. Later toggles and resumes do nothing.
  stop(): Promise<void>;
};

export type ReceiverSwitchOptions = {
  settingsPath: string;
  controller: ReceiverController;
};

const SETTING_NOT_SAVED_MESSAGE =
  'The setting could not be saved, so the receiver was left unchanged.';

export async function createReceiverSwitch({
  settingsPath,
  controller,
}: ReceiverSwitchOptions): Promise<ReceiverSwitch> {
  const settings = await readJsonFile(settingsPath, parseSettings);
  let enabled = (settings ?? DEFAULT_SETTINGS).receiverEnabled;
  // Why the last step failed, which the controller's own status cannot say: it can still read `off`
  // after refusing to start. It outranks that status until the next attempt or controller report.
  let fault: string | null = null;
  let stopped = false;
  const listeners = new Set<(status: ReceiverStatus) => void>();

  const status = (): ReceiverStatus => {
    if (fault !== null) return { state: 'failed', message: fault, enabled };
    const current = controller.status();
    return current.state === 'failed' ? { ...current, enabled } : current;
  };
  const publish = () => {
    const current = status();
    for (const listener of listeners) listener(current);
    return current;
  };
  controller.onStatus(() => {
    fault = null;
    publish();
  });

  // One queue keeps the file and the controller on the last request when toggles overlap. Each step
  // publishes before the next begins, and its caller gets that same status. A step records its own
  // failures as `fault`, so only a throwing listener rejects, and the queue outlives that too.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (step: () => Promise<void>): Promise<ReceiverStatus> => {
    const run = queue.then(async () => {
      if (stopped) return status();
      await step();
      return publish();
    });
    queue = run.catch((error: unknown) => {
      console.error('Receiver switch step failed', error);
    });
    return run;
  };

  const drive = async (action: 'start' | 'stop') => {
    try {
      await controller[action]();
    } catch (error) {
      console.error(`Could not ${action} the receiver`, error);
      const cause = error instanceof Error ? error.message : String(error);
      fault = `Could not ${action}: ${cause}`;
    }
  };

  return {
    enabled: () => enabled,
    status,
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setEnabled: (next) =>
      enqueue(async () => {
        fault = null;
        try {
          await writeJsonAtomic(settingsPath, { receiverEnabled: next } satisfies ReceiverSettings);
        } catch (error) {
          console.error('Could not save the receiver setting', error);
          fault = SETTING_NOT_SAVED_MESSAGE;
          return;
        }
        enabled = next;
        // Always start, even when already on: this is the retry from `port-conflict` or `failed`.
        await drive(next ? 'start' : 'stop');
      }),
    resume: async () => {
      await enqueue(async () => {
        fault = null;
        if (enabled) await drive('start');
      });
    },
    stop: async () => {
      await enqueue(async () => {
        stopped = true;
        await drive('stop');
      });
    },
  };
}
