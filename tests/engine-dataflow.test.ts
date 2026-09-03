/**
 * Following a value through the locals of one function body.
 *
 * This is a measurement instrument (#208), not a word. Nothing here can put a
 * colour on a diagram, and the tests are written against the two questions the
 * measurement asks rather than against a verdict:
 *
 *   1. does a producer's result reach a consumer, through however many locals
 *   2. does a value provably never leave the body it was made in
 *
 * The second is the one worth being strict about. Every wrong answer there is a
 * claim that an absence is proof, which is the mistake `licence.ts` exists to
 * prevent -- so the reader must count a value as escaping whenever it cannot
 * account for a use, and these tests are mostly shapes that must *not* come back
 * contained.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  chainFrom, contained, operates, operatorOf, readBodies, readBody, settleCalls,
} from "../src/engine/dataflow";
import { each, initEngine, parseSource, type Language, type Node } from "../src/engine/parse";

beforeAll(async () => {
  await initEngine();
}, 60_000);

/** The body of one routine, read. Throws on a refusal, so a test says why. */
function body(source: string, routine: string, language: Language = "ts") {
  const reading = readBody(source, routine, language);
  if (!reading.read) throw new Error(`refused: ${reading.why}`);
  return reading.body;
}

describe("a value followed through the locals of one body", () => {
  it("follows a result through two locals into the call at the end", () => {
    // The shape from #208, which the shipped one-hop reader cannot see.
    const read = body(
      "function pipeline(input) {\n"
      + "  const rows = parse(input);\n"
      + "  const shaped = normalise(rows);\n"
      + "  render(shaped);\n"
      + "}\n",
      "pipeline",
    );
    expect(chainFrom(read, ["parse"], ["render"])).toEqual({
      producer: "parse",
      consumer: "render",
      through: ["rows", "shaped"],
      line: 4,
    });
  });

  it("follows the same shape in Rust and in Python", () => {
    const rust = body(
      "fn pipeline(input: &str) {\n"
      + "  let rows = parse(input);\n"
      + "  let shaped = normalise(rows);\n"
      + "  render(shaped);\n"
      + "}\n",
      "pipeline",
      "rust",
    );
    expect(chainFrom(rust, ["parse"], ["render"])?.through).toEqual(["rows", "shaped"]);

    const python = body(
      "def pipeline(input):\n"
      + "    rows = parse(input)\n"
      + "    shaped = normalise(rows)\n"
      + "    render(shaped)\n",
      "pipeline",
      "python",
    );
    expect(chainFrom(python, ["parse"], ["render"])?.through).toEqual(["rows", "shaped"]);
  });

  it("still finds the one-hop shapes the shipped reader already finds", () => {
    const bound = body("function f() {\n  const v = A(1);\n  B(v);\n}\n", "f");
    expect(chainFrom(bound, ["A"], ["B"])?.through).toEqual(["v"]);
    // Handed straight over: no binding, so no name to quote, and inventing one
    // would be evidence the file does not contain.
    const direct = body("function f() { B(A(1)); }", "f");
    expect(chainFrom(direct, ["A"], ["B"])?.through).toEqual([]);
  });

  it("does not invent a flow for a producer the body never calls", () => {
    const read = body(
      "function f() {\n  const rows = parse(input);\n  render(rows);\n}\n", "f",
    );
    expect(chainFrom(read, ["ZzNotARealName"], ["render"])).toBeUndefined();
    expect(chainFrom(read, ["parse"], ["ZzNotARealName"])).toBeUndefined();
  });

  it("does not join two halves that live in different bodies", () => {
    // The false positive `feeds.ts` names: two routines in one file can each
    // hold a binding of the same name, and reading one in the other would
    // confirm an arrow out of two unrelated lines.
    const source = "function one() {\n  const v = A(1);\n}\n"
      + "function two() {\n  B(v);\n}\n";
    expect(chainFrom(body(source, "one"), ["A"], ["B"])).toBeUndefined();
    expect(chainFrom(body(source, "two"), ["A"], ["B"])).toBeUndefined();
  });

  it("reads a file's top level as a region, because a script writes pipelines there", () => {
    // `measure-constructs.mts` binds `language` and hands it to `bump` outside
    // any routine at all. Leaving the top level out cost this reader 93 flows
    // the shipped one already confirms, none of them about hops.
    const { bodies } = readBodies(
      "for (const file of files()) {\n"
      + "  const language = languageOf(file);\n"
      + "  bump(counts, language);\n"
      + "}\n",
      "ts",
    );
    const top = bodies.find((one) => one.scope === "module")!;
    expect(chainFrom(top, ["languageOf"], ["bump"])?.through).toEqual(["language"]);
  });

  it("follows a name declared empty and assigned later", () => {
    // `let source: string; try { source = readFileSync(..) }` — three of this
    // repo's own measurement scripts open exactly that way, and the assignment
    // read as writing to a name from an enclosing scope, so the local was never
    // recorded and every flow out of it was lost.
    const read = body(
      "function f(file) {\n"
      + "  let source;\n"
      + "  try {\n"
      + "    source = readFileSync(file);\n"
      + "  } catch {\n"
      + "    return;\n"
      + "  }\n"
      + "  refereeTypes(source);\n"
      + "}\n",
      "f",
    );
    expect(chainFrom(read, ["readFileSync"], ["refereeTypes"])?.through).toEqual(["source"]);
  });

  it("still follows a rebound name's current value, which is what the arrow asks", () => {
    /*
     * `G = load_graph(gp)` in graphify's `cli.py`, assigned in several branches
     * of one long routine. The escape question about `G` is unanswerable -- the
     * name does not stand for one value -- and the flow question is not: at the
     * line of the call it holds the last thing written to it. Treating the two
     * refusals as one cost 63 flows the shipped reader confirms.
     */
    const read = body(
      "def f(gp):\n"
      + "    G = load_graph(gp)\n"
      + "    G = load_graph(other)\n"
      + "    gods = _god_nodes(G)\n",
      "f",
      "python",
    );
    expect(chainFrom(read, ["load_graph"], ["_god_nodes"])?.through).toEqual(["G"]);
    const g = read.locals.find((one) => one.name === "G")!;
    expect(g.why).toBe("rebound");
    expect(contained(g)).toBe(false);
  });

  it("says nothing about a shadowed name, where the value genuinely is unknown", () => {
    const read = body(
      "function f() {\n"
      + "  const v = A();\n"
      + "  if (x) { const v = other(); }\n"
      + "  B(v);\n"
      + "}\n",
      "f",
    );
    expect(chainFrom(read, ["A"], ["B"])).toBeUndefined();
  });

  it("still calls a second assignment a rebind, not another filling", () => {
    const v = local(
      "function f() {\n  let w;\n  w = make();\n  w = other();\n}\n", "f", "w",
    );
    expect(v.why).toBe("rebound");
  });

  it("follows a loop variable, which is a binding as much as a `const` is", () => {
    // `for (const child of children(node))` in `rust.ts`. Found by the
    // measurement, as a flow the shipped one-hop reader confirms and this one
    // could not -- and the loop body was being thrown away with it.
    const read = body(
      "function f(node) {\n"
      + "  for (const child of children(node)) {\n"
      + "    segmentsOf(child);\n"
      + "  }\n"
      + "}\n",
      "f",
    );
    expect(chainFrom(read, ["children"], ["segmentsOf"])?.through).toEqual(["child"]);
  });
});

/** One local of a body, by name. Throws rather than returning undefined. */
function local(source: string, routine: string, name: string, language: Language = "ts") {
  const found = body(source, routine, language).locals.find((one) => one.name === name);
  if (!found) throw new Error(`no local ${name} in ${routine}`);
  return found;
}

describe("a value that provably never leaves the body", () => {
  it("counts a value only ever read as contained", () => {
    const v = local(
      "function count(rows) {\n"
      + "  const total = rows.length;\n"
      + "  if (total > 3) { return true; }\n"
      + "  return false;\n"
      + "}\n",
      "count",
      "total",
    );
    expect(contained(v)).toBe(true);
    expect(v.escapes).toEqual([]);
    expect(v.unread).toEqual([]);
  });

  it("counts a returned value as gone", () => {
    const v = local("function f() {\n  const w = make();\n  return w;\n}\n", "f", "w");
    expect(v.escapes).toEqual(["returned"]);
    expect(contained(v)).toBe(false);
  });

  it("counts Rust's tail expression as a return, because it is one", () => {
    const v = local("fn f() -> Widget {\n  let w = make();\n  w\n}\n", "f", "w", "rust");
    expect(v.escapes).toEqual(["returned"]);
  });

  it("counts a value written onto a field as gone", () => {
    const v = local(
      "function f() {\n  const w = make();\n  this.cache = w;\n}\n", "f", "w",
    );
    expect(v.escapes).toEqual(["stored-in-a-field"]);
  });

  it("counts a value handed to a routine as gone, because no call is resolvable", () => {
    const v = local("function f() {\n  const w = make();\n  store(w);\n}\n", "f", "w");
    expect(v.escapes).toEqual(["passed-to-a-call"]);
  });

  it("counts a method called on it as gone, because a method can store it too", () => {
    const v = local("function f() {\n  const w = make();\n  w.register();\n}\n", "f", "w");
    expect(v.escapes).toEqual(["used-as-a-receiver"]);
  });

  it("counts a value read inside a closure as captured", () => {
    const v = local(
      "function f() {\n  const w = make();\n  const later = () => w;\n}\n", "f", "w",
    );
    expect(v.escapes).toEqual(["captured-by-a-closure"]);
  });

  it("counts a value published to a name outside the body as gone", () => {
    // `font.ts`'s module-level `faces`. An assignment to it reads exactly like a
    // fresh binding, and the value was being counted as a local that never left
    // while it was being handed to the whole module. The referee found it.
    const v = local(
      "let faces = null;\n"
      + "function loadFaces() {\n  const loaded = read();\n  faces = loaded;\n}\n",
      "loadFaces",
      "loaded",
    );
    expect(v.escapes).toEqual(["assigned-to-an-outer"]);
    expect(body(
      "let faces = null;\n"
      + "function loadFaces() {\n  const loaded = read();\n  faces = loaded;\n}\n",
      "loadFaces",
    ).locals.map((one) => one.name)).toEqual(["loaded"]);
  });

  it("counts a value in Python's only binding form as a local, not as an outer name", () => {
    // Python spells a local binding and an assignment the same way, so the rule
    // above has to be told apart by the grammar rather than by the scope.
    const v = local("def f():\n    w = make()\n    return w\n", "f", "w", "python");
    expect(v.escapes).toEqual(["returned"]);
  });

  it("counts a value given a second name as no longer answerable", () => {
    const v = local("function f() {\n  const w = make();\n  const other = w;\n}\n", "f", "w");
    expect(v.escapes).toEqual(["bound-to-another-name"]);
    // Reading a field out of it is not aliasing it, and must stay contained.
    expect(contained(local(
      "function f() {\n  const w = make();\n  const n = w.length;\n}\n", "f", "w",
    ))).toBe(true);
  });

  it("counts a value put in a structure as gone, because the structure is not tracked", () => {
    const v = local("function f() {\n  const w = make();\n  const pair = [w, 1];\n}\n", "f", "w");
    expect(v.escapes).toEqual(["into-a-structure"]);
  });
});

describe("locals this reader refuses to follow at all", () => {
  it("refuses a name that is assigned again", () => {
    const v = local("function f() {\n  let w = make();\n  w = other();\n}\n", "f", "w");
    expect(v.why).toBe("rebound");
    expect(contained(v)).toBe(false);
  });

  it("refuses a name an inner scope binds as well", () => {
    const v = local(
      "function f() {\n  const w = make();\n  if (x) { const w = other(); }\n}\n", "f", "w",
    );
    expect(v.why).toBe("shadowed");
    expect(contained(v)).toBe(false);
  });
});

/**
 * The vector case, which is #203's own motivating example and the shape a
 * pattern-matching reader can never cover:
 *
 *     v.push(widget);
 *     use(v[i]);
 *
 * A person sees one thing going in and the same thing coming out. Every reader
 * in this engine sees two unrelated statements, and the first version of this
 * one saw a method called on `v` and gave up.
 *
 * The trick is *not* to know which index `i` is -- that is undecidable in
 * general, and knowing it is not needed. The collection is abstracted as one
 * thing and what is tracked is "everything in v". That deliberate forgetting is
 * what turns an impossible question into a computable one.
 */
describe("a value put into a collection and taken back out", () => {
  it("follows a value through a collection, without knowing the index", () => {
    const read = body(
      "function f(i) {\n"
      + "  const v = [];\n"
      + "  v.push(widget());\n"
      + "  use(v[i]);\n"
      + "}\n",
      "f",
    );
    expect(chainFrom(read, ["widget"], ["use"])).toEqual({
      producer: "widget",
      consumer: "use",
      through: ["v"],
      line: 4,
    });
  });

  it("follows it in all four languages", () => {
    const python = body(
      "def f(i):\n"
      + "    v = []\n"
      + "    v.append(widget())\n"
      + "    use(v[i])\n",
      "f",
      "python",
    );
    expect(chainFrom(python, ["widget"], ["use"])?.through).toEqual(["v"]);

    const rust = body(
      "fn f(i: usize) {\n"
      + "  let v = Vec::new();\n"
      + "  v.push(widget());\n"
      + "  use_it(v[i]);\n"
      + "}\n",
      "f",
      "rust",
    );
    expect(chainFrom(rust, ["widget"], ["use_it"])?.through).toEqual(["v"]);

    const map = body(
      "function f(k) {\n"
      + "  const seen = new Map();\n"
      + "  seen.set(k, widget());\n"
      + "  use(seen.get(k));\n"
      + "}\n",
      "f",
    );
    expect(chainFrom(map, ["widget"], ["use"])?.through).toEqual(["seen"]);
  });

  it("follows a value out through iteration, which is how real code reads one", () => {
    const read = body(
      "function f() {\n"
      + "  const rows = [];\n"
      + "  rows.push(parse());\n"
      + "  for (const row of rows) {\n"
      + "    render(row);\n"
      + "  }\n"
      + "}\n",
      "f",
    );
    expect(chainFrom(read, ["parse"], ["render"])?.through).toEqual(["rows", "row"]);
  });

  it("will not model a collection whose making it never saw", () => {
    // A parameter. `v.push(x)` might be a list taking a value or somebody's own
    // method storing it globally, and nothing in the text says which -- so the
    // value is counted as gone, and no flow is claimed.
    const read = body(
      "function f(v, i) {\n  v.push(widget());\n  use(v[i]);\n}\n", "f",
    );
    expect(chainFrom(read, ["widget"], ["use"])).toBeUndefined();
  });

  it("will not model one bound from an ordinary call either", () => {
    // `load()` may return anything. Reading `push` as a list write here would be
    // taking a method name for evidence, which is what `constructs.ts` refuses
    // Python over.
    const read = body(
      "function f(i) {\n"
      + "  const v = load();\n"
      + "  v.push(widget());\n"
      + "  use(v[i]);\n"
      + "}\n",
      "f",
    );
    expect(chainFrom(read, ["widget"], ["use"])).toBeUndefined();
  });
});

describe("what a collection means for whether a value stayed", () => {
  it("counts a value in a collection that never leaves as still contained", () => {
    // The refutation case, and the one #203 says is impossible: `w` is inside
    // `v`, `v` never leaves the body, so nothing that went into `v` left either
    // — and what is in `v` is enumerable.
    const read = body(
      "function f() {\n"
      + "  const v = [];\n"
      + "  const w = make();\n"
      + "  v.push(w);\n"
      + "  return v.length;\n"
      + "}\n",
      "f",
    );
    const w = read.locals.find((one) => one.name === "w")!;
    const v = read.locals.find((one) => one.name === "v")!;
    expect(w.inside).toEqual(["v"]);
    expect(contained(w)).toBe(true);
    expect(contained(v)).toBe(true);
    expect([...v.holds.keys()]).toEqual(["make"]);
  });

  it("takes the contents with it when the collection leaves", () => {
    const read = body(
      "function f() {\n"
      + "  const v = [];\n"
      + "  const w = make();\n"
      + "  v.push(w);\n"
      + "  return v;\n"
      + "}\n",
      "f",
    );
    const w = read.locals.find((one) => one.name === "w")!;
    expect(w.escapes).toEqual(["left-inside-a-collection"]);
    expect(contained(w)).toBe(false);
  });

  it("lets a question about a collection leave it alone entirely", () => {
    /*
     * `seen.has(k)` yields a boolean: neither the Set nor anything in it comes
     * back. Found by the report rather than by imagining it -- an unclassified
     * method falls through to "a method was called on it, which might store
     * it", so `has` was counting 33 collections in this repository's own `src`
     * as having escaped.
     */
    const read = body(
      "function f(k) {\n"
      + "  const seen = new Set();\n"
      + "  const w = make();\n"
      + "  seen.add(w);\n"
      + "  if (seen.has(k)) { return 1; }\n"
      + "  return 0;\n"
      + "}\n",
      "f",
    );
    const seen = read.locals.find((one) => one.name === "seen")!;
    const w = read.locals.find((one) => one.name === "w")!;
    expect(contained(seen)).toBe(true);
    // Not spilled either: a question is not a read, and nothing came back out.
    expect(seen.spilled).toBeUndefined();
    expect(contained(w)).toBe(true);
  });

  it("names a method on a collection that no table classifies", () => {
    // The table's own edge, reported rather than guessed at. That `push`
    // appends is knowledge about a standard library and no structural rule
    // derives it, so what a table can do is show where it stops.
    const read = body(
      "function f() {\n"
      + "  const rows = [];\n"
      + "  rows.zzUnclassified(1);\n"
      + "}\n",
      "f",
    );
    expect(read.unknownMethods.map((one) => one.name)).toEqual(["zzUnclassified"]);
    // And still counted against the collection, which is the safe direction.
    expect(contained(read.locals.find((one) => one.name === "rows")!)).toBe(false);
  });

  it("takes the contents with it when the collection is drained, not just indexed", () => {
    // `listDiagrams` in `diagram.ts`: `return [...summaries.values()]` keeps the
    // Map — a new array is what leaves — and hands over everything in it.
    // Marking that only on the `v[i]` shape reported every value in a drained
    // Map as never having left, and the referee caught it.
    const read = body(
      "function f() {\n"
      + "  const seen = new Map();\n"
      + "  const w = make();\n"
      + "  seen.set(1, w);\n"
      + "  return [...seen.values()];\n"
      + "}\n",
      "f",
    );
    const w = read.locals.find((one) => one.name === "w")!;
    const seen = read.locals.find((one) => one.name === "seen")!;
    expect(seen.spilled).toBe(true);
    expect(contained(seen)).toBe(true);
    expect(w.escapes).toEqual(["left-inside-a-collection"]);
  });

  it("takes the contents with it when something is read out and handed away", () => {
    // `v` itself never leaves — it is only read. What came out of it did, and
    // which one came out is the question not being asked, so all of it counts.
    const read = body(
      "function f(i) {\n"
      + "  const v = [];\n"
      + "  const w = make();\n"
      + "  v.push(w);\n"
      + "  store(v[i]);\n"
      + "}\n",
      "f",
    );
    const w = read.locals.find((one) => one.name === "w")!;
    const v = read.locals.find((one) => one.name === "v")!;
    expect(w.escapes).toEqual(["left-inside-a-collection"]);
    expect(v.spilled).toBe(true);
    expect(contained(v)).toBe(true);
  });
});

/**
 * Reading past the body in front of you, which is the first thing here that
 * does.
 *
 * 42% of every value in the corpus escapes for one reason: it was handed to a
 * routine, and nothing could follow the call. #189 made a call's *name*
 * resolvable, so the question becomes answerable -- does the callee let the
 * argument out?
 *
 * Conservative in one direction throughout, and most of what follows is the
 * conservative side. A value stops escaping only when every call it was handed
 * to resolves, reads cleanly, and keeps its argument. One unresolved call and
 * the value is gone, because it is.
 */
describe("a call that provably keeps what it is given", () => {
  /** A resolver over routines written in one string, the way one file reads. */
  function within(source: string, language: Language = "ts") {
    const { bodies } = readBodies(source, language);
    return {
      bodies,
      resolve: (callee: string) => {
        const found = bodies.find((one) => one.routine === callee);
        return found ? { body: found, file: "one.ts" } : undefined;
      },
    };
  }

  it("frees a value handed to a routine that only reads it", () => {
    const source =
      "function width(text) {\n  return text.length;\n}\n"
      + "function f() {\n  const w = make();\n  width(w);\n}\n";
    const { bodies, resolve } = within(source);
    const f = bodies.find((one) => one.routine === "f")!;
    const w = f.locals.find((one) => one.name === "w")!;
    expect(w.escapes).toEqual(["passed-to-a-call"]);

    const settled = settleCalls(f, resolve);
    expect(settled.freed).toBe(1);
    expect(contained(w)).toBe(true);
    /*
     * And marked as having had something read out of it. `return text.length`
     * hands out a property, so `w` stayed and what was in it did not -- two
     * different claims, and the second one is what `spilled` carries. Treating
     * them as one answered no for every callee in the corpus.
     */
    expect(settled.freedSpilling).toBe(1);
    expect(w.spilled).toBe(true);
  });

  it("frees a value cleanly when the callee reads nothing out of it", () => {
    const source =
      "function count(x) {\n  let total = 0;\n  return total;\n}\n"
      + "function f() {\n  const w = make();\n  count(w);\n}\n";
    const { bodies, resolve } = within(source);
    const f = bodies.find((one) => one.routine === "f")!;
    const settled = settleCalls(f, resolve);
    expect(settled.freed).toBe(1);
    expect(settled.freedSpilling).toBe(0);
    expect(f.locals.find((one) => one.name === "w")!.spilled).toBeUndefined();
  });

  it("follows a chain of wrappers that each only pass it on", () => {
    const source =
      "function inner(x) {\n  return x.length;\n}\n"
      + "function outer(y) {\n  return inner(y);\n}\n"
      + "function f() {\n  const w = make();\n  outer(w);\n}\n";
    const { bodies, resolve } = within(source);
    const f = bodies.find((one) => one.routine === "f")!;
    expect(settleCalls(f, resolve).freed).toBe(1);
  });

  it("will not free a value the callee returns", () => {
    const source =
      "function keep(x) {\n  return x;\n}\n"
      + "function f() {\n  const w = make();\n  keep(w);\n}\n";
    const { bodies, resolve } = within(source);
    const f = bodies.find((one) => one.routine === "f")!;
    const settled = settleCalls(f, resolve);
    expect(settled.freed).toBe(0);
    expect(settled.why.get("callee-lets-it-out")).toBe(1);
  });

  it("will not free a value the callee stores in a field", () => {
    const source =
      "function stash(x) {\n  this.held = x;\n}\n"
      + "function f() {\n  const w = make();\n  stash(w);\n}\n";
    const { bodies, resolve } = within(source);
    const f = bodies.find((one) => one.routine === "f")!;
    expect(settleCalls(f, resolve).freed).toBe(0);
  });

  it("will not free a value handed to a callee it cannot resolve", () => {
    const source = "function f() {\n  const w = make();\n  storeSomewhere(w);\n}\n";
    const { bodies, resolve } = within(source);
    const f = bodies.find((one) => one.routine === "f")!;
    const settled = settleCalls(f, resolve);
    expect(settled.freed).toBe(0);
    expect(settled.why.get("callee-not-resolved")).toBe(1);
  });

  it("will not free a value handed to a method, whose target needs a type", () => {
    // `registry.store(w)` -- which routine that reaches depends on what
    // `registry` is, and nothing in the text says. Counted under its own name,
    // because it is a different missing capability from an unresolved name.
    const source = "function f(registry) {\n  const w = make();\n  registry.store(w);\n}\n";
    const { bodies, resolve } = within(source);
    const f = bodies.find((one) => one.routine === "f")!;
    settleCalls(f, resolve);
    expect(contained(f.locals.find((one) => one.name === "w")!)).toBe(false);
  });

  it("needs every call to keep it, not just one", () => {
    const source =
      "function width(x) {\n  return x.length;\n}\n"
      + "function keep(x) {\n  return x;\n}\n"
      + "function f() {\n  const w = make();\n  width(w);\n  keep(w);\n}\n";
    const { bodies, resolve } = within(source);
    const f = bodies.find((one) => one.routine === "f")!;
    expect(settleCalls(f, resolve).freed).toBe(0);
  });

  it("answers per argument position, not per callee", () => {
    // `pair` keeps its first argument and lets the second out. Which one the
    // value arrived as is the whole question.
    const source =
      "function pair(a, b) {\n  return b;\n}\n"
      + "function f() {\n  const kept = make();\n  const gone = make();\n"
      + "  pair(kept, gone);\n}\n";
    const { bodies, resolve } = within(source);
    const f = bodies.find((one) => one.routine === "f")!;
    settleCalls(f, resolve);
    expect(contained(f.locals.find((one) => one.name === "kept")!)).toBe(true);
    expect(contained(f.locals.find((one) => one.name === "gone")!)).toBe(false);
  });

  it("stops on a cycle rather than assuming what it is proving", () => {
    const source =
      "function ping(x) {\n  return pong(x);\n}\n"
      + "function pong(x) {\n  return ping(x);\n}\n"
      + "function f() {\n  const w = make();\n  ping(w);\n}\n";
    const { bodies, resolve } = within(source);
    const f = bodies.find((one) => one.routine === "f")!;
    const settled = settleCalls(f, resolve);
    expect(settled.freed).toBe(0);
    expect(settled.why.get("callee-lets-it-out") ?? settled.why.get("too-deep")).toBeGreaterThan(0);
  });

  it("works the same in Python and Rust", () => {
    const python = within(
      "def check(flag):\n    if flag:\n        return 1\n    return 0\n\n"
      + "def f():\n    w = make()\n    check(w)\n",
      "python",
    );
    const pf = python.bodies.find((one) => one.routine === "f")!;
    expect(settleCalls(pf, python.resolve).freed).toBe(1);

    const rust = within(
      "fn bump(n: usize) -> usize {\n  n + 1\n}\n"
      + "fn f() {\n  let w = make();\n  bump(w);\n}\n",
      "rust",
    );
    const rf = rust.bodies.find((one) => one.routine === "f")!;
    expect(settleCalls(rf, rust.resolve).freed).toBe(1);
  });

  it("will not free a value handed to a builtin, which is not in the corpus", () => {
    /*
     * `return len(text)` reads nothing out of `text` and still blocks, because
     * `len` is not a routine any file here declares. Honest and worth naming:
     * Python code calls builtins constantly, so this is a large share of what
     * stays unresolved and it is not the same gap as a missing call graph.
     */
    const source =
      "def width(text):\n    return len(text)\n\n"
      + "def f():\n    w = make()\n    width(w)\n";
    const { bodies, resolve } = within(source, "python");
    const f = bodies.find((one) => one.routine === "f")!;
    const settled = settleCalls(f, resolve);
    expect(settled.freed).toBe(0);
    expect(settled.why.get("callee-not-resolved")).toBe(1);
  });
});

/** The operator node of a one-operator body, for reading its symbol directly. */
function onlyOperator(source: string, language: Language) {
  const tree = parseSource(source, language)!;
  let found: Node | undefined;
  each(tree.rootNode, (node) => {
    if (found || node.childCount === 0) return;
    if (operatorOf(node) !== undefined && !/declarat|assignment|statement|item/.test(node.type)) {
      found = node;
    }
  });
  if (!found) throw new Error("no operator node");
  return found;
}

/**
 * Operators, read by their symbol rather than by what a grammar calls the node.
 *
 * The bug this replaces was silent and it read like a fact about a language:
 * Python spells comparison `comparison_operator`, the hand-written list of node
 * types did not have it, so every Python comparison counted as a use nobody had
 * looked at and Python's containment reported 11.8% instead of 19.7%.
 *
 * The node's name could not have answered the question anyway. TypeScript calls
 * `a + b`, `a > b`, `a ?? b` and `a && b` all `binary_expression`, and those are
 * three different answers. So the symbol has to be read whatever the node is
 * called -- and once it is, the name is not needed.
 *
 * Every test below asserts the *same* answer in four languages. That is the
 * whole guard: if a per-grammar list creeps back in, one column breaks.
 */
describe("what an operator does, in four languages at once", () => {
  /** The one local of a body that only does arithmetic with its value. */
  const computed = (source: string, language: Language) =>
    local(source, "f", "w", language);

  it("does not let a value out through arithmetic, whatever the node is called", () => {
    // ts and js call this `binary_expression`, python `binary_operator`,
    // rust `binary_expression`. One answer.
    const shapes: Array<[Language, string]> = [
      ["ts", "function f() {\n  const w = make();\n  return w + 1;\n}\n"],
      ["js", "function f() {\n  const w = make();\n  return w * 2;\n}\n"],
      ["python", "def f():\n    w = make()\n    return w + 1\n"],
      ["rust", "fn f() -> i32 {\n  let w = make();\n  w + 1\n}\n"],
    ];
    for (const [language, source] of shapes) {
      const value = computed(source, language);
      expect(value.escapes, language).toEqual([]);
      // Arithmetic can carry what the operands held into the new value, so the
      // contents are doubtful even though the value stayed.
      expect(value.spilled, language).toBe(true);
    }
  });

  it("does not let a value out through a comparison, and does not even doubt it", () => {
    // The one Python spells `comparison_operator` and TypeScript spells
    // `binary_expression`, which is the pair that broke.
    const shapes: Array<[Language, string]> = [
      ["ts", "function f(b) {\n  const w = make();\n  return w > b;\n}\n"],
      ["js", "function f(b) {\n  const w = make();\n  return w === b;\n}\n"],
      ["python", "def f(b):\n    w = make()\n    return w > b\n"],
      ["rust", "fn f(b: i32) -> bool {\n  let w = make();\n  w > b\n}\n"],
    ];
    for (const [language, source] of shapes) {
      const value = computed(source, language);
      expect(value.escapes, language).toEqual([]);
      expect(contained(value), language).toBe(true);
      // A boolean holds nothing, so there is no doubt to carry.
      expect(value.spilled, language).toBeUndefined();
    }
  });

  it("does let a value out through an operator that hands back an operand", () => {
    // `??`, `||` and `or` return one of their operands, so a returned one has
    // plainly left. TypeScript gives this the same node name as `a + b`.
    const shapes: Array<[Language, string]> = [
      ["ts", "function f(b) {\n  const w = make();\n  return w ?? b;\n}\n"],
      ["js", "function f(b) {\n  const w = make();\n  return w || b;\n}\n"],
      ["python", "def f(b):\n    w = make()\n    return w or b\n"],
    ];
    for (const [language, source] of shapes) {
      const value = computed(source, language);
      expect(value.escapes, language).toEqual(["returned"]);
      expect(contained(value), language).toBe(false);
    }
  });

  it("reads the symbol where the grammar keeps no field for it", () => {
    // Rust's unary and Python's `not` have no `operator` field at all -- the
    // symbol is an anonymous token child, and that is the case the old
    // node-type list existed to paper over.
    expect(operatorOf(onlyOperator("fn f() -> i32 { let w = make(); -w }", "rust")))
      .toBe("-");
    expect(operatorOf(onlyOperator("def f():\n    w = make()\n    return not w\n", "python")))
      .toBe("not");
    // Python's comparison keeps it under `operators`, plural, because it chains.
    expect(operatorOf(onlyOperator("def f(b):\n    w = make()\n    return w > b\n", "python")))
      .toBe(">");
  });

  it("classifies every word operator it recognises, so the gate cannot drift", () => {
    /*
     * The gate that decides "is this token an operator or a keyword" and the
     * table that says what an operator does used to be two lists. `is not` was
     * in the table and not in the gate, so 1,071 Python comparisons came back
     * as "not an operator" -- the duplicate-list failure, committed while
     * fixing the duplicate-list failure.
     *
     * They are one list now, and this is what keeps them one: every word this
     * reader will accept as an operator has to have an answer.
     */
    const words = [
      "and", "or", "not", "in", "is", "is not", "not in", "instanceof",
      "typeof", "void", "delete",
    ];
    const sources: Record<string, [Language, string]> = {
      and: ["python", "def f(a, b):\n    return a and b\n"],
      or: ["python", "def f(a, b):\n    return a or b\n"],
      not: ["python", "def f(a):\n    return not a\n"],
      in: ["python", "def f(a, b):\n    return a in b\n"],
      is: ["python", "def f(a, b):\n    return a is b\n"],
      "is not": ["python", "def f(a):\n    return a is not None\n"],
      "not in": ["python", "def f(a, b):\n    return a not in b\n"],
      instanceof: ["ts", "function f(a, b) { return a instanceof b; }"],
      typeof: ["ts", "function f(a) { return typeof a; }"],
      void: ["ts", "function f(a) { return void a; }"],
      delete: ["ts", "function f(a) { delete a.x; }"],
    };
    for (const word of words) {
      const [language, source] = sources[word]!;
      const node = onlyOperator(source, language);
      expect(operatorOf(node), word).toBe(word);
      expect(operates(node), word).not.toBe("unknown");
    }
  });

  it("says `unknown` for a symbol nobody has classified, rather than assuming", () => {
    /*
     * Two real ones in this corpus's own languages: Rust's range `..` and
     * Python's walrus `:=`. Neither is arithmetic, a comparison, or an operator
     * that hands an operand back, and the answer has to be "nobody has decided"
     * rather than silence -- silence is how the last bug read as a fact about
     * Python.
     */
    expect(operates(onlyOperator("fn f(a: usize, b: usize) { for i in a..b {} }", "rust")))
      .toBe("unknown");
    expect(operates(onlyOperator("def f(a):\n    if (w := a):\n        return w\n", "python")))
      .toBe("unknown");
  });

  it("counts a value used with an unclassified symbol against it staying", () => {
    /*
     * The conservative direction, and what makes the answer above safe: an
     * operator nobody has looked at is a use nobody has accounted for. Named by
     * its symbol, which is the point -- the version this replaces recorded the
     * *node type*, so the report said `binary_expression` for four different
     * operators.
     *
     * Rust's `..` would have served here and does not: `range_expression` is
     * already on the list of things that hold a value without moving it, and
     * that list is consulted first. Python's walrus is on no list at all.
     */
    const value = local(
      "def f():\n    w = make()\n    if (x := w):\n        return 1\n    return 0\n",
      "f", "w", "python",
    );
    expect(value.unread).toEqual([":="]);
    expect(contained(value)).toBe(false);
  });
});
