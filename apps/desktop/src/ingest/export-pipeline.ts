import type { ExportLookup, StagedExport } from '../shared/integration';
import type { RejectionCode } from './rejections';

// Validated, hashed, decoded, and ready to write. Nothing here touches disk.
export type PreparedExport = {
  lookup: ExportLookup;
  describe(stagingId: StagedExport['stagingId']): StagedExport;
  files: readonly BundleFile[];
};

export type BundleFile = { relativePath: string; bytes: Uint8Array | string };

export type PrepareResult =
  | { ok: true; prepared: PreparedExport }
  | { ok: false; rejection: RejectionCode };

export declare function prepareExport(body: Buffer): PrepareResult;

export type StageResult =
  | { ok: true; staged: StagedExport }
  | { ok: false; rejection: Extract<RejectionCode, 'diskFull' | 'saveFailed'> };

// Writes `<stagingDir>/<stagingId>/bundle/` complete, or removes what it wrote.
export declare function stageExport(
  prepared: PreparedExport,
  stagingDir: string,
): Promise<StageResult>;

export declare function discardStaging(stagingDir: string, stagingId: string): Promise<void>;
