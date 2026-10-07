// `deriving (Eq, Ord, Show)`: generated equality, ordering and printing.
//
// TypeScript has no type classes, so this follows the dictionary-passing
// translation Haskell uses internally. Each derived operation is a function
// specialized to the data type:
//
//   data List<T> = Nil | Cons(head: T, tail: List<T>) deriving (Eq);
//   function __List_equals<T>(a: List<T>, b: List<T>, eqT = __tsadt_eq): boolean
//
// A field is compared with the operation that fits its declared type: a
// type parameter uses the function passed for it (eqT), a data type that
// derives the operation uses that type's function, an array goes element by
// element, and anything else (numbers, strings, records...) uses a small
// generic helper. The helpers are emitted once per file, and only the ones
// that are used, so that projects with noUnusedLocals stay quiet.

import type { Token } from "./lexer.js";
import type { DataDecl, Registry, TypeAst } from "./registry.js";

/** Derivable class -> the method name it adds to the type's namespace. */
export const DERIVABLE: ReadonlyMap<string, string> = new Map([
  ["Eq", "equals"],
  ["Ord", "compare"],
  ["Show", "show"],
]);

const GENERIC: Record<string, string> = { Eq: "__tsadt_eq", Ord: "__tsadt_cmp", Show: "__tsadt_show" };
const ARRAY: Record<string, string> = { Eq: "__tsadt_arrayEq", Ord: "__tsadt_arrayCmp", Show: "__tsadt_arrayShow" };
const PREFIX: Record<string, string> = { Eq: "eq", Ord: "cmp", Show: "show" };

/** Parses a field type's tokens. Anything beyond names, arguments and arrays is opaque. */
export function parseTypeAst(toks: Token[]): TypeAst {
  let i = 0;
  const text = (k = 0) => toks[i + k]?.text;
  const parse = (): TypeAst | null => {
    if (text() === "readonly") i++;
    let t: TypeAst | null;
    if (text() === "(") {
      i++;
      t = parse();
      if (!t || text() !== ")") return null;
      i++;
    } else if (toks[i]?.kind === "ident") {
      let name = toks[i++].text;
      while (text() === "." && toks[i + 1]?.kind === "ident") {
        name += "." + toks[i + 1].text;
        i += 2;
      }
      const args: TypeAst[] = [];
      if (text() === "<") {
        i++;
        for (;;) {
          const a = parse();
          if (!a) return null;
          args.push(a);
          if (text() === ",") i++;
          else if (text() === ">") {
            i++;
            break;
          } else return null;
        }
      }
      t = (name === "Array" || name === "ReadonlyArray") && args.length === 1 ? { k: "array", elem: args[0] } : { k: "ref", name, args };
    } else {
      return null;
    }
    while (text() === "[" && text(1) === "]") {
      i += 2;
      t = { k: "array", elem: t };
    }
    return t;
  };
  const t = parse();
  return t && i === toks.length ? t : { k: "opaque" };
}

interface Dict {
  /** Code applying the operation to the given argument expressions. */
  call(args: string[]): string;
  /** Code for the operation as a function value. */
  value(): string;
}

export interface DeriveContext {
  reg: Registry;
  file: string;
  tag: string;
  /** Generic helpers referenced so far in this file. */
  helpers: Set<string>;
  error(message: string, pos: number): void;
}

/** The name of the generated function for one operation of one type. */
export function derivedFunctionName(type: string, cls: string): string {
  return `__${type}_${DERIVABLE.get(cls)}`;
}

/** Generates the function for one derived class of one data type. */
export function deriveFunction(d: DataDecl, cls: string, ctx: DeriveContext, NL: string): string {
  const usedParams = new Set<string>();
  const paramName = (p: string) => PREFIX[cls] + p;
  const generic = (): Dict => {
    ctx.helpers.add(GENERIC[cls]);
    return { call: (a) => `${GENERIC[cls]}(${a.join(", ")})`, value: () => GENERIC[cls] };
  };
  const lambda = (body: (args: string[]) => string) => (cls === "Show" ? `(x) => ${body(["x"])}` : `(x, y) => ${body(["x", "y"])}`);

  const dictFor = (t: TypeAst, pos: number): Dict | null => {
    if (t.k === "array") {
      const elem = dictFor(t.elem, pos) ?? generic();
      ctx.helpers.add(ARRAY[cls]);
      const v = () => `${ARRAY[cls]}(${elem.value()})`;
      return { call: (a) => `${v()}(${a.join(", ")})`, value: v };
    }
    if (t.k !== "ref") return null;
    if (t.args.length === 0 && d.params.includes(t.name)) {
      const n = paramName(t.name);
      return {
        call: (a) => (usedParams.add(n), `${n}(${a.join(", ")})`),
        value: () => (usedParams.add(n), n),
      };
    }
    const D = ctx.reg.types.get(t.name);
    if (!D) return null;
    if (!D.deriving.includes(cls)) {
      ctx.error(`${d.name} derives ${cls}, so its field type ${D.name} must too: add deriving (${cls}) to ${D.name}`, pos);
      return null;
    }
    const fn = D.file === ctx.file ? derivedFunctionName(D.name, cls) : `${D.name}.${DERIVABLE.get(cls)}`;
    const extra = () => {
      const xs = D.params.map((_, k) => (t.args[k] ? (dictFor(t.args[k], pos)?.value() ?? "undefined") : "undefined"));
      while (xs.length && xs[xs.length - 1] === "undefined") xs.pop();
      return xs;
    };
    return {
      call: (a) => `${fn}(${[...a, ...extra()].join(", ")})`,
      value: () => {
        const xs = extra();
        return xs.length ? lambda((a) => `${fn}(${[...a, ...xs].join(", ")})`) : fn;
      },
    };
  };
  const field = (t: TypeAst, args: string[], pos: number) => (dictFor(t, pos) ?? generic()).call(args);

  const tag = ctx.tag;
  const self = d.name + (d.params.length ? `<${d.params.join(", ")}>` : "");
  const body: string[] = [];
  if (cls === "Eq") {
    body.push(`if (a.${tag} !== b.${tag}) return false;`);
    for (const c of d.ctors) {
      const parts = c.fields.map((f, k) => field(c.typeAsts[k], [`a.${f}`, `b.${f}`], c.pos));
      body.push(`if (a.${tag} === "${c.name}" && b.${tag} === "${c.name}") return ${parts.length ? parts.join(" && ") : "true"};`);
    }
    body.push("return false;");
  } else if (cls === "Ord") {
    const order = JSON.stringify(d.ctors.map((c) => c.name)).replace(/,/g, ", ");
    body.push(`if (a.${tag} !== b.${tag}) {`, `  const order = ${order};`, `  return order.indexOf(a.${tag}) < order.indexOf(b.${tag}) ? -1 : 1;`, "}");
    for (const c of d.ctors) {
      const parts = c.fields.map((f, k) => field(c.typeAsts[k], [`a.${f}`, `b.${f}`], c.pos));
      const test = `if (a.${tag} === "${c.name}" && b.${tag} === "${c.name}")`;
      if (parts.length <= 1) {
        body.push(`${test} return ${parts[0] ?? "0"};`);
      } else {
        body.push(`${test} {`, "  let c: number;");
        for (const p of parts.slice(0, -1)) body.push(`  if ((c = ${p}) !== 0) return c;`);
        body.push(`  return ${parts[parts.length - 1]};`, "}");
      }
    }
    body.push("return 0;");
  } else {
    body.push(`switch (a.${tag}) {`);
    for (const c of d.ctors) {
      const name = ctx.reg.isShared(c.name) ? `${d.name}.${c.name}` : c.name;
      const parts = c.fields.map((f, k) => "${" + field(c.typeAsts[k], [`a.${f}`], c.pos) + "}");
      body.push(`  case "${c.name}": return ${parts.length ? "`" + `${name}(${parts.join(", ")})` + "`" : JSON.stringify(name)};`);
    }
    body.push("}");
  }

  // Signature last: an unused dictionary parameter gets a leading underscore.
  const dictType = (p: string) => (cls === "Show" ? `(x: ${p}) => string` : `(x: ${p}, y: ${p}) => ${cls === "Eq" ? "boolean" : "number"}`);
  const dicts = d.params.map((p) => {
    const n = paramName(p);
    ctx.helpers.add(GENERIC[cls]);
    return `${usedParams.has(n) ? n : "_" + n}: ${dictType(p)} = ${GENERIC[cls]}`;
  });
  const values = cls === "Show" ? [`a: ${self}`] : [`a: ${self}`, `b: ${self}`];
  const ret = cls === "Eq" ? "boolean" : cls === "Ord" ? "number" : "string";
  return [
    `function ${derivedFunctionName(d.name, cls)}${d.paramText}(${[...values, ...dicts].join(", ")}): ${ret} {`,
    ...body.map((l) => "  " + l),
    "}",
  ].join(NL);
}

/** Source for the generic helpers in `names`, plus the helpers they use. */
export function helperSource(names: Set<string>, tag: string): string {
  const need = new Set(names);
  if (need.has("__tsadt_cmp")) need.add("__tsadt_show"); // its error message shows the values
  const T = JSON.stringify(tag);
  const src: Record<string, string> = {
    __tsadt_eq: `function __tsadt_eq(a: unknown, b: unknown): boolean {
  if (a === b || (a !== a && b !== b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => __tsadt_eq(x, b[i]));
  if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();
  const pa = Object.getPrototypeOf(a);
  if (pa !== Object.getPrototypeOf(b) || (pa !== Object.prototype && pa !== null)) return false;
  const ra = a as Record<string, unknown>, rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  return ka.length === Object.keys(rb).length && ka.every((k) => Object.prototype.hasOwnProperty.call(rb, k) && __tsadt_eq(ra[k], rb[k]));
}`,
    __tsadt_cmp: `function __tsadt_cmp(a: unknown, b: unknown): number {
  const t = typeof a;
  if (t === typeof b && (t === "number" || t === "string" || t === "bigint" || t === "boolean")) {
    const x = a as number, y = b as number;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < a.length && i < b.length; i++) {
      const c = __tsadt_cmp(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
  }
  if (a instanceof Date && b instanceof Date) return __tsadt_cmp(a.getTime(), b.getTime());
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    const ra = a as Record<string, unknown>, rb = b as Record<string, unknown>;
    if (typeof ra[${T}] === "string" && ra[${T}] === rb[${T}]) {
      for (const k of Object.keys(ra)) {
        if (k === ${T}) continue;
        const c = __tsadt_cmp(ra[k], rb[k]);
        if (c !== 0) return c;
      }
      return 0;
    }
  }
  throw new TypeError("tsadt: cannot order " + __tsadt_show(a) + " and " + __tsadt_show(b) +
    " without knowing their type; pass a comparator for the type parameter, as in List.compare(xs, ys, Option.compare)");
}`,
    __tsadt_show: `function __tsadt_show(x: unknown): string {
  if (typeof x === "string") return JSON.stringify(x);
  if (typeof x === "bigint") return x + "n";
  if (Array.isArray(x)) return "[" + x.map((e) => __tsadt_show(e)).join(", ") + "]";
  if (x instanceof Date) return "Date(" + JSON.stringify(x.toISOString()) + ")";
  if (typeof x === "object" && x !== null) {
    const r = x as Record<string, unknown>;
    const keys = Object.keys(r).filter((k) => k !== ${T});
    if (typeof r[${T}] === "string") return keys.length ? r[${T}] + "(" + keys.map((k) => __tsadt_show(r[k])).join(", ") + ")" : r[${T}];
    return "{ " + keys.map((k) => k + ": " + __tsadt_show(r[k])).join(", ") + " }";
  }
  return String(x);
}`,
    __tsadt_arrayEq: `function __tsadt_arrayEq<T>(eq: (x: T, y: T) => boolean): (a: readonly T[], b: readonly T[]) => boolean {
  return (a, b) => a.length === b.length && a.every((x, i) => eq(x, b[i] as T));
}`,
    __tsadt_arrayCmp: `function __tsadt_arrayCmp<T>(cmp: (x: T, y: T) => number): (a: readonly T[], b: readonly T[]) => number {
  return (a, b) => {
    for (let i = 0; i < a.length && i < b.length; i++) {
      const c = cmp(a[i] as T, b[i] as T);
      if (c !== 0) return c;
    }
    return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
  };
}`,
    __tsadt_arrayShow: `function __tsadt_arrayShow<T>(show: (x: T) => string): (a: readonly T[]) => string {
  return (a) => "[" + a.map((x) => show(x)).join(", ") + "]";
}`,
  };
  const order = ["__tsadt_eq", "__tsadt_cmp", "__tsadt_show", "__tsadt_arrayEq", "__tsadt_arrayCmp", "__tsadt_arrayShow"];
  const parts = order.filter((n) => need.has(n)).map((n) => src[n]);
  return parts.length ? "// Helpers for derived operations, generated by tsadt.\n" + parts.join("\n") + "\n\n" : "";
}
