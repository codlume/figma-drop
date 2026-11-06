import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vite-plus/test';

const script = fileURLToPath(new URL('../../scripts/inline-ui.mjs', import.meta.url));

const directories: string[] = [];

function inline(js: string) {
  const dist = mkdtempSync(join(tmpdir(), 'figma-drop-inline-'));
  directories.push(dist);
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets/ui-a1.js'), js);
  writeFileSync(join(dist, 'assets/style-b2.css'), 'body{color:red}');
  writeFileSync(
    join(dist, 'ui.html'),
    `<head><script type="module" crossorigin src="./assets/ui-a1.js"></script>
<link rel="stylesheet" crossorigin href="./assets/style-b2.css"></head>`,
  );
  const { status } = spawnSync(process.execPath, [script, dist]);
  return { status, dist, html: readFileSync(join(dist, 'ui.html'), 'utf8') };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe('inline-ui', () => {
  it('folds the emitted files into the page and removes them', () => {
    const { status, dist, html } = inline('go()');
    expect(status).toBe(0);
    expect(html).toContain('<script type="module">go()</script>');
    expect(html).toContain('<style>body{color:red}</style>');
    expect(html).not.toContain('assets/');
    expect(existsSync(join(dist, 'assets'))).toBe(false);
  });

  it('keeps replacement patterns in code literal', () => {
    expect(inline("go('$& $` $1')").html).toContain("go('$& $` $1')");
  });

  it('keeps a closing tag inside a string from ending the script', () => {
    const { html } = inline("go('</script><!--')");
    expect(html).toContain("go('\\x3C/script>\\x3C!--')</script>");
  });
});
