/**
 * The signature reader (#169), which is the first thing in this engine allowed
 * to refute from an absence.
 *
 * Every other verdict here confirms or goes quiet. This one reads a function's
 * parameters and return type and, finding no mention of a type, is prepared to
 * say the arrow claiming one is wrong -- so a reader bug is not a missed finding,
 * it is the tool telling somebody their correct diagram is wrong. That is not
 * recoverable by being right afterwards.
 *
 * So the tests that matter here are the refusals. Everything under "refuses
 * rather than accuses" is a case where the signature is fully enumerable, does
 * not contain the type, and the arrow is nevertheless right; each one must come
 * back withheld, never absent. `scripts/measure-signature.mts` is the same
 * question asked of whole repositories.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { signatureNames, type SignatureVerdict } from "../src/engine/signature";

beforeAll(async () => { await initEngine(); }, 120_000);

/** The verdict as one word, so a test reads as the sentence it is checking. */
function verdictOf(v: SignatureVerdict): string {
  return v.verdict === "withheld" ? `withheld/${v.why}` : v.verdict;
}

describe("a signature that names the type", () => {
  it("confirms the case from the issue", () => {
    // struct Request -> handler(&Request): the arrow every board draws and no
    // word could state.
    const source = "fn user_handler(request: &Request) -> Response { todo!() }";
    const verdict = signatureNames(source, "user_handler", ["Request"], "parameter", "rust");
    expect(verdict.verdict).toBe("confirmed");
    if (verdict.verdict !== "confirmed") return;
    expect(verdict.evidence.name).toBe("Request");
    expect(verdict.evidence.line).toBe(1);
    // Quotable, because a refutable verdict has to show what it read.
    expect(verdict.evidence.signature).toContain("&Request");
  });

  it("confirms the other motivating case, on the return type", () => {
    const source = "impl Pool { fn get_client(&mut self, i: usize) -> &mut Client { todo!() } }";
    expect(verdictOf(signatureNames(source, "get_client", ["Client"], "return", "rust")))
      .toBe("confirmed");
  });

  it("reads a type out of a generic", () => {
    const source = "fn k(m: Slab<Client>) { }";
    expect(verdictOf(signatureNames(source, "k", ["Client"], "parameter", "rust")))
      .toBe("confirmed");
  });

  it("takes any one of the names a box stands for", () => {
    const source = "fn h(r: &Request) { }";
    expect(verdictOf(signatureNames(source, "h", ["Nope", "Request"], "parameter", "rust")))
      .toBe("confirmed");
  });

  it("reads all four grammars the engine loads", () => {
    const cases: Array<[string, string, "parameter" | "return", Parameters<typeof signatureNames>[4]]> = [
      ["fn h(r: &Request) -> Response { }", "h", "parameter", "rust"],
      ["function h(r: Request): Response { }", "h", "parameter", "ts"],
      ["const h = (r: Request): Response => x;", "h", "return", "ts"],
      ["def h(r: Request) -> Response: ...", "h", "parameter", "python"],
    ];
    for (const [source, symbol, position, language] of cases) {
      const target = position === "parameter" ? "Request" : "Response";
      expect(verdictOf(signatureNames(source, symbol, [target], position, language)))
        .toBe("confirmed");
    }
  });
});

describe("a signature that names the type in the other half", () => {
  /*
   * The strongest thing here that is not a refutation: it rests on a name that
   * was found. And the whole reason `takes` and `returns` are two words -- with
   * one, this arrow would pass no matter which way it was drawn.
   */
  it("says so rather than calling the arrow wrong", () => {
    const source = "fn user_handler(request: &Request) -> Response { }";
    const verdict = signatureNames(source, "user_handler", ["Request"], "return", "rust");
    expect(verdict.verdict).toBe("misplaced");
    if (verdict.verdict !== "misplaced") return;
    expect(verdict.evidence.position).toBe("parameter");
    expect(verdict.evidence.name).toBe("Request");
  });

  it("works the other way round too", () => {
    const source = "fn user_handler(request: &Request) -> Response { }";
    const verdict = signatureNames(source, "user_handler", ["Response"], "parameter", "rust");
    expect(verdict.verdict).toBe("misplaced");
    if (verdict.verdict !== "misplaced") return;
    expect(verdict.evidence.position).toBe("return");
  });
});

describe("a signature that does not name the type", () => {
  it("refutes, and quotes the signature it read", () => {
    const source = "fn user_handler(request: &Request) -> Response { }";
    const verdict = signatureNames(source, "user_handler", ["Database"], "parameter", "rust");
    expect(verdict.verdict).toBe("absent");
    if (verdict.verdict !== "absent") return;
    expect(verdict.signature).toBe("(request: &Request) -> Response");
    expect(verdict.line).toBe(1);
  });

  it("will not match a name that merely starts the same way", () => {
    // `Client` must not be found in `ClientPool`. The identifier test is what
    // makes a refutation about a name rather than about a substring.
    expect(verdictOf(signatureNames("fn h(c: &ClientPool) { }", "h", ["Client"], "parameter", "rust")))
      .toBe("absent");
  });

  it("does not mistake a parameter's own name for its type", () => {
    // `fn h(request: &Foo)` says nothing about anything called `request`.
    expect(verdictOf(signatureNames("fn h(request: &Foo) { }", "h", ["request"], "parameter", "rust")))
      .toBe("absent");
  });
});

/**
 * The half this whole design exists for.
 *
 * Each of these signatures is fully enumerable, does not contain the type, and
 * belongs to an arrow that is *right*. A verdict of `absent` on any of them is a
 * false accusation.
 */
describe("refuses rather than accuses", () => {
  it("a local type alias standing in for the type", () => {
    const source = "type Req = Request;\nfn h(r: &Req) { }";
    expect(verdictOf(signatureNames(source, "h", ["Request"], "parameter", "rust")))
      .toBe("withheld/aliased");
  });

  it("an import renamed on the way in", () => {
    const source = "use lib::Request as Req;\nfn h(r: &Req) { }";
    expect(verdictOf(signatureNames(source, "h", ["Request"], "parameter", "rust")))
      .toBe("withheld/aliased");
  });

  it("the same two shapes in TypeScript", () => {
    for (const source of [
      'import { Request as Req } from "./m";\nfunction h(r: Req) { }',
      "type Req = Request;\nfunction h(r: Req) { }",
    ]) {
      expect(verdictOf(signatureNames(source, "h", ["Request"], "parameter", "ts")))
        .toBe("withheld/aliased");
    }
  });

  it("and in Python", () => {
    const source = "from m import Request as Req\ndef h(r: Req): ...";
    expect(verdictOf(signatureNames(source, "h", ["Request"], "parameter", "python")))
      .toBe("withheld/aliased");
  });

  it("a parse that recovered from an error", () => {
    // "the type is not in here" is a statement about a whole file, and a
    // recovered parse read less than one.
    expect(verdictOf(signatureNames("fn h(r: &Request -> { {{{", "h", ["Request"], "parameter", "rust")))
      .toBe("withheld/incomplete");
  });

  it("a name the file does not declare", () => {
    // The node check already reports a missing symbol. Saying it again here
    // would be one mistake with two diagnoses.
    expect(verdictOf(signatureNames("fn other() { }", "h", ["Request"], "parameter", "rust")))
      .toBe("withheld/not-declared");
  });

  it("a name that is not a function", () => {
    expect(verdictOf(signatureNames("struct Request { a: u8 }", "Request", ["Foo"], "parameter", "rust")))
      .toBe("withheld/no-signature");
  });

  it("`returns` asked of a function that declares no return type", () => {
    expect(verdictOf(signatureNames("fn h(a: &Foo) { }", "h", ["Client"], "return", "rust")))
      .toBe("withheld/untyped-return");
  });

  it("`returns` asked of JavaScript, which writes none", () => {
    expect(verdictOf(signatureNames("function h(a) { return 1; }", "h", ["Client"], "return", "js")))
      .toBe("withheld/untyped-return");
  });

  /*
   * The bug the measurement found, and the most dangerous shape here: a name
   * declared more than once. `new`, `parse`, `from` -- and a method on two
   * `impl` blocks. Reading only the first declaration judges a signature that is
   * not the one the arrow is about, which was six wrong answers out of 159 on
   * real Rust.
   */
  it("reads every declaration of the name, not the first one it finds", () => {
    const source = [
      "impl A { fn make(x: &Other) -> Self { } }",
      "impl B { fn make(x: &Request) -> Self { } }",
    ].join("\n");
    expect(verdictOf(signatureNames(source, "make", ["Request"], "parameter", "rust")))
      .toBe("confirmed");
  });

  it("lets one doubtful declaration silence the rest", () => {
    // One of these two could be hiding `Request` behind `Req`, so nothing here
    // may refute -- even though the other signature is perfectly readable.
    const source = [
      "type Req = Request;",
      "impl A { fn make(x: &Other) -> Self { } }",
      "impl B { fn make(x: &Req) -> Self { } }",
    ].join("\n");
    expect(verdictOf(signatureNames(source, "make", ["Request"], "parameter", "rust")))
      .toBe("withheld/aliased");
  });

  /*
   * The narrowing that made the word usable. Every grammar gives a plain named
   * import the same node type as a renamed one, and treating them alike withheld
   * on 212 of 522 functions in this repository -- a word that ships and never
   * fires, which reads exactly like a claim that passed.
   */
  it("does not treat an ordinary import as a rename", () => {
    const source = 'import { Request } from "./m";\nfunction h(r: Nope) { }';
    expect(verdictOf(signatureNames(source, "h", ["Request"], "parameter", "ts")))
      .toBe("absent");
  });

  it("does not treat an unrelated alias as one that could be hiding the type", () => {
    // `Tone` is an alias and the signature uses it, but the signature does not
    // use the alias standing in for anything relevant. Withholding on any alias
    // anywhere in the file is what the over-broad version did.
    const source = 'type Tone = "bad" | "good";\nfunction h(t: Nope) { }';
    expect(verdictOf(signatureNames(source, "h", ["Request"], "parameter", "ts")))
      .toBe("absent");
  });
});
