#!/usr/bin/env node
/**
 * Can a name the language provides be confused with one a repository declares? (#337)
 *
 *   npm run measure:builtins                    -- the fifteen pinned corpus repos
 *   npm run measure:builtins -- <path>...       -- any trees you like
 *   npm run measure:builtins -- --all           -- every collision, not the first few
 *
 * **A measurement. No word ships from it and nothing here can colour a diagram.**
 *
 * ## What is being refereed
 *
 * `src/engine/builtins.ts` lets a call on `isinstance`, `Number` or `Ok` be
 * placed **outside the repository** instead of doubted, which lets a body
 * close and lets `@calls` refute from its absence. So this reader can now put
 * a name somewhere, and the one way it can be wrong is the one worth
 * measuring: the repository declares a name of its own that shadows a
 * built-in, and a call on that name means the repository's rather than the
 * language's.
 *
 * The languages rule most of it out by themselves -- Python, Rust and
 * ECMAScript modules all make a file declare or import a name before it may
 * use one, and the placement is only reached where the file does neither. But
 * "the language says so" is an argument, not a number, and an argument is
 * what the gate in AGENTS.md exists to refuse.
 *
 * ## Two referees, because there are two ways to be wrong
 *
 * The first version of this asked whether the repository declares the name
 * *anywhere*, and the answer was 53 collisions -- `super` in django, `Ok` in
 * serde_json, `format` in clap. Every one was a method inside a class or an
 * associated type inside an `impl`, neither of which shadows anything for a
 * bare call in another file. The question was wrong, so the number was noise.
 *
 * The two questions that are not:
 *
 *   **the same file declares it at top level.** That is the only shadow the
 *   languages allow to reach a bare call, and it is asked by a line scan
 *   anchored at column zero -- no tree-sitter query, no grammar table, no
 *   import resolution, nothing `calls.ts` uses. (The reader would answer this
 *   itself, from `bindings.local`; a referee that asked it the reader's way
 *   would agree with the reader for the reader's own reasons.)
 *
 *   **the compiler disagrees.** For TypeScript only, and it is the language
 *   that needs it: a `.d.ts` can `declare global` a name into every file at
 *   once, which is the one shadow no rule about imports rules out. Asked as
 *   "go to definition" at the call's own range, through the same
 *   `symbolDeclarationAt` #329 refereed placements with, and a declaration
 *   inside the tree is a disagreement.
 *
 * Python and Rust get the first only. Neither has an ambient global: a bare
 * name is the module's, the crate prelude's, or the language's, and a file
 * that declares and imports neither has left the language's.
 *
 * ## What it prints
 *
 * Per language: how many call sites this placement now answers for, and how
 * many of those either referee calls wrong. The second number is the hazard,
 * and it has to be nil before anything may accuse on the strength of this.
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { sourceFiles } from "./lib/source-files";

import { callSitesIn, EXTERNAL_RECEIVER, type CallSide } from "../src/engine/calls";
import { createTsReferee, isOutsideTree } from "../src/engine/referee-ts";
import { PROVIDED } from "../src/engine/builtins";
import { readDependencies } from "../src/engine/deps";
import { createWorkspace } from "../src/engine/drift";
import { initEngine, languageOf, type Language } from "../src/engine/parse";
import type { ConfigCache } from "../src/engine/resolve";

const HOME = process.env.HOME ?? "";
const CORPUS = path.join(HOME, "board-ai", ".corpus");
/** A tree that will not finish is named in the report, never dropped (#274). */
const BUDGET = 10 * 60_000;

const flags = new Set(process.argv.slice(2).filter((one) => one.startsWith("--")));
const given = process.argv.slice(2).filter((one) => !one.startsWith("--"));
const oneTree = flags.has("--one") ? given[0] : undefined;
const showAll = flags.has("--all");

/**
 * The corpus is named by its directory rather than discovered anywhere else:
 * the fifteen repositories pinned by #278, which is the population every
 * licence number in this repository is quoted against.
 */
const corpusTrees = (): string[] => (existsSync(CORPUS)
  ? readdirSync(CORPUS)
    .map((one) => path.join(CORPUS, one))
    .filter((one) => statSync(one).isDirectory())
  : []);

const trees = oneTree ? [oneTree] : given.length > 0 ? given : corpusTrees();

/**
 * Every way each grammar writes "this name is declared at the top of this
 * file", as text, anchored at column zero.
 *
 * The anchor is the whole of it. A `def list(self)` indented inside a class is
 * a method and shadows nothing; `list = ...` at the left margin is a module
 * name and shadows the built-in for every bare call in that file. Reading the
 * two as one is what made the first version of this script report 53 hazards
 * that were not hazards.
 */
const DECLARES: Record<Language, (name: string) => RegExp> = {
  ts: (n) => new RegExp(String.raw`^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|const|let|var|interface|type|enum|namespace)\s+${n}\b`, "m"),
  tsx: (n) => DECLARES.ts(n),
  js: (n) => DECLARES.ts(n),
  python: (n) => new RegExp(String.raw`^(async\s+)?(def|class)\s+${n}\b|^${n}\s*(:[^=\n]*)?=`, "m"),
  rust: (n) => new RegExp(String.raw`^(pub(\([^)]*\))?\s+)?(unsafe\s+|async\s+|extern\s+"[^"]*"\s+)*(fn|struct|enum|trait|type|static|const|union|mod)\s+${n}\b|^macro_rules!\s*${n}\b`, "m"),
};

/** One tree's answer, as it crosses between a child process and this one. */
interface Tallies {
  tree: string;
  placed: Array<[Language, number]>;
  refereed: Array<[Language, number]>;
  wrong: Array<{
    language: Language; name: string; file: string; line: number;
    by: "same-file" | "compiler"; said?: string;
  }>;
}

async function measureOne(tree: string): Promise<Tallies> {
  await initEngine();
  const workspace = createWorkspace(tree);
  const configs: ConfigCache = new Map();
  const sources = new Map<string, string>();
  const importsOf = new Map<string, CallSide["imports"]>();
  const read = (rel: string): string | undefined => {
    if (sources.has(rel)) return sources.get(rel);
    const absolute = workspace.resolve(rel);
    if (!absolute || workspace.stat(absolute) !== "file") return undefined;
    const text = workspace.read(absolute);
    sources.set(rel, text);
    return text;
  };
  const imports = (rel: string, source: string): CallSide["imports"] => {
    const cached = importsOf.get(rel);
    if (cached) return cached;
    const declared = readDependencies(rel, source, workspace, configs)?.dependencies ?? [];
    const list = declared.map((one) => (
      { specifier: one.specifier, ...(one.file ? { file: one.file } : {}) }));
    importsOf.set(rel, list);
    return list;
  };
  const open = (rel: string) => {
    const source = read(rel);
    const language = languageOf(rel);
    if (source === undefined || !language) return undefined;
    return { source, language, imports: imports(rel, source) };
  };

  /*
   * Built lazily, and only for the TypeScript half: a `ts.Program` over a
   * repository this size costs seconds, and there is nothing for it to answer
   * in a tree with no TypeScript in it.
   */
  let checker: ReturnType<typeof createTsReferee> | undefined;
  let checkerTried = false;
  const compilerSays = (file: string, at: { start: number; end: number }): string | undefined => {
    if (!checkerTried) {
      checkerTried = true;
      try { checker = createTsReferee(tree); } catch { checker = undefined; }
    }
    return checker?.symbolDeclarationAt(file, at.start, at.end);
  };

  const placed = new Map<Language, number>();
  const refereed = new Map<Language, number>();
  const wrong: Tallies["wrong"] = [];

  for (const file of sourceFiles(tree)) {
    const rel = path.relative(tree, file);
    const source = read(rel);
    const language = languageOf(rel);
    if (source === undefined || !language) continue;
    const reading = callSitesIn({
      file: rel, source, language, imports: imports(rel, source), open,
    });
    if (!reading.read) continue;
    for (const body of reading.bodies) {
      for (const site of body.sites) {
        if (site.file !== EXTERNAL_RECEIVER || site.receiver) continue;
        if (!PROVIDED[language].has(site.name)) continue;
        const bump = (into: Map<Language, number>) => into.set(language, (into.get(language) ?? 0) + 1);
        bump(placed);
        /*
         * Counted here rather than in the branches below, and the first
         * version counted it there: `refereed` printed 0 for Python and Rust
         * while every one of their 33,894 sites had in fact been put to the
         * same-file scan, because only a site the scan *caught* was tallied.
         * A referee column that reads zero when the referee ran is the exact
         * shape of number AGENTS.md says to check before quoting.
         */
        bump(refereed);

        // Referee one: does this very file declare the name at its left margin?
        if (DECLARES[language](site.name).test(source)) {
          wrong.push({ language, name: site.name, file: rel, line: site.line, by: "same-file" });
          continue;
        }

        // Referee two, TypeScript only: ask the compiler where it is declared.
        if (language === "rust" || language === "python" || !site.nameAt) continue;
        const said = compilerSays(file, site.nameAt);
        if (said !== undefined && !isOutsideTree(said, tree)) {
          wrong.push({
            language, name: site.name, file: rel, line: site.line,
            by: "compiler", said: path.relative(tree, said),
          });
        }
      }
    }
  }

  return { tree: path.basename(tree), placed: [...placed], refereed: [...refereed], wrong };
}

if (oneTree) {
  process.stdout.write(JSON.stringify(await measureOne(oneTree)));
} else {
  const { spawnSync } = await import("node:child_process");
  /*
   * A process per tree. One process reading fifteen repositories dies twice
   * over -- the JS heap first, then tree-sitter's own wasm heap, which no
   * `--max-old-space-size` touches. Each child's answer is kept, so a second
   * run costs only the trees that have not been read yet.
   */
  const KEEP = process.env.BUILTINS_OUT ?? path.join(HOME, "board-ai-337-out", "builtins");
  mkdirSync(KEEP, { recursive: true });
  const all: Tallies[] = [];
  const unfinished = new Map<string, string>();
  for (const tree of trees) {
    const kept = path.join(KEEP, `${path.basename(tree)}.json`);
    let printed: string | undefined;
    if (!flags.has("--fresh") && existsSync(kept)) {
      printed = readFileSync(kept, "utf8");
      console.error(`${path.basename(tree)} -- kept from an earlier run`);
    } else {
      console.error(`reading ${path.basename(tree)}`);
      const run = spawnSync(process.execPath, [
        ...process.execArgv, process.argv[1]!, "--one", tree,
      ], {
        encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: process.env,
        stdio: ["ignore", "pipe", "inherit"], timeout: BUDGET,
      });
      const out = (run.stdout ?? "").trim();
      if (run.status !== 0 || !out.startsWith("{")) {
        /*
         * A tree that runs out of its budget is named in the report rather
         * than silently dropped: a corpus that quietly shrank is how four
         * numbers on #274 became shares of 15% of what they claimed.
         */
        const why = run.signal ? `over its ${BUDGET / 60_000}-minute budget` : `exit ${run.status}`;
        unfinished.set(path.basename(tree), why);
        console.error(`  ${path.basename(tree)} did not finish (${why})`);
        continue;
      }
      writeFileSync(kept, out);
      printed = out;
    }
    all.push(JSON.parse(printed) as Tallies);
  }

  const placed = new Map<Language, number>();
  const refereed = new Map<Language, number>();
  const wrong: Array<Tallies["wrong"][number] & { tree: string }> = [];
  for (const one of all) {
    for (const [language, count] of one.placed) placed.set(language, (placed.get(language) ?? 0) + count);
    for (const [language, count] of one.refereed) refereed.set(language, (refereed.get(language) ?? 0) + count);
    for (const row of one.wrong) wrong.push({ ...row, tree: one.tree });
  }

  const total = (of: Map<Language, number>) => [...of.values()].reduce((a, b) => a + b, 0);
  console.log("");
  console.log("#337 · A NAME THE LANGUAGE PROVIDES, PUT TO THE REPOSITORIES THAT MIGHT SHADOW IT");
  console.log(`  ${all.length} of ${trees.length} trees read`);
  console.log("");
  console.log("  CALL SITES THIS PLACEMENT NOW ANSWERS FOR");
  console.log("    a call on a built-in, in a file that neither declares nor imports the name");
  console.log("    refereed: put to the same-file scan, and in TypeScript to the compiler as well");
  console.log(`    ${"language".padEnd(9)}${"placed".padStart(9)}${"refereed".padStart(10)}${"wrong".padStart(8)}`);
  for (const language of [...placed.keys()].sort((a, b) => (placed.get(b) ?? 0) - (placed.get(a) ?? 0))) {
    const bad = wrong.filter((one) => one.language === language).length;
    console.log(`    ${language.padEnd(9)}${String(placed.get(language) ?? 0).padStart(9)}`
      + `${String(refereed.get(language) ?? 0).padStart(10)}${String(bad).padStart(8)}`);
  }
  console.log(`    ${"ALL".padEnd(9)}${String(total(placed)).padStart(9)}`
    + `${String(total(refereed)).padStart(10)}${String(wrong.length).padStart(8)}`);
  console.log("");
  console.log("  THE HAZARD -- a placement a referee calls wrong");
  console.log("    same-file: the file declares that name at its left margin, so the call is not the language's");
  console.log("    compiler:  go-to-definition lands inside the tree, so something ambient shadowed it");
  if (wrong.length === 0) {
    console.log("    none.");
  } else {
    const shown = showAll ? wrong : wrong.slice(0, 40);
    for (const one of shown) {
      console.log(`    ${one.by} · ${one.tree}/${one.file}:${one.line} · ${one.name}`
        + (one.said ? ` · declared in ${one.said}` : ""));
    }
    if (shown.length < wrong.length) console.log(`    ... and ${wrong.length - shown.length} more (--all)`);
  }
  if (unfinished.size > 0) {
    console.log("");
    console.log("  TREES THAT DID NOT FINISH -- their sites are in none of the numbers above");
    for (const [tree, why] of unfinished) console.log(`    ${tree}: ${why}`);
  }
  console.log("");
}
