import { describe, expect, it } from 'vite-plus/test';
import type { RawExport, SandboxToUi } from '../shared/messages.ts';
import { exportNode } from './export-node.ts';
import { createFakeFigma, type FakeFigma, type FakeFigmaOptions } from './testing/fake-figma.ts';
import { handleUiMessage } from './ui-messages.ts';

const postedOf = (fake: FakeFigma) => fake.posted as SandboxToUi[];

describe('file identity', () => {
  const exportWith = async (options: FakeFigmaOptions) => {
    const fake = createFakeFigma(options);
    return exportNode(fake.figma, fake.node('RECTANGLE'));
  };

  it('sends a real key and the file name', async () => {
    const raw = await exportWith({ fileKey: 'REALKEY', fileName: 'My File' });
    expect(raw).toMatchObject({ fileKey: 'REALKEY', fileName: 'My File' });
  });

  it.each<[string, FakeFigmaOptions]>([
    ['undefined', { fileKey: undefined, fileName: 'My File' }],
    ['empty', { fileKey: '', fileName: 'My File' }],
    ['a throwing read', { fileKey: new Error('private API off'), fileName: 'My File' }],
    ['undefined in an unnamed file', { fileKey: undefined, fileName: '' }],
  ])('omits fileKey on %s, never substituting a name or "current"', async (_label, options) => {
    const raw = await exportWith(options);
    expect(raw).not.toHaveProperty('fileKey');
    expect(raw.fileName).toBe(options.fileName);
  });

  it('carries the target’s id and name, and an ISO timestamp', async () => {
    const fake = createFakeFigma();
    const raw = await exportNode(fake.figma, fake.node('FRAME', { id: '7:7', name: 'Hero' }));
    expect(raw).toMatchObject({ nodeId: '7:7', nodeName: 'Hero' });
    expect(new Date(raw.exportedAt ?? '').toISOString()).toBe(raw.exportedAt);
  });

  it('shortens a long nodeName on the wire and keeps the full name in the tree', async () => {
    const name = `${'x'.repeat(1023)}😀 and more text`;
    const fake = createFakeFigma();
    const raw = await exportNode(fake.figma, fake.node('TEXT', { name }));
    expect(raw.nodeName).toBe('x'.repeat(1023));
    expect(raw.node.name).toBe(name);
  });

  it('adds none of the fields the plugin never sends', async () => {
    const fake = createFakeFigma();
    const raw = await exportNode(fake.figma, fake.node('RECTANGLE'));
    for (const key of ['outputDir', 'folderName', 'batchId', 'contractVersion']) {
      expect(raw).not.toHaveProperty(key);
    }
  });
});

describe('selection message', () => {
  const selectionAfterReady = async (fake: FakeFigma) => {
    await handleUiMessage(fake.figma, { type: 'ui-ready' });
    return postedOf(fake).at(-1);
  };

  it('reports targets and hasFileKey', async () => {
    const fake = createFakeFigma({ fileKey: 'K' });
    fake.select([fake.node('FRAME', { id: '1:1', name: 'A' })]);
    expect(await selectionAfterReady(fake)).toEqual({
      type: 'selection',
      targets: [{ id: '1:1', name: 'A', type: 'FRAME' }],
      hasFileKey: true,
    });
  });

  it('reports an empty selection', async () => {
    const fake = createFakeFigma({ fileKey: 'K' });
    expect(await selectionAfterReady(fake)).toMatchObject({ targets: [] });
  });

  it.each<[string, FakeFigmaOptions]>([
    ['undefined', { fileKey: undefined }],
    ['empty', { fileKey: '' }],
    ['a throw', { fileKey: new Error('no') }],
  ])('has no file key on %s', async (_label, options) => {
    const fake = createFakeFigma(options);
    expect(await selectionAfterReady(fake)).toMatchObject({ hasFileKey: false });
  });

  it('drops nodes with a selected ancestor at any depth and keeps Figma’s order', async () => {
    const fake = createFakeFigma();
    const deep = fake.node('RECTANGLE', { id: '1:3' });
    const middle = fake.node('FRAME', { id: '1:2', children: [deep] });
    const top = fake.node('FRAME', { id: '1:1', children: [middle] });
    const other = fake.node('TEXT', { id: '2:1' });
    const sibling = fake.node('ELLIPSE', { id: '3:1' });
    fake.select([other, deep, top, sibling]);

    const message = await selectionAfterReady(fake);

    expect(message).toMatchObject({
      targets: [{ id: '2:1' }, { id: '1:1' }, { id: '3:1' }],
    });
  });

  it('keeps a selected child of an unselected parent', async () => {
    const fake = createFakeFigma();
    const child = fake.node('RECTANGLE', { id: '1:2' });
    fake.node('FRAME', { id: '1:1', children: [child] });
    fake.select([child]);
    expect(await selectionAfterReady(fake)).toMatchObject({ targets: [{ id: '1:2' }] });
  });
});

describe('export-node replies', () => {
  it('replies once with node-exported, bytes intact', async () => {
    const fake = createFakeFigma();
    const node = fake.node('RECTANGLE', { id: '1:1' });

    await handleUiMessage(fake.figma, { type: 'export-node', nodeId: '1:1' });

    expect(fake.posted).toHaveLength(1);
    const reply = postedOf(fake)[0] as { type: string; nodeId: string; raw: RawExport };
    expect(reply).toMatchObject({ type: 'node-exported', nodeId: node.id });
    expect(reply.raw.pngBytes).toBeInstanceOf(Uint8Array);
  });

  it('replies once with node-failed when the node vanished', async () => {
    const fake = createFakeFigma();
    const node = fake.node('RECTANGLE', { id: '1:1' });
    fake.remove(node);

    await handleUiMessage(fake.figma, { type: 'export-node', nodeId: '1:1' });

    expect(fake.posted).toEqual([
      {
        type: 'node-failed',
        nodeId: '1:1',
        message: expect.stringContaining('no longer exists'),
      },
    ]);
  });

  it('replies once with node-failed when the lookup rejects', async () => {
    const fake = createFakeFigma();
    fake.breakLookup('1:1');

    await handleUiMessage(fake.figma, { type: 'export-node', nodeId: '1:1' });

    expect(fake.posted).toEqual([
      { type: 'node-failed', nodeId: '1:1', message: 'Cannot resolve 1:1' },
    ]);
  });

  it('replies once with node-failed when the export throws', async () => {
    const fake = createFakeFigma();
    fake.node('FRAME', { id: '1:1', throwing: ['findAllWithCriteria'] });

    await handleUiMessage(fake.figma, { type: 'export-node', nodeId: '1:1' });

    expect(fake.posted).toEqual([
      { type: 'node-failed', nodeId: '1:1', message: 'Cannot read findAllWithCriteria' },
    ]);
  });

  it('replies once with node-failed when the export cannot cross to the UI', async () => {
    const fake = createFakeFigma();
    fake.node('RECTANGLE', { id: '1:1', fills: [{ type: 'SOLID', color: fake.mixed }] });

    await handleUiMessage(fake.figma, { type: 'export-node', nodeId: '1:1' });

    expect(fake.posted).toEqual([
      { type: 'node-failed', nodeId: '1:1', message: expect.any(String) },
    ]);
  });
});
