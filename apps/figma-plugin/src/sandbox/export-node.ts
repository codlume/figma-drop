import type { RawExport } from '../shared/messages.ts';
import { collectComponents } from './components.ts';
import { type FigmaApi, readFileKey } from './figma-api.ts';
import { collectIcons } from './icons.ts';
import { collectImages } from './images.ts';
import { renderPreviews } from './previews.ts';
import { resolveRemoteMasters } from './remote-masters.ts';
import { serializeTree } from './serialize.ts';
import { collectStyles } from './styles.ts';
import { buildSummary, tallyTree } from './summary.ts';
import { collectVariables } from './variables.ts';

const NODE_CAP = 40000;
// A text layer's default name is its text, and the receiver rejects a long identity
// field. `nodeName` is a display hint, and `node.name` keeps the full name.
const NODE_NAME_CHARS = 1024;

const displayName = (name: string) =>
  name.slice(0, NODE_NAME_CHARS).replace(/[\uD800-\uDBFF]$/, '');

export async function exportNode(figma: FigmaApi, node: BaseNode): Promise<RawExport> {
  const { tree, truncated } = await serializeTree(figma, node, NODE_CAP);
  const { components, remoteMasters, remoteMasterErrors } = await resolveRemoteMasters(
    figma,
    await collectComponents(node),
  );
  // Styles come first so a style's bound variables reach the variable search.
  const styles = await collectStyles(figma, [tree, ...remoteMasters]);
  const variables = await collectVariables(figma, [tree, remoteMasters, styles]);
  const icons = await collectIcons(node);
  const images = await collectImages(figma, node);
  const tally = tallyTree(tree);
  const { svgBytes, pngBytes, svgSkipped } = await renderPreviews(node, tally.totalNodes);
  const fileKey = readFileKey(figma);

  return {
    node: tree,
    ...(fileKey ? { fileKey } : {}),
    fileName: figma.root.name,
    nodeId: node.id,
    nodeName: displayName(node.name),
    exportedAt: new Date().toISOString(),
    summary: buildSummary({
      target: node,
      tally,
      components,
      remoteMastersResolved: remoteMasters.length,
      remoteMasterErrors,
      variables,
      styles,
      imageAssets: images.length,
      truncatedAt: truncated ? NODE_CAP : null,
      preview: { svg: svgBytes !== undefined, png: pngBytes !== undefined, svgSkipped },
    }),
    components,
    remoteMasters,
    ...(variables ? { variables } : {}),
    ...(styles ? { styles } : {}),
    ...(svgBytes ? { svgBytes } : {}),
    ...(pngBytes ? { pngBytes } : {}),
    icons,
    images,
  };
}
