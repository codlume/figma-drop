import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { LibrarySnapshot, ReceiverStatus, Revision, RevisionId } from '../bridge.ts';
import type { ReadySnapshot } from '../libraryView.ts';
import { createSyntheticBridge, type ScenarioName } from './createSyntheticBridge.ts';
import { emptyLibrary, populatedLibrary } from './fixtures.ts';

const { projects, unidentified } = populatedLibrary;

const nodes = projects.flatMap((project) => project.nodes);
const revisions: readonly Revision[] = [
  ...nodes.flatMap((node) => node.revisions),
  ...unidentified,
];

const previewFile = (url: string) =>
  readFileSync(
    join(import.meta.dirname, 'previews', basename(new URL(url, 'file:///').pathname)),
    'utf8',
  );

function nodeNamed(fragment: string) {
  const node = nodes.find((candidate) => candidate.name.includes(fragment));
  if (!node) throw new Error(`no fixture node named ${fragment}`);
  return node;
}

function revisionOf(fragment: string): RevisionId {
  const revision = nodeNamed(fragment).revisions[0];
  if (!revision) throw new Error(`fixture node ${fragment} has no revisions`);
  return revision.id;
}

async function readyLibrary(snapshot: Promise<LibrarySnapshot>): Promise<ReadySnapshot> {
  const library = await snapshot;
  if (library.state !== 'ready') throw new Error(`expected ready, got ${library.state}`);
  return library;
}

const isNewestFirst = (times: readonly string[]) =>
  times.every((time, index) => index === 0 || (times[index - 1] ?? '') >= time);

describe('fixtures', () => {
  it('labels every display name as synthetic', () => {
    const names = [
      ...projects.map((project) => project.fileName),
      ...nodes.map((node) => node.name),
      ...unidentified.map((entry) => entry.name),
      ...unidentified.flatMap((entry) => (entry.claimedName ? [entry.claimedName] : [])),
    ];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/synthetic/i);
  });

  it('watermarks every preview and keeps every path out of the real library', () => {
    for (const revision of revisions) {
      expect(revision.bundlePath).toMatch(/^\/synthetic\//);
      if (!revision.preview) continue;
      expect(revision.preview.url).toMatch(/^\/[^:]*\.svg(\?|$)/);
      expect(previewFile(revision.preview.url)).toContain('SYNTHETIC');
    }
  });

  it('arrives newest first, the order main sends', () => {
    expect(isNewestFirst(projects.map((project) => project.updatedAt))).toBe(true);
    expect(isNewestFirst(unidentified.map((entry) => entry.receivedAt))).toBe(true);
    for (const project of projects) {
      const latest = project.nodes.map((node) => node.revisions[0]?.receivedAt ?? '');
      expect(isNewestFirst(latest)).toBe(true);
      for (const node of project.nodes) {
        expect(isNewestFirst(node.revisions.map((revision) => revision.receivedAt))).toBe(true);
      }
    }
  });

  it('covers the hostile and awkward cases', () => {
    const fileNames = projects.map((project) => project.fileName);
    expect(fileNames.filter((name) => name.endsWith('Untitled'))).toHaveLength(2);
    expect(fileNames.some((name) => name.includes('..'))).toBe(true);
    expect(fileNames.some((name) => /[^\x00-\x7f]/.test(name))).toBe(true);
    expect(fileNames.some((name) => name.length > 200)).toBe(true);
    const lowered = fileNames.map((name) => name.toLowerCase());
    expect(new Set(fileNames).size - new Set(lowered).size).toBeGreaterThan(0);

    const previews = nodeNamed('Hero banner').revisions.map((revision) => revision.preview?.url);
    expect(previews).toHaveLength(3);
    expect(previews[0]).toBe(previews[2]);
    expect(previews[1]).not.toBe(previews[0]);

    const scripted = nodeNamed('SVG with a script').revisions[0]?.preview?.url ?? '';
    expect(previewFile(scripted)).toContain('<script>');
    expect(previewFile(scripted)).toContain('onload=');

    expect(nodeNamed('HTML-only').revisions[0]).toMatchObject({ preview: null, state: 'ok' });
    expect(revisions.filter((revision) => revision.state === 'damaged').length).toBeGreaterThan(1);
    expect(projects.some((project) => project.fileKey === '')).toBe(true);

    expect(unidentified.some((entry) => entry.claimedKey === null)).toBe(true);
    expect(unidentified.some((entry) => entry.claimedKey === 'current')).toBe(true);
    expect(unidentified.some((e) => e.claimedKey !== null && e.claimedKey === e.claimedName)).toBe(
      true,
    );
  });

  it('gives a damaged revision no preview', () => {
    const damaged = revisions.filter((revision) => revision.state === 'damaged');
    for (const revision of damaged) expect(revision.preview).toBeNull();
  });

  it('draws on no clock or randomness', () => {
    const sources = import.meta.glob<string>(['./*.ts', '!./*.test.ts'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    expect(Object.keys(sources).length).toBeGreaterThan(0);
    for (const [path, source] of Object.entries(sources)) {
      expect(source, path).not.toMatch(/Math\.random|Date\.now|new Date\(\)/);
    }
  });
});

describe('scenarios', () => {
  it.each<[ScenarioName, ReadySnapshot]>([
    ['populated', populatedLibrary],
    ['empty', emptyLibrary],
  ])('%s resolves its library', async (scenario, expected) => {
    const { bridge } = createSyntheticBridge({ scenario });
    await expect(bridge.library.getSnapshot()).resolves.toEqual(expected);
  });

  it('loading never settles', async () => {
    const { bridge } = createSyntheticBridge({ scenario: 'loading' });
    const outcome = await Promise.race([bridge.library.getSnapshot(), Promise.resolve('pending')]);
    expect(outcome).toBe('pending');
  });

  it.each<[ScenarioName, LibrarySnapshot['state']]>([
    ['unreadable', 'unreadable'],
    ['library-unavailable', 'unavailable'],
  ])('%s reports its state with a message and no data', async (scenario, state) => {
    const { bridge } = createSyntheticBridge({ scenario });
    await expect(bridge.library.getSnapshot()).resolves.toEqual({
      state,
      message: expect.stringContaining('Synthetic'),
      projects: [],
      unidentified: [],
    });
  });

  it('snapshot-rejects rejects', async () => {
    const { bridge } = createSyntheticBridge({ scenario: 'snapshot-rejects' });
    await expect(bridge.library.getSnapshot()).rejects.toThrow();
  });

  it.each<[ScenarioName, ReceiverStatus['state']]>([
    ['populated', 'listening'],
    ['receiver-off', 'off'],
    ['port-conflict', 'port-conflict'],
    ['receiver-failed', 'failed'],
    ['receiver-stop-failed', 'failed'],
    ['receiver-absent', 'unavailable'],
  ])('%s reports receiver state %s', async (scenario, state) => {
    const { bridge } = createSyntheticBridge({ scenario });
    await expect(bridge.receiver.getStatus()).resolves.toMatchObject({ state });
  });

  it('names who holds a conflicting port', async () => {
    const { bridge } = createSyntheticBridge({ scenario: 'port-conflict' });
    await expect(bridge.receiver.getStatus()).resolves.toMatchObject({
      holder: { pid: expect.any(Number), command: expect.any(String) },
    });
  });

  it('receiver-unavailable rejects status and switching', async () => {
    const { bridge } = createSyntheticBridge({ scenario: 'receiver-unavailable' });
    await expect(bridge.receiver.getStatus()).rejects.toThrow();
    await expect(bridge.receiver.setEnabled(true)).rejects.toThrow();
  });

  it('actions-fail resolves every command with a real failure code', async () => {
    const { library } = createSyntheticBridge({ scenario: 'actions-fail' }).bridge;
    const id = revisionOf('Hero banner');
    const failure = { ok: false, code: 'failed', message: expect.any(String) };
    await expect(library.reveal(id)).resolves.toEqual(failure);
    await expect(library.copyPath(id)).resolves.toEqual(failure);
    await expect(library.copyToFolder(id)).resolves.toEqual(failure);
    await expect(library.trash(id)).resolves.toEqual(failure);
  });

  it('actions-reject rejects every command', async () => {
    const { library, receiver } = createSyntheticBridge({ scenario: 'actions-reject' }).bridge;
    const id = revisionOf('Hero banner');
    await expect(library.reveal(id)).rejects.toThrow();
    await expect(library.copyPath(id)).rejects.toThrow();
    await expect(library.copyToFolder(id)).rejects.toThrow();
    await expect(library.trash(id)).rejects.toThrow();
    await expect(receiver.setEnabled(false)).rejects.toThrow();
  });
});

describe('trash', () => {
  it('removes one revision and keeps the node while others remain', async () => {
    const { bridge } = createSyntheticBridge();
    const onChanged = vi.fn();
    bridge.library.onChanged(onChanged);

    await expect(bridge.library.trash(revisionOf('Hero banner'))).resolves.toEqual({ ok: true });

    const library = await readyLibrary(bridge.library.getSnapshot());
    const hero = library.projects.flatMap((p) => p.nodes).find((n) => n.name.includes('Hero'));
    expect(hero?.revisions).toHaveLength(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('drops the node and the project with their last revision', async () => {
    const { bridge } = createSyntheticBridge();
    const project = projects.find((candidate) => candidate.fileName.includes('BRAND KIT'));
    const id = project?.nodes[0]?.revisions[0]?.id;
    if (!project || !id) throw new Error('no single-revision fixture');

    await bridge.library.trash(id);

    const library = await readyLibrary(bridge.library.getSnapshot());
    expect(library.projects.map((p) => p.id)).not.toContain(project.id);
    expect(library.projects).toHaveLength(projects.length - 1);
  });

  it('removes an Unidentified entry', async () => {
    const { bridge } = createSyntheticBridge();
    const id = unidentified[0]?.id;
    if (!id) throw new Error('no unidentified fixture');

    await bridge.library.trash(id);

    const library = await readyLibrary(bridge.library.getSnapshot());
    expect(library.unidentified.map((entry) => entry.id)).not.toContain(id);
  });

  it('replies not-found the second time', async () => {
    const { bridge } = createSyntheticBridge();
    const id = revisionOf('HTML-only');
    await bridge.library.trash(id);
    await expect(bridge.library.trash(id)).resolves.toMatchObject({ ok: false, code: 'not-found' });
    await expect(bridge.library.reveal(id)).resolves.toMatchObject({
      ok: false,
      code: 'not-found',
    });
  });

  it('trashAlreadyGone replies not-found and only a refetch shows the removal', async () => {
    const { bridge } = createSyntheticBridge({ trashAlreadyGone: true });
    const onChanged = vi.fn();
    bridge.library.onChanged(onChanged);
    const id = revisionOf('HTML-only');

    await expect(bridge.library.trash(id)).resolves.toMatchObject({ ok: false, code: 'not-found' });

    expect(onChanged).not.toHaveBeenCalled();
    const library = await readyLibrary(bridge.library.getSnapshot());
    const ids = library.projects
      .flatMap((p) => p.nodes)
      .flatMap((n) => n.revisions.map((r) => r.id));
    expect(ids).not.toContain(id);
  });
});

describe('commands on a damaged revision', () => {
  const damagedId = revisionOf('Damaged latest');

  it('reveal, copy path, and trash work', async () => {
    const { library } = createSyntheticBridge().bridge;
    await expect(library.reveal(damagedId)).resolves.toEqual({ ok: true });
    await expect(library.copyPath(damagedId)).resolves.toEqual({ ok: true });
    await expect(library.trash(damagedId)).resolves.toEqual({ ok: true });
  });

  it('copy to folder replies damaged', async () => {
    const { library } = createSyntheticBridge().bridge;
    await expect(library.copyToFolder(damagedId)).resolves.toMatchObject({
      ok: false,
      code: 'damaged',
    });
  });
});

describe('copy to folder', () => {
  it('copies to a synthetic path', async () => {
    const { library } = createSyntheticBridge().bridge;
    await expect(library.copyToFolder(revisionOf('Hero banner'))).resolves.toEqual({
      ok: true,
      status: 'copied',
      path: expect.stringMatching(/^\/synthetic\//),
    });
  });

  it('can be cancelled', async () => {
    const { library } = createSyntheticBridge({ copyCancelled: true }).bridge;
    await expect(library.copyToFolder(revisionOf('Hero banner'))).resolves.toEqual({
      ok: true,
      status: 'cancelled',
    });
  });
});

describe('receiver switching', () => {
  function recordStatuses(scenario: ScenarioName) {
    const { bridge } = createSyntheticBridge({ scenario });
    const states: string[] = [];
    bridge.receiver.onStatus((status) => states.push(status.state));
    return { receiver: bridge.receiver, states };
  }

  it('goes through starting to listening', async () => {
    const { receiver, states } = recordStatuses('receiver-off');
    await expect(receiver.setEnabled(true)).resolves.toEqual({ state: 'listening', port: 3579 });
    expect(states).toEqual(['starting', 'listening']);
  });

  it('goes through stopping to off', async () => {
    const { receiver, states } = recordStatuses('populated');
    await expect(receiver.setEnabled(false)).resolves.toEqual({ state: 'off' });
    expect(states).toEqual(['stopping', 'off']);
    await expect(receiver.getStatus()).resolves.toEqual({ state: 'off' });
  });

  it('stays in conflict when turned on', async () => {
    const { receiver, states } = recordStatuses('port-conflict');
    await receiver.setEnabled(true);
    expect(states).toEqual(['starting', 'port-conflict']);
  });
});

describe('control', () => {
  it('pushExport adds a revision to one project, first in the list', async () => {
    const { bridge, control } = createSyntheticBridge({ scenario: 'empty' });
    const onChanged = vi.fn();
    bridge.library.onChanged(onChanged);

    const first = control.pushExport();
    const second = control.pushExport();

    const library = await readyLibrary(bridge.library.getSnapshot());
    expect(library.projects).toHaveLength(1);
    expect(library.projects[0]?.nodes[0]?.revisions.map((r) => r.id)).toEqual([second, first]);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('pushExport can add an Unidentified entry that joins no project', async () => {
    const { bridge, control } = createSyntheticBridge({ scenario: 'empty' });

    const id = control.pushExport('unidentified');

    const library = await readyLibrary(bridge.library.getSnapshot());
    expect(library.projects).toEqual([]);
    expect(library.unidentified.map((entry) => entry.id)).toEqual([id]);
  });

  it('focusExport reaches subscribers until they unsubscribe', () => {
    const { bridge, control } = createSyntheticBridge();
    const listener = vi.fn();
    const unsubscribe = bridge.app.onFocusExport(listener);
    const target = { kind: 'revision', revisionId: revisionOf('Hero banner') } as const;

    control.focusExport(target);
    unsubscribe();
    control.focusExport(target);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(target);
  });

  it('recover lets the next request succeed without a change event', async () => {
    const { bridge, control } = createSyntheticBridge({ scenario: 'unreadable' });
    const onChanged = vi.fn();
    bridge.library.onChanged(onChanged);

    control.recover();

    await expect(bridge.library.getSnapshot()).resolves.toEqual(populatedLibrary);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('setScenario restarts as that scenario and tells listeners', async () => {
    const { bridge, control } = createSyntheticBridge();
    const onChanged = vi.fn();
    const onStatus = vi.fn();
    bridge.library.onChanged(onChanged);
    bridge.receiver.onStatus(onStatus);

    control.setScenario('empty');
    await expect(bridge.library.getSnapshot()).resolves.toEqual(emptyLibrary);
    expect(onChanged).toHaveBeenCalledTimes(1);

    control.setScenario('port-conflict');
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'port-conflict' }));
  });
});

describe('the production entry', () => {
  it('never imports the synthetic adapter', () => {
    const sources = import.meta.glob<string>('../**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const production = Object.entries(sources).filter(
      ([path]) => !path.includes('/synthetic/') && !/\.test\.tsx?$/.test(path),
    );
    expect(production.length).toBeGreaterThan(0);
    for (const [path, source] of production) {
      expect(source, path).not.toMatch(
        /from\s+["'][^"']*synthetic\/|import\(["'][^"']*synthetic\//,
      );
    }
  });
});
