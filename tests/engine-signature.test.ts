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

describe("a Rust constructor, which ends `-> Self`", () => {
  /*
   * The third time a correct board went red (#169, #188, #193), and the worst:
   * the other two were a word that did not exist. This one is `returns`, used
   * correctly, on an arrow that is right -- and the reader looked for `Error`,
   * found `Self`, and called it absent. Four of thirteen arrows on a generated
   * `anyhow` board went red this way, and nine per cent of every returning
   * function in the Rust corpus writes `Self` in its return type.
   */
  it("reads `Self` as the type the impl names", () => {
    const source = "struct Error;\nimpl Error { pub fn new<E>(error: E) -> Self { todo!() } }";
    const verdict = signatureNames(source, "new", ["Error"], "return", "rust");
    expect(verdict.verdict).toBe("confirmed");
    if (verdict.verdict !== "confirmed") return;
    // Quoted as written. The reader resolved it; the report still shows the
    // line the author would go and look at.
    expect(verdict.evidence.signature).toContain("Self");
  });

  it("reads `Self` in a trait impl as the concrete type, not the trait", () => {
    const source = "impl Display for Error { fn clone_it(&self, other: Self) -> u8 { 0 } }";
    expect(verdictOf(signatureNames(source, "clone_it", ["Error"], "parameter", "rust")))
      .toBe("confirmed");
    expect(verdictOf(signatureNames(source, "clone_it", ["Display"], "parameter", "rust")))
      .toBe("absent");
  });

  it("reads `Self` inside a generic return type", () => {
    const source = "impl Error { fn opt() -> Option<Self> { None } }";
    expect(verdictOf(signatureNames(source, "opt", ["Error"], "return", "rust")))
      .toBe("confirmed");
  });

  it("still says the arrow is the wrong way round", () => {
    // Resolving `Self` has to keep the orientation verdict, or the fix would
    // buy silence back at the price of the thing `takes`/`returns` are for.
    const source = "impl Error { fn new(e: u8) -> Self { todo!() } }";
    expect(verdictOf(signatureNames(source, "new", ["Error"], "parameter", "rust")))
      .toBe("misplaced");
  });

  it("still refutes an arrow that is genuinely wrong", () => {
    const source = "impl Error { fn new(e: u8) -> Self { todo!() } }";
    expect(verdictOf(signatureNames(source, "new", ["Database"], "return", "rust")))
      .toBe("absent");
  });

  /*
   * The two shapes where the enclosing type is not a plain name. Resolving is
   * strictly better where it works; where it does not, this is back to the rule
   * the rest of the file follows -- an accusation only from evidence that is
   * unambiguous, and silence everywhere else.
   */
  it("withholds when the impl is generic", () => {
    const source = "impl<T> Wrapper<T> { fn wrap(t: T) -> Self { todo!() } }";
    expect(verdictOf(signatureNames(source, "wrap", ["Wrapper"], "return", "rust")))
      .toBe("withheld/self-type");
  });

  it("withholds on a trait's own default method, where `Self` is whoever implements it", () => {
    const source = "trait Maker { fn make() -> Self where Self: Sized; }";
    expect(verdictOf(signatureNames(source, "make", ["Maker"], "return", "rust")))
      .toBe("withheld/self-type");
  });

  it("lets one unresolvable `Self` silence a readable declaration of the same name", () => {
    const source = [
      "impl Error { fn make() -> u8 { 0 } }",
      "impl<T> Wrapper<T> { fn make() -> Self { todo!() } }",
    ].join("\n");
    expect(verdictOf(signatureNames(source, "make", ["Database"], "return", "rust")))
      .toBe("withheld/self-type");
  });

  /*
   * Python spells the same idea `typing.Self` and does not reserve the word, so
   * the treatment is dropped for a file that declares a `Self` of its own.
   * TypeScript has no such word at all: `Self` there is an ordinary imported
   * name, and reading it as the enclosing class would invent the false red this
   * is removing.
   */
  it("reads Python's `Self` as the enclosing class", () => {
    const source = "class Node:\n    def clone(self) -> Self:\n        return self";
    expect(verdictOf(signatureNames(source, "clone", ["Node"], "return", "python")))
      .toBe("confirmed");
  });

  it("leaves a `Self` the file declares for itself alone", () => {
    const source = "class Self:\n    pass\n\nclass Node:\n    def clone(self) -> Self:\n        return self";
    expect(verdictOf(signatureNames(source, "clone", ["Self"], "return", "python")))
      .toBe("confirmed");
  });

  it("leaves TypeScript's `Self` alone, where it is an ordinary name", () => {
    const source = "class Box { grab(a: Self): number { return 1 } }";
    expect(verdictOf(signatureNames(source, "grab", ["Self"], "parameter", "ts")))
      .toBe("confirmed");
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
 * Python writes a type inside a string, and #195 is what that cost.
 *
 * `def unit_path(unit: "Path | FileSlice")` takes a `FileSlice`. To every
 * grammar here the annotation is a piece of text, so the reader saw no names at
 * all and called the correct arrow wrong. The quoted form is not an oddity: it
 * is how Python writes a forward reference and the only way to write a type
 * imported under `if TYPE_CHECKING:`, which are exactly the places a diagram
 * wants to draw an arrow.
 */
describe("a Python annotation written inside a string", () => {
  it("confirms the case from the issue", () => {
    const source = 'def unit_path(unit: "Path | FileSlice") -> Path:\n    return unit';
    const verdict = signatureNames(source, "unit_path", ["FileSlice"], "parameter", "python");
    expect(verdict.verdict).toBe("confirmed");
    if (verdict.verdict !== "confirmed") return;
    expect(verdict.evidence.name).toBe("FileSlice");
    // Quoted as written, the way a resolved `Self` is: the report shows the
    // line the author would go and look at.
    expect(verdict.evidence.signature).toContain('"Path | FileSlice"');
  });

  it("reads a quoted type inside a generic", () => {
    const source = 'def g(x: list["Foo"]) -> None: ...';
    expect(verdictOf(signatureNames(source, "g", ["Foo"], "parameter", "python")))
      .toBe("confirmed");
  });

  it("reads a quoted return type", () => {
    const source = 'def h(x: Path) -> "Bar": ...';
    expect(verdictOf(signatureNames(source, "h", ["Bar"], "return", "python")))
      .toBe("confirmed");
  });

  it("reads a type imported only under TYPE_CHECKING", () => {
    // The one shape where the quotes are compulsory: the name does not exist at
    // runtime, so it cannot be written any other way.
    const source = [
      "from typing import TYPE_CHECKING",
      "",
      "if TYPE_CHECKING:",
      "    from .slice import FileSlice",
      "",
      'def take(unit: "FileSlice") -> None: ...',
    ].join("\n");
    expect(verdictOf(signatureNames(source, "take", ["FileSlice"], "parameter", "python")))
      .toBe("confirmed");
  });

  it("refuses to refute the half that has one", () => {
    // The words inside the quotes were read by scanning text, not by parsing a
    // type. Finding a name proves it is there; not finding one proves nothing.
    const source = 'def unit_path(unit: "Path | FileSlice") -> Path:\n    return unit';
    expect(verdictOf(signatureNames(source, "unit_path", ["Database"], "parameter", "python")))
      .toBe("withheld/quoted-annotation");
  });

  it("still refutes the half that is written plainly", () => {
    /*
     * Asked of the claimed half only. A quoted parameter has no bearing on
     * whether the return type says what it says, and silencing both halves
     * would spend refutations this has no reason to spend.
     *
     * Shown in TypeScript, which is where a refutation is currently available:
     * the half-independence this is about is a property of the reader, and
     * whether the language may accuse at all is a separate question answered by
     * `mayAccuse` below. Written in Python it tested the two at once, and the
     * licence gate would have looked like it broke this rule when it does not.
     */
    const quoted = 'declare function unitPath(unit: "Path" | FileSlice): Path;';
    expect(verdictOf(signatureNames(quoted, "unitPath", ["Database"], "return", "ts")))
      .toBe("absent");
  });

  it("confirms an ordinary Python signature, and now accuses on a real absence", () => {
    /*
     * This is #198 arriving, and it is worth reading against what it replaced.
     *
     * #195 left the absence withheld because nothing had checked how often this
     * reader is blind about Python, and a fixed blindness is not evidence there
     * are no others. That is exactly what a referee buys, and Python had none.
     * It has one now: `npm run measure:signature` reads 4,002 Python type names
     * in 1,543 functions and misses none, and `licence.ts` carries a pinned
     * Python corpus behind the language.
     *
     * So `is_splittable_text` takes a `Path` and does not take a `FileSlice`,
     * and the board may be told so. The number this bought is on the record:
     * the reader went from refuting 0 of 1,543 Python functions to 1,404, and
     * still withholds 139 -- 71 aliased, 68 quoted.
     */
    const source = "def is_splittable_text(path: Path) -> bool: ...";
    expect(verdictOf(signatureNames(source, "is_splittable_text", ["Path"], "parameter", "python")))
      .toBe("confirmed");
    expect(verdictOf(signatureNames(source, "is_splittable_text", ["FileSlice"], "parameter", "python")))
      .toBe("absent");
  });

  it("leaves a TypeScript literal type alone, where the quotes mean themselves", () => {
    // `mode: "read" | "write"` is a type that means itself. Reading TypeScript's
    // quotes the way Python's are read would withhold on ordinary code and buy
    // nothing back.
    const source = 'function h(mode: "read" | "write") { }';
    expect(verdictOf(signatureNames(source, "h", ["Request"], "parameter", "ts")))
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
  it("refutes an absence in Python, now that its reader has been measured", () => {
    // `go` takes a `Request`. It does not take a `Client`, the parameter list is
    // right there, and since #198 the reader has a referee behind it that says
    // how often it is blind. `tests/engine-licence.test.ts` holds the guard that
    // no language reaches this point unmeasured.
    const source = "def go(r: Request) -> Response:\n    pass\n";
    expect(verdictOf(signatureNames(source, "go", ["Client"], "parameter", "python")))
      .toBe("absent");
  });

  it("confirms in Python without the licence having anything to do with it", () => {
    // Confirming never needed a licence: finding the name is the same evidence
    // a measured reader would have found. This passed before #198 and after.
    const source = "def go(r: Request) -> Response:\n    pass\n";
    expect(verdictOf(signatureNames(source, "go", ["Request"], "parameter", "python")))
      .toBe("confirmed");
  });

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
