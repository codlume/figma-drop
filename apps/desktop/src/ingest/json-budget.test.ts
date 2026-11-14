import { describe, expect, it } from 'vite-plus/test';

import { exceedsValueBudget } from './json-budget';

const over = (json: string, budget: number) => exceedsValueBudget(Buffer.from(json), budget);

function countValuesByteByByte(json: string): number {
  let values = 0;
  let inString = false;
  const bytes = Buffer.from(json);
  for (let index = 0; index < bytes.length; index += 1) {
    const char = String.fromCharCode(bytes[index] ?? 0);
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === ',' || char === '[' || char === '{') values += 1;
  }
  return values;
}

function expectBudgetAtCount(json: string): void {
  const values = countValuesByteByByte(json);
  expect(values).toBeGreaterThan(0);
  expect(over(json, values)).toBe(false);
  expect(over(json, values - 1)).toBe(true);
}

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

  it.each([
    ['a long string', `[1,"${'x,[{'.repeat(100)}",2,[3]]`],
    [
      'an escaped quote deep in a long string',
      `["${'x'.repeat(300)}\\",[[","${'y'.repeat(300)}",[]]`,
    ],
    ['an escaped backslash closing a long string', `["${'x'.repeat(300)}\\\\",[[",",[]]`],
    ['three backslashes before a quote', `["${'x'.repeat(300)}\\\\\\",[[",",[]]`],
    ['an odd long run of backslashes', `[[],"${'\\'.repeat(301)}",[["]`],
    ['an even long run of backslashes', `[[],"${'\\'.repeat(300)}",[[","]`],
    ['a string that never closes', `[1,2,"${'x,['.repeat(200)}`],
    ['a string closing at the end of the body', `[1,2,"${'x'.repeat(200)}"`],
    ['a backslash as the last byte', `[1,"${'x'.repeat(200)}\\`],
    ['many short strings', `[${'"k":"v",'.repeat(200)}{"a":"b"}]`],
    ['multi-byte text', `["${'é✓'.repeat(100)}",["${'😀'.repeat(50)}\\"",{}]]`],
  ])('agrees with a byte-at-a-time count on %s', (_label, json) => {
    expectBudgetAtCount(json);
  });

  it.each([0, 1, 31, 63, 64, 65, 127, 128, 129])(
    'agrees with it around a string of %i bytes with escapes at its end',
    (length) => {
      const filler = 'x'.repeat(length);
      expectBudgetAtCount(`[[],"${filler}",[],[]]`);
      expectBudgetAtCount(`[[],"${filler}\\"${filler}",[],[]]`);
      expectBudgetAtCount(`[[],"${filler}\\\\",[],"${filler}\\\\\\"",[]]`);
    },
  );

  it('agrees with it on 3000 seeded mixes of quotes, backslashes, and structure', () => {
    let seed = 0x2f6e2b1;
    const next = (below: number) => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % below;
    };
    const pieces = ['"', '"', '\\', '\\\\', ',', '[', '{', 'x'.repeat(70), 'x', '\\"', 'é'];
    for (let round = 0; round < 3000; round += 1) {
      let json = '[';
      for (let piece = next(40); piece >= 0; piece -= 1) json += pieces[next(pieces.length)];
      const values = countValuesByteByByte(json);
      expect(over(json, values), json).toBe(false);
      expect(over(json, values - 1), json).toBe(true);
    }
  });

  it('is exact where the body is as long as the budget, and one byte longer', () => {
    expect(over('[[[[', 4)).toBe(false);
    expect(over('[[[[[', 4)).toBe(true);
  });

  it('catches the shapes that abort V8 inside JSON.parse', () => {
    expect(over('['.repeat(100), 50)).toBe(true);
    expect(over(`[${'[],'.repeat(100)}[]]`, 50)).toBe(true);
    expect(over(`[${'0,'.repeat(100)}0]`, 50)).toBe(true);
  });
});
