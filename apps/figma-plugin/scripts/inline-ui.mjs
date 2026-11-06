// Figma hands ui.html to the iframe as a string, so a file beside it can never
// load. This folds Vite's emitted CSS and JS into the HTML.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2];
const htmlPath = join(dist, 'ui.html');
const emitted = (reference) => readFileSync(join(dist, reference), 'utf8');

// Replacer functions, because `$&` in minified code would expand in a string
// replacement. The escape keeps text inside a JS string from ending the tag.
const html = readFileSync(htmlPath, 'utf8')
  .replace(
    /<link\b[^>]*\bhref="\.\/([^"]+\.css)"[^>]*>/g,
    (_tag, reference) => `<style>${emitted(reference)}</style>`,
  )
  .replace(/<script\b[^>]*\bsrc="\.\/([^"]+\.js)"[^>]*><\/script>/g, (_tag, reference) => {
    const code = emitted(reference).replace(/<(\/script|!--)/gi, '\\x3C$1');
    return `<script type="module">${code}</script>`;
  });

writeFileSync(htmlPath, html);
rmSync(join(dist, 'assets'), { recursive: true, force: true });
