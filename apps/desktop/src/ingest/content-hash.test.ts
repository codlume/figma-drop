import { describe, expect, it } from 'vite-plus/test';
import { HASH_EXCLUDED_FIELDS } from '@figma-drop/export-contract';
import { hashExport, MAX_JSON_DEPTH } from './content-hash';
import { exportPayload } from './ingest-fixtures';

function parsed(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

function nested(depth: number): unknown {
  let value: unknown = [];
  for (let level = 1; level < depth; level += 1) value = [value];
  return value;
}

describe('hashExport', () => {
  it('is 64 lowercase hex characters', () => {
    expect(hashExport(exportPayload())).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(HASH_EXCLUDED_FIELDS)('ignores a change to top-level %s', (field) => {
    expect(hashExport(exportPayload({ [field]: 'changed' }))).toBe(hashExport(exportPayload()));
  });

  it('ignores every excluded field being absent', () => {
    const absent = Object.fromEntries(HASH_EXCLUDED_FIELDS.map((field) => [field, undefined]));
    const payload = parsed(JSON.stringify(exportPayload(absent)));
    expect(hashExport(payload)).toBe(hashExport(exportPayload()));
  });

  it('still hashes an excluded field name below the top level', () => {
    const node = (exportedAt: string) => ({ id: '1:2', exportedAt });
    expect(hashExport(exportPayload({ node: node('a') }))).not.toBe(
      hashExport(exportPayload({ node: node('b') })),
    );
  });

  it('ignores key order at every level', () => {
    const left = parsed('{"a":1,"b":{"c":2,"d":[{"e":3,"f":4}]}}');
    const right = parsed('{"b":{"d":[{"f":4,"e":3}],"c":2},"a":1}');
    expect(hashExport(left)).toBe(hashExport(right));
  });

  it.each([
    ['a changed field', '{"a":1}', '{"a":2}'],
    ['an added unknown field', '{"a":1}', '{"a":1,"b":null}'],
    ['array order', '{"a":[1,2]}', '{"a":[2,1]}'],
    ['a number and its text', '{"a":1}', '{"a":"1"}'],
    ['null and false', '{"a":null}', '{"a":false}'],
    ['zero and negative zero', '{"a":0}', '{"a":-0}'],
    ['an empty array and an empty object', '{"a":[]}', '{"a":{}}'],
    ['a string split across two items', '{"a":["bc","d"]}', '{"a":["b","cd"]}'],
    ['a key moved into its value', '{"ab":"c"}', '{"a":"bc"}'],
    ['flat and nested arrays', '{"a":[[1],2]}', '{"a":[[1,2]]}'],
    ['two lone surrogates', '{"a":"\\ud800"}', '{"a":"\\ud801"}'],
    ['a top-level __proto__ key', '{"a":1}', '{"a":1,"__proto__":{"b":1}}'],
  ])('separates %s', (_label, left, right) => {
    expect(hashExport(parsed(left))).not.toBe(hashExport(parsed(right)));
  });

  it('separates a long string that differs only in its last unit', () => {
    const long = 'a'.repeat(200_000);
    expect(hashExport({ a: `${long}b` })).not.toBe(hashExport({ a: `${long}c` }));
  });

  it('accepts nesting at the limit and rejects one level more', () => {
    expect(hashExport({ a: nested(MAX_JSON_DEPTH - 1) })).not.toBeNull();
    expect(hashExport({ a: nested(MAX_JSON_DEPTH) })).toBeNull();
  });

  it('counts object nesting the same as array nesting', () => {
    let value: unknown = {};
    for (let level = 2; level < MAX_JSON_DEPTH; level += 1) value = { a: value };
    expect(hashExport({ a: value })).not.toBeNull();
    expect(hashExport({ a: { a: value } })).toBeNull();
  });

  it('rejects 100k levels without overflowing the stack', () => {
    const text = `{"a":${'['.repeat(100_000)}${']'.repeat(100_000)}}`;
    expect(hashExport(parsed(text))).toBeNull();
  });
});
