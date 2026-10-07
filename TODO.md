# Roadmap

Check items off as they land. Within each section, items are roughly in
priority order.

## Done

- [x] `data` declarations: named and positional fields, generics with
      constraints and defaults, `export`
- [x] `match` expressions: constructor, literal, wildcard, binding and
      `x @ p` patterns, nested patterns, guards, block bodies
- [x] Exhaustiveness errors with a counterexample; unreachable-arm warnings
- [x] Constructors shared across files in one run
- [x] `async` matches when an arm uses `await`
- [x] `--js` (strip types) and `--js --check` (type check, then emit)
- [x] `--check` for type checking the generated TypeScript
- [x] `--tsconfig` for compiler options
- [x] Type errors reported at `.tsa` line and column
- [x] Match on several values at once: `match (a, b) { (Some(x), Some(y)) => ... }`

## Next up

- [ ] Or-patterns: `Circle(_) | Rect(_, _) => ...`, with the same variables bound in every alternative
- [ ] Named-field patterns: `Rect { width, height: h }`

## Patterns

- [ ] Tuple and array patterns: `[x, y]`, `[first, ...rest]`
- [ ] Type-test patterns for ordinary unions: `n: number`, `e instanceof Error`
- [ ] Destructuring `let`: `let Pair(a, b) = p;`
- [ ] `if let Some(x) = opt { ... }` for when only one case matters
- [ ] Range patterns: `1..=9`

## Data declarations

- [ ] Qualified constructors (`Shape.Circle`), removing the global uniqueness rule
- [ ] `deriving (Eq, Show, Ord)`: structural equality, printing, comparison
- [ ] A type and a type guard for each variant: `Shape.Circle`, `isCircle(s)`
- [ ] Enums: all-nullary types compile to string literal unions (`"Red" | "Green"`)
- [ ] Newtypes: `newtype UserId = UserId(string)` as a zero-cost branded type
- [ ] Variant-preserving update: `p with { radius: 2 }`
- [ ] GADTs: constructors that fix the type parameter, `Lit(n: number): Expr<number>`
- [ ] Existential types

## Checking

- [ ] Type-directed exhaustiveness using the TypeScript checker: finite
      literal unions and TS enums, hand-written or imported discriminated
      unions, and early errors for patterns of the wrong type

## Code generation

- [ ] Decision-tree compilation: a `switch` on the tag that tests each field once
- [ ] Statement-level output without the per-match closure
- [ ] `.js.map` source maps that lead back to `.tsa`, so runtime stack traces do too
- [ ] `yield` inside match arms (generator functions)

## Tooling

- [ ] Editor support: TypeScript language-service plugin or VS Code extension
      (Volar.js) with errors, hover types and go-to-definition in `.tsa` files
- [ ] Syntax highlighting grammar for `.tsa`
- [ ] `--watch` mode
- [ ] Vite and esbuild plugins so projects can import `.tsa` directly
- [ ] `.tsx` support
- [ ] Publish to npm

## Parsing

- [ ] Allow commas at the top level of an arm body (`new Map<string, number>()`)
- [ ] Translate `match` inside template literal `${...}` substitutions
