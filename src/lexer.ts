// A small TypeScript tokenizer. It does not need to understand the full
// grammar: it only has to find token boundaries reliably so the transpiler can
// locate `data` and `match` forms and copy everything else through verbatim.
//
// Design notes:
// - Whitespace and comments are skipped; the transpiler copies source text
//   between tokens, so they are preserved in the output.
// - `>` is always a single-character token (never `>>`, `>=`, `>>>`), and `<`
//   likewise, so angle-bracket depth can be tracked in type positions such as
//   `List<List<T>>`. `=>` is the one exception, so arrow types do not confuse
//   that depth tracking.
// - Template literals are single tokens. Their `${...}` parts are lexed only
//   to find the closing brace.

export type Kind = "ident" | "num" | "str" | "tmpl" | "regex" | "punct";

export interface Token {
  kind: Kind;
  text: string;
  start: number;
  end: number;
}

export class TsadtError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
  ) {
    super(message);
  }
}

const PUNCTS = [
  "...", "===", "!==", "**=", "&&=", "||=", "??=",
  "=>", "==", "!=", "&&", "||", "??", "++", "--",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**",
];

// After these keywords a `/` starts a regular expression, not a division.
const REGEX_AFTER = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);

const isIdStart = (c: string) => /[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127;
const isIdPart = (c: string) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 127;

function regexAllowed(prev: Token | null): boolean {
  if (!prev) return true;
  if (prev.kind === "punct") return prev.text !== ")" && prev.text !== "]" && prev.text !== "}";
  if (prev.kind === "ident") return REGEX_AFTER.has(prev.text);
  return false;
}

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let start = 0;
  if (src.startsWith("#!")) {
    const nl = src.indexOf("\n");
    start = nl < 0 ? src.length : nl;
  }
  lex(src, start, false, out);
  return out;
}

// Lexes from `start`. When `inTemplate` is true, stops at the `}` that closes a
// template substitution and returns its position. Tokens go to `sink` if given.
function lex(src: string, start: number, inTemplate: boolean, sink: Token[] | null): number {
  const n = src.length;
  let i = start;
  let depth = 0;
  let prev: Token | null = null;

  while (i < n) {
    const c = src[i];
    if (/\s/.test(c) || c === "﻿") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e < 0) throw new TsadtError("Unterminated block comment", i);
      i = e + 2;
      continue;
    }

    const s = i;
    let kind: Kind;
    if (isIdStart(c)) {
      while (i < n && isIdPart(src[i])) i++;
      kind = "ident";
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      i++;
      while (i < n) {
        const ch = src[i];
        if (/[0-9A-Za-z_.]/.test(ch)) i++;
        else if ((ch === "+" || ch === "-") && /[eE]/.test(src[i - 1]) && !/^0[xX]/.test(src.slice(s, i))) i++;
        else break;
      }
      kind = "num";
    } else if (c === '"' || c === "'") {
      i++;
      for (;;) {
        if (i >= n || src[i] === "\n") throw new TsadtError("Unterminated string literal", s);
        if (src[i] === "\\") i += 2;
        else if (src[i] === c) { i++; break; }
        else i++;
      }
      kind = "str";
    } else if (c === "`") {
      i = scanTemplate(src, i + 1, s);
      kind = "tmpl";
    } else if (c === "/" && regexAllowed(prev)) {
      i++;
      let inClass = false;
      for (;;) {
        if (i >= n || src[i] === "\n") throw new TsadtError("Unterminated regular expression", s);
        const ch = src[i];
        if (ch === "\\") { i += 2; continue; }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) { i++; break; }
        i++;
      }
      while (i < n && isIdPart(src[i])) i++;
      kind = "regex";
    } else {
      if (c === "?" && src[i + 1] === "." && !/[0-9]/.test(src[i + 2] ?? "")) {
        i += 2;
      } else {
        const p = PUNCTS.find((p) => src.startsWith(p, i));
        i += p ? p.length : 1;
      }
      kind = "punct";
      if (inTemplate) {
        if (c === "{") depth++;
        else if (c === "}") {
          if (depth === 0) return s;
          depth--;
        }
      }
    }

    const tok: Token = { kind, text: src.slice(s, i), start: s, end: i };
    prev = tok;
    sink?.push(tok);
  }

  if (inTemplate) throw new TsadtError("Unterminated template substitution", start);
  return i;
}

function scanTemplate(src: string, i: number, start: number): number {
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") i += 2;
    else if (ch === "`") return i + 1;
    else if (ch === "$" && src[i + 1] === "{") i = lex(src, i + 2, true, null) + 1;
    else i++;
  }
  throw new TsadtError("Unterminated template literal", start);
}
