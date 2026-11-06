import { describe, expect, it } from 'vite-plus/test';

import { exceedsValueBudget } from './json-budget';

const over = (json: string, budget: number) => exceedsValueBudget(Buffer.from(json), budget);

describe('exceedsValueBudget', () => {
  it('counts containers and separators up to the budget', () => {
    expect(over('[1,2,3]', 3)).toBe(false);
    expect(over('[1,2,3]', 2)).toBe(true);
    expect(over('{"a":{"b":[]}}', 3)).toBe(false);
    expect(over('{"a":{"b":[]}}', 2)).toBe(true);
  });

  it('ignores structure inside strings, so SVG and CSS text cost nothing', () => {
    expect(over('{"svg":"[[[,,,{{{"}', 1)).toBe(false);
  });

  it('keeps an escaped quote inside the string', () => {
    expect(over(String.raw`{"a":"\",[[[,"}`, 1)).toBe(false);
    expect(over(String.raw`{"a":"\\",[[[]]]}`, 1)).toBe(true);
  });

  it('catches the shapes that abort V8 inside JSON.parse', () => {
    expect(over('['.repeat(100), 50)).toBe(true);
    expect(over(`[${'[],'.repeat(100)}[]]`, 50)).toBe(true);
    expect(over(`[${'0,'.repeat(100)}0]`, 50)).toBe(true);
  });
});
