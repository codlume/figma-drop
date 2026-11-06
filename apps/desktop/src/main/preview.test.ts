import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as NodePath from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vite-plus/test';

import type { PreviewFile } from '../shared/integration.ts';
import { previewUrl, type RevisionId } from '../shared/library.ts';
import { previewResponse } from './preview.ts';

const ID = 'rev 1/é' as RevisionId;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

let file: PreviewFile;
const libraryWith = (preview: PreviewFile | null) => ({ previewFile: vi.fn(async () => preview) });

beforeAll(async () => {
  const dir = await mkdtemp(NodePath.join(tmpdir(), 'preview-'));
  file = { path: NodePath.join(dir, 'preview.svg'), contentType: 'image/svg+xml' };
  await writeFile(file.path, SVG);
});

describe('previewResponse', () => {
  it('serves the bytes with the library content type and sandbox headers', async () => {
    const library = libraryWith(file);
    const response = await previewResponse(previewUrl(ID), library);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(SVG);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(library.previewFile).toHaveBeenCalledWith(ID);
  });

  it('answers 404 when the library knows no preview', async () => {
    const response = await previewResponse(previewUrl(ID), libraryWith(null));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
  });

  it('answers 404 when the library is absent', async () => {
    expect((await previewResponse(previewUrl(ID), null)).status).toBe(404);
  });

  it('answers 404 when the file cannot be read', async () => {
    const gone: PreviewFile = { path: `${file.path}.gone`, contentType: 'image/png' };
    expect((await previewResponse(previewUrl(ID), libraryWith(gone))).status).toBe(404);
  });

  it.each([
    'figma-drop-preview://other/abc',
    'figma-drop-preview://revision/',
    'figma-drop-preview://revision/a/b',
    'figma-drop-preview://revision/%E0%A4%A',
    'not a url',
  ])('answers 404 for %s without asking the library', async (url) => {
    const library = libraryWith(file);
    expect((await previewResponse(url, library)).status).toBe(404);
    expect(library.previewFile).not.toHaveBeenCalled();
  });
});
