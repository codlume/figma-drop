import type { UiToSandbox } from '../shared/messages.ts';
import { exportNode } from './export-node.ts';
import { errorMessage, type FigmaApi } from './figma-api.ts';
import { selectionMessage } from './selection.ts';

export type SandboxFigma = FigmaApi & Pick<PluginAPI, 'currentPage' | 'getNodeByIdAsync' | 'ui'>;

async function replyToExport(figma: SandboxFigma, nodeId: string): Promise<void> {
  try {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      const message = 'This layer no longer exists. Select it again and retry.';
      figma.ui.postMessage({ type: 'node-failed', nodeId, message });
      return;
    }
    const raw = await exportNode(figma, node);
    figma.ui.postMessage({ type: 'node-exported', nodeId, raw });
  } catch (error) {
    figma.ui.postMessage({ type: 'node-failed', nodeId, message: errorMessage(error) });
  }
}

export async function handleUiMessage(figma: SandboxFigma, message: UiToSandbox): Promise<void> {
  switch (message.type) {
    case 'ui-ready':
      figma.ui.postMessage(selectionMessage(figma));
      return;
    case 'export-node':
      await replyToExport(figma, message.nodeId);
  }
}
