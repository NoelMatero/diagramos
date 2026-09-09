/**
 * The referee `@accesses` is licensed against, driven over source it should be
 * able to read.
 *
 * It reported 450 confirmations the member reader had failed to make, and most
 * of them were reads it had invented: file extensions inside a regular
 * expression, a Java package name inside a string, module paths inside an
 * import, and dotted names in type positions. One Python function was credited
 * with 24 member reads, every one of them from lines below that function's own
 * end -- so the routine boundary was wrong as well. (#222)
 *
 * A referee that invents is worse than one that misses: the recall it produces
 * is untrustworthy in both directions, and that recall is what `licence.ts`
 * cites as the reason a word may accuse.
 *
 * Driven as a command over fixture trees, because the printed totals are the
 * thing that was wrong.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts/measure-accesses.mts");
const TSX = path.join(REPO, "node_modules/.bin/tsx");

const trees: string[] = [];

function measure(files: Record<string, string>): string {
  const tree = mkdtempSync(path.join(os.tmpdir(), "measure-accesses-"));
  trees.push(tree);
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(tree, name), body);
  const run = spawnSync(TSX, [SCRIPT, "--all", tree], { cwd: REPO, encoding: "utf8" });
  return `${run.stdout ?? ""}${run.stderr ?? ""}`;
}

/** Every `A reads B` the report printed, which is what the referee claimed. */
function missed(report: string): string[] {
  return report.split("\n")
    .filter((line) => / reads /.test(line) && /^ {4}\S/.test(line))
    .map((line) => line.trim().split(" ").slice(-3).join(" "));
}

/** Every `A has no B` the report printed. The bar on these is zero. */
function accused(report: string): string[] {
  return report.split("\n")
    .filter((line) => / has no /.test(line) && /^ {4}\S/.test(line))
    .map((line) => line.trim().split(" ").slice(-4).join(" "));
}

afterAll(() => {
  for (const tree of trees) rmSync(tree, { recursive: true, force: true });
});

describe("what the accesses referee calls a member read", () => {
  it("does not lose a Python def to a docstring that mentions C comments", () => {
    /*
     * The `/* */` pass ran on Python, where those are not comments. The `/*`
     * in the docstring's third line paired with the `*` `/` down in the regex,
     * blanking the docstring's own closing `"""` on the way. The next `"""` in
     * the file then paired with the opening one, `def other` vanished with it,
     * and `strip_jsonc` stayed open and collected everything below. The real
     * site collected 24 reads on one line.
     */
    const report = measure({ "a.py": [
        "def strip_jsonc(text):",
        "    \"\"\"Strip // line comments, /* */ block comments, and trailing commas.",
        "",
        "    Preserves string contents (including // and /* inside strings) by",
        "    skipping quoted spans first.",
        "    \"\"\"",
        "    pattern = re.compile(",
        "        r'\"(?:\\\\.|[^\"\\\\])*\"'",
        "        r\"|/\\*.*?\\*/\"",
        "        r\"|//[^\\n]*\",",
        "    )",
        "    return pattern.sub('', text)",
        "",
        "def other():",
        "    \"\"\"Second docstring, which is what the first one pairs with.\"\"\"",
        "    return cfg.alpha",
        "",
      ].join("\n") });
    expect(missed(report)).toEqual([]);
    // Three reads, all confirmed: `re.compile` and `pattern.sub` in the first
    // routine, `cfg.alpha` in the second -- which has to exist to make it.
    expect(report).toMatch(/python\s+3\s+3\s+100\.0%/);
    // And no routine collected more than its own. Before the fix `strip_jsonc`
    // held every read in the file.
    expect(report).toContain("most member reads credited to one routine: 2");
  });

  it("does not read a directory name out of a regular expression", () => {
    const report = measure({ "b.ts": [
        "export function sourceFiles(all: string[]) {",
        "  return all.filter((one) => !/\\/(node_modules|\\.git|\\.venv)\\//.test(one));",
        "}",
        "",
      ].join("\n") });
    // `git` and `venv` sit inside a regular expression. Nothing reads a member
    // called `git` here, and the reader was blamed for not finding one.
    expect(missed(report)).toEqual([]);
  });

  it("does not read a dotted name out of a type position", () => {
    const report = measure({ "c.ts": [
        "export function programFrom(root: string): ts.Program | undefined {",
        "  const made: ts.Program | undefined = undefined;",
        "  const seen = root as NodeJS.ErrnoException;",
        "  return made ?? seen;",
        "}",
        "",
      ].join("\n") });
    // `ts.Program` is a namespaced type and `NodeJS.ErrnoException` is one
    // behind an `as`. Neither `Program` nor `ErrnoException` is a member of
    // anything. 86 of the 450 were this shape.
    expect(missed(report)).toEqual([]);
  });

  it("does not read a module path out of an import", () => {
    const report = measure({ "d.py": [
        "def dispatch():",
        "    from graphify.paths import out_path",
        "    from graphify.security import sanitize_label",
        "    return out_path, sanitize_label",
        "",
      ].join("\n") });
    // `graphify.paths` says where the name comes from. It is not a member read
    // off a value, and it was the single biggest cluster in the 450.
    expect(missed(report)).toEqual([]);
  });

  it("stops a routine where it ends, not where the next one is found", () => {
    const report = measure({ "e.ts": [
        "export function first(code: string) {",
        "  return /\\)\\s*(?::|=>|\\{)/.test(code);",
        "}",
        "",
        "for (const row of rows) {",
        "  totals.set(row.beta, 1);",
        "}",
        "",
      ].join("\n") });
    /*
     * The escaped brace inside that regular expression was counted as an
     * opening brace with nothing to close it, so `first` never ended and
     * `beta` was credited to it. The reader looks inside `first`, finds
     * nothing, and the referee calls that a miss. This is the exact line that
     * held `refereeTypes` in `measure-holds.mts` open for 130 lines.
     */
    expect(missed(report)).toEqual([]);
  });

  it("does not read a member off an inline object type in a one-line declaration", () => {
    const report = measure({ "f.ts": [
        "interface LspRange { start: { line: number; character: number } }",
        "export function useIt(range: LspRange) {",
        "  return range.start;",
        "}",
        "",
      ].join("\n") });
    // `character` belongs to the anonymous type inside `start`, not to
    // LspRange. The reader says LspRange has no `character` and is right --
    // and that lands in the column whose bar is zero.
    expect(accused(report)).toEqual([]);
  });

  it("ends a routine with no braces at the next line back at its own indent", () => {
    const report = measure({ "h.ts": [
        "const cell = (count: number, whole: number) => `${count}/${whole}`;",
        "for (const row of rows) {",
        "  totals.set(row.tier1, row.tier2);",
        "}",
        "",
      ].join("\n") });
    // `cell` is a whole routine on one line, so its brace depth never rises and
    // braces can never bring it back down. The `for` loop under it raised the
    // depth instead, and `tier1` and `tier2` were credited to `cell`.
    expect(missed(report)).toEqual([]);
  });

  it("does not end a routine whose body is written flat against the margin", () => {
    const report = measure({ "i.rs": [
        "pub struct Handler {",
        "    pub label: String,",
        "}",
        "",
        "#[handler]",
        "pub fn run(input: HandlerInput) -> Result<Response, GraphError> {",
        "let db = Arc::clone(&input.storage);",
        "let name = db.label.clone();",
        "Ok(name)",
        "}",
        "",
      ].join("\n") });
    /*
     * The guard on the rule above, and it is not hypothetical: closing every
     * routine on indentation looked tidier and took 616 real member reads out
     * of the corpus in one file. Generated code is not indented, and a routine
     * that did open a brace has a reliable end without needing the indent.
     */
    expect(missed(report)).toEqual([]);
    expect(report).toMatch(/rust\s+2\s+2\s+100\.0%/);
  });

  it("still reads a member a routine plainly reads", () => {
    const report = measure({ "g.ts": [
        "interface Config { width: number }",
        "export function measure(config: Config) {",
        "  return config.width;",
        "}",
        "",
      ].join("\n") });
    // The guard on all of the above. A referee that claims nothing agrees with
    // everything, and every recall in the report would read perfect.
    expect(report).toMatch(/ts\s+1\s+1\s+1\s+100\.0%/);
    expect(missed(report)).toEqual([]);
    expect(accused(report)).toEqual([]);
  });
});
