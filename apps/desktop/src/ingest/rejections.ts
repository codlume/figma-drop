import type { ErrorReply } from '@figma-drop/export-contract/parser';

// Upstream's plugin shows `error` verbatim in batch rows and on `/open`, so this text is user-facing.
export const REJECTIONS = {
  hostNotAllowed: { status: 403, error: 'This address is not allowed.' },
  originNotAllowed: { status: 403, error: 'This origin is not allowed.' },
  notFound: { status: 404, error: 'There is nothing at this address.' },
  methodNotAllowed: { status: 405, error: 'This method is not supported here.' },
  unsupportedMediaType: { status: 415, error: 'Send this request as application/json.' },
  bodyTooLarge: { status: 413, error: 'This export is too large for figma-drop to receive.' },
  tooManyAssets: { status: 413, error: 'This export has too many image assets.' },
  malformedJson: { status: 400, error: 'The request body is not valid JSON.' },
  invalidExport: { status: 400, error: 'This export is missing required data.' },
  missingNodeId: { status: 400, error: 'This export has no Figma node id.' },
  invalidAsset: { status: 400, error: 'This export has an image that is not valid base64.' },
  nestedTooDeeply: { status: 400, error: 'This export is nested too deeply.' },
  invalidOpenRequest: { status: 400, error: 'This request names no export path.' },
  unknownExport: { status: 404, error: 'figma-drop has no export at that path.' },
  pickFolderUnsupported: {
    status: 501,
    error: 'figma-drop chooses where exports are saved, so there is nothing to pick.',
  },
  busy: { status: 503, error: 'figma-drop is receiving another export. Try again.' },
  deadlineExceeded: { status: 503, error: 'figma-drop did not finish in time. Try again.' },
  diskFull: { status: 507, error: 'The disk is full, so figma-drop could not save this export.' },
  libraryUnavailable: {
    status: 503,
    error: 'figma-drop cannot reach its library right now. Try again.',
  },
  saveFailed: { status: 500, error: 'figma-drop could not save this export.' },
  focusFailed: { status: 500, error: 'figma-drop could not show this export.' },
} as const satisfies Record<string, { status: number } & ErrorReply>;

export type RejectionCode = keyof typeof REJECTIONS;
