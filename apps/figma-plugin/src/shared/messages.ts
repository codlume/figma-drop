import type { ExportPayload } from '@figma-drop/export-contract/parser';

export type ExportTarget = { id: string; name: string; type: string };

export type RawFile = { name: string; bytes: Uint8Array };
export type RawImage = RawFile & { imageHash: string };

// The sandbox has no TextDecoder or btoa, so bytes cross to the UI, which encodes
// them. `icons` become `assets` entries after the SVG's own rasters.
export type RawExport = Pick<
  ExportPayload,
  | 'node'
  | 'fileKey'
  | 'fileName'
  | 'nodeId'
  | 'nodeName'
  | 'exportedAt'
  | 'summary'
  | 'components'
  | 'remoteMasters'
  | 'variables'
  | 'styles'
> & {
  svgBytes?: Uint8Array;
  pngBytes?: Uint8Array;
  icons: RawFile[];
  images: RawImage[];
};

export type UiToSandbox = { type: 'ui-ready' } | { type: 'export-node'; nodeId: string };

export type SandboxToUi =
  | { type: 'selection'; targets: ExportTarget[]; hasFileKey: boolean }
  | { type: 'node-exported'; nodeId: string; raw: RawExport }
  | { type: 'node-failed'; nodeId: string; message: string };
