import { BUNDLE_FILES } from '@figma-drop/export-contract';
import type { ExportPayload } from '@figma-drop/export-contract/parser';
import { placeAssets } from './asset-names';
import type { BundleFile } from './export-pipeline';
import type { RejectionCode } from './rejections';

export const MAX_ASSETS = 2000;

// Sized for a screenshot tab, and applied before escaping: a name of hundreds of
// megabytes exhausts the heap in the replacement, which no catch can recover from.
const MAX_TITLE_LENGTH = 1024;

const PREVIEW_CSP =
  "default-src 'none'; img-src 'self' data: file:; style-src 'unsafe-inline'; font-src 'self' data: file:";

const IS_BASE64_CODE = new Uint8Array(256);
for (const code of Buffer.from(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
)) {
  IS_BASE64_CODE[code] = 1;
}

// A scan rather than a pattern: a grouped regex overflows V8's backtrack stack on
// a long value. Buffer.from accepts anything, URL-safe characters included, so
// this is the only check base64 gets.
function isStrictBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  let end = value.length;
  if (value[end - 1] === '=') end -= 1;
  if (value[end - 1] === '=') end -= 1;
  for (let index = 0; index < end; index += 1) {
    if (IS_BASE64_CODE[value.charCodeAt(index)] !== 1) return false;
  }
  return true;
}

// Pretty output of a deep tree can pass V8's string limit where compact fits.
function toJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    if (error instanceof RangeError) return JSON.stringify(value);
    throw error;
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function previewHtml(title: string, svg: string): string {
  return `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">
<meta charset="utf-8">
<title>${escapeHtml(title.slice(0, MAX_TITLE_LENGTH))}</title>
</head>
<body>
${svg}
</body>
</html>
`;
}

// A hostile `variables` or `styles` can hold anything under these keys.
function lengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function bundleMeta(payload: ExportPayload) {
  const { svg, png, variables, styles } = payload;
  const assets = payload.assets ?? [];
  const assetSvgCount = assets.filter(({ name }) => name.endsWith('.svg')).length;
  return {
    fileKey: payload.fileKey ?? null,
    fileName: payload.fileName ?? null,
    nodeId: payload.nodeId ?? null,
    nodeName: payload.nodeName ?? null,
    exportedAt: payload.exportedAt ?? new Date().toISOString(),
    componentCount: lengthOf(payload.components),
    remoteMasterCount: lengthOf(payload.remoteMasters),
    hasSvg: svg !== undefined,
    hasPng: png !== undefined,
    assetCount: assets.length,
    assetImageCount: assets.length - assetSvgCount,
    assetSvgCount,
    hasPreviewHtml: svg !== undefined,
    hasVariables: variables !== undefined,
    variableCount: lengthOf(variables?.tokens),
    variableCollectionCount: lengthOf(variables?.collections),
    hasStyles: styles !== undefined,
    styleCount: lengthOf(styles?.styles),
    imageAssetCount: lengthOf(payload.images),
    summary: payload.summary ?? null,
  };
}

export type BundleResult =
  | { ok: true; files: BundleFile[] }
  | { ok: false; rejection: Extract<RejectionCode, 'tooManyAssets' | 'invalidAsset'> };

// Throws RangeError when a file exceeds V8's string limit even as compact JSON.
export function buildBundleFiles(payload: ExportPayload & { nodeId: string }): BundleResult {
  const { node, components, remoteMasters, variables, styles, svg, png } = payload;
  const encodedAssets = [...(payload.assets ?? []), ...(payload.images ?? [])];
  if (encodedAssets.length > MAX_ASSETS) return { ok: false, rejection: 'tooManyAssets' };
  const allBase64 = encodedAssets.every(({ base64 }) => isStrictBase64(base64));
  if (!allBase64 || (png !== undefined && !isStrictBase64(png))) {
    return { ok: false, rejection: 'invalidAsset' };
  }

  const files: BundleFile[] = [
    { relativePath: BUNDLE_FILES.node, bytes: toJson(node) },
    { relativePath: BUNDLE_FILES.components, bytes: toJson(components ?? []) },
    { relativePath: BUNDLE_FILES.meta, bytes: toJson(bundleMeta(payload)) },
  ];
  if (remoteMasters?.length) {
    files.push({ relativePath: BUNDLE_FILES.remoteMasters, bytes: toJson(remoteMasters) });
  }
  if (variables) files.push({ relativePath: BUNDLE_FILES.variables, bytes: toJson(variables) });
  if (styles) files.push({ relativePath: BUNDLE_FILES.styles, bytes: toJson(styles) });
  if (svg !== undefined) {
    const title = payload.nodeName || payload.nodeId;
    files.push(
      { relativePath: BUNDLE_FILES.previewSvg, bytes: svg },
      { relativePath: BUNDLE_FILES.previewHtml, bytes: previewHtml(title, svg) },
    );
  }
  if (png !== undefined) {
    files.push({ relativePath: BUNDLE_FILES.previewPng, bytes: Buffer.from(png, 'base64') });
  }
  const assets = placeAssets(
    encodedAssets.map(({ name, base64 }) => ({ name, bytes: Buffer.from(base64, 'base64') })),
  );
  for (const { name, bytes } of assets) {
    files.push({ relativePath: `${BUNDLE_FILES.previewAssetsDir}/${name}`, bytes });
  }
  return { ok: true, files };
}
