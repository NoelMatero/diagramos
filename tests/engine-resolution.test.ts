/**
 * The receiver-type reader (#227): what `x` in `x.foo()` can be worked out to
 * be from the text alone, before anything is built on the answer.
 *
 * A measurement's reader, not a claim's -- see `src/engine/resolution.ts`'s
 * module doc. Nothing here refutes anything, so the tests that matter most are
 * not the refusals `holds.ts`/`calls.ts` are built around; they are whether
 * each shape in #227's table is actually read, and whether a plainly
 * unresolvable receiver comes back withheld with the right name rather than
 * silently missing from the report.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import {
  resolveReceiversIn, shapeDisagreementsIn,
  type ResolutionReading, type ResolutionVerdict,
} from "../src/engine/resolution";

beforeAll(async () => { await initEngine(); }, 120_000);

/** The verdict as one word, so a test reads as the sentence it is checking. */
function verdictOf(verdict: ResolutionVerdict): string {
  if (verdict.verdict === "withheld") return `withheld/${verdict.why}`;
  return `resolved/${verdict.evidence.shape}/${verdict.evidence.type}`;
}

/** Every receiver site across every routine, flattened for a small fixture. */
function sitesOf(reading: ResolutionReading) {
  if (!reading.read) throw new Error(`unreadable: ${reading.why}`);
  return reading.routines.flatMap((routine) => routine.sites);
}

/** The one site a small fixture is expected to carry. */
function onlySite(reading: ResolutionReading) {
  const sites = sitesOf(reading);
  expect(sites).toHaveLength(1);
  return sites[0]!;
}

describe("construction -- `new Foo()` cannot be anything else", () => {
  it("resolves a TypeScript constructed local", () => {
    const source = "function f() {\n  const x = new Config();\n  x.run();\n}";
    const site = onlySite(resolveReceiversIn(source, "ts"));
    expect(verdictOf(site.verdict)).toBe("resolved/construction/Config");
    if (site.verdict.verdict === "resolved") expect(site.verdict.evidence.line).toBe(2);
  });

  it("resolves the same shape in JavaScript", () => {
    const source = "function f() {\n  const x = new Config();\n  x.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "js")).verdict)).toBe("resolved/construction/Config");
  });
});

describe("rust constructor -- `Foo::new()`, the same shape spelled Rust's way", () => {
  it("resolves it, and only that one associated function name", () => {
    const source = "fn f() {\n    let x = Config::new();\n    x.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/rust-constructor/Config");
  });

  it("does not trust an arbitrary associated function the way it trusts `new`", () => {
    // `Path::new` famously does not return `Path` in the standard library --
    // the module doc's whole reason `::new()` alone is treated as evidence.
    const source = "fn f() {\n    let x = Config::from(y);\n    x.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict)).toBe("withheld/from-a-call");
  });

  it("resolves a Rust struct literal, the third spelling of the same evidence", () => {
    const source = "fn f() {\n    let x = Config { a: 1 };\n    x.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/struct-literal/Config");
  });
});

describe("annotated parameter -- declared in the signature", () => {
  it("resolves a TypeScript parameter", () => {
    const source = "function f(c: Config) {\n  c.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict))
      .toBe("resolved/annotated-parameter/Config");
  });

  it("resolves a Python typed parameter, `self` excluded", () => {
    const source = "class C:\n    def f(self, c: Config):\n        c.run()\n";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "python")).verdict))
      .toBe("resolved/annotated-parameter/Config");
  });

  it("resolves a Rust parameter", () => {
    const source = "fn f(c: Config) {\n    c.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/annotated-parameter/Config");
  });

  it("resolves TypeScript's postfix array shorthand to Array, not its element", () => {
    // `measure:resolution`'s first full-corpus run found this: `c: Foo[]`
    // read as `Foo`, because `array_type` wraps the element and a plain
    // recursive walk finds it first. `Foo[]` is the receiver's own type --
    // an array -- and a real checker's own printed form of one is also
    // postfix, never `Array<Foo>`, so this was wrong on both ends until fixed.
    const source = "function f(c: Foo[]) {\n  c.push(x);\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict))
      .toBe("resolved/annotated-parameter/Array");
  });

  it("resolves `readonly Foo[]` to ReadonlyArray, not to Array", () => {
    // A second full-corpus run, after the fix above, found this: `readonly
    // Foo[]` fell into the same `array_type` branch as a plain array and read
    // as `Array`, while the compiler prints both `ReadonlyArray<Foo>` and
    // `readonly Foo[]` the same way -- `readonly Foo[]` -- so every readonly
    // array parameter in the corpus disagreed with the referee.
    const source = "function f(c: readonly Foo[]) {\n  c.forEach(x);\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict))
      .toBe("resolved/annotated-parameter/ReadonlyArray");
  });

  it("resolves a TypeScript tuple type to Array, not its first element", () => {
    // A fourth full-corpus run found this on a nested tuple type,
    // `[[number, number], [number, number], [number, number]]`, reported as
    // `number` -- three levels down from what the receiver actually is.
    const source = "function f(c: [number, number]) {\n  c.push(x);\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict))
      .toBe("resolved/annotated-parameter/Array");
  });

  it("resolves an inline object type to Object, not its first field's type", () => {
    // Same run: `mutation: { isSuccess: boolean; reset: () => void }` read
    // as `boolean`, the type of the first field rather than of the
    // parameter itself.
    const source = "function f(m: { isSuccess: boolean; reset: () => void }) {\n  m.reset();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict))
      .toBe("resolved/annotated-parameter/Object");
  });

  it("resolves a TypeScript qualified annotation to its full name, not just the tail", () => {
    // A third full-corpus run found this: `node: ts.Node` read as plain
    // `Node` -- and this repo's own corpus has a real, different `Node`
    // (from `parse.ts`) that name could be silently confused with. A real
    // checker always prints a qualified type qualified; taking the tail was
    // a board-labelling convenience (`holds.ts`'s job), not evidence here.
    const source = "function f(node: ts.Node) {\n  node.getText();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict))
      .toBe("resolved/annotated-parameter/ts.Node");
  });

  it("withholds indexed-type rather than naming the outer type of a lookup", () => {
    // `RustLayout["adopted"]` does not name `RustLayout` -- it names
    // whatever `RustLayout`'s `adopted` field is typed as. The third
    // full-corpus run found this reported as `RustLayout` where the referee
    // named the field's real type, `Array`.
    const source = 'function f() {\n  const adopted: RustLayout["adopted"] = [];\n  adopted.push(x);\n}';
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict)).toBe("withheld/indexed-type");
  });

  it("does not read a method call on a variable named `list` as constructing one", () => {
    // `collectionHeadOf` trusted a callee's text split on `.` the same way
    // `dataflow.ts`'s `makesCollection` does, which reads a plain method
    // call's *receiver* name as if it were the called function -- `list` is
    // a Python builtin name and also a common parameter name for a `Node`.
    // The third full-corpus run found this on `dataflow.ts`'s own source:
    // `list.child(index)` read as constructing a fresh list.
    const source = "function f(list: Node) {\n  const child = list.child(0);\n  child.foo();\n}";
    const sites = sitesOf(resolveReceiversIn(source, "ts"));
    const listSite = sites.find((site) => site.method === "child")!;
    expect(verdictOf(listSite.verdict)).toBe("resolved/annotated-parameter/Node");
  });

  it("resolves a Python module-qualified annotation to the class, not the module", () => {
    // `measure:resolution`'s first real run against infrarouter found this:
    // `rng: random.Random` read as "random" -- a module name, never a type.
    // Pyright's own referee caught it in 13 of 182 checked sites.
    const source = "def f(rng: random.Random):\n    rng.choice(x)\n";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "python")).verdict))
      .toBe("resolved/annotated-parameter/Random");
  });
});

describe("annotated local -- declared, even though the call is opaque", () => {
  it("resolves a TypeScript local whose value is a plain call", () => {
    const source = "function f() {\n  let x: Config = load();\n  x.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict))
      .toBe("resolved/annotated-local/Config");
  });

  it("resolves a Python annotated local the same way", () => {
    const source = "def f():\n    x: Config = load()\n    x.run()\n";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "python")).verdict))
      .toBe("resolved/annotated-local/Config");
  });

  it("resolves a Rust typed `let`", () => {
    const source = "fn f() {\n    let x: Config = load();\n    x.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/annotated-local/Config");
  });
});

describe("declared field -- self.cache: Dict[str, Row]", () => {
  it("resolves a Python instance attribute annotated inside a method", () => {
    const source = [
      "class C:",
      "    def __init__(self):",
      "        self.cache: Dict[str, Row] = {}",
      "    def m(self):",
      "        self.cache.get(x)",
    ].join("\n");
    const sites = sitesOf(resolveReceiversIn(source, "python"));
    expect(sites).toHaveLength(1);
    expect(sites[0]!.kind).toBe("field");
    expect(sites[0]!.receiver).toBe("cache");
    expect(verdictOf(sites[0]!.verdict)).toBe("resolved/declared-field/Dict");
  });

  it("resolves a TypeScript class field reached through `this`", () => {
    const source = [
      "class C {",
      "  cache: Map<string, Row>;",
      "  m() { this.cache.get(x); }",
      "}",
    ].join("\n");
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict))
      .toBe("resolved/declared-field/Map");
  });

  it("resolves a Rust struct field reached through `self`, declared on the sibling struct", () => {
    const source = [
      "struct S { cache: HashMap<String, Row> }",
      "impl S { fn m(&self) { self.cache.get(&k); } }",
    ].join("\n");
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/declared-field/HashMap");
  });

  it("withholds `no-fields` when the field is not declared on the type", () => {
    const source = "class C {\n  m() { this.cache.get(x); }\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict)).toBe("withheld/no-fields");
  });
});

describe("collection literal -- already gated by dataflow.ts", () => {
  it("resolves a TypeScript array literal", () => {
    const source = "function f() {\n  const v = [];\n  v.push(x);\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict))
      .toBe("resolved/collection-literal/Array");
  });

  it("resolves a Python dict-maker call", () => {
    const source = "def f():\n    v = dict()\n    v.get(k)\n";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "python")).verdict))
      .toBe("resolved/collection-literal/dict");
  });

  it("resolves `new Map()` as a construction, not double-counted as a collection", () => {
    const source = "function f() {\n  const v = new Map();\n  v.get(k);\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict))
      .toBe("resolved/construction/Map");
  });
});

describe("refusals -- a resolver that guesses is worse than one that shrugs", () => {
  it("withholds from-a-call when nothing else says what the value is", () => {
    const source = "function f() {\n  const x = load();\n  x.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict)).toBe("withheld/from-a-call");
  });

  it("withholds union-type rather than picking the first branch of a union", () => {
    // `measure:resolution`'s first full-corpus run found this: a parameter
    // typed `string | undefined` read as `string`, and pyright's referee
    // correctly reported the whole union at the point it was actually read --
    // 253 of 2215 TypeScript sites were wrong before this refusal existed,
    // most of them this exact shape.
    const source = "function f(raw: string | undefined) {\n  raw.trim();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict)).toBe("withheld/union-type");
  });

  it("still resolves a generic whose type argument happens to be a union", () => {
    // The union is not the receiver's own type here -- `Array` is, and it is
    // one real answer. Over-refusing this would cost resolved sites for no
    // gain in correctness.
    const source = "function f(xs: Array<string | number>) {\n  xs.push(y);\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict))
      .toBe("resolved/annotated-parameter/Array");
  });

  it("withholds union-type for Python's Optional[...]", () => {
    const source = "def f(c: Optional[Config]):\n    c.run()\n";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "python")).verdict)).toBe("withheld/union-type");
  });

  it("withholds union-type for Python's X | None", () => {
    const source = "def f(c: Config | None):\n    c.run()\n";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "python")).verdict)).toBe("withheld/union-type");
  });

  it("withholds no-annotation for a binding that is neither a call nor a construction", () => {
    const source = "function f(a, b) {\n  const x = a + b;\n  x.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict)).toBe("withheld/no-annotation");
  });

  it("withholds reassigned when a name is bound more than once in the routine", () => {
    const source = "function f() {\n  let x = new Config();\n  x = other();\n  x.run();\n}";
    const sites = sitesOf(resolveReceiversIn(source, "ts"));
    const call = sites.find((site) => site.method === "run")!;
    expect(verdictOf(call.verdict)).toBe("withheld/reassigned");
  });

  it("withholds imported-type for a name bound by an import", () => {
    const source = "import { db } from './db';\nfunction f() {\n  db.query();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict)).toBe("withheld/imported-type");
  });

  it("withholds unbound for a name this reader never saw declared", () => {
    const source = "function f() {\n  x.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict)).toBe("withheld/unbound");
  });

  it("withholds generic-parameter rather than reporting a placeholder as a type", () => {
    const source = "function f<T>(x: T) {\n  x.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict)).toBe("withheld/generic-parameter");
  });

  it("withholds not-a-name for a receiver that is not a simple name or a self-field", () => {
    const source = "function f() {\n  make().run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict)).toBe("withheld/not-a-name");
  });

  it("withholds quoted for a Python forward-reference annotation", () => {
    const source = "def f(c: \"Config\"):\n    c.run()\n";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "python")).verdict)).toBe("withheld/quoted");
  });

  it("skips a call on self/this directly -- not a receiver question", () => {
    const source = "class C {\n  m() { this.run(); }\n}";
    expect(sitesOf(resolveReceiversIn(source, "ts"))).toHaveLength(0);
  });

  it("skips a Rust static call, which is a namespaced call rather than a value's type", () => {
    const source = "fn f() {\n    Config::validate(x);\n}";
    expect(sitesOf(resolveReceiversIn(source, "rust"))).toHaveLength(0);
  });
});

describe("shape disagreement -- both answers are true", () => {
  it("finds an annotation and a construction naming different types", () => {
    const source = "function f() {\n  const x: Base = new Child();\n  x.run();\n}";
    const found = shapeDisagreementsIn(source, "ts");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "x", annotation: "Base", construction: "Child", line: 2 });
    // The main verdict prefers the annotation -- both are true, but a
    // receiver call needs one answer, and #227's own text picks this one.
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict)).toBe("resolved/annotated-local/Base");
  });

  it("reports nothing when the two shapes agree", () => {
    const source = "function f() {\n  const x: Config = new Config();\n  x.run();\n}";
    expect(shapeDisagreementsIn(source, "ts")).toHaveLength(0);
  });
});

describe("unreadable", () => {
  it("reports a file with no grammar loaded as unreadable, never as empty", () => {
    // @ts-expect-error -- deliberately an unloaded language, to see the refusal.
    const reading = resolveReceiversIn("x.run();", "yaml");
    expect(reading.read).toBe(false);
  });
});

/**
 * A reference with an explicit lifetime, which resolved to the *lifetime* --
 * found by #246's Rust referee, which named `trait Flag` where this reader
 * said the type was `static`.
 *
 * `&'static dyn Flag` parses as `reference_type(lifetime(identifier "static"),
 * dynamic_type(type_identifier "Flag"))`, and `headTypeOf`'s leaf fallback
 * takes any childless `identifier` it reaches first. The lifetime precedes the
 * type in child order, so every annotation of this shape named the lifetime --
 * `'static` as `static`, `'a` as `a` -- and named it *confidently*, which is
 * the shape `docs/claim-vocabulary.md` calls a false red rather than a gap.
 * `docs/reading-a-grammar.md`'s rule applies exactly: read the structure, and
 * a `lifetime` is never a type.
 *
 * One test per way a lifetime actually appears in real source, not per branch.
 */
describe("a lifetime is not a type (#246)", () => {
  it("reads through `&'static dyn Trait` to the trait, not the lifetime", () => {
    const source = "fn g(flag: &'static dyn Flag) {\n    flag.name_short();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/annotated-parameter/Flag");
  });

  it("reads through a named lifetime the same way", () => {
    const source = "fn g<'a>(flag: &'a dyn Flag) {\n    flag.name_short();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/annotated-parameter/Flag");
  });

  it("reads through a lifetime to a primitive type", () => {
    const source = "fn g(s: &'static str) {\n    s.len();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/annotated-parameter/str");
  });

  it("reads through a lifetime to a plain named type", () => {
    const source = "fn g(f: &'static Config) {\n    f.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/annotated-parameter/Config");
  });

  it("reads through a lifetime on a mutable reference", () => {
    const source = "fn g<'a>(f: &'a mut Config) {\n    f.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/annotated-parameter/Config");
  });

  it("names the type, not the lifetime, when the lifetime is a generic argument", () => {
    const source = "fn g(c: Cow<'a, str>) {\n    c.len();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/annotated-parameter/Cow");
  });

  it("still resolves a reference with no lifetime, which already worked", () => {
    const source = "fn g(f: &Config) {\n    f.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/annotated-parameter/Config");
  });

  it("does not read a struct field's lifetime as the field's type", () => {
    const source = "struct Holder<'a> {\n    inner: &'a Config,\n}\n"
      + "impl<'a> Holder<'a> {\n    fn go(&self) {\n        self.inner.run();\n    }\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/declared-field/Config");
  });
});

/**
 * Fields of a generic type's `impl` block, which were not found at all --
 * `impl<'a> Holder<'a>` and `impl<T> Foo<T>` put a `generic_type` on the
 * `type` field, and the lookup required a childless node. Every
 * `self.field.method()` inside one was withheld as `no-fields`: honest, so
 * nothing went red, but it cost coverage silently on exactly the types most
 * likely to have fields worth reading. Found while testing the lifetime fix
 * above (#246).
 */
describe("fields reach a generic type's impl block (#246)", () => {
  it("resolves a field receiver inside `impl<T> Foo<T>`", () => {
    const source = "struct Holder<T> {\n    inner: Config,\n    items: T,\n}\n"
      + "impl<T> Holder<T> {\n    fn go(&self) {\n        self.inner.run();\n    }\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/declared-field/Config");
  });

  it("resolves a field receiver inside a lifetime-parameterised impl", () => {
    const source = "struct Holder<'a> {\n    inner: Config,\n}\n"
      + "impl<'a> Holder<'a> {\n    fn go(&self) {\n        self.inner.run();\n    }\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/declared-field/Config");
  });

  it("still resolves a field receiver inside a plain `impl Foo`, which already worked", () => {
    const source = "struct Holder {\n    inner: Config,\n}\n"
      + "impl Holder {\n    fn go(&self) {\n        self.inner.run();\n    }\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/declared-field/Config");
  });
});

/**
 * A parameter that is rebound inside the body reported the *parameter's* type
 * at every call site, including after the rebinding (#247).
 *
 * `resolveReceiver` consulted `scope.params` before `scope.bindings`, so the
 * parameter always won and the binding that shadowed it was never reached. It
 * answered confidently, with no refusal, which is the false-red shape rather
 * than a coverage gap -- and it is not a Rust bug: the same shape reproduces in
 * TypeScript and Python, so a share of items 12-14's 0.7% and item 17's 1.76%
 * was always this.
 *
 * Found by #246's Rust referee, which named `String` where the reader said
 * `str` on ripgrep's `fn select(&mut self, name: &str)` shadowed by
 * `for name in self.types.keys()`.
 *
 * The answer is `reassigned`, not the shadowing type: this reader has no
 * positional scoping, so it cannot tell whether the binding precedes the call,
 * and "one of two possible types" is exactly what `reassigned` already means
 * for two bindings of the same name.
 *
 * One test per way the shadowing is actually written, in each language that has
 * that spelling -- not per branch.
 */
describe("a rebound parameter is not still the parameter (#247)", () => {
  it("withholds in Rust when a `let` rebinds the parameter", () => {
    const source = "fn g(c: Thing) {\n    let c = Other::new();\n    c.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("withheld/reassigned");
  });

  it("withholds in Rust when a `for` pattern rebinds the parameter", () => {
    // The corpus instance. A `for` pattern was not collected as a binding at
    // all, so the shadowing was invisible and the parameter won by default --
    // a second defect behind the same symptom.
    const source = "fn g(c: Thing) {\n    for c in items() {\n        c.run();\n    }\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("withheld/reassigned");
  });

  it("withholds in TypeScript when a `const` rebinds the parameter", () => {
    const source = "function g(c: Thing) {\n  const c = new Other();\n  c.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict))
      .toBe("withheld/reassigned");
  });

  it("withholds in Python when an assignment rebinds the parameter", () => {
    const source = "def g(c: Thing) -> None:\n    c = Other()\n    c.run()";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "python")).verdict))
      .toBe("withheld/reassigned");
  });

  it("withholds in Python when a `for` target rebinds the parameter", () => {
    const source = "def g(c: Thing) -> None:\n    for c in items():\n        c.run()";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "python")).verdict))
      .toBe("withheld/reassigned");
  });

  /* The regression guards. A parameter that is *not* shadowed must keep
   * resolving exactly as it did, in every language -- the whole cost of this
   * fix is meant to fall on the shadowed case and nowhere else. */

  it("still resolves an unshadowed Rust parameter", () => {
    const source = "fn g(c: Thing) {\n    c.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/annotated-parameter/Thing");
  });

  it("still resolves an unshadowed TypeScript parameter", () => {
    const source = "function g(c: Thing) {\n  c.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "ts")).verdict))
      .toBe("resolved/annotated-parameter/Thing");
  });

  it("still resolves an unshadowed Python parameter", () => {
    const source = "def g(c: Thing) -> None:\n    c.run()";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "python")).verdict))
      .toBe("resolved/annotated-parameter/Thing");
  });

  it("still resolves a body binding that shadows no parameter", () => {
    const source = "fn g() {\n    let c = Other::new();\n    c.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/rust-constructor/Other");
  });

  it("resolves a parameter whose name merely resembles a binding's", () => {
    const source = "fn g(c: Thing) {\n    let cc = Other::new();\n    c.run();\n}";
    expect(verdictOf(onlySite(resolveReceiversIn(source, "rust")).verdict))
      .toBe("resolved/annotated-parameter/Thing");
  });
});

/**
 * A loop variable's own withheld reason, which #247 changed as a side effect
 * worth pinning: it used to come back `unbound`, meaning "this name was never
 * bound anywhere", which was simply untrue -- the name is bound by the loop.
 * It is now `no-annotation`: bound, with nothing in the text naming its type.
 *
 * Still withheld either way, so nothing that consumes a verdict changes
 * behaviour; the reason column in `measure:resolution`'s section 3 does.
 */
describe("a loop variable is bound, with no annotation (#247)", () => {
  for (const [language, source] of [
    ["rust", "fn g() {\n    for c in items() {\n        c.run();\n    }\n}"],
    ["python", "def g() -> None:\n    for c in items():\n        c.run()"],
    ["ts", "function g() {\n  for (const c of items()) {\n    c.run();\n  }\n}"],
  ] as Array<["rust" | "python" | "ts", string]>) {
    it(`says no-annotation rather than unbound in ${language}`, () => {
      const site = resolveReceiversIn(source, language);
      const found = sitesOf(site).find((one) => one.receiver === "c");
      expect(found && verdictOf(found.verdict)).toBe("withheld/no-annotation");
    });
  }

  it("does not record a destructuring pattern, so a parameter it shadows stays wrong", () => {
    // The honest remaining limit, stated as a test rather than left to be
    // rediscovered: a tuple pattern has children and is skipped, the same way
    // every other binding shape here skips one.
    const source = "fn g(c: Thing) {\n    for (c, d) in items() {\n        c.run();\n    }\n}";
    const found = sitesOf(resolveReceiversIn(source, "rust")).find((one) => one.receiver === "c");
    expect(found && verdictOf(found.verdict)).toBe("resolved/annotated-parameter/Thing");
  });
});
