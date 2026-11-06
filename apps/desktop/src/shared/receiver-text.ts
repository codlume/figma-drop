import type { ReceiverStatus } from './receiver';

// One wording for every surface that shows the receiver, so the window and tray never disagree.
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
      return `Receiver failed: ${status.message}`;
    case 'unavailable':
      return `Receiver unavailable: ${status.message}`;
  }
}
