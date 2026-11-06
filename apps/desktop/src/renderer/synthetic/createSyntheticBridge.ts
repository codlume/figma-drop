import type {
  CommandError,
  CommandResult,
  CopyToFolderResult,
  FigmaDropApi,
  FocusTarget,
  LibrarySnapshot,
  ReceiverStatus,
  Revision,
  RevisionId,
} from '../bridge.ts';
import type { ReadySnapshot } from '../libraryView.ts';
import {
  emptyLibrary,
  populatedLibrary,
  syntheticName,
  syntheticNode,
  previews,
  syntheticProject,
  syntheticRevision,
} from './fixtures.ts';

export const scenarioNames = [
  'populated',
  'empty',
  'loading',
  'unreadable',
  'library-unavailable',
  'snapshot-rejects',
  'receiver-off',
  'port-conflict',
  'receiver-failed',
  'receiver-stop-failed',
  'receiver-unavailable',
  'receiver-absent',
  'actions-fail',
  'actions-reject',
] as const;

export type ScenarioName = (typeof scenarioNames)[number];

export type SyntheticOptions = {
  readonly scenario?: ScenarioName;
  readonly latencyMs?: number;
  readonly copyCancelled?: boolean;
  readonly trashAlreadyGone?: boolean;
};

export type SyntheticControl = {
  pushExport(target?: 'project' | 'unidentified'): RevisionId;
  focusExport(target: FocusTarget): void;
  setScenario(name: ScenarioName): void;
  recover(): void;
};

export type SyntheticBridge = {
  readonly bridge: FigmaDropApi;
  readonly control: SyntheticControl;
};

type Scenario = {
  readonly seed: ReadySnapshot;
  readonly snapshot: (library: ReadySnapshot) => Promise<LibrarySnapshot>;
  readonly status: ReceiverStatus;
  readonly statusWhenOn: ReceiverStatus;
  readonly receiverReachable: boolean;
  readonly commands: 'succeed' | 'fail' | 'reject';
};

const listening: ReceiverStatus = { state: 'listening', port: 3579 };
const portConflict: ReceiverStatus = {
  state: 'port-conflict',
  port: 3579,
  holder: { pid: 4242, command: 'synthetic-other-app' },
};
const receiverFailed: ReceiverStatus = {
  state: 'failed',
  message: 'Synthetic: the receiver stopped unexpectedly.',
  enabled: true,
};
const receiverStopFailed: ReceiverStatus = {
  state: 'failed',
  message: 'Synthetic: could not stop the receiver.',
  enabled: false,
};
const receiverAbsent: ReceiverStatus = {
  state: 'unavailable',
  message: 'Synthetic: this build has no receiver.',
};

const notReady =
  (state: 'unreadable' | 'unavailable', message: string) => (): Promise<LibrarySnapshot> =>
    Promise.resolve({ state, message, projects: [], unidentified: [] });

const populated: Scenario = {
  seed: populatedLibrary,
  snapshot: (library) => Promise.resolve(library),
  status: listening,
  statusWhenOn: listening,
  receiverReachable: true,
  commands: 'succeed',
};

const scenarios: Record<ScenarioName, Scenario> = {
  populated,
  empty: { ...populated, seed: emptyLibrary },
  loading: { ...populated, snapshot: () => new Promise(() => {}) },
  unreadable: {
    ...populated,
    snapshot: notReady('unreadable', 'Synthetic: the library folder could not be read.'),
  },
  'library-unavailable': {
    ...populated,
    snapshot: notReady('unavailable', 'Synthetic: the library is not open.'),
  },
  'snapshot-rejects': {
    ...populated,
    snapshot: () => Promise.reject(new Error('Synthetic snapshot rejection')),
  },
  'receiver-off': { ...populated, status: { state: 'off' } },
  'port-conflict': { ...populated, status: portConflict, statusWhenOn: portConflict },
  'receiver-failed': { ...populated, status: receiverFailed, statusWhenOn: receiverFailed },
  'receiver-stop-failed': { ...populated, status: receiverStopFailed },
  'receiver-unavailable': { ...populated, receiverReachable: false },
  'receiver-absent': { ...populated, status: receiverAbsent, statusWhenOn: receiverAbsent },
  'actions-fail': { ...populated, commands: 'fail' },
  'actions-reject': { ...populated, commands: 'reject' },
};

const succeeded: CommandResult = { ok: true };
const commandFailed: CommandError = {
  ok: false,
  code: 'failed',
  message: 'Synthetic: the command failed.',
};
const notFound: CommandError = {
  ok: false,
  code: 'not-found',
  message: 'Synthetic: that revision is gone.',
};
const copyDamaged: CommandError = {
  ok: false,
  code: 'damaged',
  message: 'Synthetic: a damaged revision cannot be copied.',
};

const allRevisions = (library: ReadySnapshot): readonly Revision[] => [
  ...library.projects.flatMap((project) => project.nodes.flatMap((node) => node.revisions)),
  ...library.unidentified,
];

function withoutRevision(library: ReadySnapshot, id: RevisionId): ReadySnapshot {
  return {
    ...library,
    projects: library.projects.flatMap((project) => {
      const nodes = project.nodes.flatMap((node) => {
        const revisions = node.revisions.filter((revision) => revision.id !== id);
        return revisions.length > 0 ? [{ ...node, revisions }] : [];
      });
      return nodes.length > 0 ? [{ ...project, nodes }] : [];
    }),
    unidentified: library.unidentified.filter((entry) => entry.id !== id),
  };
}

const incomingProject = syntheticProject(
  'incoming',
  syntheticName('Incoming exports'),
  'i9-incoming-synthetic',
  [syntheticNode('incoming', syntheticName('Pushed node'), '90:1', [])],
);

function withIncomingRevision(library: ReadySnapshot, revision: Revision): ReadySnapshot {
  const current = library.projects.find((p) => p.id === incomingProject.id) ?? incomingProject;
  const updated = {
    ...current,
    updatedAt: revision.receivedAt,
    nodes: current.nodes.map((node) => ({ ...node, revisions: [revision, ...node.revisions] })),
  };
  return {
    ...library,
    projects: [updated, ...library.projects.filter((p) => p.id !== updated.id)],
  };
}

export function createSyntheticBridge(options: SyntheticOptions = {}): SyntheticBridge {
  const { latencyMs = 0, copyCancelled = false, trashAlreadyGone = false } = options;
  let scenario = scenarios[options.scenario ?? 'populated'];
  let library = scenario.seed;
  let status = scenario.status;
  let pushed = 0;

  const changeListeners = new Set<() => void>();
  const statusListeners = new Set<(status: ReceiverStatus) => void>();
  const focusListeners = new Set<(target: FocusTarget) => void>();

  const subscribe = <Listener>(listeners: Set<Listener>, listener: Listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const delay = () =>
    latencyMs > 0
      ? new Promise<void>((resolve) => setTimeout(resolve, latencyMs))
      : Promise.resolve();

  const notifyChanged = () => {
    for (const listener of changeListeners) listener();
  };

  const publishStatus = (next: ReceiverStatus) => {
    status = next;
    for (const listener of statusListeners) listener(next);
  };

  async function command<Result>(
    id: RevisionId,
    succeed: (revision: Revision) => Result,
  ): Promise<Result | CommandError> {
    await delay();
    if (scenario.commands === 'reject') throw new Error('Synthetic command rejection');
    if (scenario.commands === 'fail') return commandFailed;
    const revision = allRevisions(library).find((candidate) => candidate.id === id);
    return revision ? succeed(revision) : notFound;
  }

  const bridge: FigmaDropApi = {
    library: {
      async getSnapshot() {
        await delay();
        return scenario.snapshot(library);
      },
      onChanged: (listener) => subscribe(changeListeners, listener),
      reveal: (id) => command(id, () => succeeded),
      copyPath: (id) => command(id, () => succeeded),
      copyToFolder: (id) =>
        command<CopyToFolderResult>(id, (revision) => {
          if (revision.state === 'damaged') return copyDamaged;
          if (copyCancelled) return { ok: true, status: 'cancelled' };
          return { ok: true, status: 'copied', path: `/synthetic/copies/${revision.id}` };
        }),
      trash: (id) =>
        command(id, () => {
          library = withoutRevision(library, id);
          if (trashAlreadyGone) return notFound;
          notifyChanged();
          return succeeded;
        }),
    },
    receiver: {
      async getStatus() {
        await delay();
        if (!scenario.receiverReachable) throw new Error('Synthetic status rejection');
        return status;
      },
      onStatus: (listener) => subscribe(statusListeners, listener),
      async setEnabled(enabled) {
        await delay();
        if (!scenario.receiverReachable || scenario.commands === 'reject') {
          throw new Error('Synthetic switch rejection');
        }
        publishStatus({ state: enabled ? 'starting' : 'stopping' });
        await delay();
        publishStatus(enabled ? scenario.statusWhenOn : { state: 'off' });
        return status;
      },
    },
    app: {
      onFocusExport: (listener) => subscribe(focusListeners, listener),
    },
  };

  const control: SyntheticControl = {
    pushExport(target = 'project') {
      pushed += 1;
      const revision = syntheticRevision(`pushed-${pushed}`, 1000 + pushed, previews.pushed);
      library =
        target === 'project'
          ? withIncomingRevision(library, revision)
          : {
              ...library,
              unidentified: [
                {
                  ...revision,
                  claimedName: syntheticName('Pushed file'),
                  claimedKey: null,
                  figmaNodeId: `91:${pushed}`,
                  name: syntheticName(`Pushed entry ${pushed}`),
                },
                ...library.unidentified,
              ],
            };
      notifyChanged();
      return revision.id;
    },
    focusExport(target) {
      for (const listener of focusListeners) listener(target);
    },
    setScenario(name) {
      scenario = scenarios[name];
      library = scenario.seed;
      if (scenario.receiverReachable) publishStatus(scenario.status);
      notifyChanged();
    },
    recover() {
      scenario = populated;
    },
  };

  return { bridge, control };
}
