import { CONTRACT_VERSION } from '@figma-drop/export-contract';
import type { ExportPayload } from '@figma-drop/export-contract/parser';
import type { RawExport } from '../shared/messages.ts';

type Asset = { name: string; base64: string };

// A multiple of 3, so each chunk encodes with no padding and the parts join into
// one valid string. Small enough to pass as call arguments on any engine.
const BASE64_CHUNK_BYTES = 3 * 8192;

export function toBase64(bytes: Uint8Array): string {
  let encoded = '';
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(start, start + BASE64_CHUNK_BYTES);
    encoded += btoa(String.fromCharCode(...chunk));
  }
  return encoded;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/png': 'png',
};

const EMBEDDED_IMAGE = /(\s(?:xlink:)?href=")data:(image\/[^;,"]+)(?:;[^;,"]+)*;base64,([^"]*)"/g;

function extractRasters(svg: string): { svg: string; rasters: Asset[] } {
  const nameByBase64 = new Map<string, string>();
  const rewritten = svg.replace(
    EMBEDDED_IMAGE,
    (_match, attribute: string, mime: string, base64: string) => {
      let name = nameByBase64.get(base64);
      if (name === undefined) {
        name = `img-${nameByBase64.size}.${EXTENSION_BY_MIME[mime] ?? 'bin'}`;
        nameByBase64.set(base64, name);
      }
      return `${attribute}preview.assets/${name}"`;
    },
  );
  const rasters = Array.from(nameByBase64, ([base64, name]) => ({ name, base64 }));
  return { svg: rewritten, rasters };
}

export function encodeExport(raw: RawExport): ExportPayload {
  const { svgBytes, pngBytes, icons, images, ...fields } = raw;
  const preview = svgBytes && extractRasters(new TextDecoder().decode(svgBytes));
  const assets: Asset[] = [
    ...(preview?.rasters ?? []),
    ...icons.map(({ name, bytes }) => ({ name, base64: toBase64(bytes) })),
  ];

  return {
    ...fields,
    contractVersion: CONTRACT_VERSION,
    ...(preview && { svg: preview.svg }),
    ...(pngBytes && { png: toBase64(pngBytes) }),
    ...(assets.length > 0 && { assets }),
    ...(images.length > 0 && {
      images: images.map(({ imageHash, name, bytes }) => ({
        imageHash,
        name,
        base64: toBase64(bytes),
      })),
    }),
  };
}
