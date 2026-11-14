// Body size of one export by top-level field.
//   node sizes.mjs <apps/figma-plugin/src> <doc> [doc...]
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDocument, DOCUMENTS } from './docs.mjs';

const [srcArg, ...docs] = process.argv.slice(2);
const src = resolve(srcArg);
const load = (file) => import(pathToFileURL(join(src, file)).href);
const { createFakeFigma } = await load('sandbox/testing/fake-figma.ts');
const { exportNode } = await load('sandbox/export-node.ts');
const { encodeExport } = await load('ui/payload.ts');

const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;
for (const doc of docs) {
  const { fake, root } = buildDocument(createFakeFigma, DOCUMENTS[doc]);
  const raw = await exportNode(fake.figma, root);
  const payload = encodeExport(raw);
  const total = Buffer.byteLength(JSON.stringify(payload));
  const fields = Object.entries(payload)
    .map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))])
    .sort((a, b) => b[1] - a[1])
    .filter(([, bytes]) => bytes > total / 200)
    .map(([key, bytes]) => `${key} ${mb(bytes)}`);
  const nodes = raw.summary.totalNodes;
  const tree = Buffer.byteLength(JSON.stringify(payload.node));
  console.log(
    `${doc}: ${nodes} nodes, body ${mb(total)}, ${(tree / nodes).toFixed(0)} B of JSON per node | ${fields.join(', ')}`,
  );
}
