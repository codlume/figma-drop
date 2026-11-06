import * as stylex from '@stylexjs/stylex';
import { useEffect, useId, useRef } from 'react';
import { TrashIcon } from './Icons.tsx';
import { color, font, radius, space } from './tokens.stylex.ts';
import { Button, shared } from './ui.tsx';

export type TrashTarget = {
  readonly label: string;
  readonly labelIsPath: boolean;
  readonly consequence: string;
};

const styles = stylex.create({
  dialog: {
    '::backdrop': { backgroundColor: 'rgb(0 0 0 / 30%)' },
    backgroundColor: color.surfaceRaised,
    borderColor: color.border,
    borderRadius: radius.lg,
    borderStyle: 'solid',
    borderWidth: '1px',
    boxShadow: '0 12px 32px rgb(0 0 0 / 24%)',
    color: color.text,
    maxWidth: 'calc(100vw - 32px)',
    padding: space.lg,
    width: '340px',
  },
  title: { fontSize: font.sizeLg, fontWeight: font.weightBold, margin: 0 },
  label: { fontWeight: font.weightMedium, marginTop: space.sm, overflowWrap: 'anywhere' },
  body: { color: color.textMuted, marginBottom: 0, marginTop: space.xs },
  buttons: {
    columnGap: space.sm,
    display: 'flex',
    justifyContent: 'flex-end',
    marginTop: space.lg,
  },
});

/** Closing natively before calling out hands focus back to the button that opened the dialog. */
export function ConfirmTrash({
  target,
  onCancel,
  onConfirm,
}: {
  readonly target: TrashTarget;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    cancelButton.current?.focus();
  }, []);

  function closeThen(next: () => void) {
    dialog.current?.close();
    next();
  }

  return (
    <dialog
      ref={dialog}
      {...stylex.props(styles.dialog)}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        closeThen(onCancel);
      }}
    >
      <h2 {...stylex.props(styles.title)} id={titleId}>
        Move to Trash?
      </h2>
      <div {...stylex.props(styles.label)}>
        <span dir="auto" {...stylex.props(target.labelIsPath && shared.mono)}>
          {target.label}
        </span>
      </div>
      <p {...stylex.props(styles.body)}>{target.consequence}</p>
      <div {...stylex.props(styles.buttons)}>
        <Button ref={cancelButton} onClick={() => closeThen(onCancel)}>
          Cancel
        </Button>
        <Button variant="danger" icon={<TrashIcon />} onClick={() => closeThen(onConfirm)}>
          Move to Trash
        </Button>
      </div>
    </dialog>
  );
}
