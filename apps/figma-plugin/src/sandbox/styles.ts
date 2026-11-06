import { attempt, type FigmaApi, read } from './figma-api.ts';
import { type SerializedNode, serializedNodes, STYLE_ID_KEYS } from './serialize.ts';

export type StyleEntry = {
  id: string;
  key: string | null;
  name: string;
  remote: boolean;
  description: string;
  type: BaseStyle['type'];
  boundVariables?: object;
  [detail: string]: unknown;
};

export type StylesExport = { styles: StyleEntry[] };

function styleDetail(style: BaseStyle): Record<string, unknown> {
  switch (style.type) {
    case 'PAINT':
      return { paints: style.paints };
    case 'EFFECT':
      return { effects: style.effects };
    case 'GRID':
      return { layoutGrids: style.layoutGrids };
    case 'TEXT':
      return {
        text: {
          fontName: style.fontName,
          fontSize: style.fontSize,
          letterSpacing: style.letterSpacing,
          lineHeight: style.lineHeight,
          paragraphIndent: style.paragraphIndent,
          paragraphSpacing: style.paragraphSpacing,
          textCase: style.textCase,
          textDecoration: style.textDecoration,
        },
      };
    default:
      return {};
  }
}

function toEntry(style: BaseStyle): StyleEntry {
  const boundVariables = read(style, 'boundVariables');
  const bound =
    typeof boundVariables === 'object' &&
    boundVariables !== null &&
    Object.keys(boundVariables).length > 0;
  return {
    id: style.id,
    key: style.key || null,
    name: style.name,
    remote: style.remote,
    description: style.description || '',
    ...(bound ? { boundVariables } : {}),
    type: style.type,
    ...styleDetail(style),
  };
}

function* referencedStyleIds(trees: readonly SerializedNode[]): Generator<unknown> {
  for (const tree of trees) {
    for (const node of serializedNodes(tree)) {
      for (const key of STYLE_ID_KEYS) yield node[key];
      for (const run of node.styledTextSegments ?? []) {
        yield run.textStyleId;
        yield run.fillStyleId;
      }
    }
  }
}

export async function collectStyles(
  figma: FigmaApi,
  trees: readonly SerializedNode[],
): Promise<StylesExport | undefined> {
  const localStyles = await Promise.all([
    attempt(() => figma.getLocalPaintStylesAsync()),
    attempt(() => figma.getLocalTextStylesAsync()),
    attempt(() => figma.getLocalEffectStylesAsync()),
    attempt(() => figma.getLocalGridStylesAsync()),
  ]);
  const styles = new Map<string, BaseStyle>();
  for (const style of localStyles.flat()) if (style) styles.set(style.id, style);

  for (const id of referencedStyleIds(trees)) {
    if (typeof id !== 'string' || id === 'MIXED' || styles.has(id)) continue;
    const style = await attempt(() => figma.getStyleByIdAsync(id));
    if (style) styles.set(id, style);
  }
  return styles.size > 0 ? { styles: [...styles.values()].map(toEntry) } : undefined;
}
