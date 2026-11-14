// A byte cap bounds neither parse time nor memory: 256 MiB of `[` or `[],` aborts
// V8 inside JSON.parse with a fatal out-of-memory that no catch can contain, and a
// sandboxed iframe on any site can send it. One object of about 2^23 keys also kills
// the child on Electron 44, so this cannot rise without capping keys per object. No
// real export has been measured, and a dense tree with many remote masters may reach it.
export const MAX_JSON_VALUES = 8_000_000;

const QUOTE = 0x22;
const COMMA = 0x2c;
const OPEN_BRACKET = 0x5b;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;

const BYTES_STEPPED_BEFORE_SEARCHING = 64;

// Reads bytes because a parser is the thing it protects. Valid JSON agrees with it
// on where strings end, and invalid JSON fails in JSON.parse at the first bad token.
export function exceedsValueBudget(body: Buffer, budget = MAX_JSON_VALUES): boolean {
  const tooShortToExceedBudget = body.length <= budget;
  if (tooShortToExceedBudget) return false;
  let values = 0;
  let index = 0;
  while (index < body.length) {
    const byte = body[index];
    index += 1;
    if (byte === QUOTE) {
      index = afterClosingQuote(body, index);
    } else if (byte === COMMA || byte === OPEN_BRACKET || byte === OPEN_BRACE) {
      values += 1;
      if (values > budget) return true;
    }
  }
  return false;
}

function afterClosingQuote(body: Buffer, afterOpeningQuote: number): number {
  let index = afterOpeningQuote;
  const stepUntil = Math.min(body.length, afterOpeningQuote + BYTES_STEPPED_BEFORE_SEARCHING);
  while (index < stepUntil) {
    const byte = body[index];
    index += 1;
    if (byte === QUOTE) return index;
    if (byte === BACKSLASH) index += 1;
  }
  return afterClosingQuoteBySearch(body, index);
}

// A backslash hides the byte after it, so a quote closes the string only after an
// even run of backslashes.
function afterClosingQuoteBySearch(body: Buffer, unescapedFrom: number): number {
  let from = unescapedFrom;
  for (;;) {
    const quote = body.indexOf(QUOTE, from);
    if (quote === -1) return body.length;
    let backslashes = 0;
    while (quote - backslashes > from && body[quote - backslashes - 1] === BACKSLASH) {
      backslashes += 1;
    }
    from = quote + 1;
    if (backslashes % 2 === 0) return from;
  }
}
