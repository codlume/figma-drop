import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Reporter, TestCase, TestModule } from 'vite-plus/test/node';
import { PROOF_DIR } from './proof.ts';

const HEADER = [
  'figma-plugin end-to-end scenarios',
  'This is a mocked run, not a real Figma export. See README.md for the limits.',
  '',
];

function lines(test: TestCase): string[] {
  const result = test.result();
  const facts = test.annotations().filter(({ type }) => type === 'fact');
  const failure = result.errors?.[0]?.message.split('\n')[0];
  return [
    `${result.state.toUpperCase().padEnd(7)} ${test.fullName}`,
    ...facts.map(({ message }) => `        ${message}`),
    ...(failure === undefined ? [] : [`        ${failure}`]),
  ];
}

// Reads vitest's own verdicts, so a timed-out or crashed test cannot log a pass.
export class ProofReporter implements Reporter {
  onTestRunEnd(modules: readonly TestModule[]) {
    const ordered = [...modules];
    ordered.sort((a, b) => a.moduleId.localeCompare(b.moduleId));
    const tests = ordered.flatMap((module) => Array.from(module.children.allTests()));
    const count = (state: string) => tests.filter((test) => test.result().state === state).length;
    // A filtered run is not evidence, so it leaves the last full log in place.
    if (count('skipped') > 0) return;
    const log = [
      ...HEADER,
      ...tests.flatMap(lines),
      '',
      `passed ${count('passed')}, failed ${count('failed')}`,
      '',
    ];
    mkdirSync(PROOF_DIR, { recursive: true });
    writeFileSync(join(PROOF_DIR, 'scenarios.txt'), log.join('\n'));
  }
}
