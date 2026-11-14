// Builds the Electron entries under several bundler settings, each into its own directory, to show
// what each setting is worth. `as-built-before` and `minify` reproduce `vp pack` before and after.
// usage: node variants.mjs <outRoot> [variant ...]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { build } from 'vite-plus/pack';

import { desktopDir } from '../../shell/driver.mjs';

const [outRoot, ...only] = process.argv.slice(2);
const isExternal = (id) => id === 'electron' || id.startsWith('electron/');
const entries = {
  main: 'src/main/index.ts',
  preload: 'src/preload/index.ts',
  receiver: 'src/ingest/receiver-process.ts',
};

const variants = {
  'as-built-before': {},
  'comments-stripped': { outputOptions: { comments: false } },
  'minify-names-kept': { minify: { compress: true, mangle: false, codegen: true } },
  'minify-function-names-kept': {
    minify: { compress: true, mangle: { keepNames: true }, codegen: true },
  },
  minify: { minify: true },
  'minify-pure-property-reads': {
    minify: true,
    treeshake: { propertyReadSideEffects: false },
  },
};

for (const [name, extra] of Object.entries(variants)) {
  if (only.length > 0 && !only.includes(name)) continue;
  const outDir = join(outRoot, name);
  for (const [entryName, entry] of Object.entries(entries)) {
    await build({
      config: false,
      cwd: desktopDir,
      entry: { [entryName]: entry },
      format: 'cjs',
      platform: 'node',
      outDir,
      outExtensions: () => ({ js: '.cjs' }),
      dts: false,
      sourcemap: true,
      clean: false,
      logLevel: 'silent',
      deps: {
        alwaysBundle: (id) => !id.startsWith('node:') && !isExternal(id),
        neverBundle: isExternal,
        onlyBundle: false,
      },
      ...extra,
      outputOptions: { codeSplitting: false, ...extra.outputOptions },
    });
  }
  const sizes = Object.keys(entries).map((entryName) => {
    const bytes = readFileSync(join(outDir, `${entryName}.cjs`));
    return `${entryName} ${bytes.length} (gzip ${gzipSync(bytes).length})`;
  });
  console.log(`${name.padEnd(28)} ${sizes.join('  ')}`);
}
