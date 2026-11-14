import { describe, expect, it } from 'vite-plus/test';

import { classifyFileIdentity, parseExportPayload, parseOpenRequest } from './parser.ts';

const node = { id: '1:2', name: 'Frame', type: 'FRAME' };

describe('classifyFileIdentity', () => {
  it('treats a key distinct from the file name as a file identity', () => {
    expect(classifyFileIdentity({ fileKey: 'abc123', fileName: 'Designs' })).toEqual({
      kind: 'file',
      fileKey: 'abc123',
    });
  });

  it('classifies the name fallback as unidentified, keeping the claimed key', () => {
    expect(classifyFileIdentity({ fileKey: 'Designs', fileName: 'Designs' })).toEqual({
      kind: 'unidentified',
      claimedKey: 'Designs',
    });
  });

  it('classifies the literal fallback as unidentified', () => {
    expect(classifyFileIdentity({ fileKey: 'current', fileName: '' })).toEqual({
      kind: 'unidentified',
      claimedKey: 'current',
    });
  });

  it('classifies a file literally named current as unidentified', () => {
    expect(classifyFileIdentity({ fileKey: 'current', fileName: 'current' })).toEqual({
      kind: 'unidentified',
      claimedKey: 'current',
    });
  });

  it('classifies "current" as unidentified even beside a real file name', () => {
    expect(classifyFileIdentity({ fileKey: 'current', fileName: 'Designs' })).toEqual({
      kind: 'unidentified',
      claimedKey: 'current',
    });
  });

  it.each([
    ['missing', {}],
    ['empty', { fileKey: '' }],
    ['empty with a file name', { fileKey: '', fileName: 'Designs' }],
  ])('classifies a %s key as unidentified with no claimed key', (_label, payload) => {
    expect(classifyFileIdentity(payload)).toEqual({ kind: 'unidentified', claimedKey: null });
  });

  it('uses no key shape: an odd-looking key is still an identity', () => {
    expect(classifyFileIdentity({ fileKey: '../ ü', fileName: 'Designs' })).toEqual({
      kind: 'file',
      fileKey: '../ ü',
    });
  });

  it('keeps two files named Untitled apart only by their keys', () => {
    const first = classifyFileIdentity({ fileKey: 'key-a', fileName: 'Untitled' });
    const second = classifyFileIdentity({ fileKey: 'key-b', fileName: 'Untitled' });
    expect(first).not.toEqual(second);
  });
});

describe('parseExportPayload', () => {
  it('accepts the only required field alone, so fileKey is optional', () => {
    const result = parseExportPayload({ node });
    expect(result).toEqual({ ok: true, payload: { node } });
  });

  it('accepts a full upstream payload', () => {
    const result = parseExportPayload({
      outputDir: '',
      fileKey: 'abc123',
      fileName: 'Designs',
      nodeId: '1:2',
      nodeName: 'Frame',
      folderName: 'Frame-1234',
      exportedAt: '2026-10-29T00:00:00.000Z',
      summary: { totalNodes: 1 },
      node,
      components: [],
      remoteMasters: [],
      variables: { collections: [], tokens: [] },
      styles: { styles: [] },
      svg: '<svg><script>alert(1)</script></svg>',
      png: 'iVBORw0KGgo=',
      assets: [{ name: 'img-1.png', base64: 'AAAA' }],
      images: [{ imageHash: 'hash', name: 'hash.png', base64: 'AAAA' }],
    });
    expect(result.ok).toBe(true);
  });

  it('keeps unknown fields at the top level and in nested objects', () => {
    const result = parseExportPayload({
      node: { ...node, futureNodeField: 1 },
      futureField: { nested: true },
      assets: [{ name: 'a.png', base64: 'AAAA', futureAssetField: 'x' }],
    });
    expect(result).toEqual({
      ok: true,
      payload: {
        node: { ...node, futureNodeField: 1 },
        futureField: { nested: true },
        assets: [{ name: 'a.png', base64: 'AAAA', futureAssetField: 'x' }],
      },
    });
  });

  it('rejects an array node, which upstream lets through', () => {
    expect(parseExportPayload({ node: [] })).toEqual({ ok: false, error: 'invalid export: node' });
  });

  it.each([
    ['missing', {}],
    ['null', { node: null }],
    ['a string', { node: 'node' }],
    ['a number', { node: 1 }],
  ])('rejects a %s node', (_label, body) => {
    expect(parseExportPayload(body)).toEqual({ ok: false, error: 'invalid export: node' });
  });

  it('names the failing path in the error', () => {
    expect(parseExportPayload({ node, assets: [{ name: 1, base64: 'AAAA' }] })).toEqual({
      ok: false,
      error: 'invalid export: assets.0.name',
    });
  });

  it('keeps unknown fields inside image entries', () => {
    const images = [{ extra: 'x', base64: 'AAAA', name: 'h.png', imageHash: 'h' }];
    expect(parseExportPayload({ node, images })).toEqual({ ok: true, payload: { node, images } });
  });

  it.each([
    'fileKey',
    'fileName',
    'nodeId',
    'nodeName',
    'exportedAt',
    'outputDir',
    'folderName',
    'summary',
    'components',
    'remoteMasters',
    'variables',
    'styles',
    'svg',
    'png',
    'assets',
    'images',
    'contractVersion',
    'batchId',
  ])('rejects a null %s, because absent fields are omitted', (field) => {
    expect(parseExportPayload({ node, [field]: null })).toEqual({
      ok: false,
      error: `invalid export: ${field}`,
    });
  });

  it('rejects a null imageHash inside an image entry', () => {
    const images = [{ imageHash: null, name: 'h.png', base64: '' }];
    expect(parseExportPayload({ node, images })).toEqual({
      ok: false,
      error: 'invalid export: images.0.imageHash',
    });
  });

  it('rejects a contract version that JSON overflows to Infinity', () => {
    expect(parseExportPayload(JSON.parse('{"node":{},"contractVersion":1e400}'))).toEqual({
      ok: false,
      error: 'invalid export: contractVersion',
    });
  });

  it('passes trees through by reference without walking them', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 200_000; depth += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    const result = parseExportPayload({ node: deep, components: [deep], summary: deep });
    expect(result.ok && result.payload.node).toBe(deep);
  });

  it('never lets a __proto__ key set a field or the prototype', () => {
    const result = parseExportPayload(JSON.parse('{"__proto__":{"fileKey":"forged"},"node":{}}'));
    if (!result.ok) throw new Error(result.error);
    expect(result.payload.fileKey).toBeUndefined();
    expect(Object.getPrototypeOf(result.payload)).toBe(Object.prototype);
  });

  it('never throws on junk and never says the forbidden words', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const junk: unknown[] = [
      undefined,
      null,
      0,
      NaN,
      '',
      'junk',
      true,
      [],
      [{ node }],
      Symbol('junk'),
      () => undefined,
      new Date(0),
      new Map([['node', node]]),
      cyclic,
      { node, fileKey: 1 },
      { node, fileKey: null },
      { node, svg: {} },
      { node, assets: 'nope' },
      { node, summary: [] },
    ];
    for (const value of junk) {
      const result = parseExportPayload(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.toLowerCase()).not.toContain('output folder');
    }
  });
});

describe('parseOpenRequest', () => {
  it('accepts a path and keeps unknown fields', () => {
    expect(parseOpenRequest({ path: '/a', extra: 1 })).toEqual({ path: '/a', extra: 1 });
  });

  it.each([
    ['null', null],
    ['an array', [{ path: '/a' }]],
    ['a string', '/a'],
    ['an object without a path', {}],
    ['a null path', { path: null }],
    ['a numeric path', { path: 1 }],
  ])('rejects %s', (_label, value) => {
    expect(parseOpenRequest(value)).toBeUndefined();
  });
});
