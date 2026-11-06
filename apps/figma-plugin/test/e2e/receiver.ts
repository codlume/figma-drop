import { once } from 'node:events';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { JSON_CONTENT_TYPE, PLUGIN_ORIGIN, ROUTES } from '@figma-drop/export-contract';
import {
  classifyFileIdentity,
  type ExportPayload,
  type FileIdentity,
  parseExportPayload,
} from '@figma-drop/export-contract/parser';

export type ReceivedRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
};

export type ReceivedExport = ReceivedRequest & { payload: ExportPayload; identity: FileIdentity };

export type Reply =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'text'; status: number; body: string }
  | { kind: 'hang' }
  | { kind: 'crash' };

export const savedPath = (nodeId: string) => `/synthetic-library/${nodeId.replaceAll(':', '-')}`;

export const saved = ({ payload }: ReceivedExport): Reply => ({
  kind: 'json',
  status: 200,
  body: { ok: true, path: savedPath(payload.nodeId ?? 'no-node-id') },
});

export const refused = (status: number, error: string): Reply => ({
  kind: 'json',
  status,
  body: { error },
});

export class SyntheticReceiver {
  port = 0;
  reply: (post: ReceivedExport) => Reply = saved;
  requests: ReceivedRequest[] = [];
  exports: ReceivedExport[] = [];
  maxPostsInFlight = 0;

  #server: Server | null = null;
  #postsInFlight = 0;
  #holding = false;
  #released = 0;
  #waiters = new Set<() => void>();

  static async stopped(): Promise<SyntheticReceiver> {
    const receiver = new SyntheticReceiver();
    await receiver.start();
    await receiver.stop();
    return receiver;
  }

  static async started(): Promise<SyntheticReceiver> {
    const receiver = new SyntheticReceiver();
    await receiver.start();
    return receiver;
  }

  async start() {
    const server = createServer((request, response) => void this.#handle(request, response));
    server.listen(this.port, '127.0.0.1');
    await once(server, 'listening');
    this.#server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  async stop() {
    const server = this.#server;
    if (server === null) return;
    this.#server = null;
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }

  /** Every later POST waits for its own `release`, so a test can look at the panel mid-run. */
  hold() {
    this.#holding = true;
  }

  release() {
    this.#released += 1;
    this.#notify();
  }

  async until(label: string, condition: () => boolean, timeoutMs = 10_000): Promise<void> {
    if (condition()) return;
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!condition()) return;
        clearTimeout(timer);
        this.#waiters.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(check);
        reject(new Error(`receiver never saw: ${label}`));
      }, timeoutMs);
      this.#waiters.add(check);
    });
  }

  posts(count: number) {
    return this.until(`${count} POST ${ROUTES.sync}`, () => this.exports.length >= count);
  }

  get nodeIdsPosted() {
    return this.exports.map(({ payload }) => payload.nodeId);
  }

  #notify() {
    for (const waiter of this.#waiters) waiter();
  }

  async #handle(request: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const received: ReceivedRequest = {
      method: request.method ?? '',
      path: request.url ?? '',
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    this.requests.push(received);
    this.#notify();

    const originAccepted = request.headers.origin === PLUGIN_ORIGIN;
    if (originAccepted) response.setHeader('Access-Control-Allow-Origin', PLUGIN_ORIGIN);

    if (received.method === 'OPTIONS' || received.method === 'POST') {
      if (!originAccepted) {
        this.#send(response, refused(403, 'origin not accepted'));
        return;
      }
    }
    if (received.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader(
        'Access-Control-Allow-Headers',
        request.headers['access-control-request-headers'] ?? '',
      );
      response.writeHead(204).end();
      return;
    }
    if (received.method === 'POST' && received.path === ROUTES.sync) {
      await this.#handleExport(received, response);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/plain' }).end('synthetic receiver');
  }

  async #handleExport(received: ReceivedRequest, response: ServerResponse) {
    const parsed = parseExportPayload(JSON.parse(received.body));
    if (!parsed.ok) {
      this.#send(response, refused(400, parsed.error));
      return;
    }
    const post: ReceivedExport = {
      ...received,
      payload: parsed.payload,
      identity: classifyFileIdentity(parsed.payload),
    };
    this.exports.push(post);
    const ticket = this.exports.length;
    this.#postsInFlight += 1;
    this.maxPostsInFlight = Math.max(this.maxPostsInFlight, this.#postsInFlight);
    this.#notify();

    if (this.#holding) {
      await this.until(`release ${ticket}`, () => this.#released >= ticket, 120_000);
    }
    this.#send(response, this.reply(post));
    this.#postsInFlight -= 1;
  }

  #send(response: ServerResponse, reply: Reply) {
    switch (reply.kind) {
      case 'json':
        response
          .writeHead(reply.status, { 'Content-Type': JSON_CONTENT_TYPE })
          .end(JSON.stringify(reply.body));
        return;
      case 'text':
        response.writeHead(reply.status, { 'Content-Type': 'text/plain' }).end(reply.body);
        return;
      case 'hang':
        return;
      case 'crash':
        void this.stop();
    }
  }
}
