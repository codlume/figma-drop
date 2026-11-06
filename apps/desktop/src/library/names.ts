import { createHash } from 'node:crypto';
import { BUNDLE_FILES } from '@figma-drop/export-contract';
import type { ExportNodeId, ProjectId, RevisionId, StagingId } from '../shared/library';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SLUG = '[a-z0-9-]{1,40}';
const UUID_ONLY = new RegExp(`^${UUID}$`);
const HASHED_DIR = new RegExp(`^(${SLUG})-([0-9a-f]{16})$`);
const REVISION_DIR = new RegExp(`^([0-9]{6,15})-(${UUID})$`);
const UNIDENTIFIED_DIR = new RegExp(`^(${SLUG})-(${UUID})$`);

const MAX_SEGMENT_BYTES = 255;

export type HashedDir = { name: string; slug: string; hash: string };

export function slug(name: string): string {
  const text = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return text || 'untitled';
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function isStagingId(value: unknown): value is StagingId {
  return typeof value === 'string' && UUID_ONLY.test(value);
}

export function isRevisionId(value: unknown): value is RevisionId {
  return typeof value === 'string' && UUID_ONLY.test(value);
}

export function revisionIdOf(stagingId: StagingId): RevisionId {
  return stagingId as string as RevisionId;
}

export function projectIdFromHash(hash: string): ProjectId {
  return hash as ProjectId;
}

export function nodeIdFromHashes(projectId: ProjectId, nodeHash: string): ExportNodeId {
  return `${projectId}-${nodeHash}` as ExportNodeId;
}

export function projectIdOf(fileKey: string): ProjectId {
  return projectIdFromHash(shortHash(fileKey));
}

export function nodeHashOf(figmaNodeId: string): string {
  return shortHash(figmaNodeId);
}

export function nodeIdOf(projectId: ProjectId, figmaNodeId: string): ExportNodeId {
  return nodeIdFromHashes(projectId, nodeHashOf(figmaNodeId));
}

export function hashedDir(slugText: string, hash: string): HashedDir {
  return { name: `${slugText}-${hash}`, slug: slugText, hash };
}

export function parseHashedDir(name: string): HashedDir | null {
  const [, slugText, hash] = HASHED_DIR.exec(name) ?? [];
  return slugText && hash ? { name, slug: slugText, hash } : null;
}

export function revisionDirName(seq: number, id: RevisionId): string {
  return `${String(seq).padStart(6, '0')}-${id}`;
}

export function parseRevisionDir(name: string): { seq: number; id: RevisionId } | null {
  const [, seq, id] = REVISION_DIR.exec(name) ?? [];
  return seq && isRevisionId(id) ? { seq: Number(seq), id } : null;
}

export function parseUnidentifiedDir(name: string): { slug: string; id: RevisionId } | null {
  const [, slugText, id] = UNIDENTIFIED_DIR.exec(name) ?? [];
  return slugText && isRevisionId(id) ? { slug: slugText, id } : null;
}

function isSafeSegment(segment: string): boolean {
  return (
    segment !== '' &&
    segment !== '.' &&
    segment !== '..' &&
    !/[/\\\0]/.test(segment) &&
    Buffer.byteLength(segment) <= MAX_SEGMENT_BYTES
  );
}

export function isSafeBundlePath(path: string): boolean {
  const [first, second, ...rest] = path.split('/');
  if (first === undefined || rest.length > 0) return false;
  if (second === undefined) return isSafeSegment(first);
  return first === BUNDLE_FILES.previewAssetsDir && isSafeSegment(second);
}
