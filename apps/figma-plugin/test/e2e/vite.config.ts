import { defineConfig } from 'vite-plus';
import { ProofReporter } from './proof-reporter.ts';

export default defineConfig({
  test: {
    root: '.',
    include: ['test/e2e/*.e2e.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default', new ProofReporter()],
  },
});
