import type { CommitResult, ExportLookup, StagedExport } from '../shared/integration';
import type { ReceiverStatus } from '../shared/receiver';

// The child parses hostile bodies, so main treats every ChildMessage as untrusted
// and validates it with `parseChildMessage` before acting.
export type MainMessage =
  | { type: 'start'; port: number; stagingDir: string }
  | { type: 'stop' }
  | { type: 'reply'; callId: number; result: BackendResult };

export type BackendCall =
  | { method: 'commit'; staged: StagedExport }
  | { method: 'findExport'; lookup: ExportLookup }
  | { method: 'focus'; path: string };

export type BackendResult =
  | { method: 'commit'; result: CommitResult }
  | { method: 'findExport'; result: CommitResult | null }
  | { method: 'focus'; found: boolean };

export type ChildMessage =
  | { type: 'status'; status: ReceiverStatus }
  // Brackets the synchronous work that no timer inside the child can interrupt.
  | { type: 'parse-start' }
  | { type: 'parse-end' }
  | { type: 'call'; callId: number; call: BackendCall };

// What the HTTP server needs from main, with the process boundary hidden.
export interface ReceiverBackend {
  commit(staged: StagedExport): Promise<CommitResult>;
  findExport(lookup: ExportLookup): Promise<CommitResult | null>;
  focus(path: string): Promise<boolean>;
}
