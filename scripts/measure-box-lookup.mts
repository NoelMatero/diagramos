#!/usr/bin/env node
/**
 * Every declaration a box could point at, looked up the way the checker looks
 * up a box (#464, #451, #462).
 *
 *   npm run measure:box-lookup                          -- main, holdout, holdout-b
 *   npm run measure:box-lookup -- --set=holdout --only=colinhacks-zod
 *   npm run measure:box-lookup -- --table               -- the tables from a finished run
 *   npm run measure:box-lookup -- --compare=<run dir>   -- this run against an earlier one, declaration by declaration
 *
 * ## Why
 *
 * The call census (#467) measures where the checker sends each call *inside*
 * a function. It never asks the step before: whether the checker finds the
 * function the box names at all. When it does not, no arrow touching that box
 * is checked, and nothing says so. The #468 trace found 8 of 20 arrows stuck
 * there -- `#dispatch`, `$ZodIssue`, and a function after a line the parser
 * could not read -- and no measurement had seen it.
 *
 * This needs no answer key. A second parser, one that shares nothing with the
 * checker's, lists every declaration in the file: the TypeScript compiler for
 * TypeScript and JavaScript, Python's own `ast` for Python, rust-analyzer's
 * document symbols for Rust. Each declaration is looked up by the name a board
 * would write for it, and the row says whether the checker found it there.
 *
 * ## What "found" means
 *
 * A box goes through three lookups before an arrow at it is read, and each is
 * a column:
 *
 *   box       the box check: does the file still mention the name (`mentions`)
 *   index     the declaration index most readers ask (`declaredShapes`)
 *   routines  the routine lookup `@calls`, `@accesses` and `@makes` ask
 *             (`routinesNamed`); only for functions, methods and types that
 *             hold methods, which is all it is asked about
 *
 * Each lookup is asked the way the checker asks it: the written name goes
 * through `spelledHere` first, which is where a board's name enters the
 * checker (#451). Before #464 that door did not exist and the name went in
 * as written, which is what the baseline run measured.
 *
 * A declaration is found when every lookup that applies returns it, at its own
 * line. It is found *wrong* when a lookup returns something under that name
 * that the second parser says is a different declaration, or no declaration at
 * all -- the private `#dispatch` answering for a public `dispatch`, say. A
 * wrong find is worse than a miss: a miss leaves an arrow unread, a wrong find
 * reads the wrong body and can call a correct arrow wrong.
 *
 * ## The name a board writes
 *
 * As declared, except: a TypeScript `#name` is written `name` (a ref is
 * `path#symbol`, so `##name` is not something anybody writes), and a Rust raw
 * identifier `r#type` is written `type` -- each unless the file also declares
 * the plain name, which then owns it.
 *
 * ## Shapes
 *
 * Per language: function, method, class, type. Across them: a `#private`
 * name, a name with `$`, a name with a letter outside ASCII, a Rust raw
 * identifier, and a declaration after the first line the checker's parser
 * could not read.
 *
 * Same files as the call census (tests, bundles, docs and `.d.ts` left out),
 * one child process per project, resumable by `.done`, waits for quiet
 * before each project. holdout-c is not a census set. Measure only.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitForQuiet } from "./lib/bench-busy";
import { CENSUS_SET_ORDER, censusSets, isTestPath } from "./lib/census-sets";
import { sourceFiles } from "./lib/source-files";

import { declaredShapes } from "../src/engine/body";
import { routinesNamed } from "../src/engine/calls";
import { mentions } from "../src/engine/drift";
import type { LspDocumentSymbol } from "../src/engine/lsp-symbols";
import * as parse from "../src/engine/parse";
import { initEngine, languageOf, parseSource, type Language, type Node } from "../src/engine/parse";
import { cargoRootsIn } from "../src/engine/referee-rust";
import { createRustAnalyzerReferee } from "../src/engine/referee-rust-lsp";

const HOME = os.homedir();
const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), "..");
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => argv.find((one) => one.startsWith(`--${name}=`))?.slice(name.length + 3);
const SETS = censusSets(REPO);

function defaultRunDirectory(): string {
  let head = "unknown";
  let dirty = "";
  try {
    head = execFileSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    if (execFileSync("git", ["-C", REPO, "status", "--porcelain", "--", "src"], { encoding: "utf8" }).trim()) dirty = "-dirty";
  } catch { /* not a checkout */ }
  return path.join(HOME, ".board-ai-box-lookup", `${head}${dirty}`);
}
const RUN = path.resolve(flag("out") ?? defaultRunDirectory());

const LANGS = ["ts", "python", "rust"] as const;
type Lang = (typeof LANGS)[number];
const langOf = (language: Language): Lang => (language === "python" ? "python" : language === "rust" ? "rust" : "ts");

/* ------------------------------------------------------- the second parser */

type Kind = "function" | "method" | "class" | "type" | "macro" | "value" | "impl";
/** One declaration as the second parser reads it. `line` is 1-based, where the name is written. */
interface Truth { name: string; line: number; kind: Kind; holdsRoutines?: boolean; lastLine?: number; inLiteral?: boolean }

const require_ = createRequire(import.meta.url);

function tsDeclarations(file: string, source: string): Truth[] {
  const ts = require_("typescript") as typeof import("typescript");
  const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const out: Truth[] = [];
  const lineOf = (node: import("typescript").Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const isFn = (node: import("typescript").Node | undefined) =>
    !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
  const methodsIn = (node: import("typescript").Node): boolean => {
    let found = false;
    const visit = (child: import("typescript").Node) => {
      if (found) return;
      // A method, not a function *type*: `onClose: () => void` declares no code.
      if (ts.isFunctionLike(child) && !ts.isFunctionTypeNode(child) && !ts.isConstructorTypeNode(child) && !ts.isIndexSignatureDeclaration(child)) {
        found = true;
        return;
      }
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
    return found;
  };
  const push = (name: import("typescript").Node | undefined, k: Kind, node: import("typescript").Node, holds?: boolean) => {
    if (!name || !(ts.isIdentifier(name) || ts.isPrivateIdentifier(name))) return;
    const inLiteral = ts.isObjectLiteralExpression(node.parent);
    out.push({ name: name.text, line: lineOf(name), kind: k, ...(holds !== undefined ? { holdsRoutines: holds } : {}),
      ...(inLiteral ? { inLiteral } : {}),
      lastLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1 });
  };
  const visit = (node: import("typescript").Node) => {
    if (ts.isFunctionDeclaration(node)) push(node.name, "function", node);
    else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) push(node.name, "method", node);
    else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) push(node.name, "class", node, methodsIn(node));
    else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
      push(node.name, "type", node, methodsIn(node));
    } else if (ts.isVariableDeclaration(node)) push(node.name, isFn(node.initializer) ? "function" : "value", node);
    else if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isPropertyAssignment(node)) {
      push(node.name, isFn((node as { initializer?: import("typescript").Node }).initializer) ? "method" : "value", node);
    } else if (ts.isEnumMember(node) || ts.isParameter(node) && ts.isIdentifier(node.name) && node.modifiers?.length) {
      push(node.name, "value", node);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      push(node.left, "value", node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Python's own parser, one process for every file of a project. */
const PYTHON = String.raw`
import ast, json, sys, warnings
warnings.simplefilter("ignore")
for path in sys.stdin.read().splitlines():
    try:
        tree = ast.parse(open(path, encoding="utf-8", errors="replace").read())
    except Exception as error:
        print(json.dumps({"file": path, "error": type(error).__name__})); continue
    out = []
    def holds(node):
        return any(isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef)) for c in ast.walk(node) if c is not node)
    def visit(node, in_class):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                out.append({"name": child.name, "line": child.lineno, "kind": "method" if in_class else "function", "lastLine": child.end_lineno})
                visit(child, False)
            elif isinstance(child, ast.ClassDef):
                out.append({"name": child.name, "line": child.lineno, "kind": "class", "holdsRoutines": holds(child), "lastLine": child.end_lineno})
                visit(child, True)
            else:
                if isinstance(child, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                    targets = child.targets if isinstance(child, ast.Assign) else [child.target]
                    for target in targets:
                        for name in ast.walk(target):
                            if isinstance(name, ast.Name): out.append({"name": name.id, "line": name.lineno, "kind": "value"})
                visit(child, in_class)
    visit(tree, False)
    print(json.dumps({"file": path, "decls": out}))
`;

function pythonDeclarations(files: string[]): Map<string, Truth[] | string> {
  const run = spawnSync("python3", ["-I", "-c", PYTHON], { input: files.join("\n"), encoding: "utf8", maxBuffer: 1 << 30 });
  const out = new Map<string, Truth[] | string>();
  for (const line of (run.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { file: string; decls?: Truth[]; error?: string };
    out.set(row.file, row.decls ?? `python could not parse it (${row.error})`);
  }
  return out;
}

/** LSP SymbolKind numbers rust-analyzer uses for items. */
const RA_KIND: Record<number, Kind> = {
  12: "function", 6: "method", 23: "class", 10: "type", 11: "type", 26: "type", 5: "class",
  2: "value", 14: "value", 13: "value", 8: "value", 22: "value", 7: "value",
};

function rustDeclarations(symbols: LspDocumentSymbol[], source: string): Truth[] {
  const out: Truth[] = [];
  const lines = source.split("\n");
  const visit = (symbol: LspDocumentSymbol, inImpl: boolean) => {
    const range = symbol.range ?? symbol.location?.range;
    const at = symbol.selectionRange ?? range;
    const impl = /^impl\b/.test(symbol.name);
    if (at && range) {
      if (impl) {
        // `impl Foo`, `impl<T> Trait for Foo<T>`: the type the block is for.
        const self = /\bfor\s+(?:[\w:]+::)?(\w+)|^impl(?:\s*<.*?>)?\s+(?:[\w:]+::)?(\w+)/.exec(symbol.name);
        const name = self?.[1] ?? self?.[2];
        if (name) for (let line = at.start.line; line <= at.end.line; line++) out.push({ name, line: line + 1, kind: "impl" });
      } else {
        let kind = RA_KIND[symbol.kind] ?? "value";
        if (kind === "function" && inImpl) kind = "method";
        // rust-analyzer reports `macro_rules!` as a function; an associated `type Target` is not a box.
        if (kind === "function" && /\bmacro_rules!/.test(lines[at.start.line] ?? "")) kind = "macro";
        if (symbol.kind === 26 && inImpl) kind = "value";
        const holds = (symbol.children ?? []).some((child) => child.kind === 12 || child.kind === 6);
        out.push({ name: symbol.name, line: at.start.line + 1, kind, lastLine: range.end.line + 1,
          ...(kind === "class" || kind === "type" ? { holdsRoutines: holds } : {}) });
      }
    }
    for (const child of symbol.children ?? []) visit(child, impl || (inImpl && !RA_KIND[symbol.kind]) || symbol.kind === 11);
  };
  for (const symbol of symbols) visit(symbol, false);
  return out;
}

/* ------------------------------------------------------------------- rows */

const SHAPES = ["function", "method", "class", "type", "macro"] as const;
type Shape = (typeof SHAPES)[number];
const TAGS = ["in an object literal", "#private", "$ in the name", "letter outside ASCII", "Rust raw identifier", "after a line the parser can't read", "in a file that does not parse, before the error"] as const;
type Tag = (typeof TAGS)[number];
type Verdict = "found" | "missed" | "wrong";

interface Row {
  set: string; project: string; lang: Lang; file: string; line: number;
  declared: string; written: string; shape: Shape; tags: Tag[];
  box: boolean; index: Verdict; routines?: Verdict;
  /** What a wrong lookup landed on: line and, when the second parser has one there, its name. */
  landed?: string;
  found: boolean;
}

interface Summary {
  set: string; project: string; seconds: number; files: Record<Lang, number>;
  unread: string[]; diagnostics: string[];
}

/**
 * The first line (1-based) the checker's parser could not read, as written --
 * before the parser blanks it and reads on (#462), so a declaration keeps the
 * same shape before and after.
 */
function firstError(source: string, language: Language): number | undefined {
  // A commit before #462 has no `firstUnreadableRow`, and no recovery: its tree is the parse as written.
  const asWritten = (parse as { firstUnreadableRow?: (source: string, language: Language) => number | undefined }).firstUnreadableRow;
  if (asWritten) {
    const row = asWritten(source, language);
    return row === undefined ? undefined : row + 1;
  }
  const root = parseSource(source, language)?.rootNode;
  if (!root?.hasError) return undefined;
  let first: number | undefined;
  const visit = (node: Node) => {
    const n = node as Node & { isError?: boolean; isMissing?: boolean };
    if (n !== root && (n.isError || n.isMissing)) {
      const row = startRow(n);
      if (first === undefined || row < first) first = row;
      return;
    }
    if (!n.hasError) return;
    for (let i = 0; i < n.childCount; i++) visit(n.child(i)!);
  };
  visit(root);
  return first;
}

/** The checker's door for a board's name (#451); a commit before it took the name as written. */
const declaredModule = await import("../src/engine/declared").catch(() => undefined) as
  { spelledHere?: (source: string, written: string, language: Language) => string } | undefined;
const spelledHere = declaredModule?.spelledHere ?? ((_source: string, written: string) => written);

const startRow = (node: Node): number => (node as Node & { startPosition: { row: number } }).startPosition.row + 1;

function routineNameRow(node: Node): number {
  const name = node.type === "impl_item"
    ? node.childForFieldName("type")
    : node.childForFieldName("name") ?? node.childForFieldName("left");
  return startRow(name ?? node);
}

/** The name a board writes for a declaration, given every name the file declares. */
function writtenFor(declared: string, all: Set<string>): string {
  const bare = declared.startsWith("#") ? declared.slice(1) : declared.startsWith("r#") ? declared.slice(2) : declared;
  return bare !== declared && all.has(bare) ? declared : bare;
}

function rowsForFile(
  set: string, project: string, rel: string, source: string, language: Language, truths: Truth[],
): Row[] {
  const lang = langOf(language);
  const tree = parseSource(source, language);
  const root = tree?.rootNode;
  const broken = root ? firstError(source, language) : undefined;
  const names = new Set(truths.filter((one) => one.kind !== "impl").map((one) => one.name));
  /** Every line the second parser says declares something under this written name. */
  const linesOf = new Map<string, Map<number, string>>();
  for (const truth of truths) {
    const written = truth.kind === "impl" ? truth.name : writtenFor(truth.name, names);
    const lines = linesOf.get(written) ?? new Map<number, string>();
    lines.set(truth.line, truth.name);
    linesOf.set(written, lines);
  }
  /** Any declaration the second parser has on this line, by name, for naming a wrong landing. */
  const onLine = new Map<number, string>();
  for (const truth of truths) if (!onLine.has(truth.line)) onLine.set(truth.line, truth.name);
  const shapes = root ? declaredShapes(source, language) : undefined;
  const routinesCache = new Map<string, ReturnType<typeof routinesNamed>>();
  const rows: Row[] = [];
  for (const truth of truths) {
    if (truth.kind === "value" || truth.kind === "impl") continue;
    const written = writtenFor(truth.name, names);
    const shape: Shape = truth.kind;
    const tags: Tag[] = [];
    if (truth.inLiteral) tags.push("in an object literal");
    if (truth.name.startsWith("#")) tags.push("#private");
    if (truth.name.includes("$")) tags.push("$ in the name");
    if (/[^\x00-\x7f]/.test(truth.name)) tags.push("letter outside ASCII");
    if (truth.name.startsWith("r#")) tags.push("Rust raw identifier");
    if (broken !== undefined) tags.push(truth.line > broken ? "after a line the parser can't read" : "in a file that does not parse, before the error");
    const accepted = linesOf.get(written) ?? new Map<number, string>();
    const judge = (rowsFound: number[], own: (row: number) => boolean): { verdict: Verdict; landed?: string } => {
      if (rowsFound.some(own)) return { verdict: "found" };
      const stray = rowsFound.find((row) => !accepted.has(row));
      if (stray !== undefined) return { verdict: "wrong", landed: `${stray}${onLine.has(stray) ? ` (${onLine.get(stray)})` : ""}` };
      return { verdict: "missed" };
    };
    const box = mentions(source, written);
    const spelled = spelledHere(source, written, language);
    const indexRows = (shapes?.get(spelled) ?? []).filter((one) => !one.soup).map((one) => startRow(one.nameNode));
    const index = judge(indexRows, (row) => row === truth.line);
    let routines: { verdict: Verdict; landed?: string } | undefined;
    const isRoutine = shape === "function" || shape === "method";
    if (isRoutine || truth.holdsRoutines) {
      const named = routinesCache.get(spelled) ?? routinesNamed(source, spelled, language);
      routinesCache.set(spelled, named);
      const found = named.routines.map(routineNameRow);
      // A type's methods may be in an `impl` block elsewhere in the file: any of the type's own lines will do.
      routines = judge(found, isRoutine ? (row) => row === truth.line : (row) => accepted.has(row));
    }
    const wrong = index.verdict === "wrong" || routines?.verdict === "wrong";
    rows.push({
      set, project, lang, file: rel, line: truth.line, declared: truth.name, written, shape, tags,
      box, index: index.verdict, ...(routines ? { routines: routines.verdict } : {}),
      ...(wrong ? { landed: index.landed ?? routines?.landed } : {}),
      found: box && index.verdict === "found" && (routines === undefined || routines.verdict === "found"),
    });
  }
  return rows;
}

/* ------------------------------------------------------------ one project */

async function measureOne(setName: string, project: string): Promise<void> {
  const started = Date.now();
  const set = SETS[setName]!;
  const diagnostics: string[] = [];
  const say = (line: string): void => {
    diagnostics.push(line);
    const text = `${new Date().toLocaleString("sv-SE")}   [${setName}/${project}] ${line}\n`;
    process.stderr.write(text);
    appendFileSync(path.join(RUN, "run.log"), text);
  };
  const root = path.join(set.corpus, project);
  const files = sourceFiles(root).map((one) => path.relative(root, one)).filter((rel) => !isTestPath(rel));
  const fileCount: Record<Lang, number> = { ts: 0, python: 0, rust: 0 };
  const unread: string[] = [];
  const rows: Row[] = [];
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

  const byLang = (lang: Lang) => files.filter((rel) => langOf(languageOf(rel)!) === lang);

  for (const rel of byLang("ts")) {
    const source = read(rel);
    fileCount.ts++;
    rows.push(...rowsForFile(setName, project, rel, source, languageOf(rel)!, tsDeclarations(rel, source)));
  }

  const python = byLang("python");
  if (python.length) {
    const truths = pythonDeclarations(python.map((rel) => path.join(root, rel)));
    for (const rel of python) {
      const truth = truths.get(path.join(root, rel));
      if (truth === undefined || typeof truth === "string") { unread.push(`${rel}: ${truth ?? "python gave no answer"}`); continue; }
      fileCount.python++;
      rows.push(...rowsForFile(setName, project, rel, read(rel), "python", truth));
    }
  }

  const rust = byLang("rust");
  if (rust.length) {
    const crates = cargoRootsIn(root, new Set(["node_modules", ".git", "target", "vendor"]));
    // The outermost manifest: rust-analyzer started inside a workspace member waited forever on axum.
    const crateOf = (rel: string) => crates.filter((one) => path.join(root, rel).startsWith(one + path.sep)).sort((a, b) => a.length - b.length)[0];
    const groups = new Map<string, string[]>();
    for (const rel of rust) {
      const crate = crateOf(rel);
      if (!crate) { unread.push(`${rel}: no Cargo.toml owns it`); continue; }
      groups.set(crate, [...(groups.get(crate) ?? []), rel]);
    }
    for (const [crate, group] of groups) {
      const t0 = Date.now();
      let referee: Awaited<ReturnType<typeof createRustAnalyzerReferee>> | undefined;
      try {
        referee = await createRustAnalyzerReferee(crate);
      } catch (error) {
        say(`rust-analyzer ${path.relative(root, crate) || "."}: did not start: ${error instanceof Error ? error.message : String(error)}`);
        for (const rel of group) unread.push(`${rel}: rust-analyzer did not start`);
        continue;
      }
      let silent = 0;
      for (const rel of group) {
        // A server that stops answering must cost one file, not the run: a pending request alone
        // keeps nothing alive, and the process exits mid-await (actix-web, axum in the first run).
        const symbols = await Promise.race([
          referee.documentSymbols(path.join(root, rel)),
          new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), 60_000); }),
        ]);
        if (!symbols) { silent++; unread.push(`${rel}: rust-analyzer gave no symbols`); continue; }
        fileCount.rust++;
        rows.push(...rowsForFile(setName, project, rel, read(rel), "rust", rustDeclarations(symbols, read(rel))));
      }
      referee.close();
      say(`rust-analyzer ${path.relative(root, crate) || "."}: ${group.length} files, ${silent} unanswered, ${Math.round((Date.now() - t0) / 1000)}s`
        + (referee.primedCleanly() ? "" : " (server never said it was ready)"));
    }
  }
  if (unread.length) say(`${unread.length} files the second parser could not read; first: ${unread[0]}`);

  const out = path.join(RUN, setName);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, `${project}.jsonl`), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const summary: Summary = { set: setName, project, seconds: Math.round((Date.now() - started) / 1000), files: fileCount, unread, diagnostics };
  writeFileSync(path.join(out, `${project}.json`), JSON.stringify(summary, null, 2));
  writeFileSync(path.join(out, `${project}.done`), new Date().toString());
}

/* ----------------------------------------------------------------- tables */

function loadRows(run: string, sets: string[]): Row[] {
  const rows: Row[] = [];
  for (const setName of sets) {
    const folder = path.join(run, setName);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).filter((one) => one.endsWith(".done")).sort()) {
      const file = path.join(folder, name.replace(/\.done$/, ".jsonl"));
      for (const line of readFileSync(file, "utf8").split("\n")) if (line.trim()) rows.push(JSON.parse(line) as Row);
    }
  }
  return rows;
}

const pct = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : "-");

function tables(rows: Row[]): string {
  const out: string[] = [];
  const projects = new Set(rows.map((row) => `${row.set}/${row.project}`)).size;
  out.push(`# Box lookup: ${rows.length.toLocaleString("en")} declarations in ${projects} projects`, "");
  out.push("**missed** = the checker cannot find the declaration by the name a board writes; **wrong** = it finds something else under that name.", "");
  const line = (label: string, group: Row[]) => {
    const missed = group.filter((row) => !row.found && !(row.index === "wrong" || row.routines === "wrong")).length;
    const wrong = group.filter((row) => row.index === "wrong" || row.routines === "wrong").length;
    const box = group.filter((row) => !row.box).length;
    const index = group.filter((row) => row.index !== "found").length;
    const routineRows = group.filter((row) => row.routines !== undefined);
    const routines = routineRows.filter((row) => row.routines !== "found").length;
    return `| ${label} | ${group.length.toLocaleString("en")} | **${missed.toLocaleString("en")}** (${pct(missed, group.length)}) | **${wrong}** | ${box} | ${index} | ${routines} of ${routineRows.length.toLocaleString("en")} |`;
  };
  for (const lang of LANGS) {
    const mine = rows.filter((row) => row.lang === lang);
    if (!mine.length) continue;
    out.push(`## ${lang === "ts" ? "TypeScript / JavaScript" : lang === "python" ? "Python" : "Rust"}`, "");
    out.push("| shape | declarations | missed | wrong | box check misses | index misses | routine lookup misses |", "|---|---|---|---|---|---|---|");
    out.push(line("all", mine));
    for (const shape of SHAPES) {
      const group = mine.filter((row) => row.shape === shape);
      if (group.length) out.push(line(shape, group));
    }
    for (const tag of TAGS) {
      const group = mine.filter((row) => row.tags.includes(tag));
      if (group.length) out.push(line(`· ${tag}`, group));
    }
    out.push("");
  }
  const wrong = rows.filter((row) => row.index === "wrong" || row.routines === "wrong");
  if (wrong.length) {
    out.push(`## Wrong finds (${wrong.length}), first 30`, "");
    for (const row of wrong.slice(0, 30)) {
      out.push(`- ${row.set}/${row.project} ${row.file}:${row.line} \`${row.declared}\` written \`${row.written}\` -> line ${row.landed}`);
    }
    out.push("");
  }
  return out.join("\n");
}

function compare(before: string, after: string, sets: string[]): string {
  const key = (row: Row) => `${row.set}|${row.project}|${row.file}|${row.line}|${row.declared}`;
  const old = new Map(loadRows(before, sets).map((row) => [key(row), row]));
  const now = loadRows(after, sets);
  const state = (row: Row | undefined) => (!row ? "absent" : row.index === "wrong" || row.routines === "wrong" ? "wrong" : row.found ? "found" : "missed");
  const moves = new Map<string, Row[]>();
  for (const row of now) {
    const from = state(old.get(key(row)));
    const to = state(row);
    if (from === to) continue;
    const label = `${row.lang} ${from} -> ${to}`;
    moves.set(label, [...(moves.get(label) ?? []), row]);
  }
  const out = [`# Box lookup: ${before} -> ${after}`, ""];
  for (const [label, group] of [...moves.entries()].sort()) {
    out.push(`## ${label}: ${group.length}`);
    const byTag = new Map<string, number>();
    for (const row of group) for (const tag of row.tags.length ? row.tags : [`(${row.shape})`]) byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
    out.push([...byTag.entries()].sort((a, b) => b[1] - a[1]).map(([tag, n]) => `${tag} ${n}`).join(" · "));
    for (const row of group.slice(0, 12)) out.push(`- ${row.set}/${row.project} ${row.file}:${row.line} \`${row.declared}\`${row.landed ? ` -> ${row.landed}` : ""}`);
    out.push("");
  }
  if (moves.size === 0) out.push("No declaration changed.");
  return out.join("\n");
}

/* ------------------------------------------------------------------- main */

await initEngine();
const one = flag("one");
if (one) {
  const [setName, project] = one.split("/");
  if (!setName || !project || !SETS[setName]) throw new Error(`--one=${one}: want <set>/<project>`);
  mkdirSync(RUN, { recursive: true });
  await measureOne(setName, project);
  process.exit(0);
}

const wanted = (flag("set") ?? CENSUS_SET_ORDER.join(",")).split(",");
for (const name of wanted) {
  if (name === "holdout-c") throw new Error("holdout-c is score only: its code is never read by a measurement.");
  if (!SETS[name]) throw new Error(`--set=${name}: the sets are ${CENSUS_SET_ORDER.join(", ")}`);
}

const compareTo = flag("compare");
if (compareTo) {
  console.log(compare(path.resolve(compareTo), RUN, wanted));
  process.exit(0);
}

const only = flag("only")?.split(",");
const log = (line: string) => {
  const stamp = new Date().toLocaleString("sv-SE");
  process.stderr.write(`${stamp} ${line}\n`);
  mkdirSync(RUN, { recursive: true });
  appendFileSync(path.join(RUN, "run.log"), `${stamp} ${line}\n`);
};
const failed: string[] = [];
if (!argv.includes("--table")) {
  log(`box lookup into ${RUN}`);
  for (const setName of wanted) {
    mkdirSync(path.join(RUN, setName), { recursive: true });
    for (const project of SETS[setName]!.projects()) {
      if (only && !only.includes(project)) continue;
      if (existsSync(path.join(RUN, setName, `${project}.done`))) continue;
      await waitForQuiet(log);
      log(`${setName}/${project}`);
      const run = spawnSync(process.execPath, [...process.execArgv, SELF, `--one=${setName}/${project}`, `--out=${RUN}`], {
        stdio: ["ignore", "inherit", "inherit"], timeout: 60 * 60_000,
      });
      if (run.status !== 0 || !existsSync(path.join(RUN, setName, `${project}.done`))) {
        const why = run.error ? run.error.message : `exit ${run.status ?? run.signal}`;
        failed.push(`${setName}/${project} (${why})`);
        log(`FAILED ${setName}/${project}: ${why}`);
      }
    }
  }
}
const rows = loadRows(RUN, wanted).filter((row) => !only || only.includes(row.project));
const table = tables(rows) + (failed.length ? `\n**Failed:** ${failed.join(", ")}\n` : "");
writeFileSync(path.join(RUN, "tables.md"), table + "\n");
console.log(table);
