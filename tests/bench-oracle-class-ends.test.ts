/**
 * #374: what the answer key says when a class sits at the far end of `@calls`
 * or at the near end of `@accesses`, and the two key errors #366 found that
 * are about reading the code rather than about the word.
 *
 * "main calls Parser" is true when main creates a Parser (`new Parser()`,
 * `Parser()`, `Parser::new()`, `Parser { .. }`) or calls any of Parser's
 * methods, and false when it does neither. "Installer reads config.width" is
 * true when one of Installer's methods reads it -- the rule #352 set for a
 * class at the near end of `@calls`.
 *
 * Asked of the real tools, per language. Every "can't tell" below is a shape
 * where the call could reach the class and the tool cannot see whether it
 * does; the key must not guess there in either direction.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOracle, type ClaimUnderTest, type Oracle } from "../scripts/lib/bench-oracle";
import { createTooling, type Language } from "../scripts/lib/bench-tooling";

/** A language server's round trip under a loaded suite; see resolution-rust-lsp.test.ts. */
const LIVE_TIMEOUT_MS = 60_000;

const hasRustAnalyzer = (() => {
  try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "class-ends-"));
  for (const [relative, text] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

function oracleOver(language: Language, files: Record<string, string>) {
  let root = "";
  let oracle: Oracle | undefined;
  beforeAll(async () => {
    root = tree(files);
    oracle = createOracle(await createTooling(language, root));
  }, LIVE_TIMEOUT_MS);
  afterAll(() => {
    oracle?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });
  return (word: ClaimUnderTest["word"], from: string, to: string, member?: string) =>
    oracle!.judge({ word, from, to, ...(member ? { member } : {}) });
}

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext" } });

describe("TypeScript: calling a class means creating one or calling its methods", () => {
  const judge = oracleOver("ts", {
    "tsconfig.json": TSCONFIG,
    "parser.ts": [
      "export interface Handler { handle(): void }",
      "export class Base { inherited(): number { return 1; } }",
      "export class Parser {",
      "  static fromText(text: string): Parser { return new Parser(); }",
      "  parse(): number { return 1; }",
      "}",
      "export class SubParser extends Parser {}",
      "export class Child extends Base { own(): number { return 2; } }",
      "export class Worker implements Handler { handle(): void {} }",
      "export class Lonely { solo(): number { return 1; } }",
      "export class Other { parse(): number { return 2; } }",
      "export class Sized { get size(): number { return 1; } }",
      "export interface Job { start: () => number; id: string }",
      "export function register(kind: unknown): void {}",
      "",
    ].join("\n"),
    "main.ts": [
      'import { Parser, SubParser, Child, Handler, Worker, Lonely, Other, Job, Sized, register } from "./parser";',
      "export function creates(): void { new Parser(); }",
      "export function usesMethod(p: Parser): number { return p.parse(); }",
      "export function usesStatic(): void { Parser.fromText(\"x\"); }",
      "export function createsSub(): void { new SubParser(); }",
      "export function usesInherited(c: Child): number { return c.inherited(); }",
      "export function throughInterface(h: Handler): void { h.handle(); }",
      "export function passesClass(): void { register(Lonely); }",
      "export function neither(): number { return 1 + 1; }",
      "export function othersMethod(o: Other): number { return o.parse(); }",
      "export function runsJob(j: Job): number { return j.start(); }",
      "export function readsGetter(s: Sized): number { return s.size; }",
      "export function readsJob(j: Job): string { return j.id; }",
      "export class Driver {",
      "  run(p: Parser): number { return p.parse(); }",
      "}",
      "",
    ].join("\n"),
  });

  it("is true when it creates one and calls no method", async () => {
    expect((await judge("calls", "main.ts#creates", "parser.ts#Parser")).truth).toBe("true");
  }, LIVE_TIMEOUT_MS);

  it("is true when it calls a method of one made elsewhere", async () => {
    expect(await judge("calls", "main.ts#usesMethod", "parser.ts#Parser"))
      .toEqual({ truth: "true", why: "it calls its routine parse" });
  }, LIVE_TIMEOUT_MS);

  it("is true when it calls a static method", async () => {
    expect(await judge("calls", "main.ts#usesStatic", "parser.ts#Parser"))
      .toEqual({ truth: "true", why: "it calls its routine fromText" });
  }, LIVE_TIMEOUT_MS);

  it("is true when it creates a subclass", async () => {
    expect(await judge("calls", "main.ts#createsSub", "parser.ts#Parser"))
      .toEqual({ truth: "true", why: "it creates SubParser, which is one" });
  }, LIVE_TIMEOUT_MS);

  it("cannot tell when it calls a method the class inherits", async () => {
    expect((await judge("calls", "main.ts#usesInherited", "parser.ts#Child")).truth).toBe("undecidable");
  }, LIVE_TIMEOUT_MS);

  it("cannot tell when it calls through an interface the class implements", async () => {
    expect((await judge("calls", "main.ts#throughInterface", "parser.ts#Worker")).truth).toBe("undecidable");
  }, LIVE_TIMEOUT_MS);

  it("cannot tell when the class is passed as a value", async () => {
    expect((await judge("calls", "main.ts#passesClass", "parser.ts#Lonely")).truth).toBe("undecidable");
  }, LIVE_TIMEOUT_MS);

  it("is false when it neither creates one nor calls a method", async () => {
    expect(await judge("calls", "main.ts#neither", "parser.ts#Parser"))
      .toEqual({ truth: "false", why: "it neither creates one nor calls any of its 2 members" });
  }, LIVE_TIMEOUT_MS);

  it("is true when it calls a field that holds a function", async () => {
    expect(await judge("calls", "main.ts#runsJob", "parser.ts#Job"))
      .toEqual({ truth: "true", why: "it calls its routine start" });
  }, LIVE_TIMEOUT_MS);

  it("is false when it only reads a getter, which runs code but is not a call anybody draws", async () => {
    expect((await judge("calls", "main.ts#readsGetter", "parser.ts#Sized")).truth).toBe("false");
  }, LIVE_TIMEOUT_MS);

  it("is false when it only reads a field", async () => {
    expect((await judge("calls", "main.ts#readsJob", "parser.ts#Job")).truth).toBe("false");
  }, LIVE_TIMEOUT_MS);

  it("is false when the same method name is called on an unrelated class", async () => {
    expect((await judge("calls", "main.ts#othersMethod", "parser.ts#Parser")).truth).toBe("false");
  }, LIVE_TIMEOUT_MS);

  it("reads a class at both ends through the near class's routines", async () => {
    expect(await judge("calls", "main.ts#Driver", "parser.ts#Parser"))
      .toEqual({ truth: "true", why: "its routine run calls it" });
  }, LIVE_TIMEOUT_MS);
});

describe("TypeScript: a class reads a member when one of its routines does", () => {
  const judge = oracleOver("ts", {
    "tsconfig.json": TSCONFIG,
    "config.ts": "export class Config { width = 1; height = 2; }\n",
    "render.ts": [
      'import { Config } from "./config";',
      "export class Renderer {",
      "  constructor(private config: Config) {}",
      "  draw(): number { return this.config.width; }",
      "}",
      "export class Idle {",
      "  constructor(private config: Config) {}",
      "  draw(): number { return this.config.height; }",
      "}",
      "export class Base { size(c: Config): number { return c.width; } }",
      "export class Child extends Base { draw(): number { return 0; } }",
      "",
    ].join("\n"),
  });

  it("is true when a method reads it", async () => {
    expect(await judge("accesses", "render.ts#Renderer", "config.ts#Config", "width"))
      .toEqual({ truth: "true", why: "its routine draw reads it" });
  }, LIVE_TIMEOUT_MS);

  it("is false when every method was read and none reads it", async () => {
    expect(await judge("accesses", "render.ts#Idle", "config.ts#Config", "width"))
      .toEqual({ truth: "false", why: "every routine of the type was read and none reads that type's width" });
  }, LIVE_TIMEOUT_MS);

  it("is still false when the far type declares no such member", async () => {
    expect((await judge("accesses", "render.ts#Renderer", "config.ts#Config", "depth")).truth).toBe("false");
  }, LIVE_TIMEOUT_MS);

  it("cannot tell when a base in the repository may be the one reading", async () => {
    const answer = await judge("accesses", "render.ts#Child", "config.ts#Config", "width");
    expect(answer.truth).toBe("undecidable");
    expect(answer.why).toMatch(/inherits from Base/);
  }, LIVE_TIMEOUT_MS);
});

/*
 * #366's key errors. TanStack's `useQuery` has three overload signatures and
 * then the one with a body; the key read only the first three and found no
 * call in any. Excalidraw's `_newElementBase` builds its element as an object
 * literal, which is how an interface or a union type is made.
 */
describe("TypeScript: key errors #366 found", () => {
  const judge = oracleOver("ts", {
    "tsconfig.json": TSCONFIG,
    "base.ts": "export function base(x: unknown): number { return 1; }\n",
    "query.ts": [
      'import { base } from "./base";',
      "export function useQ(a: string): number;",
      "export function useQ(a: number): number;",
      "export function useQ(a: boolean): number;",
      "export function useQ(a: unknown): number { return base(a); }",
      "",
    ].join("\n"),
    "element.ts": [
      "export interface Shape { id: string; x: number }",
      "export class Box { id = \"\"; area(): number { return 0; } }",
      "export const makeShape = (id: string) => {",
      "  const shape = { id, x: 0 };",
      "  return shape;",
      "};",
      "export function noLiteral(id: string): number { return id.length; }",
      "export interface Config { retries: number }",
      "export function configure(config: Config): Shape { return { id: String(config.retries), x: 0 }; }",
      "export function handsOn(): void { configure({ retries: 1 }); }",
      "export type Pair = [number, number] & { _brand: \"pair\" };",
      "export function pairOf<P extends Pair>(x: number): P { return [x, x] as P; }",
      "",
    ].join("\n"),
  });

  it("reads an overloaded function's body, not only its signatures", async () => {
    expect((await judge("calls", "query.ts#useQ", "base.ts#base")).truth).toBe("true");
  }, LIVE_TIMEOUT_MS);

  it("cannot tell whether an object literal is the interface it is said to build", async () => {
    expect((await judge("builds", "element.ts#makeShape", "element.ts#Shape")).truth).toBe("undecidable");
  }, LIVE_TIMEOUT_MS);

  it("cannot tell whether an array literal is the tuple alias it is said to build", async () => {
    expect((await judge("builds", "element.ts#pairOf", "element.ts#Pair")).truth).toBe("undecidable");
  }, LIVE_TIMEOUT_MS);

  it("still says false when its only literal is an options object of another type", async () => {
    expect((await judge("builds", "element.ts#handsOn", "element.ts#Shape")).truth).toBe("false");
  }, LIVE_TIMEOUT_MS);

  it("still says false for a class, which an object literal is not", async () => {
    expect((await judge("builds", "element.ts#makeShape", "element.ts#Box")).truth).toBe("false");
  }, LIVE_TIMEOUT_MS);

  it("still says false when there is no object literal", async () => {
    expect((await judge("builds", "element.ts#noLiteral", "element.ts#Shape")).truth).toBe("false");
  }, LIVE_TIMEOUT_MS);
});

describe("Python: calling a class means creating one or calling its methods", () => {
  const judge = oracleOver("python", {
    "parser.py": [
      "class Base:",
      "    def inherited(self) -> int:",
      "        return 1",
      "",
      "",
      "class Parser:",
      "    @staticmethod",
      "    def from_text(text: str) -> \"Parser\":",
      "        return Parser()",
      "",
      "    def parse(self) -> int:",
      "        return 1",
      "",
      "",
      "class SubParser(Parser):",
      "    pass",
      "",
      "",
      "class Child(Base):",
      "    def own(self) -> int:",
      "        return 2",
      "",
      "",
      "class Lonely:",
      "    def solo(self) -> int:",
      "        return 1",
      "",
      "",
      "class Sized:",
      "    @property",
      "    def size(self) -> int:",
      "        return 1",
      "",
      "",
      "def register(kind: object) -> None:",
      "    pass",
      "",
    ].join("\n"),
    "main.py": [
      "from parser import Parser, SubParser, Child, Lonely, Sized, register",
      "",
      "",
      "def creates() -> None:",
      "    Parser()",
      "",
      "",
      "def uses_method(p: Parser) -> int:",
      "    return p.parse()",
      "",
      "",
      "def uses_static() -> None:",
      "    Parser.from_text(\"x\")",
      "",
      "",
      "def creates_sub() -> None:",
      "    SubParser()",
      "",
      "",
      "def uses_inherited(c: Child) -> int:",
      "    return c.inherited()",
      "",
      "",
      "def passes_class() -> None:",
      "    register(Lonely)",
      "",
      "",
      "def neither() -> int:",
      "    return 1 + 1",
      "",
      "",
      "def reads_property(s: Sized) -> int:",
      "    return s.size",
      "",
    ].join("\n"),
  });

  it("is true when it creates one and calls no method", async () => {
    expect((await judge("calls", "main.py#creates", "parser.py#Parser")).truth).toBe("true");
  }, LIVE_TIMEOUT_MS);

  it("is true when it calls a method of one made elsewhere", async () => {
    expect(await judge("calls", "main.py#uses_method", "parser.py#Parser"))
      .toEqual({ truth: "true", why: "it calls its routine parse" });
  }, LIVE_TIMEOUT_MS);

  it("is true when it calls a static method", async () => {
    expect(await judge("calls", "main.py#uses_static", "parser.py#Parser"))
      .toEqual({ truth: "true", why: "it calls its routine from_text" });
  }, LIVE_TIMEOUT_MS);

  it("is true when it creates a subclass", async () => {
    expect(await judge("calls", "main.py#creates_sub", "parser.py#Parser"))
      .toEqual({ truth: "true", why: "it creates SubParser, which is one" });
  }, LIVE_TIMEOUT_MS);

  it("cannot tell when it calls a method the class inherits", async () => {
    expect((await judge("calls", "main.py#uses_inherited", "parser.py#Child")).truth).toBe("undecidable");
  }, LIVE_TIMEOUT_MS);

  it("cannot tell when the class is passed as a value", async () => {
    expect((await judge("calls", "main.py#passes_class", "parser.py#Lonely")).truth).toBe("undecidable");
  }, LIVE_TIMEOUT_MS);

  it("is false when it only reads a property", async () => {
    expect((await judge("calls", "main.py#reads_property", "parser.py#Sized")).truth).toBe("false");
  }, LIVE_TIMEOUT_MS);

  it("is false when it neither creates one nor calls a method", async () => {
    expect(await judge("calls", "main.py#neither", "parser.py#Parser"))
      .toEqual({ truth: "false", why: "it neither creates one nor calls any of its 2 members" });
  }, LIVE_TIMEOUT_MS);
});

describe("Python: a class reads a member when one of its routines does", () => {
  const judge = oracleOver("python", {
    "config.py": "class Config:\n    width: int = 1\n    height: int = 2\n",
    "render.py": [
      "from config import Config",
      "",
      "",
      "class Renderer:",
      "    def __init__(self, config: Config) -> None:",
      "        self.config = config",
      "",
      "    def draw(self) -> int:",
      "        return self.config.width",
      "",
      "",
      "class Idle:",
      "    def __init__(self, config: Config) -> None:",
      "        self.config = config",
      "",
      "    def draw(self) -> int:",
      "        return self.config.height",
      "",
    ].join("\n"),
  });

  it("is true when a method reads it", async () => {
    expect(await judge("accesses", "render.py#Renderer", "config.py#Config", "width"))
      .toEqual({ truth: "true", why: "its routine draw reads it" });
  }, LIVE_TIMEOUT_MS);

  it("is false when every method was read and none reads it", async () => {
    expect(await judge("accesses", "render.py#Idle", "config.py#Config", "width"))
      .toEqual({ truth: "false", why: "every routine of the type was read and none reads that type's width" });
  }, LIVE_TIMEOUT_MS);
});

describe.skipIf(!hasRustAnalyzer)("Rust: calling a struct means creating one or calling its methods", () => {
  const judge = oracleOver("rust", {
    "Cargo.toml": '[package]\nname = "classends"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n',
    "src/lib.rs": "pub mod parser;\npub mod main;\n",
    "src/parser.rs": [
      "pub struct Parser { pub depth: u32 }",
      "",
      "impl Parser {",
      "    pub fn new() -> Parser { Parser { depth: 0 } }",
      "    pub fn parse(&self) -> u32 { self.depth }",
      "}",
      "",
      "pub trait Handler { fn handle(&self); }",
      "",
      "pub struct Worker;",
      "",
      "impl Handler for Worker { fn handle(&self) {} }",
      "",
      "pub struct Other;",
      "",
      "impl Other { pub fn parse(&self) -> u32 { 2 } }",
      "",
      "pub struct Config { pub width: u32, pub height: u32 }",
      "",
      "pub struct Renderer { pub config: Config }",
      "",
      "impl Renderer {",
      "    pub fn draw(&self) -> u32 { self.config.width }",
      "}",
      "",
      "pub struct Idle { pub config: Config }",
      "",
      "impl Idle {",
      "    pub fn draw(&self) -> u32 { self.config.height }",
      "}",
      "",
    ].join("\n"),
    "src/main.rs": [
      "use crate::parser::{Handler, Other, Parser, Worker};",
      "",
      "pub fn creates() -> u32 { let p = Parser::new(); 1 }",
      "pub fn literal() -> u32 { let p = Parser { depth: 1 }; 1 }",
      "pub fn uses_method(p: &Parser) -> u32 { p.parse() }",
      "pub fn through_trait(h: &dyn Handler) { h.handle(); }",
      "pub fn neither() -> u32 { 1 + 1 }",
      "pub fn others_method(o: &Other) -> u32 { o.parse() }",
      "",
    ].join("\n"),
  });

  it("is true when it calls the constructor", async () => {
    expect((await judge("calls", "src/main.rs#creates", "src/parser.rs#Parser")).truth).toBe("true");
  }, LIVE_TIMEOUT_MS);

  it("is true when it writes a struct literal", async () => {
    expect((await judge("calls", "src/main.rs#literal", "src/parser.rs#Parser")).truth).toBe("true");
  }, LIVE_TIMEOUT_MS);

  it("is true when it calls a method of one made elsewhere", async () => {
    expect(await judge("calls", "src/main.rs#uses_method", "src/parser.rs#Parser"))
      .toEqual({ truth: "true", why: "it calls its routine parse" });
  }, LIVE_TIMEOUT_MS);

  it("cannot tell when it calls through a trait the struct implements", async () => {
    expect((await judge("calls", "src/main.rs#through_trait", "src/parser.rs#Worker")).truth).toBe("undecidable");
  }, LIVE_TIMEOUT_MS);

  it("is false when it neither creates one nor calls a method", async () => {
    expect(await judge("calls", "src/main.rs#neither", "src/parser.rs#Parser"))
      .toEqual({ truth: "false", why: "it neither creates one nor calls any of its 3 members" });
  }, LIVE_TIMEOUT_MS);

  it("is false when the same method name is called on another struct", async () => {
    expect((await judge("calls", "src/main.rs#others_method", "src/parser.rs#Parser")).truth).toBe("false");
  }, LIVE_TIMEOUT_MS);

  it("reads a member through a struct's methods", async () => {
    expect(await judge("accesses", "src/parser.rs#Renderer", "src/parser.rs#Config", "width"))
      .toEqual({ truth: "true", why: "its routine draw reads it" });
  }, LIVE_TIMEOUT_MS);

  it("is false when no method of the struct reads it", async () => {
    expect(await judge("accesses", "src/parser.rs#Idle", "src/parser.rs#Config", "width"))
      .toEqual({ truth: "false", why: "every routine of the type was read and none reads that type's width" });
  }, LIVE_TIMEOUT_MS);
});
