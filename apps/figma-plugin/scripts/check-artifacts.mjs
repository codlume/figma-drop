import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// A schema runtime in code.js dwarfs all the code the sandbox should hold: zod
// measured 90 KB minified. The cap exists to catch a parser import, not to save
// bytes.
const MAX_CODE_BYTES = 64 * 1024;

function sandboxFailures(code) {
  const failures = [];
  try {
    void new vm.Script(code, { filename: 'code.js' });
  } catch (error) {
    failures.push(`code.js does not parse as a classic script: ${error.message}`);
  }
  if (/\bimport\s*\(/.test(code)) {
    failures.push('code.js contains `import(` text, which Figma rejects even in a string');
  }
  if (/(?:^|[;{}\n])\s*(?:import|export)[\s{*"'`]/.test(code)) {
    failures.push('code.js has an import or export statement');
  }
  if (/(?<![\w$.])require\(/.test(code)) {
    failures.push('code.js calls require(');
  }
  // An external dependency survives an IIFE build as a trailing argument, such as
  // `})(_figma_drop_export_contract);`, and throws only when Figma loads it.
  if (!/\)\(\s*\)\s*;?\s*$/.test(code)) {
    failures.push(
      'code.js is not an argument-free IIFE, so a dependency is external or the format changed',
    );
  }
  const bytes = Buffer.byteLength(code);
  if (bytes > MAX_CODE_BYTES) {
    failures.push(
      `code.js is ${bytes} bytes, over the ${MAX_CODE_BYTES} cap. Look for a runtime import`,
    );
  }
  return failures;
}

function uiFailures(html) {
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1],
  );
  const markup = html
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/g, '$1$2')
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/g, '$1$2');

  const failures = [];
  if (!scripts.some((code) => code.trim())) failures.push('ui.html has no inline script');
  if (!styles.some((css) => css.trim())) failures.push('ui.html has no inline style');
  for (const [, attribute] of markup.matchAll(/\s((?:src|href)\s*=\s*["']?[^"'\s>]*)/gi)) {
    if (!/=\s*["']?(?:#|data:)/i.test(attribute)) {
      failures.push(`ui.html has an external reference: ${attribute}`);
    }
  }
  for (const css of styles) {
    if (/@import\b|url\(\s*["']?(?!data:|#)/i.test(css)) {
      failures.push('ui.html has CSS that loads an external file');
    }
  }
  return failures;
}

const dist = process.argv[2];
const code = readFileSync(join(dist, 'code.js'), 'utf8');
const html = readFileSync(join(dist, 'ui.html'), 'utf8');
const failures = [...sandboxFailures(code), ...uiFailures(html)];

for (const failure of failures) console.error(failure);
if (failures.length > 0) process.exit(1);
console.log(`artifacts ok: code.js ${code.length} chars, ui.html ${html.length} chars`);
