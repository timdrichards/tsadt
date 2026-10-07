# tsadt

**Algebraic data types and pattern matching for TypeScript.**

[![CI](https://github.com/timdrichards/tsadt/actions/workflows/ci.yml/badge.svg)](https://github.com/timdrichards/tsadt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Write `data` types and `match` expressions the way you would in OCaml, Haskell
or Rust. `tsadt` compiles them to ordinary TypeScript (or straight to
JavaScript), checks that every match is exhaustive, and reports type errors
against the lines you wrote.

```ts
data Expr =
  | Num(value: number)
  | Var(name: string)
  | Add(left: Expr, right: Expr)
  | Mul(left: Expr, right: Expr);

function simplify(e: Expr): Expr {
  return match (e) {
    Add(Num(0), x) => simplify(x),
    Mul(Num(1), x) => simplify(x),
    Mul(Num(0), _) => Num(0),
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
  like `Nil` work for every type argument.
- **`match` expressions** with nested constructor patterns, literals,
  wildcards, `x @ pattern` bindings, `if` guards and block bodies. Match
  several values at once with `match (a, b) { (p, q) => ... }`. A `match` is
  an expression, so it nests and composes.
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
data Shape = Circle(radius: number) | Rect(width: number, height: number) | Empty;
export data Option<T> = None | Some(value: T);
export data List<T> = Nil | Cons(head: T, tail: List<T>);
data Pair = Pair(number, string);     // positional fields are named _0, _1
```

Each declaration produces a union type, a constructor function for each
variant with fields, and a constant for each variant without. Constructor
names start with an uppercase letter and must be unique across your files,
because patterns refer to them by name.

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
| `0`, `-1`, `"hi"`                    | a number or string literal                  |
| `true`, `false`, `null`, `undefined` | that value                                  |
| `t @ Cons(_, _)`                     | what the inner pattern matches, also binding `t` |
| `(p, q)`                             | with `match (a, b)`: `a` against `p` and `b` against `q` |

Arms are tried in order. A guard can use the pattern's variables, and a
guarded arm never counts toward exhaustiveness. Booleans and `data` types
are finite; numbers and strings need a catch-all arm.

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

```ts
const describe = (code: number) => match (code) {
  200 => "OK",
  404 => "Not Found",
  c if c >= 500 => `Server error ${c}`,
  _ => "Other",
};
```

### What it compiles to

<details>
<summary>Generated TypeScript for <code>List</code> and a <code>match</code></summary>

```ts
export type List<T> =
  | { readonly tag: "Nil" }
  | { readonly tag: "Cons"; readonly head: T; readonly tail: List<T> };
export const Nil: List<never> = { tag: "Nil" };
export function Cons<T>(head: T, tail: List<T>): List<T> {
  return { tag: "Cons", head, tail };
}

export function last<T>(xs: List<T>): Option<T> {
  return ((__m2) => {
    if (__m2.tag === "Nil") {
      return None;
    }
    if (__m2.tag === "Cons" && __m2.tail.tag === "Nil") {
      const x = __m2.head;
      return Some(x);
    }
    if (__m2.tag === "Cons") {
      const rest = __m2.tail;
      return last(rest);
    }
    throw new Error("match failure at list.tsa:28:10");
  })(xs);
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
3. **Translate.** Only `data` and `match` are parsed. Everything else is
   copied through verbatim. Patterns are checked for exhaustiveness and
   redundancy, then compiled to tag tests and bindings inside an immediately
   invoked arrow function, which keeps `this` and becomes `async` if an arm
   uses `await`.
4. **Map.** Every piece of output remembers the source position it came from,
   so compiler errors can be reported against the `.tsa` file.
5. **Emit.** Optionally, the TypeScript compiler API type checks the result
   in memory and writes JavaScript.

```
src/lexer.ts        tokenizer
src/registry.ts     constructor registry and pattern AST
src/exhaustive.ts   exhaustiveness and redundancy checking
src/transpiler.ts   parsing of data and match, code generation
src/mapped.ts       output text with a map back to source positions
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
  arguments there, like `f<A, B>(x)`, needs its own parentheses. Object literal bodies need
  them too, as with arrow functions: `A => ({ x: 1 })`.
- `yield` inside an arm does not work, and a `match` inside a template
  literal's `${...}` is not translated.
- Runtime stack traces point at the generated `.js`.
- There is no editor support yet, and no `.tsx`.

## Roadmap

See [TODO.md](TODO.md) for the full list. Next up: or-patterns and named-field
patterns.

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
