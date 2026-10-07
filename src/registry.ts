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
 * Every `data` declaration across all input files. Constructor names must be
 * globally unique: a pattern like `Cons(h, t)` is resolved by name alone.
 */
export class Registry {
  readonly types = new Map<string, DataDecl>();
  readonly ctors = new Map<string, CtorInfo>();
}

export type Pattern =
  | { k: "wild"; pos: number }
  | { k: "bind"; name: string; sub: Pattern | null; pos: number }
  | { k: "lit"; text: string; pos: number }
  | { k: "ctor"; name: string; args: Pattern[]; pos: number };

export function showPattern(p: Pattern): string {
  switch (p.k) {
    case "wild":
      return "_";
    case "bind":
      return p.sub ? `${p.name} @ ${showPattern(p.sub)}` : p.name;
    case "lit":
      return p.text;
    case "ctor":
      return p.args.length ? `${p.name}(${p.args.map(showPattern).join(", ")})` : p.name;
  }
}
