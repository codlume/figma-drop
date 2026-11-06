import { describe, expect, it } from 'vite-plus/test';
import { exportNode } from './export-node.ts';
import type { SerializedNode } from './serialize.ts';
import { createFakeFigma, type FakeNodeType } from './testing/fake-figma.ts';

const CORE = 'absoluteBoundingBox boundVariables height id locked name type visible width x y';
const BLEND = 'blendMode isMask opacity';
const FILL_STROKE = 'fills strokeAlign strokes strokeWeight';
const CHILD_LAYOUT = 'layoutAlign layoutGrow layoutSizingHorizontal layoutSizingVertical rotation';
const CONTAINER_LAYOUT =
  'counterAxisAlignItems counterAxisSizingMode counterAxisSpacing itemSpacing layoutMode ' +
  'layoutWrap paddingBottom paddingLeft paddingRight paddingTop primaryAxisAlignItems ' +
  'primaryAxisSizingMode';
const TEXT =
  'characters fontName fontSize fontWeight letterSpacing lineHeight textAlignHorizontal ' +
  'textAlignVertical textAutoResize textCase textDecoration';
const FRAME =
  `${BLEND} ${FILL_STROKE} effects ${CHILD_LAYOUT} ${CONTAINER_LAYOUT} backgrounds constraints ` +
  'cornerRadius effectStyleId fillStyleId gridStyleId strokeStyleId';
const LINE = `${BLEND} ${FILL_STROKE} effects ${CHILD_LAYOUT} constraints effectStyleId fillStyleId strokeStyleId`;
const SHAPE = `${LINE} cornerRadius`;
const MINIMAL = 'blendMode fillStyleId fills opacity';
const CONNECTOR =
  'blendMode cornerRadius opacity rotation strokeAlign strokeStyleId strokes strokeWeight';

const KEYS_BEYOND_CORE: Record<FakeNodeType, string> = {
  FRAME: `${FRAME} children`,
  COMPONENT: `${FRAME} children componentPropertyDefinitions variantProperties`,
  COMPONENT_SET: `${FRAME} children componentPropertyDefinitions`,
  INSTANCE: `${FRAME} children componentProperties variantProperties`,
  GROUP: `${BLEND} effects ${CHILD_LAYOUT} backgrounds effectStyleId children`,
  SECTION: 'cornerRadius fillStyleId fills strokeAlign strokeStyleId strokes strokeWeight children',
  BOOLEAN_OPERATION: `${BLEND} ${FILL_STROKE} effects ${CHILD_LAYOUT} cornerRadius effectStyleId fillStyleId strokeStyleId children`,
  VECTOR: SHAPE,
  RECTANGLE: SHAPE,
  ELLIPSE: SHAPE,
  POLYGON: SHAPE,
  STAR: SHAPE,
  LINE,
  TEXT: `${LINE} ${TEXT} textStyleId`,
  SLICE: CHILD_LAYOUT,
  STICKY: MINIMAL,
  TABLE: MINIMAL,
  SHAPE_WITH_TEXT: `${CONNECTOR} fillStyleId fills`,
  CONNECTOR,
};

const words = (list: string) => list.split(' ').filter(Boolean);
const sorted = (list: Iterable<string>) => [...list].sort();
const childrenOf = (node: unknown) => (node as SerializedNode).children ?? [];

describe('node key sets', () => {
  const types = Object.keys(KEYS_BEYOND_CORE) as FakeNodeType[];

  it.each(types)('%s carries exactly the keys in the spec table', async (type) => {
    const fake = createFakeFigma();
    const expected = [...words(CORE), ...words(KEYS_BEYOND_CORE[type])];
    const styleIds = expected.filter((key) => key.endsWith('StyleId'));
    const node = fake.node(type, Object.fromEntries(styleIds.map((key) => [key, `S:${key},`])));

    const { node: serialized } = await exportNode(fake.figma, node);

    expect(sorted(Object.keys(serialized))).toEqual(sorted(expected));
  });

  it('never carries properties Figma has but the allowlist leaves out', async () => {
    const fake = createFakeFigma();
    const { node } = await exportNode(
      fake.figma,
      fake.node('COMPONENT', { key: 'k', description: 'd', clipsContent: false }),
    );
    for (const key of [
      'key',
      'description',
      'clipsContent',
      'layoutGrids',
      'layoutPositioning',
      'strokeCap',
      'dashPattern',
      'topLeftRadius',
      'exportSettings',
      'reactions',
      'explicitVariableModes',
      'parent',
      'rectangleCornerRadii',
    ]) {
      expect(node).not.toHaveProperty(key);
    }
  });

  it('leaves vectors without path data and boolean operations without their operation', async () => {
    const fake = createFakeFigma();
    const vector = await exportNode(fake.figma, fake.node('VECTOR'));
    const boolean = await exportNode(fake.figma, fake.node('BOOLEAN_OPERATION'));
    expect(vector.node).not.toHaveProperty('vectorPaths');
    expect(vector.node).not.toHaveProperty('vectorNetwork');
    expect(vector.node).not.toHaveProperty('fillGeometry');
    expect(boolean.node).not.toHaveProperty('booleanOperation');
  });
});

describe('presence rules', () => {
  it('omits a key whose getter throws and keeps the rest', async () => {
    const fake = createFakeFigma();
    const { node } = await exportNode(
      fake.figma,
      fake.node('RECTANGLE', { throwing: ['fills'], opacity: 0.5 }),
    );
    expect(node).not.toHaveProperty('fills');
    expect(node.opacity).toBe(0.5);
  });

  it('omits an undefined value', async () => {
    const fake = createFakeFigma();
    const { node } = await exportNode(fake.figma, fake.node('RECTANGLE', { rotation: undefined }));
    expect(node).not.toHaveProperty('rotation');
  });

  it('replaces figma.mixed with "MIXED"', async () => {
    const fake = createFakeFigma();
    const { node } = await exportNode(
      fake.figma,
      fake.node('TEXT', { fills: fake.mixed, fontSize: fake.mixed }),
    );
    expect(node.fills).toBe('MIXED');
    expect(node.fontSize).toBe('MIXED');
  });

  it('keeps null', async () => {
    const fake = createFakeFigma();
    const { node } = await exportNode(
      fake.figma,
      fake.node('RECTANGLE', { absoluteBoundingBox: null }),
    );
    expect(node.absoluteBoundingBox).toBeNull();
  });

  it('omits an empty style id and keeps a set one', async () => {
    const fake = createFakeFigma();
    const { node } = await exportNode(
      fake.figma,
      fake.node('RECTANGLE', { fillStyleId: '', strokeStyleId: 'S:a,' }),
    );
    expect(node).not.toHaveProperty('fillStyleId');
    expect(node.strokeStyleId).toBe('S:a,');
  });

  it('keeps every other empty value', async () => {
    const fake = createFakeFigma();
    const { node } = await exportNode(
      fake.figma,
      fake.node('TEXT', {
        fills: [],
        boundVariables: {},
        opacity: 0,
        isMask: false,
        characters: '',
      }),
    );
    expect(node).toMatchObject({
      fills: [],
      boundVariables: {},
      opacity: 0,
      isMask: false,
      characters: '',
    });
  });

  it('copies values without rounding or reshaping', async () => {
    const fake = createFakeFigma();
    const fills = [{ type: 'SOLID', visible: false, opacity: 0.25, color: { r: 0.1, g: 0, b: 1 } }];
    const { node } = await exportNode(
      fake.figma,
      fake.node('RECTANGLE', { x: 1.0000001, width: 33.3333333, fills }),
    );
    expect(node).toMatchObject({ x: 1.0000001, width: 33.3333333, fills });
  });
});

describe('recursion', () => {
  it('gives a container an empty children array and a leaf none', async () => {
    const fake = createFakeFigma();
    const frame = await exportNode(fake.figma, fake.node('FRAME'));
    const leaf = await exportNode(fake.figma, fake.node('RECTANGLE'));
    expect(frame.node.children).toEqual([]);
    expect(leaf.node).not.toHaveProperty('children');
  });

  it('keeps child order and serializes instance sublayers', async () => {
    const fake = createFakeFigma();
    const instance = fake.node('INSTANCE', {
      name: 'b',
      main: null,
      children: [fake.node('VECTOR', { id: 'I1;2', name: 'sublayer' })],
    });
    const root = fake.node('FRAME', {
      children: [fake.node('TEXT', { name: 'a' }), instance, fake.node('LINE', { name: 'c' })],
    });

    const { node } = await exportNode(fake.figma, root);

    expect(childrenOf(node).map((child) => child.name)).toEqual(['a', 'b', 'c']);
    expect(childrenOf(childrenOf(node)[1])[0]).toMatchObject({ id: 'I1;2', type: 'VECTOR' });
  });

  it('serializes hidden and locked nodes in full', async () => {
    const fake = createFakeFigma();
    const hidden = fake.node('FRAME', {
      visible: false,
      locked: true,
      children: [fake.node('TEXT', { characters: 'inside' })],
    });

    const { node } = await exportNode(fake.figma, fake.node('FRAME', { children: [hidden] }));

    expect(childrenOf(node)[0]).toMatchObject({ visible: false, locked: true });
    expect(childrenOf(childrenOf(node)[0])[0]).toMatchObject({ characters: 'inside' });
  });
});

describe('node cap', () => {
  it('leaves a tree of exactly 40000 nodes whole', async () => {
    const fake = createFakeFigma();
    const children = Array.from({ length: 39999 }, () => fake.node('RECTANGLE'));

    const raw = await exportNode(fake.figma, fake.node('FRAME', { children }));

    expect(raw.summary).toMatchObject({ totalNodes: 40000, truncated: false, truncatedAt: null });
    expect(childrenOf(raw.node).some((child) => child.truncated)).toBe(false);
  });

  it('stubs every visited node past the cap, and never enters a stub', async () => {
    const fake = createFakeFigma();
    const children = Array.from({ length: 39999 }, () => fake.node('RECTANGLE'));
    const pastCap = fake.node('FRAME', {
      id: '9:1',
      name: 'past',
      children: [fake.node('TEXT', { characters: 'unreached' })],
    });
    const sibling = fake.node('ELLIPSE', { id: '9:2', name: 'pending' });

    const raw = await exportNode(
      fake.figma,
      fake.node('FRAME', { children: [...children, pastCap, sibling] }),
    );

    expect(childrenOf(raw.node).slice(-2)).toEqual([
      { id: '9:1', name: 'past', type: 'FRAME', truncated: true },
      { id: '9:2', name: 'pending', type: 'ELLIPSE', truncated: true },
    ]);
    expect(raw.summary).toMatchObject({
      totalNodes: 40002,
      truncated: true,
      truncatedAt: 40000,
      textLayerCount: 0,
    });
  });

  it('stubs pending siblings in open ancestors after a deep subtree crosses the cap', async () => {
    const fake = createFakeFigma();
    const deep = Array.from({ length: 40000 }, () => fake.node('RECTANGLE'));
    const branch = fake.node('FRAME', { children: deep });
    const pending = fake.node('RECTANGLE', { id: '9:9', name: 'after' });

    const raw = await exportNode(fake.figma, fake.node('GROUP', { children: [branch, pending] }));

    expect(childrenOf(raw.node)[1]).toEqual({
      id: '9:9',
      name: 'after',
      type: 'RECTANGLE',
      truncated: true,
    });
    expect(childrenOf(childrenOf(raw.node)[0]).at(-1)).toMatchObject({ truncated: true });
  });
});

describe('styled text segments', () => {
  const runs = [
    { characters: 'Ada', start: 0, end: 3, textStyleId: 'S:a,' },
    { characters: ' Lovelace', start: 3, end: 12, fillStyleId: 'S:b,' },
    { characters: '!', start: 12, end: 13 },
  ];

  it('appears when textStyleId is mixed, with only non-empty ids per run', async () => {
    const fake = createFakeFigma();
    const { node } = await exportNode(
      fake.figma,
      fake.node('TEXT', { textStyleId: fake.mixed, segments: runs }),
    );
    expect(node.textStyleId).toBe('MIXED');
    expect(node.styledTextSegments).toEqual(runs);
  });

  it('appears when fillStyleId is mixed', async () => {
    const fake = createFakeFigma();
    const { node } = await exportNode(
      fake.figma,
      fake.node('TEXT', { fillStyleId: fake.mixed, segments: runs }),
    );
    expect(node.styledTextSegments).toEqual(runs);
  });

  it('stays out when only another text property is mixed', async () => {
    const fake = createFakeFigma();
    const { node } = await exportNode(
      fake.figma,
      fake.node('TEXT', { fontSize: fake.mixed, segments: runs }),
    );
    expect(node.fontSize).toBe('MIXED');
    expect(node).not.toHaveProperty('styledTextSegments');
  });

  it('stays out when the call throws', async () => {
    const fake = createFakeFigma();
    const { node } = await exportNode(
      fake.figma,
      fake.node('TEXT', { textStyleId: fake.mixed, segments: new Error('no segments') }),
    );
    expect(node).not.toHaveProperty('styledTextSegments');
  });
});

describe('variants', () => {
  const variantValuesOf = async (name: string) => {
    const fake = createFakeFigma();
    const { node } = await exportNode(fake.figma, fake.node('COMPONENT', { name }));
    return node.variantValues;
  };

  it.each([
    ['Style=Primary, Size=md', { Style: 'Primary', Size: 'md' }],
    [' Style = Primary ', { Style: 'Primary' }],
    ['Formula=a=b', { Formula: 'a=b' }],
    ['Style=Primary, =md, Size=, loose', { Style: 'Primary' }],
  ])('parses %j', async (name, expected) => {
    expect(await variantValuesOf(name)).toEqual(expected);
  });

  it.each(['Plain name', '=', 'a=', '=b', ', ,'])(
    'leaves %j without variantValues',
    async (name) => {
      expect(await variantValuesOf(name)).toBeUndefined();
    },
  );

  it('keeps __proto__ as an ordinary axis', async () => {
    const values = await variantValuesOf('__proto__=x');
    expect(Object.keys(values as object)).toEqual(['__proto__']);
  });

  it('builds a set’s variantProperties from direct children, first seen, no duplicates', async () => {
    const fake = createFakeFigma();
    const children = [
      fake.node('COMPONENT', { name: 'Size=md, Tone=warm' }),
      fake.node('COMPONENT', { name: 'Size=lg, Tone=warm' }),
      fake.node('COMPONENT', { name: 'Size=md, Tone=cold' }),
      fake.node('COMPONENT', { name: 'not a variant' }),
    ];

    const { node } = await exportNode(fake.figma, fake.node('COMPONENT_SET', { children }));

    expect(node.variantProperties).toEqual({ Size: ['md', 'lg'], Tone: ['warm', 'cold'] });
    expect(node).not.toHaveProperty('variantGroupProperties');
  });

  it('leaves variantProperties off a set whose children do not parse', async () => {
    const fake = createFakeFigma();
    const { node } = await exportNode(
      fake.figma,
      fake.node('COMPONENT_SET', { children: [fake.node('COMPONENT', { name: 'plain' })] }),
    );
    expect(node).not.toHaveProperty('variantProperties');
  });

  it('omits componentPropertyDefinitions on a variant, where the getter throws', async () => {
    const fake = createFakeFigma();
    const variant = fake.node('COMPONENT', { name: 'Size=md' });
    fake.node('COMPONENT_SET', { children: [variant] });

    const { node } = await exportNode(fake.figma, variant);

    expect(node).not.toHaveProperty('componentPropertyDefinitions');
    expect(node.variantValues).toEqual({ Size: 'md' });
    expect(node.variantProperties).toBeNull();
  });
});

describe('instances', () => {
  it('carries its main component fields and Figma’s property maps', async () => {
    const fake = createFakeFigma();
    const main = fake.node('COMPONENT', { id: '20:1', name: 'Icon/Close', key: 'abc' });
    const componentProperties = { 'Show badge#1:0': { type: 'BOOLEAN', value: false } };

    const { node } = await exportNode(
      fake.figma,
      fake.node('INSTANCE', { main, componentProperties, variantProperties: { Size: 'md' } }),
    );

    expect(node).toMatchObject({
      mainComponentId: '20:1',
      mainComponentName: 'Icon/Close',
      mainComponentKey: 'abc',
      componentProperties,
      variantProperties: { Size: 'md' },
    });
  });

  it.each([
    ['null', null],
    ['a throw', new Error('detached')],
  ])('omits all three main component keys on %s', async (_label, main) => {
    const fake = createFakeFigma();
    const { node } = await exportNode(fake.figma, fake.node('INSTANCE', { main }));
    expect(node).not.toHaveProperty('mainComponentId');
    expect(node).not.toHaveProperty('mainComponentName');
    expect(node).not.toHaveProperty('mainComponentKey');
  });
});
