// Times library.commit alone for new nodes in a seeded library, from two source trees in turn.
// Each round opens a hard-linked clone of the seed, so both sides commit into the same library.
// usage: AUDIT_SCRATCH=<dir> node commit.mjs <baseTree> <changeTree> <seedDir> [rounds] [commits]
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const [baseTree, changeTree, seedDir, roundsArg, commitsArg] = process.argv.slice(2);
const rounds = Number(roundsArg ?? 5);
const commits = Number(commitsArg ?? 40);
registerHooks({
  resolve(specifier, context, next) {
    const extensionless = specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier);
    return next(extensionless ? `${specifier}.ts` : specifier, context);
  },
});
const trees = { base: baseTree, change: changeTree };
const modules = {};
for (const [name, tree] of Object.entries(trees))
  modules[name] = await import(join(tree, 'apps/desktop/src/library/library.ts'));

const med = (a) => [...a].toSorted((x, y) => x - y)[Math.floor(a.length / 2)];

async function round(name, index) {
  const scratch = await mkdtemp(join(process.env.AUDIT_SCRATCH, 'c'));
  const root = join(scratch, 'L');
  execFileSync('cp', ['-al', seedDir, root]);
  try {
    const library = await modules[name].openLibrary({ root, trashItem: async () => {} });
    const times = [];
    for (let i = 0; i < commits; i += 1) {
      const stagingId = randomUUID();
      const bundle = join(library.stagingDir, stagingId, 'bundle');
      await mkdir(bundle, { recursive: true });
      const node = `7${index}:${i}`;
      await writeFile(join(bundle, 'node.json'), `{"id":"${node}"}\n`);
      await writeFile(join(bundle, 'figma-components.json'), '[]\n');
      await writeFile(join(bundle, 'meta.json'), '{}\n');
      await writeFile(join(bundle, 'preview.png'), Buffer.alloc(70_000, i));
      const staged = {
        stagingId,
        identity: { kind: 'file', fileKey: i % 2 ? 'designSystemKey' : `benchKey${i}` },
        fileName: 'Bench File',
        figmaNodeId: node,
        nodeName: `Bench ${i}`,
        contentHash: createHash('sha256').update(`${name}-${index}-${i}`).digest('hex'),
        exportedAt: null,
      };
      const t = performance.now();
      const result = await library.commit(staged);
      times.push(performance.now() - t);
      if (!result.ok || result.status !== 'committed') throw new Error(JSON.stringify(result));
    }
    return med(times);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const medians = { base: [], change: [] };
for (let i = 0; i < rounds; i += 1)
  for (const name of i % 2 ? ['change', 'base'] : ['base', 'change'])
    medians[name].push(await round(name, i));
const row = (a) => ({
  medianMs: +med(a).toFixed(2),
  minMs: +Math.min(...a).toFixed(2),
  maxMs: +Math.max(...a).toFixed(2),
});
console.log(
  JSON.stringify({
    seedDir,
    rounds,
    commits,
    base: row(medians.base),
    change: row(medians.change),
  }),
);
