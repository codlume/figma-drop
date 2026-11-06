export const CONTRACT_VERSION = 1;

export const RECEIVER_PORT = 3579;
export const RECEIVER_HOST = 'localhost';
export const RECEIVER_ORIGIN = `http://${RECEIVER_HOST}:${RECEIVER_PORT}`;
export const LOOPBACK_BIND_ADDRESSES = ['127.0.0.1', '::1'] as const;

export const ROUTES = {
  health: '/',
  sync: '/sync',
  open: '/open',
  pickFolder: '/pick-folder',
} as const;

// Working assumption until a real plugin run records the iframe's Origin.
// It is a filter, not authentication: a hostile sandboxed iframe sends it too.
export const PLUGIN_ORIGIN = 'null';

export const JSON_CONTENT_TYPE = 'application/json';

// One request is one node with its image bytes as base64.
export const MAX_BODY_BYTES = 256 * 1024 * 1024;

// Upstream's plugin sets no timeout, so a silent receiver stalls a batch forever.
export const REPLY_DEADLINE_MS = 60_000;

// Upstream's plugin matches this text in `{error}` and offers its folder picker.
export const FORBIDDEN_ERROR_TEXT = 'output folder';

export const LITERAL_FALLBACK_FILE_KEY = 'current';

// None of these describe the design. `exportedAt` and `batchId` change on every
// run, `outputDir` and `folderName` describe placement, and `contractVersion`
// changes with a plugin upgrade.
export const HASH_EXCLUDED_FIELDS = [
  'exportedAt',
  'outputDir',
  'folderName',
  'batchId',
  'contractVersion',
] as const;

export const BUNDLE_FILES = {
  node: 'node.json',
  components: 'figma-components.json',
  meta: 'meta.json',
  remoteMasters: 'remote-masters.json',
  variables: 'variables.json',
  styles: 'styles.json',
  previewSvg: 'preview.svg',
  previewPng: 'preview.png',
  previewHtml: 'preview.html',
  previewAssetsDir: 'preview.assets',
} as const;

export function allowedHostHeaders(port: number): readonly string[] {
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
}
