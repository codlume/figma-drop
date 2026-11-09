// Times scanCatalog and toSnapshot separately on a seeded library, and fingerprints the result.
// usage: node scan.mjs <repo> <libraryDir> <runs>
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const [repo, root, runsArg] = process.argv.slice(2);
registerHooks({
  resolve(specifier, context, next) {
    const extensionless = specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier);
    return next(extensionless ? `${specifier}.ts` : specifier, context);
  },
});
const { scanCatalog } = await import(join(repo, 'apps/desktop/src/library/disk.ts'));
const { toSnapshot } = await import(join(repo, 'apps/desktop/src/library/catalog.ts'));

const scan = [];
const shape = [];
const clone = [];
let fingerprint;
for (let i = 0; i < Number(runsArg); i += 1) {
  const t0 = performance.now();
  const catalog = await scanCatalog(fs, root);
  const t1 = performance.now();
  const snapshot = toSnapshot(catalog);
  const t2 = performance.now();
  structuredClone(snapshot);
  const t3 = performance.now();
  scan.push(t1 - t0);
  shape.push(t2 - t1);
  clone.push(t3 - t2);
  const rows = [...catalog.revisions.values()].map((r) => [
    r.id,
    r.dir,
    r.record.state,
    JSON.stringify(r.record),
  ]);
  const fp = createHash('sha256')
    .update(
      JSON.stringify([
        rows,
        [...catalog.projectDirs],
        [...catalog.nodeDirs],
        [...catalog.blocked],
        snapshot,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
  if (fingerprint && fp !== fingerprint) throw new Error('scan result changed between runs');
  fingerprint = fp;
}
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(
  JSON.stringify({
    root,
    fingerprint,
    scanMed: med(scan),
    scanMin: Math.min(...scan),
    scanMax: Math.max(...scan),
    shapeMed: med(shape),
    cloneMed: med(clone),
    scan,
    shape,
  }),
);
