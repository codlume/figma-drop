import { attempt, type FigmaApi } from './figma-api.ts';

type Rgba = { r: number; g: number; b: number; a: number };
type ModeValue =
  | { alias: string; name: string | null }
  | { hex: string; rgba: Rgba }
  | VariableValue;

export type VariablesExport = {
  collections: {
    id: string;
    name: string;
    key: string | null;
    remote: boolean;
    defaultModeId: string;
    modes: { modeId: string; name: string }[];
  }[];
  tokens: {
    id: string;
    name: string;
    key: string | null;
    remote: boolean;
    resolvedType: VariableResolvedDataType;
    description: string;
    collectionId: string;
    collectionName: string;
    scopes?: VariableScope[];
    valuesByMode: Record<string, ModeValue>;
  }[];
};

function isAlias(value: unknown): value is VariableAlias {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'VARIABLE_ALIAS'
  );
}

// Aliases are searched everywhere, because paints and effects nest their own.
function* aliasIds(value: unknown): Generator<string> {
  if (isAlias(value)) yield value.id;
  else if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) yield* aliasIds(nested);
  }
}

function isColor(value: VariableValue): value is RGB | RGBA {
  return typeof value === 'object' && 'r' in value;
}

function hexChannel(channel: number): string {
  const byte = Math.min(255, Math.max(0, Math.round(channel * 255)));
  return byte.toString(16).padStart(2, '0');
}

function toColor(color: RGB | RGBA): { hex: string; rgba: Rgba } {
  const { r, g, b } = color;
  const a = 'a' in color ? color.a : 1;
  const alpha = a < 1 ? hexChannel(a) : '';
  return {
    hex: `#${hexChannel(r)}${hexChannel(g)}${hexChannel(b)}${alpha}`,
    rgba: { r, g, b, a },
  };
}

function toModeValue(
  variable: Variable,
  value: VariableValue,
  resolved: ReadonlyMap<string, Variable | null>,
): ModeValue {
  if (isAlias(value)) return { alias: value.id, name: resolved.get(value.id)?.name ?? null };
  return variable.resolvedType === 'COLOR' && isColor(value) ? toColor(value) : value;
}

function toToken(
  variable: Variable,
  collection: VariableCollection | null,
  resolved: ReadonlyMap<string, Variable | null>,
): VariablesExport['tokens'][number] {
  const modeName = (modeId: string) =>
    collection?.modes.find((mode) => mode.modeId === modeId)?.name ?? modeId;
  return {
    id: variable.id,
    name: variable.name,
    key: variable.key || null,
    remote: variable.remote,
    resolvedType: variable.resolvedType,
    description: variable.description || '',
    collectionId: variable.variableCollectionId,
    collectionName: collection?.name ?? '',
    ...(Array.isArray(variable.scopes) ? { scopes: variable.scopes } : {}),
    valuesByMode: Object.fromEntries(
      Object.entries(variable.valuesByMode).map(([modeId, value]) => [
        modeName(modeId),
        toModeValue(variable, value, resolved),
      ]),
    ),
  };
}

export async function collectVariables(
  figma: FigmaApi,
  serialized: unknown,
): Promise<VariablesExport | undefined> {
  const local = await attempt(() => figma.variables.getLocalVariableCollectionsAsync());
  const queue = (local ?? []).flatMap((collection) => collection.variableIds);
  queue.push(...aliasIds(serialized));
  if (queue.length === 0) return undefined;

  const resolved = new Map<string, Variable | null>();
  for (const id of queue) {
    if (resolved.has(id)) continue;
    const variable = await attempt(() => figma.variables.getVariableByIdAsync(id));
    resolved.set(id, variable);
    if (variable) queue.push(...aliasIds(variable.valuesByMode));
  }

  const collections = new Map<string, VariableCollection | null>();
  const tokens: VariablesExport['tokens'] = [];
  for (const variable of resolved.values()) {
    if (!variable) continue;
    const id = variable.variableCollectionId;
    if (!collections.has(id)) {
      const collection = await attempt(() => figma.variables.getVariableCollectionByIdAsync(id));
      collections.set(id, collection);
    }
    tokens.push(toToken(variable, collections.get(id) ?? null, resolved));
  }

  return {
    collections: [...collections.values()].flatMap((collection) =>
      collection
        ? [
            {
              id: collection.id,
              name: collection.name,
              key: collection.key || null,
              remote: collection.remote,
              defaultModeId: collection.defaultModeId,
              modes: collection.modes.map(({ modeId, name }) => ({ modeId, name })),
            },
          ]
        : [],
    ),
    tokens,
  };
}
