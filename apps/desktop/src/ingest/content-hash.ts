import { createHash } from 'node:crypto';
import { HASH_EXCLUDED_FIELDS } from '@figma-drop/export-contract';

// The payload object itself is depth 1. Bundle writing recurses over the same
// tree, so this bound keeps every later walk clear of the stack limit.
export const MAX_JSON_DEPTH = 1000;

const EXCLUDED_FIELDS: ReadonlySet<string> = new Set(HASH_EXCLUDED_FIELDS);

const SCRATCH_BYTES = 64 * 1024;
const STRING_CHUNK_UNITS = 16 * 1024;

const TAG = { null: 0, false: 1, true: 2, number: 3, string: 4, array: 5, object: 6 } as const;

// Tokens collect in one scratch buffer because a hash call per token dominates
// the walk of a dense tree. Every value is tagged and every string and container
// is length-prefixed, so two different payloads cannot encode to the same bytes.
class CanonicalWriter {
  private readonly hash = createHash('sha256');
  private readonly scratch = Buffer.allocUnsafe(SCRATCH_BYTES);
  private used = 0;

  private reserve(bytes: number): void {
    if (this.used + bytes <= SCRATCH_BYTES) return;
    this.hash.update(this.scratch.subarray(0, this.used));
    this.used = 0;
  }

  tag(tag: number): void {
    this.reserve(1);
    this.used = this.scratch.writeUInt8(tag, this.used);
  }

  count(count: number): void {
    this.reserve(4);
    this.used = this.scratch.writeUInt32BE(count, this.used);
  }

  // Fixed-width doubles keep `-0` apart from `0`, which decimal text would merge.
  number(value: number): void {
    this.tag(TAG.number);
    this.reserve(8);
    this.used = this.scratch.writeDoubleBE(value, this.used);
  }

  // UTF-16 code units, because UTF-8 turns every lone surrogate into U+FFFD and
  // two different strings would hash the same.
  string(value: string): void {
    this.tag(TAG.string);
    this.count(value.length);
    for (let start = 0; start < value.length; start += STRING_CHUNK_UNITS) {
      const chunk = value.slice(start, start + STRING_CHUNK_UNITS);
      this.reserve(chunk.length * 2);
      this.used += this.scratch.write(chunk, this.used, 'utf16le');
    }
  }

  digest(): string {
    this.hash.update(this.scratch.subarray(0, this.used));
    return this.hash.digest('hex');
  }
}

function writeObject(
  writer: CanonicalWriter,
  object: Readonly<Record<string, unknown>>,
  keys: string[],
  depth: number,
): boolean {
  writer.tag(TAG.object);
  writer.count(keys.length);
  for (const key of keys.sort()) {
    writer.string(key);
    if (!writeValue(writer, object[key], depth + 1)) return false;
  }
  return true;
}

function writeValue(writer: CanonicalWriter, value: unknown, depth: number): boolean {
  if (value === null) writer.tag(TAG.null);
  else if (value === true) writer.tag(TAG.true);
  else if (value === false) writer.tag(TAG.false);
  else if (typeof value === 'number') writer.number(value);
  else if (typeof value === 'string') writer.string(value);
  else if (depth > MAX_JSON_DEPTH) return false;
  else if (Array.isArray(value)) {
    writer.tag(TAG.array);
    writer.count(value.length);
    return value.every((item) => writeValue(writer, item, depth + 1));
  } else {
    const object = value as Record<string, unknown>;
    return writeObject(writer, object, Object.keys(object), depth);
  }
  return true;
}

// Takes the raw `JSON.parse` result rather than the schema's output, because the
// schema drops a top-level `__proto__` and that key must still change the hash.
// Returns null when the payload nests beyond MAX_JSON_DEPTH.
export function hashExport(payload: Readonly<Record<string, unknown>>): string | null {
  const writer = new CanonicalWriter();
  const keys = Object.keys(payload).filter((key) => !EXCLUDED_FIELDS.has(key));
  return writeObject(writer, payload, keys, 1) ? writer.digest() : null;
}
