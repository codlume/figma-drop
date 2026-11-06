import { attempt, read } from './figma-api.ts';

const SVG_NODE_LIMIT = 6000;
const PNG_MAX_WIDTH = 2048;

type Previews = { svgBytes?: Uint8Array; pngBytes?: Uint8Array; svgSkipped: boolean };

export async function renderPreviews(node: BaseNode, totalNodes: number): Promise<Previews> {
  if (!('exportAsync' in node)) return { svgSkipped: false };

  const svgSkipped = totalNodes > SVG_NODE_LIMIT;
  const svgBytes = svgSkipped ? null : await attempt(() => node.exportAsync({ format: 'SVG' }));

  const width = read(node, 'width');
  const constraint: ExportSettingsConstraints =
    typeof width === 'number' && width > PNG_MAX_WIDTH
      ? { type: 'WIDTH', value: PNG_MAX_WIDTH }
      : { type: 'SCALE', value: 2 };
  const pngBytes = await attempt(() => node.exportAsync({ format: 'PNG', constraint }));

  return {
    ...(svgBytes ? { svgBytes } : {}),
    ...(pngBytes ? { pngBytes } : {}),
    svgSkipped,
  };
}
