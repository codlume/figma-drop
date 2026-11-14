// Attributes every byte of a bundle to the source its sourcemap names for it.
// usage: node breakdown.mjs <bundle.cjs> [--top N] [--shared-with <other.cjs>]
// With --shared-with, also sums the modules that both bundles carry.
import { readFileSync, statSync } from 'node:fs';

const [file, ...flags] = process.argv.slice(2);
const flag = (name) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined);
const top = Number(flag('--top') ?? 20);

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeSegment(text) {
  const values = [];
  let shift = 0;
  let value = 0;
  for (const char of text) {
    const digit = BASE64.indexOf(char);
    value |= (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    values.push(value & 1 ? -(value >>> 1) : value >>> 1);
    shift = 0;
    value = 0;
  }
  return values;
}

const moduleName = (source) => {
  const dependency = source.match(/node_modules\/\.pnpm\/[^/]+\/node_modules\/(.+)$/);
  return dependency ? `npm:${dependency[1]}` : source.replace(/^(\.\.\/)+/, '');
};
const packageName = (name) => {
  if (name === '(unmapped)') return name;
  const parts = name.replace(/^npm:/, '').split('/');
  const depth = name.startsWith('npm:') ? (parts[0].startsWith('@') ? 2 : 1) : 2;
  return `${name.startsWith('npm:') ? 'npm:' : ''}${parts.slice(0, depth).join('/')}`;
};

function attribute(bundle) {
  const code = readFileSync(bundle, 'utf8');
  const map = JSON.parse(readFileSync(`${bundle}.map`, 'utf8'));
  const lines = code.split('\n');
  const mappings = map.mappings.split(';');
  const bytes = new Map();
  const add = (source, text) =>
    bytes.set(source, (bytes.get(source) ?? 0) + Buffer.byteLength(text));

  let sourceIndex = 0;
  // Text before a line's first segment continues the previous source: a statement or comment that
  // spans lines is mapped once, at its start.
  let current = '(unmapped)';
  for (const [lineNo, line] of lines.entries()) {
    const newline = lineNo < lines.length - 1 ? '\n' : '';
    const segments = [];
    let column = 0;
    for (const raw of (mappings[lineNo] ?? '').split(',')) {
      if (raw === '') continue;
      const fields = decodeSegment(raw);
      column += fields[0];
      if (fields.length >= 4) sourceIndex += fields[1];
      segments.push([column, fields.length >= 4 ? map.sources[sourceIndex] : '(unmapped)']);
    }
    add(current, line.slice(0, segments[0]?.[0] ?? line.length));
    for (const [i, [start, source]] of segments.entries()) {
      current = source;
      add(current, line.slice(start, segments[i + 1]?.[0] ?? line.length));
    }
    add(current, newline);
  }

  const modules = new Map();
  for (const [source, size] of bytes) {
    const name = source === '(unmapped)' ? source : moduleName(source);
    modules.set(name, (modules.get(name) ?? 0) + size);
  }
  return { code, map, lines, modules };
}

const { code, map, lines, modules } = attribute(file);
const total = Buffer.byteLength(code);
const attributed = [...modules.values()].reduce((sum, size) => sum + size, 0);
const descending = (entries) => [...entries].toSorted((a, b) => b[1] - a[1]);
const row = ([name, size]) =>
  `${String(size).padStart(8)} ${`${((100 * size) / total).toFixed(1)}%`.padStart(6)}  ${name}`;

const packages = new Map();
for (const [name, size] of modules)
  packages.set(packageName(name), (packages.get(packageName(name)) ?? 0) + size);

console.log(`${file}: ${total} bytes in ${lines.length} lines, ${attributed} attributed`);
console.log('\nby package');
console.log(descending(packages).map(row).join('\n'));
console.log(`\ntop ${top} of ${modules.size} modules`);
console.log(descending(modules).slice(0, top).map(row).join('\n'));

const EFFECT = '/node_modules/effect/';
const effectSources = map.sources.filter((source) => source.includes(EFFECT));
const roots = new Set(effectSources.map((source) => source.split(EFFECT)[0]));
const builds = new Set(effectSources.map((source) => source.split(EFFECT)[1].split('/')[0]));
const paths = new Map();
for (const source of map.sources)
  paths.set(moduleName(source), (paths.get(moduleName(source)) ?? new Set()).add(source));
const repeated = [...paths].filter(([, sources]) => sources.size > 1).map(([name]) => name);
console.log(`\neffect copies: ${roots.size} install, build directories ${[...builds].join(', ')}`);
console.log(`modules bundled from more than one path: ${repeated.join(', ') || 'none'}`);

const contentBytes = (wanted) =>
  map.sources.reduce(
    (sum, source, i) =>
      sum + (source.includes(EFFECT) === wanted ? Buffer.byteLength(map.sourcesContent[i]) : 0),
    0,
  );
console.log(
  `${file}.map: ${statSync(`${file}.map`).size} bytes, sources embedded: effect ${contentBytes(true)}, other ${contentBytes(false)}`,
);

const other = flag('--shared-with');
if (other) {
  const theirs = attribute(other).modules;
  const shared = [...modules].filter(([name]) => name !== '(unmapped)' && theirs.has(name));
  const sum = (entries) =>
    entries.reduce((n, [name, size]) => n + Math.min(size, theirs.get(name)), 0);
  console.log(
    `\nmodules also in ${other}: ${shared.length}, ${sum(shared)} bytes, of which effect ${sum(shared.filter(([name]) => name.startsWith('npm:effect/')))}`,
  );
}
