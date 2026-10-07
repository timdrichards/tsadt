// Source-to-source translation of `data` declarations and `match` expressions
// into plain TypeScript. Everything else is copied through untouched.

import { checkMatch } from "./exhaustive.js";
import { Token, TsadtError, tokenize } from "./lexer.js";
import { Mapped } from "./mapped.js";
import { CtorInfo, DataDecl, Pattern, Registry, showPattern } from "./registry.js";

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
const LITERAL_IDENTS =new Set(["true", "false", "null", "undefined"]);
const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSE = new Set([")", "]", "}"]);

interface Arm {
  /** One pattern per matched value. */
  pats: Pattern[];
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
    return m
      .copy(this.src, 0, this.toks[0].start)
      .add(this.transform(0, n))
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
    if (this.text(j) === "<") {
      const close = this.matchingAngle(j);
      paramText = this.slice(j, close + 1);
      paramSpan = [this.toks[j].start, this.toks[close].end];
      params = this.splitCommas(j + 1, close, true).map(([s]) => {
        if (this.toks[s].kind !== "ident") throw new TsadtError("Expected a type parameter name", this.posOf(s));
        return this.toks[s].text;
      });
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
          if (fields.at(-1) === this.tag) {
            throw new TsadtError(`Field name '${this.tag}' is reserved for the discriminant`, this.posOf(s));
          }
        });
        const dup = fields.find((f, k) => fields.indexOf(f) !== k);
        if (dup) throw new TsadtError(`Duplicate field '${dup}' in ${t.text}`, this.posOf(j));
        j = close + 1;
      }
      ctors.push({ name: t.text, typeName: name, fields, types, pos: t.start, typeSpans });
      if (this.text(j) !== "|") break;
      j++;
    }
    if (this.text(j) === ";") j++;
    return { decl: { name, params, paramText, paramSpan, ctors, file: this.file, pos }, next: j };
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
    for (const c of d.ctors) {
      if (c.fields.length === 0) {
        // A nullary constructor is one shared value. With type parameters it
        // gets type List<never>, which is assignable to every List<T>
        // because all fields are readonly (covariant).
        const ty = d.name + (d.params.length ? `<${d.params.map(() => "never").join(", ")}>` : "");
        m.gen(`${NL}${ex}const ${c.name}: ${ty} = { ${tag}: "${c.name}" };`, c.pos);
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
    return m;
  }

  // ---------------------------------------------------------------- match

  private parsePattern(j: number): { pat: Pattern; next: number } {
    const t = this.toks[j];
    if (!t) throw new TsadtError("Expected a pattern but found end of file", this.src.length);
    const pos = t.start;
    if (t.text === "_") return { pat: { k: "wild", pos }, next: j + 1 };
    if (t.kind === "num" || t.kind === "str" || (t.kind === "ident" && LITERAL_IDENTS.has(t.text))) {
      return { pat: { k: "lit", text: t.text, pos }, next: j + 1 };
    }
    if (t.text === "-" && this.toks[j + 1]?.kind === "num") {
      return { pat: { k: "lit", text: "-" + this.toks[j + 1].text, pos }, next: j + 2 };
    }
    if (t.kind === "tmpl") throw new TsadtError("Template literals are not allowed in patterns", pos);
    if (t.kind !== "ident") throw new TsadtError(`Expected a pattern but found '${t.text}'`, pos);

    if (/^[A-Z]/.test(t.text)) {
      const args: Pattern[] = [];
      let k = j + 1;
      if (this.text(k) === "(") {
        k++;
        while (this.text(k) !== ")") {
          const r = this.parsePattern(k);
          args.push(r.pat);
          k = r.next;
          if (this.text(k) === ",") k++;
          else if (this.text(k) !== ")") throw new TsadtError(`Expected ',' or ')' in pattern but found ${this.describe(k)}`, this.posOf(k));
        }
        k++;
      }
      return { pat: { k: "ctor", name: t.text, args, pos }, next: k };
    }
    if (this.text(j + 1) === "@") {
      const r = this.parsePattern(j + 2);
      return { pat: { k: "bind", name: t.text, sub: r.pat, pos }, next: r.next };
    }
    return { pat: { k: "bind", name: t.text, sub: null, pos }, next: j + 1 };
  }

  /**
   * Parses the patterns of one arm. With several matched values that is a
   * parenthesized tuple `(p1, ..., pn)`, or `_` for "anything". With one value
   * a parenthesized pattern `(p)` is just grouping.
   */
  private parseArmPatterns(j: number, width: number): { pats: Pattern[]; next: number } {
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
        const what = width === 1 ? "one value" : `${width} values`;
        throw new TsadtError(`This match is on ${what}, but the pattern has ${pats.length}`, this.posOf(j));
      }
      return { pats, next: close + 1 };
    }
    const { pat, next } = this.parsePattern(j);
    if (width === 1) return { pats: [pat], next };
    if (pat.k === "wild") return { pats: Array.from({ length: width }, () => pat), next };
    throw new TsadtError(
      `This match is on ${width} values, so each arm needs ${width} patterns in parentheses, like (${Array(width).fill("_").join(", ")}), or _ for anything`,
      pat.pos,
    );
  }

  private validate(p: Pattern, names: Set<string>): void {
    switch (p.k) {
      case "bind":
        if (names.has(p.name)) throw new TsadtError(`Variable '${p.name}' is bound twice in one pattern`, p.pos);
        names.add(p.name);
        if (p.sub) this.validate(p.sub, names);
        return;
      case "ctor": {
        const info = this.reg.ctors.get(p.name);
        if (!info) throw new TsadtError(`Unknown constructor '${p.name}'. Is its data declaration in one of the input files?`, p.pos);
        if (info.fields.length !== p.args.length) {
          throw new TsadtError(`${p.name} has ${info.fields.length} field(s) but the pattern gives ${p.args.length}`, p.pos);
        }
        for (const a of p.args) this.validate(a, names);
        return;
      }
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
      const { pats, next } = this.parseArmPatterns(j, width);
      const names = new Set<string>();
      for (const p of pats) this.validate(p, names);
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
      this.expect(j, "=>", `'=>' after pattern ${showArm(pats)}`);
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
      arms.push({ pats, guard, guardPos, body, bodyPos, block, pos: this.posOf(armStart) });
    }
    if (arms.length === 0) throw new TsadtError("match has no arms", matchPos);

    const check = checkMatch(arms.map((a) => ({ pats: a.pats, guarded: a.guard !== null })), this.reg);
    for (const k of check.redundant) {
      this.report("warning", `Unreachable match arm '${showArm(arms[k].pats)}' (removed from output)`, arms[k].pos);
    }
    if (check.missing !== null) {
      this.report("error", `Non-exhaustive match: no arm covers ${check.missing}`, matchPos);
    }
    const live = arms.filter((_, k) => !check.redundant.includes(k));
    const out = new Mapped();
    if (!usesAwait && this.needsAsiGuard(i)) out.gen(";", matchPos);
    out.add(this.genMatch(live, width, scrutinee, usesAwait, matchPos));
    return { out, next: bClose + 1 };
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
        const info = this.reg.ctors.get(p.name)!;
        conds.push([`${path}.${this.tag} === "${p.name}"`, p.pos]);
        p.args.forEach((a, k) => this.compilePattern(a, `${path}.${info.fields[k]}`, conds, binds));
        return;
      }
    }
  }

  private genMatch(arms: Arm[], width: number, scrutinee: Mapped, isAsync: boolean, pos: number): Mapped {
    const m = new Mapped();
    // One parameter per matched value: (__m0) or (__m0_0, __m0_1, ...).
    const base = `__m${this.counter++}`;
    const vars = width === 1 ? [base] : Array.from({ length: width }, (_, k) => `${base}_${k}`);
    const NL = "\n" + this.indentAt(pos);
    const asyncKw = isAsync ? "async " : "";
    m.gen(`${isAsync ? "(await " : ""}(${asyncKw}(${vars.join(", ")}) => {`, pos);
    let irrefutable = false;
    for (const arm of arms) {
      const conds: Array<[string, number]> = [];
      const binds: Array<[string, number]> = [];
      arm.pats.forEach((p, k) => this.compilePattern(p, vars[k], conds, binds));
      const wrapped = conds.length > 0 || arm.guard !== null;
      const indent = wrapped ? "    " : "  ";
      if (conds.length > 0) {
        m.gen(`${NL}  if (`, arm.pos);
        conds.forEach(([c, at], k) => m.gen((k ? " && " : "") + c, at));
        m.gen(") {", arm.pos);
      } else if (arm.guard !== null) {
        m.gen(`${NL}  {`, arm.pos);
      }
      for (const [b, at] of binds) m.gen(NL + indent + b, at);
      m.gen(NL + indent, arm.pos);
      if (arm.guard !== null) m.gen("if (", arm.guardPos).add(arm.guard).gen(") ", arm.guardPos);
      if (arm.block) m.gen(`return (${asyncKw}() => {`, arm.bodyPos).add(arm.body).gen("})();", arm.bodyPos);
      else m.gen("return ", arm.bodyPos).add(arm.body).gen(";", arm.bodyPos);
      if (wrapped) {
        m.gen(`${NL}  }`, arm.pos);
      } else {
        irrefutable = true;
        break;
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

function showArm(pats: Pattern[]): string {
  return pats.length === 1 ? showPattern(pats[0]) : `(${pats.map(showPattern).join(", ")})`;
}

function register(reg: Registry, d: DataDecl, error: (msg: string) => void): void {
  const prior = reg.types.get(d.name);
  if (prior) {
    error(`Data type '${d.name}' is already declared in ${prior.file}`);
    return;
  }
  for (const c of d.ctors) {
    const other = reg.ctors.get(c.name);
    if (other) {
      error(`Constructor '${c.name}' is already used by data type '${other.typeName}'. Constructor names must be unique.`);
      return;
    }
  }
  reg.types.set(d.name, d);
  for (const c of d.ctors) reg.ctors.set(c.name, c);
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
