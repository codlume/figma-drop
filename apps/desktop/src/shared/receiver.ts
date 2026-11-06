export type ReceiverStatus =
  | { state: 'off' }
  | { state: 'starting' }
  | { state: 'listening'; port: number }
  | { state: 'stopping' }
  | { state: 'port-conflict'; port: number; holder?: { pid: number; command: string } }
  | { state: 'failed'; message: string }
  // The ingest build is absent, so nothing receives exports.
  | { state: 'unavailable'; message: string };
