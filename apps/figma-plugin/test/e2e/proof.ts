import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportPayload } from '@figma-drop/export-contract/parser';

export const PROOF_DIR = join(import.meta.dirname, '../../../../proof/figma-plugin');

function elideBase64(base64: string): string {
  const digest = createHash('sha256').update(base64).digest('hex').slice(0, 12);
  return `<base64 elided: ${base64.length} chars, sha256 ${digest}>`;
}

type Tree = { id?: unknown; name?: unknown; type?: unknown; children?: unknown };

function outline({ id, name, type, children }: Tree): object {
  return {
    id,
    name,
    type,
    ...(Array.isArray(children) ? { children: children.map(outline) } : {}),
  };
}

export function writeSamplePayload(payload: ExportPayload) {
  const sample = {
    note: 'Synthetic fixture through a fake figma global. Base64 and the timestamp are elided, and node trees keep only id, name, type.',
    ...payload,
    exportedAt: '<timestamp elided>',
    node: outline(payload.node),
    remoteMasters: payload.remoteMasters?.map((master) => outline(master as Tree)),
    png: payload.png === undefined ? undefined : elideBase64(payload.png),
    assets: payload.assets?.map(({ name, base64 }) => ({ name, base64: elideBase64(base64) })),
    images: payload.images?.map(({ base64, ...image }) => ({
      ...image,
      base64: elideBase64(base64),
    })),
  };
  mkdirSync(PROOF_DIR, { recursive: true });
  writeFileSync(join(PROOF_DIR, 'sample-payload.json'), `${JSON.stringify(sample, null, 2)}\n`);
}

export function writeScreenshot(name: string, png: Buffer) {
  const directory = join(PROOF_DIR, 'screenshots');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.png`), png);
}
