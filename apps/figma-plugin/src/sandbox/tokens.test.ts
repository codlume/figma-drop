import { describe, expect, it } from 'vite-plus/test';
import { exportNode } from './export-node.ts';
import { createFakeFigma, type FakeFigma } from './testing/fake-figma.ts';

const MODES = [
  { modeId: '1:0', name: 'Light' },
  { modeId: '1:1', name: 'Dark' },
];
const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id });

function addTheme(fake: FakeFigma) {
  fake.addCollection({ id: 'C:1', name: 'Theme', key: 'ck', modes: MODES });
}

const tokenNames = (raw: Awaited<ReturnType<typeof exportNode>>) =>
  (raw.variables?.tokens as { name: string }[]).map((token) => token.name);
const firstToken = (raw: Awaited<ReturnType<typeof exportNode>>) =>
  (raw.variables?.tokens as Record<string, unknown>[])[0];

describe('variables', () => {
  it('is omitted when no id was found at all', async () => {
    const fake = createFakeFigma();
    fake.addCollection({ id: 'C:0', name: 'Empty', modes: MODES });
    const raw = await exportNode(fake.figma, fake.node('RECTANGLE'));
    expect(raw).not.toHaveProperty('variables');
    expect(raw.summary).not.toHaveProperty('variables');
  });

  it('includes every local variable, used or not, with every token and collection field', async () => {
    const fake = createFakeFigma();
    addTheme(fake);
    fake.addVariable({
      id: 'V:1',
      name: 'space/md',
      key: 'vk',
      resolvedType: 'FLOAT',
      description: 'Medium',
      variableCollectionId: 'C:1',
      scopes: ['GAP'],
      valuesByMode: { '1:0': 16, '1:1': 16 },
    });

    const raw = await exportNode(fake.figma, fake.node('RECTANGLE'));

    expect(raw.variables).toEqual({
      collections: [
        {
          id: 'C:1',
          name: 'Theme',
          key: 'ck',
          remote: false,
          defaultModeId: '1:0',
          modes: MODES,
        },
      ],
      tokens: [
        {
          id: 'V:1',
          name: 'space/md',
          key: 'vk',
          remote: false,
          resolvedType: 'FLOAT',
          description: 'Medium',
          collectionId: 'C:1',
          collectionName: 'Theme',
          scopes: ['GAP'],
          valuesByMode: { Light: 16, Dark: 16 },
        },
      ],
    });
    expect(raw.summary).toMatchObject({ variables: { collections: 1, tokens: 1 } });
  });

  it('nulls an empty key, keeps an empty description, and omits non-array scopes', async () => {
    const fake = createFakeFigma();
    addTheme(fake);
    fake.addVariable({
      id: 'V:1',
      name: 'a',
      resolvedType: 'STRING',
      variableCollectionId: 'C:1',
      scopes: undefined,
      valuesByMode: { '1:0': 'x' },
    });

    const token = firstToken(await exportNode(fake.figma, fake.node('RECTANGLE')));

    expect(token).toMatchObject({ key: null, description: '' });
    expect(token).not.toHaveProperty('scopes');
  });

  it('finds aliases anywhere in the node, not just in boundVariables', async () => {
    const fake = createFakeFigma();
    fake.addCollection({ id: 'C:9', name: 'Library', modes: MODES, remote: true });
    for (const id of ['V:bound', 'V:paint', 'V:effect']) {
      fake.addVariable({
        id,
        name: id,
        remote: true,
        resolvedType: 'FLOAT',
        variableCollectionId: 'C:9',
        valuesByMode: { '1:0': 1 },
      });
    }
    fake.addVariable({
      id: 'V:unused',
      name: 'unused',
      remote: true,
      resolvedType: 'FLOAT',
      variableCollectionId: 'C:9',
      valuesByMode: { '1:0': 1 },
    });
    const rectangle = fake.node('RECTANGLE', {
      boundVariables: { width: alias('V:bound') },
      fills: [{ type: 'SOLID', boundVariables: { color: alias('V:paint') } }],
      effects: [{ type: 'DROP_SHADOW', boundVariables: { radius: alias('V:effect') } }],
    });

    const raw = await exportNode(fake.figma, rectangle);

    expect(tokenNames(raw).sort()).toEqual(['V:bound', 'V:effect', 'V:paint']);
  });

  it('finds aliases in remote masters and in styles', async () => {
    const fake = createFakeFigma();
    fake.addCollection({ id: 'C:9', name: 'Library', modes: MODES, remote: true });
    for (const id of ['V:master', 'V:style']) {
      fake.addVariable({
        id,
        name: id,
        remote: true,
        resolvedType: 'FLOAT',
        variableCollectionId: 'C:9',
        valuesByMode: { '1:0': 1 },
      });
    }
    fake.addStyle({
      id: 'S:1,',
      name: 'Bound',
      type: 'PAINT',
      paints: [],
      boundVariables: { paints: [alias('V:style')] },
    });
    const master = fake.node('COMPONENT', {
      key: 'rk',
      remote: true,
      boundVariables: { width: alias('V:master') },
    });
    fake.publish(master);

    const raw = await exportNode(fake.figma, fake.node('INSTANCE', { main: master }));

    expect(tokenNames(raw).sort()).toEqual(['V:master', 'V:style']);
  });

  it('follows aliases transitively and names the target', async () => {
    const fake = createFakeFigma();
    fake.addCollection({ id: 'C:9', name: 'Library', modes: MODES, remote: true });
    const remote = { remote: true, variableCollectionId: 'C:9', resolvedType: 'COLOR' } as const;
    fake.addVariable({
      ...remote,
      id: 'V:a',
      name: 'a',
      valuesByMode: { '1:0': alias('V:b') },
    });
    fake.addVariable({
      ...remote,
      id: 'V:b',
      name: 'b',
      valuesByMode: { '1:0': alias('V:c') },
    });
    fake.addVariable({
      ...remote,
      id: 'V:c',
      name: 'c',
      valuesByMode: { '1:0': { r: 0, g: 0, b: 0 } },
    });

    const raw = await exportNode(
      fake.figma,
      fake.node('RECTANGLE', { boundVariables: { width: alias('V:a') } }),
    );

    expect(tokenNames(raw)).toEqual(['a', 'b', 'c']);
    expect(firstToken(raw)?.valuesByMode).toEqual({ Light: { alias: 'V:b', name: 'b' } });
  });

  it('gives a null name to an alias whose target cannot resolve, and skips the target', async () => {
    const fake = createFakeFigma();
    addTheme(fake);
    fake.addVariable({
      id: 'V:a',
      name: 'a',
      resolvedType: 'COLOR',
      variableCollectionId: 'C:1',
      valuesByMode: { '1:0': alias('V:missing'), '1:1': alias('V:broken') },
    });
    fake.breakLookup('V:broken');

    const raw = await exportNode(fake.figma, fake.node('RECTANGLE'));

    expect(tokenNames(raw)).toEqual(['a']);
    expect(firstToken(raw)?.valuesByMode).toEqual({
      Light: { alias: 'V:missing', name: null },
      Dark: { alias: 'V:broken', name: null },
    });
  });

  it('terminates on an alias cycle', async () => {
    const fake = createFakeFigma();
    addTheme(fake);
    const shared = { resolvedType: 'FLOAT', variableCollectionId: 'C:1' } as const;
    fake.addVariable({ ...shared, id: 'V:a', name: 'a', valuesByMode: { '1:0': alias('V:b') } });
    fake.addVariable({ ...shared, id: 'V:b', name: 'b', valuesByMode: { '1:0': alias('V:a') } });

    expect(tokenNames(await exportNode(fake.figma, fake.node('RECTANGLE')))).toEqual(['a', 'b']);
  });

  it('is present with empty arrays when every found id fails', async () => {
    const fake = createFakeFigma();
    const raw = await exportNode(
      fake.figma,
      fake.node('RECTANGLE', { boundVariables: { width: alias('V:gone') } }),
    );
    expect(raw.variables).toEqual({ collections: [], tokens: [] });
    expect(raw.summary).toMatchObject({ variables: { collections: 0, tokens: 0 } });
  });

  it('falls back to mode ids and an empty collection name when the collection is unavailable', async () => {
    const fake = createFakeFigma();
    fake.addVariable({
      id: 'V:a',
      name: 'a',
      remote: true,
      resolvedType: 'FLOAT',
      variableCollectionId: 'C:gone',
      valuesByMode: { '7:0': 4 },
    });

    const raw = await exportNode(
      fake.figma,
      fake.node('RECTANGLE', { boundVariables: { width: alias('V:a') } }),
    );

    expect(raw.variables?.collections).toEqual([]);
    expect(firstToken(raw)).toMatchObject({ collectionName: '', valuesByMode: { '7:0': 4 } });
  });

  it('falls back to the mode id when the collection does not know the mode', async () => {
    const fake = createFakeFigma();
    addTheme(fake);
    fake.addVariable({
      id: 'V:a',
      name: 'a',
      resolvedType: 'FLOAT',
      variableCollectionId: 'C:1',
      valuesByMode: { '1:0': 1, '9:9': 2 },
    });

    const token = firstToken(await exportNode(fake.figma, fake.node('RECTANGLE')));

    expect(token?.valuesByMode).toEqual({ Light: 1, '9:9': 2 });
  });

  it('lets the later of two same-named modes win', async () => {
    const fake = createFakeFigma();
    fake.addCollection({
      id: 'C:1',
      name: 'Twins',
      modes: [
        { modeId: '1:0', name: 'Same' },
        { modeId: '1:1', name: 'Same' },
      ],
    });
    fake.addVariable({
      id: 'V:a',
      name: 'a',
      resolvedType: 'FLOAT',
      variableCollectionId: 'C:1',
      valuesByMode: { '1:0': 1, '1:1': 2 },
    });

    const token = firstToken(await exportNode(fake.figma, fake.node('RECTANGLE')));

    expect(token?.valuesByMode).toEqual({ Same: 2 });
  });

  it.each([
    [{ r: 1, g: 1, b: 1 }, '#ffffff', 1],
    [{ r: 1, g: 1, b: 1, a: 1 }, '#ffffff', 1],
    [{ r: 0.2, g: 0.4, b: 0.8, a: 0.5 }, '#3366cc80', 0.5],
    [{ r: 0, g: 0.5, b: 0.004, a: 0 }, '#00800100', 0],
    [{ r: 1.5, g: -0.5, b: 0 }, '#ff0000', 1],
  ])('renders color %j as %s', async (color, hex, a) => {
    const fake = createFakeFigma();
    addTheme(fake);
    fake.addVariable({
      id: 'V:a',
      name: 'a',
      resolvedType: 'COLOR',
      variableCollectionId: 'C:1',
      valuesByMode: { '1:0': color },
    });

    const token = firstToken(await exportNode(fake.figma, fake.node('RECTANGLE')));

    expect(token?.valuesByMode).toEqual({
      Light: { hex, rgba: { r: color.r, g: color.g, b: color.b, a } },
    });
  });

  it('leaves number, string and boolean values unchanged', async () => {
    const fake = createFakeFigma();
    addTheme(fake);
    const shared = { variableCollectionId: 'C:1' };
    fake.addVariable({
      ...shared,
      id: 'V:s',
      name: 's',
      resolvedType: 'STRING',
      valuesByMode: { '1:0': 'hello' },
    });
    fake.addVariable({
      ...shared,
      id: 'V:b',
      name: 'b',
      resolvedType: 'BOOLEAN',
      valuesByMode: { '1:0': false },
    });

    const raw = await exportNode(fake.figma, fake.node('RECTANGLE'));

    expect(raw.variables?.tokens).toMatchObject([
      { valuesByMode: { Light: 'hello' } },
      { valuesByMode: { Light: false } },
    ]);
  });
});

describe('styles', () => {
  const stylesOf = (raw: Awaited<ReturnType<typeof exportNode>>) =>
    raw.styles?.styles as Record<string, unknown>[];

  it('is omitted when the list is empty', async () => {
    const fake = createFakeFigma();
    const raw = await exportNode(fake.figma, fake.node('RECTANGLE'));
    expect(raw).not.toHaveProperty('styles');
    expect(raw.summary).not.toHaveProperty('styles');
  });

  it('lists local styles file-wide with each type’s own field', async () => {
    const fake = createFakeFigma();
    const paints = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    const effects = [{ type: 'LAYER_BLUR', radius: 4 }];
    const layoutGrids = [{ pattern: 'GRID', sectionSize: 8 }];
    const text = {
      fontName: { family: 'Inter', style: 'Bold' },
      fontSize: 18,
      letterSpacing: { value: 0, unit: 'PIXELS' },
      lineHeight: { value: 24, unit: 'PIXELS' },
      paragraphIndent: 0,
      paragraphSpacing: 2,
      textCase: 'ORIGINAL',
      textDecoration: 'NONE',
    };
    fake.addStyle({
      id: 'S:p,',
      name: 'Paint',
      key: 'pk',
      description: 'D',
      type: 'PAINT',
      paints,
    });
    fake.addStyle({ id: 'S:t,', name: 'Text', type: 'TEXT', ...text, extraneous: true });
    fake.addStyle({ id: 'S:e,', name: 'Effect', type: 'EFFECT', effects });
    fake.addStyle({ id: 'S:g,', name: 'Grid', type: 'GRID', layoutGrids });

    const raw = await exportNode(fake.figma, fake.node('RECTANGLE'));

    expect(stylesOf(raw)).toEqual([
      {
        id: 'S:p,',
        key: 'pk',
        name: 'Paint',
        remote: false,
        description: 'D',
        type: 'PAINT',
        paints,
      },
      {
        id: 'S:t,',
        key: null,
        name: 'Text',
        remote: false,
        description: '',
        type: 'TEXT',
        text,
      },
      {
        id: 'S:e,',
        key: null,
        name: 'Effect',
        remote: false,
        description: '',
        type: 'EFFECT',
        effects,
      },
      {
        id: 'S:g,',
        key: null,
        name: 'Grid',
        remote: false,
        description: '',
        type: 'GRID',
        layoutGrids,
      },
    ]);
    expect(raw.summary).toMatchObject({ styles: { paint: 1, text: 1, effect: 1, grid: 1 } });
  });

  it('keeps boundVariables only when non-empty', async () => {
    const fake = createFakeFigma();
    const boundVariables = { paints: [alias('V:x')] };
    fake.addStyle({ id: 'S:a,', name: 'A', type: 'PAINT', paints: [], boundVariables });
    fake.addStyle({ id: 'S:b,', name: 'B', type: 'PAINT', paints: [] });

    const raw = await exportNode(fake.figma, fake.node('RECTANGLE'));

    expect(stylesOf(raw)[0]?.boundVariables).toEqual(boundVariables);
    expect(stylesOf(raw)[1]).not.toHaveProperty('boundVariables');
  });

  it('resolves referenced remote styles, from nodes, runs and masters, once each', async () => {
    const fake = createFakeFigma();
    for (const id of ['S:node,', 'S:run,', 'S:master,', 'S:unused,']) {
      fake.addStyle({ id, name: id, type: 'PAINT', remote: true, paints: [] });
    }
    const master = fake.node('COMPONENT', { key: 'rk', remote: true, fillStyleId: 'S:master,' });
    fake.publish(master);
    const root = fake.node('FRAME', {
      fillStyleId: 'S:node,',
      children: [
        fake.node('RECTANGLE', { strokeStyleId: 'S:node,' }),
        fake.node('TEXT', {
          textStyleId: fake.mixed,
          segments: [{ characters: 'a', start: 0, end: 1, fillStyleId: 'S:run,' }],
        }),
        fake.node('INSTANCE', { main: master }),
      ],
    });

    const raw = await exportNode(fake.figma, root);

    expect(stylesOf(raw).map((style) => style.id)).toEqual(['S:node,', 'S:run,', 'S:master,']);
  });

  it('never looks up "MIXED" as a style id', async () => {
    const fake = createFakeFigma();
    fake.addStyle({ id: 'MIXED', name: 'Trap', type: 'PAINT', remote: true, paints: [] });
    const raw = await exportNode(fake.figma, fake.node('TEXT', { textStyleId: fake.mixed }));
    expect(raw).not.toHaveProperty('styles');
  });

  it('skips a referenced style that fails or resolves to null', async () => {
    const fake = createFakeFigma();
    fake.addStyle({ id: 'S:ok,', name: 'Ok', type: 'PAINT', remote: true, paints: [] });
    fake.addStyle({ id: 'S:bad,', name: 'Bad', type: 'PAINT', remote: true, paints: [] });
    fake.breakLookup('S:bad,');
    const root = fake.node('RECTANGLE', {
      fillStyleId: 'S:ok,',
      strokeStyleId: 'S:bad,',
      effectStyleId: 'S:none,',
    });

    const raw = await exportNode(fake.figma, root);

    expect(stylesOf(raw).map((style) => style.id)).toEqual(['S:ok,']);
    expect(raw.node).toMatchObject({ strokeStyleId: 'S:bad,', effectStyleId: 'S:none,' });
  });
});
