import type {
  ExportNode,
  ExportNodeId,
  FocusTarget,
  LibrarySnapshot,
  Project,
  ProjectId,
  Revision,
  RevisionId,
  UnidentifiedEntry,
} from './bridge.ts';

export type ReadySnapshot = Extract<LibrarySnapshot, { state: 'ready' }>;

export type Selection =
  | {
      readonly area: 'project';
      readonly projectId: ProjectId;
      readonly nodeId: ExportNodeId | null;
      readonly revisionId: RevisionId | null;
    }
  | { readonly area: 'unidentified'; readonly entryId: RevisionId | null };

export type ProjectRow = {
  readonly id: ProjectId;
  readonly name: string;
  readonly keyHint: string | null;
  readonly nodeCount: number;
};

export type Fact = { readonly label: string; readonly value: string };

export type Detail = {
  readonly source: 'project' | 'unidentified';
  readonly title: string;
  readonly facts: readonly Fact[];
  readonly revisions: readonly Revision[];
  readonly selected: Revision;
};

export type NodeCard = {
  readonly id: ExportNodeId;
  readonly name: string;
  readonly latest: Revision;
  readonly revisionCount: number;
};

export type EntryCard = {
  readonly id: RevisionId;
  readonly name: string;
  readonly claim: string;
  readonly latest: Revision;
};

export type LibraryMain =
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'project';
      readonly project: ProjectRow;
      readonly fileKey: string;
      readonly nodes: readonly NodeCard[];
      readonly selectedNodeId: ExportNodeId | null;
      readonly detail: Detail | null;
    }
  | {
      readonly kind: 'unidentified';
      readonly entries: readonly EntryCard[];
      readonly selectedEntryId: RevisionId | null;
      readonly detail: Detail | null;
    };

export type LibraryView = {
  readonly projects: readonly ProjectRow[];
  readonly selectedProjectId: ProjectId | null;
  readonly unidentifiedCount: number;
  // What is on screen, by id. Lists arrive newest first, so "the first one" moves with every export.
  readonly selection: Selection | null;
  readonly main: LibraryMain;
};

type ShownNode = { readonly node: ExportNode; readonly latest: Revision };

const orUnknown = (value: string) => value || 'Unknown';

// Figma documents no key shape, so same-named files can share any length of prefix.
function keyHint(project: Project, sameName: readonly Project[]): string | null {
  const key = project.fileKey;
  if (!key || sameName.length < 2) return null;
  let length = 8;
  const collides = (other: Project) =>
    other !== project && other.fileKey.slice(0, length) === key.slice(0, length);
  while (length < key.length && sameName.some(collides)) length += 1;
  return key.slice(0, length);
}

function projectRows(projects: readonly Project[]): readonly ProjectRow[] {
  const byName = Map.groupBy(projects, (project) => project.fileName);
  return projects.map((project) => ({
    id: project.id,
    name: project.fileName,
    keyHint: keyHint(project, byName.get(project.fileName) ?? []),
    nodeCount: project.nodes.length,
  }));
}

function shownNodes(project: Project): readonly ShownNode[] {
  return project.nodes.flatMap((node) => {
    const latest = node.revisions[0];
    return latest ? [{ node, latest }] : [];
  });
}

function projectDetail(
  project: Project,
  { node, latest }: ShownNode,
  revisionId: RevisionId | null,
): Detail {
  return {
    source: 'project',
    title: node.name,
    facts: [
      { label: 'Figma file', value: project.fileName },
      { label: 'File key', value: orUnknown(project.fileKey) },
      { label: 'Node', value: orUnknown(node.figmaNodeId) },
    ],
    revisions: node.revisions,
    selected: node.revisions.find((r) => r.id === revisionId) ?? latest,
  };
}

function entryDetail(entry: UnidentifiedEntry): Detail {
  return {
    source: 'unidentified',
    title: entry.name,
    facts: [
      // `||` because the `"current"` fallback sends an empty file name.
      { label: 'Claimed file', value: entry.claimedName || 'None sent' },
      { label: 'Claimed key', value: entry.claimedKey ?? 'None sent' },
      { label: 'Node', value: orUnknown(entry.figmaNodeId) },
    ],
    revisions: [entry],
    selected: entry,
  };
}

function entryCard(entry: UnidentifiedEntry): EntryCard {
  return {
    id: entry.id,
    name: entry.name,
    claim: entry.claimedName || 'No file name sent',
    latest: entry,
  };
}

export function resolveView(snapshot: ReadySnapshot, selection: Selection | null): LibraryView {
  const { projects, unidentified } = snapshot;
  const rows = projectRows(projects);
  const base = { projects: rows, unidentifiedCount: unidentified.length };

  const hasExports = projects.length + unidentified.length > 0;
  const showUnidentified = hasExports && (selection?.area === 'unidentified' || !projects.length);
  if (showUnidentified) {
    const entryId = selection?.area === 'unidentified' ? selection.entryId : null;
    const entry = unidentified.find((e) => e.id === entryId) ?? unidentified[0];
    return {
      ...base,
      selectedProjectId: null,
      selection: { area: 'unidentified', entryId: entry?.id ?? null },
      main: {
        kind: 'unidentified',
        entries: unidentified.map(entryCard),
        selectedEntryId: entry?.id ?? null,
        detail: entry ? entryDetail(entry) : null,
      },
    };
  }

  const wanted = selection?.area === 'project' ? selection : null;
  const project = projects.find((p) => p.id === wanted?.projectId) ?? projects[0];
  const row = rows.find((r) => r.id === project?.id);
  if (!project || !row) {
    return { ...base, selectedProjectId: null, selection: null, main: { kind: 'empty' } };
  }

  const shown = shownNodes(project);
  const selected = shown.find(({ node }) => node.id === wanted?.nodeId) ?? shown[0];
  const detail = selected ? projectDetail(project, selected, wanted?.revisionId ?? null) : null;
  // An unpicked revision stays null, so the detail follows the node's latest.
  const pickedRevision = detail?.revisions.some((r) => r.id === wanted?.revisionId);
  return {
    ...base,
    selectedProjectId: project.id,
    selection: {
      area: 'project',
      projectId: project.id,
      nodeId: selected?.node.id ?? null,
      revisionId: pickedRevision ? (wanted?.revisionId ?? null) : null,
    },
    main: {
      kind: 'project',
      project: row,
      fileKey: project.fileKey,
      nodes: shown.map(({ node, latest }) => ({
        id: node.id,
        name: node.name,
        latest,
        revisionCount: node.revisions.length,
      })),
      selectedNodeId: selected?.node.id ?? null,
      detail,
    },
  };
}

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.area === 'unidentified') return b.area === 'unidentified' && a.entryId === b.entryId;
  return (
    b.area === 'project' &&
    a.projectId === b.projectId &&
    a.nodeId === b.nodeId &&
    a.revisionId === b.revisionId
  );
}

export function selectionForFocus(snapshot: ReadySnapshot, target: FocusTarget): Selection | null {
  if (target.kind === 'project') {
    const project = snapshot.projects.find((p) => p.id === target.projectId);
    return project
      ? { area: 'project', projectId: project.id, nodeId: null, revisionId: null }
      : null;
  }

  const { revisionId } = target;
  for (const project of snapshot.projects) {
    const node = project.nodes.find((n) => n.revisions.some((r) => r.id === revisionId));
    if (node) return { area: 'project', projectId: project.id, nodeId: node.id, revisionId };
  }
  return snapshot.unidentified.some((e) => e.id === revisionId)
    ? { area: 'unidentified', entryId: revisionId }
    : null;
}
