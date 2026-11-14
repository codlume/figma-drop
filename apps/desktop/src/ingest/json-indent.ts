const NEWLINE = 0x0a;
const SPACE = 0x20;
const QUOTE = 0x22;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_BRACKET = 0x5b;
const BACKSLASH = 0x5c;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

const INDENT = 2;
const COLON_AND_SPACE = 2;
const LONGEST_STRING_COPIED_BY_LOOP = 32;

export type SerializedJson = {
  compact: Buffer;
  indentGrowth: number;
  indentedChars: number;
  indented(): Buffer;
};

export function serializeJson(value: unknown): SerializedJson {
  const text = JSON.stringify(value);
  const compact = Buffer.from(text);
  const indentGrowth = indentationGrowth(compact);
  return {
    compact,
    indentGrowth,
    indentedChars: text.length + indentGrowth,
    indented: () => indent(compact, indentGrowth),
  };
}

function afterString(compact: Buffer, openQuote: number): number {
  let index = openQuote + 1;
  while (index < compact.length && compact[index] !== QUOTE) {
    index += compact[index] === BACKSLASH ? 2 : 1;
  }
  return index + 1;
}

// How many bytes indenting adds: a newline and its indent before every member and
// before the bracket that closes a non-empty container, and a space after every colon.
function indentationGrowth(compact: Buffer): number {
  let growth = 0;
  let depth = 0;
  for (let index = 0; index < compact.length; index += 1) {
    const byte = compact[index];
    if (byte === QUOTE) {
      index = afterString(compact, index) - 1;
    } else if (byte === COLON) {
      growth += 1;
    } else if (byte === COMMA) {
      growth += 1 + depth * INDENT;
    } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      const next = compact[index + 1];
      if (next === CLOSE_BRACE || next === CLOSE_BRACKET) {
        index += 1;
      } else {
        depth += 1;
        growth += 1 + depth * INDENT;
      }
    } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      depth -= 1;
      growth += 1 + depth * INDENT;
    }
  }
  return growth;
}

function indent(compact: Buffer, growth: number): Buffer {
  const out = Buffer.alloc(compact.length + growth, SPACE);
  let at = 0;
  let depth = 0;
  const breakLineAtDepth = () => {
    out[at] = NEWLINE;
    at += 1 + depth * INDENT;
  };
  let index = 0;
  while (index < compact.length) {
    const byte = compact[index] ?? 0;
    if (byte === QUOTE) {
      const end = afterString(compact, index);
      if (end - index > LONGEST_STRING_COPIED_BY_LOOP) {
        at += compact.copy(out, at, index, end);
        index = end;
      } else {
        while (index < end) out[at++] = compact[index++] ?? 0;
      }
      continue;
    }
    index += 1;
    if (byte === COLON) {
      out[at] = byte;
      at += COLON_AND_SPACE;
    } else if (byte === COMMA) {
      out[at++] = byte;
      breakLineAtDepth();
    } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      out[at++] = byte;
      const next = compact[index];
      if (next === CLOSE_BRACE || next === CLOSE_BRACKET) {
        out[at++] = next;
        index += 1;
      } else {
        depth += 1;
        breakLineAtDepth();
      }
    } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      depth -= 1;
      breakLineAtDepth();
      out[at++] = byte;
    } else {
      out[at++] = byte;
    }
  }
  return out;
}
