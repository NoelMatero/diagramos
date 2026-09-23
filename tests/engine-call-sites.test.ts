/**
 * Enumerating one body's call sites, which is a measurement and not a word (#217).
 *
 * `callsBetween` asks whether a body calls one named far end and reports its
 * doubts per *ask*. `callSitesIn` asks the other question -- what does this body
 * call, all of it -- because that is the one a closed region needs.
 *
 * The point of the exercise: a routine's call sites are syntactically
 * enumerable, but what each one *resolves to* is not. If every call in a body
 * resolves, the set of things it calls is complete, and "this routine does not
 * call that one" stops being silence and becomes refutable from an absence, on
 * the footing a signature stands on.
 *
 * So the direction that must never be wrong is the opposite of the usual one
 * here. Elsewhere the danger is refusing too much; here it is calling a body
 * **closed** when a call in it was never placed, because that is the claim an
 * absence is proof. Every test below is a shape that must leave a body open.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { callSitesIn, EXTERNAL_RECEIVER, type CallSide } from "../src/engine/calls";
import { initEngine, type Language } from "../src/engine/parse";

beforeAll(async () => { await initEngine(); }, 120_000);

/** One file, read for its call sites. Throws on a refusal, so a test says why. */
function sitesIn(
  source: string,
  language: Language = "ts",
  extra: Partial<CallSide> = {},
) {
  const reading = callSitesIn({
    file: "a.ts", source, language, imports: [], ...extra,
  });
  if (!reading.read) throw new Error(`refused: ${reading.why}`);
  return reading.bodies;
}

/** The reasons one routine's unplaced calls gave, in source order. */
function why(source: string, routine: string, language: Language = "ts", extra: Partial<CallSide> = {}) {
  const body = sitesIn(source, language, extra).find((one) => one.routine === routine);
  if (!body) throw new Error(`no body ${routine}`);
  return body.sites.filter((one) => one.why).map((one) => one.why);
}

describe("a body whose every call site the reader can place", () => {
  it("closes when both calls are declared in the same file", () => {
    const body = sitesIn(
      "function helper() {}\n"
      + "function other() {}\n"
      + "function f() {\n  helper();\n  other();\n}\n",
    ).find((one) => one.routine === "f")!;
    expect(body.sites).toHaveLength(2);
    expect(body.sites.every((one) => one.file === "a.ts")).toBe(true);
  });

  it("places a call on `this`, because the member belongs to this file", () => {
    expect(why("class K {\n  run() {\n    this.step();\n  }\n}\n", "run")).toEqual([]);
  });

  it("closes an imported call once the name comes to rest on a file that declares it", () => {
    const sites = sitesIn(
      'import { helper } from "./b";\nfunction f() {\n  helper();\n}\n',
      "ts",
      {
        imports: [{ specifier: "./b", file: "b.ts" }],
        open: () => ({ source: "export function helper() {}\n", language: "ts", imports: [] }),
      },
    ).find((one) => one.routine === "f")!;
    expect(sites.sites.map((one) => one.file)).toEqual(["b.ts"]);
  });
});

describe("a body the reader must leave open", () => {
  it("leaves a receiver call open, because whose method that is is not in the text", () => {
    // The shape the whole measurement turns on: `x.foo()` is the ordinary way
    // code is written and the reader cannot say what it reaches.
    expect(why("function f(x) {\n  x.run();\n}\n", "f")).toEqual(["receiver"]);
  });

  it("leaves a call through an expression receiver open", () => {
    expect(why("function f() {\n  make().run();\n}\n", "f")).toContain("receiver");
  });

  it("leaves a computed callee open, because the name is not in the text", () => {
    expect(why("function f(table, k) {\n  table[k]();\n}\n", "f")).toEqual(["computed"]);
  });

  it("leaves a body open when it can reach a name nowhere in it", () => {
    // Python's whole hazard: `getattr(h, name)()` is how a dispatcher is spelled.
    expect(why("def f(h, name):\n    getattr(h, name)()\n", "f", "python")).toContain("dynamic");
  });

  it("leaves an unbound name open -- a wildcard import, a global, an ambient", () => {
    expect(why("function f() {\n  mystery();\n}\n", "f")).toEqual(["unbound"]);
  });

  it("leaves a name bound twice over open, because the text does not say which wins", () => {
    expect(why(
      'import { helper } from "./b";\nfunction helper() {}\nfunction f() {\n  helper();\n}\n',
      "f",
    )).toEqual(["ambiguous"]);
  });

  it("leaves a call open when the specifier resolved to no file here", () => {
    // A package, usually. Sometimes a workspace alias inside the repository,
    // and the two are indistinguishable -- so it withholds.
    expect(why(
      'import { patch } from "unittest.mock";\nfunction f() {\n  patch();\n}\n',
      "f",
      "ts",
      { imports: [{ specifier: "unittest.mock" }] },
    )).toEqual(["unplaced"]);
  });

  it("leaves a barrel re-export open when the chain runs out of road", () => {
    // The specifier is placed and the declaration is not, which is the
    // difference `comesToRest` exists for. Counting this as placed would make a
    // call set look enumerable when the reader cannot name what is in it.
    expect(why(
      'import { helper } from "./barrel";\nfunction f() {\n  helper();\n}\n',
      "f",
      "ts",
      {
        imports: [{ specifier: "./barrel", file: "barrel.ts" }],
        open: () => ({
          source: 'export * from "./deeper";\n',
          language: "ts",
          imports: [{ specifier: "./deeper" }],
        }),
      },
    )).toEqual(["elsewhere"]);
  });

  it("leaves a body open around a macro, because a call inside one is invisible", () => {
    // Unlike `callsTo`, which raises this only when the name asked after is in
    // the tokens. A body cannot be closed around calls nobody can see.
    const reasons = why("fn f() {\n    println!(\"{}\", g());\n}\n", "f", "rust");
    expect(reasons).toContain("macro");
  });
});

describe("what the enumeration reports about a body", () => {
  it("counts the lines a routine spans, so a closure can be weighed by size", () => {
    const body = sitesIn("function f() {\n  a();\n  b();\n}\n").find((one) => one.routine === "f")!;
    expect(body.lines).toBe(4);
    expect(body.line).toBe(1);
  });

  it("reports a body that calls nothing as having no sites at all", () => {
    // Not interesting, and the measurement has to be able to split these out:
    // a body that closes because it makes no calls proves nothing.
    const body = sitesIn("function f(a, b) {\n  return a + b;\n}\n").find((one) => one.routine === "f")!;
    expect(body.sites).toEqual([]);
  });

  it("leaves out a method signature, which has parameters and no body", () => {
    /*
     * Found by the referee on the first run, and it was not a small error: a
     * signature reads as a routine that makes no calls, so it lands in the
     * trivially-closed column and inflates the number the measurement exists to
     * report. `board-server.ts` declared `setFile` and `close` twice this way --
     * once as the interface's promise and once as the real thing.
     */
    const bodies = sitesIn(
      "interface Server {\n  setFile(path: string): void;\n  close(): void;\n}\n"
      + "function setFile(path) {\n  write(path);\n}\n",
    );
    expect(bodies.map((one) => one.routine)).toEqual(["setFile"]);
    expect(bodies[0]!.sites).toHaveLength(1);
  });

  it("leaves out a Rust trait method that declares no body", () => {
    const bodies = sitesIn(
      "trait Run {\n    fn go(&self);\n}\n"
      + "fn go(x: u8) {\n    step(x);\n}\n",
      "rust",
    );
    expect(bodies.map((one) => one.routine)).toEqual(["go"]);
  });

  it("finds every routine in the file, not just the first", () => {
    const bodies = sitesIn("function a() {}\nfunction b() {}\nfunction c() {}\n");
    expect(bodies.map((one) => one.routine)).toEqual(["a", "b", "c"]);
  });

  it("credits a call inside a nested closure to the routine that encloses it", () => {
    // The same answer the referee gives and the same answer a person would.
    const body = sitesIn("function f(items) {\n  items.map((x) => inner(x));\n}\n")
      .find((one) => one.routine === "f")!;
    expect(body.sites.some((one) => one.name === "inner")).toBe(true);
  });
});

/**
 * `resolveReceiver` (#226): a caller can narrow `receiver` into a real place
 * by naming the type a resolver worked out, from tier 1 (`resolution.ts`) or
 * tier 2 (a real checker) -- `placeOf` never invents a new reason, it only
 * places the name a resolver hands back exactly as it would a bare one.
 */
describe("a receiver placed by a resolver, not by the text", () => {
  it("places a receiver once a resolver names a type declared in this file", () => {
    const source = "class Foo {\n  run() {}\n}\nfunction f(x) {\n  x.run();\n}\n";
    const body = sitesIn(source, "ts", { resolveReceiver: () => ({ kind: "type", name: "Foo" }) })
      .find((one) => one.routine === "f")!;
    expect(body.sites.map((one) => one.file)).toEqual(["a.ts"]);
  });

  it("asks the resolver at the receiver's own byte range, not the whole call", () => {
    const source = "function f(x) {\n  x.run();\n}\n";
    const seen: Array<{ start: number; end: number }> = [];
    sitesIn(source, "ts", {
      resolveReceiver: (at) => { seen.push(at); return undefined; },
    });
    expect(seen).toEqual([{ start: source.indexOf("x.run"), end: source.indexOf("x.run") + 1 }]);
  });

  it("places a receiver once a resolver names an imported type", () => {
    // `Foo` has to be an import *in the source* -- `bindings.imported` reads
    // the text, not `CallSide.imports` (that only resolves a specifier once
    // some name is already known to come from it).
    const body = sitesIn(
      'import { Foo } from "./foo";\nfunction f(x) {\n  x.run();\n}\n',
      "ts",
      {
        imports: [{ specifier: "./foo", file: "foo.ts" }],
        open: () => ({ source: "export class Foo {}\n", language: "ts", imports: [] }),
        resolveReceiver: () => ({ kind: "type", name: "Foo" }),
      },
    ).find((one) => one.routine === "f")!;
    expect(body.sites.map((one) => one.file)).toEqual(["foo.ts"]);
  });

  it("leaves a receiver open when the resolver has nothing to say", () => {
    expect(why("function f(x) {\n  x.run();\n}\n", "f", "ts", { resolveReceiver: () => undefined }))
      .toEqual(["receiver"]);
  });

  it("narrows into `unbound`, not `receiver`, when the resolver names a type nothing here declares or imports", () => {
    // A real narrowing, not a bug: `placeName` treats a resolved type exactly
    // like a bare name, and a name neither declared nor imported has always
    // been `unbound` -- true here too, a global or a type from an untracked
    // import, same as it would be for a value name in that position.
    expect(why("function f(x) {\n  x.run();\n}\n", "f", "ts", {
      resolveReceiver: () => ({ kind: "type", name: "Nowhere" }),
    })).toEqual(["unbound"]);
  });

  it("places even a complex expression receiver, since a resolver reads the expression, not a name", () => {
    // Without a resolver this is the one shape `through` never even has a
    // name for (`through: ""`) -- the whole reason `at` is carried regardless.
    // `make()` is declared too, so the only site left to check is `.run()`'s.
    const source = "class Foo {\n  run() {}\n}\nfunction make() {}\nfunction f() {\n  make().run();\n}\n";
    const body = sitesIn(source, "ts", { resolveReceiver: () => ({ kind: "type", name: "Foo" }) })
      .find((one) => one.routine === "f")!;
    const receiverSite = body.sites.find((one) => one.name === "run")!;
    expect(receiverSite.file).toBe("a.ts");
  });

  it("never lets a resolver override a call the text already placed", () => {
    // `this.step()` is `own`, placed before any resolver is consulted -- a
    // resolver that always answers must not be able to move it.
    const body = sitesIn(
      "class K {\n  run() {\n    this.step();\n  }\n  step() {}\n}\n",
      "ts",
      { resolveReceiver: () => ({ kind: "type", name: "SomewhereElse" }) },
    ).find((one) => one.routine === "run")!;
    expect(body.sites.map((one) => one.file)).toEqual(["a.ts"]);
  });

  it("places a receiver immediately when the resolver knows the type is declared outside the repository", () => {
    // No name match attempted at all -- `external` is placed before
    // `placeName` would ever be consulted, and would stay unbound if it
    // were: nothing here declares or imports a type called "Array".
    expect(why("function f(x) {\n  x.push(1);\n}\n", "f", "ts", {
      resolveReceiver: () => ({ kind: "external" }),
    })).toEqual([]);
  });

  it("places a receiver at the file the resolver names directly, with no name search at all", () => {
    // The shape a name search alone can never close: `x`'s real type
    // (`Thing`, declared in "thing.ts") is never imported by name here --
    // only `make`, the function that produced it, is. `placeName("Thing", ..)`
    // would find nothing in this file's own bindings and refuse; `declared`
    // skips that search because the resolver already knows the file.
    const body = sitesIn(
      'import { make } from "./make";\nfunction f() {\n  const x = make();\n  x.run();\n}\n',
      "ts",
      { resolveReceiver: () => ({ kind: "declared", file: "thing.ts", concrete: true }) },
    ).find((one) => one.routine === "f")!;
    const receiverSite = body.sites.find((one) => one.name === "run")!;
    expect(receiverSite.file).toBe("thing.ts");
  });

  /**
   * Three shapes `placeOf` used to give up on *before* ever consulting a
   * resolver, found re-measuring #221 the morning after: whenever the
   * receiver's own bare name (`x` in `x.foo()`) happened to also match
   * something in `bindings.imported` -- ambiguous, an unresolved specifier,
   * or a re-export chain that ran out of road -- the reader tried to place
   * `x` as a *namespace* first and, on failure, refused outright. A resolver
   * answers the *value* question directly and was never asked. Confirmed at
   * ~880 receiver sites corpus-wide before this fix (`measure:closed-bodies`
   * section 6's own site-for-site count).
   */
  it("falls back to the resolver when the receiver's bare name is itself ambiguous", () => {
    // `x` is both imported and locally declared here -- ambiguous as a
    // *value* name. The resolver, asked at one exact position, has no such
    // doubt.
    const body = sitesIn(
      'import { x } from "./mod";\nfunction x() {}\nclass Foo {\n  run() {}\n}\nfunction f() {\n  x.run();\n}\n',
      "ts",
      { resolveReceiver: () => ({ kind: "type", name: "Foo" }) },
    ).find((one) => one.routine === "f")!;
    expect(body.sites.find((one) => one.name === "run")!.file).toBe("a.ts");
  });

  it("falls back to the resolver when the receiver's bare name is an import that never resolved to a file", () => {
    const body = sitesIn(
      'import { x } from "unittest.mock";\nfunction f() {\n  x.run();\n}\n',
      "ts",
      { imports: [{ specifier: "unittest.mock" }], resolveReceiver: () => ({ kind: "external" }) },
    ).find((one) => one.routine === "f")!;
    expect(body.sites.find((one) => one.name === "run")!.file).toBe("<external-to-repository>");
  });

  it("falls back to the resolver when the receiver's bare name resolves but the re-export chain runs out", () => {
    const body = sitesIn(
      'import { x } from "./barrel";\nfunction f() {\n  x.run();\n}\n',
      "ts",
      {
        imports: [{ specifier: "./barrel", file: "barrel.ts" }],
        open: () => ({
          source: 'export * from "./deeper";\n',
          language: "ts",
          imports: [{ specifier: "./deeper" }],
        }),
        resolveReceiver: () => ({ kind: "declared", file: "thing.ts", concrete: true }),
      },
    ).find((one) => one.routine === "f")!;
    expect(body.sites.find((one) => one.name === "run")!.file).toBe("thing.ts");
  });

  it("carries the method's own byte range for a receiver site, and neither field for a bare call", () => {
    // The range a safety measurement needs to ask a real checker what `run`
    // itself resolves to, independently of how the receiver was placed --
    // not present at all for a call with no receiver to ask about.
    const source = "function helper() {}\nfunction f(x) {\n  helper();\n  x.run();\n}\n";
    const body = sitesIn(source).find((one) => one.routine === "f")!;
    const bare = body.sites.find((one) => one.name === "helper")!;
    const receiver = body.sites.find((one) => one.name === "run")!;
    expect(bare.receiver).toBe(false);
    expect(bare.memberAt).toBeUndefined();
    expect(receiver.receiver).toBe(true);
    expect(receiver.memberAt).toEqual({
      start: source.indexOf("run"), end: source.indexOf("run") + "run".length,
    });
  });
});

/*
 * Where each call's own name is written (#255).
 *
 * `@accesses` stays quiet when a function a body calls reads the member, and
 * finding that function means asking a checker "go to definition" at the
 * call's name. `memberAt` has carried that position for `x.foo()` since #217;
 * a bare `foo()` had none, so #254's measurement found it again with a regex
 * over the line. The tree already holds the node.
 */
describe("the position of a call's own name", () => {
  const nameOf = (source: string, bodies: ReturnType<typeof sitesIn>, index: number) => {
    const site = bodies.flatMap((one) => one.sites)[index]!;
    return site.nameAt ? source.slice(site.nameAt.start, site.nameAt.end) : undefined;
  };

  it("records a bare call's name", () => {
    const source = "function f() {\n  paint();\n}";
    expect(nameOf(source, sitesIn(source), 0)).toBe("paint");
  });

  it("records a method call's name, the same range `memberAt` already has", () => {
    const source = "function f(x: X) {\n  x.paint();\n}";
    const site = sitesIn(source).flatMap((one) => one.sites)[0]!;
    expect(nameOf(source, sitesIn(source), 0)).toBe("paint");
    expect(site.nameAt).toEqual(site.memberAt);
  });

  it("records a call on the routine's own type", () => {
    const source = "class C {\n  f() {\n    this.paint();\n  }\n}";
    expect(nameOf(source, sitesIn(source), 0)).toBe("paint");
  });

  it("records a Python call's name", () => {
    const source = "def f():\n    paint()\n";
    expect(nameOf(source, sitesIn(source, "python"), 0)).toBe("paint");
  });

  it("records nothing for a computed call, which has no name in the text", () => {
    const source = "function f(table: T, k: string) {\n  table[k]();\n}";
    expect(sitesIn(source).flatMap((one) => one.sites)[0]!.nameAt).toBeUndefined();
  });
});

/**
 * The name a call comes to rest under, which is not always the name it was
 * written as (#329).
 *
 * `import { render as r }` and `r()` is a call to `render`, and every grammar
 * here has a form that does this -- TypeScript's `as`, Python's `as`, Rust's
 * `as`, and a re-export that renames on the way through. The reader used to
 * record the name at the call site and throw the other one away, so nothing
 * downstream could tell an aliased call to the right routine from a call to a
 * different routine that happens to live in the same file. Those are opposite
 * answers, and one of them is an accusation.
 */
describe("the name a call is declared under where it comes to rest", () => {
  const declaredAs = (
    source: string,
    language: Language = "ts",
    extra: Partial<CallSide> = {},
  ) => sitesIn(source, language, extra)
    .find((one) => one.routine === "f")!
    .sites.map((one) => one.declaredAs);

  it("reads through a barrel that renames on the way past", () => {
    // `render` here and `paint` there, with a file in between that never
    // declares either. The rename is the barrel's, and a reader that follows
    // the specifier without following the name arrives with the wrong one.
    const files: Record<string, { source: string; language: Language; imports: CallSide["imports"] }> = {
      "barrel.ts": {
        source: 'export { paint as render } from "./b";\n',
        language: "ts",
        imports: [{ specifier: "./b", file: "b.ts" }],
      },
      "b.ts": { source: "export function paint() {}\n", language: "ts", imports: [] },
    };
    expect(declaredAs(
      'import { render } from "./barrel";\nfunction f() {\n  render();\n}\n',
      "ts",
      {
        imports: [{ specifier: "./barrel", file: "barrel.ts" }],
        open: (file) => files[file],
      },
    )).toEqual(["paint"]);
  });

  it("reads through a Rust module that re-exports under another name", () => {
    // `pub use ... as` is Rust's barrel, and it renames with the same clause
    // an ordinary `use` does -- so the walk has to rename at every hop, not
    // only at the one the call site can see.
    const files: Record<string, { source: string; language: Language; imports: CallSide["imports"] }> = {
      "api.rs": {
        source: "pub use crate::b::render as paint;\n",
        language: "rust",
        imports: [{ specifier: "crate::b", file: "b.rs" }, { specifier: "crate::b::render", file: "b.rs" }],
      },
      "b.rs": { source: "pub fn render() {}\n", language: "rust", imports: [] },
    };
    expect(declaredAs(
      "use crate::api::paint;\n\nfn f() {\n    paint();\n}\n",
      "rust",
      {
        imports: [{ specifier: "crate::api", file: "api.rs" }, { specifier: "crate::api::paint", file: "api.rs" }],
        open: (file) => files[file],
      },
    )).toEqual(["render"]);
  });

  it("reads through a Python package that re-exports under another name", () => {
    const files: Record<string, { source: string; language: Language; imports: CallSide["imports"] }> = {
      "pkg/__init__.py": {
        source: "from pkg.b import render as paint\n",
        language: "python",
        imports: [{ specifier: "pkg.b", file: "pkg/b.py" }, { specifier: "pkg.b.render", file: "pkg/b.py" }],
      },
      "pkg/b.py": { source: "def render():\n    pass\n", language: "python", imports: [] },
    };
    expect(declaredAs(
      "from pkg import paint\n\ndef f():\n    paint()\n",
      "python",
      {
        imports: [{ specifier: "pkg", file: "pkg/__init__.py" }, { specifier: "pkg.paint", file: "pkg/__init__.py" }],
        open: (file) => files[file],
      },
    )).toEqual(["render"]);
  });

  it("says nothing about a default import, which the far side never named", () => {
    // `import anything from "./b"` is the importer's own spelling. Reading it
    // as the far side's name would be an invention, and an accusation resting
    // on one is a false accusation.
    expect(declaredAs(
      'import render from "./b";\nfunction f() {\n  render();\n}\n',
      "ts",
      {
        imports: [{ specifier: "./b", file: "b.ts" }],
        open: () => ({ source: "export default function paint() {}\n", language: "ts", imports: [] }),
      },
    )).toEqual([undefined]);
  });

  it("says nothing when the resting file could not be opened", () => {
    expect(declaredAs(
      'import { render } from "./b";\nfunction f() {\n  render();\n}\n',
      "ts",
      { imports: [{ specifier: "./b", file: "b.ts" }] },
    )).toEqual([undefined]);
  });

  it("gives an ordinary call its own name, in every grammar", () => {
    expect(declaredAs("function helper() {}\nfunction f() {\n  helper();\n}\n")).toEqual(["helper"]);
    expect(declaredAs("def helper():\n    pass\n\ndef f():\n    helper()\n", "python")).toEqual(["helper"]);
    expect(declaredAs("fn helper() {}\nfn f() {\n    helper();\n}\n", "rust")).toEqual(["helper"]);
  });

  it("reads through a Rust use alias", () => {
    expect(declaredAs(
      "use crate::b::render as r;\n\nfn f() {\n    r();\n}\n",
      "rust",
      {
        imports: [{ specifier: "crate::b", file: "b.rs" }],
        open: () => ({ source: "pub fn render() {}\n", language: "rust", imports: [] }),
      },
    )).toEqual(["render"]);
  });

  it("reads through a Python import alias", () => {
    expect(declaredAs(
      "from b import render as r\n\ndef f():\n    r()\n",
      "python",
      {
        imports: [{ specifier: "b.render", file: "b.py" }],
        open: () => ({ source: "def render():\n    pass\n", language: "python", imports: [] }),
      },
    )).toEqual(["render"]);
  });

  it("reads through a TypeScript import alias", () => {
    expect(declaredAs(
      'import { render as r } from "./b";\nfunction f() {\n  r();\n}\n',
      "ts",
      {
        imports: [{ specifier: "./b", file: "b.ts" }],
        open: () => ({ source: "export function render() {}\n", language: "ts", imports: [] }),
      },
    )).toEqual(["render"]);
  });
});

/**
 * A call on a name the language itself provides (#337 part C).
 *
 * `isinstance(x, int)` is not a name the file forgot to import. It is Python,
 * and there is no file in any repository it could reach. Reported as `unbound`
 * it read as a gap in the text and left the body open, which is how one
 * built-in stood between a whole body and a verdict: `is_stdlib_dataclass`
 * makes exactly one call, `hasattr`, and nothing else was ever in doubt.
 *
 * Placed outside the repository rather than at any file, so it can close a
 * body and can never be what an arrow reaches.
 *
 * The refusal that keeps it honest: a file carrying a wildcard import may have
 * had the name shadowed by something it brought in, and the text does not say.
 */
describe("a call on a name the language itself provides", () => {
  const placedOutside = (source: string, language: Language) => {
    const body = sitesIn(source, language).find((one) => one.routine === "f")!;
    return body.sites.map((one) => one.file ?? `?${one.why}`);
  };

  it("places a JavaScript global, and leaves an ordinary unbound name open", () => {
    expect(placedOutside("function f(v) {\n  return Number(v);\n}\n", "ts"))
      .toEqual([EXTERNAL_RECEIVER]);
    expect(why("function f() {\n  mystery();\n}\n", "f")).toEqual(["unbound"]);
  });

  it("places a Python built-in, and leaves an ordinary unbound name open", () => {
    expect(placedOutside("def f(v):\n    return isinstance(v, int)\n", "python"))
      .toEqual([EXTERNAL_RECEIVER]);
    expect(why("def f():\n    mystery()\n", "f", "python")).toEqual(["unbound"]);
  });

  it("places a Rust prelude name, and leaves an ordinary unbound name open", () => {
    expect(placedOutside("fn f() -> Result<u8, E> {\n    Ok(1)\n}\n", "rust"))
      .toEqual([EXTERNAL_RECEIVER]);
    expect(why("fn f() {\n    mystery();\n}\n", "f", "rust")).toEqual(["unbound"]);
  });

  it("places a std macro's name, and still leaves the body open on its tokens", () => {
    /*
     * `calleeOf` reads a `macro_invocation` through its `macro` field, so
     * `vec![1]` arrives as the bare name `vec` and is placed like any other
     * prelude name. The body stays open all the same: what is *inside* a
     * macro is loose tokens rather than a tree, and a call written in there
     * is invisible. Both facts, because the first one alone would read as a
     * Rust body that closes and no Rust body with a macro in it does.
     */
    const body = sitesIn("fn f() {\n    let v = vec![1];\n}\n", "rust")
      .find((one) => one.routine === "f")!;
    expect(body.sites.map((one) => one.file ?? `?${one.why}`))
      .toEqual([EXTERNAL_RECEIVER, "?macro"]);
  });

  it("places a global in TSX too, and leaves an ordinary unbound name open", () => {
    expect(placedOutside("function f(v) {\n  return Number(v);\n}\n", "tsx"))
      .toEqual([EXTERNAL_RECEIVER]);
    expect(why("function f() {\n  mystery();\n}\n", "f", "tsx")).toEqual(["unbound"]);
  });

  it("refuses when a wildcard import could have shadowed the name", () => {
    /*
     * `from .shims import *` may well declare a `list` of its own, and which
     * one `list()` means is not in this file. The same doubt `throughWildcards`
     * applies to a name it cannot follow to a unique answer.
     */
    expect(why("from .shims import *\n\n\ndef f(v):\n    return list(v)\n", "f", "python"))
      .toEqual(["unbound"]);
  });
});

/**
 * A call on a name the routine itself holds (#337 part C).
 *
 * `next()` inside vite's `transformMiddleware` is that function's own third
 * parameter. Reported as `unbound` -- "the file never says where this name
 * came from" -- it described a gap in the text that is not there: the file
 * says where it came from, on the line above. Nine of those sites were in one
 * body, and the ranking that #337 was written from counted every one of them
 * as a wildcard import waiting to be followed.
 *
 * The body stays open either way, and that is why this is safe to get wrong
 * in the generous direction: a value handed in is genuinely not in the text,
 * so no verdict moves. What moves is whether the next person reading the
 * ranking is told the truth about what stopped the reader.
 */
describe("a call on a name the routine holds rather than the file", () => {
  it("names a parameter as one, in each grammar", () => {
    expect(why("function f(next) {\n  next();\n}\n", "f")).toEqual(["local-callee"]);
    expect(why("def f(hook):\n    hook()\n", "f", "python")).toEqual(["local-callee"]);
    expect(why("fn f(go: fn()) {\n    go();\n}\n", "f", "rust")).toEqual(["local-callee"]);
    expect(why("function f(Render) {\n  return Render();\n}\n", "f", "tsx")).toEqual(["local-callee"]);
  });

  it("names a value the body binds, where the file reader has not already", () => {
    /*
     * Python and Rust, where a body-local is not something `bindingsIn`
     * collects.
     */
    expect(why("def f():\n    step = pick()\n    step()\n", "f", "python"))
      .toEqual(["unbound", "local-callee"]);
    expect(why("fn f() {\n    let step = pick();\n    step();\n}\n", "f", "rust"))
      .toEqual(["unbound", "local-callee"]);
  });

  it("leaves TypeScript's function-local const where the file reader put it", () => {
    /*
     * Asserted so it is on the record rather than found again later. A `const`
     * inside a function body has a `name` field, so `bindingsIn` counts it
     * among the *file's* declarations and the call is placed at this file --
     * before this reader is ever asked. Python and Rust, whose locals carry no
     * `name` field, get the more careful answer above.
     *
     * Not changed here. Placing it differently would move `@calls` verdicts on
     * every TypeScript board, and nothing in this change has measured that.
     */
    const body = sitesIn("function f() {\n  const step = pick();\n  step();\n}\n")
      .find((one) => one.routine === "f")!;
    expect(body.sites.map((one) => one.file ?? `?${one.why}`)).toEqual(["?unbound", "a.ts"]);
  });

  it("still says unbound for a name nothing in the routine binds", () => {
    // The distinction the whole thing is for: this one really is a name the
    // file never says the origin of, and the ranking should keep saying so.
    expect(why("function f() {\n  mystery();\n}\n", "f")).toEqual(["unbound"]);
  });

  it("does not mistake a parameter's type for a name it binds", () => {
    // Rust writes the type on the same field-shaped node as the binding, and
    // reading the two as one would bind `Mystery` and then place a call on it.
    expect(why("fn f(x: Mystery) {\n    Mystery();\n}\n", "f", "rust")).toEqual(["unbound"]);
  });
});
