import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { color, font, motion, space } from './tokens.stylex.ts';

const appear = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

const styles = stylex.create({
  screen: {
    alignItems: 'center',
    animationDuration: motion.durationBase,
    animationName: { default: appear, '@media (prefers-reduced-motion: reduce)': 'none' },
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    justifyContent: 'center',
    minHeight: 0,
    paddingBlock: space.xxl,
    paddingInline: space.xl,
    rowGap: space.sm,
    textAlign: 'center',
  },
  icon: { color: color.textMuted, marginBottom: space.xs },
  title: { color: color.text, fontSize: font.sizeLg, fontWeight: font.weightBold, margin: 0 },
  body: {
    color: color.textMuted,
    margin: 0,
    maxWidth: '380px',
    overflowWrap: 'anywhere',
    userSelect: 'text',
  },
  actions: { display: 'flex', marginTop: space.sm },
});

export function StateScreen({
  title,
  icon,
  actions,
  role,
  children,
}: {
  readonly title: string;
  readonly icon?: ReactNode;
  readonly actions?: ReactNode;
  readonly role?: 'alert';
  readonly children: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.screen)} role={role}>
      {icon && <div {...stylex.props(styles.icon)}>{icon}</div>}
      <h2 {...stylex.props(styles.title)}>{title}</h2>
      <p {...stylex.props(styles.body)}>{children}</p>
      {actions && <div {...stylex.props(styles.actions)}>{actions}</div>}
    </div>
  );
}
