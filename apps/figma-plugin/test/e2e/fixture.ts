import { createFakeFigma, type FakeFigmaOptions } from '../../src/sandbox/testing/fake-figma.ts';

export const FILE_KEY = 'SYNTHfixture0000000000';
export const FILE_NAME = 'Synthetic Fixture';

export const LOCAL_ICON_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f001234567';
export const REMOTE_BUTTON_KEY = 'feedface00000000000000000000000000000001';
export const IMAGE_HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const SURFACE_STYLE_ID = 'S:aaaa000000000000000000000000000000000001,';
export const SURFACE_VARIABLE_ID = 'VariableID:1:2';

const bytesOf = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'));
const textBytes = (text: string) => new TextEncoder().encode(text);

export const PIXEL_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
export const IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAC0lEQVR42mNgQAcAABIAAQ==';
export const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h8v8z"/></svg>';

const CARD_SVG = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,${PIXEL_BASE64}"/></svg>`;
export const CARD_SVG_ON_THE_WIRE =
  '<svg xmlns="http://www.w3.org/2000/svg"><image href="preview.assets/img-0.png"/></svg>';

const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id });
const white = {
  type: 'SOLID',
  visible: true,
  opacity: 1,
  blendMode: 'NORMAL',
  color: { r: 1, g: 1, b: 1 },
};

export function createFigmaFile(
  options: FakeFigmaOptions = { fileKey: FILE_KEY, fileName: FILE_NAME },
) {
  const fake = createFakeFigma(options);
  return {
    fake,
    frame: (id: string, name: string) => fake.node('FRAME', { id, name }),
  };
}

/** A frame with text, a vector, an image fill, a local and a remote instance, and a bound variable. */
export function createProfileCard({ fake }: ReturnType<typeof createFigmaFile>) {
  fake.addCollection({
    id: 'VariableCollectionId:1:1',
    name: 'Theme',
    key: 'c0ffee0000000000000000000000000000000001',
    modes: [{ modeId: '1:0', name: 'Light' }],
  });
  fake.addVariable({
    id: SURFACE_VARIABLE_ID,
    name: 'color/surface',
    key: 'c0ffee0000000000000000000000000000000002',
    resolvedType: 'COLOR',
    variableCollectionId: 'VariableCollectionId:1:1',
    valuesByMode: { '1:0': { r: 1, g: 1, b: 1, a: 1 } },
  });
  fake.addStyle({
    id: SURFACE_STYLE_ID,
    key: 'aaaa000000000000000000000000000000000001',
    name: 'Surface/Card',
    type: 'PAINT',
    paints: [white],
  });
  fake.addImage(IMAGE_HASH, bytesOf(IMAGE_BASE64));

  const localIcon = fake.node('COMPONENT', { id: '20:1', name: 'Icon/Close', key: LOCAL_ICON_KEY });
  const remoteButton = fake.node('COMPONENT', {
    id: '30:1',
    name: 'Library Button',
    key: REMOTE_BUTTON_KEY,
    remote: true,
    children: [fake.node('TEXT', { id: '30:2', name: 'Label', characters: 'Go' })],
  });
  fake.publish(remoteButton);

  return fake.node('FRAME', {
    id: '10:1',
    name: 'Profile Card',
    fills: [{ ...white, boundVariables: { color: alias(SURFACE_VARIABLE_ID) } }],
    boundVariables: { fills: [alias(SURFACE_VARIABLE_ID)] },
    fillStyleId: SURFACE_STYLE_ID,
    renders: { SVG: textBytes(CARD_SVG), PNG: bytesOf(PIXEL_BASE64) },
    children: [
      fake.node('TEXT', { id: '10:2', name: 'Title', characters: 'Ada Example' }),
      fake.node('VECTOR', { id: '10:3', name: 'Divider' }),
      fake.node('RECTANGLE', {
        id: '10:4',
        name: 'Avatar',
        fills: [{ type: 'IMAGE', visible: true, scaleMode: 'FILL', imageHash: IMAGE_HASH }],
      }),
      fake.node('INSTANCE', {
        id: '10:5',
        name: 'Close',
        main: localIcon,
        renders: { SVG: textBytes(ICON_SVG) },
        children: [fake.node('VECTOR', { id: 'I10:5;20:2', name: 'Glyph' })],
      }),
      fake.node('INSTANCE', {
        id: '10:6',
        name: 'Follow',
        main: remoteButton,
        children: [fake.node('TEXT', { id: 'I10:6;30:2', name: 'Label', characters: 'Follow' })],
      }),
    ],
  });
}
