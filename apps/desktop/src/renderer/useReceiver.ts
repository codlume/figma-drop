import { Effect, type Fiber } from 'effect';
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

const UNAVAILABLE: ReceiverState = {
  kind: 'unavailable',
  message: 'figma-drop could not read the receiver status.',
};
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
  const pendingStatusRead = useRef<Fiber.Fiber<void> | null>(null);
  const switching = useRef(false);

  useEffect(() => {
    const read = Effect.runFork(
      Effect.tryPromise(() => bridge.receiver.getStatus()).pipe(
        Effect.match({ onSuccess: withStatus, onFailure: () => UNAVAILABLE }),
        Effect.andThen((next) => Effect.sync(() => setState(next))),
      ),
    );
    pendingStatusRead.current = read;

    const unsubscribe = bridge.receiver.onStatus((status) => {
      read.interruptUnsafe();
      setState(withStatus(status));
    });

    return () => {
      read.interruptUnsafe();
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
          pendingStatusRead.current?.interruptUnsafe();
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
