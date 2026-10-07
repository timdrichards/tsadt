import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { transpile, collectDataDecls, Registry } from "../dist/index.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tsc = path.join(root, "node_modules", ".bin", "tsc");
const tscArgs = ["--strict", "--noUnusedLocals", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck"];

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tsadt-"));

function ok(src) {
  const r = transpile(src, "t.tsa");
  const errors = r.diagnostics.filter((d) => d.severity === "error");
  assert.deepEqual(errors, [], "unexpected errors");
  return r;
}

function errorsOf(src) {
  return transpile(src, "t.tsa").diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
}

/** Transpiles, typechecks with tsc --strict, runs, returns stdout. */
function run(src) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "m.ts"), ok(src).code + "\nexport {};\n");
  const r = spawnSync(tsc, [...tscArgs, "--outDir", dir, path.join(dir, "m.ts")], { encoding: "utf8" });
  assert.equal(r.status, 0, "tsc failed:\n" + r.stdout);
  return execFileSync("node", [path.join(dir, "m.js")], { encoding: "utf8" });
}

/** Transpiles and returns tsc's error output (expects a type error). */
function typeErrors(src) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "m.ts"), ok(src).code + "\nexport {};\n");
  const r = spawnSync(tsc, [...tscArgs, "--noEmit", path.join(dir, "m.ts")], { encoding: "utf8" });
  assert.notEqual(r.status, 0, "expected tsc to report an error");
  return r.stdout;
}

const LIST = `data List<T> = Nil | Cons(head: T, tail: List<T>);\n`;

// ------------------------------------------------------------- end to end

test("examples compile, typecheck under --strict, and run", () => {
  const out = tmp();
  execFileSync("node", [path.join(root, "dist/cli.js"), path.join(root, "examples"), "-o", out], { stdio: "pipe" });
  const files = fs.readdirSync(out).filter((f) => f.endsWith(".ts")).map((f) => path.join(out, f));
  const r = spawnSync(tsc, [...tscArgs.filter((a) => a !== "--noUnusedLocals"), "--outDir", path.join(out, "js"), ...files], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
  const stdout = execFileSync("node", [path.join(out, "js", "main.js")], { encoding: "utf8" });
  assert.equal(stdout, fs.readFileSync(path.join(root, "test", "expected-main.txt"), "utf8"));
});

test("data generates a discriminated union and constructors", () => {
  const { code } = ok(`export data Shape = Circle(r: number) | Rect(w: number, h: number) | Dot;`);
  assert.match(code, /export type Shape =/);
  assert.match(code, /\| \{ readonly tag: "Circle"; readonly r: number \}/);
  assert.match(code, /export function Rect\(w: number, h: number\): Shape/);
  assert.match(code, /export const Dot: Shape = \{ tag: "Dot" \};/);
});

test("unnamed fields get positional names", () => {
  const out = run(`data P = Pair(number, string);
    const p = Pair(1, "a");
    console.log(p._0, p._1, match (p) { Pair(n, s) => s + n });`);
  assert.equal(out, "1 a a1\n");
});

test("generic nullary constructors fit every instantiation", () => {
  const out = run(LIST + `
    const a: List<string> = Nil;
    const b = Cons(1, Cons(2, Nil));
    const len = <T,>(xs: List<T>): number => match (xs) { Nil => 0, Cons(_, t) => 1 + len(t) };
    console.log(len(a), len(b));`);
  assert.equal(out, "0 2\n");
});

test("custom discriminant field", () => {
  const r = transpile(`data T = A | B(x: number); const f = (t: T) => match (t) { A => 0, B(x) => x };`, "t.tsa", undefined, { tagField: "kind" });
  assert.match(r.code, /readonly kind: "A"/);
  assert.match(r.code, /\.kind === "B"/);
});

// ----------------------------------------------------------------- typing

test("bound variables get precise types", () => {
  const msg = typeErrors(LIST + `const s: string = match (Cons(1, Nil)) { Cons(h, _) => h, Nil => "" };`);
  assert.match(msg, /Type 'number \| ""' is not assignable to type 'string'/);
});

test("constructors are type checked", () => {
  const msg = typeErrors(`data Shape = Circle(r: number); Circle("big");`);
  assert.match(msg, /not assignable to parameter of type 'number'/);
});

// ------------------------------------------------------- exhaustiveness

test("missing constructor is reported with an example", () => {
  assert.deepEqual(errorsOf(LIST + `const f = (xs: List<number>) => match (xs) { Nil => 0 };`), [
    "Non-exhaustive match: no arm covers Cons(_, _)",
  ]);
});

test("nested gaps are found", () => {
  const errs = errorsOf(LIST + `const f = (xs: List<number>) => match (xs) {
    Nil => 0, Cons(_, Nil) => 1, Cons(_, Cons(_, Cons(_, _))) => 3 };`);
  assert.deepEqual(errs, ["Non-exhaustive match: no arm covers Cons(_, Cons(_, Nil))"]);
});

test("guarded arms do not count toward coverage", () => {
  const errs = errorsOf(`data O = N | S(v: number);
    const f = (o: O) => match (o) { N => 0, S(v) if v > 0 => v };`);
  assert.deepEqual(errs, ["Non-exhaustive match: no arm covers S(_)"]);
});

test("numbers need a catch-all; booleans do not", () => {
  assert.deepEqual(errorsOf(`const f = (n: number) => match (n) { 0 => "z", 1 => "o" };`), [
    "Non-exhaustive match: no arm covers _",
  ]);
  assert.deepEqual(errorsOf(`const f = (b: boolean) => match (b) { true => 1 };`), [
    "Non-exhaustive match: no arm covers false",
  ]);
  assert.deepEqual(errorsOf(`const f = (b: boolean) => match (b) { true => 1, false => 0 };`), []);
});

test("unreachable arms are warned about and removed", () => {
  const r = transpile(LIST + `const f = (xs: List<number>) => match (xs) {
    Cons(h, _) => h, Nil => 0, Cons(_, Nil) => 2, _ => 3 };`, "t.tsa");
  const warnings = r.diagnostics.filter((d) => d.severity === "warning").map((d) => d.message);
  assert.deepEqual(warnings, [
    "Unreachable match arm 'Cons(_, Nil)' (removed from output)",
    "Unreachable match arm '_' (removed from output)",
  ]);
  assert.doesNotMatch(r.code, /return 2/);
});

// ------------------------------------------------------- pattern features

test("literals, guards, as-patterns and nested matches run correctly", () => {
  const out = run(LIST + `
    data Tok = Word(text: string) | Int(value: number);
    const describe = (t: Tok): string => match (t) {
      Word("hi") => "greeting",
      Word(w) if w.length > 3 => "long word",
      Word(_) => "word",
      Int(-1) => "minus one",
      Int(n) => match (n % 2) { 0 => "even", _ => "odd" },
    };
    const firstTwo = (xs: List<Tok>): string => match (xs) {
      Cons(a, rest @ Cons(b, _)) => describe(a) + "/" + describe(b) + "/" + (rest === xs ? "same" : "tail"),
      _ => "short",
    };
    console.log([Word("hi"), Word("hello"), Word("yo"), Int(-1), Int(4), Int(7)].map(describe).join(","));
    console.log(firstTwo(Cons(Word("hi"), Cons(Int(3), Nil))), firstTwo(Nil));`);
  assert.equal(out, "greeting,long word,word,minus one,even,odd\ngreeting/odd/tail short\n");
});

test("block bodies and statement position", () => {
  const out = run(`data R = Ok(v: number) | Err(msg: string);
    function handle(r: R): void {
      match (r) {
        Ok(v) => { console.log("ok", v); }
        Err(m) => { console.log("err", m); }
      }
    }
    handle(Ok(1)); handle(Err("bad"))
    match (Ok(2)) { Ok(v) => console.log(v), Err(_) => 0 };`);
  assert.equal(out, "ok 1\nerr bad\n2\n");
});

test("await inside an arm makes the match async", () => {
  const out = run(`data J = Fetch(n: number) | Done;
    const slow = (n: number) => new Promise<number>((res) => setTimeout(() => res(n * 2), 1));
    async function go(j: J) { return match (j) { Fetch(n) => await slow(n), Done => 0 }; }
    go(Fetch(21)).then(console.log); void Done;`);
  assert.equal(out, "42\n");
});

test("this and arguments refer to the enclosing function", () => {
  const out = run(`data B = Y | N;
    class C { k = 7; get(b: B) { return match (b) { Y => this.k, N => -this.k }; } }
    console.log(new C().get(Y), new C().get(N));`);
  assert.equal(out, "7 -7\n");
});

// ------------------------------------------------- leave other code alone

test("data and match as ordinary identifiers, strings, comments and regexes", () => {
  const src = `const data = { match: 1 };
const match = (x: number) => x;
const s = "match (a) { b }"; // match (c) { d }
/* data X = A | B; */
const re = /match (x) {/;
const t = \`data Y = \${data.match} | match (z) {\`;
obj.match(re).data;
`;
  assert.equal(transpile(src, "t.tsa").code, src);
});

test("output is plain TS for files with no new syntax", () => {
  const src = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
  assert.equal(ok(src).code, src);
});

// ------------------------------------------------------------ diagnostics

test("helpful errors", () => {
  assert.deepEqual(errorsOf(`const f = (x: any) => match (x) { Foo(a) => a };`), [
    "Unknown constructor 'Foo'. Is its data declaration in one of the input files?",
  ]);
  assert.deepEqual(errorsOf(LIST + `const f = (x: List<number>) => match (x) { Cons(a) => a, Nil => 0 };`), [
    "Cons has 2 field(s) but the pattern gives 1",
  ]);
  assert.deepEqual(errorsOf(LIST + `const f = (x: List<number>) => match (x) { Cons(a, a) => a, Nil => 0 };`), [
    "Variable 'a' is bound twice in one pattern",
  ]);
  assert.deepEqual(errorsOf(`data A = X | Y; data B = Y | Z;`), [
    "Constructor 'Y' is already used by data type 'A'. Constructor names must be unique.",
  ]);
  assert.deepEqual(errorsOf(`data A = X(tag: string);`), ["Field name 'tag' is reserved for the discriminant"]);
});

test("diagnostics carry line and column", () => {
  const d = transpile(LIST + "\nconst f = (x: List<number>) =>\n  match (x) { Nil => 0 };", "file.tsa").diagnostics[0];
  assert.equal(`${d.file}:${d.line}:${d.col}`, "file.tsa:4:3");
});

test("a shared registry resolves constructors across files", () => {
  const reg = new Registry();
  const a = "export data Color = Red | Green | Blue;";
  const b = `import { Color } from "./a.js";\nexport const name = (c: Color) => match (c) { Red => "r", Green => "g", Blue => "b" };`;
  collectDataDecls(a, "a.tsa", reg);
  collectDataDecls(b, "b.tsa", reg);
  const r = transpile(b, "b.tsa", reg);
  assert.deepEqual(r.diagnostics, []);
  assert.match(r.code, /__m0\.tag === "Blue"/);
});

// ------------------------------------------------------- JavaScript output

const cli = (...args) => spawnSync("node", [path.join(root, "dist/cli.js"), ...args], { encoding: "utf8" });
const expectedMain = () => fs.readFileSync(path.join(root, "test", "expected-main.txt"), "utf8");

for (const mode of [["--js"], ["--js", "--check"]]) {
  test(`${mode.join(" ")} compiles the examples straight to runnable JavaScript`, () => {
    const out = tmp();
    const r = cli(path.join(root, "examples"), ...mode, "-o", out);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(out).sort(), ["expr.js", "list.js", "main.js", "option.js"]);
    assert.match(fs.readFileSync(path.join(out, "list.js"), "utf8"), /^\/\/ Generated by tsadt from list\.tsa/);
    fs.writeFileSync(path.join(out, "package.json"), '{"type":"module"}');
    assert.equal(execFileSync("node", [path.join(out, "main.js")], { encoding: "utf8" }), expectedMain());
  });
}

test("--js --check reports type errors against the .tsa file and writes nothing", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "bad.tsa"), `data S = C(r: number);\nconst s: string = match (C(1)) { C(r) => r };\nconsole.log(s);\n`);
  const r = cli(dir, "--js", "--check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bad\.tsa:2:7: error TS2322: Type 'number' is not assignable to type 'string'/);
  assert.deepEqual(fs.readdirSync(dir), ["bad.tsa"]);
});

test("--js without --check skips type checking", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "bad.tsa"), `data S = C(r: number);\nconst s: string = match (C(1)) { C(r) => r };\n`);
  const r = cli(dir, "--js");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dir, "bad.js")));
});

test("--check alone writes .ts and type checks it", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "bad.tsa"), `const n: number = match ("x") { _ => "y" };\n`);
  const r = cli(dir, "--check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TS2322/);
  assert.ok(fs.existsSync(path.join(dir, "bad.ts")));
});

test("--tsconfig controls the JavaScript output", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "tsconfig.json"), '{"compilerOptions":{"module":"commonjs","target":"ES2017","strict":true}}');
  fs.writeFileSync(path.join(dir, "a.tsa"), `export data T = A | B(n: number);\nexport const f = (t: T) => match (t) { A => 0, B(n) => n };\n`);
  const r = cli(path.join(dir, "a.tsa"), "--js", "--check", "--tsconfig", path.join(dir, "tsconfig.json"));
  assert.equal(r.status, 0, r.stderr);
  const js = fs.readFileSync(path.join(dir, "a.js"), "utf8");
  assert.match(js, /exports\.f =/);
  assert.equal(createRequire(import.meta.url)(path.join(dir, "a.js")).f({ tag: "B", n: 5 }), 5);
});

test("type errors point at the exact .tsa line and column", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "tsconfig.json"), '{"compilerOptions":{"strict":true,"noUnusedLocals":true,"target":"ES2022","module":"NodeNext"}}');
  fs.writeFileSync(path.join(dir, "bad.tsa"), [
    /* 1 */ "export data Shape =",
    /* 2 */ "  | Circle(radius: number)",
    /* 3 */ "  | Rect(width: number, height: Strng);",
    /* 4 */ "",
    /* 5 */ "export function area(sh: Shape): number {",
    /* 6 */ "  return match (sh) {",
    /* 7 */ "    Circle(r) if r.length > 0 => 0,",
    /* 8 */ "    Circle(r) => Math.PI * r * r,",
    /* 9 */ "    Rect(w, h) => w.toFixed(1),",
    /* 10 */ "  };",
    /* 11 */ "}",
  ].join("\n"));
  const r = cli(path.join(dir, "bad.tsa"), "--check", "--tsconfig", path.join(dir, "tsconfig.json"));
  const lines = r.stderr.split("\n").filter((l) => /^\S+\.tsa:\d+:\d+: error/.test(l)).map((l) => l.replace(/^.*?bad\.tsa:/, ""));
  assert.deepEqual(lines, [
    "3:33: error TS2552: Cannot find name 'Strng'. Did you mean 'String'?", // field type, reported once
    "6:3: error TS2322: Type 'string | number' is not assignable to type 'number'.", // the return statement
    "7:20: error TS2339: Property 'length' does not exist on type 'number'.", // inside the guard
    "9:13: error TS6133: 'h' is declared but its value is never read.", // the unused pattern variable
  ]);
});

test("the library API maps generated offsets back to source positions", () => {
  const src = "data T = A | B(n: number);\nconst f = (t: T) => match (t) { A => 0, B(n) => n + 1 };\n";
  const r = ok(src);
  const at = (needle) => r.sourcePosition(r.code.indexOf(needle));
  assert.deepEqual(at("n + 1"), { line: 2, col: 49 }); // copied: exact
  assert.deepEqual(at('.tag === "B"'), { line: 2, col: 41 }); // generated: the B(n) pattern
  assert.deepEqual(at("const n ="), { line: 2, col: 43 }); // generated: the n binding
});

// ------------------------------------------------------ multi-value match

const OPT = `data Opt<T> = None | Some(value: T);\n`;

test("matching several values at once", () => {
  const out = run(OPT + LIST + `
    const add = (a: Opt<number>, b: Opt<number>): Opt<number> => match (a, b) {
      (Some(x), Some(y)) => Some(x + y),
      (Some(x), None) => Some(x),
      (None, y) => y,
    };
    const show = (o: Opt<number>) => match (o) { Some(v) => String(v), None => "none" };
    console.log(show(add(Some(1), Some(2))), show(add(Some(5), None)), show(add(None, Some(7))), show(add(None, None)));

    // zip two lists; three values, with a literal in the mix
    const zip = <A, B>(xs: List<A>, ys: List<B>): List<[A, B]> => match (xs, ys) {
      (Cons(x, xt), Cons(y, yt)) => Cons([x, y] as [A, B], zip(xt, yt)),
      _ => Nil,
    };
    const len = <T,>(l: List<T>): number => match (l) { Nil => 0, Cons(_, t) => 1 + len(t) };
    console.log(len(zip(Cons(1, Cons(2, Cons(3, Nil))), Cons("a", Cons("b", Nil)))));

    const fizz = (n: number) => match (n % 3, n % 5) {
      (0, 0) => "FizzBuzz",
      (0, _) => "Fizz",
      (_, 0) => "Buzz",
      _ => String(n),
    };
    console.log([1, 3, 5, 15].map(fizz).join(" "));

    // booleans are finite, so this is exhaustive with no catch-all
    const quadrant = (x: number, y: number) => match (x >= 0, y >= 0) {
      (true, true) => 1, (false, true) => 2, (false, false) => 3, (true, false) => 4,
    };
    console.log(quadrant(1, 1), quadrant(-1, 1), quadrant(-1, -1), quadrant(1, -1));`);
  assert.equal(out, "3 5 7 none\n2\n1 Fizz Buzz FizzBuzz\n1 2 3 4\n");
});

test("exhaustiveness across several values names the missing combination", () => {
  assert.deepEqual(errorsOf(OPT + `const f = (a: Opt<number>, b: Opt<number>) => match (a, b) {
    (Some(_), Some(_)) => 1, (None, _) => 2 };`), ["Non-exhaustive match: no arm covers (Some(_), None)"]);
  assert.deepEqual(errorsOf(`const f = (p: boolean, q: boolean) => match (p, q) {
    (true, _) => 1, (false, true) => 2 };`), ["Non-exhaustive match: no arm covers (false, false)"]);
});

test("unreachable tuple arms are reported", () => {
  const r = transpile(OPT + `const f = (a: Opt<number>, b: Opt<number>) => match (a, b) {
    (Some(_), _) => 1, (None, _) => 2, (Some(x), Some(_)) => x };`, "t.tsa");
  assert.deepEqual(r.diagnostics.map((d) => d.message), ["Unreachable match arm '(Some(x), Some(_))' (removed from output)"]);
});

test("tuple pattern errors", () => {
  assert.deepEqual(errorsOf(OPT + `const f = (a: Opt<number>, b: Opt<number>) => match (a, b) { (Some(x)) => x, _ => 0 };`), [
    "This match is on 2 values, but the pattern has 1",
  ]);
  assert.deepEqual(errorsOf(OPT + `const f = (a: Opt<number>, b: Opt<number>) => match (a, b) { pair => 0 };`), [
    "This match is on 2 values, so each arm needs 2 patterns in parentheses, like (_, _), or _ for anything",
  ]);
  assert.deepEqual(errorsOf(OPT + `const f = (a: Opt<number>, b: Opt<number>) => match (a, b) { (Some(x), Some(x)) => x, _ => 0 };`), [
    "Variable 'x' is bound twice in one pattern",
  ]);
});

test("one value: parentheses group; double parentheses keep a comma expression", () => {
  const out = run(OPT + `
    const g = (o: Opt<number>) => match (o) { (Some(v)) => v, (None) => 0 };
    let calls = 0;
    const h = match ((calls++, Some(4))) { Some(v) => v, None => 0 };
    console.log(g(Some(2)), g(None), h, calls);`);
  assert.equal(out, "2 0 4 1\n");
});

// ------------------------------------------------------------- or-patterns

const SHAPE = `export data Shape = Circle(r: number) | Square(side: number) | Rect(w: number, h: number) | Dot;\n`;

test("or-patterns: top-level, nested, with bindings, and across several values", () => {
  const out = run(SHAPE + LIST + `
    const corners = (s: Shape) => match (s) { Circle(_) | Dot => 0, Square(_) | Rect(_, _) => 4 };
    const size = (s: Shape) => match (s) { Circle(n) | Square(n) => n, Rect(w, _) => w, Dot => 0 };
    const weekend = (d: string) => match (d) { "Sat" | "Sun" => true, _ => false };
    const sameKind = (a: Shape, b: Shape) => match (a, b) {
      (Circle(_), Circle(_)) | (Dot, Dot) => true,
      (Square(_) | Rect(_, _), Square(_) | Rect(_, _)) => true,
      _ => false,
    };
    // nested or-pattern that binds: expands into one test per alternative
    const firstSize = (xs: List<Shape>) => match (xs) {
      Cons(Circle(n) | Square(n), _) => n,
      Cons(x @ (Rect(_, _) | Dot), _) => corners(x),
      Nil => -1,
    };
    console.log(corners(Circle(1)), corners(Rect(1, 2)), size(Square(3)), size(Circle(5)), weekend("Sun"), weekend("Mon"));
    console.log(sameKind(Square(1), Rect(1, 2)), sameKind(Dot, Dot), sameKind(Dot, Circle(1)));
    console.log(firstSize(Cons(Square(7), Nil)), firstSize(Cons(Dot, Nil)), firstSize(Cons(Rect(1, 1), Nil)), firstSize(Nil));`);
  assert.equal(out, "0 4 3 5 true false\ntrue true false\n7 0 4 -1\n");
});

test("or-patterns that bind nothing compile to one test", () => {
  const { code } = ok(SHAPE + `const f = (s: Shape) => match (s) { Circle(_) | Dot => 0, _ => 1 };`);
  assert.match(code, /if \(__m0\.tag === "Circle" \|\| __m0\.tag === "Dot"\)/);
});

test("exhaustiveness sees through or-patterns", () => {
  assert.deepEqual(errorsOf(SHAPE + `const f = (s: Shape) => match (s) { Circle(_) | Dot => 0, Square(_) => 4 };`), [
    "Non-exhaustive match: no arm covers Rect(_, _)",
  ]);
  assert.deepEqual(errorsOf(SHAPE + `const f = (s: Shape) => match (s) { Circle(_) | Dot | Square(_) | Rect(_, _) => 0 };`), []);
  assert.deepEqual(errorsOf(`const f = (b: boolean) => match (b) { true | false => 1 };`), []);
  assert.deepEqual(errorsOf(LIST + `const f = (xs: List<boolean>) => match (xs) { Nil => 0, Cons(true | false, Nil) => 1 };`), [
    "Non-exhaustive match: no arm covers Cons(true, Cons(_, _))",
  ]);
});

test("unreachable alternatives are reported and removed", () => {
  const r = transpile(SHAPE + `const f = (s: Shape) => match (s) {
    Circle(_) | Dot => 0, Dot | Square(_) => 1, Circle(_) | Dot => 2, _ => 3 };`, "t.tsa");
  assert.deepEqual(r.diagnostics.map((d) => d.message), [
    "Unreachable match arm 'Circle(_) | Dot' (removed from output)",
    "Unreachable alternative 'Dot' in or-pattern (removed from output)",
  ]);
  assert.match(r.code, /if \(__m0\.tag === "Square"\) \{\n\s+return 1;/);
  run(SHAPE + `const f = (s: Shape) => match (s) { Circle(_) | Dot => 0, Dot | Square(_) => 1, _ => 3 }; console.log(f(Dot));`);
});

test("every alternative must bind the same variables", () => {
  assert.deepEqual(errorsOf(SHAPE + `const f = (s: Shape) => match (s) { Circle(n) | Square(m) => 0, _ => 1 };`), [
    "Every alternative of an or-pattern must bind the same variables: 'n' is bound in 'Circle(n)' but not in 'Square(m)'",
  ]);
  assert.deepEqual(errorsOf(SHAPE + `const f = (s: Shape) => match (s) { Circle(_) | Square(m) => 0, _ => 1 };`), [
    "Every alternative of an or-pattern must bind the same variables: 'm' is bound in 'Square(m)' but not in 'Circle(_)'",
  ]);
  // `x @ A | B` is `(x @ A) | B`, as in Rust
  assert.deepEqual(errorsOf(SHAPE + `const f = (s: Shape) => match (s) { x @ Circle(_) | Dot => 0, _ => 1 };`), [
    "Every alternative of an or-pattern must bind the same variables: 'x' is bound in 'x @ Circle(_)' but not in 'Dot'",
  ]);
});

// ------------------------------------------------------ named-field patterns

const REC = `export data Shape = Circle(radius: number) | Rect(width: number, height: number) | Dot;\n`;

test("named-field patterns: shorthand, renaming, literals, omitted fields, nesting", () => {
  const out = run(REC + LIST + `
    const describe = (s: Shape) => match (s) {
      Rect { width: 0 } | Rect { height: 0 } => "flat",
      Rect { width, height } if width === height => "square " + width,
      Rect { height: h, .. } => "tall " + h,
      Circle { radius } => "circle " + radius,
      Dot {} => "dot",
    };
    const head = (xs: List<Shape>) => match (xs) { Cons { head: Circle { radius: r } } => r, _ => -1 };
    console.log([Rect(0, 3), Rect(2, 2), Rect(2, 5), Circle(1), Dot].map(describe).join(", "));
    console.log(head(Cons(Circle(9), Nil)), head(Cons(Dot, Nil)), head(Nil));`);
  assert.equal(out, "flat, square 2, tall 5, circle 1, dot\n9 -1 -1\n");
});

test("named-field patterns work with exhaustiveness checking", () => {
  assert.deepEqual(errorsOf(REC + `const f = (s: Shape) => match (s) { Circle {} => 0, Rect { width: 0 } => 1, Dot => 2 };`), [
    "Non-exhaustive match: no arm covers Rect(_, _)",
  ]);
  assert.deepEqual(errorsOf(REC + `const f = (s: Shape) => match (s) { Circle { .. } => 0, Rect { } => 1, Dot => 2 };`), []);
});

test("named-field pattern errors", () => {
  assert.deepEqual(errorsOf(REC + `const f = (s: Shape) => match (s) { Rect { depth } => 0, _ => 1 };`), [
    "Rect has no field 'depth' (fields: width, height)",
  ]);
  assert.deepEqual(errorsOf(REC + `const f = (s: Shape) => match (s) { Rect { width, width: w } => 0, _ => 1 };`), [
    "Field 'width' appears twice in this pattern",
  ]);
  assert.deepEqual(errorsOf(REC + `const f = (s: Shape) => match (s) { Rect { width: radius, radius } => 0, _ => 1 };`), [
    "Rect has no field 'radius' (fields: width, height)",
  ]);
});
