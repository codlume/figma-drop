import {
  JSON_CONTENT_TYPE,
  PLUGIN_ORIGIN,
  ROUTES,
  allowedHostHeaders,
} from '@figma-drop/export-contract';

import type { RejectionCode } from './rejections';

// The header values a decision needs, lifted off the request at the boundary.
export type RequestFacts = {
  method: string | undefined;
  url: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  contentType: string | undefined;
  remoteAddress: string | undefined;
  privateNetworkPreflight: boolean;
};

export type RouteName = keyof typeof ROUTES;

export type PolicyDecision = {
  // True for the one Origin the plugin iframe sends. Every reply then carries
  // the CORS headers, errors included, or the plugin reports the receiver down.
  cors: boolean;
  outcome:
    | { kind: 'reject'; code: RejectionCode; headers?: Record<string, string> }
    | { kind: 'preflight'; privateNetwork: boolean }
    | { kind: 'route'; route: RouteName };
};

const ROUTE_METHODS: Record<RouteName, 'GET' | 'POST'> = {
  health: 'GET',
  sync: 'POST',
  open: 'POST',
  pickFolder: 'GET',
};

const ROUTE_BY_PATH = new Map<string, RouteName>(
  (Object.keys(ROUTES) as RouteName[]).map((name) => [ROUTES[name], name]),
);

export function decideRequest(facts: RequestFacts, port: number): PolicyDecision {
  const cors = facts.origin === PLUGIN_ORIGIN;
  const reject = (code: RejectionCode, headers?: Record<string, string>): PolicyDecision => ({
    cors,
    outcome: headers ? { kind: 'reject', code, headers } : { kind: 'reject', code },
  });

  if (!isLoopbackAddress(facts.remoteAddress)) return reject('hostNotAllowed');
  if (!facts.host || !allowedHostHeaders(port).includes(facts.host.toLowerCase())) {
    return reject('hostNotAllowed');
  }

  const method = facts.method ?? '';
  if (facts.origin === undefined) {
    if (method !== 'GET') return reject('originNotAllowed');
  } else if (!cors) {
    return reject('originNotAllowed');
  }

  if (method === 'OPTIONS') {
    return { cors, outcome: { kind: 'preflight', privateNetwork: facts.privateNetworkPreflight } };
  }

  const route = ROUTE_BY_PATH.get(pathname(facts.url));
  if (!route) return reject('notFound');
  const expected = ROUTE_METHODS[route];
  if (method !== expected) return reject('methodNotAllowed', { Allow: `${expected}, OPTIONS` });
  if (expected === 'POST' && !isJsonContentType(facts.contentType)) {
    return reject('unsupportedMediaType');
  }
  return { cors, outcome: { kind: 'route', route } };
}

export function corsHeaders(cors: boolean): Record<string, string> {
  return cors ? { 'Access-Control-Allow-Origin': PLUGIN_ORIGIN, Vary: 'Origin' } : {};
}

export function preflightHeaders(privateNetwork: boolean): Record<string, string> {
  return {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    ...(privateNetwork ? { 'Access-Control-Allow-Private-Network': 'true' } : {}),
  };
}

// Absolute-form targets and anything outside the route table fall to 404.
function pathname(url: string | undefined): string {
  return (url ?? '').split('?', 1)[0] ?? '';
}

// `application/json` with an optional charset parameter, case-insensitive.
// text/plain is the no-preflight attack, so nothing else passes.
export function isJsonContentType(header: string | undefined): boolean {
  if (!header) return false;
  const [type, ...params] = header.split(';').map((part) => part.trim().toLowerCase());
  if (type !== JSON_CONTENT_TYPE) return false;
  return params.every((param) => param === '' || /^charset=[\w"-]+$/.test(param));
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  if (v4.startsWith('127.')) return true;
  return address === '::1';
}
