// usage: node profsum.mjs <file.cpuprofile> [top]
// Self time per function, plus inclusive time for named roots.
import { readFileSync } from 'node:fs';

const [file, topArg] = process.argv.slice(2);
const top = Number(topArg ?? 25);
const profile = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const self = new Map();
const deltas = profile.timeDeltas;
for (let i = 0; i < profile.samples.length; i += 1) {
  self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (deltas[i] ?? 0));
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
const label = (node) => {
  const { functionName, url, lineNumber } = node.callFrame;
  const where = url ? `${url.split('/').pop()}:${lineNumber + 1}` : '(native)';
  return `${functionName || '(anonymous)'} ${where}`;
};
const flat = new Map();
for (const [id, micros] of self) {
  const key = label(byId.get(id));
  flat.set(key, (flat.get(key) ?? 0) + micros);
}
const inclusive = new Map();
const walk = (node, stack) => {
  const key = label(node);
  const seen = stack.includes(key);
  const mine = self.get(node.id) ?? 0;
  let sum = mine;
  for (const child of node.children ?? [])
    sum += walk(byId.get(child), seen ? stack : [...stack, key]);
  if (!seen) inclusive.set(key, (inclusive.get(key) ?? 0) + sum);
  return sum;
};
walk(profile.nodes[0], []);
const fmt = (micros) =>
  `${(micros / 1000).toFixed(0).padStart(8)} ms ${((100 * micros) / total).toFixed(1).padStart(5)}%`;
console.log(`total ${(total / 1000).toFixed(0)} ms, ${profile.samples.length} samples`);
console.log('--- self');
for (const [key, micros] of [...flat].sort((a, b) => b[1] - a[1]).slice(0, top))
  console.log(fmt(micros), key);
console.log('--- inclusive');
for (const [key, micros] of [...inclusive].sort((a, b) => b[1] - a[1]).slice(0, top))
  console.log(fmt(micros), key);
