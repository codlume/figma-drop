import { readFile } from 'node:fs/promises';

import type { Library } from '../shared/integration.ts';
import type { RevisionId } from '../shared/library.ts';

// Previews are images. These headers keep exported SVG from ever running as a document, even if
// something navigates straight to a preview URL.
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
};

function parseRevisionId(requestUrl: string): RevisionId | null {
  const url = URL.parse(requestUrl);
  if (url?.hostname !== 'revision') return null;
  const [id, ...rest] = url.pathname.slice(1).split('/');
  if (!id || rest.length > 0) return null;
  try {
    return decodeURIComponent(id) as RevisionId;
  } catch {
    return null;
  }
}

export async function previewResponse(
  requestUrl: string,
  library: Pick<Library, 'previewFile'> | null,
): Promise<Response> {
  const notFound = new Response(null, { status: 404, headers: HEADERS });
  const revisionId = parseRevisionId(requestUrl);
  if (!library || !revisionId) return notFound;
  const file = await library.previewFile(revisionId);
  if (!file) return notFound;
  try {
    return new Response(await readFile(file.path), {
      headers: { ...HEADERS, 'Content-Type': file.contentType },
    });
  } catch {
    return notFound;
  }
}
