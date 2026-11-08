import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import type { ExportNodeId, RevisionId } from './bridge.ts';
import { countOf, formatDate } from './format.ts';
import { InboxIcon } from './Icons.tsx';
import type { LibraryView } from './libraryView.ts';
import { NodeGrid } from './NodeGrid.tsx';
import { receiverCopy, shownReceiver } from './ReceiverControl.tsx';
import { StateScreen } from './StateScreen.tsx';
import { color, font, motion, radius, space } from './tokens.stylex.ts';
import { Button, Truncate, shared } from './ui.tsx';
import type { UseReceiver } from './useReceiver.ts';

const appear = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

const styles = stylex.create({
  header: {
    borderBottomColor: color.border,
    borderBottomStyle: 'solid',
    borderBottomWidth: '1px',
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    paddingBottom: space.md,
    paddingInline: space.lg,
    rowGap: '2px',
  },
  title: {
    color: color.text,
    fontSize: font.sizeXl,
    fontWeight: font.weightBold,
    lineHeight: 1.2,
    margin: 0,
  },
  subline: {
    alignItems: 'baseline',
    color: color.textMuted,
    columnGap: space.sm,
    display: 'flex',
    justifyContent: 'space-between',
    minWidth: 0,
  },
  count: { flexShrink: 0 },
  explain: { color: color.textMuted, margin: 0 },
  scroll: { flexGrow: 1, minHeight: 0, overflowY: 'auto' },
  skeletonTitle: { height: '24px', marginBottom: space.xs, width: '40%' },
  skeletonLine: { height: '12px', width: '25%' },
  skeletonGrid: {
    animationDelay: '150ms',
    animationDuration: motion.durationBase,
    animationFillMode: 'both',
    animationName: { default: appear, '@media (prefers-reduced-motion: reduce)': 'none' },
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  skeletonCards: {
    display: 'grid',
    gap: space.md,
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))',
    padding: { default: space.lg, '@media (max-width: 960px)': space.md },
  },
  skeletonCard: { aspectRatio: '2 / 3' },
  block: {
    backgroundColor: `color-mix(in srgb, ${color.text} 7%, transparent)`,
    borderRadius: radius.md,
  },
});

export function LoadingContent() {
  return (
    <>
      <p {...stylex.props(shared.visuallyHidden)} role="status">
        Loading library…
      </p>
      <div {...stylex.props(styles.skeletonGrid)} aria-hidden="true">
        <div {...stylex.props(styles.header)}>
          <div {...stylex.props(styles.block, styles.skeletonTitle)} />
          <div {...stylex.props(styles.block, styles.skeletonLine)} />
        </div>
        <div {...stylex.props(styles.skeletonCards)}>
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} {...stylex.props(styles.block, styles.skeletonCard)} />
          ))}
        </div>
      </div>
    </>
  );
}

function EmptyLibrary({ receiver }: { readonly receiver: UseReceiver }) {
  const shown = shownReceiver(receiver.state);
  const { emptyLibrary } = receiverCopy(shown);
  const switching = receiver.state.kind === 'known' && receiver.state.switching;
  return (
    <StateScreen
      title={emptyLibrary.title}
      actions={
        shown.state === 'off' && (
          <Button
            variant="primary"
            disabled={switching}
            busy={switching}
            onClick={() => receiver.setEnabled(true)}
          >
            Turn on receiver
          </Button>
        )
      }
    >
      {emptyLibrary.body}
    </StateScreen>
  );
}

function Header({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <header {...stylex.props(styles.header)}>
      <Truncate as="h1" text={title} style={styles.title} />
      {children}
    </header>
  );
}

export function LibraryContent({
  view,
  receiver,
  onSelectNode,
  onSelectEntry,
}: {
  readonly view: LibraryView;
  readonly receiver: UseReceiver;
  readonly onSelectNode: (id: ExportNodeId) => void;
  readonly onSelectEntry: (id: RevisionId) => void;
}) {
  const { main } = view;
  switch (main.kind) {
    case 'empty':
      return <EmptyLibrary receiver={receiver} />;
    case 'project':
      return (
        <>
          <Header title={main.project.name}>
            <div {...stylex.props(styles.subline)}>
              <Truncate text={main.fileKey} style={[shared.mono, shared.selectable]} />
              <span {...stylex.props(styles.count)}>{countOf(main.nodes.length, 'node')}</span>
            </div>
          </Header>
          <div {...stylex.props(styles.scroll)}>
            <NodeGrid
              label={`Nodes in ${main.project.name}`}
              items={main.nodes.map((node) => ({
                id: node.id,
                name: node.name,
                latest: node.latest,
                lines: [
                  formatDate(node.latest.receivedAt),
                  countOf(node.revisionCount, 'revision'),
                ],
              }))}
              selectedId={main.selectedNodeId}
              onSelect={onSelectNode}
            />
          </div>
        </>
      );
    case 'unidentified':
      return (
        <>
          <Header title="Unidentified">
            <p {...stylex.props(styles.explain)}>
              These exports have no stable Figma file identity. Each one stands alone and leaves
              only through Trash.
            </p>
          </Header>
          {main.entries.length === 0 ? (
            <StateScreen title="Nothing unidentified" icon={<InboxIcon size={20} />}>
              Every export has a Figma file to belong to.
            </StateScreen>
          ) : (
            <div {...stylex.props(styles.scroll)}>
              <NodeGrid
                label="Unidentified exports"
                items={main.entries.map((entry) => ({
                  id: entry.id,
                  name: entry.name,
                  latest: entry.latest,
                  lines: [`Claim: ${entry.claim}`, formatDate(entry.latest.receivedAt)],
                }))}
                selectedId={main.selectedEntryId}
                onSelect={onSelectEntry}
              />
            </div>
          )}
        </>
      );
  }
}
