import { mainComponentOf } from './figma-api.ts';
import { parseVariantName, type VariantAxes, type VariantValues } from './variants.ts';

export type ComponentEntry = {
  id: string;
  name: string;
  key: string | null;
  type: 'COMPONENT' | 'COMPONENT_SET';
  description: string;
  remote: boolean;
  componentSetId: string | null;
  variantValues?: VariantValues;
  masterName?: string;
  setName?: string;
  setKey?: string;
  variantProperties?: VariantAxes;
  componentPropertyDefinitions?: ComponentPropertyDefinitions;
  masterError?: string;
};

function toEntry(component: ComponentNode | ComponentSetNode): ComponentEntry {
  const variantValues = parseVariantName(component.name);
  const parent = component.parent;
  return {
    id: component.id,
    name: component.name,
    key: component.key || null,
    type: component.type,
    description: component.description || '',
    remote: component.remote,
    componentSetId: parent?.type === 'COMPONENT_SET' ? parent.id : null,
    ...(variantValues ? { variantValues } : {}),
  };
}

async function componentBehind(node: BaseNode): Promise<ComponentNode | ComponentSetNode | null> {
  if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') return node;
  return node.type === 'INSTANCE' ? mainComponentOf(node) : null;
}

export async function collectComponents(root: BaseNode): Promise<ComponentEntry[]> {
  const descendants =
    'findAllWithCriteria' in root
      ? root.findAllWithCriteria({ types: ['INSTANCE', 'COMPONENT', 'COMPONENT_SET'] })
      : [];
  const entries = new Map<string, ComponentEntry>();
  for (const node of [root, ...descendants]) {
    const component = await componentBehind(node);
    if (component && !entries.has(component.id)) entries.set(component.id, toEntry(component));
  }
  return [...entries.values()];
}
