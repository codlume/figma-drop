import { nativeImage, type NativeImage } from 'electron';

// A downward arrow into an open tray, on a 36-unit grid.
const GRID = 36;
const STEM = { left: 16, right: 20, top: 3, bottom: 15 };
const HEAD = { tipX: 18, tipY: 25, top: 14, halfWidth: 9 };
const TRAY_RECTS = [
  [4, 19, 3, 14],
  [29, 19, 3, 14],
  [4, 30, 28, 3],
] as const;

function insideGlyph(x: number, y: number): boolean {
  const gx = x * GRID;
  const gy = y * GRID;
  const inStem = gx >= STEM.left && gx <= STEM.right && gy >= STEM.top && gy <= STEM.bottom;
  const headHeight = HEAD.tipY - HEAD.top;
  const inHead =
    gy >= HEAD.top &&
    gy <= HEAD.tipY &&
    Math.abs(gx - HEAD.tipX) <= ((HEAD.tipY - gy) * HEAD.halfWidth) / headHeight;
  const inTray = TRAY_RECTS.some(
    ([rx, ry, w, h]) => gx >= rx && gx <= rx + w && gy >= ry && gy <= ry + h,
  );
  return inStem || inHead || inTray;
}

function rasterize(size: number): Buffer {
  const samples = 4;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let covered = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          if (insideGlyph(x, y)) covered += 1;
        }
      }
      pixels[(py * size + px) * 4 + 3] = Math.round((255 * covered) / (samples * samples));
    }
  }
  return pixels;
}

export function createTrayIcon(): NativeImage {
  const image = nativeImage.createFromBitmap(rasterize(18), { width: 18, height: 18 });
  image.addRepresentation({ scaleFactor: 2, width: 36, height: 36, buffer: rasterize(36) });
  image.setTemplateImage(true);
  return image;
}
