// Serves the browser harness: the source trees with types stripped, plus a /sync sink.
//   node serve.mjs <port> <worktree root> <snapshot dir>
// Each subdirectory of <snapshot dir> named in SNAPSHOTS is served as one side.
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [port, worktree, snapshots] = process.argv.slice(2);
if (!snapshots) throw new Error('usage: node serve.mjs <port> <worktree root> <snapshot dir>');
const SNAPSHOTS = ['base', 'fix', 'p1', 'p2', 'p3', 'p4', 'p5'];
const roots = { h: here, work: worktree };
for (const name of SNAPSHOTS) roots[name] = join(snapshots, name);
const importMap = { scopes: {} };
for (const side of [...SNAPSHOTS, 'work']) {
  importMap.scopes[`/${side}/`] = {
    '@figma-drop/export-contract': `/${side}/packages/export-contract/src/index.ts`,
  };
}
const index = `<!doctype html><meta charset="utf-8"><title>plugin bench</title>
<script type="importmap">${JSON.stringify(importMap)}</script>
<script type="module" src="/h/page.mjs"></script><pre id="out">loading</pre>`;

const server = http.createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://x');
  if (request.method === 'POST' && pathname === '/sync') {
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
    });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ path: String(bytes) }));
    });
    return;
  }
  if (pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(index);
    return;
  }
  const [, rootName, ...rest] = pathname.split('/');
  const root = roots[rootName];
  const file = root && normalize(join(root, ...rest));
  if (!file || !file.startsWith(root)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const source = await readFile(file, 'utf8');
    const body = file.endsWith('.ts') ? stripTypeScriptTypes(source) : source;
    response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
server.keepAliveTimeout = 10 * 60 * 1000;
server.listen(Number(port), '127.0.0.1', () => console.log(`listening ${port}`));
