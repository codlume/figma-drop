import * as stylex from '@stylexjs/stylex';

const DARK = '@media (prefers-color-scheme: dark)';

export const color = stylex.defineVars({
  background: { default: '#f6f6f4', [DARK]: '#1b1b1d' },
  surface: { default: '#ffffff', [DARK]: '#242427' },
  surfaceRaised: { default: '#ffffff', [DARK]: '#2e2e32' },
  border: { default: '#e2e2de', [DARK]: '#3a3a3f' },
  text: { default: '#1c1c1e', [DARK]: '#f2f2f0' },
  textMuted: { default: '#6c6c70', [DARK]: '#a0a0a6' },
  accent: { default: '#3355dd', [DARK]: '#8ba3ff' },
  onAccent: { default: '#ffffff', [DARK]: '#10152b' },
  success: { default: '#1f7a4d', [DARK]: '#5fd39a' },
  warning: { default: '#9a6200', [DARK]: '#f0b64d' },
  danger: { default: '#c0332b', [DARK]: '#ff8a80' },
});

export const space = stylex.defineVars({
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  xxl: '32px',
});

export const radius = stylex.defineVars({
  sm: '4px',
  md: '8px',
  lg: '12px',
});

export const font = stylex.defineVars({
  family: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
  familyMono: "ui-monospace, 'SF Mono', Menlo, monospace",
  sizeSm: '12px',
  sizeMd: '13px',
  sizeLg: '15px',
  sizeXl: '20px',
  weightRegular: '400',
  weightMedium: '500',
  weightBold: '600',
  lineHeight: '1.4',
});

export const motion = stylex.defineVars({
  durationFast: '120ms',
  durationBase: '200ms',
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
});
