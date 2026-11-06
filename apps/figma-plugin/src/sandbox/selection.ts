import type { SandboxToUi } from '../shared/messages.ts';
import { readFileKey } from './figma-api.ts';

function hasSelectedAncestor(node: BaseNode, selectedIds: ReadonlySet<string>): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (selectedIds.has(parent.id)) return true;
  }
  return false;
}

export function selectionMessage(figma: Pick<PluginAPI, 'currentPage' | 'fileKey'>): SandboxToUi {
  const selected = figma.currentPage.selection;
  const selectedIds = new Set(selected.map((node) => node.id));
  return {
    type: 'selection',
    targets: selected
      .filter((node) => !hasSelectedAncestor(node, selectedIds))
      .map(({ id, name, type }) => ({ id, name, type })),
    hasFileKey: readFileKey(figma) !== undefined,
  };
}
