/**
 * `@declared` and `@used`: what a box may claim about a symbol, and the comment
 * and string stripping that makes the claim mean anything.
 *
 * The negative tests are the ones that matter, as everywhere else in drift, but
 * this file has a second bar: the stripper is the one component whose bugs make
 * the check *louder*. So every lexer test below has a partner asserting that
 * confusion produces silence rather than a finding.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { parseSymbol, symbolEvidence } from "../src/engine/assert";
import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { languageOf } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

function fakeWorkspace(files: Record<string, string>): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => (files[target] === undefined ? "missing" : "file"),
    read: (target) => files[target] ?? "",
    list: () => [],
  };
}

async function boardWith(
  nodes: Array<{ id: string; label: string; ref?: string; refs?: string[] }>,
): Promise<BoardFile> {
  const result = await createDiagram(emptyBoard(), { name: "arch", nodes, edges: [] });
  return result.board;
}

beforeAll(async () => {
  await boardWith([{ id: "warmup", label: "Warm up" }]);
}, 60_000);

describe("reading an assertion off an anchor", () => {
  it("takes the two words, in either order, alone or together", () => {
    expect(parseSymbol("log_line")).toEqual({ symbol: "log_line" });
    expect(parseSymbol("log_line@declared")).toEqual({
      symbol: "log_line",
      assertion: { declared: true, used: false },
    });
    expect(parseSymbol("log_line@used")).toEqual({
      symbol: "log_line",
      assertion: { declared: false, used: true },
    });
    expect(parseSymbol("log_line@declared+used")).toEqual({
      symbol: "log_line",
      assertion: { declared: true, used: true },
    });
    expect(parseSymbol("log_line@used+declared")).toEqual({
      symbol: "log_line",
      assertion: { declared: true, used: true },
    });
  });

  it("refuses anything outside the whitelist instead of ignoring it", () => {
    // The alternative is a claim that silently checks nothing, which is worse
    // than no claim: the board would look more verified than it is.
    expect(parseSymbol("log_line@exported")).toEqual({ garbled: "exported" });
    expect(parseSymbol("log_line@declared+exported")).toEqual({ garbled: "declared+exported" });
    expect(parseSymbol("log_line@")).toEqual({ garbled: "" });
  });

  it("leaves a route alone, because a route may legitimately contain @", () => {
    expect(parseSymbol("/api/users/@me")).toEqual({ symbol: "/api/users/@me" });
  });
});

/**
 * The property the old lexer existed for, kept after the lexer went away.
 *
 * Without it, a file holding nothing but `/// Logs via log_line! and LOGGER.`
 * satisfies both anchors -- measured, and the worst row in
 * `docs/usage-brief.md`. There is no stripping pass any more, so these are no
 * longer tests of a blanking routine; they are tests that a name written in a
 * comment or a string never counts as a use of it. The parser gives that for
 * free, and "for free" is exactly the claim worth guarding.
 */
describe("a name in a comment or a string is not a use", () => {
  const uses = (file: string, source: string, name = "LOGGER") =>
    symbolEvidence(file, source, name)?.used;

  it("ignores a line comment and a string, in TypeScript", () => {
    expect(uses("a.ts", 'const a = "LOGGER"; // LOGGER\nconst b = LOGGER;\n')).toBe(1);
  });

  it("keeps template expressions, which are code, and ignores the text around them", () => {
    expect(uses("a.ts", "const m = `LOGGER ${LOGGER.name} LOGGER`;")).toBe(1);
  });

  it("is not fooled by quotes inside a regex literal", () => {
    // drift.ts is full of these, so it is not a hypothetical.
    expect(uses("a.ts", 'const RE = /["\']LOGGER/g;\nconst after = LOGGER;')).toBe(1);
  });

  it("does not mistake division for a regex", () => {
    expect(uses("a.ts", "const half = total / 2;\nconst LOGGER = 1;")).toBe(0);
  });

  it("reads JSX, where </div> and an apostrophe both look unterminated", () => {
    // Both .tsx files in src/ used to bail outright here. Bailing was safe, but
    // it threw away every other line in the file.
    expect(uses("a.tsx", "const v = <div className=\"x\">don't LOGGER</div>;\nconst u = LOGGER;\n"))
      .toBe(1);
  });

  it("handles nested block comments, which Rust has and TypeScript does not", () => {
    expect(uses("a.rs", "/* outer /* inner LOGGER */ still comment */ let x = LOGGER;")).toBe(1);
  });

  it("ignores raw strings, including the hashed forms", () => {
    expect(uses("a.rs", 'let a = r#"LOGGER"#; let b = br##"LOGGER"##; let c = LOGGER;')).toBe(1);
  });

  it("tells a char literal from a lifetime", () => {
    // `\'"\'` is a char whose body is a quote -- read as a lifetime it would
    // swallow the rest of the file into a string.
    expect(uses("a.rs", "fn f<\'a>(q: char) -> &\'a str { let c = \'\"\'; \"LOGGER\" }")).toBe(0);
  });

  it("allows a string to span lines, which is legal Rust and not legal TypeScript", () => {
    expect(uses("a.rs", 'let s = "first LOGGER\nsecond";\nlet t = LOGGER;')).toBe(1);
  });

  it("ignores a docstring, which is how Python writes a comment that is a string", () => {
    expect(uses("a.py", 'def f():\n    """mentions LOGGER"""\n    return 1\n')).toBe(0);
  });
});

describe("the declaration tables", () => {
  it("finds every way TypeScript introduces a name", () => {
    const source = [
      "export function alpha() {}",
      "export const beta = 1;",
      "class Gamma {",
      "  delta(x: number) {",
      "    return x;",
      "  }",
      "}",
      "export interface Epsilon { n: number }",
      "export type Zeta = string;",
    ].join("\n");
    for (const name of ["alpha", "beta", "Gamma", "delta", "Epsilon", "Zeta"]) {
      expect(symbolEvidence("a.ts", source, name)?.declared, name).toBe(true);
    }
  });

  it("finds every way the Rust file introduces a name", () => {
    const source = [
      "macro_rules! log_line { () => {} }",
      "lazy_static! { static ref LOGGER: usize = 0; }",
      "pub struct Client { pub id: usize }",
      "pub enum Mode { Read }",
      "pub trait Sink {}",
      "pub mod inner {}",
      "pub const CAP: usize = 8;",
      "impl Client { pub fn ready(&self) {} }",
    ].join("\n");
    for (const name of ["log_line", "LOGGER", "Client", "Mode", "Sink", "inner", "CAP", "ready"]) {
      expect(symbolEvidence("a.rs", source, name)?.declared, name).toBe(true);
    }
  });

  it("counts uses without counting the declaration", () => {
    const one = symbolEvidence("a.ts", "export function alpha() {}", "alpha")!;
    expect(one).toMatchObject({ declared: true, used: 0 });
    const two = symbolEvidence("a.ts", "export function alpha() {}\nalpha();", "alpha")!;
    expect(two).toMatchObject({ declared: true, used: 1 });
  });

  it("lets @used stand alone on a file that only consumes the symbol", () => {
    // This is why uses are counted as "occurrences minus declarations" and not
    // "more than one occurrence": on a consumer file a single mention is the
    // whole of the evidence.
    const consumer = symbolEvidence("a.ts", 'import { alpha } from "./b";\n', "alpha")!;
    expect(consumer).toMatchObject({ declared: false, used: 1 });
  });

  it("finds every way Python introduces a name", () => {
    const source = [
      "LOGGER = []",
      "def alpha(x):",
      "    return x",
      "class Gamma:",
      "    def delta(self):",
      "        pass",
    ].join("\n");
    for (const name of ["LOGGER", "alpha", "Gamma", "delta"]) {
      expect(symbolEvidence("a.py", source, name)?.declared, name).toBe(true);
    }
  });

  it("says nothing at all about a language it has no grammar for", () => {
    expect(symbolEvidence("a.rb", "def alpha\nend\n", "alpha")).toBeUndefined();
    expect(languageOf("a.rb")).toBeUndefined();
  });
});

/**
 * The measured table from `docs/usage-brief.md`, as fixtures.
 *
 * One box claiming a logging feature via two anchors, against every realistic
 * way that feature could stop being real. The plain mention check catches one
 * of these; the point of the assertions is the other nine.
 */
const RUST = [
  "//! An event-loop server. Logs through log_line! into LOGGER.",
  'use std::io::Write;',
  "use std::sync::Mutex;",
  "",
  "lazy_static! {",
  "    static ref LOGGER: Mutex<std::fs::File> = Mutex::new(open_log());",
  "}",
  "",
  "macro_rules! log_line {",
  "    ($($arg:tt)*) => {{",
  "        let msg = format!($($arg)*);",
  "        if let Ok(mut file) = LOGGER.lock() {",
  '            let _ = writeln!(file, "{}", msg);',
  "        }",
  "    }};",
  "}",
  "",
  "pub struct Client { pub id: usize }",
  "",
  "impl Client {",
  "    pub fn ready(&self) {",
  '        log_line!("ready {}", self.id);',
  "    }",
  "    pub fn handle_request(&self) {",
  '        log_line!("request {}", self.id);',
  "    }",
  "}",
  "",
  "pub fn reset_connection(client: &Client) {",
  '    log_line!("reset {}", client.id);',
  "}",
].join("\n");

const CALL_SITES = /^ *log_line!\("[^"]*", [^)]*\);$/gm;
const MACRO = /macro_rules! log_line \{[\s\S]*?\n\}\n/;
const STATIC = /lazy_static! \{[\s\S]*?\n\}\n/;

async function reportOn(source: string) {
  const board = await boardWith([
    {
      id: "log",
      label: "logging",
      ref: "src/lib.rs#LOGGER@declared+used",
      refs: ["src/lib.rs#log_line@declared+used"],
    },
  ]);
  return checkDrift(board, fakeWorkspace({ "src/lib.rs": source }));
}

describe("a logging box, against every way the logging could go", () => {
  it("is quiet on the untouched file", async () => {
    const report = await reportOn(RUST);
    expect(report).toMatchObject({ clean: true, findings: [], checked: 1 });
    // Both anchors were genuinely evaluated, not silently downgraded.
    expect(report.assertions).toEqual({ checked: 2, downgraded: 0, unsupportedLanguage: 0 });
  });

  const removals: Array<[string, string, "missing-declaration" | "unused-symbol" | "missing-symbol"]> = [
    ["all call sites, macro kept", RUST.replace(CALL_SITES, ""), "unused-symbol"],
    ["the macro, calls kept", RUST.replace(MACRO, ""), "missing-declaration"],
    ["the LOGGER static", RUST.replace(STATIC, ""), "missing-declaration"],
    [
      "the call sites, commented out rather than deleted",
      RUST.replace(CALL_SITES, (line) => `// ${line.trim()}`),
      "unused-symbol",
    ],
    [
      "the call sites, buried in a nested block comment",
      RUST.replace(CALL_SITES, (line) => `/* /* ${line.trim()} */ */`),
      "unused-symbol",
    ],
  ];

  for (const [what, source, kind] of removals) {
    it(`flags when someone removes ${what}`, async () => {
      const report = await reportOn(source);
      expect(report.clean).toBe(false);
      expect(report.findings.map((finding) => finding.kind)).toContain(kind);
    });
  }

  it("flags a file that keeps only a doc comment naming both symbols", async () => {
    // The worst row in the brief: this passes both anchors under the plain
    // mention check, because a name in a comment is a name in the file.
    const source = "//! Logs a message through log_line! into LOGGER.\npub fn nothing() {}\n";
    const report = await reportOn(source);
    expect(report.clean).toBe(false);
    expect(report.findings.every((finding) => finding.kind === "missing-declaration")).toBe(true);
    expect(report.findings).toHaveLength(2);
  });

  it("flags a file where the names survive only inside strings", async () => {
    const source = 'pub fn nothing() -> &\'static str { r#"log_line LOGGER"# }\n';
    const report = await reportOn(source);
    expect(report.clean).toBe(false);
  });

  it("still catches the whole feature vanishing, through the older check", async () => {
    const report = await reportOn("pub fn nothing() {}\n");
    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "missing-symbol",
      "missing-symbol",
    ]);
  });

  it("stays quiet when the only use is under cfg(test)", async () => {
    // A use is a use. Deciding that test-only usage does not count would be a
    // judgement about what tests are for, and that is not a lexical fact.
    const source = RUST.replace(CALL_SITES, "").concat(
      ['', "#[cfg(test)]", "mod tests {", '    fn t() { log_line!("x", 1); }', "}"].join("\n"),
    );
    const report = await reportOn(source);
    expect(report.clean).toBe(true);
  });
});

describe("what an assertion does not do", () => {
  it("leaves every ref without an @ exactly as it was", async () => {
    const board = await boardWith([
      { id: "log", label: "logging", ref: "src/lib.rs#log_line" },
    ]);
    // Nothing but a doc comment, which the plain mention check accepts by
    // design. Adding assertions must not change that for refs that never
    // asked for them.
    const report = checkDrift(
      board,
      fakeWorkspace({ "src/lib.rs": "//! Logs through log_line!.\n" }),
    );
    expect(report).toMatchObject({ clean: true });
    expect(report.assertions).toEqual({ checked: 0, downgraded: 0, unsupportedLanguage: 0 });
  });

  it("falls back to a mention and counts it when there is no table for the language", async () => {
    const board = await boardWith([
      { id: "log", label: "logging", ref: "src/app.rb#log_line@declared+used" },
    ]);
    const report = checkDrift(
      board,
      fakeWorkspace({ "src/app.rb": "# log_line is mentioned only here\n" }),
    );
    expect(report.clean).toBe(true);
    expect(report.assertions).toEqual({ checked: 0, downgraded: 0, unsupportedLanguage: 1 });
  });

  it("falls back to a mention and counts it when the lexer bails", async () => {
    const board = await boardWith([
      { id: "log", label: "logging", ref: "src/a.ts#alpha@declared+used" },
    ]);
    // An unterminated block comment. The claim cannot be judged, so it is not:
    // a stripper bug must be able to cost precision and never add a finding.
    const report = checkDrift(
      board,
      fakeWorkspace({ "src/a.ts": "/* alpha\nnever closed" }),
    );
    expect(report.clean).toBe(true);
    expect(report.assertions).toEqual({ checked: 0, downgraded: 1, unsupportedLanguage: 0 });
  });

  it("is loud the moment a garbled assertion is written", async () => {
    const board = await boardWith([
      { id: "log", label: "logging", ref: "src/a.ts#alpha@exported" },
    ]);
    const report = checkDrift(board, fakeWorkspace({ "src/a.ts": "export const alpha = 1;" }));
    expect(report.clean).toBe(false);
    expect(report.findings[0]).toMatchObject({ kind: "unresolvable-ref" });
    expect(report.findings[0].detail).toContain("@declared, @used, or @declared+used");
  });
});
