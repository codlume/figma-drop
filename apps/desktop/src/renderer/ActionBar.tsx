import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RevisionId } from './bridge.ts';
import { ConfirmTrash, type TrashTarget } from './ConfirmTrash.tsx';
import { formatDate } from './format.ts';
import { CheckIcon, CopyIcon, CopyToFolderIcon, RevealIcon, TrashIcon } from './Icons.tsx';
import type { Detail } from './libraryView.ts';
import { color, font, radius, space } from './tokens.stylex.ts';
import { Button } from './ui.tsx';
import type { RevisionAction, UseRevisionActions } from './useRevisionActions.ts';

const actionCopy: Record<
  RevisionAction,
  {
    readonly label: string;
    readonly running: string;
    readonly failed: string;
    readonly icon: ReactNode;
  }
> = {
  reveal: {
    label: 'Reveal in Finder',
    running: 'Revealing…',
    failed: "Couldn't reveal in Finder",
    icon: <RevealIcon />,
  },
  copyPath: {
    label: 'Copy path',
    running: 'Copying…',
    failed: "Couldn't copy the path",
    icon: <CopyIcon />,
  },
  copyToFolder: {
    label: 'Copy to folder',
    running: 'Copying…',
    failed: "Couldn't copy to the folder",
    icon: <CopyToFolderIcon />,
  },
  trash: {
    label: 'Move to Trash',
    running: 'Moving…',
    failed: "Couldn't move to Trash",
    icon: <TrashIcon />,
  },
};

const styles = stylex.create({
  bar: {
    display: 'grid',
    gap: space.sm,
    gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))',
  },
  done: {
    alignItems: 'center',
    color: color.textMuted,
    columnGap: '6px',
    display: 'flex',
    fontSize: font.sizeSm,
    margin: 0,
    marginTop: space.sm,
    overflowWrap: 'anywhere',
  },
  failed: {
    backgroundColor: `color-mix(in srgb, ${color.danger} 10%, transparent)`,
    borderRadius: radius.sm,
    display: 'flex',
    flexDirection: 'column',
    marginTop: space.sm,
    padding: space.sm,
    rowGap: space.sm,
  },
  failedText: { color: color.text, fontSize: font.sizeSm, margin: 0, overflowWrap: 'anywhere' },
  failedTitle: { fontWeight: font.weightBold },
  failedButtons: { columnGap: space.sm, display: 'flex' },
  floating: { paddingBottom: space.md, paddingInline: space.lg },
});

function trashTarget(detail: Detail): TrashTarget {
  const { selected, source, title, revisions } = detail;
  if (selected.state === 'damaged') {
    return {
      label: selected.bundlePath,
      labelIsPath: true,
      consequence: "This damaged revision's folder moves to the macOS Trash.",
    };
  }
  if (source === 'unidentified') {
    return {
      label: title,
      labelIsPath: false,
      consequence: 'This export moves to the macOS Trash and leaves the Unidentified inbox.',
    };
  }
  const when = formatDate(selected.receivedAt);
  return {
    label: title,
    labelIsPath: false,
    consequence:
      revisions.length === 1
        ? `The revision from ${when} moves to the macOS Trash. It's the only revision, so this node leaves the library.`
        : `The revision from ${when} moves to the macOS Trash. Other revisions stay in the library.`,
  };
}

export function ActionFeedback({
  actions,
  currentId,
  returnFocus,
  floating = false,
}: {
  readonly actions: UseRevisionActions;
  readonly currentId: RevisionId | null;
  // Retry and Dismiss unmount as they are pressed, which would drop focus to the body.
  readonly returnFocus: () => void;
  readonly floating?: boolean;
}) {
  const { state, run, dismiss } = actions;
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.kind === 'done' || state.kind === 'failed') {
      root.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [state]);

  return (
    <div ref={root} {...stylex.props(floating && styles.floating)}>
      <div role="status">
        {state.kind === 'done' && (
          <p {...stylex.props(styles.done)}>
            <CheckIcon />
            {state.message}
          </p>
        )}
      </div>
      {state.kind === 'failed' && (
        <div {...stylex.props(styles.failed)} role="alert">
          <p {...stylex.props(styles.failedText)}>
            <span {...stylex.props(styles.failedTitle)}>{actionCopy[state.action].failed}. </span>
            {state.message}
          </p>
          <div {...stylex.props(styles.failedButtons)}>
            {state.revisionId === currentId && (
              <Button
                onClick={() => {
                  returnFocus();
                  run(state.action, state.revisionId);
                }}
              >
                Retry
              </Button>
            )}
            <Button
              onClick={() => {
                returnFocus();
                dismiss();
              }}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ActionBar({
  detail,
  actions,
}: {
  readonly detail: Detail;
  readonly actions: UseRevisionActions;
}) {
  const [confirming, setConfirming] = useState<{
    readonly id: RevisionId;
    readonly target: TrashTarget;
  } | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const { selected } = detail;
  const running = actions.state.kind === 'running' ? actions.state.action : null;
  const available: readonly RevisionAction[] =
    selected.state === 'damaged'
      ? ['reveal', 'copyPath', 'trash']
      : ['reveal', 'copyPath', 'copyToFolder', 'trash'];

  return (
    <div>
      <div ref={bar} {...stylex.props(styles.bar)} role="group" aria-label="Revision actions">
        {available.map((action) => (
          <Button
            key={action}
            fill
            variant={action === 'trash' ? 'danger' : 'plain'}
            icon={actionCopy[action].icon}
            disabled={running !== null}
            busy={running === action}
            onClick={() =>
              action === 'trash'
                ? setConfirming({ id: selected.id, target: trashTarget(detail) })
                : actions.run(action, selected.id)
            }
          >
            {running === action ? actionCopy[action].running : actionCopy[action].label}
          </Button>
        ))}
      </div>
      <ActionFeedback
        actions={actions}
        currentId={selected.id}
        returnFocus={() => bar.current?.querySelector('button')?.focus()}
      />
      {confirming && (
        <ConfirmTrash
          target={confirming.target}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            actions.run('trash', confirming.id);
          }}
        />
      )}
    </div>
  );
}
