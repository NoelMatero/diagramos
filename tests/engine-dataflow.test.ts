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

import { chainFrom, contained, readBodies, readBody } from "../src/engine/dataflow";
import { initEngine, type Language } from "../src/engine/parse";

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
