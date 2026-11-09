// Deterministic synthetic export payloads shaped like the plugin's /sync body.
import { createHash } from 'node:crypto';

function prng(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function bytes(rand, size) {
  const out = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i += 1) out[i] = Math.floor(rand() * 256);
  return out;
}

const TYPES = ['FRAME', 'TEXT', 'RECTANGLE', 'VECTOR', 'INSTANCE', 'GROUP', 'ELLIPSE'];

function tree(rand, count, prefix) {
  let made = 0;
  const make = (depth) => {
    made += 1;
    const id = `${prefix}:${made}`;
    const type = TYPES[Math.floor(rand() * TYPES.length)];
    const node = {
      id,
      name: `${type.toLowerCase()} ${made}`,
      type,
      visible: true,
      locked: false,
      opacity: Math.round(rand() * 100) / 100,
      x: Math.round(rand() * 2000),
      y: Math.round(rand() * 2000),
      width: Math.round(rand() * 400),
      height: Math.round(rand() * 400),
      rotation: 0,
      fills: [{ type: 'SOLID', color: { r: rand(), g: rand(), b: rand(), a: 1 }, visible: true }],
      strokes: [],
      effects: rand() < 0.2 ? [{ type: 'DROP_SHADOW', radius: 4, offset: { x: 0, y: 2 } }] : [],
      layoutMode: rand() < 0.5 ? 'VERTICAL' : 'NONE',
      itemSpacing: 8,
      paddingLeft: 16,
      paddingRight: 16,
      constraints: { horizontal: 'MIN', vertical: 'MIN' },
    };
    if (type === 'TEXT')
      node.characters = 'Lorem ipsum dolor sit amet '.repeat(1 + Math.floor(rand() * 3));
    if (depth < 6 && made < count) {
      node.children = [];
      const kids = 1 + Math.floor(rand() * 6);
      for (let k = 0; k < kids && made < count; k += 1) node.children.push(make(depth + 1));
    }
    return node;
  };
  const root = make(0);
  while (made < count) {
    root.children ??= [];
    root.children.push(make(1));
  }
  return root;
}

// Profiles are guesses at a typical and a heavy export; no real export has been measured.
export const PROFILES = {
  typical: { nodes: 1500, pngBytes: 300_000, svgBytes: 60_000, images: 4, imageBytes: 80_000 },
  heavy: { nodes: 12000, pngBytes: 2_000_000, svgBytes: 400_000, images: 12, imageBytes: 250_000 },
};

export function makePayload({ seed, fileKey, fileName, nodeId, profile = 'typical' }) {
  const p = PROFILES[profile];
  const rand = prng(seed);
  const node = tree(rand, p.nodes, nodeId.split(':')[0]);
  node.id = nodeId;
  const svgBody = Array.from(
    { length: Math.ceil(p.svgBytes / 80) },
    (_, i) =>
      `<rect x="${i % 400}" y="${(i * 7) % 400}" width="10" height="10" fill="#${(i * 99991).toString(16).slice(-6).padStart(6, '0')}"/>`,
  ).join('');
  return {
    node,
    fileKey,
    fileName,
    nodeId,
    nodeName: `Screen ${nodeId}`,
    exportedAt: new Date(Date.UTC(2026, 0, 1) + seed * 1000).toISOString(),
    summary: { totalNodes: p.nodes },
    components: Array.from({ length: 20 }, (_, i) => ({
      id: `c:${i}`,
      name: `Button/${i}`,
      key: `k${i}`,
    })),
    remoteMasters: [],
    variables: {
      collections: [{ id: 'vc:1', name: 'Tokens' }],
      tokens: Array.from({ length: 50 }, (_, i) => ({
        id: `v:${i}`,
        name: `color/${i}`,
        value: '#ffffff',
      })),
    },
    styles: { styles: Array.from({ length: 20 }, (_, i) => ({ id: `s:${i}`, name: `Text/${i}` })) },
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">${svgBody}</svg>`,
    png: bytes(rand, p.pngBytes).toString('base64'),
    assets: [
      {
        name: 'icon.svg',
        base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
      },
    ],
    images: Array.from({ length: p.images }, (_, i) => ({
      imageHash: `h${seed}-${i}`,
      name: `img-${i}.png`,
      base64: bytes(rand, p.imageBytes).toString('base64'),
    })),
  };
}
