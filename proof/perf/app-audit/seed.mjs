// Builds a disposable library with a realistic spread through the real library commit path.
// usage: node seed.mjs <repo> <outDir> [scale]
// Shape at scale 1 (about 5,000 revisions, 300 projects):
//   298 ordinary files of 7 nodes x 2 revisions, one design-system file of 240 nodes x 2 revisions,
//   one file whose first node has 120 revisions, and 200 unidentified exports.
// Every export carries an 800x1000 PNG preview. Receipt times spread over 180 days.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const [repo, out, scaleArg] = process.argv.slice(2);
const scale = Number(scaleArg ?? 1);
registerHooks({
  resolve(specifier, context, next) {
    const extensionless = specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier);
    return next(extensionless ? `${specifier}.ts` : specifier, context);
  },
});
const { openLibrary } = await import(join(repo, 'apps/desktop/src/library/library.ts'));

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

// A flat frame with coloured blocks and one noisy band, so the file is tens of kilobytes while
// decoding still costs a full 800x1000 bitmap.
function png(seed, width = 800, height = 1000) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let state = seed * 2654435761 + 1;
  const rand = () => (state = (state * 1664525 + 1013904223) >>> 0) >>> 24;
  const hue = [rand(), rand(), rand()];
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    const noisy = y > 300 && y < 320;
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 3;
      const block = (Math.floor(x / 100) + Math.floor(y / 100)) % 3;
      raw[at] = noisy ? rand() : (hue[0] + block * 40) & 255;
      raw[at + 1] = noisy ? rand() : (hue[1] + block * 20) & 255;
      raw[at + 2] = noisy ? rand() : hue[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PNGS = Array.from({ length: 16 }, (_, i) => png(i + 1));

const plan = [];
const ordinary = Math.round(298 * scale);
for (let p = 0; p < ordinary; p += 1)
  for (let n = 0; n < 7; n += 1)
    for (let r = 0; r < 2; r += 1)
      plan.push({
        key: `fileKey${String(p).padStart(4, '0')}`,
        file: p % 40 === 0 ? 'Untitled' : `Product ${p}`,
        node: n,
      });
for (let n = 0; n < Math.round(240 * scale); n += 1)
  for (let r = 0; r < 2; r += 1)
    plan.push({ key: 'designSystemKey', file: 'Design System', node: n });
for (let n = 0; n < 11; n += 1)
  for (let r = 0; r < 2; r += 1)
    plan.push({ key: 'hotFileKey', file: 'Checkout flow', node: n + 1 });
for (let r = 0; r < Math.round(120 * scale); r += 1)
  plan.push({ key: 'hotFileKey', file: 'Checkout flow', node: 0 });
for (let u = 0; u < Math.round(200 * scale); u += 1)
  plan.push({ key: null, file: u % 3 === 0 ? '' : `Draft ${u}`, node: u });

// Deterministic shuffle, so receipt times interleave projects as real use does.
let s = 12345;
for (let i = plan.length - 1; i > 0; i -= 1) {
  s = (s * 1103515245 + 12345) & 0x7fffffff;
  const j = s % (i + 1);
  [plan[i], plan[j]] = [plan[j], plan[i]];
}

const END = Date.parse('2026-11-01T12:00:00.000Z');
const STEP = Math.floor((180 * 24 * 3600 * 1000) / plan.length);
let clock = END - STEP * plan.length;
const library = await openLibrary(
  { root: out, trashItem: async () => {} },
  { now: () => new Date((clock += STEP)) },
);
let i = 0;
for (const item of plan) {
  i += 1;
  const stagingId = randomUUID();
  const bundle = join(library.stagingDir, stagingId, 'bundle');
  await mkdir(bundle, { recursive: true });
  const files = {
    'node.json': `{"id":"${item.node}:1","name":"Seed ${i}"}\n`,
    'figma-components.json': '[]\n',
    'meta.json': '{}\n',
    'preview.png': PNGS[i % PNGS.length],
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(bundle, name), bytes);
  const result = await library.commit({
    stagingId,
    identity: item.key
      ? { kind: 'file', fileKey: item.key }
      : { kind: 'unidentified', claimedKey: null },
    fileName: item.file,
    figmaNodeId: `${item.node}:1`,
    nodeName: `Frame ${item.node} / ${item.file}`,
    contentHash: createHash('sha256').update(`seed-${i}`).digest('hex'),
    exportedAt: null,
  });
  if (!result.ok || result.status !== 'committed')
    throw new Error(`seed ${i}: ${JSON.stringify(result)}`);
}
const snapshot = await library.getSnapshot();
const revisions =
  snapshot.projects.reduce((n, p) => n + p.nodes.reduce((m, x) => m + x.revisions.length, 0), 0) +
  snapshot.unidentified.length;
if (revisions !== plan.length)
  throw new Error(`expected ${plan.length} revisions, snapshot has ${revisions}`);
console.log(
  JSON.stringify({
    out,
    revisions,
    projects: snapshot.projects.length,
    unidentified: snapshot.unidentified.length,
    pngBytes: PNGS.map((b) => b.length),
    staging: (await readdir(library.stagingDir)).length,
  }),
);
