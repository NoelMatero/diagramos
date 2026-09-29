/**
 * "main calls Parser" where Parser is a class (#374): main creates a Parser
 * or calls one of its methods.
 *
 * The bad outcomes, before this: a correct arrow whose tail only calls
 * `p.parse()` was never confirmed, and one whose tail builds the class some
 * way that is not a call -- a Rust struct literal, a subclass, a method it
 * inherits -- was called wrong, because no call landed in the class's file.
 * anyhow's `construct -> ErrorImpl` was red on correct code for exactly that.
 *
 * Every correct shape below is asked for "not red", and the ones the checker
 * can see for "green". The guard the other way: an arrow whose tail neither
 * creates the class nor calls anything it declares is still called wrong.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { refereedCheckLive } from "../src/engine/referee-live";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

const HAS_CARGO = spawnSync("cargo", ["--version"]).status === 0;
/**
 * Placing `Parser::new()` or `p.parse()` in an `impl` two files away is
 * rust-analyzer's "go to definition"; without it the checker is quiet, which
 * is right, and CI has only rustup's proxy (see resolution-rust-lsp.test.ts).
 */
const HAS_RUST_ANALYZER = spawnSync("rust-analyzer", ["--version"]).status === 0;
const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

function tree(files: Record<string, string>): string {
  // Outside the worktree: a scratch source file inside one is read by the
  // dependency tests as though it belonged to this repository.
  const repo = mkdtempSync(path.join(tmpdir(), "calls-into-a-class-"));
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return repo;
}

type Said = "red" | "green" | "quiet";

async function said(repo: string, fromRef: string, toRef: string): Promise<{ said: Said; report: DriftReport }> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "tail", label: "tail", ref: fromRef },
      { id: "head", label: "head", ref: toRef },
    ],
    edges: [{ from: "tail", to: "head", claim: "calls" }],
  });
  const workspace = createWorkspace(repo);
  const { report } = await refereedCheckLive(repo, (referee) =>
    checkDrift(board as BoardFile, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));
  if (report.edges.some((finding) => ACCUSES.has(finding.kind))) return { said: "red", report };
  return { said: report.claims.callsConfirmed > 0 ? "green" : "quiet", report };
}

let repoOf: () => string = () => "";

function over(files: Record<string, string>) {
  let repo = "";
  beforeAll(() => { repo = tree(files); repoOf = () => repo; });
  afterAll(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });
  return async (from: string, to: string) => (await said(repo, from, to)).said;
}

describe("TypeScript", () => {
  const ask = over({
    "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
    "parser.ts": [
      "export interface Handler { handle(): void }",
      "export class Base { inherited(): number { return 1; } }",
      "export class Parser {",
      "  static fromText(text: string): Parser { return new Parser(); }",
      "  parse(): number { return 1; }",
      "}",
      "export class Worker implements Handler { handle(): void {} }",
      "export class Lonely { solo(): number { return 1; } }",
      "",
    ].join("\n"),
    // Kinds of Parser and of Base live in a file of their own, so a call that
    // lands in parser.ts says nothing about them.
    "kinds.ts": 'import { Base, Parser } from "./parser";\n'
      + "export class SubParser extends Parser {}\n"
      + "export class Child extends Base { own(): number { return 2; } }\n",
    "registry.ts": "export function register(kind: unknown): void {}\nexport function tally(n: number): number { return n + 1; }\n",
    // vite's mixedModuleGraph shape: each side calls the other.
    "graph.ts": [
      "export class Graph {",
      "  size(): number { return 1; }",
      "  report(): number { return measure(this); }",
      "}",
      "export function measure(g: Graph): number { return g.size(); }",
      "export function leaf(): number { return 1; }",
      // nest's ConfigurableModuleBuilder: a class declared inside a function.
      "export function build(): unknown {",
      "  class Inner {",
      "    static make(): number { return Inner.helper(); }",
      "    static helper(): number { return 1; }",
      "    run(): number { return Inner.make(); }",
      "  }",
      "  return Inner;",
      "}",
      "export class Caller {",
      "  run(): number { return leaf(); }",
      "}",
      "",
    ].join("\n"),
    "main.ts": [
      'import { Parser, Handler, Worker, Lonely } from "./parser";',
      'import { SubParser, Child } from "./kinds";',
      'import { register, tally } from "./registry";',
      "export function creates(): void { new Parser(); }",
      "export function usesMethod(p: Parser): number { return p.parse(); }",
      "export function usesStatic(): void { Parser.fromText(\"x\"); }",
      "export function createsSub(): void { new SubParser(); }",
      "export function usesInherited(c: Child): number { return c.inherited(); }",
      "export function throughInterface(h: Handler): void { h.handle(); }",
      "export function passesClass(): void { register(Lonely); }",
      "export function neither(): number { return tally(1); }",
      "export class Driver {",
      "  run(p: Parser): number { return p.parse(); }",
      "}",
      "",
    ].join("\n"),
  });

  it("confirms a tail that creates one and calls no method", async () => {
    expect(await ask("main.ts#creates", "parser.ts#Parser")).toBe("green");
  }, 120_000);

  it("confirms a tail that calls a method of one made elsewhere", async () => {
    expect(await ask("main.ts#usesMethod", "parser.ts#Parser")).toBe("green");
  }, 120_000);

  it("confirms a tail that calls a static method", async () => {
    expect(await ask("main.ts#usesStatic", "parser.ts#Parser")).toBe("green");
  }, 120_000);

  it("does not accuse a tail that creates a subclass", async () => {
    expect(await ask("main.ts#createsSub", "parser.ts#Parser")).not.toBe("red");
  }, 120_000);

  it("does not accuse a tail that calls a method the class inherits", async () => {
    expect(await ask("main.ts#usesInherited", "kinds.ts#Child")).not.toBe("red");
  }, 120_000);

  it("stays quiet on a call through an interface the class implements", async () => {
    expect(await ask("main.ts#throughInterface", "parser.ts#Worker")).toBe("quiet");
  }, 120_000);

  it("stays quiet when the class is passed as a value", async () => {
    expect(await ask("main.ts#passesClass", "parser.ts#Lonely")).toBe("quiet");
  }, 120_000);

  it("still calls wrong a tail that neither creates one nor calls a method", async () => {
    expect(await ask("main.ts#neither", "parser.ts#Parser")).toBe("red");
  }, 120_000);

  it("confirms a tail that calls a method of a class whose code calls it back", async () => {
    expect(await ask("graph.ts#measure", "graph.ts#Graph")).toBe("green");
  }, 120_000);

  it("confirms a method of a class declared inside a function calling its own class", async () => {
    expect(await ask("graph.ts#make", "graph.ts#Inner")).toBe("green");
  }, 120_000);

  it("still says backwards when only the class's code makes the call", async () => {
    const found = await said(repoOf(), "graph.ts#leaf", "graph.ts#Caller");
    expect(found.report.edges.map((finding) => finding.kind)).toEqual(["calls-backwards"]);
  }, 120_000);

  it("confirms a class at the tail through one of its methods", async () => {
    expect(await ask("main.ts#Driver", "parser.ts#Parser")).toBe("green");
  }, 120_000);
});

describe("Python", () => {
  const ask = over({
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
      "class Lonely:",
      "    def solo(self) -> int:",
      "        return 1",
      "",
    ].join("\n"),
    "kinds.py": "from parser import Base, Parser\n\n\nclass SubParser(Parser):\n    pass\n\n\n"
      + "class Child(Base):\n    def own(self) -> int:\n        return 2\n",
    "registry.py": "def register(kind: object) -> None:\n    pass\n\n\ndef tally(n: int) -> int:\n    return n + 1\n",
    "main.py": [
      "from parser import Parser, Lonely",
      "from kinds import SubParser, Child",
      "from registry import register, tally",
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
      "    return tally(1)",
      "",
    ].join("\n"),
  });

  it("confirms a tail that creates one and calls no method", async () => {
    expect(await ask("main.py#creates", "parser.py#Parser")).toBe("green");
  }, 120_000);

  it("confirms a tail that calls a method of one made elsewhere", async () => {
    expect(await ask("main.py#uses_method", "parser.py#Parser")).toBe("green");
  }, 120_000);

  it("confirms a tail that calls a static method", async () => {
    expect(await ask("main.py#uses_static", "parser.py#Parser")).toBe("green");
  }, 120_000);

  it("does not accuse a tail that creates a subclass", async () => {
    expect(await ask("main.py#creates_sub", "parser.py#Parser")).not.toBe("red");
  }, 120_000);

  it("does not accuse a tail that calls a method the class inherits", async () => {
    expect(await ask("main.py#uses_inherited", "kinds.py#Child")).not.toBe("red");
  }, 120_000);

  it("stays quiet when the class is passed as a value", async () => {
    expect(await ask("main.py#passes_class", "parser.py#Lonely")).toBe("quiet");
  }, 120_000);

  it("still calls wrong a tail that neither creates one nor calls a method", async () => {
    expect(await ask("main.py#neither", "parser.py#Parser")).toBe("red");
  }, 120_000);
});

describe.skipIf(!HAS_CARGO)("Rust", () => {
  const ask = over({
    "Cargo.toml": '[package]\nname = "intoclass"\nversion = "0.1.0"\nedition = "2021"\n',
    "src/lib.rs": "pub mod parser;\npub mod parse_impl;\npub mod main_mod;\npub mod flags;\npub mod ids;\n",
    // regex's `StateID`: `a >= b` runs the struct's derived `PartialOrd`, and
    // no call is written.
    "src/ids.rs": "#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]\npub struct Id {\n    pub n: u32,\n}\n\n"
      + "pub struct Span {\n    pub start: Id,\n    pub end: Id,\n}\n\n"
      + "pub fn later(s: &Span) -> bool {\n    s.end >= s.start\n}\n",
    // clap's shape: an enum variant that shares the struct's name.
    "src/flags.rs": "pub enum Flag {\n    Parser(u32),\n    Other(u32),\n}\n",
    "src/parser.rs": [
      "pub struct Parser {\n    pub depth: u32,\n}",
      "pub trait Handler {\n    fn handle(&self);\n    fn greet(&self) -> u32 {\n        1\n    }\n}",
      "pub struct Worker;",
      "impl Handler for Worker {\n    fn handle(&self) {}\n}",
      "pub struct Lonely;",
      "",
    ].join("\n\n"),
    // The impl is in another file, which is where Rust often keeps it.
    "src/parse_impl.rs": [
      "use crate::parser::Parser;",
      "impl Parser {\n    pub fn new() -> Parser {\n        Parser { depth: 0 }\n    }\n\n    pub fn parse(&self) -> u32 {\n        self.depth\n    }\n}",
      "",
    ].join("\n\n"),
    "src/main_mod.rs": [
      "use crate::parser::{Handler, Parser, Worker};",
      "pub fn literal() -> u32 {\n    let p = Parser { depth: 1 };\n    p.depth\n}",
      "pub fn constructs() -> u32 {\n    let p = Parser::new();\n    p.depth\n}",
      "pub fn uses_method(p: &Parser) -> u32 {\n    p.parse()\n}",
      "pub fn through_trait(h: &dyn Handler) {\n    h.handle();\n}",
      "pub fn default_method(w: &Worker) -> u32 {\n    w.greet()\n}",
      "pub fn tally(n: u32) -> u32 {\n    n + 1\n}",
      "pub fn neither() -> u32 {\n    tally(1)\n}",
      "",
    ].join("\n\n"),
  });

  it("confirms a tail that writes a struct literal", async () => {
    expect(await ask("src/main_mod.rs#literal", "src/parser.rs#Parser")).toBe("green");
  }, 300_000);

  it.skipIf(!HAS_RUST_ANALYZER)("confirms a tail that calls the constructor from an impl in another file", async () => {
    expect(await ask("src/main_mod.rs#constructs", "src/parser.rs#Parser")).toBe("green");
  }, 300_000);

  it.skipIf(!HAS_RUST_ANALYZER)("confirms a tail that calls a method from an impl in another file", async () => {
    expect(await ask("src/main_mod.rs#uses_method", "src/parser.rs#Parser")).toBe("green");
  }, 300_000);

  it("stays quiet on a call through a trait the struct implements", async () => {
    expect(await ask("src/main_mod.rs#through_trait", "src/parser.rs#Worker")).toBe("quiet");
  }, 300_000);

  it("still calls wrong a tail that neither creates one nor calls a method", async () => {
    expect(await ask("src/main_mod.rs#neither", "src/parser.rs#Parser")).toBe("red");
  }, 300_000);

  it.skipIf(!HAS_RUST_ANALYZER)("does not confirm an arrow at a file that only imports the class", async () => {
    // main_mod.rs writes `use crate::parser::Parser`, and declares no Parser.
    expect(await ask("src/main_mod.rs#uses_method", "src/main_mod.rs#Parser")).not.toBe("green");
  }, 300_000);

  it.skipIf(!HAS_RUST_ANALYZER)("does not confirm an arrow at an enum variant named like the struct", async () => {
    expect(await ask("src/main_mod.rs#uses_method", "src/flags.rs#Parser")).not.toBe("green");
  }, 300_000);

  it("does not accuse a tail that runs a derived method through an operator", async () => {
    expect(await ask("src/ids.rs#later", "src/ids.rs#Id")).not.toBe("red");
  }, 300_000);

  it("does not accuse a tail that calls a trait's default method on it", async () => {
    expect(await ask("src/main_mod.rs#default_method", "src/parser.rs#Worker")).not.toBe("red");
  }, 300_000);
});
