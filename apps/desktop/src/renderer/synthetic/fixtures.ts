import type {
  ExportNode,
  ExportNodeId,
  Preview,
  Project,
  ProjectId,
  Revision,
  RevisionId,
  UnidentifiedEntry,
} from '../bridge.ts';
import type { ReadySnapshot } from '../libraryView.ts';
import amber from './previews/amber.svg?url&no-inline';
import pushed from './previews/pushed.svg?url&no-inline';
import rose from './previews/rose.svg?url&no-inline';
import scripted from './previews/scripted.svg?url&no-inline';
import teal from './previews/teal.svg?url&no-inline';
import versionA from './previews/version-a.svg?url&no-inline';
import versionB from './previews/version-b.svg?url&no-inline';
import violet from './previews/violet.svg?url&no-inline';

export const mintId = <Id extends string>(value: string) => value as Id;

export const syntheticName = (name: string) => `Synthetic: ${name}`;

const syntheticAt = (minute: number) => new Date(Date.UTC(2026, 0, 1, 9, minute)).toISOString();

// Static files, because the shell's CSP allows same-origin images and refuses `data:`.
const image = (url: string): Preview => ({ url, kind: 'image' });

export const previews = {
  versionA: image(versionA),
  versionB: image(versionB),
  rose: image(rose),
  violet: image(violet),
  teal: image(teal),
  amber: image(amber),
  pushed: image(pushed),
  // Runs only if a preview is ever loaded as a document, which would change the page title.
  scripted: image(scripted),
};

export const syntheticRevision = (
  slug: string,
  minute: number,
  preview: Preview | null,
): Revision => ({
  id: mintId<RevisionId>(`rev-${slug}`),
  receivedAt: syntheticAt(minute),
  preview,
  state: 'ok',
  bundlePath: `/synthetic/library/${slug}`,
});

const damagedRevision = (slug: string, minute: number): Revision => ({
  ...syntheticRevision(slug, minute, null),
  state: 'damaged',
});

export const syntheticNode = (
  slug: string,
  name: string,
  figmaNodeId: string,
  revisions: readonly Revision[],
): ExportNode => ({ id: mintId<ExportNodeId>(`node-${slug}`), figmaNodeId, name, revisions });

export const syntheticProject = (
  slug: string,
  fileName: string,
  fileKey: string,
  nodes: readonly ExportNode[],
): Project => ({
  id: mintId<ProjectId>(`project-${slug}`),
  fileKey,
  fileName,
  nodes,
  updatedAt: nodes[0]?.revisions[0]?.receivedAt ?? syntheticAt(0),
});

const longName = 'A very long file name that keeps going '.repeat(7).trim();

const projects: readonly Project[] = [
  syntheticProject('marketing', syntheticName('Marketing site'), 'c3-marketing-synthetic', [
    syntheticNode('html-only', syntheticName('HTML-only export'), '10:6', [
      syntheticRevision('html-only', 216, null),
    ]),
    syntheticNode('damaged-latest', syntheticName('Damaged latest revision'), '10:5', [
      damagedRevision('damaged-latest-2', 214),
      syntheticRevision('damaged-latest-1', 212, previews.rose),
    ]),
    syntheticNode('scripted', syntheticName('SVG with a script'), '10:4', [
      syntheticRevision('scripted', 210, previews.scripted),
    ]),
    syntheticNode('arrow-upper', syntheticName('Icon/Arrow'), '10:3', [
      syntheticRevision('arrow-upper', 208, previews.violet),
    ]),
    syntheticNode('arrow-lower', syntheticName('icon/arrow'), '10:2', [
      syntheticRevision('arrow-lower', 206, previews.teal),
    ]),
    syntheticNode('hero', syntheticName('Hero banner'), '10:1', [
      syntheticRevision('hero-3', 204, previews.versionA),
      syntheticRevision('hero-2', 202, previews.versionB),
      syntheticRevision('hero-1', 200, previews.versionA),
    ]),
  ]),
  syntheticProject('untitled-a', syntheticName('Untitled'), 'a1-untitled-synthetic', [
    syntheticNode('untitled-a', syntheticName('Frame 1'), '1:2', [
      syntheticRevision('untitled-a', 190, previews.amber),
    ]),
  ]),
  syntheticProject('untitled-b', syntheticName('Untitled'), 'b2-untitled-synthetic', [
    syntheticNode('untitled-b', syntheticName('Frame 1'), '1:2', [
      syntheticRevision('untitled-b', 180, previews.rose),
    ]),
  ]),
  syntheticProject('dots', syntheticName('../../etc/passwd'), 'd4-dots-synthetic', [
    syntheticNode('dots', syntheticName('..'), '2:1', [
      syntheticRevision('dots', 170, previews.violet),
    ]),
  ]),
  syntheticProject(
    'non-ascii',
    syntheticName('Zażółć gęślą jaźń 日本語 مرحبا 🎨'),
    'e5-non-ascii-synthetic',
    [
      syntheticNode('non-ascii', syntheticName('Przycisk główny ボタン'), '3:1', [
        syntheticRevision('non-ascii', 160, previews.teal),
      ]),
    ],
  ),
  syntheticProject('brand-title', syntheticName('Brand kit'), 'f6-brand-synthetic', [
    syntheticNode('brand-title', syntheticName('Logo'), '4:1', [
      syntheticRevision('brand-title', 150, previews.amber),
    ]),
  ]),
  syntheticProject('brand-upper', syntheticName('BRAND KIT'), 'g7-brand-synthetic', [
    syntheticNode('brand-upper', syntheticName('Logo'), '4:1', [
      syntheticRevision('brand-upper', 140, previews.rose),
    ]),
  ]),
  syntheticProject('long', syntheticName(longName), 'h8-long-synthetic', [
    syntheticNode('long', syntheticName(longName), '5:1', [
      syntheticRevision('long', 130, previews.violet),
    ]),
  ]),
  syntheticProject('lost-receipt', 'synthetic-lost-receipt-3fa9c1', '', [
    syntheticNode('lost-receipt', 'synthetic-lost-node-9be204', '', [
      damagedRevision('lost-receipt', 120),
    ]),
  ]),
];

const unidentifiedEntry = (
  revision: Revision,
  claim: Pick<UnidentifiedEntry, 'claimedName' | 'claimedKey' | 'figmaNodeId' | 'name'>,
): UnidentifiedEntry => ({ ...revision, ...claim });

const untitledFallback = syntheticName('Untitled');

const unidentified: readonly UnidentifiedEntry[] = [
  unidentifiedEntry(syntheticRevision('missing-key', 110, previews.teal), {
    claimedName: syntheticName('Offline draft'),
    claimedKey: null,
    figmaNodeId: '20:1',
    name: syntheticName('Missing key'),
  }),
  unidentifiedEntry(syntheticRevision('nothing-sent', 108, null), {
    claimedName: null,
    claimedKey: null,
    figmaNodeId: '',
    name: syntheticName('Nothing claimed, no preview'),
  }),
  // Upstream's literal fallback pairs `"current"` with an empty file name.
  unidentifiedEntry(syntheticRevision('current', 106, previews.amber), {
    claimedName: '',
    claimedKey: 'current',
    figmaNodeId: '20:2',
    name: syntheticName('Literal current key'),
  }),
  unidentifiedEntry(syntheticRevision('key-is-name', 104, previews.rose), {
    claimedName: syntheticName('Checkout flow'),
    claimedKey: syntheticName('Checkout flow'),
    figmaNodeId: '20:3',
    name: syntheticName('Key equals file name'),
  }),
  unidentifiedEntry(syntheticRevision('fallback-1', 102, previews.violet), {
    claimedName: untitledFallback,
    claimedKey: untitledFallback,
    figmaNodeId: '20:4',
    name: syntheticName('Same fallback, first file'),
  }),
  unidentifiedEntry(syntheticRevision('fallback-2', 100, previews.teal), {
    claimedName: untitledFallback,
    claimedKey: untitledFallback,
    figmaNodeId: '20:4',
    name: syntheticName('Same fallback, second file'),
  }),
];

export const populatedLibrary: ReadySnapshot = { state: 'ready', projects, unidentified };

export const emptyLibrary: ReadySnapshot = { state: 'ready', projects: [], unidentified: [] };
