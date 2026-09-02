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

  it("withholds an absence in a language whose reader has no licence", () => {
    /*
     * Python has a grammar and no measured corpus, so nothing has ever checked
     * how often this reader is wrong about Python -- and an accusation resting
     * on an unmeasured reader is the thing `licence.ts` exists to forbid.
     *
     * Confirming is fine and stays: finding the name is evidence of the name
     * being there whoever is reading. It is the *absence* that needs a licence,
     * because absence is a claim about the whole of something.
     */
    const source = ["class RouteInfo:", "    path: str"].join("\n");
    expect(verdictOf(heldTypes(source, "RouteInfo", ["Response"], "python")))
      .toBe("withheld/unlicensed");
  });

  it("still confirms in a language with no licence", () => {
    const source = ["class RouteInfo:", "    handler: Response"].join("\n");
    expect(verdictOf(heldTypes(source, "RouteInfo", ["Response"], "python"))).toBe("confirmed");
  });

  it("withholds when nothing here declares the name", () => {
    expect(verdictOf(heldTypes("struct Other { a: u8 }", "RouteInfo", ["Response"], "rust")))
      .toBe("withheld/not-declared");
  });
});
