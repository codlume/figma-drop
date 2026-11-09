// Builds a disposable library of N revisions through the real library commit path.
// usage: node seed.mjs <repo> <outDir> <revisions>
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';

const [repo, out, countArg] = process.argv.slice(2);
const total = Number(countArg);
registerHooks({
  resolve(specifier, context, next) {
    const extensionless = specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier);
    return next(extensionless ? `${specifier}.ts` : specifier, context);
  },
});
const { createLibrary } = await import(join(repo, 'apps/desktop/src/library/index.ts'));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const library = await createLibrary({ root: out, trashItem: async () => {} });
const NODES_PER_PROJECT = 40;
const REVISIONS_PER_NODE = 2;
let made = 0;
for (let i = 0; made < total; i += 1) {
  const unidentified = i % 20 === 19;
  const project = Math.floor(i / (NODES_PER_PROJECT * REVISIONS_PER_NODE));
  const node = Math.floor(i / REVISIONS_PER_NODE) % NODES_PER_PROJECT;
  const stagingId = randomUUID();
  const bundle = join(library.stagingDir, stagingId, 'bundle');
  await mkdir(bundle, { recursive: true });
  const files = {
    'node.json': `{"id":"${node}:1","name":"Seed ${i}"}\n`,
    'figma-components.json': '[]\n',
    'meta.json': '{}\n',
    'preview.png': PNG,
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(bundle, name), bytes);
  const result = await library.commit({
    stagingId,
    identity: unidentified
      ? { kind: 'unidentified', claimedKey: null }
      : { kind: 'file', fileKey: `seedKey${String(project).padStart(4, '0')}` },
    fileName: `Seed File ${project}`,
    figmaNodeId: `${node}:1`,
    nodeName: `Seed Node ${node}`,
    contentHash: createHash('sha256').update(`seed-${i}`).digest('hex'),
    exportedAt: null,
  });
  if (!result.ok || result.status !== 'committed')
    throw new Error(`seed ${i}: ${JSON.stringify(result)}`);
  made += 1;
}
const snapshot = await library.getSnapshot();
const revisions =
  snapshot.projects.reduce((n, p) => n + p.nodes.reduce((m, x) => m + x.revisions.length, 0), 0) +
  snapshot.unidentified.length;
if (revisions !== total) throw new Error(`expected ${total} revisions, snapshot has ${revisions}`);
console.log(
  JSON.stringify({
    out,
    revisions,
    projects: snapshot.projects.length,
    staging: (await readdir(library.stagingDir)).length,
  }),
);
