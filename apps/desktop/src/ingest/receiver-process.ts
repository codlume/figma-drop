import { runReceiverChild } from './receiver-child';
import type { MainMessage } from './receiver-protocol';

// Electron's MessagePortMain, structurally, so ingest imports no electron.
type ParentPort = {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
};

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) throw new Error('receiver-process runs only as a utilityProcess');

// Main is the only sender on this port, so its messages are trusted as typed.
runReceiverChild({
  post: (message) => parentPort.postMessage(message),
  onMessage: (listener) => parentPort.on('message', (event) => listener(event.data as MainMessage)),
  exit: (code) => process.exit(code),
});
