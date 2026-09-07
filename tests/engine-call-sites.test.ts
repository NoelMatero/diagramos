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

import { callSitesIn, type CallSide } from "../src/engine/calls";
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
});
