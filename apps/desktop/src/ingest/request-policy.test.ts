import { describe, expect, it } from 'vite-plus/test';

import { FORBIDDEN_ERROR_TEXT } from '@figma-drop/export-contract';

import { decideRequest, isJsonContentType } from './request-policy';
import type { RequestFacts } from './request-policy';
import { REJECTIONS } from './rejections';

const PORT = 4321;

function facts(overrides: Partial<RequestFacts> = {}): RequestFacts {
  return {
    method: 'POST',
    url: '/sync',
    host: `localhost:${PORT}`,
    origin: 'null',
    contentType: 'application/json',
    remoteAddress: '127.0.0.1',
    privateNetworkPreflight: false,
    ...overrides,
  };
}

const decide = (overrides: Partial<RequestFacts> = {}) => decideRequest(facts(overrides), PORT);

describe('rejection text', () => {
  it('never contains the text upstream matches to open its folder picker', () => {
    for (const { error } of Object.values(REJECTIONS)) {
      expect(error.toLowerCase()).not.toContain(FORBIDDEN_ERROR_TEXT.toLowerCase());
    }
  });
});

describe('decideRequest', () => {
  it('routes a plugin POST to /sync', () => {
    expect(decide()).toEqual({ cors: true, outcome: { kind: 'route', route: 'sync' } });
  });

  it('ignores a query string but not an absolute-form target', () => {
    expect(decide({ url: '/sync?x=1' }).outcome).toEqual({ kind: 'route', route: 'sync' });
    expect(decide({ url: `http://localhost:${PORT}/sync` }).outcome).toEqual({
      kind: 'reject',
      code: 'notFound',
    });
  });

  it('refuses a socket that is not loopback before anything else', () => {
    expect(decide({ remoteAddress: '192.168.1.5' }).outcome).toEqual({
      kind: 'reject',
      code: 'hostNotAllowed',
    });
    expect(decide({ remoteAddress: undefined }).outcome).toEqual({
      kind: 'reject',
      code: 'hostNotAllowed',
    });
    for (const address of ['127.0.0.1', '127.3.4.5', '::1', '::ffff:127.0.0.1']) {
      expect(decide({ remoteAddress: address }).outcome.kind).toBe('route');
    }
  });

  it('matches Host exactly against the bound port, case-insensitively', () => {
    expect(decide({ host: `LOCALHOST:${PORT}` }).outcome.kind).toBe('route');
    expect(decide({ host: `127.0.0.1:${PORT}` }).outcome.kind).toBe('route');
    expect(decide({ host: `[::1]:${PORT}` }).outcome.kind).toBe('route');
    for (const host of [undefined, 'localhost', `localhost:${PORT + 1}`, `evil.test:${PORT}`]) {
      expect(decide({ host }).outcome).toEqual({ kind: 'reject', code: 'hostNotAllowed' });
    }
  });

  it('keeps CORS on a rejection when the Origin is the accepted one', () => {
    expect(decide({ host: 'evil.test' })).toEqual({
      cors: true,
      outcome: { kind: 'reject', code: 'hostNotAllowed' },
    });
    expect(decide({ host: 'evil.test', origin: undefined }).cors).toBe(false);
  });

  it('accepts a missing Origin on GET only', () => {
    expect(decide({ method: 'GET', url: '/', origin: undefined })).toEqual({
      cors: false,
      outcome: { kind: 'route', route: 'health' },
    });
    expect(decide({ origin: undefined }).outcome).toEqual({
      kind: 'reject',
      code: 'originNotAllowed',
    });
    expect(decide({ method: 'OPTIONS', origin: undefined }).outcome).toEqual({
      kind: 'reject',
      code: 'originNotAllowed',
    });
  });

  it('rejects a foreign Origin on every method without CORS', () => {
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      expect(decide({ method, url: '/', origin: 'https://evil.test' })).toEqual({
        cors: false,
        outcome: { kind: 'reject', code: 'originNotAllowed' },
      });
    }
  });

  it('answers a preflight on any path and echoes the private network ask', () => {
    expect(decide({ method: 'OPTIONS', url: '/anything' })).toEqual({
      cors: true,
      outcome: { kind: 'preflight', privateNetwork: false },
    });
    expect(decide({ method: 'OPTIONS', privateNetworkPreflight: true }).outcome).toEqual({
      kind: 'preflight',
      privateNetwork: true,
    });
  });

  it('names the allowed methods on a wrong-method request', () => {
    expect(decide({ method: 'GET', url: '/sync' }).outcome).toEqual({
      kind: 'reject',
      code: 'methodNotAllowed',
      headers: { Allow: 'POST, OPTIONS' },
    });
    expect(decide({ method: 'POST', url: '/pick-folder' }).outcome).toEqual({
      kind: 'reject',
      code: 'methodNotAllowed',
      headers: { Allow: 'GET, OPTIONS' },
    });
    expect(decide({ method: 'DELETE', url: '/' }).outcome).toMatchObject({
      code: 'methodNotAllowed',
    });
  });

  it('requires application/json on POST, allowing only a charset parameter', () => {
    expect(decide({ contentType: 'text/plain' }).outcome).toEqual({
      kind: 'reject',
      code: 'unsupportedMediaType',
    });
    expect(decide({ contentType: undefined }).outcome).toMatchObject({
      code: 'unsupportedMediaType',
    });
    expect(decide({ contentType: 'Application/JSON; charset=UTF-8' }).outcome.kind).toBe('route');
    expect(decide({ url: '/open', contentType: 'application/json;charset=utf-8' }).outcome).toEqual(
      { kind: 'route', route: 'open' },
    );
    expect(decide({ method: 'GET', url: '/', contentType: 'text/plain' }).outcome.kind).toBe(
      'route',
    );
  });

  it('isJsonContentType rejects other parameters and look-alike types', () => {
    expect(isJsonContentType('application/json; boundary=x')).toBe(false);
    expect(isJsonContentType('application/json-patch+json')).toBe(false);
    expect(isJsonContentType('application/jsonx')).toBe(false);
    expect(isJsonContentType(' application/json ; charset=utf-8 ')).toBe(true);
  });
});
