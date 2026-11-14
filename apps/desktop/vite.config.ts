import * as NodeURL from 'node:url';

import stylex from '@stylexjs/unplugin';
import react from '@vitejs/plugin-react';
import 'vite-plus/test/config';
import { defineConfig, type Plugin } from 'vite-plus';

const appDir = NodeURL.fileURLToPath(new URL('.', import.meta.url));
const rendererDir = `${appDir}src/renderer`;
const DEV_SERVER_PORT = 5791;

const isExternal = (id: string) => id === 'electron' || id.startsWith('electron/');

const electronEntry = (name: 'main' | 'preload' | 'receiver', entry: string) => ({
  entry: { [name]: entry },
  format: 'cjs' as const,
  platform: 'node' as const,
  outDir: 'dist-electron',
  outExtensions: () => ({ js: '.cjs' }),
  dts: false,
  sourcemap: true,
  // An unminified bundle keeps the JSDoc of every bundled dependency, over a third of its bytes.
  minify: true,
  // Entries share this directory.
  clean: false,
  outputOptions: { codeSplitting: false },
  deps: {
    alwaysBundle: (id: string) => !id.startsWith('node:') && !isExternal(id),
    neverBundle: isExternal,
    onlyBundle: false as const,
  },
});

// Packaged windows load over file://, which carries no response headers, so the policy rides in a
// meta tag. The dev server injects inline scripts (React Refresh), admitted by a nonce, and the
// StyleX dev runtime writes un-nonced <style> elements, so dev styles allow inline.
// Fixed on purpose: dev pages carry no untrusted content, so the nonce only has to match the tags.
const DEV_NONCE = 'figma-drop-dev';

function contentSecurityPolicy(): Plugin {
  let dev = false;
  return {
    name: 'figma-drop:content-security-policy',
    config(_config, { command }) {
      dev = command === 'serve';
      return dev ? { html: { cspNonce: DEV_NONCE } } : undefined;
    },
    transformIndexHtml: {
      order: 'post',
      handler: () => [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: [
              "default-src 'none'",
              dev ? `script-src 'self' 'nonce-${DEV_NONCE}'` : "script-src 'self'",
              dev ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
              "img-src 'self' figma-drop-preview:",
              ...(dev ? [`connect-src 'self' ws://localhost:${DEV_SERVER_PORT}`] : []),
              "base-uri 'none'",
              "form-action 'none'",
            ].join('; '),
          },
          injectTo: 'head-prepend',
        },
      ],
    },
  };
}

const RESET_ID = 'virtual:figma-drop/reset.css';

// StyleX appends its rules to a CSS asset the entry already links. An entry with no CSS import gets
// an orphan `stylex.css` instead, and the page ships unstyled with no error. This module guarantees
// the entry a CSS asset whether or not App imports a stylesheet of its own.
function resetStylesheet(): Plugin {
  return {
    name: 'figma-drop:reset-stylesheet',
    resolveId: (id) => (id === RESET_ID ? `\0${RESET_ID}` : undefined),
    load: (id) =>
      id === `\0${RESET_ID}` ? '@layer reset { html, body { margin: 0; } }' : undefined,
  };
}

export default defineConfig({
  root: rendererDir,
  base: './',
  plugins: [
    stylex.vite({ useCSSLayers: true }),
    resetStylesheet(),
    react(),
    contentSecurityPolicy(),
  ],
  server: { port: DEV_SERVER_PORT, strictPort: true },
  // StyleX's dev transform calls this.load() on each import, so a *.stylex.ts file requested during
  // the first crawl waits on a pre-bundled dependency, which by default waits for the crawl to end.
  optimizeDeps: { holdUntilCrawlEnd: false },
  build: {
    outDir: `${appDir}dist/renderer`,
    emptyOutDir: true,
    rollupOptions: { input: { index: `${rendererDir}/index.html` } },
  },
  pack: [
    electronEntry('main', 'src/main/index.ts'),
    electronEntry('preload', 'src/preload/index.ts'),
    electronEntry('receiver', 'src/ingest/receiver-process.ts'),
  ],
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
          setupFiles: [`${rendererDir}/test-setup.ts`],
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
