import type { ComponentEntry } from './components.ts';
import { errorMessage, type FigmaApi, read } from './figma-api.ts';
import { type SerializedNode, serializeTree } from './serialize.ts';
import { variantAxes } from './variants.ts';

const MASTER_NODE_CAP = 5000;

export type RemoteMasterError = { name: string; error: string };

function importMaster(
  figma: FigmaApi,
  type: ComponentEntry['type'],
  key: string,
): Promise<ComponentNode | ComponentSetNode> {
  return type === 'COMPONENT_SET'
    ? figma.importComponentSetByKeyAsync(key)
    : figma.importComponentByKeyAsync(key);
}

function owningSet(master: ComponentNode | ComponentSetNode): ComponentSetNode | null {
  if (master.type === 'COMPONENT_SET') return master;
  return master.parent?.type === 'COMPONENT_SET' ? master.parent : null;
}

function masterFields(
  master: ComponentNode | ComponentSetNode,
  set: ComponentSetNode | null,
): Partial<ComponentEntry> {
  // Figma keeps definitions on the set, and a variant's own getter throws.
  const definitions = read(set ?? master, 'componentPropertyDefinitions') as
    | ComponentPropertyDefinitions
    | undefined;
  const axes = set ? variantAxes(set) : undefined;
  return {
    masterName: master.name,
    ...(master.description ? { description: master.description } : {}),
    ...(definitions && Object.keys(definitions).length > 0
      ? { componentPropertyDefinitions: definitions }
      : {}),
    ...(set ? { setName: set.name, setKey: set.key } : {}),
    ...(axes ? { variantProperties: axes } : {}),
  };
}

export async function resolveRemoteMasters(
  figma: FigmaApi,
  entries: readonly ComponentEntry[],
): Promise<{
  components: ComponentEntry[];
  remoteMasters: SerializedNode[];
  remoteMasterErrors: RemoteMasterError[];
}> {
  const components: ComponentEntry[] = [];
  const remoteMasters: SerializedNode[] = [];
  const remoteMasterErrors: RemoteMasterError[] = [];
  const serializedKeys = new Set<string>();

  for (const entry of entries) {
    if (!entry.remote || entry.key === null) {
      components.push(entry);
      continue;
    }
    try {
      const master = await importMaster(figma, entry.type, entry.key);
      const set = owningSet(master);
      const serialized = set ?? master;
      if (!serializedKeys.has(serialized.key)) {
        serializedKeys.add(serialized.key);
        const { tree } = await serializeTree(figma, serialized, MASTER_NODE_CAP);
        remoteMasters.push(tree);
      }
      components.push({ ...entry, ...masterFields(master, set) });
    } catch (error) {
      const message = errorMessage(error);
      remoteMasterErrors.push({ name: entry.name, error: message });
      components.push({ ...entry, masterError: message });
    }
  }
  return { components, remoteMasters, remoteMasterErrors };
}
