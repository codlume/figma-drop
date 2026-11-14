export type FigmaApi = Pick<
  PluginAPI,
  | 'fileKey'
  | 'root'
  | 'mixed'
  | 'getImageByHash'
  | 'getLocalEffectStylesAsync'
  | 'getLocalGridStylesAsync'
  | 'getLocalPaintStylesAsync'
  | 'getLocalTextStylesAsync'
  | 'getStyleByIdAsync'
  | 'importComponentByKeyAsync'
  | 'importComponentSetByKeyAsync'
  | 'variables'
>;

// Figma getters throw for properties a node can't answer, and a throw means absent.
export function read(target: object, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

export async function attempt<T>(task: () => T | Promise<T>): Promise<T | null> {
  try {
    return await task();
  } catch {
    return null;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readFileKey(figma: Pick<PluginAPI, 'fileKey'>): string | undefined {
  const key = read(figma, 'fileKey');
  return typeof key === 'string' && key !== '' ? key : undefined;
}

export function childrenOf(node: BaseNode): readonly BaseNode[] {
  const children = read(node, 'children');
  return Array.isArray(children) ? children : [];
}

export function isHidden(node: BaseNode): boolean {
  return read(node, 'visible') === false;
}

export function* visibleNodes(root: BaseNode): Generator<BaseNode> {
  const pending: (BaseNode | undefined)[] = [root];
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (isHidden(node)) continue;
    yield node;
    const children = childrenOf(node);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
  }
}

export function visiblePaints(node: BaseNode): readonly Paint[] {
  const fills = read(node, 'fills');
  return Array.isArray(fills) ? fills.filter((paint: Paint) => paint.visible !== false) : [];
}

export function mainComponentOf(instance: InstanceNode): Promise<ComponentNode | null> {
  return attempt(() => instance.getMainComponentAsync());
}
