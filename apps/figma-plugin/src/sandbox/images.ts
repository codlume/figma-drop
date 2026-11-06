import type { RawImage } from '../shared/messages.ts';
import { attempt, type FigmaApi, visibleNodes, visiblePaints } from './figma-api.ts';
import { slug } from './slug.ts';

const MAX_IMAGE_FILES = 500;

const SIGNATURES = [
  { extension: 'png', offset: 0, bytes: [0x89, 0x50] },
  { extension: 'jpg', offset: 0, bytes: [0xff, 0xd8] },
  { extension: 'gif', offset: 0, bytes: [0x47, 0x49, 0x46] },
  { extension: 'webp', offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
];

function imageExtension(bytes: Uint8Array): string {
  const match = SIGNATURES.find((signature) =>
    signature.bytes.every((byte, index) => bytes[signature.offset + index] === byte),
  );
  return match?.extension ?? 'png';
}

export async function collectImages(figma: FigmaApi, root: BaseNode): Promise<RawImage[]> {
  const images: RawImage[] = [];
  const seenHashes = new Set<string>();

  for (const node of visibleNodes(root)) {
    for (const paint of visiblePaints(node)) {
      if (paint.type !== 'IMAGE' || !paint.imageHash || seenHashes.has(paint.imageHash)) continue;
      if (images.length >= MAX_IMAGE_FILES) return images;
      const imageHash = paint.imageHash;
      seenHashes.add(imageHash);
      const bytes = await attempt(() => figma.getImageByHash(imageHash)?.getBytesAsync());
      if (!bytes) continue;
      const name = `${slug(imageHash, 'image')}.${imageExtension(bytes)}`;
      images.push({ imageHash, name, bytes });
    }
  }
  return images;
}
