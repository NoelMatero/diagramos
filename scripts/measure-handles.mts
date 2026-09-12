/**
 * Can the dispatch reader be trusted with a red?
 *
 * `AGENTS.md`'s gate, for `@handles`. The reader in `src/engine/handles.ts`
 * walks a tree-sitter tree and reads grammar fields; `scripts/lib/dispatch-scan.ts`
 * reads lines of text with four regexes and knows nothing about node types.
 * This counts the case labels in every file both ways and reports the
 * disagreement, per language.
 *
 * Prints and never fails, like every other measurement here.
 *
 * ## The two numbers that decide a licence, and they are not the same number
 *
 * A word that accuses from an absence can be wrong in two directions and only
 * one of them is recoverable:
 *
 *   invented   the reader reports a case the referee does not see. On a board
 *              this is an `extra` case -- the reader telling somebody their
 *              picture is missing a case the code does not actually have. A
 *              false red.
 *   missed     the reader does not report a case the referee sees. On a board
 *              this is a `missing` case -- the reader telling somebody the
 *              routine has no arm for something it plainly handles. Also a
 *              false red, by the other half of the check.
 *
 * Both halves of `@handles` accuse, so unlike `@calls` or `@builds` there is no
 * direction that is merely quiet. Both numbers have to be near zero.
 *
 * ## What this cannot measure, said here rather than left to be discovered
 *
 * The comparison is per **file**, not per routine, because the referee does not
 * bound a dispatch -- doing so would make it a second copy of the reader and it
 * would fail in the same places. So a reader that put the right labels in the
 * wrong routine agrees with the referee and is not caught here. What guards
 * that is `tests/engine-handles.test.ts`'s scoping tests and the two-dispatch
 * refusal, not this number.
 *
 *   npm run measure:handles            the twelve pinned clones plus this repo
 *   npm run measure:handles -- --all   every disagreement, not the first 20
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { findDispatches } from "../src/engine/handles";
import { initEngine, languageOf, parseSource, type Language } from "../src/engine/parse";
import { labelsIn, type ScanLanguage } from "./lib/dispatch-scan";

const ALL = process.argv.includes("--all");
const HOME = process.env.HOME ?? "/Users/noelmatero";

/**
 * The trees, taken as they sit on disk.
 *
 * The twelve pinned clones the licence corpus already uses, plus this repo and
 * `rust-test`. Five languages throughout and never one -- a reader that misses
 * a language's spelling produces a confident wrong answer, which
 * `docs/reading-a-grammar.md` records happening four times in one sitting.
 */
const TREES = [
  path.resolve("src"),
  path.resolve("scripts"),
  `${HOME}/board-ai/rust-test`,
  ...[
    "anyhow", "ripgrep", "django-django", "pallets-flask", "pydantic-pydantic",
    "python-poetry-poetry", "encode-httpx", "vuejs-core", "vitejs-vite",
    "nestjs-nest", "TanStack-query", "excalidraw-excalidraw",
  ].map((name) => `${HOME}/board-ai/.corpus/${name}`),
];

/**
 * Not source anybody draws a board about.
 *
 * `.min.js` and vendored third-party trees are on this list for a stated
 * reason rather than to improve the number: they are build output. A minified
 * file has no line structure at all, so measuring a line-based referee against
 * a grammar on one measures minification. django ships `xregexp.min.js` and
 * `select2`, and between them they were 28 of JavaScript's 72 cases.
 */
const SKIP = /node_modules|\/out\/|\/\.git\/|\/target\/|\.venv|\/dist\/|\/build\/|\.min\.[cm]?js$|\/vendor\//;

/**
 * Every source file under a tree.
 *
 * `maxBuffer` is raised and a failure is *reported* rather than swallowed.
 * `measure-scripts-lose-trees-silently` is the reason: `find` plus a default
 * buffer plus a blanket `catch` had eight scripts here counting trees they
 * never read, and the number looked fine.
 */
function filesUnder(tree: string): string[] | undefined {
  if (!existsSync(tree)) return undefined;
  try {
    return execFileSync("find", [
      tree, "-type", "f",
      "(", "-name", "*.ts", "-o", "-name", "*.tsx", "-o", "-name", "*.js",
      "-o", "-name", "*.rs", "-o", "-name", "*.py", ")",
    ], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 })
      .split("\n").filter(Boolean).filter((file) => !SKIP.test(file)).sort();
  } catch (error) {
    console.log(`  !! ${tree}: ${(error as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

/** A multiset difference, so two of one label is not one of it. */
function without(from: readonly string[], other: readonly string[]): string[] {
  const left = [...other];
  const out: string[] = [];
  for (const name of from) {
    const at = left.indexOf(name);
    if (at >= 0) left.splice(at, 1);
    else out.push(name);
  }
  return out;
}

interface Row {
  files: number;
  filesWithADispatch: number;
  dispatches: number;
  cases: number;
  refereeCases: number;
  agreed: number;
  invented: number;
  missed: number;
  refused: number;
}

const empty = (): Row => ({
  files: 0, filesWithADispatch: 0, dispatches: 0, cases: 0, refereeCases: 0,
  agreed: 0, invented: 0, missed: 0, refused: 0,
});

const rows = new Map<Language, Row>();
const disagreements: Array<{
  file: string; language: Language; invented: string[]; missed: string[];
}> = [];

await initEngine();

console.log();
console.log("MEASURE:HANDLES -- the dispatch reader against a text scan of the same files");
console.log();

let treesRead = 0;
for (const tree of TREES) {
  const files = filesUnder(tree);
  if (files === undefined) {
    console.log(`  (${tree} is not on disk -- skipped)`);
    continue;
  }
  treesRead += 1;
  for (const file of files) {
    const language = languageOf(file);
    if (!language) continue;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const row = rows.get(language) ?? empty();
    row.files += 1;

    const tree_ = parseSource(source, language);
    if (!tree_) {
      rows.set(language, row);
      continue;
    }
    /*
     * Only the refereed half. A chain of equality tests is read by the reader
     * and refused by `checkHandles`, and counting it here would compare the
     * reader against a referee that cannot see it -- which is what the first
     * run of this script did, for 1,409 files.
     */
    const found = findDispatches(tree_, source, language)
      .filter((dispatch) => dispatch.kind === "cases");
    const readerCases = found.flatMap((dispatch) => dispatch.cases.map((one) => one.name));
    const refereeCases = labelsIn(source, language as ScanLanguage);

    row.dispatches += found.length;
    row.cases += readerCases.length;
    row.refereeCases += refereeCases.length;
    row.refused += found.reduce((sum, one) => sum + one.unreadable.length, 0);
    if (found.length > 0) row.filesWithADispatch += 1;

    const invented = without(readerCases, refereeCases);
    const missed = without(refereeCases, readerCases);
    row.agreed += readerCases.length - invented.length;
    row.invented += invented.length;
    row.missed += missed.length;
    if (invented.length > 0 || missed.length > 0) {
      disagreements.push({ file, language, invented, missed });
    }
    rows.set(language, row);
  }
}

console.log(`  ${treesRead} of ${TREES.length} trees read.`);
console.log();
console.log("  lang    files  with a dispatch  dispatches   cases  referee  agreed  invented  missed  refused");
let totals = empty();
for (const [language, row] of [...rows].sort()) {
  totals = {
    files: totals.files + row.files,
    filesWithADispatch: totals.filesWithADispatch + row.filesWithADispatch,
    dispatches: totals.dispatches + row.dispatches,
    cases: totals.cases + row.cases,
    refereeCases: totals.refereeCases + row.refereeCases,
    agreed: totals.agreed + row.agreed,
    invented: totals.invented + row.invented,
    missed: totals.missed + row.missed,
    refused: totals.refused + row.refused,
  };
  console.log(
    `  ${language.padEnd(7)} ${String(row.files).padStart(5)}  ${String(row.filesWithADispatch).padStart(15)}`
    + `  ${String(row.dispatches).padStart(10)}  ${String(row.cases).padStart(6)}`
    + `  ${String(row.refereeCases).padStart(7)}  ${String(row.agreed).padStart(6)}`
    + `  ${String(row.invented).padStart(8)}  ${String(row.missed).padStart(6)}`
    + `  ${String(row.refused).padStart(7)}`,
  );
}
console.log(
  `  ${"total".padEnd(7)} ${String(totals.files).padStart(5)}  ${String(totals.filesWithADispatch).padStart(15)}`
  + `  ${String(totals.dispatches).padStart(10)}  ${String(totals.cases).padStart(6)}`
  + `  ${String(totals.refereeCases).padStart(7)}  ${String(totals.agreed).padStart(6)}`
  + `  ${String(totals.invented).padStart(8)}  ${String(totals.missed).padStart(6)}`
  + `  ${String(totals.refused).padStart(7)}`,
);

const percent = (part: number, whole: number) =>
  whole === 0 ? "  n/a" : `${((part / whole) * 100).toFixed(2)}%`;
console.log();
console.log(`  invented: ${totals.invented} of ${totals.cases} cases the reader reports `
  + `(${percent(totals.invented, totals.cases)}) -- a case the referee cannot see.`);
console.log(`  missed:   ${totals.missed} of ${totals.refereeCases} the referee reports `
  + `(${percent(totals.missed, totals.refereeCases)}) -- a case the reader did not report.`);
console.log();
console.log("  Both halves of @handles accuse, so unlike @calls there is no direction that is");
console.log("  merely quiet: an invented case tells somebody their picture is short, a missed");
console.log("  one tells them their routine has no arm for something it handles.");

console.log();
console.log(`DISAGREEMENTS -- ${disagreements.length} ${disagreements.length === 1 ? "file" : "files"}`);
console.log("  Every one is read before any of the numbers above is quoted. See");
// Spelled out rather than written as a figure: `tests/measure-boards.test.ts`
// refuses a hand-typed number in a measurement's own output, because a number
// nobody computed is indistinguishable from one somebody measured.
console.log("  docs/claim-vocabulary.md item twenty-six for what each category was.");
console.log();
const shown = ALL ? disagreements : disagreements.slice(0, 20);
for (const one of shown) {
  console.log(`  ${one.file.replace(HOME, "~")} [${one.language}]`);
  if (one.invented.length > 0) console.log(`      reader only: ${one.invented.slice(0, 12).join(", ")}`);
  if (one.missed.length > 0) console.log(`      scan only:   ${one.missed.slice(0, 12).join(", ")}`);
}
if (!ALL && disagreements.length > shown.length) {
  console.log(`  ... ${disagreements.length - shown.length} more. --all prints every one.`);
}
console.log();
