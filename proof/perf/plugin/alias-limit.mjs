// How many variable aliases can one export hold before collectVariables throws?
//   node alias-limit.mjs <apps/figma-plugin/src>
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const src = resolve(process.argv[2]);
const load = (file) => import(pathToFileURL(join(src, file)).href);
const { createFakeFigma } = await load('sandbox/testing/fake-figma.ts');
const { collectVariables } = await load('sandbox/variables.ts');

for (const count of [50_000, 100_000, 125_000, 150_000, 200_000, 400_000, 1_000_000]) {
  const fake = createFakeFigma();
  fake.addCollection({ id: 'C', name: 'Theme', modes: [{ modeId: 'm', name: 'Light' }] });
  fake.addVariable({
    id: 'V',
    name: 'space',
    resolvedType: 'FLOAT',
    variableCollectionId: 'C',
    valuesByMode: { m: 8 },
  });
  const nodes = Array.from({ length: count }, () => ({
    boundVariables: { itemSpacing: { type: 'VARIABLE_ALIAS', id: 'V' } },
  }));
  try {
    const start = performance.now();
    const variables = await collectVariables(fake.figma, nodes);
    console.log(
      `${count} aliases: ok, ${variables.tokens.length} token, ${(performance.now() - start).toFixed(0)} ms`,
    );
  } catch (error) {
    console.log(`${count} aliases: ${error.constructor.name}: ${error.message}`);
  }
}
