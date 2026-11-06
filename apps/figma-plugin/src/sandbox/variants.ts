import { childrenOf } from './figma-api.ts';

export type VariantValues = Record<string, string>;
export type VariantAxes = Record<string, string[]>;

export function parseVariantName(name: string): VariantValues | undefined {
  const pairs: [string, string][] = [];
  for (const part of name.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const axis = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (axis && value) pairs.push([axis, value]);
  }
  return pairs.length > 0 ? Object.fromEntries(pairs) : undefined;
}

export function variantAxes(set: ComponentSetNode): VariantAxes | undefined {
  const axes = new Map<string, Set<string>>();
  for (const child of childrenOf(set)) {
    for (const [axis, value] of Object.entries(parseVariantName(child.name) ?? {})) {
      axes.set(axis, (axes.get(axis) ?? new Set()).add(value));
    }
  }
  if (axes.size === 0) return undefined;
  return Object.fromEntries([...axes].map(([axis, values]) => [axis, [...values]]));
}
