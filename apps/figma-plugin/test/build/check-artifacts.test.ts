import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vite-plus/test';

const script = fileURLToPath(new URL('../../scripts/check-artifacts.mjs', import.meta.url));

const goodCode = '(function(){figma.showUI(__html__)})();';
const goodHtml = '<!doctype html><style>body{color:red}</style><script type="module">go()</script>';

const directories: string[] = [];

function check(files: { code?: string; html?: string }) {
  const dist = mkdtempSync(join(tmpdir(), 'figma-drop-artifacts-'));
  directories.push(dist);
  writeFileSync(join(dist, 'code.js'), files.code ?? goodCode);
  writeFileSync(join(dist, 'ui.html'), files.html ?? goodHtml);
  const result = spawnSync(process.execPath, [script, dist], { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe('check-artifacts', () => {
  it('passes a classic IIFE and a self-contained page', () => {
    expect(check({})).toEqual({ status: 0, stderr: '' });
  });

  it('accepts a minified arrow IIFE and a data URI', () => {
    const html = `<style>a{background:url(data:image/png;base64,AA==)}</style><img src="data:image/png;base64,AA=="><script>go()</script>`;
    expect(check({ code: '(()=>{go()})()\n', html }).status).toBe(0);
  });

  it.each([
    ['ESM output', 'export const a = 1;\n(function(){})();', 'classic script'],
    ['an import statement', 'import a from "a";\n(function(){a()})();', 'import or export'],
    ['an export statement', '(function(){})();\nexport {};\n(function(){})();', 'import or export'],
    ['import( in a string', '(function(){go("import(x)")})();', '`import(` text'],
    ['a dynamic import', '(function(){import("a")})();', '`import(` text'],
    ['a require call', '(function(){var a=require("a")})();', 'require('],
    ['an external dependency', '(function(e){go(e)})(_contract);', 'not an argument-free IIFE'],
    ['an oversized bundle', `(function(){go("${'a'.repeat(70_000)}")})();`, 'over the 65536 cap'],
  ])('rejects %s in code.js', (_name, code, reason) => {
    const { status, stderr } = check({ code });
    expect(status).toBe(1);
    expect(stderr).toContain(reason);
  });

  it.each([
    ['a linked script', '<style>a{}</style><script src="./ui.js"></script><script>go()</script>'],
    [
      'a linked stylesheet',
      '<link rel="stylesheet" href="ui.css"><style>a{}</style><script>go()</script>',
    ],
    [
      'a remote image',
      '<style>a{}</style><img src=https://example.com/a.png><script>go()</script>',
    ],
  ])('rejects %s in ui.html', (_name, html) => {
    const { status, stderr } = check({ html });
    expect(status).toBe(1);
    expect(stderr).toContain('external reference');
  });

  it.each([
    ['@import', '<style>@import "a.css";</style><script>go()</script>'],
    ['a remote font', '<style>a{src:url(https://example.com/a.woff)}</style><script>go()</script>'],
  ])('rejects %s in inlined CSS', (_name, html) => {
    expect(check({ html }).stderr).toContain('external file');
  });

  it('rejects a page that skipped inlining', () => {
    const { stderr } = check({ html: '<!doctype html><body></body>' });
    expect(stderr).toContain('no inline script');
    expect(stderr).toContain('no inline style');
  });

  it('ignores src text inside inlined code', () => {
    const html = `<style>a{}</style><script>go(' src="https://example.com/a.js"')</script>`;
    expect(check({ html }).status).toBe(0);
  });
});
