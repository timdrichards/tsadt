// Exhaustiveness and redundancy checking for match arms.
//
// This is the classic pattern-matrix "usefulness" algorithm (Maranget,
// "Warnings for pattern matching", JFP 2007). A pattern vector q is useful
// with respect to matrix P if some value matches q but no row of P. Then:
//   - arm i is redundant  iff  !useful(rows before i, p_i)
//   - the match is exhaustive iff !useful(all rows, _)
// The witness variant also returns an example value that no arm covers.
//
// Guarded arms never count as covering anything, since the guard may fail.

import { Pattern, Registry } from "./registry.js";

type P = { k: "wild" } | { k: "con"; key: string; display: string; args: P[] };
type Row = P[];

const WILD: P = { k: "wild" };
const wilds = (n: number): P[] => Array.from({ length: n }, () => WILD);

interface Member {
  key: string;
  arity: number;
  display: string;
}

function canonLit(text: string): string {
  if (/^["']/.test(text)) {
    return "s:" + text.slice(1, -1).replace(/\\(["'\\])/g, "$1");
  }
  if (/^-?[0-9.]/.test(text)) {
    const neg = text.startsWith("-");
    const v = Number(text.replace(/^-/, "").replace(/_/g, ""));
    return Number.isNaN(v) ? "n:" + text : "n:" + String(neg ? -v : v);
  }
  return text; // true, false, null, undefined
}

export function normalize(p: Pattern): P {
  switch (p.k) {
    case "wild":
      return WILD;
    case "bind":
      return p.sub ? normalize(p.sub) : WILD;
    case "lit":
      return { k: "con", key: "l:" + canonLit(p.text), display: p.text, args: [] };
    case "ctor":
      return { k: "con", key: "c:" + p.name, display: p.name, args: p.args.map(normalize) };
  }
}

class Checker {
  constructor(private reg: Registry) {}

  private heads(rows: Row[]): string[] {
    const keys = new Set<string>();
    for (const r of rows) if (r[0].k === "con") keys.add(r[0].key);
    return [...keys];
  }

  /** The full constructor set for a column, if it is finite and known. */
  private signature(keys: string[]): Member[] | null {
    for (const k of keys) {
      if (!k.startsWith("c:")) continue;
      const info = this.reg.ctors.get(k.slice(2));
      if (!info) continue;
      const decl = this.reg.types.get(info.typeName)!;
      return decl.ctors.map((c) => ({ key: "c:" + c.name, arity: c.fields.length, display: c.name }));
    }
    if (keys.length > 0 && keys.every((k) => k === "l:true" || k === "l:false")) {
      return [
        { key: "l:true", arity: 0, display: "true" },
        { key: "l:false", arity: 0, display: "false" },
      ];
    }
    return null; // numbers, strings, ...: never complete without a wildcard
  }

  private specialize(rows: Row[], key: string, arity: number): Row[] {
    const out: Row[] = [];
    for (const r of rows) {
      const h = r[0];
      if (h.k === "wild") out.push([...wilds(arity), ...r.slice(1)]);
      else if (h.key === key) out.push([...h.args, ...r.slice(1)]);
    }
    return out;
  }

  private defaults(rows: Row[]): Row[] {
    return rows.filter((r) => r[0].k === "wild").map((r) => r.slice(1));
  }

  useful(rows: Row[], q: P[]): boolean {
    if (q.length === 0) return rows.length === 0;
    const [h, ...rest] = q;
    if (h.k === "con") {
      return this.useful(this.specialize(rows, h.key, h.args.length), [...h.args, ...rest]);
    }
    const keys = this.heads(rows);
    const sig = this.signature(keys);
    if (sig && sig.every((m) => keys.includes(m.key))) {
      return sig.some((m) => this.useful(this.specialize(rows, m.key, m.arity), [...wilds(m.arity), ...rest]));
    }
    return this.useful(this.defaults(rows), rest);
  }

  /** A vector of n patterns matched by no row of `rows`, or null. */
  witness(rows: Row[], n: number): string[] | null {
    if (n === 0) return rows.length === 0 ? [] : null;
    const keys = this.heads(rows);
    const sig = this.signature(keys);
    if (sig && keys.length > 0 && sig.every((m) => keys.includes(m.key))) {
      for (const m of sig) {
        const w = this.witness(this.specialize(rows, m.key, m.arity), m.arity + n - 1);
        if (w) return [render(m, w.slice(0, m.arity)), ...w.slice(m.arity)];
      }
      return null;
    }
    const w = this.witness(this.defaults(rows), n - 1);
    if (!w) return null;
    const missing = sig?.find((m) => !keys.includes(m.key));
    const head = keys.length > 0 && missing ? render(missing, wilds(missing.arity).map(() => "_")) : "_";
    return [head, ...w];
  }
}

function render(m: Member, args: string[]): string {
  return m.arity === 0 ? m.display : `${m.display}(${args.join(", ")})`;
}

export interface ArmInfo {
  /** One pattern per matched value. */
  pats: Pattern[];
  guarded: boolean;
}

export interface CheckResult {
  /** Indices of arms that can never be reached. */
  redundant: number[];
  /**
   * An example value no arm covers (shown as a tuple when matching several
   * values), or null if the match is exhaustive.
   */
  missing: string | null;
}

export function checkMatch(arms: ArmInfo[], reg: Registry): CheckResult {
  const c = new Checker(reg);
  const width = arms[0]?.pats.length ?? 1;
  const covering: Row[] = [];
  const redundant: number[] = [];
  arms.forEach((arm, i) => {
    const row = arm.pats.map(normalize);
    if (!c.useful(covering, row)) redundant.push(i);
    else if (!arm.guarded) covering.push(row);
  });
  const w = c.witness(covering, width);
  return { redundant, missing: w ? (width === 1 ? w[0] : `(${w.join(", ")})`) : null };
}
