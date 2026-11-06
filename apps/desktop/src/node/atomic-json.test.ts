import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as NodePath from 'node:path';

import { beforeEach, describe, expect, it } from 'vite-plus/test';

import { readJsonFile, writeJsonAtomic } from './atomic-json.ts';

let dir: string;
const identity = (value: unknown) => value;
const rejectValue = () => {
  throw new Error('bad shape');
};

beforeEach(async () => {
  dir = await mkdtemp(NodePath.join(tmpdir(), 'atomic-json-'));
});

describe('writeJsonAtomic', () => {
  it('creates parent directories and leaves only the target file', async () => {
    const path = NodePath.join(dir, 'nested', 'value.json');
    await writeJsonAtomic(path, { a: 1 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ a: 1 });
    expect(await readdir(NodePath.dirname(path))).toEqual(['value.json']);
  });

  it('survives concurrent writers, leaving one complete value and no temp files', async () => {
    const path = NodePath.join(dir, 'value.json');
    await Promise.all(Array.from({ length: 20 }, (_, n) => writeJsonAtomic(path, { n })));
    const value = await readJsonFile(path, identity);
    expect(value).toEqual({ n: expect.any(Number) });
    expect(await readdir(dir)).toEqual(['value.json']);
  });

  it('removes the temp file when the write fails', async () => {
    const path = NodePath.join(dir, 'target');
    await writeJsonAtomic(NodePath.join(path, 'child.json'), 1);
    await expect(writeJsonAtomic(path, 2)).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['target']);
  });
});

describe('readJsonFile', () => {
  it('returns the parsed value', async () => {
    const path = NodePath.join(dir, 'value.json');
    await writeJsonAtomic(path, { a: 1 });
    expect(await readJsonFile(path, identity)).toEqual({ a: 1 });
  });

  it('returns null for a missing file', async () => {
    expect(await readJsonFile(NodePath.join(dir, 'missing.json'), identity)).toBeNull();
  });

  it('returns null for malformed JSON', async () => {
    const path = NodePath.join(dir, 'value.json');
    await writeFile(path, '{ nope');
    expect(await readJsonFile(path, identity)).toBeNull();
  });

  it('returns null when parse rejects the value', async () => {
    const path = NodePath.join(dir, 'value.json');
    await writeJsonAtomic(path, 1);
    expect(await readJsonFile(path, rejectValue)).toBeNull();
  });
});
