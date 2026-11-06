import { describe, expect, it } from 'vite-plus/test';
import { exportNode } from './export-node.ts';
import { createFakeFigma } from './testing/fake-figma.ts';

const SVG = new TextEncoder().encode('<svg/>');
const PNG = new Uint8Array([0x89, 0x50]);

describe('previews', () => {
  it('sends both, from default SVG settings and PNG scale 2', async () => {
    const fake = createFakeFigma();
    const node = fake.node('RECTANGLE', { id: '1:1', renders: { SVG, PNG } });

    const raw = await exportNode(fake.figma, node);

    expect(raw.svgBytes).toEqual(SVG);
    expect(raw.pngBytes).toEqual(PNG);
    expect(fake.exportCalls).toEqual([
      { nodeId: '1:1', settings: { format: 'SVG' } },
      { nodeId: '1:1', settings: { format: 'PNG', constraint: { type: 'SCALE', value: 2 } } },
    ]);
    expect(raw.summary).toMatchObject({ preview: { svg: true, png: true, svgSkipped: false } });
  });

  it.each([
    [2048, { type: 'SCALE', value: 2 }],
    [2049, { type: 'WIDTH', value: 2048 }],
  ])('constrains a %i wide PNG with %j', async (width, constraint) => {
    const fake = createFakeFigma();
    await exportNode(fake.figma, fake.node('RECTANGLE', { width }));
    expect(fake.exportCalls.at(-1)?.settings).toEqual({ format: 'PNG', constraint });
  });

  it('exports SVG at exactly 6000 nodes', async () => {
    const fake = createFakeFigma();
    const children = Array.from({ length: 5999 }, () => fake.node('RECTANGLE'));
    const raw = await exportNode(fake.figma, fake.node('FRAME', { children }));
    expect(raw.svgBytes).toBeDefined();
    expect(raw.summary).toMatchObject({ preview: { svg: true, png: true, svgSkipped: false } });
  });

  it('skips SVG above 6000 nodes and still sends PNG', async () => {
    const fake = createFakeFigma();
    const children = Array.from({ length: 6000 }, () => fake.node('RECTANGLE'));
    const root = fake.node('FRAME', { id: 'root:1', children });

    const raw = await exportNode(fake.figma, root);

    expect(raw).not.toHaveProperty('svgBytes');
    expect(raw.pngBytes).toBeDefined();
    expect(raw.summary).toMatchObject({ preview: { svg: false, png: true, svgSkipped: true } });
    expect(fake.exportCalls.map((call) => call.settings.format)).toEqual(['PNG']);
  });

  it('survives an SVG failure', async () => {
    const fake = createFakeFigma();
    const raw = await exportNode(
      fake.figma,
      fake.node('RECTANGLE', { renders: { SVG: new Error('svg failed') } }),
    );
    expect(raw).not.toHaveProperty('svgBytes');
    expect(raw.pngBytes).toBeDefined();
    expect(raw.summary).toMatchObject({ preview: { svg: false, png: true, svgSkipped: false } });
  });

  it('survives a PNG failure', async () => {
    const fake = createFakeFigma();
    const raw = await exportNode(
      fake.figma,
      fake.node('RECTANGLE', { renders: { PNG: new Error('png failed') } }),
    );
    expect(raw).not.toHaveProperty('pngBytes');
    expect(raw.svgBytes).toBeDefined();
    expect(raw.summary).toMatchObject({ preview: { svg: true, png: false, svgSkipped: false } });
  });

  it('still produces an export when both fail', async () => {
    const fake = createFakeFigma();
    const failing = { SVG: new Error('svg'), PNG: new Error('png') };
    const raw = await exportNode(fake.figma, fake.node('RECTANGLE', { renders: failing }));
    expect(raw.node).toMatchObject({ type: 'RECTANGLE' });
    expect(raw.summary).toMatchObject({ preview: { svg: false, png: false, svgSkipped: false } });
  });

  it('runs neither preview for a node with no exportAsync', async () => {
    const fake = createFakeFigma();
    const raw = await exportNode(fake.figma, fake.figma.root);
    expect(raw).not.toHaveProperty('svgBytes');
    expect(raw).not.toHaveProperty('pngBytes');
    expect(raw.summary).toMatchObject({ preview: { svg: false, png: false, svgSkipped: false } });
  });
});

describe('summary', () => {
  it('describes the target and tree, with exactly the always-present fields', async () => {
    const fake = createFakeFigma();
    const root = fake.node('FRAME', {
      id: '1:1',
      name: 'Card',
      children: [
        fake.node('TEXT', { characters: 'One' }),
        fake.node('TEXT', { characters: 'Two' }),
        fake.node('FRAME', { children: [fake.node('RECTANGLE')] }),
      ],
    });

    const { summary } = await exportNode(fake.figma, root);

    expect(summary).toEqual({
      target: { id: '1:1', name: 'Card', type: 'FRAME' },
      totalNodes: 5,
      nodeTypes: { FRAME: 2, TEXT: 2, RECTANGLE: 1 },
      textLayerCount: 2,
      textSamples: ['One', 'Two'],
      components: { total: 0, local: 0, remote: 0 },
      sets: [],
      remoteMastersResolved: 0,
      remoteMasterErrors: [],
      truncated: false,
      truncatedAt: null,
      preview: { svg: true, png: true, svgSkipped: false },
    });
  });

  it('reports zero text layers when there are none', async () => {
    const fake = createFakeFigma();
    const { summary } = await exportNode(fake.figma, fake.node('RECTANGLE'));
    expect(summary).toMatchObject({ textLayerCount: 0, textSamples: [] });
  });

  it('trims, collapses, skips empties, caps at 15, and cuts long samples at 60', async () => {
    const fake = createFakeFigma();
    const long = 'x'.repeat(61);
    const exactly60 = 'y'.repeat(60);
    const texts = [
      '  spaced \n\t out  ',
      '   ',
      '',
      long,
      exactly60,
      ...Array.from({ length: 20 }, (_, index) => `t${index}`),
    ];
    const root = fake.node('FRAME', {
      children: texts.map((characters) => fake.node('TEXT', { characters })),
    });

    const { summary } = await exportNode(fake.figma, root);

    expect(summary).toMatchObject({
      textLayerCount: texts.length,
      textSamples: [
        'spaced out',
        `${'x'.repeat(60)}…`,
        exactly60,
        ...Array.from({ length: 12 }, (_, index) => `t${index}`),
      ],
    });
  });

  it('counts local and remote components, and omits local sets from sets', async () => {
    const fake = createFakeFigma();
    const localSet = fake.node('COMPONENT_SET', {
      name: 'Local',
      children: [fake.node('COMPONENT', { name: 'A=1' })],
    });
    const remote = fake.node('COMPONENT', { name: 'Remote', key: 'r', remote: true });
    fake.publish(remote);

    const { summary } = await exportNode(
      fake.figma,
      fake.node('FRAME', { children: [localSet, fake.node('INSTANCE', { main: remote })] }),
    );

    expect(summary).toMatchObject({ components: { total: 3, local: 2, remote: 1 }, sets: [] });
  });

  it('keeps sets unique by name', async () => {
    const fake = createFakeFigma();
    const variants = ['a', 'b'].map((key) => {
      const variant = fake.node('COMPONENT', { name: `On=${key}`, key, remote: true });
      fake.publish(variant);
      return variant;
    });
    fake.node('COMPONENT_SET', {
      name: 'Twin',
      key: 's1',
      remote: true,
      children: variants.slice(0, 1),
    });
    fake.node('COMPONENT_SET', {
      name: 'Twin',
      key: 's2',
      remote: true,
      children: variants.slice(1),
    });

    const { summary, remoteMasters } = await exportNode(
      fake.figma,
      fake.node('FRAME', {
        children: variants.map((main) => fake.node('INSTANCE', { main })),
      }),
    );

    expect(remoteMasters).toHaveLength(2);
    expect(summary).toMatchObject({ sets: [{ name: 'Twin', axes: { On: ['a'] } }] });
    expect((summary?.sets as unknown[]).length).toBe(1);
  });
});
