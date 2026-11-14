import { describe, expect, it } from 'vite-plus/test';

import { serializeJson } from './json-indent';

function expectSameAsStringify(value: unknown): void {
  const compactText = JSON.stringify(value);
  const indentedText = JSON.stringify(value, null, 2);
  const json = serializeJson(value);
  expect(json.compact.toString(), compactText).toBe(compactText);
  expect(json.indentGrowth, compactText).toBe(indentedText.length - compactText.length);
  expect(json.indentedChars, compactText).toBe(indentedText.length);
  expect(json.indented().toString(), compactText).toBe(indentedText);
}

function seeded(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % below;
  };
}

const TEXTS = [
  '',
  'x',
  'plain text',
  'a,b:c{d}[e]',
  '"',
  '\\',
  '\\"',
  'ends in a backslash\\',
  'Łódź ✓ 😀',
  '\ud800',
  '\u0001\n\t\u2028',
  'x'.repeat(31),
  'x'.repeat(32),
  'x'.repeat(33),
  '"\\'.repeat(40),
];

function randomValue(next: (below: number) => number, depth: number): unknown {
  const kind = next(depth > 5 ? 6 : 9);
  if (kind === 0) return null;
  if (kind === 1) return next(2) === 0;
  if (kind === 2) return [0, -0, 1, -1.5, 1e21, 1.5e-7, 123_456_789][next(7)];
  if (kind < 6) return TEXTS[next(TEXTS.length)];
  const length = next(4);
  if (kind < 8) return Array.from({ length }, () => randomValue(next, depth + 1));
  return Object.fromEntries(
    Array.from({ length }, (_, index) => [
      `${TEXTS[next(TEXTS.length)]}${index}`,
      randomValue(next, depth + 1),
    ]),
  );
}

describe('indentJson', () => {
  it.each([
    ['an object', { id: '1:2', children: [{ id: '1:3' }] }],
    ['an empty object', {}],
    ['an empty array', []],
    ['empty containers inside others', [{}, [], [[]], [{}], { a: {}, b: [] }]],
    ['a string', 'text'],
    ['a string of only structure', '{[,:]}'],
    ['a number', -1.5e-7],
    ['a literal', null],
    ['keys that hold structure', { 'a "b": c, [d]': { '}': ']' } }],
    ['escapes', ['"', '\\', '\\"', 'tail\\', '\u0001', '\ud800']],
    ['multi-byte text', { Łódź: '✓ 😀', '😀': ['é'] }],
    ['a string on each side of the copy threshold', TEXTS],
  ])('writes %s as JSON.stringify indents it', (_label, value) => {
    expectSameAsStringify(value);
  });

  it('writes 60 levels of nesting as JSON.stringify indents it', () => {
    let value: unknown = { leaf: [1, 2] };
    for (let level = 0; level < 60; level += 1) value = level % 2 ? [value, level] : { value };
    expectSameAsStringify(value);
  });

  it('writes 2000 seeded trees as JSON.stringify indents them', () => {
    const next = seeded(0x5eed);
    for (let round = 0; round < 2000; round += 1) expectSameAsStringify(randomValue(next, 0));
  });
});
