/**
 * The field reader (#188), the second thing in this engine allowed to refute
 * from an absence.
 *
 * The relationship is the most ordinary thing a data type does: hold another
 * one. A struct field, an interface property, a dataclass attribute. There was
 * no word for it, so an author reaching for the nearest one wrote `@takes` and
 * was told their correct board was wrong -- which is the failure that costs
 * trust rather than merely wasting it.
 *
 * A field list is a closed region for the same reason a signature is: read the
 * declaration and "this type has no field of that type" is a fact about the
 * whole of it. So this may accuse, and everything that follows from that
 * applies -- the tests that matter most are the refusals. Each one under
 * "refuses rather than accuses" is a type whose field list is fully enumerable,
 * does not contain the name, and whose arrow is nevertheless right.
 *
 * `scripts/measure-holds.mts` asks the same question of whole repositories.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { heldTypes, type HoldsVerdict } from "../src/engine/holds";

beforeAll(async () => { await initEngine(); }, 120_000);

/** The verdict as one word, so a test reads as the sentence it is checking. */
function verdictOf(verdict: HoldsVerdict): string {
  return verdict.verdict === "withheld" ? `withheld/${verdict.why}` : verdict.verdict;
}

describe("a type whose field names the type", () => {
  it("confirms the case from the issue", () => {
    // The live red on orangutan's board: RouteInfo really does hold a handler
    // of that type, and the vocabulary had no way to say so.
    const source = [
      "pub struct RouteInfo {",
      "    pub path: String,",
      "    pub methods: Vec<String>,",
      "    pub handler: fn(&Request) -> Response,",
      "}",
    ].join("\n");
    const verdict = heldTypes(source, "RouteInfo", ["Response"], "rust");
    expect(verdict.verdict).toBe("confirmed");
    if (verdict.verdict !== "confirmed") return;
    expect(verdict.evidence.name).toBe("Response");
    expect(verdict.evidence.line).toBe(4);
    // Quotable, because a refutable verdict has to show what it read.
    expect(verdict.evidence.fields).toContain("handler");
  });
});

describe("the same rule, in four grammars", () => {
  it("reads a Python class attribute, which is an annotated assignment", () => {
    // The shape that read 0 twice: once in the census written for #187, once in
    // graphify, which has no Python field extractor at all. Python spells a
    // field as an annotated assignment in a class block, not a declaration.
    const source = [
      "class RouteInfo(Base):",
      "    path: str",
      "    handler: Response",
    ].join("\n");
    expect(verdictOf(heldTypes(source, "RouteInfo", ["Response"], "python"))).toBe("confirmed");
  });

  it("reads a TypeScript interface property", () => {
    const source = "interface RouteInfo { path: string; handler: Response; }";
    expect(verdictOf(heldTypes(source, "RouteInfo", ["Response"], "ts"))).toBe("confirmed");
  });

  it("reads a TypeScript class field", () => {
    const source = "class QueryClient { #queryCache: QueryCache; mount(): void {} }";
    expect(verdictOf(heldTypes(source, "QueryClient", ["QueryCache"], "ts"))).toBe("confirmed");
  });

  it("reads `type X = { ... }`, which carries no body field at all", () => {
    // `object_type` owns its members directly. The census skipped 41 of these in
    // one file before this case was written down.
    const source = "type RouteInfo = { path: string; handler: Response };";
    expect(verdictOf(heldTypes(source, "RouteInfo", ["Response"], "ts"))).toBe("confirmed");
  });
});

describe("reads through the wrappers a field is usually written in", () => {
  it("finds the type inside a generic", () => {
    // A field typed `Vec<RouteInfo>` holds a RouteInfo in every ordinary reading
    // of a diagram. A reader taking only the outermost name reports the
    // container and misses the thing being drawn.
    const source = "struct Router { routes: Vec<RouteInfo>, seen: HashMap<String, Client> }";
    expect(verdictOf(heldTypes(source, "Router", ["RouteInfo"], "rust"))).toBe("confirmed");
    expect(verdictOf(heldTypes(source, "Router", ["Client"], "rust"))).toBe("confirmed");
  });

  it("finds the type inside an array and a Promise", () => {
    const source = "interface Cache { items: Query[]; pending: Promise<Response>; }";
    expect(verdictOf(heldTypes(source, "Cache", ["Query"], "ts"))).toBe("confirmed");
    expect(verdictOf(heldTypes(source, "Cache", ["Response"], "ts"))).toBe("confirmed");
  });

  it("finds the type inside Optional and a Python collection", () => {
    // `Optional[Handler]` does hold a Handler, and a reader matching only the
    // outermost name says it does not.
    const source = [
      "class Router:",
      "    handler: Optional[Handler]",
      "    routes: list[Route]",
    ].join("\n");
    expect(verdictOf(heldTypes(source, "Router", ["Handler"], "python"))).toBe("confirmed");
    expect(verdictOf(heldTypes(source, "Router", ["Route"], "python"))).toBe("confirmed");
  });

  it("finds the type inside a qualified name", () => {
    // `NodeJS.Timeout` and `React.ReactNode` are one name with a namespace on
    // the front, and the box on the board is labelled with the last part of it.
    // The reader took the whole dotted string as the name and matched nothing.
    expect(verdictOf(heldTypes("interface S { t: NodeJS.Timeout; }", "S", ["Timeout"], "ts")))
      .toBe("confirmed");
    expect(verdictOf(heldTypes("interface P { c: React.ReactNode; }", "P", ["ReactNode"], "tsx")))
      .toBe("confirmed");
    expect(verdictOf(heldTypes("struct S { t: std::time::Duration }", "S", ["Duration"], "rust")))
      .toBe("confirmed");
  });

  it("finds the payload of a Rust enum variant", () => {
    const source = "enum Kind { Adhoc(Payload), Empty }";
    expect(verdictOf(heldTypes(source, "Kind", ["Payload"], "rust"))).toBe("confirmed");
  });
});

describe("says wrong, which is the whole point of the word", () => {
  it("refutes a field list that plainly does not name the type", () => {
    // Every name here means itself, the list is complete, and `Client` is not
    // in it. This is the one verdict that can fail a build.
    const source = "struct RouteInfo { path: String, methods: Vec<String> }";
    const verdict = heldTypes(source, "RouteInfo", ["Client"], "rust");
    expect(verdict.verdict).toBe("absent");
    if (verdict.verdict !== "absent") return;
    // Quotable: an accusation has to show what it read.
    expect(verdict.fields).toContain("methods");
  });

  it("does not confirm the arrow drawn the other way round", () => {
    // Direction carries information or the word is decoration: a claim that
    // comes back green whichever way it was drawn cannot be evidence of the
    // thing it asserts. RouteInfo holds a Response; Response holds nothing.
    const source = [
      "struct RouteInfo { handler: Response }",
      "struct Response { body: Vec<u8> }",
    ].join("\n");
    expect(verdictOf(heldTypes(source, "RouteInfo", ["Response"], "rust"))).toBe("confirmed");
    expect(verdictOf(heldTypes(source, "Response", ["RouteInfo"], "rust"))).toBe("absent");
  });
});

describe("refuses rather than accuses", () => {
  it("withholds when the type is an alias for something else", () => {
    // `RouteInfo` is a name for a type declared elsewhere. Its fields are not
    // here, so "not in this field list" is a fact about the wrong declaration.
    // The same shape `signature.ts` withholds on, and for the same reason.
    const source = "type RouteInfo = SomeOtherShape;";
    expect(verdictOf(heldTypes(source, "RouteInfo", ["Response"], "ts")))
      .toBe("withheld/aliased");
  });

  it("still confirms when a different field is aliased", () => {
    // The refusal is about the name that could be hiding the answer, not about
    // the declaration as a whole. Withholding here throws away a confirmation
    // the reader plainly has -- measured at 48% of every Python type before the
    // order of these two checks was fixed.
    const source = [
      "type Res = Response;",
      "interface RouteInfo { handler: Res; client: Client; }",
    ].join("\n");
    expect(verdictOf(heldTypes(source, "RouteInfo", ["Client"], "ts"))).toBe("confirmed");
  });

  it("withholds when a field's type is itself an alias in this file", () => {
    // `Res` is `Response` by another name, so the field list not saying
    // `Response` proves nothing at all. The signature reader's motivating case,
    // one relation over.
    const source = [
      "type Res = Response;",
      "interface RouteInfo { handler: Res; }",
    ].join("\n");
    expect(verdictOf(heldTypes(source, "RouteInfo", ["Response"], "ts")))
      .toBe("withheld/aliased");
  });

  it("withholds on a quoted Python annotation, rather than reading a string as an absence", () => {
    // `x: "RequestContent | None"` is how Python writes a forward reference and
    // the only way to annotate a type imported under `if TYPE_CHECKING`. The
    // names sit inside a string literal, the reader sees none of them, and
    // reporting that as absence is an accusation built on not having looked.
    //
    // The same bug #195 found in the signature reader, found independently here
    // by `measure-holds.mts`, which is the argument for both existing.
    const source = ["class C:", '    x: "RequestContent | None"'].join("\n");
    expect(verdictOf(heldTypes(source, "C", ["RequestContent"], "python")))
      .toBe("withheld/quoted");
  });

  it("withholds when the field list came out of a macro", () => {
    // Rust generates struct bodies, and tokens awaiting expansion are not a
    // field list anybody has read yet.
    const source = "make_struct! { RouteInfo, handler: Handler }";
    expect(verdictOf(heldTypes(source, "RouteInfo", ["Response"], "rust")))
      .toMatch(/^withheld\//);
  });

  it("withholds on a file it could only partly read", () => {
    const source = "struct RouteInfo { handler: fn(&Request) -> Response,";
    expect(verdictOf(heldTypes(source, "RouteInfo", ["Response"], "rust")))
      .toBe("withheld/incomplete");
  });

  it("refutes an absence in Python, now that its reader has been measured", () => {
    /*
     * This test asserted `withheld/unlicensed` for as long as Python had no
     * measured corpus, which was the right answer then: an accusation resting
     * on an unmeasured reader is the thing `licence.ts` exists to forbid.
     *
     * #198 measured it. `npm run measure:holds` reads 2,177 Python field
     * declarations against a referee that shares no machinery with this walk
     * and misses none of them, and `npm run measure:licence -- --only=python`
     * puts a pinned corpus behind the language. So the absence is now a
     * refutation, and `tests/engine-licence.test.ts` holds the guard that no
     * language reaches this point unmeasured.
     */
    const source = ["class RouteInfo:", "    path: str"].join("\n");
    expect(verdictOf(heldTypes(source, "RouteInfo", ["Response"], "python"))).toBe("absent");
  });

  it("confirms in Python without the licence having anything to do with it", () => {
    // Confirming never needed a licence: finding the name is evidence of the
    // name being there whoever is reading. This passed before #198 and after.
    const source = ["class RouteInfo:", "    handler: Response"].join("\n");
    expect(verdictOf(heldTypes(source, "RouteInfo", ["Response"], "python"))).toBe("confirmed");
  });

  it("withholds when nothing here declares the name", () => {
    expect(verdictOf(heldTypes("struct Other { a: u8 }", "RouteInfo", ["Response"], "rust")))
      .toBe("withheld/not-declared");
  });
});

/**
 * Fields a class declares inside its constructor (#303).
 *
 * The largest source of false reds #301 found: 7 of its 8, spread across vue,
 * nest, httpx, flask and poetry. In both languages the declaration is nowhere
 * in the class body, so a walk that stops at the first thing with a parameter
 * list reads the class as holding almost nothing and then refutes almost every
 * arrow drawn at one.
 *
 * `accesses.ts` already reads both shapes for member *names*
 * (`parameterProperties` and `selfAssigned`); what is new here is reading the
 * *type* off them, which is what a field claim is about.
 */
describe("a field declared in the constructor", () => {
  it("reads a TypeScript parameter property", () => {
    // vuejs-core/packages/reactivity/src/dep.ts: `class Link` declares `sub`
    // and `dep` in its constructor and nowhere else, and `Dep --holds--> Link`
    // drawn the other way round was one of #301's false reds.
    const source = [
      "export class Link {",
      "  version: number",
      "  constructor(",
      "    public sub: Subscriber,",
      "    public dep: Dep,",
      "  ) {}",
      "}",
    ].join("\n");
    expect(verdictOf(heldTypes(source, "Link", ["Dep"], "ts"))).toBe("confirmed");
  });

  it("reads a Python attribute annotated in `__init__`", () => {
    // encode-httpx/httpx/_models.py: `Response` holds a `Request` and says so
    // only on this line.
    const source = [
      "class Response:",
      "    def __init__(self, request=None):",
      "        self._request: Request | None = request",
    ].join("\n");
    expect(verdictOf(heldTypes(source, "Response", ["Request"], "python"))).toBe("confirmed");
  });

  it("reads through the wrapper on one of those, the way it does on a plain field", () => {
    // src/poetry/mixology/partial_solution.py and src/flask/json/tag.py are
    // both this: the type is inside a `list[..]` or a `dict[str, ..]`.
    const source = [
      "class PartialSolution:",
      "    def __init__(self) -> None:",
      "        self._assignments: list[Assignment] = []",
    ].join("\n");
    expect(verdictOf(heldTypes(source, "PartialSolution", ["Assignment"], "python")))
      .toBe("confirmed");
  });

  it("does not read a plain constructor parameter as a field", () => {
    /*
     * The direction this could buy a false green. `constructor(dep: Dep)`
     * with no modifier declares no member -- TypeScript's parameter properties
     * are the modifier, which is why `accesses.ts` reads it rather than the
     * position. A reader taking every parameter would confirm a field claim
     * off an argument that is thrown away at the end of the call.
     */
    const source = [
      "export class Link {",
      "  version: number",
      "  constructor(dep: Dep) { this.version = 0 }",
      "}",
    ].join("\n");
    expect(verdictOf(heldTypes(source, "Link", ["Dep"], "ts"))).toBe("absent");
  });

  it("does not read a Python local as a field, however it is annotated", () => {
    // A name annotated inside a method and never put on the instance is a
    // local. Counting one would make the class look like it holds everything
    // any of its methods mentions.
    const source = [
      "class Response:",
      "    def __init__(self) -> None:",
      "        scratch: Request = build()",
      "        self.code: int = 0",
    ].join("\n");
    expect(verdictOf(heldTypes(source, "Response", ["Request"], "python"))).toBe("absent");
  });

  it("leaves Rust alone, which declares every field on the struct", () => {
    // Rust has neither shape: a `new` in an `impl` block assigns fields that
    // the struct already lists. Nothing here should make a Rust absence
    // anything other than what it was.
    const source = [
      "pub struct Core { config: Config }",
      "impl Core {",
      "    pub fn new(request: Request) -> Self { Core { config: Config::new(request) } }",
      "}",
    ].join("\n");
    expect(verdictOf(heldTypes(source, "Core", ["Request"], "rust"))).toBe("absent");
  });
});

/**
 * A type used under another name (#303).
 *
 * `alias.ts` is the reader; these are the two shapes #300's fixtures found
 * going red in all three languages. Both are the documented promise in
 * `docs/drawing-guide-long.md`: "Nothing is reported either way when a field's
 * type could be written under another name."
 */
describe("a field whose type is the target under another name", () => {
  it("withholds on a Python alias declared in the same file", () => {
    // Python spells an alias as an ordinary module-level assignment, with no
    // keyword and no node type to say so. Rust and TypeScript passed this from
    // the day the word shipped; Python refuted it.
    const source = [
      "LocalReq = Request",
      "",
      "class Aliased:",
      "    request: LocalReq",
    ].join("\n");
    expect(verdictOf(heldTypes(source, "Aliased", ["Request"], "python")))
      .toBe("withheld/aliased");
  });

  it("withholds on an alias declared beside the type and imported plainly", () => {
    // `use crate::model::{Req, Request}` says nothing: both are plain imports,
    // and only model.rs knows that one of them is `pub type Req = Request`.
    const holder = [
      "use crate::model::{Req, Request};",
      "pub struct Aliased { pub request: Req }",
    ].join("\n");
    const model = [
      "pub struct Request { pub path: String }",
      "pub type Req = Request;",
    ].join("\n");
    expect(verdictOf(heldTypes(holder, "Aliased", ["Request"], "rust",
      { source: model, language: "rust" }))).toBe("withheld/aliased");
  });

  it("withholds on the same shape in Python and in TypeScript", () => {
    const pythonHolder = ["from .model import Req", "", "class Aliased:", "    request: Req"].join("\n");
    const pythonModel = ["class Request:", "    path: str", "", "Req = Request"].join("\n");
    expect(verdictOf(heldTypes(pythonHolder, "Aliased", ["Request"], "python",
      { source: pythonModel, language: "python" }))).toBe("withheld/aliased");

    const tsHolder = [
      'import type { Req } from "./model";',
      "export interface Aliased { request: Req }",
    ].join("\n");
    const tsModel = [
      "export interface Request { path: string }",
      "export type Req = Request;",
    ].join("\n");
    expect(verdictOf(heldTypes(tsHolder, "Aliased", ["Request"], "ts",
      { source: tsModel, language: "ts" }))).toBe("withheld/aliased");
  });

  it("still refutes a field list with no alias in it, in every language", () => {
    /*
     * The cost side, and the reason the refusal is a set of names rather than a
     * flag on a file: a field list whose every name means itself is still a
     * closed region, whatever else the target's file happens to declare.
     */
    const model = ["pub struct Request { pub path: String }", "pub type Req = Request;"].join("\n");
    const holder = ["use crate::model::Request;", "pub struct Empty { pub n: usize }"].join("\n");
    expect(verdictOf(heldTypes(holder, "Empty", ["Request"], "rust",
      { source: model, language: "rust" }))).toBe("absent");

    const pythonModel = ["class Request:", "    path: str", "", "Req = Request"].join("\n");
    const pythonHolder = ["from .model import Request", "", "class Empty:", "    n: int"].join("\n");
    expect(verdictOf(heldTypes(pythonHolder, "Empty", ["Request"], "python",
      { source: pythonModel, language: "python" }))).toBe("absent");
  });
});

describe("what a top-level binding has to do before it counts as an alias", () => {
  it("does not read a name that is only annotated as one", () => {
    /*
     * vuejs-core/packages/reactivity/src/computed.ts declares two of these and
     * brands `ComputedRefImpl` with both. Reading `declare const X: unique
     * symbol` as a name for something else silenced a field list that was
     * fully readable, and cost a planted mistake its red.
     *
     * A name that is only annotated declares a thing. A name bound to another
     * name is a name for that thing, and only the second can hide a type.
     */
    const source = [
      "declare const Brand: unique symbol",
      "export class Ref {",
      "  readonly [Brand]: true",
      "  n: number",
      "}",
    ].join("\n");
    expect(verdictOf(heldTypes(source, "Ref", ["Request"], "ts"))).toBe("absent");
  });

  it("still reads one that is bound to another name", () => {
    const source = ["LocalReq = Request", "", "class Aliased:", "    request: LocalReq"].join("\n");
    expect(verdictOf(heldTypes(source, "Aliased", ["Request"], "python")))
      .toBe("withheld/aliased");
  });
});
