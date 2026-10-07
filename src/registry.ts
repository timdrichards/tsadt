// Shared data structures: the constructor registry and the pattern AST.

export interface CtorInfo {
  name: string;
  typeName: string;
  fields: string[];
  types: string[];
  /** Position of the constructor name in its source file. */
  pos: number;
  /** Source offsets [start, end) of each field type, for exact error mapping. */
  typeSpans: Array<[number, number]>;
}

export interface DataDecl {
  name: string;
  /** Type parameter names, e.g. ["T"] for `List<T>`. */
  params: string[];
  /** Type parameter list as written, e.g. "<T extends object = {}>", or "". */
  paramText: string;
  /** Source offsets [start, end) of paramText, or null if there are none. */
  paramSpan: [number, number] | null;
  ctors: CtorInfo[];
  file: string;
  pos: number;
}

/**
 * Every `data` declaration across all input files. A constructor name is
 * unique within its type but may be shared by several types; patterns then
 * qualify it (`Option.None`) or it is resolved from the rest of the match.
 */
export class Registry {
  readonly types = new Map<string, DataDecl>();
  /** Constructors by bare name. */
  readonly ctors = new Map<string, CtorInfo[]>();

  ctor(type: string, name: string): CtorInfo | undefined {
    return this.types.get(type)?.ctors.find((c) => c.name === name);
  }

  /** True if more than one data type has a constructor with this name. */
  isShared(name: string): boolean {
    return (this.ctors.get(name)?.length ?? 0) > 1;
  }
}

/** A constructor pattern: `Cons(h, t)`, `List.Cons(h, t)` or `Cons { head }`. */
export interface CtorPattern {
  k: "ctor";
  name: string;
  /** The type the user wrote, as in `List.Cons`, or null. */
  qualifier: string | null;
  /** The resolved data type; set before checking and code generation. */
  type: string | null;
  args: Pattern[];
  /** Named-field form, until resolution turns it into `args`. */
  fields: Array<{ name: string; pat: Pattern; pos: number }> | null;
  pos: number;
}

export type Pattern =
  | { k: "wild"; pos: number }
  | { k: "bind"; name: string; sub: Pattern | null; pos: number }
  | { k: "lit"; text: string; pos: number }
  | CtorPattern
  | { k: "or"; alts: Pattern[]; pos: number };

export function showPattern(p: Pattern): string {
  switch (p.k) {
    case "wild":
      return "_";
    case "bind":
      if (!p.sub) return p.name;
      return p.sub.k === "or" ? `${p.name} @ (${showPattern(p.sub)})` : `${p.name} @ ${showPattern(p.sub)}`;
    case "lit":
      return p.text;
    case "ctor":
    {
      const name = p.qualifier ? `${p.qualifier}.${p.name}` : p.name;
      if (p.fields) return `${name} { ${p.fields.map((f) => `${f.name}: ${showPattern(f.pat)}`).join(", ")} }`;
      return p.args.length ? `${name}(${p.args.map(showPattern).join(", ")})` : name;
    }
    case "or":
      return p.alts.map(showPattern).join(" | ");
  }
}

/** Variables bound anywhere in p. */
export function boundNames(p: Pattern, out: string[] = []): string[] {
  switch (p.k) {
    case "bind":
      out.push(p.name);
      if (p.sub) boundNames(p.sub, out);
      break;
    case "ctor":
      for (const a of p.args) boundNames(a, out);
      for (const f of p.fields ?? []) boundNames(f.pat, out);
      break;
    case "or":
      boundNames(p.alts[0], out); // all alternatives bind the same names
      break;
  }
  return out;
}
