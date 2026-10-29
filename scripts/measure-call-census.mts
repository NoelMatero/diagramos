#!/usr/bin/env node
/**
 * Every call in every function, placed twice: once by the checker, once by
 * the compiler's "go to definition" (#467).
 *
 *   npm run measure:call-census                         -- main, holdout, holdout-b
 *   npm run measure:call-census -- --set=holdout --only=psf-requests
 *   npm run measure:call-census -- --table              -- the tables from a finished run, nothing re-run
 *   npm run measure:call-census -- --compare=<run dir>  -- this run against an earlier one, site by site
 *   npm run measure:call-census -- --reuse=<run dir>    -- ask the compilers only what that run has no answer for
 *
 * ## Why
 *
 * Every checker fix so far was judged on bench arrows, and bench arrows are a
 * sample: a fix can pass the bench and still misread the same shape wherever
 * the bench does not look. This needs no answer key. For each call it asks
 * where the checker places it and where the compiler places it, and sorts the
 * call into one of five bins:
 *
 *   agree        both place it at the same declaration (outside the repository counts)
 *   disagree     both place it, differently -- a disagreement can become a false red
 *   gap          the compiler places it; the checker cannot
 *   neither      neither can (a run-time choice, an interface, a compiler with no answer)
 *   checker-only the checker places it and the compiler does not
 *
 * The issue names four bins. The fifth is there because the case exists: the
 * live checker takes any line "go to definition" names as a placement, and
 * when that line declares a variable rather than a function the compiler, read
 * strictly, has not said what runs.
 *
 * ## Two arms
 *
 * `live` is the checker as the bench runs it: the text reading, with a call it
 * cannot place by name put to "go to definition" (`CallSide.declarationAt`,
 * #351) -- fed here from the same answers the compiler column holds, so each
 * position is asked once. `text` is the first pass alone, no compiler. Layer 1
 * (#468-#471) is about the text reading, so its shapes should fall in both.
 *
 * ## What is a call, and what the compiler is asked
 *
 * Every site `callSitesIn` lists, plus every call written inside a Rust macro's
 * arguments (`format!("{}", f(x))`), found by reading the macro's tokens -- the
 * checker lists those as one `macro` doubt per macro, the compiler can still
 * answer each. The compiler is asked at the called name: `foo` in `foo()`,
 * `x.foo()` and `Type::foo()`; for a call with no name in the text (`f()()`,
 * `obj[k]()`) it is not asked and the call is `neither` unless the checker
 * placed it. Its answer counts as a placement when the line it names declares
 * a routine, a class/struct/enum/trait, or a macro, or when it is outside the
 * repository; a line declaring a variable, a parameter, a field or an import
 * is where a value is held, not what runs.
 *
 * Test files and folders, Rust `#[cfg(test)]` modules, and bundles, docs and
 * static assets (`build`, `docs`, `static`, `assets`, `*.min.js`) are left out:
 * no bench board is drawn from them,
 * and they would roughly double the run.
 *
 * ## Running it
 *
 * One child process per project (`.corpus` dies twice in one process: the JS
 * heap, then tree-sitter's), each writing its own rows and summary under the
 * run directory, so a re-run costs only the projects that have no `.done`.
 * Before each project the parent waits until no other bench, measure script
 * or vitest is running. Every compiler failure -- a server that would not
 * start or never finished indexing, a question that threw, a tsconfig with
 * errors, files where no call got an answer -- is printed, because probes trip
 * on project settings and a silent compiler reads as "the checker is right".
 *
 * Every answer a run trusts is kept under `answers/<set>/<project>.json`, and
 * `--reuse=<run dir>` answers from there what it can (#481): the compilers'
 * answers do not move with the checker, and asking them is nearly all of an
 * hour-long run. An answer is reused only while the clone, its libraries, the
 * compiler and the asking code are unchanged, and the file it was asked in has
 * the same content -- `scripts/lib/census-answers.ts` has the whole key. A
 * question that failed is never kept, so it is asked, and printed, again.
 * `run.log` says per project and in all how many were reused and how many
 * asked.
 *
 * holdout-c is score only: its projects are never read, and asking for it is
 * an error.
 *
 * Measure only. Nothing in `src/` changes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitForQuiet } from "./lib/bench-busy";
import { ProjectAnswers, answersPath, keptAnswerOf, sha1, type AnswerKey, type KeptAnswer } from "./lib/census-answers";
import { CENSUS_SET_ORDER, censusSets, isTestPath } from "./lib/census-sets";
import { CLASSY, FN, ISSUE_OF, shapeOf, type Node } from "./lib/call-census-shapes";
import { sourceFiles } from "./lib/source-files";

import { EXTERNAL_RECEIVER, callImports, callSitesIn, type CallSide, type CallSitePlaced } from "../src/engine/calls";
import { readDependencies } from "../src/engine/deps";
import { createWorkspace } from "../src/engine/drift";
import { initEngine, languageOf, parseSource, type Language } from "../src/engine/parse";
import type { ConfigCache } from "../src/engine/resolve";
import type { LocationOutcome } from "../src/engine/lsp-symbols";
import { PYRIGHT_VERSION, createPyrightLspReferee } from "../src/engine/referee-python-lsp";
import { cargoRootsIn } from "../src/engine/referee-rust";
import { createRustAnalyzerReferee, isOutsideRustTree } from "../src/engine/referee-rust-lsp";
import { createTsReferee, isOutsideTree, typescriptModule } from "../src/engine/referee-ts";

const HOME = os.homedir();
const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), "..");
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => argv.find((one) => one.startsWith(`--${name}=`))?.slice(name.length + 3);

/* ------------------------------------------------------------------ the sets */

const SETS = censusSets(REPO);
const SET_ORDER = CENSUS_SET_ORDER;

/* ------------------------------------------------------------- run directory */

function defaultRunDirectory(): string {
  let head = "unknown";
  let dirty = "";
  try {
    head = execFileSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const changed = execFileSync("git", ["-C", REPO, "status", "--porcelain", "--", "src"], { encoding: "utf8" }).trim();
    if (changed) dirty = "-dirty";
  } catch { /* not a checkout: one directory for all of it */ }
  return path.join(HOME, ".board-ai-census", `${head}${dirty}`);
}
const RUN = path.resolve(flag("out") ?? defaultRunDirectory());

/* ------------------------------------------------------------- the five bins */

const BINS = ["agree", "disagree", "gap", "neither", "checker-only"] as const;
type Bin = (typeof BINS)[number];
const ARMS = ["live", "text"] as const;
type Arm = (typeof ARMS)[number];
const LANGS = ["ts", "python", "rust"] as const;
type Lang = (typeof LANGS)[number];
const langOf = (language: Language): Lang => (language === "python" ? "python" : language === "rust" ? "rust" : "ts");

/** What the checker said about one call. */
interface CheckerAnswer { file?: string; as?: string; why?: string; several?: boolean }
/** What the compiler said, read against the line it named. */
type CompilerAnswer =
  | { kind: "outside" }
  | { kind: "repo"; file: string; line: number; name?: string; holder?: string; lands: "routine" | "type" | "macro" | "value" | "unread" }
  | { kind: "silent"; why: "no-name" | "unanswered" | "threw" | "no-server" };

const compilerPlaces = (c: CompilerAnswer): boolean =>
  c.kind === "outside" || (c.kind === "repo" && (c.lands === "routine" || c.lands === "type" || c.lands === "macro"));

const CONSTRUCTORS = new Set(["__init__", "__new__", "constructor"]);

function binOf(checker: CheckerAnswer, compiler: CompilerAnswer): Bin {
  const placed = checker.file !== undefined;
  if (!compilerPlaces(compiler)) return placed ? "checker-only" : "neither";
  if (!placed) return "gap";
  if (checker.several) return "disagree";
  const outside = checker.file === EXTERNAL_RECEIVER;
  if (compiler.kind === "outside") return outside ? "agree" : "disagree";
  if (outside || compiler.kind !== "repo") return "disagree";
  if (compiler.file !== checker.file) return "disagree";
  if (checker.as === undefined || compiler.name === undefined) return "agree";
  if (compiler.name === checker.as) return "agree";
  if (CONSTRUCTORS.has(compiler.name) && compiler.holder === checker.as) return "agree";
  return "disagree";
}

/* --------------------------------------------------------------- one project */

/** Which of a batch's answers to keep (#481): every one, places and the "nothing here"s that followed one, or none. */
type Trust = "all" | "places" | "nothing";

interface Row {
  set: string; project: string; lang: Lang; file: string; line: number; key: string;
  routine: string; name: string; text: string;
  checker: Record<Arm, CheckerAnswer>; compiler: CompilerAnswer; bin: Record<Arm, Bin>; shape?: string;
}
interface Summary {
  set: string; project: string; root: string; libraries: string; seconds: number;
  files: Record<Lang, number>; routines: Record<Lang, number>;
  bins: Record<Lang, Record<Arm, Record<Bin, number>>>;
  /** Per arm, why the compiler did not place a `neither` call: no answer, a value, no name to ask at. */
  neitherWhy: Record<Lang, Record<Arm, Record<string, number>>>;
  /** Per arm and bin, the count of each shape (gap and neither carry shapes). */
  shapes: Record<Lang, Record<Arm, Record<string, Record<string, number>>>>;
  diagnostics: string[];
  /** Compiler questions answered from an earlier run's kept answers, and asked of the compiler (#481). */
  answers?: { reused: number; asked: number };
}


/** The leaf a call names, by the same rules `calleeOf` reads it with, or undefined for a computed callee. */
function nameLeaf(call: Node): Node | undefined {
  let callee = call.type === "new_expression"
    ? call.childForFieldName("constructor")
    : /^jsx_/.test(call.type) ? call.childForFieldName("name")
      : call.childForFieldName("arguments") ? call.childForFieldName("function") : call.childForFieldName("macro");
  // `await g<T>()`, which TypeScript's grammar reads as a call of `await g` (#470).
  if (callee?.type === "await_expression") callee = firstNamed(callee) ?? callee;
  return callee ? leafOf(callee) : undefined;
}
function firstNamed(node: Node): Node | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.isNamed && !/comment/.test(child.type)) return child;
  }
  return undefined;
}
/** `calleeOfNode`'s `unwrapped` (#470): parentheses, `!` and `<T>` taken off, an awaited value and a Rust field kept. */
function unwrapped(callee: Node): Node {
  let at = callee;
  for (let depth = 0; depth < 8; depth++) {
    if (!/^(parenthesized_expression|non_null_expression|instantiation_expression)$/.test(at.type)) return at;
    const inner = firstNamed(at);
    if (!inner || inner.type === "await_expression" || inner.type === "await" || inner.type === "field_expression") return at;
    at = inner;
  }
  return at;
}
/**
 * Where the checker names a JavaScript `x.call(...)` / `x.apply(...)` it reads
 * as a call of `x` (#470): `x`'s own leaf. Undefined for any other call.
 */
function valueLeaf(call: Node): Node | undefined {
  const f = call.childForFieldName("arguments") ? call.childForFieldName("function") : undefined;
  if (!f) return undefined;
  const member = unwrapped(f.type === "await_expression" ? firstNamed(f) ?? f : f);
  const property = member.childForFieldName("property");
  if (member.type !== "member_expression" || !property || !["call", "apply"].includes(property.text)) return undefined;
  const object = member.childForFieldName("object");
  return object ? leafOf(object) : undefined;
}
/** What `super(...)` names to the checker (#470): the leaf of the class's `extends` clause. */
function superLeaf(call: Node): Node | undefined {
  if (call.childForFieldName("function")?.type !== "super") return undefined;
  for (let p = call.parent; p; p = p.parent) {
    if (!CLASSY.has(p.type)) continue;
    for (let i = 0; i < p.childCount; i++) {
      const heritage = p.child(i)!;
      if (heritage.type !== "class_heritage") continue;
      for (let j = 0; j < heritage.childCount; j++) {
        const clause = heritage.child(j)!;
        const value = clause.type === "extends_clause" ? clause.childForFieldName("value") : null;
        if (value) return leafOf(value);
      }
    }
    return undefined;
  }
  return undefined;
}
function leafOf(written: Node): Node | undefined {
  const callee = unwrapped(written);
  if (callee.childCount === 0) return /identifier$|^field_identifier$|^property_identifier$/.test(callee.type) ? callee : undefined;
  if (callee.childForFieldName("arguments")) return undefined;
  const inner = callee.childForFieldName("function");
  if (inner) return leafOf(inner);
  const object = callee.childForFieldName("object") ?? callee.childForFieldName("value") ?? callee.childForFieldName("path") ?? callee.child(0);
  const member = callee.childForFieldName("property") ?? callee.childForFieldName("attribute")
    ?? callee.childForFieldName("field") ?? callee.childForFieldName("name");
  if (!object || !member || member.childCount !== 0) return undefined;
  return member;
}
const CALLISH = new Set(["call_expression", "call", "new_expression", "macro_invocation", "jsx_opening_element", "jsx_self_closing_element"]);
const isCall = (n: Node): boolean => CALLISH.has(n.type) && (n.type !== "call_expression" || n.childForFieldName("arguments") !== null);

/**
 * Where to ask the compiler about a call the checker reads as computed: the
 * name a person would put the cursor on, when there is one. `super(...)`,
 * `(this.f)(x)`, `foo!<T>`-style wrappers. A call of a call, a subscript and
 * a function written on the spot have none.
 */
function computedAsk(call: Node): Node | undefined {
  let f = call.childForFieldName("function") ?? call.childForFieldName("constructor");
  if (!f) return undefined;
  if (f.type === "super") return f;
  for (let k = 0; f && k < 4 && ["parenthesized_expression", "non_null_expression", "await_expression", "instantiation_expression", "generic_function"].includes(f.type); k++) {
    f = f.childForFieldName("function") ?? f.namedChild(0);
  }
  if (!f) return undefined;
  if (/identifier$/.test(f.type) && f.childCount === 0) return f;
  const member = f.childForFieldName("property") ?? f.childForFieldName("attribute") ?? f.childForFieldName("field");
  return member && member.childCount === 0 ? member : undefined;
}

/** Every top-level token tree that starts on a line inside one of the routines read. */
function tokensInBodies(tree: Node, reading: ReturnType<typeof callSitesIn>): Node[] {
  if (!reading.read) return [];
  const inBody = (row: number) => reading.bodies.some((body) => body.line <= row && row < body.line + body.lines);
  const out: Node[] = [];
  const collect = (n: Node): void => {
    if (n.type === "token_tree") {
      if (inBody(n.startPosition.row + 1)) out.push(n);
      return;
    }
    for (let i = 0; i < n.namedChildCount; i++) collect(n.namedChild(i)!);
  };
  collect(tree);
  return out;
}

/** Calls written inside a Rust macro's arguments: `name (`, `.name (`, `path::name (`, `name ! (`. */
function callsInTokens(tree: Node, out: Node[] = []): Node[] {
  for (let i = 0; i < tree.childCount; i++) {
    const c = tree.child(i)!;
    if (c.type === "token_tree") { callsInTokens(c, out); continue; }
    if (c.type !== "identifier") continue;
    const next = tree.child(i + 1);
    const after = tree.child(i + 2);
    if (next?.type === "token_tree" && next.text.startsWith("(")) out.push(c);
    else if (next?.type === "!" && after?.type === "token_tree") out.push(c);
    else if (next?.type === "::" && after?.type === "<") {
      // `name::<T>(` -- turbofish; the call is the name before it.
      let j = i + 3;
      let depth = 1;
      for (; j < tree.childCount && depth > 0; j++) {
        const t = tree.child(j)!.type;
        if (t === "<") depth++;
        else if (t === ">") depth--;
      }
      const open = tree.child(j);
      if (open?.type === "token_tree" && open.text.startsWith("(")) out.push(c);
    }
  }
  return out;
}


/**
 * Every call in a file, by where the name it calls starts. One walk down the
 * tree: web-tree-sitter finds a node's parent by searching from the root, so
 * climbing from a name to its call costs a file's size per call, and on
 * regex's ten-thousand-line files that turned seconds into hours.
 */
function callsByName(root: Node): Map<number, Node> {
  const out = new Map<number, Node>();
  const visit = (n: Node): void => {
    if (isCall(n)) {
      for (const leaf of [nameLeaf(n), valueLeaf(n), superLeaf(n)]) {
        if (leaf && !out.has(leaf.startIndex)) out.set(leaf.startIndex, n);
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i)!);
  };
  visit(root);
  return out;
}

/** Whether a `macro_rules!` definition spans this line (1-based). */
function insideMacroDefinition(root: Node, line: number): boolean {
  const row = line - 1;
  const visit = (n: Node): boolean => {
    if (n.startPosition.row > row || n.endPosition.row < row) return false;
    if (n.type === "macro_definition") return true;
    for (let i = 0; i < n.namedChildCount; i++) if (visit(n.namedChild(i)!)) return true;
    return false;
  };
  return visit(root);
}

/** Line spans (1-based) of `#[cfg(test)] mod ... { }` blocks and `#[test]` functions, at any depth. */
function rustTestModules(root: Node): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const visit = (n: Node): void => {
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i)!;
      if (c.type !== "mod_item" && c.type !== "function_item") continue;
      const marks = c.type === "mod_item" ? /cfg\(\s*test\s*\)/ : /^#\[(\w+::)*test\b/;
      for (let j = i - 1; j >= 0; j--) {
        const before = n.namedChild(j)!;
        if (before.type !== "attribute_item" && before.type !== "line_comment" && before.type !== "block_comment") break;
        if (before.type === "attribute_item" && marks.test(before.text)) {
          out.push([c.startPosition.row + 1, c.endPosition.row + 1]);
          break;
        }
      }
      const body = c.type === "mod_item" ? c.childForFieldName("body") : null;
      if (body) visit(body);
    }
  };
  visit(root);
  return out;
}

/** The declarations whose name is written on `line` (1-based) of a parsed file. */
function declarationsOn(root: Node, line: number): Array<{ name: string; lands: "routine" | "type" | "macro" | "value"; holder?: string }> {
  const out: Array<{ name: string; lands: "routine" | "type" | "macro" | "value"; holder?: string }> = [];
  const row = line - 1;
  const visit = (n: Node): void => {
    if (n.startPosition.row > row || n.endPosition.row < row) return;
    const nameNode = n.childForFieldName("name") ?? (n.type === "assignment" ? n.childForFieldName("left") : null)
      ?? (n.type === "pair" ? n.childForFieldName("key") : null);
    if (nameNode && nameNode.startPosition.row === row && nameNode.childCount === 0) {
      const value = n.childForFieldName("value") ?? n.childForFieldName("right");
      let lands: "routine" | "type" | "macro" | "value" = "value";
      if (FN.has(n.type) || n.childForFieldName("parameters") || /^(method_signature|abstract_method_signature|function_signature)$/.test(n.type)) lands = "routine";
      else if (value && (FN.has(value.type) || value.childForFieldName("parameters"))) lands = "routine";
      else if (CLASSY.has(n.type) || /^(type_alias_declaration|type_item|union_item|enum_variant|enum_declaration|class|interface_declaration|module|namespace)/.test(n.type)) lands = "type";
      else if (n.type === "macro_definition") lands = "macro";
      let holder: string | undefined;
      for (let p = n.parent; p; p = p.parent) {
        if (CLASSY.has(p.type)) { holder = p.childForFieldName("name")?.text; break; }
        if (p.type === "impl_item") { holder = p.childForFieldName("type")?.text.replace(/<.*$/, ""); break; }
      }
      out.push({ name: nameNode.text, lands, ...(holder ? { holder } : {}) });
    }
    for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i)!);
  };
  visit(root);
  return out;
}

const groupBy = (items: string[], key: (item: string) => string): Array<[string, number]> => {
  const counts = new Map<string, number>();
  for (const one of items) counts.set(key(one), (counts.get(key(one)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};
const dirOf = (rel: string): string => {
  const parts = path.dirname(rel).split(path.sep);
  return parts.slice(0, 3).join("/") || ".";
};

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

  // The project's own libraries, as the bench reads it (#429): a venv first on
  // PATH for pyright, a TypeScript checkout with node_modules installed.
  const venv = path.join(set.libraries, "python", project, "bin");
  if (existsSync(path.join(venv, "python"))) process.env.PATH = `${venv}${path.delimiter}${process.env.PATH ?? ""}`;
  const checkout = path.join(set.libraries, "corpus", project);
  const root = existsSync(path.join(checkout, "node_modules")) ? checkout : path.join(set.corpus, project);
  const libraries = root === checkout ? "TypeScript checkout with node_modules" : existsSync(path.join(venv, "python")) ? "python venv" : "none";
  say(`root ${root}; libraries: ${libraries}`);

  const workspace = createWorkspace(root);
  const configs: ConfigCache = new Map();
  const sources = new Map<string, string>();
  const read = (rel: string): string | undefined => {
    if (sources.has(rel)) return sources.get(rel);
    const absolute = workspace.resolve(rel);
    if (!absolute || workspace.stat(absolute) !== "file") return undefined;
    const text = workspace.read(absolute);
    sources.set(rel, text);
    return text;
  };
  const importsOf = new Map<string, CallSide["imports"]>();
  const imports = (rel: string, source: string): CallSide["imports"] => {
    const cached = importsOf.get(rel);
    if (cached) return cached;
    const list = callImports(readDependencies(rel, source, workspace, configs)?.dependencies ?? []);
    importsOf.set(rel, list);
    return list;
  };
  const open = (rel: string) => {
    const source = read(rel);
    const language = languageOf(rel);
    if (source === undefined || !language) return undefined;
    return { source, language, imports: imports(rel, source) };
  };

  const files = sourceFiles(root).map((one) => path.relative(root, one)).filter((rel) => !isTestPath(rel));
  const fileCount: Record<Lang, number> = { ts: 0, python: 0, rust: 0 };
  const routineCount: Record<Lang, number> = { ts: 0, python: 0, rust: 0 };
  const declared = new Map<Lang, Set<string>>(LANGS.map((one) => [one, new Set<string>()]));

  /* ---- pass 1: the population, the text arm, and where to ask the compiler */
  interface Entry {
    file: string; key: string; line: number; name: string; routine: string; rline: number;
    text: CheckerAnswer; askAt?: { start: number; end: number };
    /**
     * A JavaScript `x.call(...)` / `x.apply(...)`: `x`'s leaf and name. When
     * the compiler places `call` outside -- the built-in
     * `Function.prototype.call` -- it is asked again at `x`, which is what
     * runs (#470). Asked only at `call`, every one was a gap the checker can
     * only close by saying something it does not know.
     */
    valueAt?: { start: number; end: number; name: string };
  }
  const entries = new Map<string, Map<string, Entry>>();
  const answerOf = (site: CallSitePlaced): CheckerAnswer =>
    site.file !== undefined ? { file: site.file, ...(site.declaredAs !== undefined ? { as: site.declaredAs } : {}) } : { why: site.why ?? "unknown" };

  /*
   * A local holding one of several functions (#417) is listed once per
   * function it can hold, each named where that function is written. Told
   * apart from an ordinary call by whether the name climbs to a call that
   * opens on the site's own line -- a chain split over lines
   * (`Command::new("x")` then `.long_flag(..)` below it) names a member on a
   * later line and is still an ordinary call.
   */
  const isChosen = (site: CallSitePlaced, calls: Map<number, Node>, inMacros: Set<number>): boolean => {
    if (!site.nameAt) return false;
    // A call the checker read inside a Rust macro's arguments (#471) has no call node in the file's tree.
    if (inMacros.has(site.nameAt.start)) return false;
    const call = calls.get(site.nameAt.start);
    return !call || call.startPosition.row + 1 !== site.line;
  };
  const sitesOf = (reading: ReturnType<typeof callSitesIn>, calls: Map<number, Node>, inMacros: Set<number>) => {
    const found = new Map<string, { site: CallSitePlaced; routine: string; rline: number; several?: CallSitePlaced[] }>();
    if (!reading.read) return found;
    for (const body of reading.bodies) {
      const computedOnLine = new Map<number, number>();
      for (const site of body.sites) {
        if (site.why === "macro") continue;
        let key: string;
        if (site.nameAt) {
          if (isChosen(site, calls, inMacros)) {
            key = `chosen:${site.line}:${body.line}`;
            const had = found.get(key);
            found.set(key, { site, routine: body.routine, rline: body.line, several: [...(had?.several ?? []), site] });
            continue;
          }
          key = `n:${site.nameAt.start}`;
        } else {
          const k = computedOnLine.get(site.line) ?? 0;
          computedOnLine.set(site.line, k + 1);
          key = `c:${site.line}:${k}`;
        }
        found.set(key, { site, routine: body.routine, rline: body.line });
      }
    }
    return found;
  };

  for (const rel of files) {
    const language = languageOf(rel)!;
    const lang = langOf(language);
    const source = read(rel);
    if (source === undefined) continue;
    const reading = callSitesIn({ file: rel, source, language, imports: imports(rel, source), open });
    if (!reading.read) { say(`checker could not read ${rel}: ${reading.why}`); continue; }
    fileCount[lang]++;
    const tree = parseSource(source, language)?.rootNode as Node | undefined;
    const mine = new Map<string, Entry>();
    const inTests = language === "rust" && tree ? rustTestModules(tree) : [];
    const calls = tree ? callsByName(tree) : new Map<number, Node>();
    /*
     * Every token tree inside a routine, top-level ones only: the calls a
     * person reads in a macro's arguments. Before #471 these were exactly the
     * token trees the checker raised a `macro` doubt for; since it reads some
     * of them, the population is fixed by where they are instead.
     */
    const topTokens = tree && language === "rust" ? tokensInBodies(tree, reading) : [];
    const inMacros = new Set(topTokens.flatMap((tokens) => callsInTokens(tokens).map((ident) => ident.startIndex)));
    for (const body of reading.bodies) declared.get(lang)!.add(body.routine);
    routineCount[lang] += reading.bodies.length;
    for (const [key, { site, routine, rline, several }] of sitesOf(reading, calls, inMacros)) {
      const text: CheckerAnswer = several
        ? { file: several[0]!.file, several: true }
        : answerOf(site);
      const called = lang === "ts" && site.nameAt && !several && ["call", "apply"].includes(site.name) ? calls.get(site.nameAt.start) : undefined;
      const value = called ? valueLeaf(called) : undefined;
      mine.set(key, {
        file: rel, key, line: site.line, name: site.name, routine, rline, text,
        ...(site.nameAt && !several ? { askAt: site.nameAt } : {}),
        ...(value ? { valueAt: { start: value.startIndex, end: value.startIndex + value.text.length, name: value.text } } : {}),
      });
    }
    if (tree) {
      // Computed calls: the name a person would ask about, when there is one.
      const callsByLine = new Map<number, Node[]>();
      const walk = (n: Node): void => {
        if (isCall(n) && !nameLeaf(n)) {
          const row = n.startPosition.row + 1;
          const list = callsByLine.get(row) ?? [];
          list.push(n);
          callsByLine.set(row, list);
        }
        if (n.type === "token_tree") return;
        for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i)!);
      };
      walk(tree);
      for (const entry of mine.values()) {
        const m = /^c:(\d+):(\d+)$/.exec(entry.key);
        if (!m) continue;
        const call = callsByLine.get(Number(m[1]))?.[Number(m[2])];
        const ask = call ? computedAsk(call) : undefined;
        if (ask) entry.askAt = { start: ask.startIndex, end: ask.startIndex + ask.text.length };
      }
      // Calls inside a macro's arguments the checker did not read: it lists the macro as one doubt.
      for (const tokens of topTokens) {
        for (const ident of callsInTokens(tokens)) {
          const key = `n:${ident.startIndex}`;
          if (mine.has(key)) continue;
          // The routine holding it: the innermost body opened at or before this line.
          let routine = "";
          let rline = 0;
          if (reading.read) {
            for (const body of reading.bodies) {
              if (body.line <= ident.startPosition.row + 1 && body.line + body.lines > ident.startPosition.row + 1 && body.line >= rline) {
                routine = body.routine; rline = body.line;
              }
            }
          }
          mine.set(key, {
            file: rel, key, line: ident.startPosition.row + 1, name: ident.text, routine, rline,
            text: { why: "macro" }, askAt: { start: ident.startIndex, end: ident.startIndex + ident.text.length },
          });
        }
      }
    }
    // A Rust test module written inside a source file is test code, left out as test files are.
    if (inTests.length > 0) {
      for (const [key, entry] of mine) if (inTests.some(([a, b]) => a <= entry.line && entry.line <= b)) mine.delete(key);
    }
    entries.set(rel, mine);
  }
  const population = [...entries.values()].reduce((total, one) => total + one.size, 0);
  say(`${files.length} files, ${population} calls read in ${Math.round((Date.now() - started) / 1000)}s`);

  /* ---- pass 2: the compiler, at every name */
  const raw = new Map<string, { file: string; line: number } | "outside" | "threw" | undefined>();
  const rawKey = (file: string, start: number) => `${file}@${start}`;
  const questions = (want: (lang: Lang) => boolean) => [...entries.entries()]
    .filter(([file]) => want(langOf(languageOf(file)!)))
    .flatMap(([file, mine]) => [...mine.values()].filter((one) => one.askAt).map((one) => ({ file, at: one.askAt! })));
  const errors: string[] = [];
  const failures: string[] = [];

  /*
   * Answers an earlier run kept (#481), and the ones this run keeps. A group
   * is one language, or one crate, under the key its answers depend on; a
   * project whose root is not a git checkout has no commit to key on, so
   * nothing of it is reused or kept.
   */
  const reuseFrom = flag("reuse");
  const kept = new ProjectAnswers(reuseFrom ? answersPath(path.resolve(reuseFrom), setName, project) : undefined);
  const projectKey = projectKeyOf(root, set.libraries, libraries);
  if (!projectKey) say("answers: the root is not a git checkout; none reused or kept");
  const groupKey = (lang: Lang, crate?: string): AnswerKey | undefined => projectKey && { ...projectKey, ...compilerKeyOf(lang, crate) };
  const shas = new Map<string, string>();
  const shaOf = (file: string): string => shas.get(file) ?? shas.set(file, sha1(read(file)!)).get(file)!;
  let reused = 0;
  let asked = 0;
  /** The questions of a group with no kept answer; the rest go straight into `raw`. */
  const unanswered = (group: string, key: AnswerKey | undefined, list: Array<{ file: string; at: { start: number; end: number } }>) => list.filter((q) => {
    const k = rawKey(q.file, q.at.start);
    if (raw.has(k)) return false;
    const got = key && kept.reuse(group, key, q.file, shaOf(q.file), q.at.start, q.at.end);
    if (got === undefined) return true;
    raw.set(k, got === "none" ? undefined : got);
    kept.keep(group, key!, q.file, shaOf(q.file), q.at.start, q.at.end, got);
    reused++;
    return false;
  });
  const ask = async (
    list: Array<{ file: string; at: { start: number; end: number } }>,
    one: (file: string, at: { start: number; end: number }) => Promise<LocationOutcome>,
    outside: (absolute: string) => boolean,
    keepAs?: { group: string; key: AnswerKey | undefined; trusted: () => Trust },
  ): Promise<void> => {
    let cursor = 0;
    const trusted: Array<{ q: (typeof list)[number]; answer: KeptAnswer; asked: number }> = [];
    let firstPlace = Infinity;
    const worker = async (): Promise<void> => {
      for (;;) {
        const q = list[cursor++];
        if (!q) return;
        const key = rawKey(q.file, q.at.start);
        if (raw.has(key)) continue;
        raw.set(key, undefined);
        asked++;
        const askedAt = performance.now();
        try {
          const found = await one(q.file, q.at);
          const answer = keptAnswerOf(found, root, outside);
          if (answer === undefined) { failures.push("failed" in found ? found.failed : "no answer"); continue; }
          if (answer !== "none") { raw.set(key, answer); firstPlace = Math.min(firstPlace, performance.now()); }
          trusted.push({ q, answer, asked: askedAt });
        } catch (error) {
          raw.set(key, "threw");
          errors.push(`${q.file}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(32, list.length) }, worker));
    /*
     * A server that never got ready has nothing worth keeping, its places
     * included. One whose readiness nobody saw keeps its places -- a place is
     * never a server that was not ready -- and a "nothing here" only when it
     * was asked after the server's first place came back.
     */
    const trust = keepAs?.key ? keepAs.trusted() : "nothing";
    let left = 0;
    for (const { q, answer, asked: at } of trusted) {
      if (trust === "nothing" || (trust === "places" && answer === "none" && at < firstPlace)) { left++; continue; }
      kept.keep(keepAs!.group, keepAs!.key!, q.file, shaOf(q.file), q.at.start, q.at.end, answer);
    }
    if (left > 0 && trust === "places") say(`${left} "nothing here" answers came before the server's first place; not kept`);
  };
  const located = (found: { file: string; line: number } | undefined): LocationOutcome => (found ? { at: found } : { none: true });
  const noServer = new Set<Lang>();

  const tsAll = questions((lang) => lang === "ts");
  if (tsAll.length > 0) {
    const t0 = Date.now();
    tsConfigDiagnostics(root, say);
    const key = groupKey("ts");
    let referee: ReturnType<typeof createTsReferee> | undefined;
    let built = false;
    /** Asks what no kept run answered; builds the referee only when something is left. */
    const tsAsk = async (list: Array<{ file: string; at: { start: number; end: number } }>): Promise<number> => {
      const left = unanswered("ts", key, list);
      if (left.length === 0) return 0;
      if (!built) {
        built = true;
        try { referee = createTsReferee(root); } catch (error) { say(`tsc: could not build: ${error instanceof Error ? error.message : String(error)}`); }
        if (!referee) { say("tsc: no referee for this tree"); noServer.add("ts"); }
      }
      if (!referee) return 0;
      await ask(left, async (file, at) => located(referee!.symbolDeclarationLocationAt(path.resolve(root, file), at.start, at.end)),
        (abs) => isOutsideTree(abs, root), { group: "ts", key, trusted: () => "all" });
      return left.length;
    };
    const first = await tsAsk(tsAll);
    // `x.call(...)` the compiler places at the built-in: ask at `x` (#470).
    const again: Array<{ file: string; at: { start: number; end: number } }> = [];
    for (const [file, mine] of entries) {
      if (langOf(languageOf(file)!) !== "ts") continue;
      for (const one of mine.values()) {
        if (!one.valueAt || !one.askAt || raw.get(rawKey(file, one.askAt.start)) !== "outside") continue;
        one.askAt = { start: one.valueAt.start, end: one.valueAt.end };
        one.name = one.valueAt.name;
        again.push({ file, at: one.askAt });
      }
    }
    const second = await tsAsk(again);
    if (first + second === 0) say(`tsc: all ${tsAll.length + again.length} questions answered by the kept run`);
    else say(`tsc: ${first} questions, then ${second} of ${again.length} asked again at a function value, in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  const pyAll = questions((lang) => lang === "python");
  if (pyAll.length > 0) {
    const t0 = Date.now();
    const key = groupKey("python");
    const pyQuestions = unanswered("python", key, pyAll);
    if (pyQuestions.length === 0) say(`pyright: all ${pyAll.length} questions answered by the kept run`);
    else {
      try {
        const referee = await createPyrightLspReferee(root);
        try {
          await referee.warmUp(pyQuestions.slice(0, 8).map((q) => ({ file: path.resolve(root, q.file), source: read(q.file)!, start: q.at.start })));
        } catch (error) { say(`pyright: warm-up failed: ${error instanceof Error ? error.message : String(error)}`); }
        await ask(pyQuestions, async (file, at) => referee.methodDeclarationOutcomeAt(path.resolve(root, file), read(file)!, at.start, at.end),
          (abs) => isOutsideTree(abs, root), { group: "python", key, trusted: () => (referee.warmedUp() ? "all" : "places") });
        referee.close();
        say(`pyright: ${pyQuestions.length} questions in ${Math.round((Date.now() - t0) / 1000)}s`);
      } catch (error) {
        say(`pyright: did not start: ${error instanceof Error ? error.message : String(error)}`);
        noServer.add("python");
      }
    }
  }
  const rsQuestions = questions((lang) => lang === "rust");
  if (rsQuestions.length > 0) {
    const crates = cargoRootsIn(root, new Set(["node_modules", ".git", "target", "vendor"]));
    if (crates.length === 0) { say("rust-analyzer: no Cargo.toml in this tree"); noServer.add("rust"); }
    for (const crate of crates) {
      const crateQ = rsQuestions.filter((q) => {
        const abs = path.resolve(root, q.file);
        return crates.filter((one) => abs === one || abs.startsWith(one + path.sep)).sort((a, b) => b.length - a.length)[0] === crate;
      });
      if (crateQ.length === 0) continue;
      const t0 = Date.now();
      const group = `rust:${path.relative(root, crate) || "."}`;
      const key = groupKey("rust", crate);
      const mineQ = unanswered(group, key, crateQ);
      if (mineQ.length === 0) { say(`rust-analyzer ${path.relative(root, crate) || "."}: all ${crateQ.length} questions answered by the kept run`); continue; }
      try {
        const referee = await createRustAnalyzerReferee(crate);
        await referee.warmUp();
        if (!referee.primedCleanly()) say(`rust-analyzer ${path.relative(root, crate) || "."}: never said it finished indexing; answers may be missing`);
        await ask(mineQ, async (file, at) => referee.methodDeclarationOutcomeAt(path.resolve(root, file), read(file)!, at.start, at.end),
          (abs) => isOutsideRustTree(abs, root), { group, key, trusted: () => (referee.primedCleanly() ? "all" : "nothing") });
        referee.close();
        say(`rust-analyzer ${path.relative(root, crate) || "."} (${referee.version()}): ${mineQ.length} questions in ${Math.round((Date.now() - t0) / 1000)}s`);
      } catch (error) {
        say(`rust-analyzer ${path.relative(root, crate) || "."}: did not start: ${error instanceof Error ? error.message : String(error)}`);
        noServer.add("rust");
      }
    }
    const unowned = rsQuestions.filter((q) => !crates.some((one) => path.resolve(root, q.file).startsWith(one + path.sep))).length;
    if (unowned > 0) say(`rust-analyzer: ${unowned} calls are in files no Cargo.toml owns; not asked`);
  }
  for (const [message, count] of groupBy(errors, (one) => one.replace(/^[^:]*: /, "").slice(0, 160))) {
    say(`compiler threw ${count}x: ${message}`);
  }
  for (const [message, count] of groupBy(failures, (one) => one.replace(/\/\S+/g, "<path>").slice(0, 160))) {
    say(`compiler gave no answer ${count}x (asked again next run): ${message}`);
  }
  kept.write(answersPath(RUN, setName, project));
  say(`answers: ${reused} reused, ${asked} asked`);
  // Files where the compiler answered none of its calls -- the usual sign of a
  // file outside every program or crate, rather than of hard calls.
  const silentFiles: string[] = [];
  for (const [file, mine] of entries) {
    const asked = [...mine.values()].filter((one) => one.askAt);
    if (asked.length >= 3 && asked.every((one) => raw.get(rawKey(file, one.askAt!.start)) === undefined)) silentFiles.push(file);
  }
  for (const [dir, count] of groupBy(silentFiles, dirOf)) say(`compiler answered no call in ${count} file(s) under ${dir}/`);

  /* ---- pass 3: the live arm, the comparison, the shapes */
  const parsed = new Map<string, Node | undefined>();
  const treeOf = (rel: string): Node | undefined => {
    if (parsed.has(rel)) return parsed.get(rel);
    const source = read(rel);
    const language = languageOf(rel);
    const node = source !== undefined && language ? parseSource(source, language)?.rootNode as Node | undefined : undefined;
    if (parsed.size > 64) parsed.clear();
    parsed.set(rel, node);
    return node;
  };
  const interpret = (file: string, at: { start: number } | undefined, lang: Lang, name: string, checkerAs?: string): CompilerAnswer => {
    if (!at) return { kind: "silent", why: "no-name" };
    const got = raw.get(rawKey(file, at.start));
    if (got === "outside") return { kind: "outside" };
    if (got === "threw") return { kind: "silent", why: "threw" };
    if (!got) return { kind: "silent", why: noServer.has(lang) ? "no-server" : "unanswered" };
    const target = treeOf(got.file);
    if (!target) return { kind: "repo", file: got.file, line: got.line, lands: "unread" };
    const here = declarationsOn(target, got.line);
    /*
     * The compiler names a line, not a column. A line can hold a routine and a
     * parameter of it (`fn with_context<F>(self, context: F)`), and "go to
     * definition" on `context()` lands on the parameter. So a declaration
     * whose name is the one called wins; failing that, the name the checker
     * says the far side declares it under (an import renamed on the way). A
     * line that only mentions the called name as something with no name of its
     * own -- a parameter, a pattern, an import -- is where a value is bound.
     */
    let pick = here.find((one) => one.name === name) ?? here.find((one) => one.name === checkerAs);
    const lineText = (read(got.file) ?? "").split("\n")[got.line - 1] ?? "";
    const mentioned = name !== "" && new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`).test(lineText);
    if (!pick && !mentioned) pick = here.find((one) => one.lands !== "value") ?? here[0];
    /*
     * Rust writes routines a person never typed: `#[derive(Clone)]` writes
     * `clone`, a `macro_rules!` body or an invocation like
     * `top_level_handler_fn!(get, GET)` writes `get`. "Go to definition" lands
     * on that line, and the routine is the repo's, so it is a placement.
     */
    if (!pick && lang === "rust") {
      if (/^\s*#\[derive\(/.test(lineText)) pick = { name, lands: "routine" };
      else if (/^\s*[\w:]+!\s*[([{]/.test(lineText) || insideMacroDefinition(target, got.line)) pick = { name, lands: "macro" };
    }
    if (!pick) return { kind: "repo", file: got.file, line: got.line, lands: "value" };
    return { kind: "repo", file: got.file, line: got.line, name: pick.name, lands: pick.lands, ...(pick.holder ? { holder: pick.holder } : {}) };
  };

  const zero = (): Record<Bin, number> => Object.fromEntries(BINS.map((one) => [one, 0])) as Record<Bin, number>;
  const bins = Object.fromEntries(LANGS.map((one) => [one, { live: zero(), text: zero() }])) as Summary["bins"];
  const shapes = Object.fromEntries(LANGS.map((one) => [one, { live: {}, text: {} }])) as Summary["shapes"];
  const neitherWhy = Object.fromEntries(LANGS.map((one) => [one, { live: {}, text: {} }])) as Summary["neitherWhy"];
  const rowsPath = path.join(RUN, setName, `${project}.jsonl`);
  writeFileSync(rowsPath, "");
  let buffer: string[] = [];
  const flush = () => { if (buffer.length) appendFileSync(rowsPath, buffer.join("\n") + "\n"); buffer = []; };

  for (const [file, mine] of entries) {
    const language = languageOf(file)!;
    const lang = langOf(language);
    const source = read(file)!;
    const live = callSitesIn({
      file, source, language, imports: imports(file, source), open,
      declarationAt: (at) => {
        const got = raw.get(rawKey(file, at.start));
        return got === undefined || got === "threw" ? undefined : got;
      },
    });
    const tree = parseSource(source, language)?.rootNode as Node | undefined;
    const calls = tree ? callsByName(tree) : new Map<number, Node>();
    const liveTokens = tree && language === "rust" && live.read ? tokensInBodies(tree, live) : [];
    const liveSites = sitesOf(live, calls, new Set(liveTokens.flatMap((tokens) => callsInTokens(tokens).map((ident) => ident.startIndex))));
    for (const entry of mine.values()) {
      // A `.call` the compilers place as a call of its function value is named there (#470).
      const l = liveSites.get(entry.key) ?? (entry.valueAt ? liveSites.get(`n:${entry.valueAt.start}`) : undefined);
      const liveAnswer: CheckerAnswer = l?.several ? { file: l.several[0]!.file, several: true } : l ? answerOf(l.site) : entry.text;
      const compiler = interpret(file, entry.askAt, lang, entry.name, liveAnswer.as ?? entry.text.as);
      const bin = { live: binOf(liveAnswer, compiler), text: binOf(entry.text, compiler) };
      let call: Node | undefined;
      let routine: Node | undefined;
      if (tree) {
        const at = entry.askAt ?? undefined;
        let n: Node | null = at ? tree.descendantForIndex(at.start, at.end) : null;
        if (!at) {
          const m = /^c:(\d+):(\d+)$/.exec(entry.key);
          if (m) {
            const onLine: Node[] = [];
            const row = Number(m[1]) - 1;
            const walk = (x: Node): void => {
              if (x.startPosition.row > row || x.endPosition.row < row) return;
              if (x.startPosition.row === row && isCall(x) && !nameLeaf(x)) onLine.push(x);
              for (let i = 0; i < x.namedChildCount; i++) walk(x.namedChild(i)!);
            };
            walk(tree);
            n = onLine[Number(m[2])] ?? null;
          }
        }
        for (let k = 0; n && k < 6; k++, n = n.parent) if (isCall(n)) { call = n; break; }
        for (let p = call?.parent ?? null; p; p = p.parent) {
          const nm = p.type === "impl_item" ? null : p.childForFieldName("name") ?? p.childForFieldName("left");
          if (nm?.text === entry.routine && (p.childForFieldName("parameters") || p.childForFieldName("value")?.childForFieldName("parameters"))) {
            routine = FN.has(p.type) ? p : p.childForFieldName("value") ?? p;
            break;
          }
        }
      }
      const unplaced = bin.live === "gap" || bin.live === "neither" || bin.text === "gap" || bin.text === "neither";
      const shape = unplaced && entry.text.why
        ? shapeOf({
          why: entry.text.why, name: entry.name, language, call, routine, root: tree!, source,
          declares: (name) => declared.get(lang)!.has(name),
        })
        : undefined;
      const silentWhy = compiler.kind === "silent" ? (compiler.why === "no-name" ? "no name to ask at" : "compiler had no answer")
        : compiler.kind === "repo" ? "compiler named a variable, parameter or import" : "";
      for (const arm of ARMS) {
        bins[lang][arm][bin[arm]]++;
        if (bin[arm] === "neither") neitherWhy[lang][arm][silentWhy] = (neitherWhy[lang][arm][silentWhy] ?? 0) + 1;
        if (shape && (bin[arm] === "gap" || bin[arm] === "neither")) {
          const byShape = (shapes[lang][arm][bin[arm]] ??= {});
          byShape[shape] = (byShape[shape] ?? 0) + 1;
        }
      }
      const row: Row = {
        set: setName, project, lang, file, line: entry.line, key: entry.key, routine: entry.routine, name: entry.name,
        text: (call?.text ?? "").replace(/\s+/g, " ").slice(0, 100),
        checker: { live: liveAnswer, text: entry.text }, compiler, bin, ...(shape ? { shape } : {}),
      };
      buffer.push(JSON.stringify(row));
      if (buffer.length >= 2000) flush();
    }
  }
  flush();

  const summary: Summary = {
    set: setName, project, root, libraries, seconds: Math.round((Date.now() - started) / 1000),
    files: fileCount, routines: routineCount, bins, neitherWhy, shapes, diagnostics, answers: { reused, asked },
  };
  writeFileSync(path.join(RUN, setName, `${project}.json`), JSON.stringify(summary, null, 1));
  writeFileSync(path.join(RUN, setName, `${project}.done`), new Date().toString());
}

/* ------------------------------------------------- what a kept answer rests on */

/**
 * What every answer in a project depends on (#481): the clone's commit and
 * working tree, the root read, and the libraries installed for it. Undefined
 * when the root is not the top of a git checkout -- there is no commit to key
 * on, and a guess would let a changed tree reuse old answers.
 */
function projectKeyOf(root: string, librariesDir: string, libraries: string): AnswerKey | undefined {
  const git = (...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] });
  let commit: string;
  try {
    if (path.resolve(git("rev-parse", "--show-toplevel").trim()) !== realpathSync(root)) return undefined;
    commit = git("rev-parse", "HEAD").trim();
  } catch { return undefined; }
  const tree = sha1(git("status", "--porcelain", "--untracked-files=all") + git("diff", "HEAD"));
  const installed = path.join(librariesDir, "installed.json");
  const pins = libraries === "none" ? "none" : existsSync(installed) ? sha1(readFileSync(installed, "utf8")) : "unrecorded";
  return { commit, tree, root, libraries, pins };
}

/** The files that ask the compilers and decide what is outside the tree: a change in any of them asks everything again. */
const ASKING_FILES = ["referee-ts.ts", "referee-python-lsp.ts", "referee-rust-lsp.ts", "lsp-symbols.ts", "server-process.ts"]
  .map((one) => path.join(REPO, "src", "engine", one));
let askingHash: string | undefined;
const compilerKeys = new Map<string, AnswerKey>();

/** What a language's answers depend on beyond the project: the compiler's version and the code that asks it. */
function compilerKeyOf(lang: Lang, crate?: string): AnswerKey {
  const id = `${lang}:${crate ?? ""}`;
  const had = compilerKeys.get(id);
  if (had) return had;
  askingHash ??= sha1(ASKING_FILES.map((one) => readFileSync(one, "utf8")).join("\0"));
  const run = (command: string, args: string[], cwd?: string): string => {
    try { return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return "unavailable"; }
  };
  const key: AnswerKey = { asking: askingHash };
  if (lang === "ts") key.compiler = `typescript ${typescriptModule()?.version ?? "unavailable"}`;
  else if (lang === "python") {
    key.compiler = `pyright ${PYRIGHT_VERSION}`;
    // pyright finds the project's libraries through whichever Python is first on PATH.
    key.python = run("sh", ["-c", "for p in python python3; do command -v $p && $p --version; done; true"]);
  } else key.compiler = run("rust-analyzer", ["--version"], crate); // rustup picks the toolchain per crate
  compilerKeys.set(id, key);
  return key;
}

/** Every tsconfig the TypeScript referee may read, with its own errors printed. */
function tsConfigDiagnostics(root: string, say: (line: string) => void): void {
  let ts: typeof import("typescript");
  try { ts = createRequire(path.join(REPO, "package.json"))("typescript") as typeof import("typescript"); } catch { say("tsc: typescript is not installed here"); return; }
  const found: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (["node_modules", ".git", "dist", "out", "target"].includes(name)) continue;
      const full = path.join(dir, name);
      if (/^tsconfig.*\.json$/.test(name)) found.push(full);
      else if (!name.includes(".")) walk(full);
    }
  };
  walk(root);
  for (const config of found) {
    const read = ts.readConfigFile(config, ts.sys.readFile);
    const errors = [...(read.error ? [read.error] : [])];
    if (!read.error) errors.push(...ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(config)).errors);
    for (const one of errors) {
      say(`tsconfig ${path.relative(root, config)}: ${ts.flattenDiagnosticMessageText(one.messageText, " ")}`);
    }
  }
}

/* -------------------------------------------------------------------- tables */

type Summaries = Summary[];
const pct = (n: number, d: number): string => (d === 0 ? "–" : `${Math.round((100 * n) / d)}%`);

function loadRun(dir: string): Summaries {
  const out: Summaries = [];
  for (const setName of SET_ORDER) {
    const folder = path.join(dir, setName);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).filter((one) => one.endsWith(".done")).sort()) {
      out.push(JSON.parse(readFileSync(path.join(folder, name.replace(/\.done$/, ".json")), "utf8")) as Summary);
    }
  }
  return out;
}

function tables(summaries: Summaries, failed: string[]): string {
  const lines: string[] = [];
  const add = (line = "") => lines.push(line);
  const sets = SET_ORDER.filter((one) => summaries.some((s) => s.set === one));
  add(`Run: \`${RUN}\` — ${summaries.length} projects (${sets.map((one) => `${one} ${summaries.filter((s) => s.set === one).length}`).join(", ")}).`);
  if (failed.length) add(`**Not measured:** ${failed.join("; ")}.`);
  add();
  for (const arm of ARMS) {
    add(arm === "live"
      ? "**Checker as the bench runs it** (text reading + \"go to definition\" for calls it can't place by name)"
      : "**Text reading alone** (no compiler)");
    add();
    add(`| Language | Set | Calls | agree | disagree | gap | neither | checker-only |`);
    add(`|---|---|--:|--:|--:|--:|--:|--:|`);
    for (const lang of LANGS) {
      for (const setName of [...sets, "all"]) {
        const rows = summaries.filter((s) => setName === "all" || s.set === setName);
        const b = Object.fromEntries(BINS.map((bin) => [bin, rows.reduce((t, s) => t + s.bins[lang][arm][bin], 0)])) as Record<Bin, number>;
        const total = BINS.reduce((t, bin) => t + b[bin], 0);
        if (total === 0) continue;
        const cell = (bin: Bin) => `${b[bin]} (${pct(b[bin], total)})`;
        add(`| ${setName === "all" ? `**${lang}**` : lang} | ${setName === "all" ? "**all**" : setName} | ${total} | ${BINS.map(cell).join(" | ")} |`);
      }
    }
    add();
  }
  add("**Why the compiler placed nothing, in `neither`** (checker as the bench runs it)");
  add();
  add("| Language | compiler had no answer | compiler named a variable, parameter or import | no name to ask at |");
  add("|---|--:|--:|--:|");
  for (const lang of LANGS) {
    const n = (why: string) => summaries.reduce((t, s) => t + (s.neitherWhy?.[lang]?.live?.[why] ?? 0), 0);
    const cells = ["compiler had no answer", "compiler named a variable, parameter or import", "no name to ask at"].map(n);
    if (cells.some((one) => one > 0)) add(`| ${lang} | ${cells.join(" | ")} |`);
  }
  add();
  for (const bin of ["gap", "neither"] as const) {
    add(`**${bin === "gap" ? "Gap" : "Neither"} by shape** (checker as the bench runs it; text-only in brackets; m · h · hb = main · holdout · holdout-b)`);
    add();
    add(`| Shape | Issue | ${LANGS.map((one) => `${one} (m · h · hb)`).join(" | ")} | All |`);
    add(`|---|---|${LANGS.map(() => "--:").join("|")}|--:|`);
    const all = new Set<string>();
    for (const s of summaries) for (const lang of LANGS) for (const arm of ARMS) for (const k of Object.keys(s.shapes[lang][arm][bin] ?? {})) all.add(k);
    const count = (shape: string, lang: Lang, arm: Arm, setName?: string) => summaries
      .filter((s) => !setName || s.set === setName)
      .reduce((t, s) => t + (s.shapes[lang][arm][bin]?.[shape] ?? 0), 0);
    const order = [...all].sort((a, b) => LANGS.reduce((t, l) => t + count(b, l, "live") + count(b, l, "text"), 0)
      - LANGS.reduce((t, l) => t + count(a, l, "live") + count(a, l, "text"), 0));
    for (const shape of order) {
      const cells = LANGS.map((lang) => {
        const live = count(shape, lang, "live");
        const text = count(shape, lang, "text");
        if (live === 0 && text === 0) return "";
        const split = SET_ORDER.map((one) => count(shape, lang, "live", one)).join(" · ");
        return `${live} [${text}] (${split})`;
      });
      const liveAll = LANGS.reduce((t, l) => t + count(shape, l, "live"), 0);
      const textAll = LANGS.reduce((t, l) => t + count(shape, l, "text"), 0);
      add(`| ${shape} | ${ISSUE_OF[shape] ?? ""} | ${cells.join(" | ")} | ${liveAll} [${textAll}] |`);
    }
    add();
  }
  for (const line of whereItLands(summaries)) add(line);
  const seconds = summaries.reduce((t, s) => t + s.seconds, 0);
  add(`Projects took ${Math.round(seconds / 60)} min in all. Compiler notes per project are in each \`<project>.json\` (\`diagnostics\`).`);
  return lines.join("\n");
}

/**
 * Read from the rows, because a summary does not keep it: how often the
 * compiler answered, whether an agreement or a gap lands inside the repo or in
 * a library, and the live gap per layer-1 issue. A gap call into a library
 * still counts: while it is unplaced, the checker cannot rule it out as the
 * call an arrow names.
 */
function whereItLands(summaries: Summaries): string[] {
  type Tally = { calls: number; answered: number; agreeRepo: number; agreeOut: number; gapRepo: number; gapOut: number; issue: Record<string, [number, number]> };
  const tally = Object.fromEntries(LANGS.map((one) => [one, { calls: 0, answered: 0, agreeRepo: 0, agreeOut: 0, gapRepo: 0, gapOut: 0, issue: {} }])) as Record<Lang, Tally>;
  for (const s of summaries) {
    const rowsPath = path.join(RUN, s.set, `${s.project}.jsonl`);
    if (!existsSync(rowsPath)) continue;
    for (const line of readFileSync(rowsPath, "utf8").split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line) as Row;
      const t = tally[row.lang];
      const inRepo = row.compiler.kind === "repo";
      t.calls++;
      if (row.compiler.kind !== "silent") t.answered++;
      if (row.bin.live === "agree") inRepo ? t.agreeRepo++ : t.agreeOut++;
      if (row.bin.live === "gap") {
        inRepo ? t.gapRepo++ : t.gapOut++;
        const cell = (t.issue[ISSUE_OF[row.shape ?? ""] ?? "no layer-1 issue"] ??= [0, 0]);
        cell[inRepo ? 0 : 1]++;
      }
    }
  }
  const out = ["**Where the compiler lands** (checker as the bench runs it; \"library\" is anything outside the repo, built-ins included)", "",
    "| Language | Calls | compiler answered | agree: in repo · library | gap: in repo · library |", "|---|--:|--:|--:|--:|"];
  for (const lang of LANGS) {
    const t = tally[lang];
    if (t.calls) out.push(`| ${lang} | ${t.calls} | ${t.answered} (${pct(t.answered, t.calls)}) | ${t.agreeRepo} · ${t.agreeOut} | ${t.gapRepo} · ${t.gapOut} |`);
  }
  out.push("", "**Gap per layer-1 issue** (checker as the bench runs it; share of the language's gap; in repo · library)", "",
    `| Issue | ${LANGS.join(" | ")} |`, `|---|${LANGS.map(() => "--:").join("|")}|`);
  for (const issue of ["#468", "#469", "#470", "#471", "no layer-1 issue"]) {
    const cells = LANGS.map((lang) => {
      const [repo, out_] = tally[lang].issue[issue] ?? [0, 0];
      const gap = tally[lang].gapRepo + tally[lang].gapOut;
      return repo + out_ === 0 ? "" : `${repo + out_} (${pct(repo + out_, gap)}; ${repo} · ${out_})`;
    });
    out.push(`| ${issue} | ${cells.join(" | ")} |`);
  }
  out.push("");
  return out;
}

/** Site by site against an earlier run: what moved between bins, and every new disagreement. */
function compare(before: string, after: string): string {
  const lines: string[] = [];
  const moves = new Map<string, number>();
  const newDisagreements: string[] = [];
  const gapByShape = new Map<string, { before: number; after: number }>();
  for (const setName of SET_ORDER) {
    const folder = path.join(after, setName);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).filter((one) => one.endsWith(".jsonl"))) {
      const old = path.join(before, setName, name);
      if (!existsSync(old)) { lines.push(`(${setName}/${name} has no earlier run; skipped)`); continue; }
      const index = new Map<string, Row>();
      for (const line of readFileSync(old, "utf8").split("\n")) {
        if (!line) continue;
        const row = JSON.parse(line) as Row;
        index.set(`${row.file}|${row.key}`, row);
      }
      for (const line of readFileSync(path.join(folder, name), "utf8").split("\n")) {
        if (!line) continue;
        const row = JSON.parse(line) as Row;
        const was = index.get(`${row.file}|${row.key}`);
        const from = was?.bin.live ?? "(new call)";
        const label = `${row.lang}: ${from} -> ${row.bin.live}`;
        if (from !== row.bin.live) moves.set(label, (moves.get(label) ?? 0) + 1);
        if (row.bin.live === "disagree" && from !== "disagree") {
          newDisagreements.push(`${setName}/${row.project} ${row.file}:${row.line} ${row.name} — ${row.text}`);
        }
        for (const [r, side] of [[was, "before"], [row, "after"]] as const) {
          if (r?.bin.live === "gap" && r.shape) {
            const k = `${r.lang} | ${r.shape}`;
            const v = gapByShape.get(k) ?? { before: 0, after: 0 };
            v[side]++;
            gapByShape.set(k, v);
          }
        }
      }
    }
  }
  lines.push("", "Moves between bins (checker as the bench runs it):");
  for (const [label, n] of [...moves.entries()].sort((a, b) => b[1] - a[1])) lines.push(`  ${String(n).padStart(6)}  ${label}`);
  lines.push("", "Gap by language and shape, before -> after:");
  for (const [k, v] of [...gapByShape.entries()].sort((a, b) => (b[1].before - b[1].after) - (a[1].before - a[1].after))) {
    if (v.before !== v.after) lines.push(`  ${k}: ${v.before} -> ${v.after}`);
  }
  lines.push("", `New disagreements: ${newDisagreements.length}`);
  for (const one of newDisagreements) lines.push(`  ${one}`);
  return lines.join("\n");
}

/* ----------------------------------------------------------------- the parent */

await initEngine();

const one = flag("one");
if (one) {
  const [setName, project] = one.split("/");
  if (!setName || !project || !SETS[setName]) throw new Error(`--one=${one}: want <set>/<project>`);
  mkdirSync(path.join(RUN, setName), { recursive: true });
  await measureOne(setName, project);
  process.exit(0);
}

const wanted = (flag("set") ?? SET_ORDER.join(",")).split(",");
for (const name of wanted) {
  if (/^holdout-c$/.test(name)) throw new Error("holdout-c is score only: the census reads every call's code, so it never runs there.");
  if (!SETS[name]) throw new Error(`--set=${name}: the census sets are ${SET_ORDER.join(", ")}`);
}

const compareTo = flag("compare");
if (compareTo) {
  console.log(compare(path.resolve(compareTo), RUN));
  process.exit(0);
}

const only = flag("only")?.split(",");
const reuse = flag("reuse");
if (reuse && !existsSync(path.join(path.resolve(reuse), "answers"))) throw new Error(`--reuse=${reuse}: no answers/ there; it is not a census run that kept its compiler answers`);
const minutes = Number(flag("timeout-min") ?? 90);
const failed: string[] = [];
const log = (line: string) => {
  const stamp = new Date().toLocaleString("sv-SE");
  process.stderr.write(`${stamp} ${line}\n`);
  mkdirSync(RUN, { recursive: true });
  appendFileSync(path.join(RUN, "run.log"), `${stamp} ${line}\n`);
};

if (!argv.includes("--table")) {
  mkdirSync(RUN, { recursive: true });
  log(`census into ${RUN}${reuse ? `, reusing compiler answers from ${path.resolve(reuse)}` : ""}`);
  for (const setName of wanted) {
    mkdirSync(path.join(RUN, setName), { recursive: true });
    for (const project of SETS[setName]!.projects()) {
      if (only && !only.includes(project)) continue;
      if (existsSync(path.join(RUN, setName, `${project}.done`))) continue;
      await waitForQuiet(log);
      log(`${setName}/${project}`);
      // The child's notes go to the terminal and to run.log as they happen.
      const run = spawnSync(process.execPath, [...process.execArgv, SELF, `--one=${setName}/${project}`, `--out=${RUN}`, ...(reuse ? [`--reuse=${reuse}`] : [])], {
        stdio: ["ignore", "inherit", "inherit"], timeout: minutes * 60_000,
      });
      if (run.status !== 0 || !existsSync(path.join(RUN, setName, `${project}.done`))) {
        const why = run.error ? run.error.message : `exit ${run.status ?? run.signal}`;
        failed.push(`${setName}/${project} (${why})`);
        log(`FAILED ${setName}/${project}: ${why}`);
      }
    }
  }
}

const summaries = loadRun(RUN).filter((s) => wanted.includes(s.set) && (!only || only.includes(s.project)));
if (!argv.includes("--table")) {
  const reusedAll = summaries.reduce((t, s) => t + (s.answers?.reused ?? 0), 0);
  const askedAll = summaries.reduce((t, s) => t + (s.answers?.asked ?? 0), 0);
  log(`compiler questions: ${reusedAll} reused, ${askedAll} asked, over ${summaries.length} projects`);
}
const table = tables(summaries, failed);
writeFileSync(path.join(RUN, "tables.md"), table + "\n");
console.log(table);
