import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JSON_CONTENT_TYPE, ROUTES } from '@figma-drop/export-contract';
import type { ExportPayload } from '@figma-drop/export-contract/parser';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { probeReceiver, sendExport } from './transport.ts';

type Received = { method?: string; url?: string; contentType?: string; body: string };

const payload: ExportPayload = { node: { id: '1:2' }, nodeId: '1:2', nodeName: 'Zażółć 🎨' };

let server: Server | undefined;

async function receiver(reply: (response: ServerResponse) => void) {
  const received: Received[] = [];
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        ...(request.method !== undefined && { method: request.method }),
        ...(request.url !== undefined && { url: request.url }),
        ...(request.headers['content-type'] !== undefined && {
          contentType: request.headers['content-type'],
        }),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      reply(response);
    });
  };
  const listening = createServer(handle);
  server = listening;
  await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
  const { port } = listening.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, received };
}

const json = (status: number, body: unknown) => (response: ServerResponse) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};

afterEach(async () => {
  const running = server;
  server = undefined;
  if (!running?.listening) return;
  running.closeAllConnections();
  await new Promise((resolve) => running.close(resolve));
});

async function closedPortUrl() {
  const { baseUrl } = await receiver(() => {});
  const running = server;
  await new Promise((resolve) => running?.close(resolve));
  return baseUrl;
}

describe('sendExport', () => {
  it('posts one JSON body to the sync route', async () => {
    const { baseUrl, received } = await receiver(json(200, { path: '/library/a' }));
    await sendExport(payload, { baseUrl });
    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(ROUTES.sync);
    expect(request?.contentType).toBe(JSON_CONTENT_TYPE);
    expect(JSON.parse(request?.body ?? '')).toEqual(payload);
  });

  it('reports saved with the path and preview', async () => {
    const { baseUrl } = await receiver(
      json(200, { ok: true, path: '/library/a', preview: '/library/a/preview.html' }),
    );
    expect(await sendExport(payload, { baseUrl })).toEqual({
      kind: 'saved',
      path: '/library/a',
      preview: '/library/a/preview.html',
    });
  });

  it('reports saved without a preview when the reply has none', async () => {
    const { baseUrl } = await receiver(json(200, { path: '/library/a' }));
    expect(await sendExport(payload, { baseUrl })).toEqual({ kind: 'saved', path: '/library/a' });
  });

  it.each([
    ['no path', { ok: true }],
    ['an empty path', { path: '' }],
    ['a non-string path', { path: 7 }],
  ])('treats a 200 with %s as a bad reply', async (_name, body) => {
    const { baseUrl } = await receiver(json(200, body));
    expect(await sendExport(payload, { baseUrl })).toEqual({ kind: 'bad-reply', status: 200 });
  });

  it('treats a 200 with a non-JSON body as a bad reply', async () => {
    const { baseUrl } = await receiver((response) => {
      response.writeHead(200);
      response.end('<html>not figma-drop</html>');
    });
    expect(await sendExport(payload, { baseUrl })).toEqual({ kind: 'bad-reply', status: 200 });
  });

  it.each([400, 500])('reports a %i with the receiver error', async (status) => {
    const { baseUrl } = await receiver(json(status, { error: 'disk is full' }));
    expect(await sendExport(payload, { baseUrl })).toEqual({
      kind: 'rejected',
      status,
      message: 'disk is full',
    });
  });

  it('reports a 413 with no body', async () => {
    const { baseUrl } = await receiver((response) => {
      response.writeHead(413);
      response.end();
    });
    expect(await sendExport(payload, { baseUrl })).toEqual({
      kind: 'rejected',
      status: 413,
      message: null,
    });
  });

  it.each([
    ['non-JSON', 'Bad Gateway'],
    ['a JSON array', '[1]'],
    ['JSON null', 'null'],
    ['a non-string error', '{"error":{"nested":true}}'],
  ])('reports a failure with %s as having no message', async (_name, body) => {
    const { baseUrl } = await receiver((response) => {
      response.writeHead(502);
      response.end(body);
    });
    expect(await sendExport(payload, { baseUrl })).toEqual({
      kind: 'rejected',
      status: 502,
      message: null,
    });
  });

  it('reports unreachable when nothing listens', async () => {
    const baseUrl = await closedPortUrl();
    expect(await sendExport(payload, { baseUrl })).toEqual({ kind: 'unreachable' });
  });

  it('reports timed out when the receiver never replies', async () => {
    const { baseUrl } = await receiver(() => {});
    expect(await sendExport(payload, { baseUrl, timeoutMs: 50 })).toEqual({ kind: 'timed-out' });
  });

  it('reports timed out when the reply stalls mid-body', async () => {
    const { baseUrl } = await receiver((response) => {
      response.writeHead(200);
      response.write('{"path":');
    });
    expect(await sendExport(payload, { baseUrl, timeoutMs: 50 })).toEqual({ kind: 'timed-out' });
  });
});

describe('probeReceiver', () => {
  it('reads the health route and treats any 2xx as online', async () => {
    const { baseUrl, received } = await receiver((response) => {
      response.writeHead(204);
      response.end();
    });
    expect(await probeReceiver({ baseUrl })).toBe('online');
    expect(received[0]).toMatchObject({ method: 'GET', url: ROUTES.health });
  });

  it('reports a non-2xx as offline', async () => {
    const { baseUrl } = await receiver(json(500, { error: 'no' }));
    expect(await probeReceiver({ baseUrl })).toBe('offline');
  });

  it('reports offline when nothing listens', async () => {
    expect(await probeReceiver({ baseUrl: await closedPortUrl() })).toBe('offline');
  });

  it('reports offline when the receiver hangs', async () => {
    const { baseUrl } = await receiver(() => {});
    expect(await probeReceiver({ baseUrl, timeoutMs: 50 })).toBe('offline');
  });
});
