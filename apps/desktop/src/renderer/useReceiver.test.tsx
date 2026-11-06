import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { ReceiverStatus } from './bridge.ts';
import { createSyntheticBridge, type ScenarioName } from './synthetic/createSyntheticBridge.ts';
import { useReceiver } from './useReceiver.ts';

const listening: ReceiverStatus = { state: 'listening', port: 3579 };
const off: ReceiverStatus = { state: 'off' };

function answeredByHand() {
  const { bridge } = createSyntheticBridge();
  const listeners = new Set<(status: ReceiverStatus) => void>();
  const statusRequest = Promise.withResolvers<ReceiverStatus>();
  const switchRequest = Promise.withResolvers<ReceiverStatus>();
  const setEnabled = vi.fn(() => switchRequest.promise);
  return {
    bridge: {
      ...bridge,
      receiver: {
        getStatus: () => statusRequest.promise,
        onStatus: (listener: (status: ReceiverStatus) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        setEnabled,
      },
    },
    setEnabled,
    listenerCount: () => listeners.size,
    push: (status: ReceiverStatus) =>
      act(() => {
        for (const listener of listeners) listener(status);
      }),
    settle: (run: () => void) => act(async () => run()),
    statusRequest,
    switchRequest,
  };
}

const known = (status: ReceiverStatus) => ({
  kind: 'known',
  status,
  switching: false,
  switchError: null,
});

describe('useReceiver', () => {
  it('starts loading, then shows the status from main', async () => {
    const { bridge, statusRequest, settle } = answeredByHand();
    const { result } = renderHook(() => useReceiver(bridge));
    expect(result.current.state).toEqual({ kind: 'loading' });

    await settle(() => statusRequest.resolve(listening));

    expect(result.current.state).toEqual(known(listening));
  });

  it('lets a pushed status beat an older getStatus response', async () => {
    const { bridge, push, statusRequest, settle } = answeredByHand();
    const { result } = renderHook(() => useReceiver(bridge));

    push(off);
    await settle(() => statusRequest.resolve(listening));

    expect(result.current.state).toEqual(known(off));
  });

  it('lets a pushed status beat a getStatus rejection', async () => {
    const { bridge, push, statusRequest, settle } = answeredByHand();
    const { result } = renderHook(() => useReceiver(bridge));

    push(listening);
    await settle(() => statusRequest.reject(new Error('no reply')));

    expect(result.current.state).toEqual(known(listening));
  });

  it('is safe under a StrictMode double mount', async () => {
    const { bridge, listenerCount, push, statusRequest, settle } = answeredByHand();
    const { result } = renderHook(() => useReceiver(bridge), { wrapper: StrictMode });
    expect(listenerCount()).toBe(1);

    await settle(() => statusRequest.resolve(listening));
    expect(result.current.state).toEqual(known(listening));

    push(off);
    expect(result.current.state).toEqual(known(off));
  });

  it('stops listening after unmount', () => {
    const { bridge, listenerCount } = answeredByHand();
    const { unmount } = renderHook(() => useReceiver(bridge));

    unmount();

    expect(listenerCount()).toBe(0);
  });

  it('is unavailable when getStatus rejects, and reload recovers', async () => {
    const { bridge, control } = createSyntheticBridge({ scenario: 'receiver-unavailable' });
    const { result } = renderHook(() => useReceiver(bridge));
    await waitFor(() => expect(result.current.state.kind).toBe('unavailable'));

    control.recover();
    act(() => result.current.reload());
    expect(result.current.state).toEqual({ kind: 'loading' });

    await waitFor(() => expect(result.current.state).toEqual(known(listening)));
  });

  it('stays unavailable when reload finds main still silent', async () => {
    const { bridge } = createSyntheticBridge({ scenario: 'receiver-unavailable' });
    const { result } = renderHook(() => useReceiver(bridge));
    await waitFor(() => expect(result.current.state.kind).toBe('unavailable'));

    act(() => result.current.reload());

    await waitFor(() => expect(result.current.state.kind).toBe('unavailable'));
  });

  it.each<[ScenarioName, ReceiverStatus['state']]>([
    ['receiver-absent', 'unavailable'],
    ['port-conflict', 'port-conflict'],
    ['receiver-failed', 'failed'],
    ['receiver-off', 'off'],
  ])('passes %s through as a known status', async (scenario, state) => {
    const { bridge } = createSyntheticBridge({ scenario });
    const { result } = renderHook(() => useReceiver(bridge));

    await waitFor(() => expect(result.current.state.kind).toBe('known'));

    expect(result.current.state).toMatchObject({ status: { state } });
  });

  it('never shows a status main did not send while switching', async () => {
    const { bridge, statusRequest, switchRequest, settle } = answeredByHand();
    const { result } = renderHook(() => useReceiver(bridge));
    await settle(() => statusRequest.resolve(listening));

    act(() => result.current.setEnabled(false));
    expect(result.current.state).toEqual({ ...known(listening), switching: true });

    await settle(() => switchRequest.resolve(off));
    expect(result.current.state).toEqual(known(off));
  });

  it('shows pushed statuses while a switch is pending', async () => {
    const { bridge, push, statusRequest, settle } = answeredByHand();
    const { result } = renderHook(() => useReceiver(bridge));
    await settle(() => statusRequest.resolve(off));

    act(() => result.current.setEnabled(true));
    push({ state: 'starting' });

    expect(result.current.state).toEqual({ ...known({ state: 'starting' }), switching: true });
  });

  it('goes through the transition states on the synthetic receiver', async () => {
    const { bridge } = createSyntheticBridge();
    const { result } = renderHook(() => useReceiver(bridge));
    await waitFor(() => expect(result.current.state).toEqual(known(listening)));

    act(() => result.current.setEnabled(false));

    await waitFor(() => expect(result.current.state).toEqual(known(off)));
  });

  it('keeps the last status when a switch rejects, and the next attempt clears the error', async () => {
    const { bridge, control } = createSyntheticBridge({ scenario: 'actions-reject' });
    const { result } = renderHook(() => useReceiver(bridge));
    await waitFor(() => expect(result.current.state).toEqual(known(listening)));

    act(() => result.current.setEnabled(false));
    await waitFor(() =>
      expect(result.current.state).toEqual({
        ...known(listening),
        switchError: expect.any(String),
      }),
    );

    control.recover();
    act(() => result.current.setEnabled(false));
    expect(result.current.state).toMatchObject({ switching: true, switchError: null });

    await waitFor(() => expect(result.current.state).toEqual(known(off)));
  });

  it('ignores re-entrant calls while switching', async () => {
    const { bridge, setEnabled, statusRequest, switchRequest, settle } = answeredByHand();
    const { result } = renderHook(() => useReceiver(bridge));
    await settle(() => statusRequest.resolve(listening));

    act(() => {
      result.current.setEnabled(false);
      result.current.setEnabled(true);
    });
    act(() => result.current.setEnabled(true));
    expect(setEnabled).toHaveBeenCalledTimes(1);
    expect(setEnabled).toHaveBeenCalledWith(false);

    await settle(() => switchRequest.resolve(off));
    act(() => result.current.setEnabled(true));
    expect(setEnabled).toHaveBeenCalledTimes(2);
  });

  it('ignores switching before the status is known', () => {
    const { bridge, setEnabled } = answeredByHand();
    const { result } = renderHook(() => useReceiver(bridge));

    act(() => result.current.setEnabled(true));

    expect(setEnabled).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ kind: 'loading' });
  });
});
