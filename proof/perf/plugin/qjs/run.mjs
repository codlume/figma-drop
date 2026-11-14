// Runs the sandbox export inside QuickJS compiled to WebAssembly, an interpreter
// with no JIT. One process, one side, one document. Prints one JSON line.
//   node run.mjs --src <apps/figma-plugin/src> --doc page [--iters 3] [--warmup 1]
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { getQuickJS } from 'quickjs-emscripten';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, index, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const src = resolve(args.src);

const entry = `
import { buildDocument, DOCUMENTS } from ${JSON.stringify(join(here, '../docs.mjs'))};
import { createFakeFigma } from ${JSON.stringify(join(src, 'sandbox/testing/fake-figma.ts'))};
import { exportNode } from ${JSON.stringify(join(src, 'sandbox/export-node.ts'))};
import { serializeTree } from ${JSON.stringify(join(src, 'sandbox/serialize.ts'))};
import { collectComponents } from ${JSON.stringify(join(src, 'sandbox/components.ts'))};
import { resolveRemoteMasters } from ${JSON.stringify(join(src, 'sandbox/remote-masters.ts'))};
import { collectStyles } from ${JSON.stringify(join(src, 'sandbox/styles.ts'))};
import { collectVariables } from ${JSON.stringify(join(src, 'sandbox/variables.ts'))};
import { collectIcons } from ${JSON.stringify(join(src, 'sandbox/icons.ts'))};
import { collectImages } from ${JSON.stringify(join(src, 'sandbox/images.ts'))};
import { tallyTree } from ${JSON.stringify(join(src, 'sandbox/summary.ts'))};

// Asset bytes are opaque to the sandbox, so they stay tiny here: filling megabytes
// one byte at a time in an interpreter would only time the fixture.
const SMALL = { imageBytes: 64, pngBytes: 64, svgRasters: 0 };
const fnv = (text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16);
};
globalThis.__run = async (docName, warmup, iters) => {
  const { fake, root } = buildDocument(createFakeFigma, { ...DOCUMENTS[docName], ...SMALL });
  const times = [];
  let raw;
  const cpuTimes = [];
  for (let i = 0; i < warmup + iters; i += 1) {
    const start = Date.now();
    const cpuStart = __cpu();
    raw = await exportNode(fake.figma, root);
    if (i >= warmup) {
      times.push(Date.now() - start);
      cpuTimes.push(__cpu() - cpuStart);
    }
  }
  const text = JSON.stringify({ ...raw, exportedAt: 'fixed' }, (key, value) =>
    value instanceof Uint8Array ? Array.from(value) : value,
  );
  return JSON.stringify({ times, cpuTimes, totalNodes: raw.summary.totalNodes, chars: text.length, fnv: fnv(text) });
};

globalThis.__phases = async (docName, warmup, iters) => {
  const { fake, root } = buildDocument(createFakeFigma, { ...DOCUMENTS[docName], ...SMALL });
  const { figma } = fake;
  const totals = {};
  const phase = async (name, task, counted) => {
    const start = __cpu();
    const result = await task();
    if (counted) totals[name] = (totals[name] ?? 0) + (__cpu() - start);
    return result;
  };
  for (let i = 0; i < warmup + iters; i += 1) {
    const on = i >= warmup;
    const { tree } = await phase('serializeTree', () => serializeTree(figma, root, 40000), on);
    const entries = await phase('collectComponents', () => collectComponents(root), on);
    const { remoteMasters } = await phase('resolveRemoteMasters', () => resolveRemoteMasters(figma, entries), on);
    const styles = await phase('collectStyles', () => collectStyles(figma, [tree, ...remoteMasters]), on);
    await phase('collectVariables', () => collectVariables(figma, [tree, remoteMasters, styles]), on);
    await phase('collectIcons', () => collectIcons(root), on);
    await phase('collectImages', () => collectImages(figma, root), on);
    await phase('tallyTree', () => tallyTree(tree), on);
    await phase('exportNode', () => exportNode(figma, root), on);
  }
  for (const name of Object.keys(totals)) totals[name] = Math.round(totals[name] / iters);
  return JSON.stringify({ phasesMs: totals });
};
`;

const prelude = `
globalThis.setTimeout = (callback) => { Promise.resolve().then(callback); };
globalThis.TextEncoder = class { encode(text) { const out = new Uint8Array(text.length); for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 255; return out; } };
globalThis.btoa = () => '';
`;

const dir = mkdtempSync(join(tmpdir(), 'qjs-entry-'));
const entryFile = join(dir, 'entry.mjs');
writeFileSync(entryFile, entry);
const bundled = await build({
  entryPoints: [entryFile],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  logLevel: 'silent',
});
const code = prelude + bundled.outputFiles[0].text;

const QuickJS = await getQuickJS();
const vm = QuickJS.newContext();
if (args.stack !== 'default') vm.runtime.setMaxStackSize(0);
// Process CPU time in ms. Wall time swings with the other jobs on this machine.
const cpuClock = vm.newFunction('__cpu', () => {
  const { user, system } = process.cpuUsage();
  return vm.newNumber((user + system) / 1000);
});
vm.setProp(vm.global, '__cpu', cpuClock);
cpuClock.dispose();
vm.unwrapResult(vm.evalCode(code)).dispose();
const promise = vm.unwrapResult(
  vm.evalCode(
    `${args.mode === 'phases' ? '__phases' : '__run'}(${JSON.stringify(args.doc)}, ${Number(args.warmup ?? 1)}, ${Number(args.iters ?? 3)})`,
  ),
);
const settled = vm.resolvePromise(promise);
const start = performance.now();
vm.unwrapResult(vm.runtime.executePendingJobs());
const result = vm.unwrapResult(await settled);
const report = JSON.parse(vm.getString(result));
result.dispose();
promise.dispose();
const sorted = [...(report.times ?? [0])].sort((a, b) => a - b);
console.log(
  JSON.stringify({
    engine: 'quickjs-emscripten 0.32.0',
    doc: args.doc,
    src: args.src,
    ...report,
    medianMs: sorted[sorted.length >> 1],
    cpuMedianMs: [...(report.cpuTimes ?? [0])].sort((a, b) => a - b)[
      (report.cpuTimes ?? [0]).length >> 1
    ],
    cpuMinMs: Math.min(...(report.cpuTimes ?? [0])),
    hostMs: Math.round(performance.now() - start),
  }),
);
