import { Effect, Latch } from 'effect';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FigmaDropApi, SnapshotSource } from './bridge.ts';
import type { ReadySnapshot } from './libraryView.ts';

export type LibraryState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly snapshot: ReadySnapshot;
      readonly refreshError: string | null;
    }
  | { readonly kind: 'failed'; readonly message: string };

export type UseLibrary = {
  readonly state: LibraryState;
  readonly retry: () => void;
  readonly refresh: () => void;
};

const LOAD_FAILED = 'figma-drop could not load the library.';
const REFRESH_FAILED = 'figma-drop could not refresh the library, so this may be out of date.';

type Transition = (previous: LibraryState) => LibraryState;

const fetchTransition = (bridge: FigmaDropApi, source: SnapshotSource) =>
  Effect.tryPromise(() => bridge.library.getSnapshot(source)).pipe(
    Effect.match({
      onSuccess:
        (snapshot): Transition =>
        () =>
          snapshot.state === 'ready'
            ? { kind: 'ready', snapshot, refreshError: null }
            : { kind: 'failed', message: snapshot.message },
      onFailure: (): Transition => (previous) =>
        previous.kind === 'ready'
          ? { ...previous, refreshError: REFRESH_FAILED }
          : { kind: 'failed', message: LOAD_FAILED },
    }),
  );

function sourceCoveringBoth(a: SnapshotSource, b: SnapshotSource): SnapshotSource {
  return a === 'disk' || b === 'disk' ? 'disk' : 'memory';
}

export function useLibrary(bridge: FigmaDropApi): UseLibrary {
  const [state, setState] = useState<LibraryState>({ kind: 'loading' });
  const load = useRef(() => {});

  useEffect(() => {
    const fetchOwed = Latch.makeUnsafe(true);
    let owed: SnapshotSource = 'disk';
    const owe = (source: SnapshotSource) => {
      owed = sourceCoveringBoth(owed, source);
      fetchOwed.openUnsafe();
    };
    const takeOwed = Effect.sync(() => {
      const source = owed;
      owed = 'memory';
      return source;
    });
    load.current = () => owe('disk');
    const unsubscribe = bridge.library.onChanged(() => owe('memory'));
    window.addEventListener('focus', load.current);

    const fetches = Effect.runFork(
      fetchOwed.await.pipe(
        Effect.andThen(fetchOwed.close),
        Effect.andThen(takeOwed),
        Effect.andThen((source) => fetchTransition(bridge, source)),
        Effect.andThen((transition) => Effect.sync(() => setState(transition))),
        Effect.forever,
      ),
    );

    return () => {
      fetches.interruptUnsafe();
      unsubscribe();
      window.removeEventListener('focus', load.current);
    };
  }, [bridge]);

  const refresh = useCallback(() => load.current(), []);
  const retry = useCallback(() => {
    setState((previous) => (previous.kind === 'ready' ? previous : { kind: 'loading' }));
    load.current();
  }, []);

  return { state, retry, refresh };
}
