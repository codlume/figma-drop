import type { FigmaDropApi } from '../shared/ipc.ts';

export type * from '../shared/ipc.ts';
export type * from '../shared/library.ts';
export type * from '../shared/receiver.ts';

export function getBridge(): FigmaDropApi | null {
  return window.figmaDrop ?? null;
}
