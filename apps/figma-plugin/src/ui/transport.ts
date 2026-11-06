import {
  JSON_CONTENT_TYPE,
  RECEIVER_ORIGIN,
  REPLY_DEADLINE_MS,
  ROUTES,
} from '@figma-drop/export-contract';
import type { ExportPayload } from '@figma-drop/export-contract/parser';

export type SendOutcome =
  | { kind: 'saved'; path: string; preview?: string }
  | { kind: 'rejected'; status: number; message: string | null }
  // A 2xx with no path is not proof of a commit.
  | { kind: 'bad-reply'; status: number }
  | { kind: 'unreachable' }
  // The receiver may have committed. A retry converges on the same entry.
  | { kind: 'timed-out' };

export type ReceiverProbe = 'online' | 'offline';

export type TransportDeps = {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

// The receiver always answers inside its deadline. The margin covers the upload.
const SEND_TIMEOUT_MS = REPLY_DEADLINE_MS + 5_000;
const PROBE_TIMEOUT_MS = 5_000;

function parseReply(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? { ...value } : {};
  } catch {
    return {};
  }
}

export async function sendExport(
  payload: ExportPayload,
  deps: TransportDeps = {},
): Promise<SendOutcome> {
  const { baseUrl = RECEIVER_ORIGIN, fetch: post = fetch, timeoutMs = SEND_TIMEOUT_MS } = deps;
  const body = JSON.stringify(payload);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await post(`${baseUrl}${ROUTES.sync}`, {
      method: 'POST',
      headers: { 'Content-Type': JSON_CONTENT_TYPE },
      body,
      signal,
    });
    const { path, preview, error } = parseReply(await response.text());
    if (!response.ok) {
      const message = typeof error === 'string' && error !== '' ? error : null;
      return { kind: 'rejected', status: response.status, message };
    }
    if (typeof path !== 'string' || path === '') {
      return { kind: 'bad-reply', status: response.status };
    }
    return { kind: 'saved', path, ...(typeof preview === 'string' && { preview }) };
  } catch {
    return signal.aborted ? { kind: 'timed-out' } : { kind: 'unreachable' };
  }
}

export async function probeReceiver(deps: TransportDeps = {}): Promise<ReceiverProbe> {
  const { baseUrl = RECEIVER_ORIGIN, fetch: get = fetch, timeoutMs = PROBE_TIMEOUT_MS } = deps;
  try {
    const response = await get(`${baseUrl}${ROUTES.health}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok ? 'online' : 'offline';
  } catch {
    return 'offline';
  }
}
