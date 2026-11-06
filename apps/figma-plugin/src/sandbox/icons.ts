import type { RawFile } from '../shared/messages.ts';
import {
  attempt,
  childrenOf,
  isHidden,
  mainComponentOf,
  read,
  visibleNodes,
  visiblePaints,
} from './figma-api.ts';
import { slug } from './slug.ts';

const MAX_ICON_FILES = 500;

function isZeroSized(node: BaseNode): boolean {
  return [read(node, 'width'), read(node, 'height')].some(
    (size) => typeof size === 'number' && size <= 0,
  );
}

function isVectorOnly(node: BaseNode): boolean {
  for (const visible of visibleNodes(node)) {
    if (visible.type === 'TEXT') return false;
    if (visiblePaints(visible).some((paint) => paint.type === 'IMAGE')) return false;
  }
  return true;
}

async function iconIdentity(
  node: ComponentNode | InstanceNode,
): Promise<{ key: string; name: string }> {
  const source = node.type === 'INSTANCE' ? await mainComponentOf(node) : node;
  return source
    ? { key: source.key || source.id, name: source.name }
    : { key: node.id, name: node.name };
}

function freeName(base: string, taken: ReadonlySet<string>): string {
  let name = `${base}.svg`;
  for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}-${suffix}.svg`;
  return name;
}

export async function collectIcons(root: BaseNode): Promise<RawFile[]> {
  const icons: RawFile[] = [];
  const seenKeys = new Set<string>();
  const takenNames = new Set<string>();

  async function addIcon(node: ComponentNode | InstanceNode): Promise<void> {
    const { key, name } = await iconIdentity(node);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    const bytes = await attempt(() => node.exportAsync({ format: 'SVG' }));
    if (!bytes) return;
    const fileName = freeName(`${slug(name, 'icon')}.${slug(key, 'key')}`, takenNames);
    takenNames.add(fileName);
    icons.push({ name: fileName, bytes });
  }

  async function visit(node: BaseNode): Promise<void> {
    if (icons.length >= MAX_ICON_FILES || isHidden(node) || isZeroSized(node)) return;
    if ((node.type === 'COMPONENT' || node.type === 'INSTANCE') && isVectorOnly(node)) {
      await addIcon(node);
      return;
    }
    for (const child of childrenOf(node)) await visit(child);
  }

  await visit(root);
  return icons;
}
