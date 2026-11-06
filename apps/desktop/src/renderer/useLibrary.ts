import { useCallback, useEffect, useRef, useState } from 'react';
import type { FigmaDropApi } from './bridge.ts';
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

async function fetchTransition(bridge: FigmaDropApi): Promise<Transition> {
  try {
    const snapshot = await bridge.library.getSnapshot();
    return () =>
      snapshot.state === 'ready'
        ? { kind: 'ready', snapshot, refreshError: null }
        : { kind: 'failed', message: snapshot.message };
  } catch {
    return (previous) =>
      previous.kind === 'ready'
        ? { ...previous, refreshError: REFRESH_FAILED }
        : { kind: 'failed', message: LOAD_FAILED };
  }
}

export function useLibrary(bridge: FigmaDropApi): UseLibrary {
  const [state, setState] = useState<LibraryState>({ kind: 'loading' });
  const load = useRef(() => {});

  useEffect(() => {
    let active = true;
    let fetching = false;
    let dirty = false;

    const run = async () => {
      if (!active) return;
      if (fetching) {
        dirty = true;
        return;
      }
      fetching = true;
      do {
        dirty = false;
        const transition = await fetchTransition(bridge);
        if (active) setState(transition);
      } while (active && dirty);
      fetching = false;
    };

    load.current = () => void run();
    const unsubscribe = bridge.library.onChanged(load.current);
    window.addEventListener('focus', load.current);
    load.current();

    return () => {
      active = false;
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
