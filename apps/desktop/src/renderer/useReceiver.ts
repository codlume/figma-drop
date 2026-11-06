import { useCallback, useEffect, useRef, useState } from 'react';
import type { FigmaDropApi, ReceiverStatus } from './bridge.ts';

export type ReceiverState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly message: string }
  | {
      readonly kind: 'known';
      readonly status: ReceiverStatus;
      readonly switching: boolean;
      readonly switchError: string | null;
    };

export type UseReceiver = {
  readonly state: ReceiverState;
  readonly setEnabled: (enabled: boolean) => void;
  readonly reload: () => void;
};

type KnownReceiver = Extract<ReceiverState, { kind: 'known' }>;

const STATUS_UNAVAILABLE = 'figma-drop could not read the receiver status.';
const SWITCH_FAILED = 'figma-drop could not switch the receiver.';

const withStatus =
  (status: ReceiverStatus) =>
  (previous: ReceiverState): ReceiverState =>
    previous.kind === 'known'
      ? { ...previous, status }
      : { kind: 'known', status, switching: false, switchError: null };

const whenKnown =
  (change: Partial<Omit<KnownReceiver, 'kind'>>) =>
  (previous: ReceiverState): ReceiverState =>
    previous.kind === 'known' ? { ...previous, ...change } : previous;

export function useReceiver(bridge: FigmaDropApi): UseReceiver {
  const [state, setState] = useState<ReceiverState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const statusSuperseded = useRef(false);
  const switching = useRef(false);

  useEffect(() => {
    let active = true;
    statusSuperseded.current = false;

    const unsubscribe = bridge.receiver.onStatus((status) => {
      statusSuperseded.current = true;
      setState(withStatus(status));
    });

    void (async () => {
      try {
        const status = await bridge.receiver.getStatus();
        if (active && !statusSuperseded.current) setState(withStatus(status));
      } catch {
        if (active && !statusSuperseded.current) {
          setState({ kind: 'unavailable', message: STATUS_UNAVAILABLE });
        }
      }
    })();

    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge, attempt]);

  const reload = useCallback(() => {
    setState((previous) => (previous.kind === 'known' ? previous : { kind: 'loading' }));
    setAttempt((previous) => previous + 1);
  }, []);

  const known = state.kind === 'known';
  const setEnabled = useCallback(
    (enabled: boolean) => {
      if (!known || switching.current) return;
      switching.current = true;
      setState(whenKnown({ switching: true, switchError: null }));
      void (async () => {
        try {
          const status = await bridge.receiver.setEnabled(enabled);
          statusSuperseded.current = true;
          setState(whenKnown({ status, switching: false }));
        } catch {
          setState(whenKnown({ switching: false, switchError: SWITCH_FAILED }));
        } finally {
          switching.current = false;
        }
      })();
    },
    [bridge, known],
  );

  return { state, setEnabled, reload };
}
