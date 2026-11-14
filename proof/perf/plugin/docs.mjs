// Deterministic synthetic Figma documents built on the repo's fake Figma.
// Every builder takes the fake factory of the side under test, so both sides
// get the same document from their own copy of the fake.

function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const alias = (id) => ({ type: 'VARIABLE_ALIAS', id });
const hex40 = (n, prefix = '') => (prefix + n.toString(16)).padStart(40, '0');

function bytes(size, signature, random) {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = (random() * 256) | 0;
  out.set(signature);
  return out;
}

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPG = [0xff, 0xd8, 0xff, 0xe0];

function base64(u8) {
  let out = '';
  for (let start = 0; start < u8.length; start += 24576) {
    out += btoa(String.fromCharCode.apply(null, u8.subarray(start, start + 24576)));
  }
  return out;
}

const iconSvg = (name) =>
  new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><!--${name}-->` +
      '<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="#111" stroke-width="2"/>'.repeat(
        6,
      ) +
      '</svg>',
  );

/**
 * @param createFakeFigma the fake factory of the side under test
 * @param spec
 *   cards            number of card instances (22 nodes each)
 *   depth            extra wrapper frames between the root and the rows
 *   iconKinds        distinct icon components
 *   buttonVariants   variants in the Button set
 *   remoteShare      share of button variants that are remote (imported masters)
 *   images           distinct image hashes
 *   imageBytes       bytes per image
 *   paintStyles/textStyles/effectStyles, remoteStyleShare
 *   variables        number of variables (half semantic aliases of primitives)
 *   boundShare       share of nodes that carry bound variables
 *   pngBytes         bytes of the root PNG preview
 *   svgRasters       embedded base64 rasters in the root SVG preview
 *   svgRasterBytes   bytes per embedded raster
 *   nestedInstances  wrap each card in this many extra instance levels
 */
export function buildDocument(createFakeFigma, spec) {
  const {
    cards,
    depth = 0,
    iconKinds = 24,
    buttonVariants = 12,
    remoteShare = 0.5,
    images = 8,
    imageBytes = 64 * 1024,
    paintStyles = 24,
    textStyles = 12,
    effectStyles = 4,
    remoteStyleShare = 0.25,
    variables = 120,
    boundShare = 0.6,
    pngBytes = 512 * 1024,
    svgRasters = 2,
    svgRasterBytes = 32 * 1024,
    nestedInstances = 0,
    seed = 1,
  } = spec;
  const random = prng(seed);
  const pick = (list) => list[(random() * list.length) | 0];
  const fake = createFakeFigma({ fileKey: 'BENCHfile0000000000000', fileName: 'Bench Fixture' });

  const collectionId = 'VariableCollectionId:1:1';
  fake.addCollection({
    id: collectionId,
    name: 'Theme',
    key: hex40(1, 'c0'),
    modes: [
      { modeId: '1:0', name: 'Light' },
      { modeId: '1:1', name: 'Dark' },
      { modeId: '1:2', name: 'High contrast' },
    ],
  });
  const colorIds = [];
  const floatIds = [];
  const primitives = Math.max(1, Math.floor(variables / 2));
  for (let i = 0; i < variables; i += 1) {
    const id = `VariableID:1:${i + 2}`;
    const isFloat = i % 4 === 3;
    const semantic = i >= primitives && !isFloat;
    const color = () => ({ r: random(), g: random(), b: random(), a: random() < 0.2 ? 0.5 : 1 });
    const value = () => {
      if (isFloat) return ((random() * 12) | 0) * 4;
      // A semantic color aliases an earlier primitive color (index % 4 !== 3).
      if (semantic) return alias(`VariableID:1:${(((random() * primitives) | 0) & ~3) + 2}`);
      return color();
    };
    fake.addVariable({
      id,
      name: `${isFloat ? 'space' : semantic ? 'semantic' : 'palette'}/${i}`,
      key: hex40(i + 2, 'c0'),
      resolvedType: isFloat ? 'FLOAT' : 'COLOR',
      variableCollectionId: collectionId,
      valuesByMode: { '1:0': value(), '1:1': value(), '1:2': value() },
      ...(isFloat ? { scopes: ['GAP', 'WIDTH_HEIGHT'] } : {}),
    });
    (isFloat ? floatIds : colorIds).push(id);
  }

  const solid = (bound) => {
    const paint = {
      type: 'SOLID',
      visible: true,
      opacity: 1,
      blendMode: 'NORMAL',
      color: { r: random(), g: random(), b: random() },
    };
    if (bound && colorIds.length > 0) paint.boundVariables = { color: alias(pick(colorIds)) };
    return paint;
  };

  const styleIds = { PAINT: [], TEXT: [], EFFECT: [] };
  const addStyles = (type, count, detail) => {
    for (let i = 0; i < count; i += 1) {
      const key = hex40(styleIds[type].length + 1, type[0].toLowerCase().repeat(2));
      const id = `S:${key},`;
      fake.addStyle({
        id,
        key,
        name: `${type}/${i}`,
        type,
        remote: random() < remoteStyleShare,
        ...detail(),
      });
      styleIds[type].push(id);
    }
  };
  addStyles('PAINT', paintStyles, () => {
    const paint = solid(random() < 0.5);
    return {
      paints: [paint],
      ...(paint.boundVariables ? { boundVariables: { paints: [paint.boundVariables.color] } } : {}),
    };
  });
  addStyles('TEXT', textStyles, () => ({
    fontName: { family: 'Inter', style: pick(['Regular', 'Medium', 'Semi Bold']) },
    fontSize: pick([12, 14, 16, 20, 24]),
    lineHeight: { value: 24, unit: 'PIXELS' },
    letterSpacing: { value: 0, unit: 'PIXELS' },
    textCase: 'ORIGINAL',
    textDecoration: 'NONE',
    paragraphSpacing: 0,
    paragraphIndent: 0,
  }));
  addStyles('EFFECT', effectStyles, () => ({
    effects: [
      {
        type: 'DROP_SHADOW',
        visible: true,
        radius: 8,
        color: { r: 0, g: 0, b: 0, a: 0.2 },
        offset: { x: 0, y: 2 },
        spread: 0,
        blendMode: 'NORMAL',
      },
    ],
  }));

  const imageHashes = [];
  for (let i = 0; i < images; i += 1) {
    const hash = hex40(i + 1, 'ab');
    fake.addImage(hash, bytes(imageBytes, i % 3 === 0 ? JPG : PNG, random));
    imageHashes.push(hash);
  }

  let geometry = 0;
  const box = (width, height) => {
    geometry += 1;
    const x = (geometry * 37) % 1440;
    const y = (geometry * 53) % 4000;
    return { x, y, width, height, absoluteBoundingBox: { x, y, width, height } };
  };
  const bound = (keys) => {
    if (random() >= boundShare || colorIds.length === 0) return {};
    const entries = {};
    for (const key of keys) {
      if (key === 'fills' || key === 'strokes') entries[key] = [alias(pick(colorIds))];
      else if (floatIds.length > 0) entries[key] = alias(pick(floatIds));
    }
    return { boundVariables: entries };
  };
  const paintStyle = () =>
    styleIds.PAINT.length > 0 && random() < 0.5 ? pick(styleIds.PAINT) : '';
  const textStyle = () => (styleIds.TEXT.length > 0 && random() < 0.8 ? pick(styleIds.TEXT) : '');

  const vector = () =>
    fake.node('VECTOR', { name: 'Vector', ...box(16, 16), fills: [solid(random() < boundShare)] });

  const iconMasters = [];
  for (let i = 0; i < iconKinds; i += 1) {
    iconMasters.push(
      fake.node('COMPONENT', {
        name: `Icon/${i}`,
        key: hex40(i + 1, '1c'),
        description: `Icon ${i}`,
        ...box(24, 24),
        children: [fake.node('GROUP', { name: 'Glyph', children: [vector(), vector(), vector()] })],
      }),
    );
  }
  const icon = () => {
    const main = pick(iconMasters);
    return fake.node('INSTANCE', {
      name: main.name,
      main,
      ...box(24, 24),
      renders: { SVG: iconSvg(main.name) },
      children: [fake.node('GROUP', { name: 'Glyph', children: [vector(), vector(), vector()] })],
    });
  };
  const text = (name, characters) => {
    const mixed = random() < 0.1 && styleIds.TEXT.length > 1;
    return fake.node('TEXT', {
      name,
      ...box(200, 20),
      characters,
      fills: [solid(random() < boundShare)],
      fillStyleId: paintStyle(),
      textStyleId: mixed ? fake.mixed : textStyle(),
      ...(mixed
        ? {
            segments: [
              {
                characters: characters.slice(0, 4),
                start: 0,
                end: 4,
                textStyleId: pick(styleIds.TEXT),
              },
              { characters: characters.slice(4), start: 4, end: characters.length },
            ],
          }
        : {}),
      ...bound(['fills']),
    });
  };

  const buttonMasters = [];
  const buttonVariantNodes = [];
  for (let i = 0; i < buttonVariants; i += 1) {
    const remote = i < buttonVariants * remoteShare;
    const master = fake.node('COMPONENT', {
      name: `Size=${['S', 'M', 'L'][i % 3]}, State=${['Rest', 'Hover', 'Pressed', 'Disabled'][i % 4]}, Kind=${i}`,
      key: hex40(i + 1, 'b7'),
      remote,
      description: 'Button',
      ...box(120, 40),
      fills: [solid(true)],
      layoutMode: 'HORIZONTAL',
      children: [icon(), text('Label', 'Button')],
    });
    buttonMasters.push(master);
    buttonVariantNodes.push(master);
  }
  const buttonSet = fake.node('COMPONENT_SET', {
    name: 'Button',
    key: hex40(1, '5e'),
    remote: remoteShare > 0,
    componentPropertyDefinitions: {
      Size: { type: 'VARIANT', defaultValue: 'M', variantOptions: ['S', 'M', 'L'] },
      'Label#1:0': { type: 'TEXT', defaultValue: 'Button' },
    },
    children: buttonVariantNodes,
  });
  for (const master of buttonMasters) if (master.remote) fake.publish(master);
  if (remoteShare > 0) fake.publish(buttonSet);

  const cardMasters = [];
  for (let i = 0; i < 4; i += 1) {
    cardMasters.push(
      fake.node('COMPONENT', { name: `Card/${i}`, key: hex40(i + 1, 'ca'), ...box(320, 360) }),
    );
  }

  const button = (withLabel) => {
    const main = pick(buttonMasters);
    return fake.node('INSTANCE', {
      name: 'Button',
      main,
      ...box(120, 40),
      fills: [solid(true)],
      fillStyleId: paintStyle(),
      layoutMode: 'HORIZONTAL',
      itemSpacing: 8,
      paddingLeft: 12,
      paddingRight: 12,
      componentProperties: { 'Label#1:0': { type: 'TEXT', value: 'Open' } },
      ...bound(['fills', 'itemSpacing', 'paddingLeft', 'paddingRight']),
      children: withLabel ? [icon(), text('Label', 'Open')] : [icon()],
    });
  };

  const card = (index) => {
    let node = fake.node('INSTANCE', {
      name: `Card ${index}`,
      main: pick(cardMasters),
      ...box(320, 360),
      layoutMode: 'VERTICAL',
      itemSpacing: 12,
      cornerRadius: 12,
      fills: [solid(true)],
      strokes: [solid(false)],
      fillStyleId: paintStyle(),
      effectStyleId: styleIds.EFFECT.length > 0 && random() < 0.5 ? pick(styleIds.EFFECT) : '',
      ...bound(['fills', 'strokes', 'itemSpacing', 'paddingTop', 'paddingBottom']),
      children: [
        fake.node('RECTANGLE', {
          name: 'Media',
          ...box(320, 180),
          fills:
            imageHashes.length > 0
              ? [{ type: 'IMAGE', visible: true, scaleMode: 'FILL', imageHash: pick(imageHashes) }]
              : [solid(false)],
        }),
        fake.node('FRAME', {
          name: 'Content',
          ...box(320, 180),
          layoutMode: 'VERTICAL',
          ...bound(['itemSpacing', 'paddingLeft', 'paddingRight']),
          children: [
            text('Title', `Card title number ${index}`),
            text('Body', `Body copy for card ${index}, long enough to wrap onto a second line.`),
            fake.node('FRAME', {
              name: 'Meta',
              ...box(320, 24),
              layoutMode: 'HORIZONTAL',
              children: [
                fake.node('ELLIPSE', {
                  name: 'Avatar',
                  ...box(24, 24),
                  fills:
                    imageHashes.length > 0
                      ? [
                          {
                            type: 'IMAGE',
                            visible: true,
                            scaleMode: 'FILL',
                            imageHash: pick(imageHashes),
                          },
                        ]
                      : [solid(false)],
                }),
                text('Author', `Author ${index % 97}`),
              ],
            }),
            fake.node('FRAME', {
              name: 'Actions',
              ...box(320, 40),
              layoutMode: 'HORIZONTAL',
              ...bound(['itemSpacing']),
              children: [button(true), button(false)],
            }),
          ],
        }),
      ],
    });
    for (let level = 0; level < nestedInstances; level += 1) {
      node = fake.node('INSTANCE', {
        name: `Slot ${level}`,
        main: pick(cardMasters),
        ...box(320, 360),
        children: [node],
      });
    }
    return node;
  };

  const rows = [];
  for (let start = 0; start < cards; start += 4) {
    const children = [];
    for (let index = start; index < Math.min(cards, start + 4); index += 1)
      children.push(card(index));
    rows.push(
      fake.node('FRAME', {
        name: `Row ${start / 4}`,
        ...box(1440, 360),
        layoutMode: 'HORIZONTAL',
        ...bound(['itemSpacing']),
        children,
      }),
    );
  }
  const sections = [];
  for (let start = 0; start < rows.length; start += 8) {
    sections.push(
      fake.node('FRAME', {
        name: `Section ${start / 8}`,
        ...box(1440, 2880),
        layoutMode: 'VERTICAL',
        fillStyleId: paintStyle(),
        children: rows.slice(start, start + 8),
      }),
    );
  }

  let content = sections;
  for (let level = 0; level < depth; level += 1) {
    content = [
      fake.node('FRAME', { name: `Wrap ${level}`, ...box(1440, 4000), children: content }),
    ];
  }

  const rasters = [];
  for (let i = 0; i < svgRasters; i += 1) {
    const data = base64(bytes(svgRasterBytes, PNG, random));
    // The same raster twice, as Figma repeats an image fill used by two layers.
    rasters.push(`<image width="10" height="10" xlink:href="data:image/png;base64,${data}"/>`);
    rasters.push(`<image width="10" height="10" xlink:href="data:image/png;base64,${data}"/>`);
  }
  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<rect width="100" height="100" fill="#fff"/>'.repeat(cards * 4) +
      rasters.join('') +
      '</svg>',
  );

  const root = fake.node('FRAME', {
    name: 'Screen',
    ...box(1440, 4000),
    layoutMode: 'VERTICAL',
    fills: [solid(true)],
    ...bound(['fills', 'itemSpacing']),
    renders: { SVG: svg, PNG: bytes(pngBytes, PNG, random) },
    children: content,
  });
  return { fake, root };
}

const KB = 1024;
const MB = 1024 * KB;

// Node counts are for the exported tree. One card is 22 nodes.
export const DOCUMENTS = {
  // One product screen.
  screen: { cards: 45, images: 8, imageBytes: 200 * KB, pngBytes: 1 * MB },
  // A long page or a flow of screens.
  page: {
    cards: 450,
    images: 40,
    imageBytes: 200 * KB,
    pngBytes: 4 * MB,
    variables: 400,
    paintStyles: 60,
    textStyles: 24,
    svgRasters: 8,
    svgRasterBytes: 100 * KB,
  },
  // Just under the 40,000 node cap.
  cap: {
    cards: 1750,
    images: 120,
    imageBytes: 200 * KB,
    pngBytes: 8 * MB,
    variables: 1200,
    paintStyles: 200,
    textStyles: 60,
    effectStyles: 20,
  },
  // Past the cap, so the tree truncates.
  over: { cards: 2700, images: 120, imageBytes: 200 * KB, pngBytes: 8 * MB, variables: 1200 },
  // The page wrapped in 30 frames, then in 400.
  deep30: { cards: 450, depth: 30, images: 8 },
  deep400: { cards: 450, depth: 400, images: 8 },
  deep100: { cards: 45, depth: 100, images: 8 },
  deep150: { cards: 45, depth: 150, images: 8 },
  deep200: { cards: 45, depth: 200, images: 8 },
  deep250: { cards: 45, depth: 250, images: 8 },
  deep300: { cards: 45, depth: 300, images: 8 },
  deep350: { cards: 45, depth: 350, images: 8 },
  deep1000: { cards: 45, depth: 1000, images: 8 },
  deep3000: { cards: 45, depth: 3000, images: 8 },
  // Cards nested in instances: every level is a component boundary.
  nested6: { cards: 450, nestedInstances: 6, images: 8 },
  nested40: { cards: 200, nestedInstances: 40, images: 8 },
  // The image cap: 500 distinct fills.
  images: { cards: 450, images: 500, imageBytes: 256 * KB, pngBytes: 8 * MB },
  // A token-heavy design system page.
  tokens: {
    cards: 450,
    images: 8,
    variables: 5000,
    paintStyles: 1500,
    textStyles: 400,
    effectStyles: 100,
    boundShare: 1,
  },
  // The node cap with every layer bound to variables.
  tokencap: {
    cards: 1750,
    images: 8,
    variables: 1200,
    paintStyles: 200,
    textStyles: 60,
    boundShare: 1,
  },
  // The UI limit: a preview SVG with large embedded rasters.
  rasters: {
    cards: 200,
    images: 100,
    imageBytes: 512 * KB,
    pngBytes: 16 * MB,
    svgRasters: 40,
    svgRasterBytes: 512 * KB,
  },
};
