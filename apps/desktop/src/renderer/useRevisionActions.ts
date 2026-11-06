import { useCallback, useRef, useState } from 'react';
import type { CommandResult, CopyToFolderResult, FigmaDropApi, RevisionId } from './bridge.ts';

export type RevisionAction = 'reveal' | 'copyPath' | 'copyToFolder' | 'trash';

export type ActionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly action: RevisionAction; readonly revisionId: RevisionId }
  | { readonly kind: 'done'; readonly action: RevisionAction; readonly message: string }
  | {
      readonly kind: 'failed';
      readonly action: RevisionAction;
      readonly revisionId: RevisionId;
      readonly message: string;
    };

export type UseRevisionActions = {
  readonly state: ActionState;
  readonly run: (action: RevisionAction, revisionId: RevisionId) => void;
  readonly dismiss: () => void;
};

export type RevisionActionOptions = {
  readonly onStale: () => void;
};

type ActionResult = CommandResult | CopyToFolderResult;

type ActionEntry = {
  readonly call: (library: FigmaDropApi['library'], id: RevisionId) => Promise<ActionResult>;
  readonly success: (result: Extract<ActionResult, { ok: true }>) => string | null;
};

const ACTIONS: Record<RevisionAction, ActionEntry> = {
  reveal: { call: (library, id) => library.reveal(id), success: () => 'Shown in Finder' },
  copyPath: { call: (library, id) => library.copyPath(id), success: () => 'Path copied' },
  copyToFolder: {
    call: (library, id) => library.copyToFolder(id),
    success: (result) => ('path' in result ? `Copied to ${result.path}` : null),
  },
  trash: { call: (library, id) => library.trash(id), success: () => 'Moved to Trash' },
};

const ALREADY_GONE = 'That revision is already gone';
const FILES_MISSING = "That revision's files are missing.";
const NO_REPLY = 'That did not finish. Try again.';

export function useRevisionActions(
  bridge: FigmaDropApi,
  { onStale }: RevisionActionOptions,
): UseRevisionActions {
  const [state, setState] = useState<ActionState>({ kind: 'idle' });
  const running = useRef(false);

  const run = useCallback(
    (action: RevisionAction, revisionId: RevisionId) => {
      if (running.current) return;
      running.current = true;
      setState({ kind: 'running', action, revisionId });
      void (async () => {
        const { call, success } = ACTIONS[action];
        try {
          const result = await call(bridge.library, revisionId);
          if (result.ok) {
            const message = success(result);
            setState(message === null ? { kind: 'idle' } : { kind: 'done', action, message });
          } else if (result.code === 'not-found') {
            setState(
              action === 'trash'
                ? { kind: 'done', action, message: ALREADY_GONE }
                : { kind: 'failed', action, revisionId, message: FILES_MISSING },
            );
            onStale();
          } else {
            setState({ kind: 'failed', action, revisionId, message: result.message });
          }
        } catch {
          setState({ kind: 'failed', action, revisionId, message: NO_REPLY });
        } finally {
          running.current = false;
        }
      })();
    },
    [bridge, onStale],
  );

  const dismiss = useCallback(() => {
    setState((previous) => (previous.kind === 'running' ? previous : { kind: 'idle' }));
  }, []);

  return { state, run, dismiss };
}
