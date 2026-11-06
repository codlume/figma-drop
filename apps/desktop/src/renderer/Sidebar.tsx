import * as stylex from '@stylexjs/stylex';
import { useId, type ReactNode } from 'react';
import type { ProjectId } from './bridge.ts';
import { InboxIcon } from './Icons.tsx';
import type { LibraryView } from './libraryView.ts';
import { color, font, radius, space } from './tokens.stylex.ts';
import { DragStrip, Truncate, shared } from './ui.tsx';
import { useListNavigation } from './useListNavigation.ts';

const INBOX: unique symbol = Symbol('unidentified');
type RowId = ProjectId | typeof INBOX;

const styles = stylex.create({
  sidebar: {
    backgroundColor: color.background,
    borderRightColor: color.border,
    borderRightStyle: 'solid',
    borderRightWidth: '1px',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    minWidth: 0,
  },
  nav: { display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 },
  list: { display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 },
  files: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingBottom: space.sm,
    paddingInline: space.sm,
  },
  heading: {
    color: color.textMuted,
    fontSize: font.sizeSm,
    fontWeight: font.weightBold,
    paddingBottom: space.xs,
    paddingInline: space.sm,
  },
  none: { color: color.textMuted, paddingBlock: space.xs, paddingInline: space.sm },
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
    minHeight: '28px',
    paddingBlock: space.xs,
    paddingInline: space.sm,
  },
  selected: {
    backgroundColor: {
      default: `color-mix(in srgb, ${color.accent} 16%, transparent)`,
      ':hover': `color-mix(in srgb, ${color.accent} 16%, transparent)`,
    },
    fontWeight: font.weightBold,
  },
  rowText: { flexGrow: 1, minWidth: 0 },
  hint: { color: color.textMuted, fontWeight: font.weightRegular },
  count: { color: color.textMuted, flexShrink: 0, fontVariantNumeric: 'tabular-nums' },
  onSelected: { color: color.text },
  inbox: {
    borderTopColor: color.border,
    borderTopStyle: 'solid',
    borderTopWidth: '1px',
    flexShrink: 0,
    padding: space.sm,
  },
  skeleton: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    padding: space.lg,
    rowGap: space.md,
  },
  bar: {
    backgroundColor: `color-mix(in srgb, ${color.text} 8%, transparent)`,
    borderRadius: radius.sm,
    height: '12px',
  },
  barLong: { width: '85%' },
  barMedium: { width: '70%' },
  barShort: { width: '60%' },
});

export function SidebarShell({
  list,
  receiver,
}: {
  readonly list: ReactNode;
  readonly receiver: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.sidebar)}>
      <DragStrip />
      <nav {...stylex.props(styles.nav)} aria-label="Library">
        {list}
      </nav>
      {receiver}
    </div>
  );
}

export function SidebarSkeleton() {
  return (
    <div {...stylex.props(styles.skeleton)} aria-hidden="true">
      <div {...stylex.props(styles.bar, styles.barMedium)} />
      <div {...stylex.props(styles.bar, styles.barLong)} />
      <div {...stylex.props(styles.bar, styles.barShort)} />
    </div>
  );
}

export function LibraryList({
  view,
  onSelectProject,
  onSelectUnidentified,
}: {
  readonly view: LibraryView;
  readonly onSelectProject: (id: ProjectId) => void;
  readonly onSelectUnidentified: () => void;
}) {
  const headingId = useId();
  const selectedRow: RowId | null =
    view.main.kind === 'unidentified' ? INBOX : view.selectedProjectId;
  const optionProps = useListNavigation<RowId>(
    [...view.projects.map((project) => project.id), INBOX],
    selectedRow,
    (id) => (id === INBOX ? onSelectUnidentified() : onSelectProject(id)),
  );

  return (
    <div {...stylex.props(styles.list)} role="listbox" aria-label="Library">
      <div {...stylex.props(styles.files)} role="group" aria-labelledby={headingId}>
        <div {...stylex.props(styles.heading)} id={headingId}>
          Figma files
        </div>
        {view.projects.length === 0 && <div {...stylex.props(styles.none)}>None yet</div>}
        {view.projects.map((project) => (
          <div
            key={project.id}
            {...optionProps(project.id)}
            {...stylex.props(
              styles.row,
              project.id === selectedRow && styles.selected,
              shared.focusRing,
            )}
          >
            <span {...stylex.props(styles.rowText)}>
              <Truncate text={project.name} />
              {project.keyHint && (
                <Truncate
                  text={project.keyHint}
                  style={[
                    shared.mono,
                    styles.hint,
                    project.id === selectedRow && styles.onSelected,
                  ]}
                />
              )}
            </span>
            <span {...stylex.props(styles.count, project.id === selectedRow && styles.onSelected)}>
              {project.nodeCount}
            </span>
          </div>
        ))}
      </div>
      <div {...stylex.props(styles.inbox)}>
        <div
          {...optionProps(INBOX)}
          {...stylex.props(styles.row, selectedRow === INBOX && styles.selected, shared.focusRing)}
        >
          <InboxIcon />
          <span {...stylex.props(styles.rowText)}>Unidentified</span>
          <span {...stylex.props(styles.count, selectedRow === INBOX && styles.onSelected)}>
            {view.unidentifiedCount}
          </span>
        </div>
      </div>
    </div>
  );
}
