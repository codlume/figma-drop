// Bundles the ingest internals of one source tree with the same options the
// receiver entry ships with, so phase timings run the code production runs.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [treeArg, outArg] = process.argv.slice(2);
const tree = resolve(treeArg);
const outDir = resolve(outArg);
const desktop = join(tree, 'apps/desktop');
const require = createRequire(join(desktop, 'package.json'));
const { build } = await import(
  pathToFileURL(join(require.resolve('vite-plus/package.json'), '../dist/pack.js')).href
);

await mkdir(outDir, { recursive: true });
const entry = join(desktop, 'src/ingest/zz-phase-entry.ts');
await writeFile(
  entry,
  `export { prepareExport, stageExport } from './export-pipeline';
export { exceedsValueBudget } from './json-budget';
export { hashExport } from './content-hash';
export { buildBundleFiles } from './bundle';
export { parseExportPayload, classifyFileIdentity } from '@figma-drop/export-contract/parser';
`,
);
const isExternal = (id) => id === 'electron' || id.startsWith('electron/');
try {
  await build({
    config: false,
    cwd: desktop,
    entry: { phase: entry },
    format: 'cjs',
    platform: 'node',
    outDir,
    outExtensions: () => ({ js: '.cjs' }),
    dts: false,
    sourcemap: true,
    minify: process.env.MINIFY !== '0',
    clean: false,
    outputOptions: { codeSplitting: false },
    deps: {
      alwaysBundle: (id) => !id.startsWith('node:') && !isExternal(id),
      neverBundle: isExternal,
      onlyBundle: false,
    },
    logLevel: 'warn',
  });
} finally {
  const { rm } = await import('node:fs/promises');
  await rm(entry, { force: true });
}
