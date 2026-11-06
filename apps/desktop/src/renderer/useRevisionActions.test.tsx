import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { CommandResult, RevisionId } from './bridge.ts';
import { createSyntheticBridge, type SyntheticOptions } from './synthetic/createSyntheticBridge.ts';
import { populatedLibrary } from './synthetic/fixtures.ts';
import { useRevisionActions, type RevisionAction } from './useRevisionActions.ts';

function revisionIn(nodeName: string): RevisionId {
  const node = populatedLibrary.projects
    .flatMap((project) => project.nodes)
    .find((candidate) => candidate.name.includes(nodeName));
  const id = node?.revisions[0]?.id;
  if (!id) throw new Error(`no fixture revision in ${nodeName}`);
  return id;
}

const heroId = revisionIn('Hero banner');
const damagedId = revisionIn('Damaged latest');

function setup(options?: SyntheticOptions) {
  const { bridge } = createSyntheticBridge(options);
  const onStale = vi.fn();
  const hook = renderHook(() => useRevisionActions(bridge, { onStale }));
  return { bridge, onStale, ...hook };
}

describe('useRevisionActions', () => {
  it.each<[RevisionAction, string | RegExp]>([
    ['reveal', 'Shown in Finder'],
    ['copyPath', 'Path copied'],
    ['trash', 'Moved to Trash'],
    ['copyToFolder', `Copied to /synthetic/copies/${heroId}`],
  ])('%s reports its success', async (action, message) => {
    const { result } = setup();

    act(() => result.current.run(action, heroId));
    expect(result.current.state).toEqual({ kind: 'running', action, revisionId: heroId });

    await waitFor(() => expect(result.current.state).toEqual({ kind: 'done', action, message }));
  });

  it('really trashes the revision', async () => {
    const { bridge, result } = setup();

    act(() => result.current.run('trash', heroId));
    await waitFor(() => expect(result.current.state.kind).toBe('done'));

    await expect(bridge.library.reveal(heroId)).resolves.toMatchObject({ code: 'not-found' });
  });

  it('returns to idle silently when the folder dialog is cancelled', async () => {
    const { result } = setup({ copyCancelled: true });

    act(() => result.current.run('copyToFolder', heroId));

    await waitFor(() => expect(result.current.state).toEqual({ kind: 'idle' }));
  });

  it("shows main's message on a failure and keeps the revision for Retry", async () => {
    const { result } = setup({ scenario: 'actions-fail' });

    act(() => result.current.run('reveal', heroId));

    await waitFor(() =>
      expect(result.current.state).toEqual({
        kind: 'failed',
        action: 'reveal',
        revisionId: heroId,
        message: 'Synthetic: the command failed.',
      }),
    );
  });

  it("shows main's reason when a damaged revision cannot be copied", async () => {
    const { onStale, result } = setup();

    act(() => result.current.run('copyToFolder', damagedId));

    await waitFor(() =>
      expect(result.current.state).toEqual({
        kind: 'failed',
        action: 'copyToFolder',
        revisionId: damagedId,
        message: 'Synthetic: a damaged revision cannot be copied.',
      }),
    );
    expect(onStale).not.toHaveBeenCalled();
  });

  it("gives a plain message on a rejection, without the rejection's own text", async () => {
    const { result } = setup({ scenario: 'actions-reject' });

    act(() => result.current.run('trash', heroId));

    await waitFor(() => expect(result.current.state.kind).toBe('failed'));
    expect(result.current.state).toMatchObject({ action: 'trash', revisionId: heroId });
    expect(result.current.state).not.toMatchObject({
      message: expect.stringContaining('Synthetic'),
    });
  });

  it('can rerun a failed action', async () => {
    const { bridge, control } = createSyntheticBridge({ scenario: 'actions-fail' });
    const { result } = renderHook(() => useRevisionActions(bridge, { onStale: () => {} }));
    act(() => result.current.run('reveal', heroId));
    await waitFor(() => expect(result.current.state.kind).toBe('failed'));

    control.recover();
    act(() => result.current.run('reveal', heroId));

    await waitFor(() =>
      expect(result.current.state).toEqual({
        kind: 'done',
        action: 'reveal',
        message: 'Shown in Finder',
      }),
    );
  });

  it.each<RevisionAction>(['reveal', 'copyPath', 'copyToFolder'])(
    'says the files are missing when %s gets not-found, since a damaged revision stays listed',
    async (action) => {
      const { bridge, onStale, result } = setup();
      await bridge.library.trash(heroId);

      act(() => result.current.run(action, heroId));

      await waitFor(() =>
        expect(result.current.state).toEqual({
          kind: 'failed',
          action,
          revisionId: heroId,
          message: "That revision's files are missing.",
        }),
      );
      expect(onStale).toHaveBeenCalledTimes(1);
    },
  );

  it('treats a trash that finds the revision already gone as stale', async () => {
    const { onStale, result } = setup({ trashAlreadyGone: true });

    act(() => result.current.run('trash', heroId));

    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1));
    expect(result.current.state).toMatchObject({
      kind: 'done',
      message: 'That revision is already gone',
    });
  });

  it('does not call onStale on success', async () => {
    const { onStale, result } = setup();

    act(() => result.current.run('reveal', heroId));

    await waitFor(() => expect(result.current.state.kind).toBe('done'));
    expect(onStale).not.toHaveBeenCalled();
  });

  it('runs one action at a time', async () => {
    const { bridge } = createSyntheticBridge();
    const reply = Promise.withResolvers<CommandResult>();
    const reveal = vi.fn(() => reply.promise);
    const trash = vi.fn(bridge.library.trash);
    const library = { ...bridge.library, reveal, trash };
    const { result } = renderHook(() =>
      useRevisionActions({ ...bridge, library }, { onStale: () => {} }),
    );

    act(() => {
      result.current.run('reveal', heroId);
      result.current.run('trash', heroId);
    });
    act(() => result.current.run('trash', heroId));
    expect(trash).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ kind: 'running', action: 'reveal' });

    await act(async () => reply.resolve({ ok: true }));
    act(() => result.current.run('trash', heroId));
    expect(trash).toHaveBeenCalledTimes(1);
  });

  it('dismiss clears a result, but not a running action', async () => {
    const { result } = setup();

    act(() => result.current.run('reveal', heroId));
    act(() => result.current.dismiss());
    expect(result.current.state.kind).toBe('running');

    await waitFor(() => expect(result.current.state.kind).toBe('done'));
    act(() => result.current.dismiss());
    expect(result.current.state).toEqual({ kind: 'idle' });
  });
});
