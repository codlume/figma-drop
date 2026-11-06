import type { ComponentEntry } from './components.ts';
import type { RemoteMasterError } from './remote-masters.ts';
import { type SerializedNode, serializedNodes } from './serialize.ts';
import type { StylesExport } from './styles.ts';
import type { VariablesExport } from './variables.ts';

const MAX_TEXT_SAMPLES = 15;
const MAX_SAMPLE_LENGTH = 60;

function textSample(characters: string): string {
  const collapsed = characters.trim().replace(/\s+/g, ' ');
  return collapsed.length > MAX_SAMPLE_LENGTH
    ? `${collapsed.slice(0, MAX_SAMPLE_LENGTH)}…`
    : collapsed;
}

export function tallyTree(tree: SerializedNode): {
  totalNodes: number;
  nodeTypes: Record<string, number>;
  textLayerCount: number;
  textSamples: string[];
} {
  const types = new Map<string, number>();
  const textSamples: string[] = [];
  let totalNodes = 0;

  for (const node of serializedNodes(tree)) {
    totalNodes += 1;
    types.set(node.type, (types.get(node.type) ?? 0) + 1);
    if (typeof node.characters !== 'string' || textSamples.length >= MAX_TEXT_SAMPLES) continue;
    const sample = textSample(node.characters);
    if (sample) textSamples.push(sample);
  }
  return {
    totalNodes,
    nodeTypes: Object.fromEntries(types),
    textLayerCount: types.get('TEXT') ?? 0,
    textSamples,
  };
}

function componentCounts(components: readonly ComponentEntry[]) {
  const remote = components.filter((component) => component.remote).length;
  return { total: components.length, local: components.length - remote, remote };
}

function variantSets(components: readonly ComponentEntry[]) {
  const sets = new Map<string, ComponentEntry['variantProperties']>();
  for (const { name, setName, variantProperties } of components) {
    if (variantProperties && !sets.has(setName ?? name)) {
      sets.set(setName ?? name, variantProperties);
    }
  }
  return [...sets].map(([name, axes]) => ({ name, axes }));
}

function styleCounts({ styles }: StylesExport) {
  const count = (type: StylesExport['styles'][number]['type']) =>
    styles.filter((style) => style.type === type).length;
  return {
    paint: count('PAINT'),
    text: count('TEXT'),
    effect: count('EFFECT'),
    grid: count('GRID'),
  };
}

export function buildSummary(parts: {
  target: BaseNode;
  tally: ReturnType<typeof tallyTree>;
  components: readonly ComponentEntry[];
  remoteMastersResolved: number;
  remoteMasterErrors: readonly RemoteMasterError[];
  variables: VariablesExport | undefined;
  styles: StylesExport | undefined;
  imageAssets: number;
  truncatedAt: number | null;
  preview: { svg: boolean; png: boolean; svgSkipped: boolean };
}): Record<string, unknown> {
  const { target, tally, components, variables, styles, imageAssets, truncatedAt } = parts;
  return {
    target: { id: target.id, name: target.name, type: target.type },
    ...tally,
    components: componentCounts(components),
    sets: variantSets(components),
    remoteMastersResolved: parts.remoteMastersResolved,
    remoteMasterErrors: parts.remoteMasterErrors,
    ...(variables
      ? {
          variables: { collections: variables.collections.length, tokens: variables.tokens.length },
        }
      : {}),
    ...(styles ? { styles: styleCounts(styles) } : {}),
    ...(imageAssets > 0 ? { imageAssets } : {}),
    truncated: truncatedAt !== null,
    truncatedAt,
    preview: parts.preview,
  };
}
