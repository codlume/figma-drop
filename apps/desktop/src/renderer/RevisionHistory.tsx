import * as stylex from '@stylexjs/stylex';
import { useId } from 'react';
import type { Revision, RevisionId } from './bridge.ts';
import { formatExactDate } from './format.ts';
import { PreviewImage } from './PreviewImage.tsx';
import { color, font, radius, space } from './tokens.stylex.ts';
import { shared } from './ui.tsx';
import { useListNavigation } from './useListNavigation.ts';

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', rowGap: space.xs },
  heading: {
    color: color.textMuted,
    fontSize: font.sizeSm,
    fontWeight: font.weightBold,
    margin: 0,
  },
  list: { display: 'flex', flexDirection: 'column', rowGap: '2px' },
  row: {
    alignItems: 'center',
    backgroundColor: {
      default: 'transparent',
      ':hover': `color-mix(in srgb, ${color.text} 6%, transparent)`,
    },
    borderRadius: radius.sm,
    color: color.text,
    columnGap: space.sm,
    cursor: 'default',
    display: 'flex',
    padding: space.xs,
  },
  selected: {
    backgroundColor: {
      default: `color-mix(in srgb, ${color.accent} 16%, transparent)`,
      ':hover': `color-mix(in srgb, ${color.accent} 16%, transparent)`,
    },
    fontWeight: font.weightMedium,
  },
  thumb: { flexShrink: 0, width: '36px' },
  date: { flexGrow: 1, minWidth: 0 },
  tag: {
    borderColor: color.border,
    borderRadius: radius.sm,
    borderStyle: 'solid',
    borderWidth: '1px',
    color: color.textMuted,
    flexShrink: 0,
    fontSize: font.sizeSm,
    fontWeight: font.weightRegular,
    lineHeight: '16px',
    paddingInline: space.xs,
  },
  warning: { color: color.warning },
  onSelected: { color: color.text },
});

export function RevisionHistory({
  revisions,
  selectedId,
  onSelect,
}: {
  readonly revisions: readonly Revision[];
  readonly selectedId: RevisionId;
  readonly onSelect: (id: RevisionId) => void;
}) {
  const headingId = useId();
  const optionProps = useListNavigation(
    revisions.map((revision) => revision.id),
    selectedId,
    onSelect,
  );

  return (
    <section {...stylex.props(styles.root)}>
      <h3 {...stylex.props(styles.heading)} id={headingId}>
        History
      </h3>
      <div {...stylex.props(styles.list)} role="listbox" aria-labelledby={headingId}>
        {revisions.map((revision, index) => (
          <div
            key={revision.id}
            {...optionProps(revision.id)}
            {...stylex.props(
              styles.row,
              revision.id === selectedId && styles.selected,
              shared.focusRing,
            )}
          >
            <div {...stylex.props(styles.thumb)}>
              <PreviewImage revision={revision} alt="" size="row" />
            </div>
            <span {...stylex.props(styles.date)}>{formatExactDate(revision.receivedAt)}</span>
            {revision.state === 'damaged' && (
              <span
                {...stylex.props(
                  styles.tag,
                  styles.warning,
                  revision.id === selectedId && styles.onSelected,
                )}
              >
                Damaged
              </span>
            )}
            {index === 0 && (
              <span {...stylex.props(styles.tag, revision.id === selectedId && styles.onSelected)}>
                Latest
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
