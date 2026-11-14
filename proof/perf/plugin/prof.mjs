// Summarizes a .cpuprofile: self time by function and by file, inside a time window.
//   node prof.mjs <file.cpuprofile> [top=25] [--inclusive name,name]
import { readFileSync } from 'node:fs';

const [file, topArg] = process.argv.slice(2);
const top = Number(topArg ?? 25);
const profile = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes)
  for (const child of node.children ?? []) parent.set(child, node.id);

const self = new Map();
let total = 0;
for (let i = 0; i < profile.samples.length; i += 1) {
  const delta = profile.timeDeltas[i] ?? 0;
  self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + delta);
  total += delta;
}

const label = (node) => {
  const { functionName, url, lineNumber } = node.callFrame;
  const short = url
    .replace(/^.*\/(apps|packages|node_modules)\//, '$1/')
    .replace(/^file:\/\/.*\//, '');
  return `${functionName || '(anonymous)'}  ${short}:${lineNumber + 1}`;
};

const selfByFunction = new Map();
const selfByFile = new Map();
const inclusive = new Map();
for (const [id, micros] of self) {
  const node = byId.get(id);
  const name = label(node);
  selfByFunction.set(name, (selfByFunction.get(name) ?? 0) + micros);
  const fileName = node.callFrame.url.replace(/^.*\//, '') || `(${node.callFrame.functionName})`;
  selfByFile.set(fileName, (selfByFile.get(fileName) ?? 0) + micros);
  const seen = new Set();
  for (let at = id; at !== undefined; at = parent.get(at)) {
    const frame = label(byId.get(at));
    if (seen.has(frame)) continue;
    seen.add(frame);
    inclusive.set(frame, (inclusive.get(frame) ?? 0) + micros);
  }
}

const print = (title, map, limit) => {
  console.log(`\n${title}`);
  for (const [name, micros] of [...map].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
    console.log(
      `${(micros / 1000).toFixed(1).padStart(9)} ms ${((micros / total) * 100).toFixed(1).padStart(5)}%  ${name}`,
    );
  }
};
console.log(`total ${(total / 1000).toFixed(1)} ms over ${profile.samples.length} samples`);
print('self time by file', selfByFile, 14);
print('self time by function', selfByFunction, top);
print('inclusive time by function', inclusive, top);

const wanted = (process.argv[4] ?? '').split(',').filter(Boolean);
for (const name of wanted) {
  const lines = new Map();
  let ticks = 0;
  for (const node of profile.nodes) {
    if (node.callFrame.functionName !== name) continue;
    const fileName = node.callFrame.url.replace(/^.*\//, '');
    for (const { line, ticks: count } of node.positionTicks ?? []) {
      lines.set(`${fileName}:${line}`, (lines.get(`${fileName}:${line}`) ?? 0) + count);
      ticks += count;
    }
  }
  console.log(`\nline ticks in ${name} (${ticks} ticks)`);
  for (const [line, count] of [...lines].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(
      `${String(count).padStart(8)} ${((count / ticks) * 100).toFixed(1).padStart(5)}%  ${line}`,
    );
  }
}
