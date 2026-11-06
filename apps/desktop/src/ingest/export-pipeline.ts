import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { classifyFileIdentity, parseExportPayload } from '@figma-drop/export-contract/parser';
import type { ExportLookup, StagedExport } from '../shared/integration';
import type { StagingId } from '../shared/library';
import { buildBundleFiles, type BundleResult } from './bundle';
import { hashExport } from './content-hash';
import type { RejectionCode } from './rejections';

const STAGING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

export function prepareExport(body: Buffer): PrepareResult {
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf8'));
  } catch {
    return { ok: false, rejection: 'malformedJson' };
  }

  const parsed = parseExportPayload(raw);
  if (!parsed.ok) return { ok: false, rejection: 'invalidExport' };
  const { payload } = parsed;
  const { nodeId } = payload;
  if (!nodeId) return { ok: false, rejection: 'missingNodeId' };

  const contentHash = hashExport(raw as Record<string, unknown>);
  if (contentHash === null) return { ok: false, rejection: 'nestedTooDeeply' };

  let bundle: BundleResult;
  try {
    bundle = buildBundleFiles({ ...payload, nodeId });
  } catch {
    return { ok: false, rejection: 'bodyTooLarge' };
  }
  if (!bundle.ok) return bundle;

  const lookup = { identity: classifyFileIdentity(payload), figmaNodeId: nodeId, contentHash };
  const display = {
    fileName: payload.fileName ?? null,
    nodeName: payload.nodeName ?? null,
    exportedAt: payload.exportedAt ?? null,
  };
  return {
    ok: true,
    prepared: {
      lookup,
      describe: (stagingId) => ({ stagingId, ...lookup, ...display }),
      files: bundle.files,
    },
  };
}

export type StageResult =
  | { ok: true; staged: StagedExport }
  | { ok: false; rejection: Extract<RejectionCode, 'diskFull' | 'saveFailed'> };

// Writes `<stagingDir>/<stagingId>/bundle/` complete, or removes what it wrote.
export async function stageExport(
  prepared: PreparedExport,
  stagingDir: string,
): Promise<StageResult> {
  const stagingId = randomUUID() as StagingId;
  const entry = join(stagingDir, stagingId);
  const bundleDir = join(entry, 'bundle');
  try {
    const directories = new Set(prepared.files.map((file) => dirname(file.relativePath)));
    for (const directory of directories) {
      await mkdir(join(bundleDir, directory), { recursive: true });
    }
    for (const { relativePath, bytes } of prepared.files) {
      await writeFile(join(bundleDir, relativePath), bytes, { flag: 'wx' });
    }
    return { ok: true, staged: prepared.describe(stagingId) };
  } catch (error) {
    await removeQuietly(entry);
    return { ok: false, rejection: isDiskFull(error) ? 'diskFull' : 'saveFailed' };
  }
}

// Never rejects, because a request past its deadline discards in the background
// with nobody left to catch it.
export async function discardStaging(stagingDir: string, stagingId: string): Promise<void> {
  if (STAGING_ID.test(stagingId)) await removeQuietly(join(stagingDir, stagingId));
}

function isDiskFull(error: unknown): boolean {
  const { code } = error as NodeJS.ErrnoException;
  return code === 'ENOSPC' || code === 'EDQUOT';
}

// Opening the library sweeps staging, so an entry left behind here is not lost.
async function removeQuietly(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}
