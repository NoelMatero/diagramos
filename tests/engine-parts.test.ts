/**
 * The reader behind the wrong-kind-of-end red (#297): what a declaration has,
 * read from the grammar's fields.
 *
 * One test per shape that occurs in real source rather than per branch, which
 * is what `AGENTS.md` asks for and what this reader especially needs: the
 * failure it must not have is a shape one language spells differently coming
 * back "lacks" when it has the thing. Every "unsure" below is a case the red
 * must stay silent about.
 *
 * `end-kind-claims.test.ts` is the other half: what a report says.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { initEngine, type Language } from "../src/engine/parse";
import { NEEDS, PARTS, PART_LICENCE, PART_NEEDED, PART_WORDS, partsOf } from "../src/engine/parts";
import { ARROW_CLAIMS } from "../src/engine/claim";

beforeAll(async () => { await initEngine(); }, 60_000);

const read = (source: string, name: string, language: Language) => partsOf(source, name, language);

describe("Rust", () => {
  const source = [
    "pub struct Client { pub buffer: Vec<u8> }",
    "pub struct Marker;",
    "pub struct Metres(f64);",
    "pub enum State { Idle, Busy { since: u64 } }",
    "pub trait Handler { fn handle(&self); }",
    "pub mod plumbing { pub fn go() {} }",
    "pub type Alias = Client;",
    "pub const LIMIT: usize = 4;",
    "pub fn receive(client: &Client) -> Vec<u8> { client.buffer.clone() }",
    "",
  ].join("\n");

  it("reads a struct as something with no result, no signature and no body", () => {
    expect(read(source, "Client", "rust")).toMatchObject({
      result: "lacks", signature: "lacks", body: "lacks", fields: "unsure",
    });
  });

  it("will not commit about a unit struct, which has no field list to read", () => {
    // `pub struct Marker;` has no body field at all, so nothing here saw the
    // shape. Silence is the right answer and a red would be a guess.
    expect(read(source, "Marker", "rust")?.result).toBe("unsure");
  });

  it("reads a tuple struct the same way as any other struct", () => {
    expect(read(source, "Metres", "rust")?.result).toBe("lacks");
  });

  it("reads an enum and a trait as containers", () => {
    expect(read(source, "State", "rust")?.signature).toBe("lacks");
    expect(read(source, "Handler", "rust")?.signature).toBe("lacks");
  });

  it("will not say a module has no body when code runs inside it", () => {
    expect(read(source, "plumbing", "rust")?.body).toBe("unsure");
  });

  it("says nothing about a type alias or a constant", () => {
    expect(read(source, "Alias", "rust")?.result).toBe("unsure");
    expect(read(source, "LIMIT", "rust")?.result).toBe("unsure");
  });

  it("reads a function as having a signature, a result and no fields", () => {
    expect(read(source, "receive", "rust")).toMatchObject({
      signature: "has", result: "has", body: "has", fields: "lacks", bases: "lacks",
    });
  });

  it("reads a function as never a type, and a struct as one", () => {
    expect(read(source, "receive", "rust")?.type).toBe("lacks");
    expect(read(source, "Client", "rust")?.type).toBe("has");
    // A constant whose value is written out in full is not a type either
    // (#307). Nor is one holding a function: the constant names a value of
    // that type and never the type itself, which the annotation settles
    // whatever the value turns out to be (#337) -- while `callable` stays
    // exactly as unsure as it was, because `fn() -> u32` is called all day.
    expect(read(source, "LIMIT", "rust")?.type).toBe("lacks");
    const maker = read("pub const MAKER: fn() -> u32 = build;\n", "MAKER", "rust");
    expect(maker?.type).toBe("lacks");
    expect(maker?.callable).toBe("unsure");
  });

  it("reads a trait method with no default as a function with no body", () => {
    expect(read(source, "handle", "rust")).toMatchObject({ signature: "has", body: "lacks" });
  });

  it("says nothing about a name that came out of a macro", () => {
    // `lazy_static!` is an ordinary way to declare a Rust global and no
    // grammar parses what is inside it, so its shape is unknown by definition.
    const macro = "lazy_static! { static ref LOGGER: Logger = Logger::new(); }\n";
    expect(read(macro, "LOGGER", "rust")?.result).toBe("unsure");
  });

  it("says nothing about a name the file does not declare", () => {
    expect(read(source, "Absent", "rust")).toBeUndefined();
  });
});

describe("TypeScript", () => {
  const source = [
    "export interface Options { width: number }",
    "export interface Sized { size(): number }",
    "export class Panel { title = \"\" }",
    "export enum Mode { On, Off }",
    "export namespace tools { export function go() {} }",
    "export type Draw = (panel: Panel) => void;",
    "export const draw: Draw = (panel) => { void panel; };",
    "export function render(options: Options): string { return String(options.width); }",
    "",
  ].join("\n");

  it("reads an interface, a class, an enum as containers", () => {
    for (const name of ["Options", "Panel", "Mode"]) {
      expect(read(source, name, "ts")).toMatchObject({ signature: "lacks", result: "lacks" });
    }
  });

  it("reads a method signature in an interface as a function with no body", () => {
    expect(read(source, "size", "ts")).toMatchObject({ signature: "has", body: "lacks" });
  });

  it("says nothing at all about a namespace", () => {
    // `internal_module` is not one of the shapes `body.ts` counts as
    // introducing a name, so no claim about it can ever be read here. Worth a
    // test because the silence is load-bearing: the red must not appear for a
    // declaration nothing looked at.
    expect(read(source, "tools", "ts")).toBeUndefined();
  });

  it("says nothing about a type alias or a const holding an arrow function", () => {
    // `draw` is a function, and the declaration that names it is a variable.
    // Reading the value would be a second mechanism; saying nothing costs a
    // red that never fires.
    expect(read(source, "Draw", "ts")?.signature).toBe("unsure");
    expect(read(source, "draw", "ts")?.fields).toBe("unsure");
  });

  it("takes the whole file's declarations of a name, not the first", () => {
    // TypeScript lets a type and a value share a name, and an overload is the
    // same shape: one declaration with a body, one without.
    const merged = [
      "export interface Handler { (event: string): void }",
      "export function Handler(event: string): void { void event; }",
      "",
    ].join("\n");
    expect(read(merged, "Handler", "ts")).toMatchObject({ signature: "has", fields: "unsure" });
  });

  it("does not say a class has no body when a field initialiser constructs something", () => {
    const running = "export class Panel { body = new Panel(); }\n";
    expect(read(running, "Panel", "ts")?.body).toBe("unsure");
  });
});

describe("Python", () => {
  const source = [
    "class Config:",
    "    width: int",
    "",
    "class Registry:",
    "    items = build()",
    "",
    "def render(config: Config) -> str:",
    "    return str(config.width)",
    "",
    "async def fetch(url: str) -> bytes:",
    "    return b\"\"",
    "",
    "draw = lambda config: config.width",
    "LIMIT = 4",
    "",
  ].join("\n");

  it("reads a class with only attributes as a container", () => {
    expect(read(source, "Config", "python")).toMatchObject({
      signature: "lacks", result: "lacks", body: "lacks",
    });
  });

  it("will not say a class has no body when its body calls something", () => {
    // A Python class body runs at import. `class Registry: items = build()`
    // really does call `build`, so a red saying it has no code in it would be
    // a false one.
    expect(read(source, "Registry", "python")?.body).toBe("unsure");
  });

  it("reads def and async def alike", () => {
    for (const name of ["render", "fetch"]) {
      expect(read(source, name, "python")).toMatchObject({
        signature: "has", result: "has", fields: "lacks", bases: "lacks",
      });
    }
  });

  it("says nothing about a name bound to a lambda or a number", () => {
    expect(read(source, "draw", "python")?.fields).toBe("unsure");
    expect(read(source, "LIMIT", "python")?.result).toBe("unsure");
  });
});

describe("a value written out in full (#307)", () => {
  const sources: Record<string, { file: string; source: string }> = {
    rust: {
      file: "src/lib.rs",
      source: [
        "pub const LIMIT: usize = 4;",
        "pub const NAME: &str = \"utf-8\";",
        "pub const SIZES: [u32; 3] = [1, 2, 3];",
        "pub const MAKER: fn() -> u32 = build;",
        "pub static READY: bool = true;",
        "pub fn build() -> u32 { 4 }",
        "",
      ].join("\n"),
    },
    python: {
      file: "src/limits.py",
      source: [
        "LIMIT = 4",
        "NAME = \"utf-8\"",
        "SIZES = [1, 2, 3]",
        "MAKER = build",
        "READY = True",
        "DRAW = lambda: 4",
        "MADE = build()",
        "",
        "def build():",
        "    return 4",
        "",
      ].join("\n"),
    },
    ts: {
      file: "src/limits.ts",
      source: [
        "export const LIMIT = 4;",
        "export const NAME = \"utf-8\";",
        "export const SIZES = [1, 2, 3];",
        "export const MAKER = build;",
        "export const READY = true;",
        "export const DRAW = () => 4;",
        "export const MADE = build();",
        "export function build() { return 4; }",
        "",
      ].join("\n"),
    },
  };

  it.each(Object.keys(sources))("in %s, a number, a string and a list cannot be called", (language) => {
    const { source } = sources[language]!;
    for (const name of ["LIMIT", "NAME", "SIZES", "READY"]) {
      expect(read(source, name, language as Language)).toMatchObject({
        callable: "lacks", type: "lacks", body: "lacks",
      });
    }
  });

  it.each(Object.keys(sources))("in %s, a value that is another name is never judged", (language) => {
    // `MAKER = build` is a function under another name, which is exactly the
    // case the silence is for.
    expect(read(sources[language]!.source, "MAKER", language as Language)?.callable).toBe("unsure");
  });

  it.each(["python", "ts"])("in %s, a lambda and a call's result are never judged", (language) => {
    const { source } = sources[language]!;
    expect(read(source, "DRAW", language as Language)?.callable).toBe("unsure");
    expect(read(source, "MADE", language as Language)?.callable).toBe("unsure");
  });

  it.each(["ts", "rust"])("does not call a type alias a plain value in %s", (language) => {
    // Found by the corpus: `readonly [string, string]` is keywords all the way
    // down, and `type Mode = "on" | "off"` is a value where a type belongs.
    const sources: Record<string, string> = {
      ts: "export type Tuple = readonly [string, string];\nexport type Mode = \"on\" | \"off\";\n",
      rust: "pub type Pair = (u32, u32);\n",
    };
    const names: Record<string, string[]> = { ts: ["Tuple", "Mode"], rust: ["Pair"] };
    for (const name of names[language]!) {
      expect(read(sources[language]!, name, language as Language)?.type).toBe("unsure");
      expect(read(sources[language]!, name, language as Language)?.callable).toBe("unsure");
    }
  });

  it("does not judge a type, which Python and Rust construct by calling it", () => {
    const source = "class Config:\n    width: int\n";
    expect(read(source, "Config", "python")?.callable).toBe("unsure");
  });
});

describe("a value with its type written beside it (#337)", () => {
  /*
   * One shape per way a value gets written down, in each grammar that has it.
   * The point of every case is the same: the name is a value, so nothing
   * `@builds` or `@holds` can be true of it -- and whether anything can *call*
   * it is a separate question its type answers, or refuses to.
   */
  it.each([
    ["rust", "pub struct Arg { pub(crate) settings: ArgFlags, }", "settings"],
    ["rust", "pub struct Parser { trailing_idx: Option<usize>, }", "trailing_idx"],
    ["ts", "export interface Job { readonly id: number }", "id"],
    ["ts", "export class Mutation { type: 'failed' }", "type"],
    ["python", "class Model:\n    retries: int\n", "retries"],
  ])("in %s, a field with a type written on it is not a type and cannot be called", (language, source, name) => {
    expect(read(source, name, language as Language)).toMatchObject({ type: "lacks", callable: "lacks" });
  });

  it.each([
    ["ts", "export class Query { status: QueryStatus }", "status"],
    ["python", "class Model:\n    complete: ClassVar[bool]\n", "complete"],
  ])("in %s, a field named by another type is a value, and may still be callable", (language, source, name) => {
    /*
     * `type QueryStatus = () => void` is a thing somebody can write, and this
     * file resolves no names, so the call half keeps its doubt. Rust needs no
     * such caution: there a value is callable only where its type says `fn`,
     * `Fn`, `dyn` or a bare parameter, whatever the name resolves to.
     */
    expect(read(source, name, language as Language)).toMatchObject({ type: "lacks", callable: "unsure" });
  });

  it.each([
    ["rust", "pub struct Vtable { object_drop: unsafe fn(Own<ErrorImpl>), }", "object_drop"],
    ["ts", "export interface Hooks { onDone: (value: number) => void }", "onDone"],
    ["python", "class Hooks:\n    on_done: Callable[[int], None]\n", "on_done"],
    ["ts", "export interface Hooks { onFail: FailureHandler }", "onFail"],
    // TanStack's `destroy: () => void`, found by the corpus: a function type
    // can be written with no word in it that is not a keyword.
    ["ts", "export interface Panel { destroy: () => void }", "destroy"],
    ["ts", "export interface Panel { at: { (): void } }", "at"],
  ])("in %s, a field whose type is a function keeps every doubt about calling it", (language, source, name) => {
    expect(read(source, name, language as Language)).toMatchObject({ type: "lacks", callable: "unsure" });
  });

  it.each([
    ["rust", "pub struct Held<F> { pub run: F, }", "run"],
    ["ts", "export class Held<F> { run: F }", "run"],
    ["python", "class Held:\n    run: F\n", "run"],
  ])("in %s, a bare type parameter says nothing either way", (language, source, name) => {
    // The bound that would settle it -- `F: Fn()`, `extends () => void` -- is
    // written somewhere else, so this end is not one to accuse anybody over.
    expect(read(source, name, language as Language)?.callable).toBe("unsure");
  });

  it.each([
    ["ts", "export const result: Record<string, string[]> = {};", "result"],
    ["ts", "export const rows = [];", "rows"],
    ["python", "values_dict: dict[str, str] = {}\n", "values_dict"],
    ["python", "operations: list[Operation] = []\n", "operations"],
  ])("in %s, an empty collection is a value written out in full", (language, source, name) => {
    expect(read(source, name, language as Language)).toMatchObject({ type: "lacks", callable: "lacks" });
  });

  it("a thing constructed is an instance, not a type and not callable", () => {
    const seen = read("export const seen = new WeakSet<Node>();", "seen", "ts");
    expect(seen).toMatchObject({ type: "lacks", callable: "lacks" });
  });

  it.each([
    ["ts", "export const run = (dep: Dep) => { dep.trigger(); };", "run"],
    ["python", "run = lambda dep: dep.trigger()\n", "run"],
  ])("in %s, a function written out is not a type, and is still callable", (language, source, name) => {
    expect(read(source, name, language as Language)).toMatchObject({ type: "lacks", callable: "unsure" });
  });

  it("a lambda under a type alias is never accused, whatever the alias says", () => {
    // vue's `transformElement: NodeTransform = (node, context) => {}`. Reading
    // the annotation alone and stopping there would put a red on an arrow that
    // is right, which is the one mistake this file may not make.
    const source = "export const transformElement: NodeTransform = (node, context) => { walk(node) };";
    expect(read(source, "transformElement", "ts")).toMatchObject({ type: "lacks", callable: "unsure" });
  });

  it("a Python alias written as an annotation is still a type", () => {
    const source = "Handler: TypeAlias = Callable[[], None]\n";
    expect(read(source, "Handler", "python")?.type).toBe("unsure");
  });

  it("a name declared twice is judged only where every declaration agrees", () => {
    // httpx's `unsatisfied = None` beside `unsatisfied = incompatibility`.
    const source = "unsatisfied = None\nunsatisfied = incompatibility\n";
    expect(read(source, "unsatisfied", "python")?.callable).toBe("unsure");
  });
});

describe("the two halves that must not drift apart", () => {
  it("has a need for every claim, and words for every part", () => {
    // The typed records make this a compile error too; the test is here
    // because a claim added with `from: undefined` compiles and says nothing.
    for (const claim of ARROW_CLAIMS) expect(NEEDS[claim]).toBeDefined();
    for (const part of PARTS) {
      expect(PART_WORDS[part]).toBeTruthy();
      expect(PART_NEEDED[part]).toBeTruthy();
    }
  });

  it("names a part every claim's need actually has a licence for", () => {
    for (const claim of ARROW_CLAIMS) {
      for (const end of ["from", "to"] as const) {
        const part = NEEDS[claim][end];
        if (!part) continue;
        expect(PARTS).toContain(part);
        for (const language of Object.keys(PART_LICENCE) as Array<keyof typeof PART_LICENCE>) {
          expect(typeof PART_LICENCE[language][part]).toBe("boolean");
        }
      }
    }
  });
});
