import { selectionMessage } from './sandbox/selection.ts';
import { handleUiMessage } from './sandbox/ui-messages.ts';
import type { UiToSandbox } from './shared/messages.ts';

figma.showUI(__html__, { width: 320, height: 420, themeColors: true });

figma.ui.onmessage = (message: UiToSandbox) => {
  void handleUiMessage(figma, message);
};

figma.on('selectionchange', () => {
  figma.ui.postMessage(selectionMessage(figma));
});
