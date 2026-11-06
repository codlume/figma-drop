export type ReceiverStatus =
  | { state: 'off' }
  | { state: 'starting' }
  | { state: 'listening'; port: number }
  | { state: 'stopping' }
  | { state: 'port-conflict'; port: number; holder?: { pid: number; command: string } }
  // `failed` does not say whether the receiver is on or off. `enabled` is the saved switch position,
  // which main adds to every status it exposes. A controller leaves it out.
  | { state: 'failed'; message: string; enabled?: boolean }
  // The ingest build is absent, so nothing receives exports.
  | { state: 'unavailable'; message: string };
