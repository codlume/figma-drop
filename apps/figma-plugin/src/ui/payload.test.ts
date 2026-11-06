import { CONTRACT_VERSION } from '@figma-drop/export-contract';
import { parseExportPayload } from '@figma-drop/export-contract/parser';
import { describe, expect, it } from 'vite-plus/test';
import type { RawExport } from '../shared/messages.ts';
import { encodeExport, toBase64 } from './payload.ts';

const utf8 = (text: string) => new TextEncoder().encode(text);

function rawExport(overrides: Partial<RawExport> = {}): RawExport {
  return {
    node: { id: '1:2', name: 'Card', type: 'FRAME' },
    fileKey: 'abc123',
    fileName: 'Design',
    nodeId: '1:2',
    nodeName: 'Card',
    exportedAt: '2026-11-06T10:00:00.000Z',
    summary: { totalNodes: 1 },
    components: [],
    remoteMasters: [],
    icons: [],
    images: [],
    ...overrides,
  };
}

const svgWith = (...hrefs: string[]) =>
  utf8(`<svg>${hrefs.map((href) => `<image ${href}/>`).join('')}</svg>`);

describe('encodeExport', () => {
  it('produces a payload the receiver parser accepts unchanged', () => {
    const payload = encodeExport(
      rawExport({
        svgBytes: svgWith('href="data:image/png;base64,QUJD"'),
        pngBytes: utf8('png'),
        icons: [{ name: 'star.k1.svg', bytes: utf8('<svg/>') }],
        images: [{ imageHash: 'h1', name: 'h1.png', bytes: utf8('image') }],
        variables: { collections: [], tokens: [] },
        styles: { styles: [] },
      }),
    );
    const wire: unknown = JSON.parse(JSON.stringify(payload));
    expect(parseExportPayload(wire)).toEqual({ ok: true, payload: wire });
  });

  it('carries the identity and pass-through fields and the contract version', () => {
    const payload = encodeExport(rawExport());
    expect(payload).toMatchObject({
      node: { id: '1:2', name: 'Card', type: 'FRAME' },
      fileKey: 'abc123',
      fileName: 'Design',
      nodeId: '1:2',
      nodeName: 'Card',
      exportedAt: '2026-11-06T10:00:00.000Z',
      summary: { totalNodes: 1 },
      components: [],
      remoteMasters: [],
      contractVersion: CONTRACT_VERSION,
    });
  });

  it('leaves fileKey off the wire when the sandbox had none', () => {
    const { fileKey: _fileKey, ...withoutKey } = rawExport();
    const wire = JSON.parse(JSON.stringify(encodeExport(withoutKey)));
    expect(wire).not.toHaveProperty('fileKey');
    expect(wire.fileName).toBe('Design');
  });

  it('sends no run or placement fields', () => {
    const payload = encodeExport(rawExport({ svgBytes: svgWith() }));
    for (const key of ['batchId', 'outputDir', 'folderName']) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it('omits previews and empty lists it does not have', () => {
    const payload = encodeExport(rawExport());
    for (const key of ['svg', 'png', 'assets', 'images']) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it('decodes non-ASCII SVG text as UTF-8', () => {
    const svg = '<svg><title>Zażółć 日本語 🎨</title></svg>';
    expect(encodeExport(rawExport({ svgBytes: utf8(svg) })).svg).toBe(svg);
  });

  it('leaves a pure vector SVG alone and adds no assets', () => {
    const svg = '<svg><path d="M0 0"/><a href="https://example.com">x</a></svg>';
    const payload = encodeExport(rawExport({ svgBytes: utf8(svg) }));
    expect(payload.svg).toBe(svg);
    expect(payload).not.toHaveProperty('assets');
  });

  it('moves embedded rasters into assets and rewrites href and xlink:href', () => {
    const payload = encodeExport(
      rawExport({
        svgBytes: svgWith(
          'href="data:image/png;base64,QUFB"',
          'xlink:href="data:image/jpeg;base64,QkJC"',
        ),
      }),
    );
    expect(payload.svg).toBe(
      '<svg><image href="preview.assets/img-0.png"/><image xlink:href="preview.assets/img-1.jpg"/></svg>',
    );
    expect(payload.assets).toEqual([
      { name: 'img-0.png', base64: 'QUFB' },
      { name: 'img-1.jpg', base64: 'QkJC' },
    ]);
  });

  it('maps MIME types to extensions', () => {
    const { assets } = encodeExport(
      rawExport({
        svgBytes: svgWith(
          'href="data:image/gif;base64,QQ=="',
          'href="data:image/webp;base64,Qg=="',
          'href="data:image/svg+xml;charset=utf-8;base64,Qw=="',
        ),
      }),
    );
    expect(assets?.map((asset) => asset.name)).toEqual(['img-0.gif', 'img-1.bin', 'img-2.bin']);
  });

  it('writes one asset for repeated base64 and numbers by first appearance', () => {
    const payload = encodeExport(
      rawExport({
        svgBytes: svgWith(
          'href="data:image/png;base64,QUFB"',
          'href="data:image/png;base64,QkJC"',
          'xlink:href="data:image/png;base64,QUFB"',
        ),
      }),
    );
    expect(payload.assets).toEqual([
      { name: 'img-0.png', base64: 'QUFB' },
      { name: 'img-1.png', base64: 'QkJC' },
    ]);
    expect(payload.svg).toContain('xlink:href="preview.assets/img-0.png"');
  });

  it('leaves data URIs it must not touch', () => {
    const svg = [
      `<image href='data:image/png;base64,QUFB'/>`,
      `<image href="data:image/png,raw"/>`,
      `<image data-href="data:image/png;base64,QUFB"/>`,
      `<a href="data:text/plain;base64,QUFB"/>`,
    ].join('');
    const payload = encodeExport(rawExport({ svgBytes: utf8(svg) }));
    expect(payload.svg).toBe(svg);
    expect(payload).not.toHaveProperty('assets');
  });

  it('lists SVG rasters before icons', () => {
    const { assets } = encodeExport(
      rawExport({
        svgBytes: svgWith('href="data:image/png;base64,QUFB"'),
        icons: [
          { name: 'a.k1.svg', bytes: utf8('<svg/>') },
          { name: 'b.k2.svg', bytes: utf8('<svg></svg>') },
        ],
      }),
    );
    expect(assets).toEqual([
      { name: 'img-0.png', base64: 'QUFB' },
      { name: 'a.k1.svg', base64: 'PHN2Zy8+' },
      { name: 'b.k2.svg', base64: 'PHN2Zz48L3N2Zz4=' },
    ]);
  });

  it('encodes the PNG and image fills as bare base64', () => {
    const payload = encodeExport(
      rawExport({
        pngBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        images: [{ imageHash: 'h1', name: 'h1.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff]) }],
      }),
    );
    expect(payload.png).toBe('iVBORw==');
    expect(payload.images).toEqual([{ imageHash: 'h1', name: 'h1.jpg', base64: '/9j/' }]);
  });

  it('encodes an image too large for one fromCharCode call', () => {
    const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31) % 256;
    expect(() => String.fromCharCode(...bytes)).toThrow(RangeError);

    const { png } = encodeExport(rawExport({ pngBytes: bytes }));
    expect(png).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('toBase64', () => {
  it.each([0, 1, 2, 3, 24_575, 24_576, 24_577])('matches at length %i', (length) => {
    const bytes = new Uint8Array(length).fill(0xab);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});
