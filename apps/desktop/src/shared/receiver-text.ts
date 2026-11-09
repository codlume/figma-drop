import type { ReceiverStatus } from './receiver';

// The tray's wording. The window words its own title, and `failed` reads as a problem in both,
// because it does not mean the receiver stopped.
export function receiverStatusText(status: ReceiverStatus): string {
  switch (status.state) {
    case 'off':
      return 'Receiver off';
    case 'starting':
      return 'Receiver starting';
    case 'listening':
      return `Receiver listening on port ${status.port}`;
    case 'stopping':
      return 'Receiver stopping';
    case 'port-conflict':
      return status.holder
        ? `Port ${status.port} is in use by ${status.holder.command}`
        : `Port ${status.port} is in use`;
    case 'failed':
      return `Receiver problem: ${status.message}`;
  }
}
