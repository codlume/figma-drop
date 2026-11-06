import type { SandboxToUi, UiToSandbox } from './shared/messages.ts';
import { describePanel } from './ui/panel.ts';
import { createSession } from './ui/session.ts';
import { probeReceiver, sendExport } from './ui/transport.ts';
import { createView } from './ui/view.ts';

const session = createSession({
  postToSandbox: (message: UiToSandbox) => parent.postMessage({ pluginMessage: message }, '*'),
  sendExport: (payload) => sendExport(payload),
  probeReceiver: () => probeReceiver(),
  onChange: (panel) => render(describePanel(panel)),
});

const render = createView({
  export: session.exportSelection,
  retry: session.retry,
  dismiss: session.dismiss,
  checkReceiver: () => void session.checkReceiver(),
});

window.addEventListener(
  'message',
  (event: MessageEvent<{ pluginMessage?: SandboxToUi } | null>) => {
    const message = event.data?.pluginMessage;
    if (message !== undefined) session.receive(message);
  },
);

session.start();
