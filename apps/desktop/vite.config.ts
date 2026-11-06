import { existsSync } from 'node:fs';
import * as NodeURL from 'node:url';

import stylex from '@stylexjs/unplugin';
import react from '@vitejs/plugin-react';
import 'vite-plus/test/config';
import { defineConfig } from 'vite-plus';

const appDir = NodeURL.fileURLToPath(new URL('.', import.meta.url));
const rendererDir = `${appDir}src/renderer`;
const rendererTestSetup = `${rendererDir}/test-setup.ts`;

export default defineConfig({
  root: rendererDir,
  base: './',
  plugins: [stylex.vite({ useCSSLayers: true }), react()],
  server: { port: 5791, strictPort: true },
  // StyleX's dev transform calls this.load() on each import, so a *.stylex.ts file requested during
  // the first crawl waits on a pre-bundled dependency, which by default waits for the crawl to end.
  optimizeDeps: { holdUntilCrawlEnd: false },
  build: {
    outDir: `${appDir}dist/renderer`,
    emptyOutDir: true,
    rollupOptions: { input: { index: `${rendererDir}/index.html` } },
  },
  test: {
    root: appDir,
    // The StyleX plugin delays worker exit by 10 s without this. Removing the plugin in tests is
    // not an option, because `stylex.create` then throws at runtime.
    teardownTimeout: 500,
    projects: [
      {
        extends: true,
        test: {
          name: 'renderer',
          root: appDir,
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: existsSync(rendererTestSetup) ? [rendererTestSetup] : [],
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          root: appDir,
          environment: 'node',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['src/renderer/**'],
        },
      },
    ],
  },
});
