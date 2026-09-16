#!/usr/bin/env node
/**
 * How often "this end lacks a body / signature / result / field list / base
 * list" is wrong, measured before any of it may go red (#297).
 *
 *   npm run measure:parts -- /Users/noelmatero/board-ai/.corpus/*
 *   npm run measure:parts -- <tree>... [--only=rust|python|ts] [--show=20]
 *
 * `parts.ts` reads each declaration's shape from tree-sitter fields. The
 * referees read the same names another way entirely:
 *
 *   TypeScript, TSX, JavaScript   the TypeScript compiler's own syntax tree
 *   Rust                          rust-analyzer, `textDocument/documentSymbol`
 *   Python                        pyright, `textDocument/documentSymbol`
 *
 * Every name a file declares is read once by `partsOf`, the call `drift.ts`
 * makes, and once by the referee over every declaration of that name in that
 * file. Four outcomes per part, and only one of them is expensive:
 *
 *   wrong lacks     the reader says "lacks", the referee says "has" -- a
 *                   false red waiting to happen. Any at all, and that part
 *                   may not accuse in that language.
 *   unrefereed      the reader says "lacks" and the referee cannot say.
 *                   Not proven wrong, not proven right, so it blocks too.
 *   agreed lacks    both say "lacks": the reds this is for.
 *   missed          the referee says "lacks" and the reader does not.
 *                   Costs a red that never fires, nothing more.
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { sourceFiles } from "./lib/source-files";
import { flatten, refereeParts, type RefereeReading } from "./lib/lsp-symbols";
import { createRustAnalyzerReferee } from "./lib/resolution-rust-lsp";
import { createPyrightLspReferee } from "./lib/resolution-python-lsp";

import { initEngine, languageOf, type Language } from "../src/engine/parse";
import { declaredShapes } from "../src/engine/body";
import { PARTS, partsOf, type Part } from "../src/engine/parts";

await initEngine();

const args = process.argv.slice(2);
const roots = args.filter((argument) => !argument.startsWith("--")).map((root) => path.resolve(root));
const only = args.find((argument) => argument.startsWith("--only="))?.slice(7);
const show = Number(args.find((argument) => argument.startsWith("--show="))?.slice(7) ?? 15);
if (roots.length === 0) {
  console.error("usage: measure-parts <tree>... [--only=rust|python|ts]");
  process.exit(1);
}

type Family = "ts" | "rust" | "python";
const familyOf = (language: Language): Family =>
  language === "rust" ? "rust" : language === "python" ? "python" : "ts";

type Outcome = "wrong" | "unrefereed" | "agreed" | "missed" | "agreedHas" | "wrongHas";
const tally = new Map<string, Record<Outcome, number>>();
const names = new Map<Language, { read: number; refereed: number }>();
const examples = new Map<string, string[]>();
const bump = (language: Language, part: Part, outcome: Outcome, example?: string) => {
  const key = `${language}\t${part}`;
  const row = tally.get(key) ?? { wrong: 0, unrefereed: 0, agreed: 0, missed: 0, agreedHas: 0, wrongHas: 0 };
  row[outcome] += 1;
  tally.set(key, row);
  if (example) {
    const list = examples.get(`${key}\t${outcome}`) ?? [];
    list.push(example);
    examples.set(`${key}\t${outcome}`, list);
  }
};

/** A 0-based line for a string offset, the way the engine counts offsets. */
const lineStarts = new Map<string, number[]>();
const lineAt = (source: string, offset: number) => {
  let starts = lineStarts.get(source);
  if (!starts) {
    starts = [0];
    for (let index = 0; index < source.length; index += 1) {
      if (source.charCodeAt(index) === 10) starts.push(index + 1);
    }
    lineStarts.clear();
    lineStarts.set(source, starts);
  }
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle; else high = middle - 1;
  }
  return low;
};

type RefereeByLine = Map<string, Record<Part, RefereeReading>>;

/** How many declarations the second, text referee had to answer for. */
let byText = 0;

/** Score one file, given what the referee says about each (line, name). */
function score(
  file: string, source: string, language: Language,
  referee: RefereeByLine | undefined,
  refereeRan = true,
) {
  const shapes = declaredShapes(source, language);
  if (!shapes) return;
  const counts = names.get(language) ?? { read: 0, refereed: 0 };
  names.set(language, counts);
  for (const [name, declarations] of shapes) {
    const ours = partsOf(source, name, language);
    if (!ours) continue;
    counts.read += 1;
    const theirs = declarations.map(({ nameNode }) => {
      const line = lineAt(source, nameNode.startIndex);
      const listed = referee?.get(`${line}\t${name}`);
      const silent = !listed || PARTS.every((part) => listed[part] === "unknown");
      if (!silent || !refereeRan) return listed;
      const text = declaringLine(source, line, name, language);
      if (text) byText += 1;
      return text ?? listed;
    });
    if (theirs.some((one) => one !== undefined)) counts.refereed += 1;
    const where = `${file}:${lineAt(source, declarations[0]!.nameNode.startIndex) + 1} ${name}`;
    for (const part of PARTS) {
      const readings = theirs.map((one) => one?.[part] ?? "unknown");
      const verdict: RefereeReading = readings.some((one) => one === "has")
        ? "has"
        : readings.every((one) => one === "lacks") ? "lacks" : "unknown";
      if (ours[part] === "lacks") {
        bump(language, part, verdict === "has" ? "wrong" : verdict === "lacks" ? "agreed" : "unrefereed",
          verdict === "lacks" ? undefined : where);
      } else if (verdict === "lacks") {
        bump(language, part, ours[part] === "has" ? "wrongHas" : "missed", where);
      } else if (ours[part] === "has" && verdict === "has") {
        bump(language, part, "agreedHas");
      }
    }
  }
}

/**
 * The second referee, for the lines the first one never classified.
 *
 * Both servers have blind spots, and neither is about syntax. pyright lists one
 * symbol per name per scope, so a property's getter hides behind its setter,
 * and it lists nothing declared inside a function -- which is most of Django's
 * test classes. rust-analyzer answers nothing at all for a file in no crate
 * (pydantic's `tests/pydantic_core/test.rs`) and skips `fn gen`, whose name is
 * a keyword in the 2024 edition.
 *
 * So the line itself is read, as text, for the keyword the language writes.
 * That is a third mechanism rather than the reader's: no tree, no server. It is
 * per-language by nature, which is fine in a referee -- `measure-holds.mts`'s
 * referee is a text scan for the same reason -- and it is why every square this
 * licenses can be traced to one of the two lists below.
 */
function declaringLine(
  source: string, line: number, name: string, language: Language,
): Record<Part, RefereeReading> | undefined {
  const text = source.split("\n")[line] ?? "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const routine = language === "python"
    ? new RegExp(`^\\s*(async\\s+)?def\\s+${escaped}\\s*[\\[(]`)
    : new RegExp(`\\bfn\\s+${escaped}\\s*[<(]`);
  const container = language === "python"
    ? new RegExp(`^\\s*class\\s+${escaped}\\s*[(:]`)
    : new RegExp(`\\b(struct|enum|trait|union|mod)\\s+${escaped}\\b`);
  if (routine.test(text)) {
    return refereeParts(12, language === "python" ? "" : text.trimEnd().endsWith(";") ? ";" : "}", language === "python");
  }
  if (container.test(text)) return refereeParts(5, "", language === "python");
  return undefined;
}

/** The TypeScript compiler's reading of one file. */
function typescriptReferee(file: string, source: string): RefereeByLine {
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX
    : /\.[mc]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const found: RefereeByLine = new Map();
  const visit = (node: ts.Node) => {
    const name = (node as { name?: ts.Node }).name;
    if (ts.isConstructorDeclaration(node)) {
      // The compiler gives a constructor no name; its keyword is where it is.
      const at = node.getStart(tree) + node.getText(tree).indexOf("constructor");
      found.set(`${tree.getLineAndCharacterOfPosition(at).line}\tconstructor`, {
        body: node.body ? "has" : "lacks", signature: "has", result: "has", fields: "lacks", bases: "lacks",
      });
    }
    if (name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name))) {
      let reading: Record<Part, RefereeReading> | undefined;
      if (ts.isFunctionLike(node)) {
        reading = {
          body: (node as { body?: ts.Node }).body ? "has" : "lacks",
          signature: "has", result: "has", fields: "lacks", bases: "lacks",
        };
      } else if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node)
        || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
        reading = { body: "lacks", signature: "lacks", result: "lacks", fields: "unknown", bases: "unknown" };
      }
      if (reading) {
        const line = tree.getLineAndCharacterOfPosition(name.getStart(tree)).line;
        found.set(`${line}\t${name.text}`, reading);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** The nearest enclosing directory holding `marker`, topmost first. */
function outermost(file: string, tree: string, marker: string): string {
  let best = tree;
  let found = false;
  for (let directory = path.dirname(file); directory.startsWith(tree); directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, marker))) { best = directory; found = true; }
    if (directory === tree) break;
  }
  return found ? best : tree;
}

for (const tree of roots) {
  const files = sourceFiles(tree).filter((file) => {
    const language = languageOf(file);
    return language !== undefined && (!only || familyOf(language) === only);
  });
  const byFamily = new Map<Family, string[]>();
  for (const file of files) {
    const family = familyOf(languageOf(file)!);
    byFamily.set(family, [...(byFamily.get(family) ?? []), file]);
  }

  for (const file of byFamily.get("ts") ?? []) {
    const source = readFileSync(file, "utf8");
    score(file, source, languageOf(file)!, typescriptReferee(file, source));
  }

  const rustFiles = byFamily.get("rust") ?? [];
  const crates = new Map<string, string[]>();
  for (const file of rustFiles) {
    const root = outermost(file, tree, "Cargo.toml");
    crates.set(root, [...(crates.get(root) ?? []), file]);
  }
  for (const [root, group] of crates) {
    const referee = await createRustAnalyzerReferee(root).catch((error: Error) => {
      console.error(`rust-analyzer unavailable at ${root}: ${error.message}`);
      return undefined;
    });
    if (referee) await referee.warmUp();
    let silent = 0;
    for (const file of group) {
      const source = readFileSync(file, "utf8");
      const symbols = referee ? await referee.documentSymbols(file) : undefined;
      if (!symbols) silent += 1;
      score(file, source, "rust", symbols ? byLine(symbols, source, false) : undefined);
    }
    referee?.close();
    console.error(`rust ${path.relative(tree, root) || "."}: ${group.length} files, ${silent} unanswered`
      + (referee && !referee.primedCleanly() ? " (server never said it was ready)" : ""));
  }

  const pythonFiles = byFamily.get("python") ?? [];
  if (pythonFiles.length > 0) {
    const referee = await createPyrightLspReferee(tree).catch((error: Error) => {
      console.error(`pyright unavailable at ${tree}: ${error.message}`);
      return undefined;
    });
    if (referee) {
      const first = pythonFiles[0]!;
      await referee.warmUp(first, readFileSync(first, "utf8"), 0);
    }
    let silent = 0;
    const batch = 8;
    for (let start = 0; start < pythonFiles.length; start += batch) {
      await Promise.all(pythonFiles.slice(start, start + batch).map(async (file) => {
        const source = readFileSync(file, "utf8");
        const symbols = referee ? await referee.documentSymbols(file) : undefined;
        if (!symbols) silent += 1;
        score(file, source, "python", symbols ? byLine(symbols, source, true) : undefined, true);
      }));
    }
    referee?.close();
    console.error(`python ${path.basename(tree)}: ${pythonFiles.length} files, ${silent} unanswered`);
  }
}

function byLine(symbols: Parameters<typeof flatten>[0], source: string, python: boolean): RefereeByLine {
  const lines = source.split("\n");
  const found: RefereeByLine = new Map();
  for (const symbol of flatten(symbols)) {
    const { start, end } = symbol.range;
    const text = start.line === end.line
      ? (lines[start.line] ?? "").slice(start.character, end.character)
      : [(lines[start.line] ?? "").slice(start.character), ...lines.slice(start.line + 1, end.line),
        (lines[end.line] ?? "").slice(0, end.character)].join("\n");
    found.set(`${symbol.line}\t${symbol.name}`, refereeParts(symbol.kind, text, python));
  }
  return found;
}

console.log(`\nparts, read from grammar fields, against each language's own tooling`);
console.log(`trees: ${roots.map((root) => path.basename(root)).join(", ")}\n`);
for (const [language, counts] of names) {
  console.log(`${language}: ${counts.read} names read, ${counts.refereed} of them seen by the referee`);
}
console.log(`${byText} declarations the servers did not classify, read off the line instead\n`);
console.log(["language", "part", "wrong lacks", "unrefereed", "agreed lacks", "missed", "wrong has", "licence"]
  .join("\t"));
for (const [key, row] of [...tally].sort()) {
  const [language, part] = key.split("\t");
  const licence = row.wrong === 0 && row.unrefereed === 0 && row.agreed > 0 ? "yes" : "no";
  console.log([language, part, row.wrong, row.unrefereed, row.agreed, row.missed, row.wrongHas, licence].join("\t"));
}
for (const [key, list] of [...examples].sort()) {
  const [language, part, outcome] = key.split("\t");
  if (outcome === "missed") continue;
  console.log(`\n${language} ${part} ${outcome} (${list.length}):`);
  for (const example of list.slice(0, show)) console.log(`  ${example}`);
}
const missed = [...examples].filter(([key]) => key.endsWith("\tmissed"));
if (missed.length > 0) {
  console.log("\nmissed lacks, a sample (cost: a red that never fires):");
  for (const [key, list] of missed.sort()) {
    const [language, part] = key.split("\t");
    console.log(`  ${language} ${part}: ${list.length}, e.g. ${list.slice(0, 3).join(" · ")}`);
  }
}
process.exit(0);
