import type { RevisionId } from '../shared/library.ts';

// Ids arriving over IPC or in a preview URL are untrusted. This refuses anything that could act as
// a path, and assumes no other shape, because the library owns what an id looks like.
export function parseRevisionId(value: unknown): RevisionId | null {
  if (typeof value !== 'string' || value === '') return null;
  if (value.includes('/') || value.includes('\\') || value.includes('..')) return null;
  return value as RevisionId;
}
