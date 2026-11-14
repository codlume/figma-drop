// Median and range per build over the runs alt.sh wrote.
// usage: node summarize.mjs <outDir>
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const runs = {};
for (const name of readdirSync(dir)) {
  const m = /^(.+)-(\d+)\.json$/.exec(name);
  if (!m) continue;
  (runs[m[1]] ??= []).push(JSON.parse(readFileSync(join(dir, name), 'utf8')));
}
const rounded = (v) => (v >= 100 ? Math.round(v) : +v.toFixed(1));
const fmt = (values) => {
  const s = values.filter((v) => typeof v === 'number').toSorted((a, b) => a - b);
  if (!s.length) return 'n/a';
  return `${rounded(s[Math.floor(s.length / 2)])} [${rounded(s[0])}–${rounded(s[s.length - 1])}]`;
};
const measures = {
  'batch total ms': (r) => r.batchMs,
  'batch until shown ms': (r) => r.batchUntilShownMs,
  'reply p50 ms': (r) => r.perExportMs?.p50,
  'reply p90 ms': (r) => r.perExportMs?.p90,
  'reply max ms': (r) => r.perExportMs?.max,
  'main CPU ms': (r) => r.cpuUntilShown?.main?.cpuMs,
  'renderer CPU ms': (r) => r.cpuUntilShown?.renderer?.cpuMs,
  'receiver CPU ms': (r) => r.cpuUntilShown?.['utility:node.mojom.NodeService']?.cpuMs,
  'launch to library shown ms': (r) => r.launchToLibraryShownMs,
  'reopen to library shown ms': (r) => r.reopenToLibraryShownMs,
  'focus to refreshed ms': (r) => r.focusRefreshMs,
  'focus main CPU ms': (r) => r.focusMainCpuMs,
};
for (const [build, list] of Object.entries(runs)) {
  const errors = list.reduce((n, r) => n + r.errors.length, 0);
  console.log(`${build}: ${list.length} runs, ${errors} errors`);
  for (const [label, pick] of Object.entries(measures)) {
    const text = fmt(list.map(pick));
    if (text !== 'n/a') console.log(`  ${label.padEnd(28)} ${text}`);
  }
}
