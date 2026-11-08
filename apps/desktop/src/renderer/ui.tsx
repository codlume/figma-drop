import * as stylex from '@stylexjs/stylex';
import type { ComponentProps, ReactNode } from 'react';
import { SpinnerIcon } from './Icons.tsx';
import { color, font, motion, radius } from './tokens.stylex.ts';

export const shared = stylex.create({
  focusRing: {
    outlineColor: color.accent,
    outlineOffset: '1px',
    outlineStyle: { default: 'none', ':focus-visible': 'solid' },
    outlineWidth: '2px',
  },
  selectable: { cursor: 'text', userSelect: 'text' },
  checkerboard: {
    backgroundColor: color.surfaceRaised,
    backgroundImage: `repeating-conic-gradient(color-mix(in srgb, ${color.text} 6%, transparent) 0 25%, transparent 0 50%)`,
    backgroundSize: '16px 16px',
  },
  mono: { fontFamily: font.familyMono, fontSize: font.sizeSm },
  visuallyHidden: {
    borderWidth: 0,
    clipPath: 'inset(50%)',
    height: '1px',
    margin: '-1px',
    overflow: 'hidden',
    padding: 0,
    position: 'absolute',
    whiteSpace: 'nowrap',
    width: '1px',
  },
});

const styles = stylex.create({
  truncate: {
    display: 'block',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  dragStrip: { WebkitAppRegion: 'drag', flexShrink: 0, height: '38px' },
  button: {
    alignItems: 'center',
    backgroundColor: {
      default: color.surfaceRaised,
      ':hover:not([aria-disabled="true"])': `color-mix(in srgb, ${color.text} 6%, ${color.surfaceRaised})`,
    },
    borderColor: color.border,
    borderRadius: radius.sm,
    borderStyle: 'solid',
    borderWidth: '1px',
    color: color.text,
    columnGap: '6px',
    cursor: { default: 'default', ':is([aria-disabled="true"])': 'not-allowed' },
    display: 'inline-flex',
    flexShrink: 0,
    fontFamily: 'inherit',
    fontSize: font.sizeSm,
    fontWeight: font.weightMedium,
    justifyContent: 'center',
    lineHeight: '16px',
    minHeight: '28px',
    minWidth: 0,
    opacity: { default: 1, ':is([aria-disabled="true"])': 0.6 },
    paddingBlock: '5px',
    paddingInline: '10px',
    transitionDuration: {
      default: motion.durationFast,
      '@media (prefers-reduced-motion: reduce)': '0s',
    },
    transitionProperty: 'background-color',
    transitionTimingFunction: motion.easing,
    whiteSpace: 'nowrap',
  },
  danger: { color: color.danger },
  primary: {
    backgroundColor: {
      default: color.accent,
      ':hover:not([aria-disabled="true"])': `color-mix(in srgb, ${color.accent} 88%, ${color.text})`,
    },
    borderColor: color.accent,
    color: color.onAccent,
  },
  fill: { width: '100%' },
  busy: { opacity: { default: 1, ':is([aria-disabled="true"])': 1 } },
});

export function Truncate({
  text,
  as: Tag = 'span',
  style,
}: {
  readonly text: string;
  readonly as?: 'span' | 'h1' | 'dd';
  readonly style?: stylex.StyleXStyles;
}) {
  return (
    <Tag {...stylex.props(styles.truncate, style)} dir="auto" title={text}>
      {text}
    </Tag>
  );
}

export function DragStrip() {
  return <div {...stylex.props(styles.dragStrip)} aria-hidden="true" />;
}

type ButtonProps = Omit<ComponentProps<'button'>, 'className' | 'style'> & {
  readonly variant?: 'plain' | 'primary' | 'danger';
  readonly fill?: boolean;
  readonly busy?: boolean;
  readonly icon?: ReactNode;
};

export function Button({
  variant = 'plain',
  fill = false,
  busy = false,
  icon,
  children,
  disabled = false,
  onClick,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      aria-busy={busy || undefined}
      // A natively disabled button drops keyboard focus to the body while an action runs.
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      {...rest}
      {...stylex.props(
        styles.button,
        variant === 'danger' && styles.danger,
        variant === 'primary' && styles.primary,
        fill && styles.fill,
        busy && styles.busy,
        shared.focusRing,
      )}
    >
      {busy ? <SpinnerIcon /> : icon}
      {children}
    </button>
  );
}
