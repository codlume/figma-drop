// Writes an ASCII-only twin of a body: the same shape with every non-ASCII character replaced.
import { readFileSync, writeFileSync } from 'node:fs';
const [from, to] = process.argv.slice(2);
const text = readFileSync(from, 'utf8').replace(/[\u0080-\uffff]/g, 'x');
writeFileSync(to, text);
console.log(to, Buffer.byteLength(text));
