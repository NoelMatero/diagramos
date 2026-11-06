/**
 * The answer key reads a method written with its owner (#465).
 *
 * A box can name a method `parse`, `Parser.parse`, `Parser::parse` or
 * `Parser#parse`; the checker reads all four as `parse` since #409. The key
 * split the ref on every `#`, so `Parser#parse` was judged as the class
 * `Parser` and `Parser.parse` as a name nothing declares -- 17 of holdout-c's
 * 19 "correct arrows called wrong", and dozens of arrows left out of every
 * set's sample.
 *
 * The owner picks the declaration, which the checker's plain reading does
 * not: with two classes in a file declaring `parse`, `Lexer.parse` is
 * Lexer's, and never a local or parameter called `parse` inside one of
 * Parser's other methods. An owner that does not declare the name names
 * nothing.
 *
 * Asked of the real tools.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOracle, type Oracle } from "../scripts/lib/bench-oracle";
import { createTooling, type Language } from "../scripts/lib/bench-tooling";

/** A language server's round trip under a loaded suite; see resolution-rust-lsp.test.ts. */
const LIVE_TIMEOUT_MS = 60_000;

const hasRustAnalyzer = (() => {
  try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

function oracleOver(language: Language, files: Record<string, string>) {
  let root = "";
  let oracle: Oracle | undefined;
  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "owner-refs-"));
    for (const [relative, text] of Object.entries(files)) {
      const full = path.join(root, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
    oracle = createOracle(await createTooling(language, root));
  }, LIVE_TIMEOUT_MS);
  afterAll(() => {
    oracle?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });
  return {
    /** Which owner each declaration a ref could mean sits in, and its kind. */
    async read(ref: string): Promise<string[] | undefined> {
      const syms = await oracle!.candidates(ref);
      return syms?.map((s) => `${s.kind} ${s.name} in ${s.container ?? "-"}`).sort();
    },
    calls: (from: string, to: string) => oracle!.judge({ word: "calls", from, to }),
  };
}

/*
 * The same cases in each language: two owners declaring one name, an owner
 * that declares something else, an owner the file does not have, and the
 * function that calls only Parser's, and one that makes a Parser and calls
 * nothing.
 */
function ownerCases(file: string, impl: { parser: string; lexer: string }) {
  return (key: ReturnType<typeof oracleOver>) => {
    it("reads a plain name as every declaration of it, both methods among them", async () => {
      expect(await key.read(`${file}#parse`))
        .toEqual(expect.arrayContaining([`routine parse in ${impl.lexer}`, `routine parse in ${impl.parser}`]));
    }, LIVE_TIMEOUT_MS);

    for (const spelling of ["Parser.parse", "Parser::parse", "Parser#parse"]) {
      it(`reads ${spelling} as Parser's method, not the class, not Lexer's, not a local`, async () => {
        expect(await key.read(`${file}#${spelling}`)).toEqual([`routine parse in ${impl.parser}`]);
      }, LIVE_TIMEOUT_MS);
    }

    for (const spelling of ["Parser#parse@declared+used", "Parser.parse@used", "Parser::parse@declared"]) {
      it(`reads ${spelling} as Parser's method: what the box claims is not part of the name`, async () => {
        expect(await key.read(`${file}#${spelling}`)).toEqual([`routine parse in ${impl.parser}`]);
      }, LIVE_TIMEOUT_MS);
    }

    it("reads a plain name with a claim on it as the plain name", async () => {
      expect(await key.read(`${file}#run@declared+used`)).toEqual(["routine run in -"]);
    }, LIVE_TIMEOUT_MS);

    for (const spelling of ["Lexer.parse", "Lexer::parse", "Lexer#parse"]) {
      it(`reads ${spelling} as Lexer's`, async () => {
        expect(await key.read(`${file}#${spelling}`)).toEqual([`routine parse in ${impl.lexer}`]);
      }, LIVE_TIMEOUT_MS);
    }

    for (const spelling of ["Empty.parse", "Empty::parse", "Empty#parse"]) {
      it(`reads ${spelling} as nothing: Empty is there and declares no parse`, async () => {
        expect(await key.read(`${file}#${spelling}`)).toEqual([]);
      }, LIVE_TIMEOUT_MS);
    }

    it("reads an owner the file does not have as nothing", async () => {
      expect(await key.read(`${file}#Nowhere.parse`)).toEqual([]);
    }, LIVE_TIMEOUT_MS);

    it("still reads a class written alone as the class", async () => {
      expect((await key.read(`${file}#Parser`))?.some((s) => s.startsWith("type Parser"))).toBe(true);
    }, LIVE_TIMEOUT_MS);

    it("judges an arrow into the method it names", async () => {
      expect((await key.calls(`${file}#run`, `${file}#Parser#parse`)).truth).toBe("true");
      expect((await key.calls(`${file}#run`, `${file}#Parser.parse`)).truth).toBe("true");
    }, LIVE_TIMEOUT_MS);

    it("does not judge Parser#parse as the class: making a Parser is not calling parse", async () => {
      // Read as the class, `make -> Parser#parse` was true: make creates one.
      expect(await key.calls(`${file}#make`, `${file}#Parser#parse`))
        .toEqual({ truth: "false", why: "the routine's calls were read and none is it" });
    }, LIVE_TIMEOUT_MS);

    it("judges Lexer.parse as Lexer's: a call to Parser's is only a doubt about it", async () => {
      expect(await key.calls(`${file}#run`, `${file}#Lexer.parse`))
        .toEqual({ truth: "undecidable", why: "a call to another parse is here, and dispatch could reach this one" });
    }, LIVE_TIMEOUT_MS);
  };
}

describe("TypeScript: a method written with its class", () => {
  const key = oracleOver("ts", {
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext" } }),
    "shapes.ts": [
      "export class Parser {",
      "  parse(): number { return 1; }",
      "  size(): number { const parse = 3; return parse; }",
      "}",
      "export class Lexer { parse(): number { return 2; } }",
      "export class Empty { size(): number { return 0; } }",
      "export function run(): number { return new Parser().parse(); }",
      "export function make(): Parser { return new Parser(); }",
      "",
    ].join("\n"),
  });
  ownerCases("shapes.ts", { parser: "Parser", lexer: "Lexer" })(key);

  it("reads the file's own module name as the plain name", async () => {
    expect(await key.read("shapes.ts#shapes.run")).toEqual(["routine run in -"]);
  }, LIVE_TIMEOUT_MS);
});

describe("Python: a method written with its class", () => {
  const key = oracleOver("python", {
    "shapes.py": [
      "class Parser:",
      "    def parse(self) -> int:",
      "        return 1",
      "",
      "    def size(self, parse: int = 0) -> int:",
      "        return parse",
      "",
      "",
      "class Lexer:",
      "    def parse(self) -> int:",
      "        return 2",
      "",
      "",
      "class Empty:",
      "    def size(self) -> int:",
      "        return 0",
      "",
      "",
      "def run() -> int:",
      "    return Parser().parse()",
      "",
      "",
      "def make() -> Parser:",
      "    return Parser()",
      "",
    ].join("\n"),
  });
  ownerCases("shapes.py", { parser: "Parser", lexer: "Lexer" })(key);

  it("reads self as where it is written", async () => {
    expect(await key.read("shapes.py#self.parse")).toEqual(["routine parse in Lexer", "routine parse in Parser"]);
  }, LIVE_TIMEOUT_MS);
});

describe.skipIf(!hasRustAnalyzer)("Rust: a method written with its type", () => {
  const key = oracleOver("rust", {
    "Cargo.toml": '[package]\nname = "ownerrefs"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n',
    "src/lib.rs": "pub mod shapes;\n",
    "src/shapes.rs": [
      "pub struct Parser;",
      "impl Parser { pub fn parse(&self) -> u32 { 1 } }",
      "",
      "pub struct Lexer;",
      "impl Lexer { pub fn parse(&self) -> u32 { 2 } }",
      "",
      "pub struct Empty;",
      "impl Empty { pub fn size(&self) -> u32 { 0 } }",
      "",
      "pub trait Step { fn step(&self); }",
      "impl Step for Lexer { fn step(&self) {} }",
      "",
      "pub fn run() -> u32 { Parser.parse() }",
      "",
      "pub fn make() -> Parser { Parser }",
      "",
    ].join("\n"),
  });
  ownerCases("src/shapes.rs", { parser: "impl Parser", lexer: "impl Lexer" })(key);

  it("reads Self as where it is written", async () => {
    expect(await key.read("src/shapes.rs#Self::parse")).toEqual(["routine parse in impl Lexer", "routine parse in impl Parser"]);
  }, LIVE_TIMEOUT_MS);

  it("reads a trait's method in the trait and in each impl of it, and a type's in its impl only", async () => {
    expect(await key.read("src/shapes.rs#Step::step")).toEqual(["routine step in Step", "routine step in impl Step for Lexer"]);
    expect(await key.read("src/shapes.rs#Lexer::step")).toEqual(["routine step in impl Step for Lexer"]);
    expect(await key.read("src/shapes.rs#Parser::step")).toEqual([]);
  }, LIVE_TIMEOUT_MS);

  it("reads the file's own module name as the plain name", async () => {
    expect(await key.read("src/shapes.rs#shapes::run")).toEqual(["routine run in -"]);
  }, LIVE_TIMEOUT_MS);
});
