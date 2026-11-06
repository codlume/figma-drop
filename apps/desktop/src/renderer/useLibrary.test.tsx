import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { LibrarySnapshot } from './bridge.ts';
import { createSyntheticBridge } from './synthetic/createSyntheticBridge.ts';
import { emptyLibrary, populatedLibrary } from './synthetic/fixtures.ts';
import { useLibrary } from './useLibrary.ts';

const unreadable: LibrarySnapshot = {
  state: 'unreadable',
  message: 'Main says no',
  projects: [],
  unidentified: [],
};

function answeredByHand() {
  const { bridge, control } = createSyntheticBridge();
  const requests: PromiseWithResolvers<LibrarySnapshot>[] = [];
  const getSnapshot = vi.fn(() => {
    const request = Promise.withResolvers<LibrarySnapshot>();
    requests.push(request);
    return request.promise;
  });
  const settle = (
    index: number,
    settleRequest: (r: PromiseWithResolvers<LibrarySnapshot>) => void,
  ) =>
    act(async () => {
      const request = requests[index];
      if (!request) throw new Error(`no request ${index}`);
      settleRequest(request);
    });
  return {
    bridge: { ...bridge, library: { ...bridge.library, getSnapshot } },
    control,
    getSnapshot,
    answer: (index: number, snapshot: LibrarySnapshot) =>
      settle(index, (request) => request.resolve(snapshot)),
    reject: (index: number) => settle(index, (request) => request.reject(new Error('no reply'))),
  };
}

describe('useLibrary', () => {
  it('loads, then shows the snapshot', async () => {
    const { bridge, answer } = answeredByHand();
    const { result } = renderHook(() => useLibrary(bridge));
    expect(result.current.state).toEqual({ kind: 'loading' });

    await answer(0, populatedLibrary);

    expect(result.current.state).toEqual({
      kind: 'ready',
      snapshot: populatedLibrary,
      refreshError: null,
    });
  });

  it('refetches when the window regains focus, because nothing watches the folder', async () => {
    const { bridge, getSnapshot, answer } = answeredByHand();
    const { result } = renderHook(() => useLibrary(bridge));
    await answer(0, populatedLibrary);

    act(() => void window.dispatchEvent(new Event('focus')));
    await answer(1, unreadable);

    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(result.current.state).toEqual({ kind: 'failed', message: 'Main says no' });
  });

  it('does not lose a commit that lands as the first fetch starts', async () => {
    const { bridge, control, getSnapshot, answer } = answeredByHand();
    const fetchSnapshot = getSnapshot.getMockImplementation();
    getSnapshot.mockImplementationOnce(() => {
      control.pushExport();
      if (!fetchSnapshot) throw new Error('no implementation');
      return fetchSnapshot();
    });
    const { result } = renderHook(() => useLibrary(bridge));

    await answer(0, emptyLibrary);
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
    await answer(1, populatedLibrary);

    expect(result.current.state).toMatchObject({ kind: 'ready', snapshot: populatedLibrary });
  });

  it('runs one more fetch for any number of changes during a fetch', async () => {
    const { bridge, control, getSnapshot, answer } = answeredByHand();
    const { result } = renderHook(() => useLibrary(bridge));

    control.pushExport();
    control.pushExport();
    control.pushExport();
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    await answer(0, emptyLibrary);
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
    await answer(1, populatedLibrary);

    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(result.current.state).toMatchObject({ snapshot: populatedLibrary });
  });

  it('fetches again for a change after the last fetch finished', async () => {
    const { bridge, control, getSnapshot, answer } = answeredByHand();
    const { result } = renderHook(() => useLibrary(bridge));
    await answer(0, emptyLibrary);

    act(() => void control.pushExport());
    await answer(1, populatedLibrary);

    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(result.current.state).toMatchObject({ snapshot: populatedLibrary });
  });

  it('is safe under a StrictMode double mount', async () => {
    const { bridge, control, getSnapshot, answer } = answeredByHand();
    const { result } = renderHook(() => useLibrary(bridge), { wrapper: StrictMode });
    expect(getSnapshot).toHaveBeenCalledTimes(2);

    await answer(1, populatedLibrary);
    await answer(0, emptyLibrary);
    expect(result.current.state).toMatchObject({ snapshot: populatedLibrary });

    act(() => void control.pushExport());
    expect(getSnapshot).toHaveBeenCalledTimes(3);
  });

  it('applies nothing and fetches nothing after unmount', async () => {
    const { bridge, control, getSnapshot, answer } = answeredByHand();
    const { result, unmount } = renderHook(() => useLibrary(bridge));
    control.pushExport();

    unmount();
    await answer(0, populatedLibrary);
    control.pushExport();

    expect(result.current.state).toEqual({ kind: 'loading' });
    expect(getSnapshot).toHaveBeenCalledTimes(1);
  });

  it('leaves no change listener behind after a StrictMode mount and unmount', () => {
    const { bridge } = answeredByHand();
    const listeners = new Set<() => void>();
    const onChanged = (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
    const library = { ...bridge.library, onChanged };

    const { unmount } = renderHook(() => useLibrary({ ...bridge, library }), {
      wrapper: StrictMode,
    });
    expect(listeners.size).toBe(1);

    unmount();
    expect(listeners.size).toBe(0);
  });

  it.each(['unreadable', 'library-unavailable'] as const)(
    "shows main's message for %s, and a later success recovers without a restart",
    async (scenario) => {
      const { bridge, control } = createSyntheticBridge({ scenario });
      const { result } = renderHook(() => useLibrary(bridge));
      await waitFor(() => expect(result.current.state.kind).toBe('failed'));
      expect(result.current.state).toMatchObject({ message: expect.stringContaining('Synthetic') });

      control.recover();
      act(() => result.current.retry());
      expect(result.current.state).toEqual({ kind: 'loading' });

      await waitFor(() => expect(result.current.state.kind).toBe('ready'));
      expect(result.current.state).toMatchObject({ snapshot: populatedLibrary });
    },
  );

  it('stays failed when retrying an unreadable library that has not recovered', async () => {
    const { bridge } = createSyntheticBridge({ scenario: 'unreadable' });
    const { result } = renderHook(() => useLibrary(bridge));
    await waitFor(() => expect(result.current.state.kind).toBe('failed'));

    act(() => result.current.retry());

    await waitFor(() => expect(result.current.state.kind).toBe('failed'));
  });

  it('fails on a first-load rejection, and retry refetches', async () => {
    const { bridge, answer, reject } = answeredByHand();
    const { result } = renderHook(() => useLibrary(bridge));

    await reject(0);
    expect(result.current.state).toEqual({ kind: 'failed', message: expect.any(String) });

    act(() => result.current.retry());
    expect(result.current.state).toEqual({ kind: 'loading' });
    await answer(1, populatedLibrary);

    expect(result.current.state).toMatchObject({ kind: 'ready', snapshot: populatedLibrary });
  });

  it('keeps the last snapshot when a refetch rejects, until a success clears the error', async () => {
    const { bridge, control, answer, reject } = answeredByHand();
    const { result } = renderHook(() => useLibrary(bridge));
    await answer(0, populatedLibrary);

    act(() => void control.pushExport());
    await reject(1);
    expect(result.current.state).toEqual({
      kind: 'ready',
      snapshot: populatedLibrary,
      refreshError: expect.any(String),
    });

    act(() => void control.pushExport());
    await answer(2, emptyLibrary);
    expect(result.current.state).toEqual({
      kind: 'ready',
      snapshot: emptyLibrary,
      refreshError: null,
    });
  });

  it('fails when main reports the library unreadable on a refetch, even with data held', async () => {
    const { bridge, control, answer } = answeredByHand();
    const { result } = renderHook(() => useLibrary(bridge));
    await answer(0, populatedLibrary);

    act(() => void control.pushExport());
    await answer(1, unreadable);

    expect(result.current.state).toEqual({ kind: 'failed', message: 'Main says no' });
  });

  it('refresh refetches without showing loading', async () => {
    const { bridge, answer } = answeredByHand();
    const { result } = renderHook(() => useLibrary(bridge));
    await answer(0, populatedLibrary);

    act(() => result.current.refresh());
    expect(result.current.state).toMatchObject({ kind: 'ready', snapshot: populatedLibrary });
    await answer(1, emptyLibrary);

    expect(result.current.state).toMatchObject({ kind: 'ready', snapshot: emptyLibrary });
  });

  it('retry keeps the screen when a snapshot is already held', async () => {
    const { bridge, control, answer, reject } = answeredByHand();
    const { result } = renderHook(() => useLibrary(bridge));
    await answer(0, populatedLibrary);
    act(() => void control.pushExport());
    await reject(1);

    act(() => result.current.retry());
    expect(result.current.state).toMatchObject({ kind: 'ready', snapshot: populatedLibrary });
    await answer(2, emptyLibrary);

    expect(result.current.state).toMatchObject({ snapshot: emptyLibrary, refreshError: null });
  });

  it('keeps the same retry and refresh across renders', async () => {
    const { bridge, answer } = answeredByHand();
    const { result } = renderHook(() => useLibrary(bridge));
    const { retry, refresh } = result.current;

    await answer(0, populatedLibrary);

    expect(result.current.retry).toBe(retry);
    expect(result.current.refresh).toBe(refresh);
  });
});
