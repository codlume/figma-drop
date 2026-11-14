// Times a rescan of one library from two source trees, alternating sides, and checks that both
// give the same catalog. The change side keeps its receipt memo between scans, as the library does.
// The base side's scanCatalog returns the catalog itself and takes no receipt memory.
// usage: node rescan.mjs <baseTree> <changeTree> <libraryDir> [rounds] [scansPerRound]
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const [baseTree, changeTree, root, roundsArg, scansArg] = process.argv.slice(2);
const rounds = Number(roundsArg ?? 7);
const scans = Number(scansArg ?? 3);
registerHooks({
  resolve(specifier, context, next) {
    const extensionless = specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier);
    return next(extensionless ? `${specifier}.ts` : specifier, context);
  },
});
const load = async (tree) => ({
  ...(await import(join(tree, 'apps/desktop/src/library/catalog.ts'))),
  ...(await import(join(tree, 'apps/desktop/src/library/disk.ts'))),
  receipts: new Map(),
});
const sides = { base: await load(baseTree), change: await load(changeTree) };

function fingerprint(side, catalog) {
  const rows = [...catalog.revisions.values()].map((r) => [r.id, r.dir, JSON.stringify(r.record)]);
  return createHash('sha256')
    .update(
      JSON.stringify([
        rows,
        [...catalog.projectDirs],
        [...catalog.nodeDirs],
        [...catalog.blocked],
        side.toSnapshot(catalog),
      ]),
    )
    .digest('hex')
    .slice(0, 16);
}

async function scan(side) {
  const result = await side.scanCatalog(fs, root, side.receipts);
  if (!result.catalog) return result;
  side.receipts = result.receipts;
  return result.catalog;
}

const prints = new Set();
const first = {};
for (const [name, side] of Object.entries(sides)) {
  const t = performance.now();
  const catalog = await scan(side);
  first[name] = +(performance.now() - t).toFixed(1);
  prints.add(fingerprint(side, catalog));
}

const med = (a) => [...a].toSorted((x, y) => x - y)[Math.floor(a.length / 2)];
const medians = { base: [], change: [] };
let revisions = 0;
for (let round = 0; round < rounds; round += 1) {
  for (const name of round % 2 ? ['change', 'base'] : ['base', 'change']) {
    const side = sides[name];
    const times = [];
    for (let i = 0; i < scans; i += 1) {
      const t = performance.now();
      const catalog = await scan(side);
      times.push(performance.now() - t);
      revisions = catalog.revisions.size;
      if (i === 0) prints.add(fingerprint(side, catalog));
    }
    medians[name].push(med(times));
  }
}
const row = (a) => ({
  medianMs: +med(a).toFixed(1),
  minMs: +Math.min(...a).toFixed(1),
  maxMs: +Math.max(...a).toFixed(1),
});
console.log(
  JSON.stringify({
    revisions,
    sameCatalog: prints.size === 1,
    remembered: sides.change.receipts.size,
    firstScanMs: first,
    rounds,
    scansPerRound: scans,
    base: row(medians.base),
    change: row(medians.change),
  }),
);
