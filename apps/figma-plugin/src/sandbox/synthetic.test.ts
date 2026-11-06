import { expect, it } from 'vite-plus/test';
import { exportNode } from './export-node.ts';
import { createFakeFigma } from './testing/fake-figma.ts';

const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id });
const solid = (r: number, g: number, b: number) => ({
  type: 'SOLID',
  visible: true,
  opacity: 1,
  blendMode: 'NORMAL',
  color: { r, g, b },
});
const box = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
  absoluteBoundingBox: { x, y, width, height },
});

const SURFACE_STYLE = 'S:aaaa000000000000000000000000000000000001,';
const LEAD_STYLE = 'S:bbbb000000000000000000000000000000000002,';
const ICON_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f001234567';
const IMAGE_HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function buildProfileCard() {
  const fake = createFakeFigma({
    fileKey: 'SYNTHfixture0000000000',
    fileName: 'Synthetic Fixture',
  });

  fake.addCollection({
    id: 'VariableCollectionId:1:1',
    name: 'Theme',
    key: 'c0ffee0000000000000000000000000000000001',
    modes: [
      { modeId: '1:0', name: 'Light' },
      { modeId: '1:1', name: 'Dark' },
    ],
  });
  const theme = { variableCollectionId: 'VariableCollectionId:1:1' };
  fake.addVariable({
    ...theme,
    id: 'VariableID:1:2',
    name: 'color/surface',
    key: 'c0ffee0000000000000000000000000000000002',
    resolvedType: 'COLOR',
    valuesByMode: { '1:0': { r: 1, g: 1, b: 1, a: 1 }, '1:1': alias('VariableID:1:3') },
  });
  fake.addVariable({
    ...theme,
    id: 'VariableID:1:4',
    name: 'space/md',
    key: 'c0ffee0000000000000000000000000000000003',
    resolvedType: 'FLOAT',
    scopes: ['GAP'],
    valuesByMode: { '1:0': 16, '1:1': 16 },
  });
  fake.addVariable({
    ...theme,
    id: 'VariableID:1:3',
    name: 'color/primary',
    key: 'c0ffee0000000000000000000000000000000004',
    resolvedType: 'COLOR',
    description: 'Brand',
    valuesByMode: {
      '1:0': { r: 0.2, g: 0.4, b: 0.8, a: 0.5 },
      '1:1': { r: 0.2, g: 0.4, b: 0.8, a: 1 },
    },
  });

  fake.addStyle({
    id: SURFACE_STYLE,
    key: 'aaaa000000000000000000000000000000000001',
    name: 'Surface/Card',
    type: 'PAINT',
    paints: [solid(1, 1, 1)],
  });
  fake.addStyle({
    id: LEAD_STYLE,
    key: 'bbbb000000000000000000000000000000000002',
    name: 'Body/Lead',
    type: 'TEXT',
    fontName: { family: 'Inter', style: 'Semi Bold' },
    fontSize: 18,
    lineHeight: { value: 24, unit: 'PIXELS' },
    letterSpacing: { value: 0, unit: 'PIXELS' },
    textCase: 'ORIGINAL',
    textDecoration: 'NONE',
    paragraphSpacing: 0,
    paragraphIndent: 0,
  });

  fake.addImage(IMAGE_HASH, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

  const closeIcon = fake.node('COMPONENT', { id: '20:1', name: 'Icon/Close', key: ICON_KEY });
  const root = fake.node('FRAME', {
    id: '10:1',
    name: 'Profile Card',
    ...box(100, 200, 320, 200),
    fills: [{ ...solid(1, 1, 1), boundVariables: { color: alias('VariableID:1:2') } }],
    boundVariables: {
      fills: [alias('VariableID:1:2')],
      itemSpacing: alias('VariableID:1:4'),
    },
    layoutMode: 'VERTICAL',
    itemSpacing: 16,
    cornerRadius: 12,
    fillStyleId: SURFACE_STYLE,
    children: [
      fake.node('TEXT', {
        id: '10:2',
        name: 'Title',
        ...box(116, 216, 288, 24),
        characters: 'Ada Example',
        textStyleId: fake.mixed,
        segments: [
          { characters: 'Ada', start: 0, end: 3, textStyleId: LEAD_STYLE },
          { characters: ' Example', start: 3, end: 11 },
        ],
      }),
      fake.node('VECTOR', { id: '10:3', name: 'Divider', strokes: [solid(0.8, 0.8, 0.8)] }),
      fake.node('RECTANGLE', {
        id: '10:4',
        name: 'Avatar',
        cornerRadius: 32,
        fills: [{ type: 'IMAGE', visible: true, scaleMode: 'FILL', imageHash: IMAGE_HASH }],
      }),
      fake.node('INSTANCE', {
        id: '10:5',
        name: 'Close',
        main: closeIcon,
        componentProperties: { 'Show badge#1:0': { type: 'BOOLEAN', value: false } },
        children: [fake.node('VECTOR', { id: 'I10:5;20:2', name: 'Glyph' })],
      }),
    ],
  });
  return { fake, root };
}

const keysOf = (value: unknown) => Object.keys(value as object).sort();
const words = (list: string) => list.split(' ').sort();

const SHAPE_KEYS =
  'absoluteBoundingBox blendMode boundVariables constraints cornerRadius effects fills height id ' +
  'isMask layoutAlign layoutGrow layoutSizingHorizontal layoutSizingVertical locked name opacity ' +
  'rotation strokeAlign strokes strokeWeight type visible width x y';
const CONTAINER_KEYS =
  'backgrounds children counterAxisAlignItems counterAxisSizingMode counterAxisSpacing itemSpacing ' +
  'layoutMode layoutWrap paddingBottom paddingLeft paddingRight paddingTop ' +
  'primaryAxisAlignItems primaryAxisSizingMode';
const TEXT_KEYS =
  'absoluteBoundingBox blendMode boundVariables characters constraints effects fills fontName ' +
  'fontSize fontWeight height id isMask layoutAlign layoutGrow layoutSizingHorizontal ' +
  'layoutSizingVertical letterSpacing lineHeight locked name opacity rotation strokeAlign ' +
  'strokes strokeWeight styledTextSegments textAlignHorizontal textAlignVertical ' +
  'textAutoResize textCase textDecoration textStyleId type visible width x y';
const TOKEN_KEYS =
  'collectionId collectionName description id key name remote resolvedType scopes valuesByMode';

it('produces the synthetic payload’s shape for the profile card design', async () => {
  const { fake, root } = buildProfileCard();

  const raw = await exportNode(fake.figma, root);

  expect(keysOf(raw)).toEqual(
    words(
      'components exportedAt fileKey fileName icons images node nodeId nodeName pngBytes ' +
        'remoteMasters styles summary svgBytes variables',
    ),
  );

  const [title, divider, avatar, close] = raw.node.children as Record<string, unknown>[];
  expect(keysOf(raw.node)).toEqual(words(`${SHAPE_KEYS} ${CONTAINER_KEYS} fillStyleId`));
  expect(keysOf(title)).toEqual(words(TEXT_KEYS));
  expect(keysOf(divider)).toEqual(words(SHAPE_KEYS));
  expect(keysOf(avatar)).toEqual(words(SHAPE_KEYS));
  expect(keysOf(close)).toEqual(
    words(
      `${SHAPE_KEYS} ${CONTAINER_KEYS} componentProperties mainComponentId mainComponentKey ` +
        'mainComponentName variantProperties',
    ),
  );
  expect(title).toMatchObject({
    textStyleId: 'MIXED',
    styledTextSegments: [
      { characters: 'Ada', start: 0, end: 3, textStyleId: LEAD_STYLE },
      { characters: ' Example', start: 3, end: 11 },
    ],
  });
  expect(close).toMatchObject({
    variantProperties: null,
    mainComponentId: '20:1',
    mainComponentName: 'Icon/Close',
    mainComponentKey: ICON_KEY,
  });

  expect(raw.components).toEqual([
    {
      id: '20:1',
      name: 'Icon/Close',
      key: ICON_KEY,
      type: 'COMPONENT',
      description: '',
      remote: false,
      componentSetId: null,
    },
  ]);
  expect(raw.remoteMasters).toEqual([]);

  const { collections, tokens } = raw.variables as {
    collections: object[];
    tokens: Record<string, unknown>[];
  };
  expect(collections.map(keysOf)).toEqual([words('defaultModeId id key modes name remote')]);
  expect(tokens.map(keysOf)).toEqual([words(TOKEN_KEYS), words(TOKEN_KEYS), words(TOKEN_KEYS)]);
  expect(tokens.find((token) => token.name === 'color/surface')?.valuesByMode).toEqual({
    Light: { hex: '#ffffff', rgba: { r: 1, g: 1, b: 1, a: 1 } },
    Dark: { alias: 'VariableID:1:3', name: 'color/primary' },
  });
  expect(tokens.find((token) => token.name === 'color/primary')?.valuesByMode).toEqual({
    Light: { hex: '#3366cc80', rgba: { r: 0.2, g: 0.4, b: 0.8, a: 0.5 } },
    Dark: { hex: '#3366cc', rgba: { r: 0.2, g: 0.4, b: 0.8, a: 1 } },
  });

  const styles = raw.styles?.styles as Record<string, unknown>[];
  expect(styles.map(keysOf)).toEqual([
    words('description id key name paints remote type'),
    words('description id key name remote text type'),
  ]);
  expect(keysOf(styles[1]?.text)).toEqual(
    words(
      'fontName fontSize letterSpacing lineHeight paragraphIndent paragraphSpacing textCase ' +
        'textDecoration',
    ),
  );

  expect(raw.icons.map((icon) => icon.name)).toEqual([`Icon-Close.${ICON_KEY}.svg`]);
  expect(raw.images.map(({ imageHash, name }) => ({ imageHash, name }))).toEqual([
    { imageHash: IMAGE_HASH, name: `${IMAGE_HASH}.png` },
  ]);

  expect(raw.summary).toEqual({
    target: { id: '10:1', name: 'Profile Card', type: 'FRAME' },
    totalNodes: 6,
    nodeTypes: { FRAME: 1, TEXT: 1, VECTOR: 2, RECTANGLE: 1, INSTANCE: 1 },
    textLayerCount: 1,
    textSamples: ['Ada Example'],
    components: { total: 1, local: 1, remote: 0 },
    sets: [],
    remoteMastersResolved: 0,
    remoteMasterErrors: [],
    variables: { collections: 1, tokens: 3 },
    styles: { paint: 1, text: 1, effect: 0, grid: 0 },
    imageAssets: 1,
    truncated: false,
    truncatedAt: null,
    preview: { svg: true, png: true, svgSkipped: false },
  });
});
