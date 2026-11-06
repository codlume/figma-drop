import { type FigmaApi, mainComponentOf, read } from './figma-api.ts';
import { parseVariantName, variantAxes } from './variants.ts';

export type SerializedNode = {
  id: string;
  name: string;
  type: string;
  children?: SerializedNode[];
  styledTextSegments?: { textStyleId?: string; fillStyleId?: string }[];
  [key: string]: unknown;
};

export const STYLE_ID_KEYS = [
  'effectStyleId',
  'fillStyleId',
  'gridStyleId',
  'strokeStyleId',
  'textStyleId',
] as const;

const EMPTY_MEANS_ABSENT: ReadonlySet<string> = new Set(STYLE_ID_KEYS);

// One list serves every type: a key the type lacks reads as undefined and drops out.
const NODE_KEYS = [
  ...STYLE_ID_KEYS,
  'absoluteBoundingBox',
  'backgrounds',
  'blendMode',
  'boundVariables',
  'characters',
  'componentProperties',
  'componentPropertyDefinitions',
  'constraints',
  'cornerRadius',
  'counterAxisAlignItems',
  'counterAxisSizingMode',
  'counterAxisSpacing',
  'effects',
  'fills',
  'fontName',
  'fontSize',
  'fontWeight',
  'height',
  'isMask',
  'itemSpacing',
  'layoutAlign',
  'layoutGrow',
  'layoutMode',
  'layoutSizingHorizontal',
  'layoutSizingVertical',
  'layoutWrap',
  'letterSpacing',
  'lineHeight',
  'locked',
  'opacity',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'primaryAxisAlignItems',
  'primaryAxisSizingMode',
  'rotation',
  'strokeAlign',
  'strokes',
  'strokeWeight',
  'textAlignHorizontal',
  'textAlignVertical',
  'textAutoResize',
  'textCase',
  'textDecoration',
  'variantProperties',
  'visible',
  'width',
  'x',
  'y',
] as const;

const NODES_PER_YIELD = 1000;

function identity(node: BaseNode): SerializedNode {
  return { id: node.id, name: node.name, type: node.type };
}

function allowlistedKeys(figma: FigmaApi, node: BaseNode): Record<string, unknown> {
  const copied: Record<string, unknown> = {};
  for (const key of NODE_KEYS) {
    const value = read(node, key);
    if (value === undefined) continue;
    if (value === '' && EMPTY_MEANS_ABSENT.has(key)) continue;
    copied[key] = value === figma.mixed ? 'MIXED' : value;
  }
  return copied;
}

function styledSegments(text: TextNode): Record<string, unknown>[] | undefined {
  try {
    return text
      .getStyledTextSegments(['textStyleId', 'fillStyleId'])
      .map(({ characters, start, end, textStyleId, fillStyleId }) => ({
        characters,
        start,
        end,
        ...(textStyleId ? { textStyleId } : {}),
        ...(fillStyleId ? { fillStyleId } : {}),
      }));
  } catch {
    return undefined;
  }
}

function present(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}

async function derivedKeys(
  node: BaseNode,
  copied: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (node.type) {
    case 'TEXT': {
      const mixed = copied.textStyleId === 'MIXED' || copied.fillStyleId === 'MIXED';
      return mixed ? present('styledTextSegments', styledSegments(node)) : {};
    }
    case 'COMPONENT':
      return present('variantValues', parseVariantName(node.name));
    case 'COMPONENT_SET':
      return present('variantProperties', variantAxes(node));
    case 'INSTANCE': {
      const main = await mainComponentOf(node);
      if (!main) return {};
      return {
        mainComponentId: main.id,
        mainComponentName: main.name,
        mainComponentKey: main.key,
      };
    }
    default:
      return {};
  }
}

// `cap` counts visited nodes, so pending siblings in open ancestors still become stubs.
export async function serializeTree(
  figma: FigmaApi,
  root: BaseNode,
  cap: number,
): Promise<{ tree: SerializedNode; truncated: boolean }> {
  let visited = 0;
  let truncated = false;

  async function visit(node: BaseNode): Promise<SerializedNode> {
    visited += 1;
    if (visited % NODES_PER_YIELD === 0) await new Promise((resume) => setTimeout(resume, 0));
    if (visited > cap) {
      truncated = true;
      return { ...identity(node), truncated: true };
    }
    const copied = allowlistedKeys(figma, node);
    const serialized = { ...identity(node), ...copied, ...(await derivedKeys(node, copied)) };
    const children = read(node, 'children');
    if (Array.isArray(children)) {
      serialized.children = [];
      for (const child of children) serialized.children.push(await visit(child));
    }
    return serialized;
  }

  const tree = await visit(root);
  return { tree, truncated };
}

export function* serializedNodes(tree: SerializedNode): Generator<SerializedNode> {
  yield tree;
  for (const child of tree.children ?? []) yield* serializedNodes(child);
}
