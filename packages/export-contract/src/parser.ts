import { Result, Schema, SchemaIssue } from 'effect';
import { LITERAL_FALLBACK_FILE_KEY } from './index.ts';

// Open objects throughout: unknown fields survive so a newer plugin never fails
// an older receiver. Node trees, `components`, and `remoteMasters` are checked at
// the top level only, because parse time must not scale with a hostile tree, and
// bundle files store them verbatim. `assets` and `images` are still walked, so
// parse time scales with their entry count.
const openObject = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)]);

const plainObject = Schema.declare(
  (value): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value),
);
const plainArray = Schema.declare((value): value is unknown[] => Array.isArray(value));

const asset = openObject({ name: Schema.String, base64: Schema.String });
const image = openObject({
  imageHash: Schema.optional(Schema.String),
  name: Schema.String,
  base64: Schema.String,
});

const exportPayload = openObject({
  node: plainObject,
  fileKey: Schema.optional(Schema.String),
  fileName: Schema.optional(Schema.String),
  nodeId: Schema.optional(Schema.String),
  nodeName: Schema.optional(Schema.String),
  exportedAt: Schema.optional(Schema.String),
  outputDir: Schema.optional(Schema.String),
  folderName: Schema.optional(Schema.String),
  summary: Schema.optional(plainObject),
  components: Schema.optional(plainArray),
  remoteMasters: Schema.optional(plainArray),
  variables: Schema.optional(plainObject),
  styles: Schema.optional(plainObject),
  svg: Schema.optional(Schema.String),
  png: Schema.optional(Schema.String),
  assets: Schema.optional(Schema.Array(asset)),
  images: Schema.optional(Schema.Array(image)),
  contractVersion: Schema.optional(Schema.Finite),
  batchId: Schema.optional(Schema.String),
});

const openRequest = openObject({ path: Schema.String });

export type ExportPayload = typeof exportPayload.Type;
export type OpenRequest = typeof openRequest.Type;

export type ParseResult = { ok: true; payload: ExportPayload } | { ok: false; error: string };

const decodeExportPayload = Schema.decodeUnknownResult(exportPayload);
const decodeOpenRequest = Schema.decodeUnknownResult(openRequest);
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

export function parseExportPayload(value: unknown): ParseResult {
  const parsed = decodeExportPayload(value);
  if (Result.isSuccess(parsed)) return { ok: true, payload: parsed.success };
  const path = formatIssue(parsed.failure.issue).issues[0]?.path ?? [];
  return { ok: false, error: `invalid export: ${path.join('.') || 'body'}` };
}

export function parseOpenRequest(value: unknown): OpenRequest | undefined {
  return Result.getOrUndefined(decodeOpenRequest(value));
}

export type SyncSuccess = { path: string; preview?: string };
export type ErrorReply = { error: string };
export type SyncReply = SyncSuccess | ErrorReply;
export type OpenReply = { ok: true } | ErrorReply;
export type PickFolderReply = ErrorReply;

export type FileIdentity =
  | { kind: 'file'; fileKey: string }
  | { kind: 'unidentified'; claimedKey: string | null };

// These comparisons are the whole rule. Figma documents no key shape.
export function classifyFileIdentity(
  payload: Pick<ExportPayload, 'fileKey' | 'fileName'>,
): FileIdentity {
  const { fileKey, fileName } = payload;
  if (!fileKey) return { kind: 'unidentified', claimedKey: null };
  if (fileKey === fileName || fileKey === LITERAL_FALLBACK_FILE_KEY) {
    return { kind: 'unidentified', claimedKey: fileKey };
  }
  return { kind: 'file', fileKey };
}
