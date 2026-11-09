import { describe, expect, it, vi } from 'vite-plus/test';

import { IPC } from '../shared/ipc.ts';
import type { FocusTarget, RevisionId } from '../shared/library.ts';
import { focusExport } from './focus.ts';

const TARGET: FocusTarget = { kind: 'revision', revisionId: 'revision-1' as RevisionId };

// Labelled fakes: they stand in for the library's `locate` and the Electron window owner.
function fakes({ target = TARGET as FocusTarget | null, shown = true, sent = true } = {}) {
  return {
    library: { locate: vi.fn(async () => target) },
    windows: { show: vi.fn(async () => shown), send: vi.fn(() => sent) },
  };
}

describe('focusExport', () => {
  it('resolves true once the target reaches a loaded window', async () => {
    const seams = fakes();
    expect(await focusExport('/known', seams)).toBe(true);
    expect(seams.library.locate).toHaveBeenCalledWith('/known');
    expect(seams.windows.send).toHaveBeenCalledWith(IPC.appFocusExport, TARGET);
  });

  it('resolves false for an unknown path and opens no window', async () => {
    const seams = fakes({ target: null });
    expect(await focusExport('/unknown', seams)).toBe(false);
    expect(seams.windows.show).not.toHaveBeenCalled();
  });

  it('resolves false and sends nothing when the page cannot load', async () => {
    const seams = fakes({ shown: false });
    expect(await focusExport('/known', seams)).toBe(false);
    expect(seams.windows.send).not.toHaveBeenCalled();
  });

  it('resolves false when the window is gone by the time the target is sent', async () => {
    expect(await focusExport('/known', fakes({ sent: false }))).toBe(false);
  });
});
