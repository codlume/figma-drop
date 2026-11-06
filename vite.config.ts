import { builtinModules } from 'node:module';

import 'vite-plus/test/config';
import { defineConfig } from 'vite-plus';

const ignorePatterns = [
  '.audit/**',
  'apps/desktop/.dev/**',
  'apps/desktop/release/**',
  'dist',
  'dist-electron',
  'node_modules',
  'pnpm-lock.yaml',
  '*.tsbuildinfo',
];

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-electron/**'],
  },
  staged: {
    '*': 'vp fmt --no-error-on-unmatched-pattern',
  },
  fmt: {
    ignorePatterns,
    singleQuote: true,
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns,
    plugins: ['eslint', 'oxc', 'react', 'unicorn', 'typescript'],
    categories: {
      correctness: 'warn',
      suspicious: 'warn',
      perf: 'warn',
    },
    rules: {
      'react-in-jsx-scope': 'off',
      'eslint/no-await-in-loop': 'off',
    },
    options: {
      reportUnusedDisableDirectives: 'error',
    },
    overrides: [
      {
        files: ['apps/desktop/src/**'],
        rules: {
          'eslint/no-restricted-imports': [
            'error',
            {
              paths: ['electron', 'electron/main'].map((name) => ({
                name,
                importNames: ['ipcMain', 'default'],
                message:
                  "Register IPC handlers on the owning window's webContents.ipc, so no other window can invoke them.",
              })),
            },
          ],
        },
      },
      {
        files: ['apps/desktop/src/renderer/**', 'apps/desktop/src/shared/**'],
        excludeFiles: ['**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}', '**/__tests__/**'],
        rules: {
          'typescript/no-require-imports': 'error',
          'eslint/no-restricted-imports': [
            'error',
            {
              paths: builtinModules
                .filter((name) => !name.startsWith('node:'))
                .map((name) => ({
                  name,
                  message:
                    'Renderer and shared modules must use the window API for privileged work.',
                })),
              patterns: [
                {
                  group: ['node:*', 'electron', 'electron/**'],
                  message:
                    'Renderer and shared modules must use the window API for privileged work.',
                },
                {
                  regex: '(?i)(^|[/\\\\])[@~#]?(main|preload)([/\\\\]|$)',
                  message:
                    'Renderer and shared modules must import shared contracts instead of main or preload code.',
                },
              ],
            },
          ],
        },
      },
    ],
  },
});
