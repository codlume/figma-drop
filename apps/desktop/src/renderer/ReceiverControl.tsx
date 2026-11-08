import * as stylex from '@stylexjs/stylex';
import type { ReceiverStatus } from './bridge.ts';
import { color, font, motion, space } from './tokens.stylex.ts';
import { Button, shared } from './ui.tsx';
import type { ReceiverState, UseReceiver } from './useReceiver.ts';

export type ShownReceiver =
  | ReceiverStatus
  | { readonly state: 'loading' }
  | { readonly state: 'unreachable'; readonly message: string };

export function shownReceiver(receiver: ReceiverState): ShownReceiver {
  switch (receiver.kind) {
    case 'known':
      return receiver.status;
    case 'loading':
      return { state: 'loading' };
    case 'unavailable':
      return { state: 'unreachable', message: receiver.message };
  }
}

type ReceiverCopy = {
  readonly title: string;
  readonly hints: readonly string[];
  readonly tone: 'idle' | 'busy' | 'good' | 'bad';
  readonly way: 'tryAgain' | 'reload' | null;
  readonly switchable: boolean;
  readonly isOn: boolean;
  readonly emptyLibrary: { readonly title: string; readonly body: string };
};

const exportHere = {
  title: 'No exports yet',
  body: 'Export from the figma-drop plugin in Figma and it appears here.',
};
const receiverOff = {
  title: 'The receiver is off',
  body: "Exports can't arrive while it's off. Turn it on, then export from the figma-drop plugin in Figma.",
};
const receiverProblem = {
  title: 'The receiver needs attention',
  body: 'Its status at the bottom of the sidebar says what to do.',
};

export function receiverCopy(shown: ShownReceiver): ReceiverCopy {
  switch (shown.state) {
    case 'off':
      return {
        title: 'Receiver off',
        hints: [],
        tone: 'idle',
        way: null,
        switchable: true,
        isOn: false,
        emptyLibrary: receiverOff,
      };
    case 'starting':
      return {
        title: 'Starting…',
        hints: [],
        tone: 'busy',
        way: null,
        switchable: true,
        isOn: true,
        emptyLibrary: exportHere,
      };
    case 'listening':
      return {
        title: `Listening on port ${shown.port}`,
        hints: [],
        tone: 'good',
        way: null,
        switchable: true,
        isOn: true,
        emptyLibrary: exportHere,
      };
    case 'stopping':
      return {
        title: 'Stopping…',
        hints: [],
        tone: 'busy',
        way: null,
        switchable: false,
        isOn: false,
        emptyLibrary: receiverOff,
      };
    case 'port-conflict':
      return {
        title: `Port ${shown.port} is in use`,
        hints: [
          'Another app is using this port. Quit that app, then try again.',
          ...(shown.holder ? [`Held by ${shown.holder.command} (pid ${shown.holder.pid})`] : []),
        ],
        tone: 'bad',
        way: 'tryAgain',
        switchable: true,
        isOn: true,
        emptyLibrary: receiverProblem,
      };
    case 'failed':
      return {
        title: 'Receiver problem',
        hints: [shown.message],
        tone: 'bad',
        way: 'tryAgain',
        switchable: true,
        isOn: shown.enabled !== false,
        emptyLibrary: receiverProblem,
      };
    case 'loading':
      return {
        title: 'Checking receiver…',
        hints: [],
        tone: 'busy',
        way: null,
        switchable: false,
        isOn: false,
        emptyLibrary: exportHere,
      };
    case 'unreachable':
      return {
        title: 'Receiver unavailable',
        hints: [shown.message],
        tone: 'bad',
        way: 'reload',
        switchable: false,
        isOn: false,
        emptyLibrary: receiverProblem,
      };
  }
}

const transition = {
  default: motion.durationFast,
  '@media (prefers-reduced-motion: reduce)': '0s',
};

const styles = stylex.create({
  root: {
    borderTopColor: color.border,
    borderTopStyle: 'solid',
    borderTopWidth: '1px',
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    padding: space.md,
    rowGap: space.sm,
  },
  row: { alignItems: 'center', columnGap: space.sm, display: 'flex', minHeight: '20px' },
  dot: { borderRadius: '999px', flexShrink: 0, height: '8px', width: '8px' },
  idle: { boxShadow: `inset 0 0 0 1.5px ${color.textMuted}` },
  busy: { backgroundColor: color.warning },
  good: { backgroundColor: color.success },
  bad: { backgroundColor: color.danger },
  title: {
    color: color.text,
    flexGrow: 1,
    fontWeight: font.weightMedium,
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  hint: {
    color: color.textMuted,
    fontSize: font.sizeSm,
    margin: 0,
    overflowWrap: 'anywhere',
    userSelect: 'text',
  },
  error: { color: color.danger, fontSize: font.sizeSm, margin: 0, overflowWrap: 'anywhere' },
  toggle: {
    alignItems: 'center',
    backgroundColor: color.textMuted,
    borderRadius: '999px',
    borderStyle: 'none',
    cursor: { default: 'default', ':is([aria-disabled="true"])': 'not-allowed' },
    display: 'flex',
    flexShrink: 0,
    height: '18px',
    opacity: { default: 1, ':is([aria-disabled="true"])': 0.5 },
    padding: '2px',
    transitionDuration: transition,
    transitionProperty: 'background-color',
    transitionTimingFunction: motion.easing,
    width: '30px',
  },
  toggleOn: { backgroundColor: color.accent },
  knob: {
    backgroundColor: color.surfaceRaised,
    borderRadius: '999px',
    height: '14px',
    transitionDuration: transition,
    transitionProperty: 'transform',
    transitionTimingFunction: motion.easing,
    width: '14px',
  },
  knobOn: { transform: 'translateX(12px)' },
});

export function ReceiverControl({ receiver }: { readonly receiver: UseReceiver }) {
  const { state, setEnabled, reload } = receiver;
  const copy = receiverCopy(shownReceiver(state));
  const switching = state.kind === 'known' && state.switching;

  return (
    <section {...stylex.props(styles.root)} aria-label="Receiver">
      <div {...stylex.props(styles.row)}>
        <span {...stylex.props(styles.dot, styles[copy.tone])} aria-hidden="true" />
        <span {...stylex.props(styles.title)} role="status">
          {copy.title}
        </span>
        {state.kind === 'known' && (
          <button
            type="button"
            role="switch"
            aria-checked={copy.isOn}
            aria-label="Receiver"
            aria-disabled={switching || !copy.switchable || undefined}
            onClick={switching || !copy.switchable ? undefined : () => setEnabled(!copy.isOn)}
            {...stylex.props(styles.toggle, copy.isOn && styles.toggleOn, shared.focusRing)}
          >
            <span {...stylex.props(styles.knob, copy.isOn && styles.knobOn)} />
          </button>
        )}
      </div>
      {copy.hints.map((hint) => (
        <p key={hint} {...stylex.props(styles.hint)}>
          {hint}
        </p>
      ))}
      {state.kind === 'known' && state.switchError && (
        <p {...stylex.props(styles.error)} role="alert">
          {state.switchError}
        </p>
      )}
      {copy.way === 'tryAgain' && (
        <Button fill disabled={switching} busy={switching} onClick={() => setEnabled(copy.isOn)}>
          Try again
        </Button>
      )}
      {copy.way === 'reload' && (
        <Button fill onClick={reload}>
          Reload
        </Button>
      )}
    </section>
  );
}
