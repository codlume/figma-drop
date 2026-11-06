import { z } from 'zod';
import { LITERAL_FALLBACK_FILE_KEY } from './index.ts';

// Open objects throughout: unknown fields survive so a newer plugin never fails
// an older receiver. Deep trees stay `unknown` because parse time must not scale
// with a hostile tree, and bundle files store them verbatim.
const assetSchema = z.looseObject({ name: z.string(), base64: z.string() });
const imageSchema = z.looseObject({
  imageHash: z.string().optional(),
  name: z.string(),
  base64: z.string(),
});
const plainObject = z.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  'expected a plain object',
);

export const exportPayloadSchema = z.looseObject({
  node: plainObject,
  fileKey: z.string().optional(),
  fileName: z.string().optional(),
  nodeId: z.string().optional(),
  nodeName: z.string().optional(),
  exportedAt: z.string().optional(),
  outputDir: z.string().optional(),
  folderName: z.string().optional(),
  summary: plainObject.optional(),
  components: z.array(z.unknown()).optional(),
  remoteMasters: z.array(z.unknown()).optional(),
  variables: plainObject.optional(),
  styles: plainObject.optional(),
  svg: z.string().optional(),
  png: z.string().optional(),
  assets: z.array(assetSchema).optional(),
  images: z.array(imageSchema).optional(),
  contractVersion: z.number().optional(),
  batchId: z.string().optional(),
});

export type ExportPayload = z.infer<typeof exportPayloadSchema>;

export type ParseResult = { ok: true; payload: ExportPayload } | { ok: false; error: string };

export function parseExportPayload(value: unknown): ParseResult {
  const parsed = exportPayloadSchema.safeParse(value);
  if (parsed.success) return { ok: true, payload: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, error: `invalid export: ${issue?.path.join('.') || 'body'}` };
}

export const openRequestSchema = z.looseObject({ path: z.string() });
export type OpenRequest = z.infer<typeof openRequestSchema>;

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
