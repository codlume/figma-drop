import { crc32, deflateSync, inflateSync } from 'node:zlib';

export const RED = [220, 40, 40];
export const BLUE = [40, 80, 220];
export const GREEN = [0, 170, 136];
export const TEAL = [0, 136, 170];

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

// Bare base64, as the wire carries `png`.
export function solidPng(width, height, [r, g, b]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3);
  const scanlines = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

function paeth(a, b, c) {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(file) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('latin1', offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = body[9] === 6 ? 4 : 3;
    }
    if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i += 1) {
      const value = raw[y * (stride + 1) + 1 + i];
      const left = i >= channels ? pixels[y * stride + i - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
      pixels[y * stride + i] = (value + predicted) & 255;
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const start = y * stride + x * channels;
      return [pixels[start], pixels[start + 1], pixels[start + 2]];
    },
  };
}

const PALETTE = [RED, BLUE, GREEN, TEAL, [0, 0, 0], [255, 255, 255]];

export function nearestColor(actual) {
  const distance = (color) => color.reduce((sum, value, i) => sum + (value - actual[i]) ** 2, 0);
  return PALETTE.reduce((best, color) => (distance(color) < distance(best) ? color : best));
}

export function plainSvg(width, height, fill) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${fill}"/></svg>`;
}

export function hostileSvg(canaryPort) {
  const canary = `http://127.0.0.1:${canaryPort}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="80" onload="fetch('${canary}/onload', {mode: 'no-cors'})">
  <rect width="120" height="80" fill="#00aa88"/>
  <script>fetch('${canary}/script', {mode: 'no-cors'}); try { parent.document.title = 'owned'; } catch {}</script>
  <image href="${canary}/external-image.png" width="1" height="1"/>
  <foreignObject width="1" height="1"><iframe xmlns="http://www.w3.org/1999/xhtml" src="${canary}/foreign-iframe"></iframe></foreignObject>
</svg>`;
}

export function styledSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><style>.paint { fill: #0088aa; }</style><rect class="paint" width="120" height="80"/></svg>`;
}

let tick = 0;

// Passing a field as `undefined` omits it from the body, as the wire omits absent optionals.
export function exportBody(overrides = {}) {
  tick += 1;
  const nodeId = overrides.nodeId ?? '1:1';
  const nodeName = overrides.nodeName ?? 'Synthetic Frame';
  return {
    outputDir: '/ignored/by/figma-drop',
    fileKey: 'SyntheticFixtureKey',
    fileName: 'Synthetic Fixture',
    nodeId,
    nodeName,
    exportedAt: new Date(Date.UTC(2026, 9, 1, 12, 0, tick)).toISOString(),
    summary: { totalNodes: 1, components: { total: 0, local: 0, remote: 0 } },
    node: { id: nodeId, name: nodeName, type: 'FRAME' },
    components: [],
    remoteMasters: [],
    ...overrides,
  };
}
