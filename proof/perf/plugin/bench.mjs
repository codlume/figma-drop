// One process, one side, one document. Prints a single JSON line.
//   node bench.mjs --src <apps/figma-plugin/src> --doc <name> --mode <export|phases|ui|dump|counts>
//                  [--iters 7] [--warmup 3] [--out file] [--sink http://127.0.0.1:port]
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDocument, DOCUMENTS } from './docs.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, index, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const src = resolve(args.src);
const mode = args.mode ?? 'export';
const iters = Number(args.iters ?? 7);
const warmup = Number(args.warmup ?? 3);
const spec = DOCUMENTS[args.doc];
if (!spec) throw new Error(`unknown --doc ${args.doc}`);

const load = (file) => import(pathToFileURL(join(src, file)).href);
const { createFakeFigma } = await load('sandbox/testing/fake-figma.ts');
const { exportNode } = await load('sandbox/export-node.ts');

const FIXED_TIME = '2026-01-01T00:00:00.000Z';
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const stats = (values) => ({
  median: median(values),
  min: Math.min(...values),
  max: Math.max(...values),
});

async function timed(task) {
  const cpuBefore = process.cpuUsage();
  const start = performance.now();
  const result = await task();
  const wall = performance.now() - start;
  const cpu = process.cpuUsage(cpuBefore);
  return { result, wall, cpu: (cpu.user + cpu.system) / 1000 };
}

async function wireBody(raw) {
  const { encodeExport } = await load('ui/payload.ts');
  return JSON.stringify(encodeExport({ ...raw, exportedAt: FIXED_TIME }));
}

function describe(raw) {
  const { totalNodes, truncated } = raw.summary;
  return {
    totalNodes,
    truncated,
    components: raw.components.length,
    remoteMasters: raw.remoteMasters.length,
    tokens: raw.variables?.tokens.length ?? 0,
    styles: raw.styles?.styles.length ?? 0,
    icons: raw.icons.length,
    images: raw.images.length,
  };
}

const output = { mode, doc: args.doc, src: args.src, node: process.version };

if (mode === 'export') {
  const { fake, root } = buildDocument(createFakeFigma, spec);
  for (let i = 0; i < warmup; i += 1) await exportNode(fake.figma, root);
  const wall = [];
  const cpu = [];
  let raw;
  for (let i = 0; i < iters; i += 1) {
    const run = await timed(() => exportNode(fake.figma, root));
    wall.push(run.wall);
    cpu.push(run.cpu);
    raw = run.result;
  }
  const body = await wireBody(raw);
  Object.assign(output, {
    shape: describe(raw),
    wallMs: stats(wall),
    cpuMs: stats(cpu),
    cpuMinMs: Math.min(...cpu),
    wall,
    bodyBytes: Buffer.byteLength(body),
    sha256: createHash('sha256').update(body).digest('hex'),
  });
}

if (mode === 'dump') {
  const { fake, root } = buildDocument(createFakeFigma, spec);
  const raw = await exportNode(fake.figma, root);
  const body = await wireBody(raw);
  if (args.out) writeFileSync(args.out, body);
  // The sandbox message must survive Figma's structured clone unchanged.
  const cloned = structuredClone({ type: 'node-exported', nodeId: root.id, raw });
  const clonedBody = await wireBody(cloned.raw);
  Object.assign(output, {
    shape: describe(raw),
    bodyBytes: Buffer.byteLength(body),
    sha256: createHash('sha256').update(body).digest('hex'),
    cloneMatches: clonedBody === body,
  });
}

if (mode === 'phases') {
  const { serializeTree } = await load('sandbox/serialize.ts');
  const { collectComponents } = await load('sandbox/components.ts');
  const { resolveRemoteMasters } = await load('sandbox/remote-masters.ts');
  const { collectStyles } = await load('sandbox/styles.ts');
  const { collectVariables } = await load('sandbox/variables.ts');
  const { collectIcons } = await load('sandbox/icons.ts');
  const { collectImages } = await load('sandbox/images.ts');
  const { tallyTree } = await load('sandbox/summary.ts');
  const { renderPreviews } = await load('sandbox/previews.ts');
  const { fake, root } = buildDocument(createFakeFigma, spec);
  const { figma } = fake;
  const samples = {};
  const phase = async (name, task) => {
    const run = await timed(task);
    (samples[name] ??= []).push(run.wall);
    return run.result;
  };
  for (let i = 0; i < warmup + iters; i += 1) {
    if (i === warmup) for (const key of Object.keys(samples)) samples[key] = [];
    const { tree } = await phase('serializeTree', () => serializeTree(figma, root, 40000));
    const entries = await phase('collectComponents', () => collectComponents(root));
    const { remoteMasters } = await phase('resolveRemoteMasters', () =>
      resolveRemoteMasters(figma, entries),
    );
    const styles = await phase('collectStyles', () =>
      collectStyles(figma, [tree, ...remoteMasters]),
    );
    await phase('collectVariables', () => collectVariables(figma, [tree, remoteMasters, styles]));
    await phase('collectIcons', () => collectIcons(root));
    await phase('collectImages', () => collectImages(figma, root));
    const tally = await phase('tallyTree', () => tallyTree(tree));
    await phase('renderPreviews', () => renderPreviews(root, tally.totalNodes));
    await phase('exportNode', () => exportNode(figma, root));
  }
  output.phasesMs = Object.fromEntries(
    Object.entries(samples).map(([name, values]) => [name, stats(values)]),
  );
}

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

if (mode === 'counts') {
  const reads = new Map();
  const calls = new Map();
  let paused = 0;
  const counting = (name, fn) =>
    function counted(...callArgs) {
      bump(calls, name);
      return fn.apply(this, callArgs);
    };
  const handler = {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, target);
      if (typeof key !== 'string') return value;
      if (paused === 0 && typeof value !== 'function') bump(reads, key);
      if (typeof value !== 'function') return value;
      if (key === 'findAllWithCriteria') {
        // The fake walks its own tree here. Those reads are not the plugin's.
        return (...callArgs) => {
          bump(calls, key);
          paused += 1;
          try {
            return value.apply(receiver, callArgs);
          } finally {
            paused -= 1;
          }
        };
      }
      return counting(key, value).bind(target);
    },
  };
  const instrumented = (options) => {
    const fake = createFakeFigma(options);
    const node = (type, nodeSpec) => new Proxy(fake.node(type, nodeSpec), handler);
    const figma = new Proxy(fake.figma, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === 'variables') {
          return new Proxy(value, {
            get: (inner, innerKey) =>
              typeof inner[innerKey] === 'function'
                ? counting(`variables.${String(innerKey)}`, inner[innerKey])
                : inner[innerKey],
          });
        }
        return typeof value === 'function' ? counting(String(key), value).bind(target) : value;
      },
    });
    return { ...fake, node, figma };
  };
  const { fake, root } = buildDocument(instrumented, spec);
  const raw = await exportNode(fake.figma, root);
  const totalReads = [...reads.values()].reduce((sum, count) => sum + count, 0);
  Object.assign(output, {
    shape: describe(raw),
    nodePropertyReads: totalReads,
    readsPerNode: totalReads / raw.summary.totalNodes,
    topReads: Object.fromEntries([...reads].sort((a, b) => b[1] - a[1]).slice(0, 12)),
    calls: Object.fromEntries([...calls].sort((a, b) => b[1] - a[1])),
  });
}

if (mode === 'ui') {
  const { encodeExport } = await load('ui/payload.ts');
  const { sendExport } = await load('ui/transport.ts');
  const { fake, root } = buildDocument(createFakeFigma, spec);
  const exported = await exportNode(fake.figma, root);
  const samples = { clone: [], encode: [], stringify: [], send: [], total: [] };
  let bodyBytes = 0;
  let outcomes = {};
  for (let i = 0; i < warmup + iters; i += 1) {
    if (i === warmup) {
      for (const key of Object.keys(samples)) samples[key] = [];
      outcomes = {};
    }
    const clone = await timed(() => structuredClone({ type: 'node-exported', raw: exported }));
    const encode = await timed(() => encodeExport(clone.result.raw));
    const stringify = await timed(() => JSON.stringify(encode.result));
    bodyBytes = Buffer.byteLength(stringify.result);
    const send = await timed(() => sendExport(encode.result, { baseUrl: args.sink }));
    outcomes[send.result.kind] = (outcomes[send.result.kind] ?? 0) + 1;
    if (send.result.kind === 'saved' && Number(send.result.path) !== bodyBytes) {
      throw new Error(`sink saw ${send.result.path} bytes, sent ${bodyBytes}`);
    }
    samples.clone.push(clone.wall);
    samples.encode.push(encode.wall);
    samples.stringify.push(stringify.wall);
    samples.send.push(send.wall);
    samples.total.push(clone.wall + encode.wall + send.wall);
  }
  Object.assign(output, {
    shape: describe(exported),
    bodyBytes,
    outcomes,
    uiMs: Object.fromEntries(
      Object.entries(samples).map(([name, values]) => [name, stats(values)]),
    ),
  });
}

console.log(JSON.stringify(output));
