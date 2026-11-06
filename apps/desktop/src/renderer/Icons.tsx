import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';

const spin = stylex.keyframes({ to: { transform: 'rotate(360deg)' } });

const styles = stylex.create({
  icon: { flexShrink: 0 },
  spinner: {
    animationDuration: '900ms',
    animationIterationCount: 'infinite',
    animationName: { default: spin, '@media (prefers-reduced-motion: reduce)': 'none' },
    animationTimingFunction: 'linear',
  },
});

function Icon({
  size = 14,
  spinning = false,
  children,
}: {
  readonly size?: number;
  readonly spinning?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <svg
      {...stylex.props(styles.icon, spinning && styles.spinner)}
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

type IconProps = { readonly size?: number };

export function RevealIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 12.5v-9h4l1.5 1.5H14v7.5z" />
      <path d="M8 11V7.5M6.5 9 8 7.5 9.5 9" />
    </Icon>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-.25A1.25 1.25 0 0 0 9.25 2h-5A1.25 1.25 0 0 0 3 3.25v5a1.25 1.25 0 0 0 1.25 1.25h.25" />
    </Icon>
  );
}

export function CopyToFolderIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 12.5v-9h4l1.5 1.5H14v7.5z" />
      <path d="M8 7.25v3.5M6.25 9h3.5" />
    </Icon>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.75 9.5h6.5L12 4M6.75 6.75v4M9.25 6.75v4" />
    </Icon>
  );
}

export function InboxIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 9.5 4 3h8l2 6.5V13H2zM2 9.5h3.5l1 1.5h3l1-1.5H14" />
    </Icon>
  );
}

export function DocumentIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 2h5.5L12 4.5V14H4zM9.5 2v2.5H12M6 8h4M6 10.5h4" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m3 8.5 3.25 3.25L13 4.75" />
    </Icon>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.25 14.5 13.5h-13zM8 6.5v3.25M8 11.75v.01" />
    </Icon>
  );
}

export function SpinnerIcon(props: IconProps) {
  return (
    <Icon {...props} spinning>
      <path d="M8 2a6 6 0 1 0 6 6" />
    </Icon>
  );
}
