import * as stylex from '@stylexjs/stylex';
import type { Revision } from './bridge.ts';
import { PreviewImage } from './PreviewImage.tsx';
import { color, font, motion, radius, space } from './tokens.stylex.ts';
import { Truncate, shared } from './ui.tsx';
import { useListNavigation } from './useListNavigation.ts';

export type GridItem<Id> = {
  readonly id: Id;
  readonly name: string;
  readonly latest: Revision;
  readonly lines: readonly string[];
};

const styles = stylex.create({
  grid: {
    display: 'grid',
    gap: space.md,
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))',
    padding: { default: space.lg, '@media (max-width: 960px)': space.md },
  },
  card: {
    backgroundColor: color.surfaceRaised,
    borderColor: {
      default: color.border,
      ':hover': `color-mix(in srgb, ${color.text} 30%, ${color.border})`,
    },
    borderRadius: radius.md,
    borderStyle: 'solid',
    borderWidth: '1px',
    cursor: 'default',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    padding: '6px',
    rowGap: '6px',
    transitionDuration: {
      default: motion.durationFast,
      '@media (prefers-reduced-motion: reduce)': '0s',
    },
    transitionProperty: 'border-color',
    transitionTimingFunction: motion.easing,
  },
  selected: {
    borderColor: { default: color.accent, ':hover': color.accent },
    boxShadow: `inset 0 0 0 1px ${color.accent}`,
  },
  text: { display: 'flex', flexDirection: 'column', paddingInline: '2px', rowGap: '1px' },
  name: { color: color.text, fontWeight: font.weightMedium },
  line: { color: color.textMuted, fontSize: font.sizeSm },
});

export function NodeGrid<Id>({
  label,
  items,
  selectedId,
  onSelect,
}: {
  readonly label: string;
  readonly items: readonly GridItem<Id>[];
  readonly selectedId: Id | null;
  readonly onSelect: (id: Id) => void;
}) {
  const optionProps = useListNavigation(
    items.map((item) => item.id),
    selectedId,
    onSelect,
  );

  return (
    <div {...stylex.props(styles.grid)} role="listbox" aria-label={label}>
      {items.map((item) => (
        <div
          key={String(item.id)}
          {...optionProps(item.id)}
          {...stylex.props(
            styles.card,
            item.id === selectedId && styles.selected,
            shared.focusRing,
          )}
        >
          <PreviewImage revision={item.latest} alt="" size="card" />
          <div {...stylex.props(styles.text)}>
            <Truncate text={item.name} style={styles.name} />
            {item.lines.map((line) => (
              <Truncate key={line} text={line} style={styles.line} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
