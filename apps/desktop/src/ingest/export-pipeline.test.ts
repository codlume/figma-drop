import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { BUNDLE_FILES } from '@figma-drop/export-contract';
import type { StagingId } from '../shared/library';
import {
  discardStaging,
  prepareExport,
  stageExport,
  type BundleFile,
  type PreparedExport,
} from './export-pipeline';
import { exportBody, exportPayload, ONE_PIXEL_PNG_BASE64 } from './ingest-fixtures';

const faults = vi.hoisted(() => ({
  mkdir: undefined as ((path: string) => void) | undefined,
  writeFile: undefined as ((path: string) => void) | undefined,
  rm: undefined as (() => void) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    mkdir: async (...args: Parameters<typeof real.mkdir>) => {
      faults.mkdir?.(String(args[0]));
      return real.mkdir(...args);
    },
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      faults.writeFile?.(String(args[0]));
      return real.writeFile(...args);
    },
    rm: async (...args: Parameters<typeof real.rm>) => {
      faults.rm?.();
      return real.rm(...args);
    },
  };
});

const STAGING_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' as StagingId;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function prepared(overrides: Record<string, unknown> = {}): PreparedExport {
  const result = prepareExport(exportBody(overrides));
  if (!result.ok) throw new Error(`expected a prepared export, got ${result.rejection}`);
  return result.prepared;
}

function rejection(body: Buffer | string): string | undefined {
  const result = prepareExport(Buffer.from(body));
  return result.ok ? undefined : result.rejection;
}

function paths(exported: PreparedExport): string[] {
  return exported.files.map(({ relativePath }) => relativePath);
}

function file(exported: PreparedExport, relativePath: string): BundleFile['bytes'] {
  const found = exported.files.find((candidate) => candidate.relativePath === relativePath);
  if (!found) throw new Error(`no ${relativePath} in ${paths(exported).join(', ')}`);
  return found.bytes;
}

function text(exported: PreparedExport, relativePath: string): string {
  return Buffer.from(file(exported, relativePath)).toString('utf8');
}

function meta(exported: PreparedExport): Record<string, unknown> {
  return JSON.parse(text(exported, BUNDLE_FILES.meta)) as Record<string, unknown>;
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function emptyAssets(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => ({ name: `${prefix}${index}`, base64: '' }));
}

function nestedJson(depth: number, innermost = ''): string {
  return `${'['.repeat(depth)}${innermost}${']'.repeat(depth)}`;
}

describe('prepareExport rejections', () => {
  it.each(['', 'not json', '{"node":', '{"node":{}}}'])('reads %j as malformed JSON', (body) => {
    expect(rejection(body)).toBe('malformedJson');
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"export"'],
    ['no node', '{"nodeId":"1:2"}'],
    ['a null node', '{"nodeId":"1:2","node":null}'],
    ['an array node', '{"nodeId":"1:2","node":[]}'],
    ['a non-string fileKey', '{"nodeId":"1:2","node":{},"fileKey":1}'],
    ['a nameless asset', '{"nodeId":"1:2","node":{},"assets":[{"base64":""}]}'],
  ])('reads %s as an invalid export', (_label, body) => {
    expect(rejection(body)).toBe('invalidExport');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])('needs a node id when it is %s', (_label, nodeId) => {
    expect(rejection(exportBody({ nodeId }))).toBe('missingNodeId');
  });

  it('rejects 100k levels of nesting without crashing', () => {
    const body = `{"nodeId":"1:2","node":{"children":${nestedJson(100_000)}}}`;
    expect(rejection(body)).toBe('nestedTooDeeply');
  });

  it('stages nesting at the limit, because writing it must not overflow either', () => {
    const body = `{"nodeId":"1:2","node":{"children":${nestedJson(998)}}}`;
    expect(rejection(body)).toBeUndefined();
  });

  it('counts assets and images together against the limit', () => {
    expect(
      rejection(exportBody({ assets: emptyAssets(1000, 'a'), images: emptyAssets(1000, 'i') })),
    ).toBeUndefined();
    expect(
      rejection(exportBody({ assets: emptyAssets(1000, 'a'), images: emptyAssets(1001, 'i') })),
    ).toBe('tooManyAssets');
  });

  const badBase64 = [
    ['a data: prefix', `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`],
    ['URL-safe characters', '-_-_'],
    ['a length off by one', 'QQ='],
    ['missing padding', 'QQ'],
    ['too much padding', 'Q==='],
    ['only padding', '===='],
    ['interior padding', 'QQ==QQ=='],
    ['whitespace', 'QQ==\n'],
    ['a line break inside', 'QUJD\nREVG'],
    ['non-ASCII', 'QUJé'],
    ['a code unit above 255', 'QUJŁ'],
  ];

  it.each(badBase64)('refuses an asset with %s', (_label, base64) => {
    expect(rejection(exportBody({ assets: [{ name: 'a.png', base64 }] }))).toBe('invalidAsset');
  });

  it.each(badBase64)('refuses an image with %s', (_label, base64) => {
    expect(rejection(exportBody({ images: [{ name: 'a.png', base64 }] }))).toBe('invalidAsset');
  });

  it.each(badBase64)('refuses a png with %s', (_label, png) => {
    expect(rejection(exportBody({ png }))).toBe('invalidAsset');
  });

  it('reports a body whose compact JSON passes the string limit as too large', () => {
    const body = Buffer.concat([
      Buffer.from('{"nodeId":"1:2","node":{"tree":['),
      Buffer.alloc(5 * 25 * 1024 * 1024, '1e20,'),
      Buffer.from('1]}}'),
    ]);
    expect(rejection(body)).toBe('bodyTooLarge');
  }, 60_000);
});

describe('prepareExport identity', () => {
  it('passes a real key through as a file', () => {
    const { lookup } = prepared({ fileKey: 'realKey', fileName: 'Design' });
    expect(lookup.identity).toEqual({ kind: 'file', fileKey: 'realKey' });
  });

  it.each([
    ['a missing key', { fileKey: undefined, fileName: 'Design' }, null],
    ['an empty key', { fileKey: '', fileName: 'Design' }, null],
    ['both missing', { fileKey: undefined, fileName: undefined }, null],
    ['the name fallback', { fileKey: 'Design', fileName: 'Design' }, 'Design'],
    ['the literal fallback', { fileKey: 'current', fileName: '' }, 'current'],
    ['a file named current', { fileKey: 'current', fileName: 'current' }, 'current'],
  ])('leaves %s unidentified', (_label, overrides, claimedKey) => {
    const { lookup } = prepared(overrides);
    expect(lookup.identity).toEqual({ kind: 'unidentified', claimedKey });
  });

  it('never gives two files sharing a name a shared project identity', () => {
    const fallback = { fileKey: 'Untitled', fileName: 'Untitled' };
    const first = prepared({ ...fallback, node: { id: '1:2', name: 'first' } });
    const second = prepared({ ...fallback, node: { id: '1:2', name: 'second' } });
    expect(first.lookup.identity.kind).toBe('unidentified');
    expect(second.lookup.identity.kind).toBe('unidentified');
    expect(first.lookup.contentHash).not.toBe(second.lookup.contentHash);
  });

  it('describes a staged export with its display data', () => {
    expect(prepared().describe(STAGING_ID)).toEqual({
      stagingId: STAGING_ID,
      identity: { kind: 'file', fileKey: 'fixtureFileKey' },
      fileName: 'Fixture file',
      figmaNodeId: '1:2',
      nodeName: 'Fixture frame',
      contentHash: prepared().lookup.contentHash,
      exportedAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('describes absent display data as null', () => {
    const staged = prepared({
      fileName: undefined,
      nodeName: undefined,
      exportedAt: undefined,
    }).describe(STAGING_ID);
    expect(staged).toMatchObject({ fileName: null, nodeName: null, exportedAt: null });
  });

  it('gives a retry with new run fields the same lookup', () => {
    const retry = prepared({
      exportedAt: '2030-01-01T00:00:00.000Z',
      outputDir: '/elsewhere',
      folderName: 'frame-1a2b',
      batchId: 'batch',
      contractVersion: 2,
    });
    expect(retry.lookup).toEqual(prepared().lookup);
  });

  it('does not let a __proto__ key forge identity or pollute anything', () => {
    const body = JSON.stringify(exportPayload({ fileKey: undefined, fileName: undefined }));
    const hostile = `{"__proto__":{"fileKey":"forged","polluted":true},${body.slice(1)}`;
    const result = prepareExport(Buffer.from(hostile));
    if (!result.ok) throw new Error(result.rejection);
    expect(result.prepared.lookup.identity).toEqual({ kind: 'unidentified', claimedKey: null });
    expect(meta(result.prepared).fileKey).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps a nested __proto__ key as data in node.json', () => {
    const hostile = '{"nodeId":"1:2","node":{"__proto__":{"polluted":true}}}';
    const result = prepareExport(Buffer.from(hostile));
    if (!result.ok) throw new Error(result.rejection);
    expect(text(result.prepared, BUNDLE_FILES.node)).toContain('"__proto__"');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('prepareExport bundle', () => {
  it('holds the three always-written files for a minimal export', () => {
    expect(paths(prepared())).toEqual(['node.json', 'figma-components.json', 'meta.json']);
  });

  it('holds every file for a full export', () => {
    const full = prepared({
      remoteMasters: [{ id: '9:9' }],
      variables: { collections: [], tokens: [] },
      styles: { styles: [] },
      svg: '<svg></svg>',
      png: ONE_PIXEL_PNG_BASE64,
      assets: [{ name: 'img-1.png', base64: 'QQ==' }],
      images: [{ imageHash: 'abc', name: 'abc.png', base64: 'Qg==' }],
    });
    expect(paths(full)).toEqual([
      'node.json',
      'figma-components.json',
      'meta.json',
      'remote-masters.json',
      'variables.json',
      'styles.json',
      'preview.svg',
      'preview.html',
      'preview.png',
      'preview.assets/img-1.png',
      'preview.assets/abc.png',
    ]);
  });

  it('writes figma-components.json as an empty list when components are absent', () => {
    expect(JSON.parse(text(prepared({ components: undefined }), 'figma-components.json'))).toEqual(
      [],
    );
  });

  it('writes the tree with two-space indent', () => {
    expect(text(prepared({ node: { id: '1:2' } }), 'node.json')).toBe('{\n  "id": "1:2"\n}');
  });

  it('falls back to compact JSON when the indent passes the string limit', () => {
    const wide = `[${'0,'.repeat(300_000)}0]`;
    const body = `{"nodeId":"1:2","node":{"tree":${nestedJson(900, wide)}}}`;
    const result = prepareExport(Buffer.from(body));
    if (!result.ok) throw new Error(result.rejection);
    expect(text(result.prepared, 'node.json')).toBe(`{"tree":${nestedJson(900, wide)}}`);
  }, 60_000);

  it('writes meta.json with exactly the wire keys, in order', () => {
    const summary = { totalNodes: 3 };
    const full = prepared({
      summary,
      components: [{ id: 'a' }, { id: 'b' }],
      remoteMasters: [{ id: 'c' }],
      variables: { collections: [{ id: 'd' }], tokens: [{ id: 'e' }, { id: 'f' }, { id: 'g' }] },
      styles: { styles: [{ id: 'h' }] },
      svg: '<svg></svg>',
      png: ONE_PIXEL_PNG_BASE64,
      assets: [
        { name: 'img-1.png', base64: 'QQ==' },
        { name: 'icon.key.svg', base64: 'Qg==' },
        { name: 'icon.other.svg', base64: 'Qw==' },
      ],
      images: [
        { name: 'hash1.png', base64: 'RA==' },
        { name: 'hash2.png', base64: 'RQ==' },
      ],
    });
    expect(Object.entries(meta(full))).toEqual([
      ['fileKey', 'fixtureFileKey'],
      ['fileName', 'Fixture file'],
      ['nodeId', '1:2'],
      ['nodeName', 'Fixture frame'],
      ['exportedAt', '2026-01-02T03:04:05.000Z'],
      ['componentCount', 2],
      ['remoteMasterCount', 1],
      ['hasSvg', true],
      ['hasPng', true],
      ['assetCount', 3],
      ['assetImageCount', 1],
      ['assetSvgCount', 2],
      ['hasPreviewHtml', true],
      ['hasVariables', true],
      ['variableCount', 3],
      ['variableCollectionCount', 1],
      ['hasStyles', true],
      ['styleCount', 1],
      ['imageAssetCount', 2],
      ['summary', summary],
    ]);
  });

  it('writes null for absent meta fields and zero for absent counts', () => {
    const bare = '{"nodeId":"1:2","node":{}}';
    const result = prepareExport(Buffer.from(bare));
    if (!result.ok) throw new Error(result.rejection);
    expect(meta(result.prepared)).toMatchObject({
      fileKey: null,
      fileName: null,
      nodeName: null,
      summary: null,
      componentCount: 0,
      hasSvg: false,
      hasPng: false,
      hasPreviewHtml: false,
      hasVariables: false,
      hasStyles: false,
    });
  });

  it('falls back to the server clock for a missing exportedAt', () => {
    const before = Date.now();
    const exportedAt = meta(prepared({ exportedAt: undefined })).exportedAt as string;
    expect(new Date(exportedAt).toISOString()).toBe(exportedAt);
    expect(Date.parse(exportedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(exportedAt)).toBeLessThanOrEqual(Date.now());
  });

  it.each([
    ['tokens as a number', { tokens: 5, collections: 'many' }],
    ['no tokens at all', {}],
  ])('counts zero for variables with %s', (_label, variables) => {
    const counts = meta(prepared({ variables, styles: { styles: 'none' } }));
    expect(counts).toMatchObject({ variableCount: 0, variableCollectionCount: 0, styleCount: 0 });
  });

  it('ignores outputDir and folderName in every path and file', () => {
    const marker = 'HOSTILE-MARKER';
    const exported = prepared({ outputDir: `/${marker}`, folderName: `../${marker}` });
    expect(paths(exported).join()).not.toContain(marker);
    for (const relativePath of paths(exported)) {
      expect(text(exported, relativePath)).not.toContain(marker);
    }
    expect(Object.keys(meta(exported))).not.toEqual(expect.arrayContaining(['outputDir']));
    expect(Object.keys(meta(exported))).not.toEqual(expect.arrayContaining(['folderName']));
  });

  it('lets no name reach a path', () => {
    const exported = prepared({
      fileName: '../file-name-marker',
      nodeName: '../node-name-marker',
      fileKey: '../file-key-marker',
      nodeId: '../node-id-marker',
    });
    expect(paths(exported).join()).not.toContain('marker');
  });

  it('writes no preview files when neither preview arrives', () => {
    const exported = prepared();
    expect(paths(exported).filter((path) => path.startsWith('preview'))).toEqual([]);
    expect(meta(exported)).toMatchObject({ hasSvg: false, hasPng: false, hasPreviewHtml: false });
  });

  it('decodes the png to its bytes', () => {
    const bytes = file(prepared({ png: ONE_PIXEL_PNG_BASE64 }), 'preview.png');
    expect(Buffer.from(bytes).toString('base64')).toBe(ONE_PIXEL_PNG_BASE64);
    expect(Buffer.from(bytes).subarray(1, 4).toString()).toBe('PNG');
  });

  it('decodes assets and images into one shared namespace', () => {
    const exported = prepared({
      assets: [{ name: 'same.png', base64: 'QQ==' }],
      images: [{ name: 'SAME.png', base64: 'Qg==' }],
    });
    const assetPaths = paths(exported).filter((path) => path.startsWith('preview.assets/'));
    expect(assetPaths).toHaveLength(2);
    expect(assetPaths.map((path) => Buffer.from(file(exported, path)).toString())).toEqual([
      'A',
      'B',
    ]);
  });
});

describe('prepareExport preview.html', () => {
  const hostileSvg = '<svg><script>alert(1)</script><text>$& $1 $`</text></svg>';

  it('keeps preview.svg verbatim', () => {
    expect(file(prepared({ svg: hostileSvg }), 'preview.svg')).toBe(hostileSvg);
  });

  it('opens the head with the CSP, ahead of everything attacker-controlled', () => {
    const html = text(prepared({ svg: hostileSvg }), 'preview.html');
    const head = html.indexOf('<head>') + '<head>'.length;
    expect(html.slice(head).trimStart()).toMatch(
      /^<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: file:; style-src 'unsafe-inline'; font-src 'self' data: file:">/,
    );
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<title>'));
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'));
  });

  it('allows no script source', () => {
    const html = text(prepared({ svg: '<svg></svg>' }), 'preview.html');
    expect(html).not.toMatch(/script-src/);
    expect(html).not.toMatch(/unsafe-eval/);
  });

  it('inlines the SVG verbatim', () => {
    expect(text(prepared({ svg: hostileSvg }), 'preview.html')).toContain(hostileSvg);
  });

  it('escapes a node name that tries to close the title', () => {
    const nodeName = `</title><script>alert('x')</script>&"`;
    const html = text(prepared({ svg: '<svg></svg>', nodeName }), 'preview.html');
    expect(html).toContain(
      '<title>&lt;/title&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;&quot;</title>',
    );
    expect(html).not.toContain('<script>');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])('titles the page with the node id when the name is %s', (_label, nodeName) => {
    const html = text(prepared({ svg: '<svg></svg>', nodeId: '<1:2>', nodeName }), 'preview.html');
    expect(html).toContain('<title>&lt;1:2&gt;</title>');
  });

  it('survives a node name far beyond any title', () => {
    const prefix = Buffer.from('{"nodeId":"1:2","node":{},"svg":"<svg></svg>","nodeName":"');
    const body = Buffer.concat([prefix, Buffer.alloc(2 ** 27, '&'), Buffer.from('"}')]);
    const result = prepareExport(body);
    if (!result.ok) throw new Error(result.rejection);
    expect(text(result.prepared, 'preview.html').length).toBeLessThan(16 * 1024);
  }, 60_000);
});

describe('staging', () => {
  let root: string;
  let stagingDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'figma-drop-pipeline-'));
    stagingDir = join(root, 'staging');
    await fs.mkdir(stagingDir);
  });

  afterEach(async () => {
    faults.mkdir = undefined;
    faults.writeFile = undefined;
    faults.rm = undefined;
    await fs.chmod(stagingDir, 0o700);
    await fs.rm(root, { recursive: true, force: true });
  });

  async function stagedPaths(id: string): Promise<string[]> {
    const entries = await fs.readdir(join(stagingDir, id, 'bundle'), {
      recursive: true,
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .map((path) => path.slice(join(stagingDir, id, 'bundle').length + 1))
      .toSorted();
  }

  describe('stageExport', () => {
    it('writes every file under a fresh uuid and describes it', async () => {
      const exported = prepared({
        svg: '<svg>é</svg>',
        png: ONE_PIXEL_PNG_BASE64,
        assets: [{ name: 'img-1.png', base64: 'QQ==' }],
      });
      const result = await stageExport(exported, stagingDir);
      if (!result.ok) throw new Error(result.rejection);
      const { stagingId } = result.staged;

      expect(stagingId).toMatch(UUID);
      expect(result.staged).toEqual(exported.describe(stagingId));
      expect(await fs.readdir(stagingDir)).toEqual([stagingId]);
      expect(await stagedPaths(stagingId)).toEqual([...paths(exported)].toSorted());
      for (const { relativePath, bytes } of exported.files) {
        const written = await fs.readFile(join(stagingDir, stagingId, 'bundle', relativePath));
        expect(written.equals(Buffer.from(bytes))).toBe(true);
      }
    });

    it('takes no part of the staging id from the payload', async () => {
      const staged = [await stageExport(prepared(), stagingDir)];
      staged.push(await stageExport(prepared(), stagingDir));
      const ids = staged.map((result) => (result.ok ? result.staged.stagingId : undefined));
      expect(new Set(ids).size).toBe(2);
    });

    it('creates a staging directory that went missing', async () => {
      const missing = join(stagingDir, 'gone', 'again');
      const result = await stageExport(prepared(), missing);
      expect(result.ok).toBe(true);
    });

    it.each(['..', '.', '../../escape', '/etc/passwd', '.hidden', '\u0000', '日本語'])(
      'keeps an asset named %j inside preview.assets',
      async (name) => {
        const result = await stageExport(
          prepared({ assets: [{ name, base64: 'QQ==' }] }),
          stagingDir,
        );
        if (!result.ok) throw new Error(result.rejection);
        const assets = (await stagedPaths(result.staged.stagingId)).filter(
          (path) => !path.endsWith('.json'),
        );
        expect(assets).toHaveLength(1);
        expect(assets[0]).toMatch(/^preview\.assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/);
        expect(await fs.readdir(root)).toEqual(['staging']);
      },
    );

    it('stages a case-only pair as two files on a case-insensitive volume', async () => {
      const result = await stageExport(
        prepared({
          assets: [
            { name: 'Logo.png', base64: 'QQ==' },
            { name: 'logo.png', base64: 'Qg==' },
          ],
        }),
        stagingDir,
      );
      if (!result.ok) throw new Error(result.rejection);
      const assets = await fs.readdir(
        join(stagingDir, result.staged.stagingId, 'bundle', 'preview.assets'),
      );
      expect(assets).toHaveLength(2);
    });

    it.each(['ENOSPC', 'EDQUOT'])('reports %s on a write as a full disk', async (code) => {
      let writes = 0;
      faults.writeFile = () => {
        writes += 1;
        if (writes === 2) throw errno(code);
      };
      expect(await stageExport(prepared(), stagingDir)).toEqual({
        ok: false,
        rejection: 'diskFull',
      });
      expect(await fs.readdir(stagingDir)).toEqual([]);
    });

    it('reports ENOSPC on a directory as a full disk', async () => {
      faults.mkdir = () => {
        throw errno('ENOSPC');
      };
      expect(await stageExport(prepared(), stagingDir)).toEqual({
        ok: false,
        rejection: 'diskFull',
      });
    });

    it('reports any other write failure as a failed save', async () => {
      let writes = 0;
      faults.writeFile = () => {
        writes += 1;
        if (writes === 2) throw errno('EIO');
      };
      expect(await stageExport(prepared(), stagingDir)).toEqual({
        ok: false,
        rejection: 'saveFailed',
      });
      expect(await fs.readdir(stagingDir)).toEqual([]);
    });

    it('reports a read-only staging directory as a failed save', async () => {
      await fs.chmod(stagingDir, 0o500);
      expect(await stageExport(prepared(), stagingDir)).toEqual({
        ok: false,
        rejection: 'saveFailed',
      });
      await fs.chmod(stagingDir, 0o700);
      expect(await fs.readdir(stagingDir)).toEqual([]);
    });

    it('refuses to write over an existing file, and removes what it wrote', async () => {
      const twice: PreparedExport = {
        ...prepared(),
        files: [
          { relativePath: 'node.json', bytes: 'first' },
          { relativePath: 'node.json', bytes: 'second' },
        ],
      };
      expect(await stageExport(twice, stagingDir)).toEqual({ ok: false, rejection: 'saveFailed' });
      expect(await fs.readdir(stagingDir)).toEqual([]);
    });

    it('still reports the failure when cleanup fails too', async () => {
      faults.writeFile = () => {
        throw errno('ENOSPC');
      };
      faults.rm = () => {
        throw errno('EACCES');
      };
      expect(await stageExport(prepared(), stagingDir)).toEqual({
        ok: false,
        rejection: 'diskFull',
      });
    });
  });

  describe('discardStaging', () => {
    it('removes one staging entry and leaves its neighbours', async () => {
      const kept = await stageExport(prepared(), stagingDir);
      const discarded = await stageExport(prepared(), stagingDir);
      if (!kept.ok || !discarded.ok) throw new Error('staging failed');
      await discardStaging(stagingDir, discarded.staged.stagingId);
      expect(await fs.readdir(stagingDir)).toEqual([kept.staged.stagingId]);
    });

    it('ignores a missing entry', async () => {
      await expect(discardStaging(stagingDir, STAGING_ID)).resolves.toBeUndefined();
    });

    it.each([
      '',
      '.',
      '..',
      '../staging',
      'not-a-uuid',
      'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
      `${STAGING_ID}\n`,
      `${STAGING_ID}/..`,
      `../${STAGING_ID}`,
    ])('refuses to remove %j', async (stagingId) => {
      const stayingFile = join(stagingDir, 'staying');
      await fs.writeFile(stayingFile, 'data');
      await fs.mkdir(join(stagingDir, STAGING_ID));
      await fs.mkdir(join(root, STAGING_ID));
      await discardStaging(stagingDir, stagingId);
      expect((await fs.readdir(stagingDir)).toSorted()).toEqual([STAGING_ID, 'staying'].toSorted());
      expect((await fs.readdir(root)).toSorted()).toEqual([STAGING_ID, 'staging'].toSorted());
    });

    it('never rejects, so a background discard cannot crash the receiver', async () => {
      faults.rm = () => {
        throw errno('EACCES');
      };
      await expect(discardStaging(stagingDir, STAGING_ID)).resolves.toBeUndefined();
    });
  });
});
