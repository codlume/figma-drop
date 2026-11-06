import { describe, expect, it } from 'vite-plus/test';
import { exportNode } from './export-node.ts';
import { createFakeFigma, type FakeFigma } from './testing/fake-figma.ts';

const imagePaint = (imageHash: string, visible = true) => ({
  type: 'IMAGE',
  visible,
  scaleMode: 'FILL',
  imageHash,
});
const iconNames = (raw: Awaited<ReturnType<typeof exportNode>>) =>
  raw.icons.map((icon) => icon.name);
const svgCalls = (fake: FakeFigma, nodeId: string) =>
  fake.exportCalls.filter((call) => call.nodeId === nodeId);

describe('icons', () => {
  it('exports a vector-only component with default SVG options, named by slug and key', async () => {
    const fake = createFakeFigma();
    const svg = new TextEncoder().encode('<svg id="close"/>');
    const icon = fake.node('COMPONENT', {
      id: '1:1',
      name: 'Icon/Close',
      key: 'abc',
      renders: { SVG: svg },
      children: [fake.node('VECTOR')],
    });

    const raw = await exportNode(fake.figma, fake.node('FRAME', { children: [icon] }));

    expect(raw.icons).toEqual([{ name: 'Icon-Close.abc.svg', bytes: svg }]);
    expect(svgCalls(fake, '1:1')).toEqual([{ nodeId: '1:1', settings: { format: 'SVG' } }]);
  });

  it('counts the root as a candidate', async () => {
    const fake = createFakeFigma();
    const raw = await exportNode(fake.figma, fake.node('COMPONENT', { name: 'Solo', key: 'k' }));
    expect(iconNames(raw)).toEqual(['Solo.k.svg']);
  });

  it('identifies an instance by its main component', async () => {
    const fake = createFakeFigma();
    const main = fake.node('COMPONENT', { name: 'Main', key: 'mk' });
    const raw = await exportNode(fake.figma, fake.node('INSTANCE', { name: 'Own', main }));
    expect(iconNames(raw)).toEqual(['Main.mk.svg']);
  });

  it('falls back to ids, slugged, for keyless components and unresolved instances', async () => {
    const fake = createFakeFigma();
    const keyless = fake.node('COMPONENT', { id: '12:34', name: 'Keyless' });
    const keylessMain = fake.node('COMPONENT', { id: '56:78', name: 'Main' });
    const root = fake.node('FRAME', {
      children: [
        keyless,
        fake.node('INSTANCE', { main: keylessMain }),
        fake.node('INSTANCE', { id: '90:12', name: 'Lost', main: null }),
      ],
    });

    const raw = await exportNode(fake.figma, root);

    expect(iconNames(raw)).toEqual(['Keyless.12-34.svg', 'Main.56-78.svg', 'Lost.90-12.svg']);
  });

  it('falls back to the words icon and key when a slug empties', async () => {
    const fake = createFakeFigma();
    const raw = await exportNode(fake.figma, fake.node('COMPONENT', { name: '★★', key: '★' }));
    expect(iconNames(raw)).toEqual(['icon.key.svg']);
  });

  it('applies the slug rule: runs collapse, ends trim, then an 80-character cut', async () => {
    const fake = createFakeFigma();
    const name = `  a  b/${'c'.repeat(76)}  d e`;
    const raw = await exportNode(fake.figma, fake.node('COMPONENT', { name, key: 'k' }));
    expect(iconNames(raw)).toEqual([`a-b-${'c'.repeat(76)}.k.svg`]);
  });

  it('keeps a slug ending in - when the cut lands on one', async () => {
    const fake = createFakeFigma();
    const name = `${'a'.repeat(79)} b`;
    const raw = await exportNode(fake.figma, fake.node('COMPONENT', { name, key: 'k' }));
    expect(iconNames(raw)).toEqual([`${'a'.repeat(79)}-.k.svg`]);
  });

  describe('vector-only test', () => {
    const isIcon = async (fake: FakeFigma, child: BaseNode) => {
      const component = fake.node('COMPONENT', { name: 'C', key: 'k', children: [child] });
      return (await exportNode(fake.figma, component)).icons.length === 1;
    };

    it('fails on visible text', async () => {
      const fake = createFakeFigma();
      expect(await isIcon(fake, fake.node('TEXT'))).toBe(false);
    });

    it('fails on a visible image fill', async () => {
      const fake = createFakeFigma();
      const rectangle = fake.node('RECTANGLE', { fills: [imagePaint('h')] });
      expect(await isIcon(fake, rectangle)).toBe(false);
    });

    it('ignores hidden text', async () => {
      const fake = createFakeFigma();
      expect(await isIcon(fake, fake.node('TEXT', { visible: false }))).toBe(true);
    });

    it('ignores text inside a hidden subtree', async () => {
      const fake = createFakeFigma();
      const group = fake.node('GROUP', { visible: false, children: [fake.node('TEXT')] });
      expect(await isIcon(fake, group)).toBe(true);
    });

    it('ignores a hidden image paint', async () => {
      const fake = createFakeFigma();
      const rectangle = fake.node('RECTANGLE', { fills: [imagePaint('h', false)] });
      expect(await isIcon(fake, rectangle)).toBe(true);
    });

    it('ignores an image on a hidden node', async () => {
      const fake = createFakeFigma();
      const rectangle = fake.node('RECTANGLE', { visible: false, fills: [imagePaint('h')] });
      expect(await isIcon(fake, rectangle)).toBe(true);
    });

    it('ignores an image in strokes', async () => {
      const fake = createFakeFigma();
      const rectangle = fake.node('RECTANGLE', { strokes: [imagePaint('h')] });
      expect(await isIcon(fake, rectangle)).toBe(true);
    });
  });

  it('excludes a hidden or zero-sized node and its subtree', async () => {
    const fake = createFakeFigma();
    const inner = () => fake.node('COMPONENT', { name: 'Inner', key: 'k' });
    const root = fake.node('FRAME', {
      children: [
        fake.node('COMPONENT', { name: 'Hidden', key: 'h', visible: false }),
        fake.node('FRAME', { visible: false, children: [inner()] }),
        fake.node('FRAME', { width: 0, children: [inner()] }),
        fake.node('FRAME', { height: -1, children: [inner()] }),
        fake.node('COMPONENT', { name: 'Flat', key: 'f', height: 0 }),
      ],
    });

    const raw = await exportNode(fake.figma, root);

    expect(raw.icons).toEqual([]);
  });

  it('never looks inside a vector-only match, even a duplicate or a failed one', async () => {
    const fake = createFakeFigma();
    const nested = () => fake.node('COMPONENT', { name: 'Nested', key: 'nested' });
    const first = fake.node('COMPONENT', { name: 'Dup', key: 'dup', children: [nested()] });
    const duplicate = fake.node('INSTANCE', {
      main: first,
      children: [fake.node('INSTANCE', { main: nested() })],
    });
    const failing = fake.node('COMPONENT', {
      name: 'Failing',
      key: 'fail',
      renders: { SVG: new Error('render failed') },
      children: [nested()],
    });

    const raw = await exportNode(
      fake.figma,
      fake.node('FRAME', { children: [first, duplicate, failing] }),
    );

    expect(iconNames(raw)).toEqual(['Dup.dup.svg']);
  });

  it('finds icons inside a component that is not vector-only', async () => {
    const fake = createFakeFigma();
    const card = fake.node('COMPONENT', {
      name: 'Card',
      key: 'card',
      fills: [imagePaint('photo')],
      children: [fake.node('INSTANCE', { main: fake.node('COMPONENT', { name: 'I', key: 'i' }) })],
    });
    const raw = await exportNode(fake.figma, card);
    expect(iconNames(raw)).toEqual(['I.i.svg']);
  });

  it('never treats a component set as an icon, but looks at its variants', async () => {
    const fake = createFakeFigma();
    const set = fake.node('COMPONENT_SET', {
      name: 'Set',
      key: 'set',
      children: [
        fake.node('COMPONENT', { name: 'On=yes', key: 'a' }),
        fake.node('COMPONENT', { name: 'On=no', key: 'b' }),
      ],
    });
    const raw = await exportNode(fake.figma, set);
    expect(iconNames(raw)).toEqual(['On-yes.a.svg', 'On-no.b.svg']);
  });

  it('drops a failed export silently', async () => {
    const fake = createFakeFigma();
    const raw = await exportNode(
      fake.figma,
      fake.node('FRAME', {
        children: [
          fake.node('COMPONENT', { key: 'x', renders: { SVG: new Error('nope') } }),
          fake.node('COMPONENT', { name: 'Fine', key: 'y' }),
        ],
      }),
    );
    expect(iconNames(raw)).toEqual(['Fine.y.svg']);
  });

  it('adds nothing for a later node with the same key', async () => {
    const fake = createFakeFigma();
    const main = fake.node('COMPONENT', { name: 'Main', key: 'same' });
    const root = fake.node('FRAME', {
      children: [fake.node('INSTANCE', { main }), fake.node('INSTANCE', { main })],
    });
    const raw = await exportNode(fake.figma, root);
    expect(iconNames(raw)).toEqual(['Main.same.svg']);
  });

  it('suffixes -2 and -3 before .svg when different keys slug to one name', async () => {
    const fake = createFakeFigma();
    const root = fake.node('FRAME', {
      children: [
        fake.node('COMPONENT', { name: 'Same', key: 'a:b' }),
        fake.node('COMPONENT', { name: 'Same', key: 'a-b' }),
        fake.node('COMPONENT', { name: 'Same', key: 'a/b' }),
      ],
    });
    const raw = await exportNode(fake.figma, root);
    expect(iconNames(raw)).toEqual(['Same.a-b.svg', 'Same.a-b-2.svg', 'Same.a-b-3.svg']);
  });

  it('stops at 500 files', async () => {
    const fake = createFakeFigma();
    const children = Array.from({ length: 501 }, (_, index) =>
      fake.node('COMPONENT', { name: 'I', key: `k${index}` }),
    );
    const raw = await exportNode(fake.figma, fake.node('FRAME', { children }));
    expect(raw.icons).toHaveLength(500);
    expect(iconNames(raw).at(-1)).toBe('I.k499.svg');
  });
});

describe('image fills', () => {
  const PNG = new Uint8Array([0x89, 0x50, 1, 2]);

  it.each([
    ['png', [0x89, 0x50, 0x4e, 0x47]],
    ['jpg', [0xff, 0xd8, 0xff]],
    ['gif', [0x47, 0x49, 0x46, 0x38]],
    ['webp', [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]],
    ['png', [1, 2, 3, 4]],
    ['png', []],
  ])('names as .%s from magic bytes %j', async (extension, magic) => {
    const fake = createFakeFigma();
    const bytes = new Uint8Array(magic);
    fake.addImage('hash', bytes);

    const raw = await exportNode(
      fake.figma,
      fake.node('RECTANGLE', { fills: [imagePaint('hash')] }),
    );

    expect(raw.images).toEqual([{ imageHash: 'hash', name: `hash.${extension}`, bytes }]);
    expect(raw.summary).toMatchObject({ imageAssets: 1 });
  });

  it('keeps one entry per hash', async () => {
    const fake = createFakeFigma();
    fake.addImage('same', PNG);
    const root = fake.node('FRAME', {
      fills: [imagePaint('same')],
      children: [fake.node('RECTANGLE', { fills: [imagePaint('same')] })],
    });
    expect((await exportNode(fake.figma, root)).images).toHaveLength(1);
  });

  it('takes only visible paints in fills of visible nodes', async () => {
    const fake = createFakeFigma();
    for (const hash of ['shown', 'paint-off', 'node-off', 'under-off', 'stroke', 'background']) {
      fake.addImage(hash, PNG);
    }
    const root = fake.node('FRAME', {
      backgrounds: [imagePaint('background')],
      children: [
        fake.node('RECTANGLE', {
          fills: [imagePaint('shown'), imagePaint('paint-off', false)],
          strokes: [imagePaint('stroke')],
        }),
        fake.node('RECTANGLE', { visible: false, fills: [imagePaint('node-off')] }),
        fake.node('FRAME', {
          visible: false,
          children: [fake.node('RECTANGLE', { fills: [imagePaint('under-off')] })],
        }),
        fake.node('TEXT', { fills: fake.mixed }),
      ],
    });

    const raw = await exportNode(fake.figma, root);

    expect(raw.images.map((image) => image.imageHash)).toEqual(['shown']);
    expect(raw.node).toHaveProperty('backgrounds', [imagePaint('background')]);
  });

  it('leaves no trace of an image that is null or fails', async () => {
    const fake = createFakeFigma();
    fake.addImage('broken', new Error('no bytes'));
    const raw = await exportNode(
      fake.figma,
      fake.node('RECTANGLE', { fills: [imagePaint('missing'), imagePaint('broken')] }),
    );
    expect(raw.images).toEqual([]);
    expect(raw.summary).not.toHaveProperty('imageAssets');
  });

  it('slugs the hash into the name and keeps it raw in imageHash', async () => {
    const fake = createFakeFigma();
    fake.addImage('a/b', PNG);
    const raw = await exportNode(
      fake.figma,
      fake.node('RECTANGLE', { fills: [imagePaint('a/b')] }),
    );
    expect(raw.images[0]).toMatchObject({ imageHash: 'a/b', name: 'a-b.png' });
  });

  it('stops at 500 files', async () => {
    const fake = createFakeFigma();
    const children = Array.from({ length: 501 }, (_, index) => {
      fake.addImage(`h${index}`, PNG);
      return fake.node('RECTANGLE', { fills: [imagePaint(`h${index}`)] });
    });
    const raw = await exportNode(fake.figma, fake.node('FRAME', { children }));
    expect(raw.images).toHaveLength(500);
    expect(raw.summary).toMatchObject({ imageAssets: 500 });
  });

  it('walks the real subtree, so truncation reduces neither assets nor previews', async () => {
    const fake = createFakeFigma();
    fake.addImage('late', PNG);
    const filler = Array.from({ length: 40000 }, () => fake.node('RECTANGLE'));
    const late = fake.node('RECTANGLE', { fills: [imagePaint('late')] });
    const icon = fake.node('COMPONENT', { name: 'Late', key: 'late' });

    const raw = await exportNode(
      fake.figma,
      fake.node('FRAME', { children: [...filler, late, icon] }),
    );

    expect(raw.summary).toMatchObject({ truncated: true });
    expect(raw.images).toHaveLength(1);
    expect(iconNames(raw)).toEqual(['Late.late.svg']);
    expect(raw.pngBytes).toBeDefined();
  });
});
