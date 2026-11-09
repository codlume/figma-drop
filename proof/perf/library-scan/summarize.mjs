// Prints median and range per library size and side.
// usage: node summarize.mjs <dir of run .json files | runs .jsonl>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const input = process.argv[2];
const runs = statSync(input).isDirectory()
  ? readdirSync(input)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({
        side: name.includes('-base-') ? 'base' : 'change',
        result: JSON.parse(readFileSync(join(input, name), 'utf8')),
      }))
  : readFileSync(input, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const range = (values) =>
  `${median(values).toFixed(0)} [${Math.min(...values).toFixed(0)}-${Math.max(...values).toFixed(0)}]`;
const groups = new Map();
for (const { side, result } of runs) {
  const key = `${result.seededRevisions}\t${side}`;
  groups.set(key, [...(groups.get(key) ?? []), result]);
}
console.log(
  'L\tside\tn\terrors\tunfinished\tbatchMs med [min-max]\tp50Sync med [min-max]\tsnapshot med [min-max]\tlaunch->shown med [min-max]',
);
for (const key of [...groups.keys()].sort()) {
  const group = groups.get(key);
  const errors = group.reduce((count, run) => count + run.errors.length, 0);
  const unfinished = group.filter(
    (run) => run.finalRevisions !== run.seededRevisions + run.batch,
  ).length;
  console.log(
    [
      key,
      group.length,
      errors,
      unfinished,
      range(group.map((run) => run.batchMs)),
      range(group.map((run) => median(run.syncLatencyMs))),
      range(group.map((run) => median(run.snapshotMs))),
      range(group.map((run) => run.launchToLibraryShownMs)),
    ].join('\t'),
  );
}
