# tsadt

**Algebraic data types and pattern matching for TypeScript.**

[![CI](https://github.com/timdrichards/tsadt/actions/workflows/ci.yml/badge.svg)](https://github.com/timdrichards/tsadt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Write `data` types, `match` expressions and clause-by-clause functions the way
you would in OCaml, Haskell or Rust. `tsadt` compiles them to ordinary
TypeScript (or straight to JavaScript), checks that every match is
exhaustive, and reports type errors against the lines you wrote.

```ts
data Expr =
  | Num(value: number)
  | Var(name: string)
  | Add(left: Expr, right: Expr)
  | Mul(left: Expr, right: Expr);

function simplify(e: Expr): Expr {
  return match (e) {
    Add(Num(0), x) | Add(x, Num(0)) => simplify(x),
    Mul(Num(1), x) | Mul(x, Num(1)) => simplify(x),
    Mul(Num(0), _) | Mul(_, Num(0)) => Num(0),
    Add(a, b) => Add(simplify(a), simplify(b)),
    Mul(a, b) => Mul(simplify(a), simplify(b)),
    leaf => leaf,
  };
}
```

Leave out the last arm and you find out at compile time, with an example of
what you missed:

```
expr.tsa:8:10: error: Non-exhaustive match: no arm covers Num(_)
```

## Features

- **`data` declarations** with named or positional fields, generics,
  constraints and defaults. Values are immutable, and nullary constructors
  like `Nil` work for every type argument. Qualified constructor names
  (`Shape.Circle`) let types share constructor names.
- **`deriving (Eq, Ord, Show)`** for structural equality, ordering and
  printing, with dictionary passing for type parameters.
- **`match` expressions** with nested constructor patterns, literals,
  wildcards, or-patterns, named-field patterns, `x @ pattern` bindings,
  `if` guards and block bodies. Match several values at once with
  `match (a, b) { (p, q) => ... }`. A `match` is an expression, so it nests
  and composes.
- **Clause functions**, `length(Nil): number => 0` and
  `length(Cons(_, t)) => 1 + length(t)`, with parameter types inferred from
  the patterns.
- **Exhaustiveness and redundancy checking** using Maranget's usefulness
  algorithm, the one OCaml and Rust use. Missing cases are errors with a
  counterexample; unreachable arms are warnings.
- **Precise types for free.** The output is a plain discriminated union, so
  TypeScript's own narrowing gives every pattern variable its exact type.
- **Errors point at your source.** Type errors from `tsc` are mapped back to
  the `.tsa` file, line and column, even when they arise in generated code.
- **TypeScript or JavaScript output**, with or without type checking, from
  one command.
- **Everything else passes through untouched.** Comments, formatting and
  ordinary TypeScript are copied byte for byte. `data` and `match` still work
  as normal identifiers.

## Quick start

Requires Node 20 or newer.

```sh
git clone https://github.com/timdrichards/tsadt.git
cd tsadt
npm install          # also builds dist/
npm link             # optional: puts `tsadt` on your PATH

tsadt examples -o out --js --check
node out/main.js
```

Without `npm link`, use `node dist/cli.js` in place of `tsadt`.

## Command line

```
tsadt [options] <file.tsa | dir>...
```

Directories are searched recursively for `.tsa` files. All inputs share one
constructor registry, so a `match` in one file can use constructors declared
in another; import them as usual (`import { Some } from "./option.js"`).

| Flags          | Writes | Type checks | Use it for                       |
| -------------- | ------ | ----------- | -------------------------------- |
| (none)         | `.ts`  | no          | feeding your existing TS build   |
| `--check`      | `.ts`  | yes         | the same, with errors up front   |
| `--js`         | `.js`  | no          | fast builds and quick runs       |
| `--js --check` | `.js`  | yes         | a complete build; writes nothing if there are errors |

| Option              | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `-o, --outDir <dir>`| Write output under `<dir>`, mirroring the input layout         |
| `--stdout`          | Print the output instead of writing files                      |
| `--tsconfig <file>` | Compiler options for `--js` and `--check` (default: strict, ES2022, NodeNext) |
| `--tag <name>`      | Name of the discriminant field (default `tag`)                 |

The exit code is 1 if there are errors. Errors use the `file:line:col` form
that editors and terminals make clickable:

```
bad.tsa:3:33: error TS2552: Cannot find name 'Strng'. Did you mean 'String'?
bad.tsa:7:20: error TS2339: Property 'length' does not exist on type 'number'.
bad.tsa:9:13: error TS6133: 'h' is declared but its value is never read.
```

With NodeNext, JavaScript output is ESM or CommonJS according to the nearest
`package.json`, as with `tsc`. `--js` compiles only the `.tsa` files you
pass; plain `.ts` files they import are type checked by `--check` but built
by your usual toolchain.

## The language

### Data types

```ts
data Shape = Circle(radius: number) | Square(side: number) | Rect(width: number, height: number) | Empty;
export data Option<T> = None | Some(value: T);
export data List<T> = Nil | Cons(head: T, tail: List<T>);
data Pair = Pair(number, string);     // positional fields are named _0, _1
```

Each declaration produces a union type, a constructor function for each
variant with fields, and a constant for each variant without. Constructor
names start with an uppercase letter. An object named after the type, such
as `Shape`, also holds its constructors and any derived operations; it is
generated when the type is exported or the file uses it (`Shape.Circle`).

Every constructor can also be written qualified by its type, in expressions
and in patterns: `Shape.Circle(1)`, `Option.None`, `List.Cons(h, t)`. That
lets two types share a constructor name:

```ts
data Option<T> = None | Some(value: T);
data Level = None | Low | High;

const volume = (l: Level) => match (l) {
  Level.None => 0,
  Low => 5,
  High => 11,
};

const show = (o: Option<number>) => match (o) {
  Some(v) => `${v}`,
  None => "nothing",       // Option.None: the Some(v) arm settles it
};

volume(Level.None);
show(Option.None);
```

A bare constructor name in a pattern is fine when only one type uses it, or
when the other constructors in the same match settle which type is meant.
Otherwise tsadt asks you to qualify it. In expressions, a name that two types
in the same file share exists only in qualified form.

### Deriving equality, ordering and printing

`===` compares objects by identity, so two separately built `Some(1)` values
are not `===`. Add `deriving` to get structural operations, specialized to the
type and added to its namespace:

```ts
export data Option<T> = None | Some(value: T) deriving (Eq, Ord, Show);
export data List<T> = Nil | Cons(head: T, tail: List<T>) deriving (Eq, Ord, Show);

List.equals(Cons(1, Nil), Cons(1, Nil));        // true
List.compare(Cons(1, Nil), Cons(2, Nil));       // -1
List.show(Cons("a", Cons("b", Nil)));           // 'Cons("a", Cons("b", Nil))'
shapes.sort(Shape.compare);
```

| Class  | Adds                         | Meaning                                                          |
| ------ | ---------------------------- | ---------------------------------------------------------------- |
| `Eq`   | `T.equals(a, b): boolean`    | same constructor and equal fields                                |
| `Ord`  | `T.compare(a, b): number`    | constructors in declaration order, then fields left to right; -1, 0 or 1 |
| `Show` | `T.show(a): string`          | constructor syntax you could paste back into a `.tsa` file       |

Each field is handled according to its declared type. A data type that
derives the same class uses its own operation, arrays go element by element,
and numbers, strings, records and the like use a generic structural
helper. Every data type used in a field must derive the class too, and
tsadt tells you if one does not.

Type parameters work the way Haskell implements type classes: each one
becomes an optional extra argument for the element type's operation. It
defaults to the generic helper, which is fine for numbers and strings; for a
data type, pass its operation:

```ts
List.equals(xs, ys, Option.equals);              // List<Option<number>>
List.compare(xs, ys, Option.compare);
List.show(xs, (o) => Option.show(o, Shape.show)); // List<Option<Shape>>
```

Ordering two different constructors of an unknown element type needs that
comparator, and the generic helper says so if it is missing.

### Matching

```ts
match (value) {
  Pattern => expression,
  Pattern if guard => expression,
  Pattern => { statements; return result; }
}
```

| Pattern                              | Matches                                     |
| ------------------------------------ | ------------------------------------------- |
| `_`                                  | anything                                    |
| `x`                                  | anything, binding it to `x`                 |
| `Some(x)`, `Cons(h, Cons(_, t))`     | a constructor, with nested field patterns   |
| `Option.None`, `List.Cons(h, t)`     | a constructor named with its type           |
| `0`, `-1`, `"hi"`                    | a number or string literal                  |
| `true`, `false`, `null`, `undefined` | that value                                  |
| `t @ Cons(_, _)`                     | what the inner pattern matches, also binding `t` |
| `Rect { width, height: h }`         | a constructor by field name; left-out fields match anything |
| `p \| q`                            | anything `p` or `q` matches; both must bind the same variables |
| `(p, q)`                             | with `match (a, b)`: `a` against `p` and `b` against `q` |

Arms are tried in order. A guard can use the pattern's variables, and a
guarded arm never counts toward exhaustiveness. Booleans and `data` types
are finite; numbers and strings need a catch-all arm.

Fields can also be matched by name, which keeps patterns readable for
constructors with many fields and robust when fields are reordered. A bare
field name binds a variable of the same name, `field: pattern` matches the
field against any pattern, and fields you leave out match anything (write
`..` if you want to say so explicitly):

```ts
const describe = (s: Shape) => match (s) {
  Rect { width: 0 } | Rect { height: 0 } => "flat",
  Rect { width, height } if width === height => `square ${width}`,
  Rect { height: h, .. } => `rectangle of height ${h}`,
  Circle { radius } => `circle ${radius}`,
  _ => "other",
};
```

Or-patterns let one arm handle several shapes. They can appear anywhere in a
pattern, and every alternative must bind the same variables, so the body
can use them whichever alternative matched:

```ts
const corners = (s: Shape) => match (s) {
  Circle(_) | Empty => 0,
  Square(_) | Rect(_, _) => 4,
};

const size = (s: Shape) => match (s) {
  Circle(n) | Square(n) => n,     // n comes from a different field in each
  Rect(w, _) => w,
  Empty => 0,
};

const weekend = (day: string) => match (day) { "Sat" | "Sun" => true, _ => false };
```

`|` binds more loosely than anything else in a pattern, so write
`x @ (A | B)` to name the value matched by either alternative.

To match several values at once, list them in the `match` and give each arm
one pattern per value, in parentheses. `_` on its own matches everything:

```ts
function both(a: Option<number>, b: Option<number>): Option<number> {
  return match (a, b) {
    (Some(x), Some(y)) => Some(x + y),
    _ => None,
  };
}

const fizz = (n: number) => match (n % 3, n % 5) {
  (0, 0) => "FizzBuzz",
  (0, _) => "Fizz",
  (_, 0) => "Buzz",
  _ => String(n),
};
```

Exhaustiveness is checked across all the values together, and a missing case
is reported as a tuple, such as `no arm covers (Some(_), None)`.

`match` works on ordinary values too, with literal patterns and guards:

```ts
const describe = (code: number) => match (code) {
  200 => "OK",
  404 => "Not Found",
  c if c >= 500 => `Server error ${c}`,
  _ => "Other",
};
```

### Clause functions

A function can also be written as a series of equations, one per case, as in
Haskell or ML. Each clause gives a pattern for every parameter; the first
clause that matches runs. Semicolons between clauses are optional.

```ts
export length(Nil): number => 0
length(Cons(_, t)) => 1 + length(t)

head(Cons(x, _)) => Some(x)
head(Nil) => None

fact(0): number => 1
fact(n) if n > 0 => n * fact(n - 1)
fact(_) => 1
```

Each group compiles to one ordinary function whose body is a `match` on its
parameters, so exhaustiveness checking, guards, or-patterns and error mapping
all apply:

```ts
export function length<T>(list: List<T>): number {
  return ((__m0) => { /* ... */ })(list);
}
```

**Types come from the patterns.** A constructor gives the parameter its data
type, generic over the declaration's own type variables (`Cons(...)` gives
`List<T>`). A literal gives `number`, `string` or `boolean`. Parameter names
come from variables the clauses bind there, or from the type.

**Annotate what the patterns cannot tell.** Write `pattern: Type` on a
parameter in any one clause, and `name(...): Type =>` for the return type:

```ts
append(Nil, ys: List<T>): List<T> => ys          // ys is only ever a variable
append(Cons(x, xs), ys) => Cons(x, append(xs, ys))

sum(Nil: List<number>): number => 0               // the body adds the elements
sum(Cons(h, t)) => h + sum(t)
```

You need an annotation in three cases, and tsadt tells you which:

- a parameter that every clause matches with a plain variable or `_`;
- a recursive function's return type (TypeScript cannot infer it and
  reports TS7023);
- a parameter whose type the body narrows, like `sum` above. tsadt infers
  from patterns, not from how the body uses a value.

Type variables in annotations are single capitals (`T`, `U`, `T2`), and
`T` in `List<T>` is the same `T` as in the data declaration, so `append`'s two
lists share an element type. To choose the type variables yourself, write
them on the first clause (`swap<A, B>(...)`), or write a full signature, a
bodiless TypeScript function declaration, just before the clauses:

```ts
function zip<A, B>(xs: List<A>, ys: List<B>): List<[A, B]>;
zip(Cons(x, xt), Cons(y, yt)) => Cons([x, y] as [A, B], zip(xt, yt))
zip(_, _) => Nil
```

Clause functions live at the top level of a file. A clause ends at the end
of its line unless the expression clearly continues (an open bracket, a
trailing operator, or a next line starting with one); a block body
`=> { ... }` works as in `match`. Put `export` on the first clause or the
signature.

### What it compiles to

<details>
<summary>Generated TypeScript for <code>List</code> and a clause function</summary>

From this input:

```ts
export data List<T> = Nil | Cons(head: T, tail: List<T>) deriving (Eq);

export last(Nil): Option<T> => None
last(Cons(x, Nil)) => Some(x)
last(Cons(_, rest)) => last(rest)
```

tsadt produces (the generic `__tsadt_eq` helper, emitted once at the top of
the file, is omitted here):

```ts
export type List<T> =
  | { readonly tag: "Nil" }
  | { readonly tag: "Cons"; readonly head: T; readonly tail: List<T> };
export const Nil: List<never> = { tag: "Nil" };
export function Cons<T>(head: T, tail: List<T>): List<T> {
  return { tag: "Cons", head, tail };
}
function __List_equals<T>(a: List<T>, b: List<T>, eqT: (x: T, y: T) => boolean = __tsadt_eq): boolean {
  if (a.tag !== b.tag) return false;
  if (a.tag === "Nil" && b.tag === "Nil") return true;
  if (a.tag === "Cons" && b.tag === "Cons") return eqT(a.head, b.head) && __List_equals(a.tail, b.tail, eqT);
  return false;
}
export const List = {
  Nil,
  Cons,
  equals: __List_equals,
} as const;
export function last<T>(list: List<T>): Option<T> {
  return ((__m0) => {
    if (__m0.tag === "Nil") {
      return None;
    }
    if (__m0.tag === "Cons" && __m0.tail.tag === "Nil") {
      const x = __m0.head;
      return Some(x);
    }
    if (__m0.tag === "Cons") {
      const rest = __m0.tail;
      return last(rest);
    }
    throw new Error("match failure at list.tsa:4:8");
  })(list);
}
```

Fields are `readonly`, which makes the types covariant: that is why `Nil`
can be a `List<never>` and still serve as a `List<T>` for any `T`.

</details>

## How it works

1. **Lex.** A small tokenizer finds token boundaries in TypeScript source,
   handling strings, template literals, comments and regex literals.
2. **Register.** A first pass over every input collects all `data`
   declarations, so constructors resolve across files.
3. **Translate.** Only the new forms are parsed: `data` declarations (with
   their `deriving` functions), `match` expressions, and top-level clause
   functions, which become a function around a `match`. Everything else is
   copied through verbatim. Constructor names in patterns are resolved to
   their types, then checked for exhaustiveness and redundancy, then
   compiled to tag tests and bindings inside an immediately invoked arrow
   function, which keeps `this` and becomes `async` if an arm uses `await`.
4. **Map.** Every piece of output remembers the source position it came from,
   so compiler errors can be reported against the `.tsa` file.
5. **Emit.** Optionally, the TypeScript compiler API type checks the result
   in memory and writes JavaScript.

```
src/lexer.ts        tokenizer
src/registry.ts     constructor registry and pattern AST
src/exhaustive.ts   exhaustiveness and redundancy checking
src/transpiler.ts   parsing of data, match and clause functions; code generation
src/mapped.ts       output text with a map back to source positions
src/derive.ts       deriving (Eq, Ord, Show)
src/emit.ts         type checking and JavaScript output via the TS compiler API
src/cli.ts          command line driver
examples/           Option, List, an expression language, and a runner
test/               node:test suite; runs tsc --strict on everything it generates
```

There is also a library API in `dist/index.js`: `transpile`,
`collectDataDecls` and `Registry` for translation, `emitFast` and
`checkAndEmit` for JavaScript output.

## Limitations

- An expression arm ends at the first comma outside brackets, so a body like
  `new Map<string, number>()` needs parentheses. Likewise a comma in the
  `match (...)` header separates values, so a call with explicit type
  arguments there, like `f<A, B>(x)`, needs its own parentheses. Object
  literal bodies need them too, as with arrow functions: `A => ({ x: 1 })`.
- `yield` inside an arm does not work, and a `match` inside a template
  literal's `${...}` is not translated.
- Clause functions must be at the top level of a file, and their types are
  inferred from patterns only, so some need annotations (see above).
- Runtime stack traces point at the generated `.js`.
- There is no editor support yet, and no `.tsx`.

## Roadmap

See [TODO.md](TODO.md) for the full list. Next up: a type and a type guard for
each variant (`Shape.Circle`, `isCircle`), then exhaustiveness checking
driven by TypeScript's own types.

## Development

```sh
npm install
npm test     # builds, then runs the test suite
```

The tests transpile every example, type check the output with
`tsc --strict`, run it, and compare the result. They also cover each
diagnostic and the error position mapping.

## License

[MIT](LICENSE)
