import type { ExportLookup, StagedExport } from '../shared/integration';
import type { ExportNodeId, RevisionId } from '../shared/library';
import { isSafeBundlePath, isStagingId, nodeIdOf, projectIdOf } from './names';

export const MAX_RECEIPT_BYTES = 1024 * 1024;

export type BundleFile = { path: string; bytes: number };

export type Receipt = {
  schemaVersion: 1;
  revisionId: RevisionId;
  receivedAt: string;
  contentHash: string;
  exportedAt: string | null;
  identity: StagedExport['identity'];
  fileName: string | null;
  figmaNodeId: string;
  nodeName: string | null;
  files: readonly BundleFile[];
};

export type ReceiptHome =
  | { kind: 'project'; revisionId: RevisionId; nodeId: ExportNodeId }
  | { kind: 'unidentified'; revisionId: RevisionId };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isTextOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isContentHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function parseIdentity(value: unknown): StagedExport['identity'] | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'file') {
    return isNonEmptyText(value.fileKey) ? { kind: 'file', fileKey: value.fileKey } : null;
  }
  if (value.kind === 'unidentified' && isTextOrNull(value.claimedKey)) {
    return { kind: 'unidentified', claimedKey: value.claimedKey };
  }
  return null;
}

export function parseExportLookup(value: unknown): ExportLookup | null {
  if (!isRecord(value)) return null;
  const identity = parseIdentity(value.identity);
  const { figmaNodeId, contentHash } = value;
  if (!identity || !isNonEmptyText(figmaNodeId) || !isContentHash(contentHash)) return null;
  return { identity, figmaNodeId, contentHash };
}

export function parseStagedExport(value: unknown): StagedExport | null {
  const lookup = parseExportLookup(value);
  if (!lookup || !isRecord(value)) return null;
  const { stagingId, fileName, nodeName, exportedAt } = value;
  if (!isStagingId(stagingId)) return null;
  if (!isTextOrNull(fileName) || !isTextOrNull(nodeName) || !isTextOrNull(exportedAt)) return null;
  return { ...lookup, stagingId, fileName, nodeName, exportedAt };
}

function parseFiles(value: unknown): BundleFile[] | null {
  if (!Array.isArray(value)) return null;
  const files: BundleFile[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const { path, bytes } = entry;
    if (typeof path !== 'string' || !isSafeBundlePath(path)) return null;
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) return null;
    files.push({ path, bytes });
  }
  return files;
}

function sitsAt(home: ReceiptHome, identity: Receipt['identity'], figmaNodeId: string): boolean {
  if (home.kind === 'unidentified') return identity.kind === 'unidentified';
  if (identity.kind !== 'file') return false;
  return nodeIdOf(projectIdOf(identity.fileKey), figmaNodeId) === home.nodeId;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseReceipt(text: string, home: ReceiptHome): Receipt | null {
  const value = parseJson(text);
  if (!isRecord(value) || value.schemaVersion !== 1 || value.revisionId !== home.revisionId) {
    return null;
  }
  const { receivedAt, contentHash, exportedAt, fileName, figmaNodeId, nodeName } = value;
  const identity = parseIdentity(value.identity);
  const files = parseFiles(value.files);
  if (!identity || !files || !isNonEmptyText(figmaNodeId)) return null;
  if (typeof receivedAt !== 'string' || Number.isNaN(Date.parse(receivedAt))) return null;
  if (!isContentHash(contentHash)) return null;
  if (!isTextOrNull(exportedAt) || !isTextOrNull(fileName) || !isTextOrNull(nodeName)) return null;
  if (!sitsAt(home, identity, figmaNodeId)) return null;
  return {
    schemaVersion: 1,
    revisionId: home.revisionId,
    receivedAt,
    contentHash,
    exportedAt,
    identity,
    fileName,
    figmaNodeId,
    nodeName,
    files,
  };
}

export function serializeWithinReadCap(receipt: Receipt): string | null {
  const text = JSON.stringify(receipt, null, 2);
  return Buffer.byteLength(text) <= MAX_RECEIPT_BYTES ? text : null;
}
