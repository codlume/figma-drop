import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';

const out = process.argv[2];
const only = process.argv.slice(3);
await mkdir(out, { recursive: true });

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

function randomBase64(rand, rawBytes) {
  const buf = Buffer.allocUnsafe(rawBytes);
  for (let i = 0; i + 4 <= rawBytes; i += 4) buf.writeUInt32LE((rand() * 0x100000000) >>> 0, i);
  for (let i = rawBytes - (rawBytes % 4); i < rawBytes; i += 1) buf[i] = (rand() * 256) | 0;
  return buf.toString('base64');
}

const TYPES = ['FRAME', 'GROUP', 'TEXT', 'RECTANGLE', 'INSTANCE', 'VECTOR', 'ELLIPSE'];
function makeNode(rand, id, depth, budget) {
  const type = depth === 0 ? 'FRAME' : TYPES[Math.floor(rand() * TYPES.length)];
  const node = {
    id: `${100 + depth}:${id.n++}`,
    name: `${type.toLowerCase()} / Łódź ${id.n} ✓`,
    type,
    visible: true,
    opacity: Math.round(rand() * 100) / 100,
    blendMode: 'PASS_THROUGH',
    absoluteBoundingBox: {
      x: rand() * 4000,
      y: rand() * 4000,
      width: rand() * 800,
      height: rand() * 600,
    },
    constraints: { horizontal: 'LEFT', vertical: 'TOP' },
    fills: [
      {
        type: 'SOLID',
        visible: true,
        opacity: 1,
        color: { r: rand(), g: rand(), b: rand(), a: 1 },
      },
    ],
    strokes: rand() < 0.3 ? [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }] : [],
    strokeWeight: 1,
    cornerRadius: rand() < 0.5 ? 8 : 0,
    effects:
      rand() < 0.1
        ? [
            {
              type: 'DROP_SHADOW',
              radius: 4,
              offset: { x: 0, y: 2 },
              color: { r: 0, g: 0, b: 0, a: 0.25 },
            },
          ]
        : [],
    layoutMode: 'NONE',
  };
  if (type === 'TEXT') {
    node.characters = 'The quick brown fox jumps over the lazy dog. '.repeat(
      1 + Math.floor(rand() * 3),
    );
    node.style = {
      fontFamily: 'Inter',
      fontPostScriptName: 'Inter-Regular',
      fontWeight: 400,
      fontSize: 14,
      lineHeightPx: 20,
      letterSpacing: 0,
      textAlignHorizontal: 'LEFT',
    };
  }
  if (type === 'INSTANCE') node.componentId = `9:${Math.floor(rand() * 40)}`;
  if ((type === 'FRAME' || type === 'GROUP' || type === 'INSTANCE') && depth < 12) {
    node.children = [];
    const want = depth === 0 ? Infinity : 1 + Math.floor(rand() * 6);
    for (let i = 0; i < want && budget.left > 0; i += 1) {
      budget.left -= 1;
      node.children.push(makeNode(rand, id, depth + 1, budget));
    }
  }
  return node;
}

function realistic({ seed, nodes, images, imageBytes, pngBytes, svgBytes, components }) {
  const rand = rng(seed);
  const id = { n: 1 };
  const node = makeNode(rand, id, 0, { left: nodes - 1 });
  const svgRect = '<rect x="10" y="10" width="100" height="40" rx="8" fill="#3366ff"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900">${svgRect.repeat(Math.ceil(svgBytes / svgRect.length))}</svg>`;
  return {
    outputDir: '',
    fileKey: `SynthKey${seed}`,
    fileName: 'Synthetic design file',
    nodeId: node.id,
    nodeName: node.name,
    exportedAt: '2026-01-01T00:00:00.000Z',
    summary: {
      totalNodes: nodes,
      truncated: false,
      components: { total: components, local: components, remote: 0 },
    },
    node,
    components: Array.from({ length: components }, (_, i) => ({
      id: `9:${i}`,
      key: `key${i}`,
      name: `Component ${i}`,
      description: '',
      remote: false,
    })),
    remoteMasters: [],
    variables: {
      collections: [{ id: 'c1', name: 'Tokens', modes: ['light', 'dark'] }],
      tokens: Array.from({ length: 200 }, (_, i) => ({
        id: `v${i}`,
        name: `color/token-${i}`,
        type: 'COLOR',
        values: { light: '#ffffff', dark: '#000000' },
      })),
    },
    styles: {
      styles: Array.from({ length: 60 }, (_, i) => ({
        id: `s${i}`,
        name: `Text/Style ${i}`,
        type: 'TEXT',
      })),
    },
    svg,
    png: randomBase64(rand, pngBytes),
    images: Array.from({ length: images }, (_, i) => ({
      imageHash: `hash${seed}_${i}`,
      name: `image-${i}.png`,
      base64: randomBase64(rand, imageBytes),
    })),
    assets: [{ name: 'icon-0.svg', base64: Buffer.from(svgRect).toString('base64') }],
  };
}

async function writeChunks(name, chunks) {
  const stream = createWriteStream(join(out, `${name}.json`));
  let bytes = 0;
  for (const chunk of chunks) {
    bytes += Buffer.byteLength(chunk);
    if (!stream.write(chunk)) await once(stream, 'drain');
  }
  stream.end();
  await once(stream, 'finish');
  console.log(name, bytes, (bytes / 1048576).toFixed(1) + ' MiB');
}

function* joined(prefix, count, item, suffix, batch = 100_000) {
  yield prefix;
  for (let start = 0; start < count; start += batch) {
    const end = Math.min(count, start + batch);
    let text = '';
    for (let i = start; i < end; i += 1) text += (i === 0 ? '' : ',') + item(i);
    yield text;
  }
  yield suffix;
}

const MIB = 1024 * 1024;
const kinds = {
  small: () =>
    writeChunks('small', [
      JSON.stringify(
        realistic({
          seed: 2,
          nodes: 300,
          images: 2,
          imageBytes: 60_000,
          pngBytes: 80_000,
          svgBytes: 20_000,
          components: 5,
        }),
      ),
    ]),
  typical: () =>
    writeChunks('typical', [
      JSON.stringify(
        realistic({
          seed: 1,
          nodes: 2000,
          images: 5,
          imageBytes: 150_000,
          pngBytes: 300_000,
          svgBytes: 100_000,
          components: 30,
        }),
      ),
    ]),
  large: () =>
    writeChunks('large', [
      JSON.stringify(
        realistic({
          seed: 3,
          nodes: 20_000,
          images: 40,
          imageBytes: 500_000,
          pngBytes: 2_000_000,
          svgBytes: 1_000_000,
          components: 200,
        }),
      ),
    ]),
  'cap-images': () => {
    const base = realistic({
      seed: 4,
      nodes: 3000,
      images: 0,
      imageBytes: 0,
      pngBytes: 2_000_000,
      svgBytes: 500_000,
      components: 50,
    });
    const text = JSON.stringify(base);
    const at = text.indexOf('"images":[') + 10;
    const rand = rng(44);
    const perImage = 3 * MIB;
    const count = Math.floor((254 * MIB - text.length) / ((perImage * 4) / 3 + 64));
    const parts = [text.slice(0, at)];
    for (let i = 0; i < count; i += 1) {
      parts.push(
        `${i ? ',' : ''}{"imageHash":"h${i}","name":"photo-${i}.png","base64":"${randomBase64(rand, perImage)}"}`,
      );
    }
    parts.push(text.slice(at));
    return writeChunks('cap-images', parts);
  },
  'budget-tree': () =>
    writeChunks('budget-tree', [
      JSON.stringify(
        realistic({
          seed: 5,
          nodes: 150_000,
          images: 5,
          imageBytes: 150_000,
          pngBytes: 300_000,
          svgBytes: 100_000,
          components: 300,
        }),
      ),
    ]),
  'keys-node': () =>
    writeChunks(
      'keys-node',
      joined(
        '{"node":{',
        7_990_000,
        (i) => `"k${i}":0`,
        '},"nodeId":"8:1","exportedAt":"2026-01-01T00:00:00.000Z"}',
      ),
    ),
  'keys-top': () =>
    writeChunks(
      'keys-top',
      joined(
        '{"node":{"id":"8:1"},"nodeId":"8:1","exportedAt":"2026-01-01T00:00:00.000Z",',
        7_900_000,
        (i) => `"k${i}":0`,
        '}',
      ),
    ),
  'objects-node': () =>
    writeChunks(
      'objects-node',
      joined('{"node":{"a":[', 3_995_000, () => '{}', ']},"nodeId":"8:2"}'),
    ),
  'images-2.6M': () =>
    writeChunks(
      'images-2.6M',
      joined(
        '{"node":{"id":"7:1"},"nodeId":"7:1","images":[',
        2_600_000,
        (i) => `{"name":"i${i}.png","base64":"AAAA"}`,
        ']}',
      ),
    ),
  'images-2000': () =>
    writeChunks(
      'images-2000',
      joined(
        '{"node":{"id":"7:2"},"nodeId":"7:2","exportedAt":"2026-01-01T00:00:00.000Z","images":[',
        2000,
        (i) =>
          `{"imageHash":"h${i}","name":"i${i}.png","base64":"${randomBase64(rng(i + 1), 3000)}"}`,
        ']}',
      ),
    ),
};
for (const [name, build] of Object.entries(kinds)) {
  if (only.length && !only.includes(name)) continue;
  await build();
}
