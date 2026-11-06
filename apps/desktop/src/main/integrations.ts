import * as NodePath from 'node:path';

import type { CreateLibrary, CreateReceiverController } from '../shared/integration.ts';

// The only place that knows which optional tickets have landed. The globs resolve at build time,
// to an empty map while a file is absent, so landing `src/library/index.ts` or the `src/ingest`
// pair needs no edit here. `vite.config.ts` packs `receiver-process.ts` when it exists.
const libraryModules = import.meta.glob<{ createLibrary: CreateLibrary }>('../library/index.ts', {
  eager: true,
});
const controllerModules = import.meta.glob<{ createReceiverController: CreateReceiverController }>(
  '../ingest/receiver-controller.ts',
  { eager: true },
);

export const createLibrary: CreateLibrary | null =
  Object.values(libraryModules)[0]?.createLibrary ?? null;

export const createReceiverController: CreateReceiverController | null =
  Object.values(controllerModules)[0]?.createReceiverController ?? null;

export const receiverEntry = NodePath.join(__dirname, 'receiver.cjs');
