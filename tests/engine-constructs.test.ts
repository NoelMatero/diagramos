/**
 * The construction reader (#199).
 *
 * The relationship is a routine making one of a type: `new QueryCache()`,
 * `RouteInfo { .. }`, `<MenuContent />`. It is the only way to describe a
 * component tree at all, and half the arrows on the React board in
 * `probe-generative.mts` are it.
 *
 * ## Why this one refutes from evidence found, not from absence
 *
 * `holds.ts` reads a *declaration*, so absence there is genuine absence and it
 * may say "this type has no such field". A function body is not that: a routine
 * that never writes `new T` can still hand you a `T` by calling a factory, so
 * "no construction of T in this body" is not evidence that none happens. That is
 * the `feeds` argument and it applies here in full.
 *
 * What is available is the strongest verdict this engine has, and it is the one
 * `needs.ts` is built on: finding the construction running the **other way** is
 * proof the arrow is backwards. That rests on something found rather than on
 * something missing, and a backwards arrow is the thing worth catching anyway.
 *
 * So the answers are `needs.ts`'s, not `holds.ts`'s: `absent` is not a finding
 * here, and never becomes one.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { constructions, type ConstructsVerdict } from "../src/engine/constructs";

beforeAll(async () => { await initEngine(); }, 120_000);

/** The verdict as one word, so a test reads as the sentence it is checking. */
function verdictOf(verdict: ConstructsVerdict): string {
  return verdict.verdict === "withheld" ? `withheld/${verdict.why}` : verdict.verdict;
}

describe("a routine that makes one of a type", () => {
  it("confirms a TypeScript `new`", () => {
    const source = "function build() { return new QueryCache({}); }";
    const verdict = constructions(source, "build", ["QueryCache"], "ts");
    expect(verdict.verdict).toBe("confirmed");
    if (verdict.verdict !== "confirmed") return;
    expect(verdict.evidence.name).toBe("QueryCache");
    expect(verdict.evidence.line).toBe(1);
    // Quotable, because a verdict that can refute has to show what it read.
    expect(verdict.evidence.wrote).toContain("new QueryCache");
  });

  it("confirms a Rust struct literal", () => {
    const source = "fn build(p: String) -> RouteInfo { RouteInfo { path: p, methods: vec![] } }";
    expect(verdictOf(constructions(source, "build", ["RouteInfo"], "rust"))).toBe("confirmed");
  });

  it("confirms a JSX element, which is a component making a component", () => {
    // The spelling the census missed entirely: 100 constructions in tsx became
    // 2,270 once this was counted (#197), and it is the only way a React board
    // can say anything at all.
    const source = "const Menu = () => (<div><MenuContent /></div>);";
    expect(verdictOf(constructions(source, "Menu", ["MenuContent"], "tsx"))).toBe("confirmed");
  });

  it("ignores a lowercase JSX tag, which is not a box anybody draws", () => {
    const source = "const Menu = () => (<div><span /></div>);";
    expect(verdictOf(constructions(source, "Menu", ["div"], "tsx"))).toBe("absent");
  });

  it("takes any one of the names a box stands for", () => {
    const source = "function build() { return new QueryCache({}); }";
    expect(verdictOf(constructions(source, "build", ["Nope", "QueryCache"], "ts")))
      .toBe("confirmed");
  });

  it("credits the outer constructor with the outer type only", () => {
    // `new Foo(new Bar())` makes a Foo. Reading the whole subtree from the
    // outer node would credit Foo's construction with making a Bar as well,
    // and both are found anyway on their own pass.
    const source = "function build() { return new Foo(new Bar()); }";
    expect(verdictOf(constructions(source, "build", ["Foo"], "ts"))).toBe("confirmed");
    expect(verdictOf(constructions(source, "build", ["Bar"], "ts"))).toBe("confirmed");
  });
});

describe("says backwards, which is the only accusation this word is entitled to", () => {
  it("finds the construction running the other way", () => {
    /*
     * The strongest verdict this engine has, and the reason it is available
     * here at all: it rests on something found rather than on something
     * missing. `needs.ts` is built on exactly this.
     *
     * The arrow says `render` makes a `Widget`. It does not -- and `Widget`'s
     * own routine makes a `Renderer`, so the arrow is drawn the wrong way
     * round and there is a line to show for it.
     */
    const theirs = "class Widget { build() { return new Renderer(); } }";
    const verdict = constructions(
      "function render() { return 1; }", "render", ["Widget"], "ts",
      { source: theirs, routines: ["build"], language: "ts", names: ["Renderer"] },
    );
    expect(verdict.verdict).toBe("backwards");
    if (verdict.verdict !== "backwards") return;
    expect(verdict.evidence.name).toBe("Renderer");
  });

  it("prefers the confirmation when both directions exist", () => {
    // A confirmation is about the direction the arrow was drawn, so it wins:
    // the arrow is right, whatever else is also true.
    const theirs = "class Widget { build() { return new Renderer(); } }";
    const verdict = constructions(
      "function render() { return new Widget(); }", "render", ["Widget"], "ts",
      { source: theirs, routines: ["build"], language: "ts", names: ["Renderer"] },
    );
    expect(verdictOf(verdict)).toBe("confirmed");
  });

  it("does not accuse on the far end when its language has no licence", () => {
    // The backwards verdict is an accusation, so it needs the licence for the
    // language the evidence was read from -- not the one the arrow starts in.
    const verdict = constructions(
      "function render() { return 1; }", "render", ["Widget"], "ts",
      { source: "class Widget:\n    pass", routines: ["build"], language: "python", names: ["R"] },
    );
    expect(verdictOf(verdict)).toBe("absent");
  });
});

describe("absent is not a finding, and must never become one", () => {
  it("stays silent when a factory could be making it", () => {
    /*
     * This is the whole reason the word cannot refute from absence. `build`
     * hands back a Widget and never writes `new Widget`: the construction is
     * inside `makeWidget`, one call away and invisible from here.
     *
     * A reader that called this wrong would be telling somebody their correct
     * diagram is wrong on the strength of not having followed a call.
     */
    const source = "function build() { return makeWidget(); }";
    expect(verdictOf(constructions(source, "build", ["Widget"], "ts"))).toBe("absent");
  });
});

describe("refuses rather than accuses", () => {
  it("withholds on Python, where construction is spelled as a call", () => {
    // `Response(body)` makes a Response and `render(body)` makes nothing, and
    // nothing in the syntax separates them. Guessing on capitalisation is a
    // naming convention masquerading as evidence.
    const source = "def build():\n    return Response(body)";
    expect(verdictOf(constructions(source, "build", ["Response"], "python")))
      .toBe("withheld/call-shaped");
  });

  it("withholds when the constructor's name is built at runtime", () => {
    // `new registry[kind]()` makes something and the text does not say what.
    const source = "function build(kind) { return new registry[kind](); }";
    expect(verdictOf(constructions(source, "build", ["Widget"], "ts")))
      .toBe("withheld/computed");
  });

  it("withholds on a body it could only partly read", () => {
    const source = "function build() { return new Widget(";
    expect(verdictOf(constructions(source, "build", ["Widget"], "ts")))
      .toMatch(/^withheld\//);
  });

  it("tells a name that is not here from one with no body", () => {
    expect(verdictOf(constructions("function other() {}", "build", ["Widget"], "ts")))
      .toBe("withheld/not-declared");
    expect(verdictOf(constructions("const build = 3;", "build", ["Widget"], "ts")))
      .toBe("withheld/no-body");
  });

  it("lets one doubtful body silence a readable declaration of the same name", () => {
    // Rust declares one name twice all the time. A single reason to doubt
    // silences the whole answer -- the rule `signature.ts` and `holds.ts` both
    // arrived at, for the reason an accusation needs every body read.
    const source = [
      "impl A { fn build() -> u8 { 0 } }",
      "impl B { fn build() -> u8 { make_struct!{ Widget } } }",
    ].join("\n");
    expect(verdictOf(constructions(source, "build", ["Widget"], "rust")))
      .toMatch(/^withheld\//);
  });
});

describe("a method is a routine, and its text is not a program", () => {
  it("reads a construction inside a class method", () => {
    // Scanning a declaration's *text* re-parses it standalone, and `build() {
    // ... }` is not a valid program -- so every method in the corpus came back
    // withheld while every plain function worked. Walked in its own tree now.
    const source = "class Factory { build() { return new Widget(); } }";
    expect(verdictOf(constructions(source, "build", ["Widget"], "ts"))).toBe("confirmed");
  });

  it("reads a construction inside a Rust impl method", () => {
    const source = "impl Factory { fn build(&self) -> Widget { Widget { id: 1 } } }";
    expect(verdictOf(constructions(source, "build", ["Widget"], "rust"))).toBe("confirmed");
  });

  it("reports the line in the file, not in the extracted body", () => {
    const source = [
      "// one",
      "// two",
      "function build() {",
      "  return new Widget();",
      "}",
    ].join("\n");
    const verdict = constructions(source, "build", ["Widget"], "ts");
    expect(verdict.verdict).toBe("confirmed");
    if (verdict.verdict !== "confirmed") return;
    expect(verdict.evidence.line).toBe(4);
  });
});

describe("a macro in the room does not hide what is plainly written", () => {
  it("confirms a struct literal in a routine that also invokes a macro", () => {
    // Rust routines are full of `println!`, `vec![]`, `todo!()`. If any macro
    // silenced the whole routine the word would be inert in Rust -- the
    // safe-and-useless failure `signature.ts` warns about in the same breath as
    // the false red. A confirmation is something found, so it wins.
    const source = [
      "fn build(p: String) -> RouteInfo {",
      '    println!("building");',
      "    RouteInfo { path: p }",
      "}",
    ].join("\n");
    expect(verdictOf(constructions(source, "build", ["RouteInfo"], "rust"))).toBe("confirmed");
  });

  it("withholds when the construction could only be inside the macro", () => {
    // `vec![Route { .. }]` puts the struct literal inside a token tree, which
    // the parser does not read as an expression. The reader genuinely cannot
    // see it, and says so rather than reporting an absence.
    const source = "fn build() -> Vec<Route> { vec![Route { id: 1 }] }";
    expect(verdictOf(constructions(source, "build", ["Route"], "rust")))
      .toBe("withheld/macro");
  });
});
