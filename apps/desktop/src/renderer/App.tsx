import * as stylex from '@stylexjs/stylex';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ActionFeedback } from './ActionBar.tsx';
import { getBridge, type FigmaDropApi, type FocusTarget, type RevisionId } from './bridge.ts';
import { DetailPane } from './DetailPane.tsx';
import { LibraryContent, LoadingContent } from './LibraryContent.tsx';
import {
  resolveView,
  sameSelection,
  selectionForFocus,
  type LibraryView,
  type Selection,
} from './libraryView.ts';
import { ReceiverControl } from './ReceiverControl.tsx';
import { LibraryList, SidebarShell, SidebarSkeleton } from './Sidebar.tsx';
import { StateScreen } from './StateScreen.tsx';
import './style.css';
import { color, font, space } from './tokens.stylex.ts';
import { Button, DragStrip } from './ui.tsx';
import { useLibrary, type LibraryState } from './useLibrary.ts';
import { useReceiver } from './useReceiver.ts';
import { useRevisionActions, type ActionState } from './useRevisionActions.ts';

const NARROW = '@media (max-width: 960px)';

const styles = stylex.create({
  shell: {
    backgroundColor: color.surface,
    color: color.text,
    cursor: 'default',
    display: 'grid',
    fontFamily: font.family,
    fontSize: font.sizeMd,
    gridTemplateColumns: { default: '240px minmax(0, 1fr)', [NARROW]: '224px minmax(0, 1fr)' },
    height: '100%',
    lineHeight: font.lineHeight,
    overflow: 'hidden',
    userSelect: 'none',
  },
  withDetail: {
    gridTemplateColumns: {
      default: '240px minmax(0, 1fr) 360px',
      [NARROW]: '224px minmax(0, 1fr) 280px',
    },
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    minWidth: 0,
    outlineStyle: 'none',
  },
  banner: {
    alignItems: 'center',
    backgroundColor: `color-mix(in srgb, ${color.warning} 12%, transparent)`,
    columnGap: space.sm,
    display: 'flex',
    flexShrink: 0,
    fontSize: font.sizeSm,
    justifyContent: 'space-between',
    marginBottom: space.sm,
    paddingBlock: space.xs,
    paddingInline: space.lg,
  },
  bannerText: { minWidth: 0, overflowWrap: 'anywhere' },
  whole: {
    backgroundColor: color.surface,
    color: color.text,
    display: 'flex',
    flexDirection: 'column',
    fontFamily: font.family,
    fontSize: font.sizeMd,
    height: '100%',
    lineHeight: font.lineHeight,
  },
});

function detailOf(view: LibraryView | null) {
  return view && view.main.kind !== 'empty' ? view.main.detail : null;
}

function useFocusAfterTrash(
  action: ActionState,
  view: LibraryView | null,
  main: RefObject<HTMLElement | null>,
) {
  const handled = useRef<ActionState | null>(null);
  useEffect(() => {
    if (action.kind !== 'done' || action.action !== 'trash') return;
    const fresh = handled.current !== action;
    handled.current = action;
    if (!fresh && document.activeElement !== document.body) return;
    const target =
      main.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]') ?? main.current;
    target?.focus();
  }, [action, view, main]);
}

function usePendingFocus(
  bridge: FigmaDropApi,
  library: LibraryState,
  onResolved: (selection: Selection) => void,
) {
  const [pending, setPending] = useState<FocusTarget | null>(null);
  useEffect(() => bridge.app.onFocusExport(setPending), [bridge]);
  useEffect(() => {
    if (pending === null || library.kind !== 'ready') return;
    const selection = selectionForFocus(library.snapshot, pending);
    if (selection === null) return;
    setPending(null);
    onResolved(selection);
  }, [pending, library, onResolved]);
  return useCallback(() => setPending(null), []);
}

function Library({ bridge }: { readonly bridge: FigmaDropApi }) {
  const library = useLibrary(bridge);
  const receiver = useReceiver(bridge);
  const actions = useRevisionActions(bridge, { onStale: library.refresh });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [titleFocusRequest, setTitleFocusRequest] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const view = useMemo(
    () => (library.state.kind === 'ready' ? resolveView(library.state.snapshot, selection) : null),
    [library.state, selection],
  );
  const detail = detailOf(view);
  if (view && !sameSelection(selection, view.selection)) setSelection(view.selection);

  const { dismiss } = actions;
  const applyFocus = useCallback(
    (next: Selection) => {
      setSelection(next);
      dismiss();
      setTitleFocusRequest((count) => count + 1);
    },
    [dismiss],
  );
  const clearPendingFocus = usePendingFocus(bridge, library.state, applyFocus);
  useFocusAfterTrash(actions.state, view, mainRef);
  useEffect(() => {
    if (titleFocusRequest > 0) titleRef.current?.focus();
  }, [titleFocusRequest]);

  function select(next: Selection) {
    setSelection(next);
    clearPendingFocus();
    dismiss();
  }

  function selectRevision(revisionId: RevisionId) {
    if (view?.main.kind === 'project' && view.main.selectedNodeId !== null) {
      select({
        area: 'project',
        projectId: view.main.project.id,
        nodeId: view.main.selectedNodeId,
        revisionId,
      });
    }
  }

  function renderList() {
    switch (library.state.kind) {
      case 'loading':
        return <SidebarSkeleton />;
      case 'failed':
        return null;
      case 'ready':
        return (
          view && (
            <LibraryList
              view={view}
              onSelectProject={(projectId) =>
                select({ area: 'project', projectId, nodeId: null, revisionId: null })
              }
              onSelectUnidentified={() => select({ area: 'unidentified', entryId: null })}
            />
          )
        );
    }
  }

  function renderMain() {
    switch (library.state.kind) {
      case 'loading':
        return <LoadingContent />;
      case 'failed':
        return (
          <StateScreen
            role="alert"
            title="Can't open the library"
            actions={<Button onClick={library.retry}>Try again</Button>}
          >
            {library.state.message}
          </StateScreen>
        );
      case 'ready':
        return (
          view && (
            <>
              {library.state.refreshError !== null && (
                <div {...stylex.props(styles.banner)} role="status">
                  <span {...stylex.props(styles.bannerText)}>{library.state.refreshError}</span>
                  <Button onClick={library.refresh}>Try again</Button>
                </div>
              )}
              <LibraryContent
                view={view}
                receiver={receiver}
                onSelectNode={(nodeId) => {
                  if (view.main.kind === 'project') {
                    select({
                      area: 'project',
                      projectId: view.main.project.id,
                      nodeId,
                      revisionId: null,
                    });
                  }
                }}
                onSelectEntry={(entryId) => select({ area: 'unidentified', entryId })}
              />
              {detail === null && (
                <ActionFeedback
                  actions={actions}
                  currentId={null}
                  returnFocus={() => mainRef.current?.focus()}
                  floating
                />
              )}
            </>
          )
        );
    }
  }

  return (
    <div {...stylex.props(styles.shell, detail !== null && styles.withDetail)}>
      <SidebarShell list={renderList()} receiver={<ReceiverControl receiver={receiver} />} />
      <main ref={mainRef} {...stylex.props(styles.main)} aria-label="Exports" tabIndex={-1}>
        <DragStrip />
        {renderMain()}
      </main>
      {detail !== null && (
        <DetailPane
          detail={detail}
          actions={actions}
          titleRef={titleRef}
          onSelectRevision={selectRevision}
        />
      )}
    </div>
  );
}

function Unreachable() {
  return (
    <div {...stylex.props(styles.whole)}>
      <DragStrip />
      <StateScreen
        role="alert"
        title="Can't reach figma-drop"
        actions={<Button onClick={() => window.location.reload()}>Reload</Button>}
      >
        This window lost its connection to the app. Reload it, or quit figma-drop and open it again.
      </StateScreen>
    </div>
  );
}

export function App() {
  const bridge = getBridge();
  return bridge ? <Library bridge={bridge} /> : <Unreachable />;
}
