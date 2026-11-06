import { defineConfig } from 'vite-plus';

export default defineConfig({
  root: 'src',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: false,
    target: 'es2020',
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    rollupOptions: { input: 'src/ui.html', output: { codeSplitting: false } },
  },
  pack: {
    entry: { code: 'src/code.ts' },
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outDir: 'dist',
    outputOptions: { entryFileNames: '[name].js' },
    dts: false,
    clean: true,
    minify: true,
    deps: { alwaysBundle: () => true, onlyBundle: false as const },
  },
  test: {
    root: '.',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
