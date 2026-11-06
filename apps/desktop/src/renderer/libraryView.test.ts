import { describe, expect, it } from 'vite-plus/test';
import type { FocusTarget, Project, UnidentifiedEntry } from './bridge.ts';
import {
  resolveView,
  sameSelection,
  selectionForFocus,
  type LibraryMain,
  type ReadySnapshot,
  type Selection,
} from './libraryView.ts';
import { createSyntheticBridge } from './synthetic/createSyntheticBridge.ts';
import { emptyLibrary, mintId, populatedLibrary } from './synthetic/fixtures.ts';

const { projects, unidentified } = populatedLibrary;

function projectNamed(fragment: string): Project {
  const project = projects.find((candidate) => candidate.fileName.includes(fragment));
  if (!project) throw new Error(`no fixture project named ${fragment}`);
  return project;
}

function nodeNamed(project: Project, fragment: string) {
  const node = project.nodes.find((candidate) => candidate.name.includes(fragment));
  if (!node) throw new Error(`no fixture node named ${fragment}`);
  return node;
}

function entryNamed(fragment: string): UnidentifiedEntry {
  const entry = unidentified.find((candidate) => candidate.name.includes(fragment));
  if (!entry) throw new Error(`no fixture entry named ${fragment}`);
  return entry;
}

function projectMain(main: LibraryMain) {
  if (main.kind !== 'project') throw new Error(`expected a project, got ${main.kind}`);
  return main;
}

function inboxMain(main: LibraryMain) {
  if (main.kind !== 'unidentified') throw new Error(`expected the inbox, got ${main.kind}`);
  return main;
}

const factsOf = (facts: readonly { label: string; value: string }[] = []) =>
  Object.fromEntries(facts.map((fact) => [fact.label, fact.value]));

const marketing = projectNamed('Marketing');
const hero = nodeNamed(marketing, 'Hero banner');

const selectHero = (revisionIndex: number): Selection => ({
  area: 'project',
  projectId: marketing.id,
  nodeId: hero.id,
  revisionId: hero.revisions[revisionIndex]?.id ?? null,
});

const staleProject = mintId<Project['id']>('project-gone');
const staleNode = mintId<Project['nodes'][number]['id']>('node-gone');
const staleRevision = mintId<UnidentifiedEntry['id']>('rev-gone');

describe('resolveView selection', () => {
  it('pins what it fell back to, so a reordered snapshot shows the same node', () => {
    const multi = projects.find((project) => project.nodes.length > 1);
    if (!multi) throw new Error('the fixture needs a project with two nodes');
    const clicked = resolveView(populatedLibrary, {
      area: 'project',
      projectId: multi.id,
      nodeId: null,
      revisionId: null,
    });
    const reordered = {
      ...populatedLibrary,
      projects: projects
        .map((project) =>
          project.id === multi.id ? { ...project, nodes: project.nodes.toReversed() } : project,
        )
        .toReversed(),
    };

    const after = resolveView(reordered, clicked.selection);

    expect(after.selectedProjectId).toBe(multi.id);
    expect(after.selection).toEqual(clicked.selection);
    expect(after.main).toMatchObject({ kind: 'project', selectedNodeId: multi.nodes[0]?.id });
  });

  it('leaves an unpicked revision null so the node keeps following its latest', () => {
    const view = resolveView(populatedLibrary, null);

    expect(view.selection).toMatchObject({ area: 'project', revisionId: null });
  });

  it('drops a revision id that is gone', () => {
    const project = projects[0];
    const node = project?.nodes[0];
    if (!project || !node) throw new Error('the fixture needs a node');

    const view = resolveView(populatedLibrary, {
      area: 'project',
      projectId: project.id,
      nodeId: node.id,
      revisionId: staleRevision,
    });

    expect(view.selection).toMatchObject({ nodeId: node.id, revisionId: null });
  });

  it('lets go of an emptied inbox, so the next project export shows', () => {
    const emptied = resolveView(emptyLibrary, { area: 'unidentified', entryId: null });
    expect(emptied.main.kind).toBe('empty');
    expect(emptied.selection).toBeNull();

    const refilled = resolveView(populatedLibrary, emptied.selection);

    expect(refilled.main.kind).toBe('project');
  });

  it('settles: resolving its own selection changes nothing', () => {
    const first = resolveView(populatedLibrary, null);

    expect(
      sameSelection(first.selection, resolveView(populatedLibrary, first.selection).selection),
    ).toBe(true);
  });
});

describe('resolveView', () => {
  it('keeps the order main sent', () => {
    const reversed = { ...populatedLibrary, projects: projects.toReversed() };

    const view = resolveView(reversed, null);

    expect(view.projects.map((row) => row.id)).toEqual(reversed.projects.map((p) => p.id));
    expect(view.selectedProjectId).toBe(reversed.projects[0]?.id);
  });

  it('shows the empty state for an empty library', () => {
    const view = resolveView(emptyLibrary, null);

    expect(view.main).toEqual({ kind: 'empty' });
    expect(view.selectedProjectId).toBeNull();
  });

  it('opens the first project and its first node with no selection', () => {
    const main = projectMain(resolveView(populatedLibrary, null).main);

    expect(main.project.id).toBe(projects[0]?.id);
    expect(main.selectedNodeId).toBe(projects[0]?.nodes[0]?.id);
    expect(main.detail?.title).toBe(projects[0]?.nodes[0]?.name);
  });

  it('opens the selected revision of the selected node', () => {
    const main = projectMain(resolveView(populatedLibrary, selectHero(1)).main);

    expect(main.selectedNodeId).toBe(hero.id);
    expect(main.detail?.selected.id).toBe(hero.revisions[1]?.id);
    expect(main.detail?.revisions).toHaveLength(3);
  });

  it('falls back to the first node for a stale node id', () => {
    const main = projectMain(
      resolveView(populatedLibrary, {
        area: 'project',
        projectId: marketing.id,
        nodeId: staleNode,
        revisionId: null,
      }).main,
    );

    expect(main.selectedNodeId).toBe(marketing.nodes[0]?.id);
    expect(main.detail).not.toBeNull();
  });

  it('falls back to the latest revision for a stale revision id', () => {
    const main = projectMain(
      resolveView(populatedLibrary, {
        area: 'project',
        projectId: marketing.id,
        nodeId: hero.id,
        revisionId: staleRevision,
      }).main,
    );

    expect(main.selectedNodeId).toBe(hero.id);
    expect(main.detail?.selected.id).toBe(hero.revisions[0]?.id);
  });

  it('falls back to the first project and node for a stale project id', () => {
    const view = resolveView(populatedLibrary, {
      area: 'project',
      projectId: staleProject,
      nodeId: hero.id,
      revisionId: null,
    });

    expect(view.selectedProjectId).toBe(projects[0]?.id);
    expect(projectMain(view.main).detail).not.toBeNull();
  });

  it('falls back after a trash removes the selected node', async () => {
    const { bridge } = createSyntheticBridge();
    const htmlOnly = nodeNamed(marketing, 'HTML-only');
    const id = htmlOnly.revisions[0]?.id;
    if (!id) throw new Error('no fixture revision');
    await bridge.library.trash(id);
    const after = await bridge.library.getSnapshot();
    if (after.state !== 'ready') throw new Error('expected ready');

    const main = projectMain(
      resolveView(after, {
        area: 'project',
        projectId: marketing.id,
        nodeId: htmlOnly.id,
        revisionId: id,
      }).main,
    );

    expect(main.selectedNodeId).not.toBe(htmlOnly.id);
    expect(main.selectedNodeId).toBe(main.nodes[0]?.id);
    expect(main.detail).not.toBeNull();
  });

  it('skips a node with no revisions when it falls back', () => {
    const bare = { ...hero, revisions: [] };
    const library = {
      ...populatedLibrary,
      projects: [{ ...marketing, nodes: [bare, nodeNamed(marketing, 'HTML-only')] }],
    };

    const main = projectMain(resolveView(library, null).main);

    expect(main.nodes).toHaveLength(1);
    expect(main.detail).not.toBeNull();
  });

  it('falls back to the first entry for a stale entry id', () => {
    const main = inboxMain(
      resolveView(populatedLibrary, { area: 'unidentified', entryId: staleRevision }).main,
    );

    expect(main.selectedEntryId).toBe(unidentified[0]?.id);
    expect(main.detail?.selected.id).toBe(unidentified[0]?.id);
  });

  it('has no detail only when the inbox is empty', () => {
    const main = inboxMain(
      resolveView(
        { ...populatedLibrary, unidentified: [] },
        { area: 'unidentified', entryId: null },
      ).main,
    );

    expect(main.entries).toEqual([]);
    expect(main.selectedEntryId).toBeNull();
    expect(main.detail).toBeNull();
  });

  it('shows the inbox when no project remains', () => {
    const view = resolveView(
      { ...populatedLibrary, projects: [] },
      { area: 'project', projectId: marketing.id, nodeId: null, revisionId: null },
    );

    expect(inboxMain(view.main).selectedEntryId).toBe(unidentified[0]?.id);
  });
});

describe('duplicate names', () => {
  it("hints each file's key only when another file shares the name", () => {
    const rows = resolveView(populatedLibrary, null).projects;
    const hints = rows.filter((row) => row.keyHint !== null);

    expect(hints.map((row) => row.keyHint).toSorted()).toEqual(['a1-untit', 'b2-untit']);
    expect(new Set(hints.map((row) => row.name)).size).toBe(1);
  });

  it('does not treat a case-only pair as duplicates', () => {
    const rows = resolveView(populatedLibrary, null).projects;
    const pair = rows.filter((row) => row.name.toLowerCase().endsWith('brand kit'));

    expect(pair).toHaveLength(2);
    expect(pair.map((row) => row.keyHint)).toEqual([null, null]);
  });

  it('lengthens the hint until files sharing a name and a key prefix differ', () => {
    const lost = projectNamed('lost-receipt');
    const library = {
      ...populatedLibrary,
      projects: [
        { ...lost, fileKey: 'sameprefix-a-key' },
        { ...lost, id: staleProject, fileKey: 'sameprefix-b-key' },
      ],
    };

    const rows = resolveView(library, null).projects;

    expect(rows.map((row) => row.keyHint)).toEqual(['sameprefix-a', 'sameprefix-b']);
  });

  it('gives no hint for an empty key, even when names repeat', () => {
    const lost = projectNamed('lost-receipt');
    const library = {
      ...populatedLibrary,
      projects: [lost, { ...lost, id: staleProject }],
    };

    const rows = resolveView(library, null).projects;

    expect(rows.map((row) => row.keyHint)).toEqual([null, null]);
  });
});

describe('placeholders', () => {
  it("shows a damaged project's empty key and node id as Unknown", () => {
    const lost = projectNamed('lost-receipt');

    const main = projectMain(
      resolveView(populatedLibrary, {
        area: 'project',
        projectId: lost.id,
        nodeId: null,
        revisionId: null,
      }).main,
    );

    expect(factsOf(main.detail?.facts)).toEqual({
      'Figma file': lost.fileName,
      'File key': 'Unknown',
      Node: 'Unknown',
    });
    expect(main.detail?.selected.state).toBe('damaged');
  });

  it('shows real ids as they are', () => {
    const main = projectMain(resolveView(populatedLibrary, selectHero(0)).main);

    expect(factsOf(main.detail?.facts)).toMatchObject({
      'File key': marketing.fileKey,
      Node: hero.figmaNodeId,
    });
  });

  it('says what an Unidentified entry never sent', () => {
    const entry = entryNamed('Nothing claimed');

    const main = inboxMain(
      resolveView(populatedLibrary, { area: 'unidentified', entryId: entry.id }).main,
    );

    expect(factsOf(main.detail?.facts)).toEqual({
      'Claimed file': 'None sent',
      'Claimed key': 'None sent',
      Node: 'Unknown',
    });
  });

  it('treats the empty file name of the current fallback as not sent', () => {
    const entry = entryNamed('Literal current');

    const main = inboxMain(
      resolveView(populatedLibrary, { area: 'unidentified', entryId: entry.id }).main,
    );

    expect(factsOf(main.detail?.facts)).toMatchObject({
      'Claimed file': 'None sent',
      'Claimed key': 'current',
    });
    expect(main.entries.find((card) => card.id === entry.id)?.claim).toBe('No file name sent');
  });
});

describe('Unidentified entries', () => {
  it('never appear inside a project', () => {
    const inbox = new Set(unidentified.map((entry) => entry.id));

    for (const project of projects) {
      const main = projectMain(
        resolveView(populatedLibrary, {
          area: 'project',
          projectId: project.id,
          nodeId: null,
          revisionId: null,
        }).main,
      );
      expect(main.nodes.filter((card) => inbox.has(card.latest.id))).toEqual([]);
    }
  });

  it('stay separate even when they claim the same fallback', () => {
    const main = inboxMain(
      resolveView(populatedLibrary, { area: 'unidentified', entryId: null }).main,
    );

    expect(resolveView(populatedLibrary, null).unidentifiedCount).toBe(unidentified.length);
    expect(main.entries).toHaveLength(unidentified.length);
    expect(new Set(main.entries.map((card) => card.id)).size).toBe(unidentified.length);
    expect(main.detail?.source).toBe('unidentified');
    expect(main.detail?.revisions).toHaveLength(1);
  });
});

describe('selectionForFocus', () => {
  const heroRevision = hero.revisions[1]?.id ?? staleRevision;
  const revisionFocus: FocusTarget = { kind: 'revision', revisionId: heroRevision };

  it('finds a revision in a project node', () => {
    expect(selectionForFocus(populatedLibrary, revisionFocus)).toEqual({
      area: 'project',
      projectId: marketing.id,
      nodeId: hero.id,
      revisionId: heroRevision,
    });
  });

  it('finds a revision in the inbox', () => {
    const entry = entryNamed('Missing key');

    expect(selectionForFocus(populatedLibrary, { kind: 'revision', revisionId: entry.id })).toEqual(
      {
        area: 'unidentified',
        entryId: entry.id,
      },
    );
  });

  it('finds a project', () => {
    expect(
      selectionForFocus(populatedLibrary, { kind: 'project', projectId: marketing.id }),
    ).toEqual({
      area: 'project',
      projectId: marketing.id,
      nodeId: null,
      revisionId: null,
    });
  });

  it('returns null for an unknown revision or project', () => {
    expect(
      selectionForFocus(populatedLibrary, { kind: 'revision', revisionId: staleRevision }),
    ).toBeNull();
    expect(
      selectionForFocus(populatedLibrary, { kind: 'project', projectId: staleProject }),
    ).toBeNull();
  });

  it('is null before the refetch lands, then resolves on the next snapshot', async () => {
    const { bridge, control } = createSyntheticBridge({ scenario: 'empty' });
    const read = async (): Promise<ReadySnapshot> => {
      const snapshot = await bridge.library.getSnapshot();
      if (snapshot.state !== 'ready') throw new Error('expected ready');
      return snapshot;
    };
    const before = await read();

    const revisionId = control.pushExport();
    const target: FocusTarget = { kind: 'revision', revisionId };
    expect(selectionForFocus(before, target)).toBeNull();

    const after = await read();
    const selection = selectionForFocus(after, target);
    expect(selection).toMatchObject({ area: 'project', revisionId });

    const main = projectMain(resolveView(after, selection).main);
    expect(main.detail?.selected.id).toBe(revisionId);
  });
});
