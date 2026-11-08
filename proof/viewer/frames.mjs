import { crc32, deflateSync } from 'node:zlib';

// Each colour is far from the others so a screenshot sample maps back to one, even after the
// display colour-space shift CDP screenshots carry.
export const COLOR = {
  header: [214, 48, 49],
  headerV2: [9, 132, 227],
  tabBar: [30, 30, 30],
  leftEdge: [0, 150, 90],
  rightEdge: [232, 67, 200],
  white: [255, 255, 255],
};
const ROWS = [
  [253, 203, 110],
  [116, 185, 255],
  [85, 239, 196],
  [162, 155, 254],
  [250, 150, 120],
];
export const PALETTE = [...Object.values(COLOR), ...ROWS];

export function nearest(actual) {
  const distance = (color) => color.reduce((sum, value, i) => sum + (value - actual[i]) ** 2, 0);
  return PALETTE.reduce((best, color) => (distance(color) < distance(best) ? color : best));
}

export const colorName = (rgb) =>
  Object.entries(COLOR).find(([, value]) => value === rgb)?.[0] ?? `row${ROWS.indexOf(rgb) + 1}`;

// 3x5 digit glyphs, one string per row, so row numbers read at any zoom.
const GLYPHS = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '001', '001', '001'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
};

class Raster {
  constructor(width, height, background) {
    this.width = width;
    this.height = height;
    this.pixels = Buffer.alloc(width * height * 3);
    this.rect(0, 0, width, height, background);
  }

  rect(x, y, width, height, [r, g, b]) {
    const x0 = Math.max(0, Math.round(x));
    const x1 = Math.min(this.width, Math.round(x + width));
    const y0 = Math.max(0, Math.round(y));
    const y1 = Math.min(this.height, Math.round(y + height));
    if (x1 <= x0 || y1 <= y0) return;
    const row = Buffer.alloc((x1 - x0) * 3);
    for (let i = 0; i < x1 - x0; i += 1) row.set([r, g, b], i * 3);
    for (let line = y0; line < y1; line += 1) row.copy(this.pixels, (line * this.width + x0) * 3);
  }

  number(value, x, y, scale, color) {
    let left = x;
    for (const digit of String(value)) {
      GLYPHS[digit].forEach((bits, row) => {
        [...bits].forEach((bit, column) => {
          if (bit === '1') this.rect(left + column * scale, y + row * scale, scale, scale, color);
        });
      });
      left += 4 * scale;
    }
  }

  // Bare base64, as the wire carries `png`.
  png() {
    const stride = this.width * 3;
    const scanlines = Buffer.alloc((stride + 1) * this.height);
    for (let y = 0; y < this.height; y += 1) {
      this.pixels.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(scanlines)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
  }
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

// A phone screen at @2x: header on top, numbered content rows, tab bar on the bottom edge.
export function mobileFrame(width, height, header = COLOR.header) {
  const raster = new Raster(width, height, COLOR.white);
  const headerHeight = 176;
  const tabHeight = 166;
  raster.rect(0, 0, width, headerHeight, header);
  raster.rect(40, 96, width * 0.45, 36, COLOR.white);
  const rowHeight = 160;
  const gap = 16;
  let index = 0;
  for (
    let y = headerHeight + gap;
    y + rowHeight <= height - tabHeight - gap;
    y += rowHeight + gap
  ) {
    const fill = ROWS[index % ROWS.length];
    raster.rect(gap, y, width - 2 * gap, rowHeight, fill);
    raster.number(index + 1, 2 * gap, y + 30, 20, COLOR.white);
    raster.rect(width * 0.4, y + 40, width * 0.45, 24, COLOR.white);
    raster.rect(width * 0.4, y + 90, width * 0.3, 24, COLOR.white);
    index += 1;
  }
  raster.rect(0, height - tabHeight, width, tabHeight, COLOR.tabBar);
  for (const slot of [0.125, 0.375, 0.625, 0.875]) {
    raster.rect(width * slot - 28, height - tabHeight + 40, 56, 56, COLOR.white);
  }
  return raster.png();
}

// A desktop screen: header across, a sidebar on the left edge, a strip on the right edge.
export function desktopFrame(width, height) {
  const raster = new Raster(width, height, COLOR.white);
  const sidebar = 480;
  const strip = 64;
  raster.rect(0, 0, width, 120, COLOR.header);
  raster.rect(0, 120, sidebar, height - 120, COLOR.leftEdge);
  raster.rect(width - strip, 120, strip, height - 120, COLOR.rightEdge);
  const columns = 4;
  const cell = (width - sidebar - strip - 40 * (columns + 1)) / columns;
  let index = 0;
  for (let y = 160; y + 360 <= height; y += 400) {
    for (let column = 0; column < columns; column += 1) {
      const x = sidebar + 40 + column * (cell + 40);
      raster.rect(x, y, cell, 360, ROWS[index % ROWS.length]);
      raster.number(index + 1, x + 32, y + 32, 24, COLOR.white);
      index += 1;
    }
  }
  return raster.png();
}

// A banner: solid blocks pin the left and right edges, numbered stripes in between.
export function bannerFrame(width, height) {
  const raster = new Raster(width, height, COLOR.white);
  raster.rect(0, 0, 200, height, COLOR.leftEdge);
  raster.rect(width - 200, 0, 200, height, COLOR.rightEdge);
  const stripe = (width - 400) / ROWS.length;
  ROWS.forEach((fill, index) => {
    raster.rect(200 + index * stripe, 40, stripe - 16, height - 80, fill);
    raster.number(index + 1, 200 + index * stripe + 24, 80, 16, COLOR.white);
  });
  return raster.png();
}
