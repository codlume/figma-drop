// A byte cap bounds neither parse time nor memory: 256 MiB of `[` or `[],` aborts
// V8 inside JSON.parse with a fatal out-of-memory that no catch can contain, and a
// sandboxed iframe on any site can send it. The plugin caps a tree at 40,000 nodes,
// so this sits far above a real export.
export const MAX_JSON_VALUES = 8_000_000;

const QUOTE = 0x22;
const COMMA = 0x2c;
const OPEN_BRACKET = 0x5b;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;

// Reads bytes because a parser is the thing it protects. Valid JSON agrees with it
// on where strings end, and invalid JSON fails in JSON.parse at the first bad token.
export function exceedsValueBudget(body: Buffer, budget = MAX_JSON_VALUES): boolean {
  let values = 0;
  let inString = false;
  for (let index = 0; index < body.length; index += 1) {
    const byte = body[index];
    if (inString) {
      if (byte === BACKSLASH) index += 1;
      else if (byte === QUOTE) inString = false;
    } else if (byte === QUOTE) {
      inString = true;
    } else if (byte === COMMA || byte === OPEN_BRACKET || byte === OPEN_BRACE) {
      values += 1;
      if (values > budget) return true;
    }
  }
  return false;
}
