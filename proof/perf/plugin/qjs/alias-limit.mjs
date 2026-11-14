// The alias-count probe of ../alias-limit.mjs, inside QuickJS.
//   node alias-limit.mjs <apps/figma-plugin/src>
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { getQuickJS } from 'quickjs-emscripten';

const src = resolve(process.argv[2]);
const entry = `
import { createFakeFigma } from ${JSON.stringify(join(src, 'sandbox/testing/fake-figma.ts'))};
import { collectVariables } from ${JSON.stringify(join(src, 'sandbox/variables.ts'))};
globalThis.__probe = async (count) => {
  const fake = createFakeFigma();
  fake.addCollection({ id: 'C', name: 'Theme', modes: [{ modeId: 'm', name: 'Light' }] });
  fake.addVariable({ id: 'V', name: 'space', resolvedType: 'FLOAT', variableCollectionId: 'C', valuesByMode: { m: 8 } });
  const nodes = Array.from({ length: count }, () => ({
    boundVariables: { itemSpacing: { type: 'VARIABLE_ALIAS', id: 'V' } },
  }));
  try {
    const variables = await collectVariables(fake.figma, nodes);
    return count + ' aliases: ok, ' + variables.tokens.length + ' token';
  } catch (error) {
    return count + ' aliases: ' + error.name + ': ' + error.message;
  }
};
`;
const dir = mkdtempSync(join(tmpdir(), 'qjs-alias-'));
writeFileSync(join(dir, 'entry.mjs'), entry);
const bundled = await build({
  entryPoints: [join(dir, 'entry.mjs')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  logLevel: 'silent',
});
const QuickJS = await getQuickJS();
for (const count of [30_000, 60_000, 70_000, 150_000, 400_000]) {
  // The default context keeps QuickJS's own stack limit, as an embedder would.
  const vm = QuickJS.newContext();
  vm.unwrapResult(
    vm.evalCode(
      `globalThis.TextEncoder = class { encode() { return new Uint8Array(4); } };${bundled.outputFiles[0].text}`,
    ),
  ).dispose();
  const promise = vm.unwrapResult(vm.evalCode(`__probe(${count})`));
  const settled = vm.resolvePromise(promise);
  vm.unwrapResult(vm.runtime.executePendingJobs());
  const result = vm.unwrapResult(await settled);
  console.log(vm.getString(result));
  result.dispose();
  promise.dispose();
}
