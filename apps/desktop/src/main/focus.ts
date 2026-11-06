import type { Library } from '../shared/integration.ts';
import { IPC } from '../shared/ipc.ts';
import type { Windows } from './windows.ts';

// `path` is client-supplied. It only ever reaches `library.locate`, never `shell` or the OS.
// Resolves true only when the target reached a loaded window, so `/open` never claims a delivery
// that did not happen.
export async function focusExport(
  path: string,
  {
    library,
    windows,
  }: { library: Pick<Library, 'locate'>; windows: Pick<Windows, 'show' | 'send'> },
): Promise<boolean> {
  const target = await library.locate(path);
  if (!target) return false;
  if (!(await windows.show())) return false;
  return windows.send(IPC.appFocusExport, target);
}
