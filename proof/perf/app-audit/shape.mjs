// Times toSnapshot from two source trees on one scanned catalog, alternating sides, and checks
// that both give the same snapshot.
// usage: node shape.mjs <baseTree> <changeTree> <libraryDir> [rounds] [callsPerRound]
import * as fs from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const [baseTree, changeTree, root, roundsArg, callsArg] = process.argv.slice(2);
const rounds = Number(roundsArg ?? 7);
const calls = Number(callsArg ?? 20);
registerHooks({
  resolve(specifier, context, next) {
    const extensionless = specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier);
    return next(extensionless ? `${specifier}.ts` : specifier, context);
  },
});
const load = async (tree) => ({
  ...(await import(join(tree, 'apps/desktop/src/library/catalog.ts'))),
  ...(await import(join(tree, 'apps/desktop/src/library/disk.ts'))),
});
const sides = { base: await load(baseTree), change: await load(changeTree) };
const { catalog } = await sides.change.scanCatalog(fs, root);

const same =
  JSON.stringify(sides.base.toSnapshot(catalog)) ===
  JSON.stringify(sides.change.toSnapshot(catalog));
for (const side of Object.values(sides)) for (let i = 0; i < 30; i += 1) side.toSnapshot(catalog);

const medians = { base: [], change: [] };
const med = (a) => [...a].toSorted((x, y) => x - y)[Math.floor(a.length / 2)];
for (let round = 0; round < rounds; round += 1) {
  for (const name of round % 2 ? ['change', 'base'] : ['base', 'change']) {
    const times = [];
    for (let i = 0; i < calls; i += 1) {
      const t = performance.now();
      const snapshot = sides[name].toSnapshot(catalog);
      times.push(performance.now() - t);
      if (snapshot.projects.length === 0) throw new Error('empty snapshot');
    }
    medians[name].push(med(times));
  }
}
const row = (a) => ({
  medianMs: +med(a).toFixed(2),
  minMs: +Math.min(...a).toFixed(2),
  maxMs: +Math.max(...a).toFixed(2),
});
console.log(
  JSON.stringify({
    revisions: catalog.revisions.size,
    sameSnapshot: same,
    rounds,
    callsPerRound: calls,
    base: row(medians.base),
    change: row(medians.change),
  }),
);
