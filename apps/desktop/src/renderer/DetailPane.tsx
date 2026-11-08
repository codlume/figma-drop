import * as stylex from '@stylexjs/stylex';
import { type Ref, useEffect, useRef, useState } from 'react';
import { ActionBar } from './ActionBar.tsx';
import type { RevisionId } from './bridge.ts';
import { formatDate } from './format.ts';
import { ImageViewer } from './ImageViewer.tsx';
import type { Detail } from './libraryView.ts';
import { PreviewImage } from './PreviewImage.tsx';
import { RevisionHistory } from './RevisionHistory.tsx';
import { color, font, space } from './tokens.stylex.ts';
import { DragStrip, Truncate, shared } from './ui.tsx';
import type { UseRevisionActions } from './useRevisionActions.ts';

const styles = stylex.create({
  pane: {
    backgroundColor: color.background,
    borderLeftColor: color.border,
    borderLeftStyle: 'solid',
    borderLeftWidth: '1px',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    minWidth: 0,
  },
  scroll: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingBottom: space.lg,
    paddingInline: space.lg,
    rowGap: space.md,
    scrollPaddingTop: '260px',
  },
  preview: {
    backgroundColor: color.background,
    flexShrink: 0,
    paddingBottom: space.xs,
    position: 'sticky',
    top: 0,
    zIndex: 1,
  },
  title: {
    color: color.text,
    fontSize: font.sizeLg,
    fontWeight: font.weightBold,
    margin: 0,
    minWidth: 0,
  },
  facts: {
    columnGap: space.sm,
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    margin: 0,
    rowGap: '2px',
  },
  fact: { display: 'contents' },
  factLabel: { color: color.textMuted },
  factValue: { color: color.text, margin: 0 },
  target: { color: color.textMuted, fontSize: font.sizeSm, margin: 0, marginBottom: '6px' },
});

function targetLabel(detail: Detail): string {
  const when = formatDate(detail.selected.receivedAt);
  if (detail.source === 'unidentified') return `Actions apply to this export, received ${when}.`;
  return detail.revisions[0]?.id === detail.selected.id
    ? `Actions apply to the latest revision, ${when}.`
    : `Actions apply to the older revision from ${when}.`;
}

export function DetailPane({
  detail,
  actions,
  titleRef,
  onSelectRevision,
}: {
  readonly detail: Detail;
  readonly actions: UseRevisionActions;
  readonly titleRef: Ref<HTMLHeadingElement>;
  readonly onSelectRevision: (id: RevisionId) => void;
}) {
  const [viewerFor, setViewerFor] = useState<RevisionId | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  // Main can move the selection while the viewer is open. Closing beats showing a stale image.
  if (viewerFor !== null && viewerFor !== detail.selected.id) setViewerFor(null);
  const preview = detail.selected.preview;
  const viewing = viewerFor === detail.selected.id && preview !== null;
  const wasViewing = useRef(false);
  useEffect(() => {
    // Unmounting an open dialog, as a new revision does, drops focus to the body.
    if (wasViewing.current && !viewing && document.activeElement === document.body) {
      opener.current?.focus();
    }
    wasViewing.current = viewing;
  }, [viewing]);

  return (
    <aside {...stylex.props(styles.pane)} aria-label="Export details">
      <DragStrip />
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.preview)}>
          <PreviewImage
            revision={detail.selected}
            alt={`Preview of ${detail.title}`}
            size="large"
            openerRef={opener}
            onOpen={() => setViewerFor(detail.selected.id)}
          />
        </div>
        <h2 ref={titleRef} tabIndex={-1} {...stylex.props(styles.title, shared.focusRing)}>
          <Truncate text={detail.title} />
        </h2>
        <dl {...stylex.props(styles.facts)}>
          {detail.facts.map((fact) => (
            <div key={fact.label} {...stylex.props(styles.fact)}>
              <dt {...stylex.props(styles.factLabel)}>{fact.label}</dt>
              <Truncate as="dd" text={fact.value} style={[styles.factValue, shared.selectable]} />
            </div>
          ))}
        </dl>
        <div>
          <p {...stylex.props(styles.target)}>{targetLabel(detail)}</p>
          <ActionBar detail={detail} actions={actions} />
        </div>
        {detail.source === 'project' && (
          <RevisionHistory
            revisions={detail.revisions}
            selectedId={detail.selected.id}
            onSelect={onSelectRevision}
          />
        )}
      </div>
      {viewing && (
        <ImageViewer src={preview.url} title={detail.title} onClose={() => setViewerFor(null)} />
      )}
    </aside>
  );
}
