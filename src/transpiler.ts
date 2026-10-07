// Source-to-source translation into plain TypeScript of the three new forms:
// `data` declarations (with `deriving`), `match` expressions, and top-level
// clause functions. Everything else is copied through untouched.

import { checkMatch } from "./exhaustive.js";
import { Token, TsadtError, tokenize } from "./lexer.js";
import { DERIVABLE, deriveFunction, derivedFunctionName, helperSource, parseTypeAst } from "./derive.js";
import { Mapped } from "./mapped.js";
import { boundNames, CtorInfo, CtorPattern, DataDecl, Pattern, Registry, showPattern, TypeAst } from "./registry.js";

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  file: string;
  line: number;
  col: number;
}

export interface TranspileResult {
  code: string;
  diagnostics: Diagnostic[];
  /**
   * Maps an offset in `code` to the line and column in the .tsa source it
   * came from: exact for copied code, the producing pattern, guard or arm for
   * generated code. Null if there is no code.
   */
  sourcePosition(offset: number): { line: number; col: number } | null;
}

export interface TranspileOptions {
  /** Name of the discriminant field. Default "tag". */
  tagField?: string;
}

export function formatDiagnostic(d: Diagnostic): string {
  return `${d.file}:${d.line}:${d.col}: ${d.severity}: ${d.message}`;
}

// Keywords after which a following expression continues the same statement.
const CONTINUATION_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await", "extends",
]);
// Names that never start a clause function.
const NOT_CLAUSE_NAMES = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "typeof", "async", "await", "yield",
  "new", "super", "import", "export", "match", "data", "do", "else", "try", "with", "void", "delete",
  "throw", "case", "default", "class", "interface", "type", "enum", "declare", "namespace", "module",
  "let", "const", "var", "this",
]);
// A line ending with one of these continues on the next line ...
const CONTINUES_AFTER = new Set([
  "(", "[", "{", ",", ".", "?.", "=>", "?", ":", "=", "+", "-", "*", "/", "%", "**", "&&", "||", "??",
  "&", "|", "^", "<", ">", "!", "~", "==", "===", "!=", "!==", "+=", "-=", "*=", "/=", "%=", "&&=", "||=", "??=",
  "new", "typeof", "void", "delete", "await", "in", "instanceof", "of", "as", "satisfies", "keyof", "...",
]);
// ... and so does one whose next line starts with one of these.
const CONTINUES_BEFORE = new Set([
  ".", "?.", "?", ":", "=>", "=", "*", "/", "%", "**", "&&", "||", "??", "&", "|", "^", "<", ">", "==", "===",
  "!=", "!==", "+", "-", "(", "[", "in", "instanceof", "as", "satisfies", ",",
]);
const LITERAL_IDENTS = new Set(["true", "false", "null", "undefined"]);
const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSE = new Set([")", "]", "}"]);

interface Arm {
  /** Top-level alternatives, each with one pattern per matched value. */
  rows: Pattern[][];
  guard: Mapped | null;
  guardPos: number;
  body: Mapped;
  bodyPos: number;
  block: boolean;
  pos: number;
}

class Transpiler {
  readonly toks: Token[];
  readonly diags: Diagnostic[] = [];
  private lineStarts: number[] = [0];
  private counter = 0;
  private depth: number[];
  /** Generic helpers that derived operations in this file use. */
  private helpers = new Set<string>();
  private tag: string;

  constructor(
    readonly src: string,
    readonly file: string,
    readonly reg: Registry,
    opts: TranspileOptions,
  ) {
    this.tag = opts.tagField ?? "tag";
    for (let i = 0; i < src.length; i++) if (src[i] === "\n") this.lineStarts.push(i + 1);
    this.toks = tokenize(src);
    // Bracket depth of each token, to find statements at the top level.
    let d = 0;
    this.depth = this.toks.map((t) => {
      if (t.kind === "punct" && CLOSE.has(t.text)) d--;
      const here = d;
      if (t.kind === "punct" && t.text in OPEN) d++;
      return here;
    });
  }

  // ---------------------------------------------------------------- helpers

  loc(pos: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: pos - this.lineStarts[lo] + 1 };
  }

  report(severity: Diagnostic["severity"], message: string, pos: number): void {
    this.diags.push({ severity, message, file: this.file, ...this.loc(pos) });
  }

  private text(i: number): string | undefined {
    return this.toks[i]?.text;
  }

  private posOf(i: number): number {
    return this.toks[i]?.start ?? this.src.length;
  }

  private expect(i: number, text: string, what = `'${text}'`): void {
    if (this.text(i) !== text) {
      throw new TsadtError(`Expected ${what} but found ${this.describe(i)}`, this.posOf(i));
    }
  }

  private describe(i: number): string {
    const t = this.toks[i];
    return t ? `'${t.text}'` : "end of file";
  }

  private slice(a: number, b: number): string {
    return a >= b ? "" : this.src.slice(this.toks[a].start, this.toks[b - 1].end);
  }

  private indentAt(pos: number): string {
    const ls = this.lineStarts[this.loc(pos).line - 1];
    return /^[ \t]*/.exec(this.src.slice(ls))![0];
  }

  /** Index of the bracket that closes the one at index i. */
  private matching(i: number): number {
    const open = this.text(i)!;
    const stack: string[] = [];
    for (let j = i; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.kind !== "punct") continue;
      if (t.text in OPEN) stack.push(OPEN[t.text]);
      else if (CLOSE.has(t.text)) {
        const want = stack.pop();
        if (want !== t.text) throw new TsadtError(`Mismatched '${t.text}'`, t.start);
        if (stack.length === 0) return j;
      }
    }
    throw new TsadtError(`Unclosed '${open}'`, this.toks[i].start);
  }

  /** Like matching(), for `<...>` in type positions. */
  private matchingAngle(i: number): number {
    let depth = 0;
    for (let j = i; j < this.toks.length; j++) {
      const t = this.text(j)!;
      if (t === "<") depth++;
      else if (t === ">") {
        if (--depth === 0) return j;
      } else if (t in OPEN) j = this.matching(j);
      else if (CLOSE.has(t) || t === ";") break;
    }
    throw new TsadtError("Unclosed '<'", this.posOf(i));
  }

  /**
   * Splits tokens [a, b) on commas at bracket depth 0. With `angles`, `<` and
   * `>` also count as brackets (only safe in type positions).
   */
  private splitCommas(a: number, b: number, angles: boolean): Array<[number, number]> {
    const parts: Array<[number, number]> = [];
    let s = a;
    let angle = 0;
    for (let j = a; j < b; j++) {
      const t = this.text(j)!;
      if (t in OPEN) j = this.matching(j);
      else if (angles && t === "<") angle++;
      else if (angles && t === ">") angle--;
      else if (t === "," && angle === 0) {
        parts.push([s, j]);
        s = j + 1;
      }
    }
    if (s < b) parts.push([s, b]);
    return parts;
  }

  // -------------------------------------------------------------- detection

  isDataStart(i: number): boolean {
    const t = this.toks[i];
    if (!t || t.kind !== "ident" || t.text !== "data") return false;
    if (this.toks[i + 1]?.kind !== "ident") return false;
    const after = this.text(i + 2);
    if (after !== "=" && after !== "<") return false;
    const prev = this.text(i - 1);
    return prev === undefined || prev === ";" || prev === "{" || prev === "}" || prev === "export";
  }

  private isMatchStart(i: number): boolean {
    const t = this.toks[i];
    if (!t || t.kind !== "ident" || t.text !== "match" || this.text(i + 1) !== "(") return false;
    const prev = this.toks[i - 1];
    if (prev && (prev.text === "." || prev.text === "?." || prev.text === "function")) return false;
    try {
      return this.text(this.matching(i + 1) + 1) === "{";
    } catch {
      return false;
    }
  }

  // ----------------------------------------------------------------- driver

  run(): Mapped {
    const m = new Mapped();
    if (this.toks.length === 0) return m.copy(this.src, 0, this.src.length);
    const n = this.toks.length;
    const body = this.transform(0, n);
    // Helpers for derived operations go after the file's leading comments.
    return m
      .copy(this.src, 0, this.toks[0].start)
      .gen(helperSource(this.helpers, this.tag), this.toks[0].start)
      .add(body)
      .copy(this.src, this.toks[n - 1].end, this.src.length);
  }

  /** Transformed text of tokens [a, b), including the text between them. */
  transform(a: number, b: number): Mapped {
    const out = new Mapped();
    if (a >= b) return out;
    let pos = this.toks[a].start;
    let i = a;
    while (i < b) {
      let r: { out: Mapped; next: number } | null = null;
      if (this.isDataStart(i)) r = this.handleData(i, false);
      else if (this.text(i) === "export" && this.isDataStart(i + 1)) r = this.handleData(i + 1, true);
      else if (this.isMatchStart(i)) r = this.handleMatch(i);
      else r = this.tryClauseFunction(i);
      if (!r) {
        i++;
        continue;
      }
      if (r.next > b) throw new TsadtError("Construct extends past its enclosing block", this.posOf(i));
      out.copy(this.src, pos, this.toks[i].start).add(r.out);
      pos = this.toks[r.next - 1].end;
      i = r.next;
    }
    return out.copy(this.src, pos, this.toks[b - 1].end);
  }

  // ------------------------------------------------------------------- data

  /** Parses `data Name<Params> = | C1(f: T, ...) | C2 ...;` starting at index i. */
  parseData(i: number): { decl: DataDecl; next: number } {
    const pos = this.posOf(i);
    let j = i + 1;
    const name = this.text(j)!;
    j++;
    let params: string[] = [];
    let paramText = "";
    let paramSpan: [number, number] | null = null;
    let paramDecls: string[] = [];
    if (this.text(j) === "<") {
      const close = this.matchingAngle(j);
      paramText = this.slice(j, close + 1);
      paramSpan = [this.toks[j].start, this.toks[close].end];
      const segs = this.splitCommas(j + 1, close, true);
      params = segs.map(([s]) => {
        if (this.toks[s].kind !== "ident") throw new TsadtError("Expected a type parameter name", this.posOf(s));
        return this.toks[s].text;
      });
      paramDecls = segs.map(([a, b]) => this.slice(a, b));
      j = close + 1;
    }
    this.expect(j, "=");
    j++;
    if (this.text(j) === "|") j++;

    const ctors: CtorInfo[] = [];
    for (;;) {
      const t = this.toks[j];
      if (!t || t.kind !== "ident" || !/^[A-Z]/.test(t.text)) {
        throw new TsadtError(`Expected a constructor name (starting with an uppercase letter) but found ${this.describe(j)}`, this.posOf(j));
      }
      j++;
      const fields: string[] = [];
      const types: string[] = [];
      const typeSpans: Array<[number, number]> = [];
      const typeAsts: TypeAst[] = [];
      if (this.text(j) === "(") {
        const close = this.matching(j);
        this.splitCommas(j + 1, close, true).forEach(([s, e], idx) => {
          if (s === e) throw new TsadtError("Empty field", this.posOf(s));
          const named = this.toks[s].kind === "ident" && this.text(s + 1) === ":";
          const ts = named ? s + 2 : s;
          if (ts >= e) throw new TsadtError("Missing field type", this.posOf(s));
          fields.push(named ? this.toks[s].text : `_${idx}`);
          types.push(this.slice(ts, e));
          typeSpans.push([this.toks[ts].start, this.toks[e - 1].end]);
          typeAsts.push(parseTypeAst(this.toks.slice(ts, e)));
          if (fields.at(-1) === this.tag) {
            throw new TsadtError(`Field name '${this.tag}' is reserved for the discriminant`, this.posOf(s));
          }
        });
        const dup = fields.find((f, k) => fields.indexOf(f) !== k);
        if (dup) throw new TsadtError(`Duplicate field '${dup}' in ${t.text}`, this.posOf(j));
        j = close + 1;
      }
      if (ctors.some((c) => c.name === t.text)) throw new TsadtError(`Constructor '${t.text}' appears twice in ${name}`, t.start);
      ctors.push({ name: t.text, typeName: name, fields, types, pos: t.start, typeSpans, typeAsts });
      if (this.text(j) !== "|") break;
      j++;
    }
    // deriving (Eq, Ord, Show)  or  deriving Eq
    const deriving: string[] = [];
    let derivingPos = pos;
    if (this.text(j) === "deriving") {
      derivingPos = this.posOf(j);
      j++;
      let names: number[];
      if (this.text(j) === "(") {
        const close = this.matching(j);
        names = this.splitCommas(j + 1, close, false).filter(([a, b]) => a < b).map(([a, b]) => {
          if (b !== a + 1) throw new TsadtError("Expected a class name such as Eq, Ord or Show", this.posOf(a));
          return a;
        });
        j = close + 1;
      } else {
        names = [j];
        j++;
      }
      for (const k of names) {
        const cls = this.text(k)!;
        if (!DERIVABLE.has(cls)) throw new TsadtError(`Cannot derive '${cls}'; tsadt can derive Eq, Ord and Show`, this.posOf(k));
        if (deriving.includes(cls)) throw new TsadtError(`'${cls}' is derived twice`, this.posOf(k));
        deriving.push(cls);
      }
    }
    if (this.text(j) === ";") j++;
    return { decl: { name, params, paramDecls, paramText, paramSpan, ctors, deriving, derivingPos, file: this.file, pos }, next: j };
  }

  collect(): void {
    for (let i = 0; i < this.toks.length; i++) {
      if (!this.isDataStart(i)) continue;
      const { decl, next } = this.parseData(i);
      register(this.reg, decl, (msg) => this.report("error", msg, decl.pos));
      i = next - 1;
    }
  }

  private handleData(i: number, exported: boolean): { out: Mapped; next: number } {
    const { decl, next } = this.parseData(i);
    if (!this.reg.types.has(decl.name)) register(this.reg, decl, (m) => this.report("error", m, decl.pos));
    return { out: this.genData(decl, exported, this.indentAt(this.posOf(i))), next };
  }

  private genData(d: DataDecl, exported: boolean, ind: string): Mapped {
    const m = new Mapped();
    const NL = "\n" + ind;
    const ex = exported ? "export " : "";
    const tag = this.tag;
    const self = d.name + (d.params.length ? `<${d.params.join(", ")}>` : "");
    // Type parameters and field types are copied from the source, so errors
    // in them (an unknown type name, say) point at the exact spot.
    const params = () => d.paramSpan && m.copy(this.src, d.paramSpan[0], d.paramSpan[1]);
    const type = (c: CtorInfo, n: number) => m.copy(this.src, c.typeSpans[n][0], c.typeSpans[n][1]);

    m.gen(`${ex}type ${d.name}`, d.pos);
    params();
    m.gen(" =", d.pos);
    d.ctors.forEach((c, k) => {
      m.gen(`${NL}  | { readonly ${tag}: "${c.name}"`, c.pos);
      c.fields.forEach((f, n) => {
        m.gen(`; readonly ${f}: `, c.pos);
        type(c, n);
      });
      m.gen(` }${k === d.ctors.length - 1 ? ";" : ""}`, c.pos);
    });
    // A constructor whose name another data type in this file also uses has
    // no unqualified form here: it exists only as Shape.Circle.
    const clashes = (c: CtorInfo) =>
      (this.reg.ctors.get(c.name) ?? []).some((o) => o.typeName !== d.name && this.reg.types.get(o.typeName)?.file === d.file);
    const nullaryType = d.name + (d.params.length ? `<${d.params.map(() => "never").join(", ")}>` : "");

    // The constructor as a value: a shared object, or a function.
    // A nullary constructor is one shared value. With type parameters it gets
    // type List<never>, which is assignable to every List<T> because all
    // fields are readonly (covariant).
    const value = (c: CtorInfo) => {
      if (c.fields.length === 0) {
        m.gen(`{ ${tag}: "${c.name}" } as ${nullaryType}`, c.pos);
        return;
      }
      params();
      m.gen("(", c.pos);
      c.fields.forEach((f, n) => {
        m.gen(`${n ? ", " : ""}${f}: `, c.pos);
        type(c, n);
      });
      m.gen(`): ${self} => ({ ${tag}: "${c.name}", ${c.fields.join(", ")} })`, c.pos);
    };

    for (const c of d.ctors) {
      if (clashes(c)) continue;
      if (c.fields.length === 0) {
        m.gen(`${NL}${ex}const ${c.name}: ${nullaryType} = { ${tag}: "${c.name}" };`, c.pos);
      } else {
        m.gen(`${NL}${ex}function ${c.name}`, c.pos);
        params();
        m.gen("(", c.pos);
        c.fields.forEach((f, n) => {
          m.gen(`${n ? ", " : ""}${f}: `, c.pos);
          type(c, n);
        });
        m.gen(`): ${self} {${NL}  return { ${tag}: "${c.name}", ${c.fields.join(", ")} };${NL}}`, c.pos);
      }
    }

    // The namespace value that makes Shape.Circle(1) work. Emitted when it can
    // be used: the type is exported, this file writes `Shape.`, or a clash
    // leaves some constructor reachable no other way. (Always emitting it
    // would trip noUnusedLocals.)
    // Derived operations: one function each, also reachable as Shape.equals etc.
    const derived = d.deriving.map((cls) => ({ member: DERIVABLE.get(cls)!, fn: derivedFunctionName(d.name, cls) }));
    for (const cls of d.deriving) {
      const ctx = { reg: this.reg, file: this.file, tag, helpers: this.helpers, error: (msg: string, at: number) => this.report("error", msg, at) };
      m.gen(NL + deriveFunction(d, cls, ctx, NL), d.derivingPos);
    }

    const usedHere = this.toks.some((t, k) => t.text === d.name && this.text(k + 1) === "." && this.text(k - 1) !== ".");
    if (!exported && !usedHere && !d.ctors.some(clashes) && derived.length === 0) return m;
    const sameName = d.ctors.find((c) => c.name === d.name && !clashes(c));
    if (!sameName) {
      m.gen(`${NL}${ex}const ${d.name} = {`, d.pos);
      for (const c of d.ctors) {
        if (clashes(c)) {
          m.gen(`${NL}  ${c.name}: `, c.pos);
          value(c);
          m.gen(",", c.pos);
        } else {
          m.gen(`${NL}  ${c.name},`, c.pos);
        }
      }
      for (const x of derived) m.gen(`${NL}  ${x.member}: ${x.fn},`, d.derivingPos);
      m.gen(`${NL}} as const;`, d.pos);
    } else if (sameName.fields.length > 0) {
      // data Point = Point(x: number, y: number): the value Point is already
      // the constructor function, so the other members hang off it.
      for (const c of d.ctors) {
        m.gen(`${NL}${d.name}.${c.name} = `, c.pos);
        if (clashes(c)) value(c);
        else m.gen(c.name, c.pos);
        m.gen(";", c.pos);
      }
      for (const x of derived) m.gen(`${NL}${d.name}.${x.member} = ${x.fn};`, d.derivingPos);
    } else if (derived.length > 0) {
      this.report(
        "error",
        `${d.name}.${derived[0].member} has nowhere to go: the name ${d.name} is already the value of its constructor ${d.name}. Rename the type or the constructor.`,
        d.derivingPos,
      );
    }
    // (data Unit = Unit: the value Unit is the constant itself; no namespace.)
    return m;
  }

  // ---------------------------------------------------------------- match

  /** pattern := primary ('|' primary)*  -- `|` binds loosest. */
  private parsePattern(j: number): { pat: Pattern; next: number } {
    const first = this.parsePrimaryPattern(j);
    if (this.text(first.next) !== "|") return first;
    const alts = [first.pat];
    let k = first.next;
    while (this.text(k) === "|") {
      const r = this.parsePrimaryPattern(k + 1);
      alts.push(r.pat);
      k = r.next;
    }
    return { pat: { k: "or", alts, pos: first.pat.pos }, next: k };
  }

  private parsePrimaryPattern(j: number): { pat: Pattern; next: number } {
    const t = this.toks[j];
    if (!t) throw new TsadtError("Expected a pattern but found end of file", this.src.length);
    const pos = t.start;
    if (t.text === "(") {
      const r = this.parsePattern(j + 1);
      if (this.text(r.next) === ",") {
        throw new TsadtError("A pattern with commas, like (a, b), needs a match on several values: match (x, y) { ... }", pos);
      }
      this.expect(r.next, ")", `')' to close the pattern`);
      return { pat: r.pat, next: r.next + 1 };
    }
    if (t.text === "_") return { pat: { k: "wild", pos }, next: j + 1 };
    if (t.kind === "num" || t.kind === "str" || (t.kind === "ident" && LITERAL_IDENTS.has(t.text))) {
      return { pat: { k: "lit", text: t.text, pos }, next: j + 1 };
    }
    if (t.text === "-" && this.toks[j + 1]?.kind === "num") {
      return { pat: { k: "lit", text: "-" + this.toks[j + 1].text, pos }, next: j + 2 };
    }
    if (t.kind === "tmpl") throw new TsadtError("Template literals are not allowed in patterns", pos);
    if (t.kind !== "ident") throw new TsadtError(`Expected a pattern but found '${t.text}'`, pos);

    // Qualified constructor: Shape.Circle
    if (this.text(j + 1) === "." && this.toks[j + 2]?.kind === "ident" && /^[A-Z]/.test(this.toks[j + 2].text)) {
      return this.parseCtorPattern(j + 2, t.text);
    }
    if (/^[A-Z]/.test(t.text)) return this.parseCtorPattern(j, null);
    if (this.text(j + 1) === "@") {
      // `x @ A | B` means `(x @ A) | B`, as in Rust; write `x @ (A | B)`.
      const r = this.parsePrimaryPattern(j + 2);
      return { pat: { k: "bind", name: t.text, sub: r.pat, pos }, next: r.next };
    }
    return { pat: { k: "bind", name: t.text, sub: null, pos }, next: j + 1 };
  }

  /**
   * A constructor pattern whose name is at index j: `Cons`, `Cons(h, t)`, or
   * the named-field form `Rect { width, height: h, .. }`. In the named form a
   * bare field name binds a variable of that name, `field: pattern` matches
   * the field against a pattern, and left-out fields match anything (`..` may
   * be written to say so). Which data type the constructor belongs to, and so
   * its fields, is settled later by resolveArms().
   */
  private parseCtorPattern(j: number, qualifier: string | null): { pat: Pattern; next: number } {
    const t = this.toks[j];
    const pos = qualifier ? this.toks[j - 2].start : t.start;
    const pat: CtorPattern = { k: "ctor", name: t.text, qualifier, type: null, args: [], fields: null, pos };
    let k = j + 1;
    if (this.text(k) === "(") {
      k++;
      while (this.text(k) !== ")") {
        const r = this.parsePattern(k);
        pat.args.push(r.pat);
        k = r.next;
        if (this.text(k) === ",") k++;
        else if (this.text(k) !== ")") throw new TsadtError(`Expected ',' or ')' in pattern but found ${this.describe(k)}`, this.posOf(k));
      }
      return { pat, next: k + 1 };
    }
    if (this.text(k) !== "{") return { pat, next: k };

    const close = this.matching(k);
    pat.fields = [];
    k++;
    while (k < close) {
      if (this.text(k) === "...") {
        k++;
      } else if (this.text(k) === "." && this.text(k + 1) === ".") {
        k += 2;
      } else {
        const f = this.toks[k];
        if (f.kind !== "ident") throw new TsadtError(`Expected a field name but found '${f.text}'`, f.start);
        if (pat.fields.some((g) => g.name === f.text)) throw new TsadtError(`Field '${f.text}' appears twice in this pattern`, f.start);
        if (this.text(k + 1) === ":") {
          const r = this.parsePattern(k + 2);
          pat.fields.push({ name: f.text, pat: r.pat, pos: f.start });
          k = r.next;
        } else {
          pat.fields.push({ name: f.text, pat: { k: "bind", name: f.text, sub: null, pos: f.start }, pos: f.start });
          k++;
        }
      }
      if (this.text(k) === ",") k++;
      else if (k !== close) throw new TsadtError(`Expected ',' or '}' in pattern but found ${this.describe(k)}`, this.posOf(k));
    }
    return { pat, next: close + 1 };
  }

  /**
   * Decides which data type each constructor pattern in a match belongs to.
   * A qualified name (`Option.None`) or a name only one type uses is settled
   * at once. A shared bare name is then settled by the types already seen in
   * the same match: next to `Some(x)`, `None` means `Option.None`. Named-field
   * patterns are turned into positional ones here, once the fields are known.
   */
  private resolveArms(arms: Arm[]): void {
    const all: CtorPattern[] = [];
    const walk = (p: Pattern): void => {
      if (p.k === "ctor") {
        all.push(p);
        p.args.forEach(walk);
        p.fields?.forEach((f) => walk(f.pat));
      } else if (p.k === "bind" && p.sub) walk(p.sub);
      else if (p.k === "or") p.alts.forEach(walk);
    };
    for (const a of arms) for (const r of a.rows) r.forEach(walk);

    const candidates = new Map<CtorPattern, CtorInfo[]>();
    const known = new Set<string>();
    for (const p of all) {
      let c: CtorInfo[];
      if (p.qualifier) {
        const d = this.reg.types.get(p.qualifier);
        if (!d) throw new TsadtError(`Unknown data type '${p.qualifier}'`, p.pos);
        const info = d.ctors.find((x) => x.name === p.name);
        if (!info) {
          throw new TsadtError(`${p.qualifier} has no constructor '${p.name}' (constructors: ${d.ctors.map((x) => x.name).join(", ")})`, p.pos);
        }
        c = [info];
      } else {
        c = this.reg.ctors.get(p.name) ?? [];
        if (c.length === 0) throw new TsadtError(`Unknown constructor '${p.name}'. Is its data declaration in one of the input files?`, p.pos);
      }
      candidates.set(p, c);
      if (c.length === 1) known.add(c[0].typeName);
    }

    for (const p of all) {
      let c = candidates.get(p)!;
      if (c.length > 1) {
        const settled = c.filter((x) => known.has(x.typeName));
        if (settled.length !== 1) {
          throw new TsadtError(
            `Constructor '${p.name}' belongs to several data types; write ${c.map((x) => `${x.typeName}.${p.name}`).join(" or ")}`,
            p.pos,
          );
        }
        c = settled;
      }
      const info = c[0];
      p.type = info.typeName;
      if (p.fields) {
        for (const f of p.fields) {
          if (!info.fields.includes(f.name)) {
            const list = info.fields.length ? info.fields.join(", ") : "none";
            throw new TsadtError(`${p.name} has no field '${f.name}' (fields: ${list})`, f.pos);
          }
        }
        const fields = p.fields;
        p.args = info.fields.map((name): Pattern => fields.find((f) => f.name === name)?.pat ?? { k: "wild", pos: p.pos });
        p.fields = null;
      }
    }
  }

  /**
   * Parses the patterns of one arm into its top-level alternatives, each with
   * one pattern per matched value. With several values each alternative is a
   * parenthesized tuple `(p1, ..., pn)` or `_`, and alternatives are joined by
   * `|`. With one value, `A | B` is two alternatives.
   */
  private parseArmPatterns(j: number, width: number): { rows: Pattern[][]; next: number } {
    if (width === 1) {
      const { pat, next } = this.parsePattern(j);
      return { rows: pat.k === "or" ? pat.alts.map((a) => [a]) : [[pat]], next };
    }
    const rows: Pattern[][] = [];
    let k = j;
    for (;;) {
      const r = this.parseTupleRow(k, width);
      rows.push(r.pats);
      k = r.next;
      if (this.text(k) !== "|") return { rows, next: k };
      k++;
    }
  }

  private parseTupleRow(j: number, width: number): { pats: Pattern[]; next: number } {
    if (this.text(j) === "(") {
      const close = this.matching(j);
      const pats: Pattern[] = [];
      let k = j + 1;
      while (k < close) {
        const r = this.parsePattern(k);
        pats.push(r.pat);
        k = r.next;
        if (this.text(k) === ",") k++;
        else if (k !== close) throw new TsadtError(`Expected ',' or ')' in pattern but found ${this.describe(k)}`, this.posOf(k));
      }
      if (pats.length !== width) {
        throw new TsadtError(`This match is on ${width} values, but the pattern has ${pats.length}`, this.posOf(j));
      }
      return { pats, next: close + 1 };
    }
    const { pat, next } = this.parsePrimaryPattern(j);
    if (pat.k === "wild") return { pats: Array.from({ length: width }, () => pat), next };
    throw new TsadtError(
      `This match is on ${width} values, so each arm needs ${width} patterns in parentheses, like (${Array(width).fill("_").join(", ")}), or _ for anything`,
      pat.pos,
    );
  }

  /** Checks a set of alternatives: each is valid, and all bind the same variables. */
  private validateAlternatives(alts: Pattern[][], names: Set<string>): void {
    let first: string[] | null = null;
    let firstShown = "";
    for (const row of alts) {
      const mine = new Set(names);
      for (const p of row) this.validate(p, mine);
      const added = [...mine].filter((n) => !names.has(n)).sort();
      const shown = showRow(row);
      if (first === null) {
        first = added;
        firstShown = shown;
        continue;
      }
      const missing = first.find((n) => !added.includes(n));
      const extra = added.find((n) => !first!.includes(n));
      const v = missing ?? extra;
      if (v !== undefined) {
        const [has, lacks] = missing !== undefined ? [firstShown, shown] : [shown, firstShown];
        throw new TsadtError(
          `Every alternative of an or-pattern must bind the same variables: '${v}' is bound in '${has}' but not in '${lacks}'`,
          row[0].pos,
        );
      }
    }
    for (const n of first ?? []) names.add(n);
  }

  private validate(p: Pattern, names: Set<string>): void {
    switch (p.k) {
      case "bind":
        if (names.has(p.name)) throw new TsadtError(`Variable '${p.name}' is bound twice in one pattern`, p.pos);
        names.add(p.name);
        if (p.sub) this.validate(p.sub, names);
        return;
      case "ctor": {
        const info = this.reg.ctor(p.type!, p.name)!;
        if (info.fields.length !== p.args.length) {
          throw new TsadtError(`${p.name} has ${info.fields.length} field(s) but the pattern gives ${p.args.length}`, p.pos);
        }
        for (const a of p.args) this.validate(a, names);
        return;
      }
      case "or":
        this.validateAlternatives(p.alts.map((a) => [a]), names);
        return;
      default:
        return;
    }
  }

  /** Scans forward from j to the first `stop` token at bracket depth 0. */
  private scanTo(j: number, end: number, stops: string[]): number {
    while (j < end) {
      const t = this.text(j)!;
      if (stops.includes(t)) return j;
      j = t in OPEN ? this.matching(j) + 1 : j + 1;
    }
    return end;
  }

  private handleMatch(i: number): { out: Mapped; next: number } {
    const matchPos = this.posOf(i);
    const pOpen = i + 1;
    const pClose = this.matching(pOpen);
    if (pClose === pOpen + 1) throw new TsadtError("match needs a value to match on", matchPos);
    const scrutinee = this.transform(pOpen + 1, pClose);
    const bOpen = pClose + 1;
    const bClose = this.matching(bOpen);

    // `match (a, b)` matches several values at once; each arm then has one
    // pattern per value, written as a tuple: `(Some(x), _) => ...`.
    const width = this.splitCommas(pOpen + 1, pClose, false).filter(([a, b]) => a < b).length;

    const arms: Arm[] = [];
    let usesAwait = false;
    let j = bOpen + 1;
    while (j < bClose) {
      const armStart = j;
      const { rows, next } = this.parseArmPatterns(j, width);
      j = next;

      let guard: Mapped | null = null;
      let guardPos = 0;
      if (this.text(j) === "if") {
        const g = this.scanTo(j + 1, bClose, ["=>"]);
        if (g === j + 1) throw new TsadtError("Empty guard", this.posOf(j));
        guard = this.transform(j + 1, g);
        guardPos = this.posOf(j + 1);
        j = g;
      }
      this.expect(j, "=>", `'=>' after pattern ${showArm(rows)}`);
      j++;

      let body: Mapped;
      let block = false;
      const bodyPos = this.posOf(j);
      if (this.text(j) === "{") {
        const c = this.matching(j);
        body = this.transform(j + 1, c);
        block = true;
        j = c + 1;
      } else {
        const e = this.scanTo(j, bClose, [","]);
        if (e === j) throw new TsadtError("Missing expression after '=>'", this.posOf(j));
        body = this.transform(j, e);
        j = e;
      }
      for (let k = armStart; k < j; k++) if (this.text(k) === "await") usesAwait = true;
      if (this.text(j) === ",") j++;
      else if (j < bClose && !block) throw new TsadtError(`Expected ',' between match arms but found ${this.describe(j)}`, this.posOf(j));
      arms.push({ rows, guard, guardPos, body, bodyPos, block, pos: this.posOf(armStart) });
    }
    if (arms.length === 0) throw new TsadtError("match has no arms", matchPos);
    const out = new Mapped();
    if (!usesAwait && this.needsAsiGuard(i)) out.gen(";", matchPos);
    out.add(this.compileArms(arms, width, scrutinee, usesAwait, matchPos, null));
    return { out, next: bClose + 1 };
  }

  /**
   * Checks and compiles the arms of a match, or the clauses of a clause
   * function (`fn` names it, for messages). Returns the generated expression.
   */
  private compileArms(
    arms: Arm[],
    width: number,
    scrutinee: Mapped,
    usesAwait: boolean,
    matchPos: number,
    fn: string | null,
    indent = this.indentAt(matchPos),
  ): Mapped {
    this.resolveArms(arms);
    for (const a of arms) this.validateAlternatives(a.rows, new Set());

    const what = fn === null ? "match arm" : "clause";
    const check = checkMatch(arms.map((a) => ({ rows: a.rows, guarded: a.guard !== null })), this.reg);
    for (const k of check.redundant) {
      const shown = fn === null ? showArm(arms[k].rows) : `${fn}${arms[k].rows.map((r) => `(${r.map(showPattern).join(", ")})`).join(" | ")}`;
      this.report("warning", `Unreachable ${what} '${shown}' (removed from output)`, arms[k].pos);
    }
    // Drop unreachable alternatives too: TypeScript would reject the test
    // for an already-excluded case as a comparison with no overlap.
    for (const { arm, alt } of [...check.redundantAlts].reverse()) {
      const row = arms[arm].rows[alt];
      this.report("warning", `Unreachable alternative '${showRow(row)}' in or-pattern (removed from output)`, row[0].pos);
      arms[arm].rows.splice(alt, 1);
    }
    if (check.missing !== null) {
      if (fn === null) {
        this.report("error", `Non-exhaustive match: no arm covers ${check.missing}`, matchPos);
      } else {
        const args = width === 1 ? `(${check.missing})` : check.missing;
        this.report("error", `Non-exhaustive function ${fn}: no clause covers ${fn}${args}`, matchPos);
      }
    }
    const live = arms.filter((_, k) => !check.redundant.includes(k));
    return this.genMatch(live, width, scrutinee, usesAwait, matchPos, indent);
  }

  /**
   * The output starts with `(`, which would turn `f()\nmatch (x) {...}` into a
   * call of f's result. Add a `;` when the previous token can end an expression.
   */
  private needsAsiGuard(i: number): boolean {
    const prev = this.toks[i - 1];
    if (!prev) return false;
    if (prev.kind === "punct") return prev.text === ")" || prev.text === "]" || prev.text === "++" || prev.text === "--";
    if (prev.kind === "ident") return !CONTINUATION_KEYWORDS.has(prev.text);
    return true; // number, string, template, regex
  }

  // ------------------------------------------------------- clause functions
  //
  //   length(Nil): number => 0
  //   length(Cons(_, t)) => 1 + length(t)
  //
  // A group of clauses at the top level of a file becomes one function whose
  // body is a match on its parameters. Parameter types come from the
  // patterns where they can (a constructor gives its data type, a literal
  // its primitive type) and from annotations (`ys: List<T>`) where they
  // cannot. A bodiless signature `function f(...): R;` just before the
  // clauses may supply all of it instead.

  /** Tokens at the top level that start a new statement. */
  private atStatementStart(i: number): boolean {
    if (this.depth[i] !== 0) return false;
    const prev = this.toks[i - 1];
    if (!prev) return true;
    if (prev.text === ";" || prev.text === "}" || prev.text === "export") return true;
    return this.src.slice(prev.end, this.toks[i].start).includes("\n");
  }

  /** If a clause `name[<...>](...) [: R] [if g] =>` starts at i, its name and parameter parens. */
  private clauseAt(i: number): { name: string; open: number; close: number; generics: [number, number] | null } | null {
    const t = this.toks[i];
    if (!t || t.kind !== "ident" || NOT_CLAUSE_NAMES.has(t.text) || !this.atStatementStart(i)) return null;
    let open = i + 1;
    let generics: [number, number] | null = null;
    try {
      if (this.text(open) === "<") {
        const g = this.matchingAngle(open);
        generics = [open, g + 1];
        open = g + 1;
      }
      if (this.text(open) !== "(") return null;
      const close = this.matching(open);
      const after = this.text(close + 1);
      if (after === "=>" || after === "if") return { name: t.text, open, close, generics };
      if (after !== ":") return null;
      // A return type must run on to `=>` or `if` before anything that ends
      // a statement.
      for (let k = close + 2; k < this.toks.length; ) {
        const x = this.text(k)!;
        if (x === "=>" || x === "if") return k > close + 2 ? { name: t.text, open, close, generics } : null;
        if (x === ";" || CLOSE.has(x)) return null;
        if (k > close + 2 && this.src.slice(this.toks[k - 1].end, this.toks[k].start).includes("\n") && !/^[|&]$/.test(x)) return null;
        k = x in OPEN ? this.matching(k) + 1 : k + 1;
      }
    } catch {
      return null;
    }
    return null;
  }

  /** `[export] function name<...>(params): R;` directly followed by clauses of name. */
  private signatureAt(i: number): { name: string; end: number; exported: boolean } | null {
    let k = i;
    const exported = this.text(k) === "export";
    if (exported) k++;
    if (this.text(k) !== "function" || !this.atStatementStart(i)) return null;
    const nameTok = this.toks[k + 1];
    if (!nameTok || nameTok.kind !== "ident") return null;
    try {
      let open = k + 2;
      if (this.text(open) === "<") open = this.matchingAngle(open) + 1;
      if (this.text(open) !== "(") return null;
      let j = this.matching(open) + 1;
      if (this.text(j) === ":") {
        j++;
        while (j < this.toks.length && this.text(j) !== ";") {
          const x = this.text(j)!;
          if (x === "{" && /^(ident|num|str)$/.test(this.toks[j - 1].kind)) return null; // a body
          if (CLOSE.has(x)) return null;
          j = x in OPEN ? this.matching(j) + 1 : j + 1;
        }
      }
      if (this.text(j) !== ";") return null;
      const c = this.clauseAt(j + 1);
      return c && c.name === nameTok.text ? { name: nameTok.text, end: j, exported } : null;
    } catch {
      return null;
    }
  }

  /** Where an expression body that started at j ends: at `;` or at a line break that ends the statement. */
  private clauseBodyEnd(j: number): { end: number; next: number } {
    let k = j;
    while (k < this.toks.length) {
      const x = this.text(k)!;
      if (x === ";") return { end: k, next: k + 1 };
      if (CLOSE.has(x)) return { end: k, next: k };
      const last = x in OPEN ? this.matching(k) : k;
      const nxt = last + 1;
      if (nxt >= this.toks.length) return { end: nxt, next: nxt };
      const broken = this.src.slice(this.toks[last].end, this.toks[nxt].start).includes("\n");
      if (broken && !CONTINUES_AFTER.has(this.text(last)!) && !CONTINUES_BEFORE.has(this.text(nxt)!)) {
        return { end: nxt, next: nxt };
      }
      k = nxt;
    }
    return { end: k, next: k };
  }

  private tryClauseFunction(i: number): { out: Mapped; next: number } | null {
    const sig = this.signatureAt(i);
    let first = i;
    let exported = false;
    if (sig) first = sig.end + 1;
    else if (this.text(i) === "export" && this.clauseAt(i + 1)) {
      exported = true;
      first = i + 1;
    }
    const head = this.clauseAt(first);
    if (!head) return null;
    const name = head.name;

    interface Clause extends Arm {
      annots: Array<[number, number] | null>;
      ret: [number, number] | null;
      bodyStart: number;
      end: number;
    }
    const clauses: Clause[] = [];
    let usesAwait = false;
    let j = first;
    for (;;) {
      const c = clauses.length === 0 ? head : this.clauseAt(j);
      if (!c || c.name !== name) break;
      if (c.generics && clauses.length > 0) throw new TsadtError("Type parameters go on the first clause only", this.posOf(c.generics[0]));
      const start = j;
      const pats: Pattern[] = [];
      const annots: Array<[number, number] | null> = [];
      for (const [a, b] of this.splitCommas(c.open + 1, c.close, true)) {
        if (a === b) throw new TsadtError("Empty parameter pattern", this.posOf(a));
        let colon = -1;
        for (let k = a; k < b; k = this.text(k)! in OPEN ? this.matching(k) + 1 : k + 1) {
          if (this.text(k) === ":") {
            colon = k;
            break;
          }
        }
        const r = this.parsePattern(a);
        if (r.next !== (colon >= 0 ? colon : b)) {
          throw new TsadtError(`Unexpected ${this.describe(r.next)} in the pattern for ${name}`, this.posOf(r.next));
        }
        pats.push(r.pat);
        annots.push(colon >= 0 ? [colon + 1, b] : null);
      }
      if (pats.length === 0) throw new TsadtError(`A clause function needs at least one parameter: ${name}()`, this.posOf(start));
      let k = c.close + 1;
      let ret: [number, number] | null = null;
      if (this.text(k) === ":") {
        const e = this.scanTo(k + 1, this.toks.length, ["=>", "if"]);
        ret = [k + 1, e];
        k = e;
      }
      let guard: Mapped | null = null;
      let guardPos = 0;
      if (this.text(k) === "if") {
        const g = this.scanTo(k + 1, this.toks.length, ["=>"]);
        if (g === k + 1) throw new TsadtError("Empty guard", this.posOf(k));
        guard = this.transform(k + 1, g);
        guardPos = this.posOf(k + 1);
        k = g;
      }
      this.expect(k, "=>", `'=>' after the parameters of ${name}`);
      k++;
      const bodyPos = this.posOf(k);
      const bodyStart = k;
      let body: Mapped;
      let block = false;
      if (this.text(k) === "{") {
        const close = this.matching(k);
        body = this.transform(k + 1, close);
        block = true;
        j = close + 1;
        if (this.text(j) === ";") j++;
      } else {
        const e = this.clauseBodyEnd(k);
        if (e.end === k) throw new TsadtError("Missing expression after '=>'", this.posOf(k));
        body = this.transform(k, e.end);
        j = e.next;
      }
      for (let x = start; x < j; x++) if (this.text(x) === "await") usesAwait = true;
      clauses.push({ rows: [pats], guard, guardPos, body, bodyPos, block, pos: this.posOf(start), annots, ret, bodyStart, end: j });
      if (j >= this.toks.length) break;
    }

    const width = clauses[0].rows[0].length;
    for (const c of clauses) {
      if (c.rows[0].length !== width) {
        throw new TsadtError(`Every clause of ${name} must take the same number of arguments (the first takes ${width})`, c.pos);
      }
    }
    const pos = clauses[0].pos;
    this.resolveArms(clauses);

    // Parameter names: a variable some clause binds there, else one made up
    // from the parameter's type.
    const taken = new Set<string>([name]);
    const paramNames: string[] = [];
    const paramTypes: Mapped[] = [];
    const typeVars: Array<[string, string]> = [];
    const addVar = (v: string, decl: string) => {
      if (!typeVars.some(([n]) => n === v)) typeVars.push([v, decl]);
    };
    let sigText: Mapped | null = null;

    if (sig) {
      if (clauses.some((c) => c.ret || c.annots.some((a) => a))) {
        throw new TsadtError(`${name} has a signature, so its clauses cannot also carry types`, pos);
      }
      sigText = new Mapped().copy(this.src, this.toks[i].start, this.toks[sig.end - 1].end);
      // parameter names, in order, from the signature
      let open = i + (sig.exported ? 3 : 2);
      if (this.text(open) === "<") open = this.matchingAngle(open) + 1;
      for (const [a] of this.splitCommas(open + 1, this.matching(open), true)) {
        if (this.toks[a]?.kind !== "ident") throw new TsadtError("Clause function signatures need plain parameter names", this.posOf(a));
        paramNames.push(this.toks[a].text);
      }
      if (paramNames.length !== width) {
        throw new TsadtError(`The signature of ${name} has ${paramNames.length} parameter(s) but its clauses take ${width}`, pos);
      }
    } else {
      for (let k = 0; k < width; k++) {
        // type
        const annotated = clauses.filter((c) => c.annots[k]);
        const texts = new Set(annotated.map((c) => this.slice(c.annots[k]![0], c.annots[k]![1])));
        if (texts.size > 1) throw new TsadtError(`Parameter ${k + 1} of ${name} is given different types: ${[...texts].join(" and ")}`, annotated[1].pos);
        if (annotated.length) {
          const [a, b] = annotated[0].annots[k]!;
          paramTypes.push(new Mapped().copy(this.src, this.toks[a].start, this.toks[b - 1].end));
        } else {
          paramTypes.push(this.inferParamType(clauses.map((c) => c.rows[0][k]), k, name, addVar));
        }
        // name: the first variable a clause binds here, else one made from the type
        const here = clauses.map((c) => c.rows[0][k]);
        let pn = here.map((p) => (p.k === "bind" ? p.name : "")).find((v) => v && !taken.has(v));
        if (!pn) {
          const ctor = here.find((p): p is CtorPattern => p.k === "ctor");
          const base = ctor ? ctor.type!.charAt(0).toLowerCase() + ctor.type!.slice(1) : "arg";
          pn = base;
          for (let n = 2; taken.has(pn); n++) pn = `${base}${n}`;
        }
        taken.add(pn);
        paramNames.push(pn);
      }
    }

    const scrutinee = new Mapped().gen(paramNames.join(", "), pos);
    const matchCode = this.compileArms(clauses, width, scrutinee, usesAwait, pos, name, this.indentAt(pos) + "  ");

    const out = new Mapped();
    if (sigText) {
      out.add(sigText).gen(" {", pos);
    } else {
      const rets = clauses.filter((c) => c.ret);
      const retTexts = new Set(rets.map((c) => this.slice(c.ret![0], c.ret![1])));
      if (retTexts.size > 1) throw new TsadtError(`${name} is given different return types: ${[...retTexts].join(" and ")}`, rets[1].pos);
      if (!rets.length) {
        const recursive = clauses.some((c) => {
          for (let x = c.bodyStart; x < c.end; x++) if (this.text(x) === name && this.text(x + 1) === "(" && this.text(x - 1) !== ".") return true;
          return false;
        });
        if (recursive) {
          throw new TsadtError(
            `${name} calls itself, so TypeScript needs its return type: add one after the first clause's parameters, as in ${name}(...): Type =>`,
            pos,
          );
        }
      }
      // type variables: explicit <...> on the first clause, or those the
      // inferred types use plus single capitals (T, U, T2) in annotations
      let generics = "";
      if (head.generics) {
        generics = this.slice(head.generics[0], head.generics[1]);
      } else {
        const annTokens: number[] = [];
        for (const c of clauses) {
          for (const a of c.annots) if (a) for (let x = a[0]; x < a[1]; x++) annTokens.push(x);
          if (c.ret) for (let x = c.ret[0]; x < c.ret[1]; x++) annTokens.push(x);
        }
        for (const x of annTokens) {
          const t = this.toks[x];
          if (t.kind === "ident" && /^[A-Z][0-9]*$/.test(t.text) && this.text(x - 1) !== ".") addVar(t.text, t.text);
        }
        if (typeVars.length) generics = `<${typeVars.map(([, d]) => d).join(", ")}>`;
      }
      out.gen(`${exported ? "export " : ""}${usesAwait ? "async " : ""}function ${name}${generics}(`, pos);
      paramNames.forEach((pn, k) => {
        out.gen(`${k ? ", " : ""}${pn}: `, clauses[0].rows[0][k].pos).add(paramTypes[k]);
      });
      out.gen(")", pos);
      if (rets.length) out.gen(": ", pos).copy(this.src, this.toks[rets[0].ret![0]].start, this.toks[rets[0].ret![1] - 1].end);
      out.gen(" {", pos);
    }
    if (sig && usesAwait && !/\basync\b/.test(sigText!.text)) {
      throw new TsadtError(`A clause of ${name} uses await, so its signature must be async`, pos);
    }
    const ind = this.indentAt(pos);
    out.gen(`\n${ind}  return `, pos).add(matchCode).gen(`;\n${ind}}`, pos);
    return { out, next: clauses[clauses.length - 1].end };
  }

  /** The type the patterns in one parameter position imply. */
  private inferParamType(pats: Pattern[], k: number, fn: string, addVar: (v: string, decl: string) => void): Mapped {
    const types = new Set<string>();
    const lits = new Set<string>();
    const walk = (p: Pattern): void => {
      if (p.k === "ctor") types.add(p.type!);
      else if (p.k === "lit") {
        if (/^-?[0-9.]/.test(p.text)) lits.add(/n$/.test(p.text) ? "bigint" : "number");
        else if (/^["']/.test(p.text)) lits.add("string");
        else if (p.text === "true" || p.text === "false") lits.add("boolean");
        else lits.add(p.text); // null, undefined
      } else if (p.k === "bind" && p.sub) walk(p.sub);
      else if (p.k === "or") p.alts.forEach(walk);
    };
    pats.forEach(walk);
    const nth = ["first", "second", "third", "fourth", "fifth"][k] ?? `${k + 1}th`;
    const at = pats[0].pos;
    if (types.size > 1) throw new TsadtError(`The ${nth} parameter of ${fn} is matched against constructors of different types: ${[...types].join(" and ")}`, at);
    if (types.size === 1 && lits.size > 0) throw new TsadtError(`The ${nth} parameter of ${fn} is matched against both constructors and literals`, at);
    if (types.size === 1) {
      const d = this.reg.types.get([...types][0])!;
      d.params.forEach((p, n) => addVar(p, d.paramDecls[n] ?? p));
      return new Mapped().gen(d.name + (d.params.length ? `<${d.params.join(", ")}>` : ""), at);
    }
    if (lits.size > 0) return new Mapped().gen([...lits].join(" | "), at);
    const v = pats.find((p) => p.k === "bind");
    const example = v && v.k === "bind" ? v.name : "x";
    throw new TsadtError(
      `Cannot tell the type of the ${nth} parameter of ${fn}: no clause matches it against a constructor or literal. ` +
        `Give it a type in one clause (${example}: SomeType) or write a signature.`,
      at,
    );
  }

  /** Appends tests and bindings for p, each attributed to its sub-pattern. */
  private compilePattern(p: Pattern, path: string, conds: Array<[string, number]>, binds: Array<[string, number]>): void {
    switch (p.k) {
      case "wild":
        return;
      case "bind":
        binds.push([`const ${p.name} = ${path};`, p.pos]);
        if (p.sub) this.compilePattern(p.sub, path, conds, binds);
        return;
      case "lit":
        conds.push([`${path} === ${p.text}`, p.pos]);
        return;
      case "ctor": {
        const info = this.reg.ctor(p.type!, p.name)!;
        conds.push([`${path}.${this.tag} === "${p.name}"`, p.pos]);
        p.args.forEach((a, k) => this.compilePattern(a, `${path}.${info.fields[k]}`, conds, binds));
        return;
      }
      case "or": {
        // Only or-patterns that bind nothing get here (see expandRow), so
        // they compile to a single disjunction.
        const alts = p.alts.map((a) => {
          const c: Array<[string, number]> = [];
          this.compilePattern(a, path, c, []);
          return c.map(([t]) => t);
        });
        if (alts.some((c) => c.length === 0)) return; // an alternative matches anything
        conds.push([`(${alts.map((c) => (c.length > 1 ? `(${c.join(" && ")})` : c[0])).join(" || ")})`, p.pos]);
        return;
      }
    }
  }

  /**
   * Splits a row into or-free variants wherever an or-pattern binds
   * variables, since each variant then binds them from different places.
   * Or-patterns that bind nothing stay and compile to `||`.
   */
  private expandRow(row: Pattern[]): Pattern[][] {
    const expand = (p: Pattern): Pattern[] => {
      switch (p.k) {
        case "bind":
          return p.sub ? expand(p.sub).map((s) => ({ ...p, sub: s })) : [p];
        case "ctor":
          return product(p.args.map(expand)).map((args) => ({ ...p, args }));
        case "or":
          return boundNames(p).length > 0 ? p.alts.flatMap(expand) : [p];
        default:
          return [p];
      }
    };
    const variants = product(row.map(expand));
    if (variants.length > 64) {
      throw new TsadtError(`This or-pattern expands to ${variants.length} cases; split it into several arms`, row[0].pos);
    }
    return variants;
  }

  private genMatch(arms: Arm[], width: number, scrutinee: Mapped, isAsync: boolean, pos: number, indent: string): Mapped {
    const m = new Mapped();
    // One parameter per matched value: (__m0) or (__m0_0, __m0_1, ...).
    const base = `__m${this.counter++}`;
    const vars = width === 1 ? [base] : Array.from({ length: width }, (_, k) => `${base}_${k}`);
    const NL = "\n" + indent;
    const asyncKw = isAsync ? "async " : "";
    m.gen(`${isAsync ? "(await " : ""}(${asyncKw}(${vars.join(", ")}) => {`, pos);
    let irrefutable = false;
    arms: for (const arm of arms) {
      const variants = arm.rows.flatMap((r) => this.expandRow(r));
      const compiled = variants.map((row) => {
        const conds: Array<[string, number]> = [];
        const binds: Array<[string, number]> = [];
        row.forEach((p, k) => this.compilePattern(p, vars[k], conds, binds));
        return { conds, binds };
      });
      // Alternatives that bind nothing share one test: if (a || b). Otherwise
      // each gets its own block, so TypeScript narrows each one separately.
      const groups =
        compiled.length > 1 && compiled.every((c) => c.binds.length === 0)
          ? [{ disjuncts: compiled.map((c) => c.conds), binds: [] as Array<[string, number]> }]
          : compiled.map((c) => ({ disjuncts: [c.conds], binds: c.binds }));
      for (const g of groups) {
        const always = g.disjuncts.some((d) => d.length === 0);
        const wrapped = !always || arm.guard !== null;
        const indent = wrapped ? "    " : "  ";
        if (!always) {
          m.gen(`${NL}  if (`, arm.pos);
          g.disjuncts.forEach((d, k) => {
            if (k) m.gen(" || ", arm.pos);
            const paren = g.disjuncts.length > 1 && d.length > 1;
            if (paren) m.gen("(", arm.pos);
            d.forEach(([c, at], n) => m.gen((n ? " && " : "") + c, at));
            if (paren) m.gen(")", arm.pos);
          });
          m.gen(") {", arm.pos);
        } else if (arm.guard !== null) {
          m.gen(`${NL}  {`, arm.pos);
        }
        for (const [b, at] of g.binds) m.gen(NL + indent + b, at);
        m.gen(NL + indent, arm.pos);
        if (arm.guard !== null) m.gen("if (", arm.guardPos).add(arm.guard).gen(") ", arm.guardPos);
        if (arm.block) m.gen(`return (${asyncKw}() => {`, arm.bodyPos).add(arm.body).gen("})();", arm.bodyPos);
        else m.gen("return ", arm.bodyPos).add(arm.body).gen(";", arm.bodyPos);
        if (wrapped) {
          m.gen(`${NL}  }`, arm.pos);
        } else {
          irrefutable = true;
          break arms;
        }
      }
    }
    if (!irrefutable) {
      const { line, col } = this.loc(pos);
      m.gen(`${NL}  throw new Error(${JSON.stringify(`match failure at ${this.file}:${line}:${col}`)});`, pos);
    }
    m.gen(`${NL}})(`, pos).add(scrutinee).gen(`)${isAsync ? ")" : ""}`, pos);
    return m;
  }
}

function showRow(pats: Pattern[]): string {
  return pats.length === 1 ? showPattern(pats[0]) : `(${pats.map(showPattern).join(", ")})`;
}

function showArm(rows: Pattern[][]): string {
  return rows.map(showRow).join(" | ");
}

/** Cartesian product: [[a, b], [c]] -> [[a, c], [b, c]]. */
function product<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>((acc, list) => acc.flatMap((xs) => list.map((x) => [...xs, x])), [[]]);
}

function register(reg: Registry, d: DataDecl, error: (msg: string) => void): void {
  const prior = reg.types.get(d.name);
  if (prior) {
    error(`Data type '${d.name}' is already declared in ${prior.file}`);
    return;
  }
  reg.types.set(d.name, d);
  for (const c of d.ctors) reg.ctors.set(c.name, [...(reg.ctors.get(c.name) ?? []), c]);
}

function errorDiag(e: unknown, t: Transpiler | null, src: string, file: string): Diagnostic {
  if (!(e instanceof TsadtError)) throw e;
  const loc = t ? t.loc(e.pos) : lineCol(src, e.pos);
  return { severity: "error", message: e.message, file, ...loc };
}

function lineCol(src: string, pos: number): { line: number; col: number } {
  const before = src.slice(0, pos).split("\n");
  return { line: before.length, col: before.at(-1)!.length + 1 };
}

/** Pass 1: registers every `data` declaration in `src`. */
export function collectDataDecls(src: string, file: string, reg: Registry, opts: TranspileOptions = {}): Diagnostic[] {
  let t: Transpiler | null = null;
  try {
    t = new Transpiler(src, file, reg, opts);
    t.collect();
    return t.diags;
  } catch (e) {
    return [...(t?.diags ?? []), errorDiag(e, t, src, file)];
  }
}

/**
 * Pass 2: translates `src` to plain TypeScript. Pass a registry already filled
 * by collectDataDecls() to resolve constructors declared in other files;
 * without one, only this file's declarations are visible.
 */
export function transpile(src: string, file = "<input>", reg?: Registry, opts: TranspileOptions = {}): TranspileResult {
  const diagnostics: Diagnostic[] = [];
  if (!reg) {
    reg = new Registry();
    diagnostics.push(...collectDataDecls(src, file, reg, opts));
    if (diagnostics.some((d) => d.severity === "error")) return { code: "", diagnostics, sourcePosition: () => null };
  }
  let t: Transpiler | null = null;
  try {
    t = new Transpiler(src, file, reg, opts);
    const out = t.run();
    const tr = t;
    return {
      code: out.text,
      diagnostics: [...diagnostics, ...t.diags],
      sourcePosition: (offset) => {
        const p = out.originalPos(offset);
        return p === null ? null : tr.loc(p);
      },
    };
  } catch (e) {
    return { code: "", diagnostics: [...diagnostics, ...(t?.diags ?? []), errorDiag(e, t, src, file)], sourcePosition: () => null };
  }
}
