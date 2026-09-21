#!/usr/bin/env node
/**
 * Can this reader say **which routine** a call reaches, or only which file? (#329)
 *
 *   npm run measure:wrong-routine                 -- this repo, plus every corpus
 *                                                    tree `measure:closed-bodies` reads
 *   npm run measure:wrong-routine -- <path>...    -- any trees you like
 *   npm run measure:wrong-routine -- --all        -- referee every site, not a sample
 *   npm run measure:wrong-routine -- --cases      -- print the disagreements
 *   npm run measure:wrong-routine -- --fresh      -- ignore what earlier runs kept
 *
 * **A measurement. No word ships from it and nothing here can colour a diagram.**
 *
 * ## The question
 *
 * `@calls` may say an arrow is wrong when it has read a routine's whole call
 * list and none of those calls reaches the far end (#233). #329 asks for the
 * one case that reading throws away: a call that lands in the far end's file,
 * at a routine the arrow does not name. Saying so out loud means comparing
 * names, and a name comparison is how a **correct** arrow gets called wrong:
 *
 *     import { render as r } from "./b";
 *     export function run() { return r(); }
 *
 * The call is written `r`, the box says `render`, and the arrow is right. So
 * the reader now carries the name the far side declares -- `declaredAs` --
 * and this script is the number that says whether it can be trusted.
 *
 * ## The referee
 *
 * A real compiler, asked "go to definition" at the call's own name: `tsc` in
 * process, pyright and rust-analyzer over their language servers. None of
 * them shares anything with the reader being judged, which places a name with
 * tree-sitter and its own import bindings and never consults a checker for
 * this question. The same three referees `measure:calls` uses (#254), asked
 * the same way, so a disagreement here is comparable with one there.
 *
 * A site agrees when the compiler's definition is in the file the reader
 * placed it in **and** the line it points at spells the name the reader says
 * it comes to rest under. Either half wrong is a site the new verdict must
 * not be allowed to rest on.
 *
 * ## What the three sections are for
 *
 *   1. how often the shape occurs at all, and how much of it the reader can
 *      name -- the ceiling on what #329 can catch, per language.
 *   2. how often the written spelling differs from the declared one -- the
 *      size of the false accusation the obvious fix would have made.
 *   3. the referee: how often the name the reader reports is the name a
 *      compiler reports. This is the number the verdict's licence rests on.
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  callSitesIn, EXTERNAL_RECEIVER, type CallSide, type CallSitePlaced, type ReceiverResolution,
} from "../src/engine/calls";
import { readDependencies } from "../src/engine/deps";
import { createWorkspace } from "../src/engine/drift";
import { initEngine, languageOf, type Language } from "../src/engine/parse";
import type { ConfigCache } from "../src/engine/resolve";

import { checkerFor, type CallChecker, type Declared } from "./lib/call-receivers";
import { createTsReferee } from "./lib/resolution-ts";

await initEngine();

const HOME = process.env.HOME ?? "/Users/noelmatero";
const flags = new Set(process.argv.slice(2).filter((one) => one.startsWith("--")));
const roots = process.argv.slice(2).filter((one) => !one.startsWith("--"));
const refereeAll = flags.has("--all");
const showCases = flags.has("--cases");

/**
 * How many sites per language **per tree** go to the compiler when `--all` is
 * not passed.
 *
 * The language servers answer one question at a time over a pipe, and the
 * corpus is hundreds of thousands of call sites. A bounded sample is a real
 * measurement as long as it is said to be one -- and it is taken per tree
 * rather than per language so that the first repository read cannot fill the
 * quota and leave the other fourteen unexamined, which would be a number
 * about one house style wearing a language's name.
 *
 * It also bounds what this holds in memory: every sampled site keeps its
 * reading alive until the referee has spoken.
 */
const SAMPLE = 400;

/**
 * `--one` marks the child process that measures a single tree and prints its
 * tallies as JSON.
 *
 * A run over fifteen repositories does not fit in one process, and neither of
 * the two ways it failed was a bug in what is being measured: eight gigabytes
 * of heap went to holding every tree's compiler program at once, and
 * tree-sitter's own WebAssembly heap -- which only `delete()` gives back --
 * ran out of bounds part-way through the sixth repository. A process per tree
 * gives both back to the operating system, which is the one collector that
 * cannot be wrong about this.
 *
 * It also makes the run resumable in the way that matters: a repository that
 * dies takes its own line down and not the report.
 */
const oneTree = flags.has("--one");

/**
 * How long one tree gets before it is abandoned and named as abandoned.
 *
 * One repository in this corpus spent three hours inside a TypeScript
 * program build for a single tree while the other fourteen waited. A
 * measurement that cannot finish is not a stricter measurement.
 */
const BUDGET = Number(process.env.WRONG_ROUTINE_BUDGET ?? 8 * 60_000);

/** Trees that did not finish, and why -- printed with the report. */
const unfinished = new Map<string, string>();

const real = (tree: string) => { try { return realpathSync(tree); } catch { return tree; } };

/**
 * The trees `measure:closed-bodies` reads, plus **every** pinned clone in
 * `.corpus` rather than the two Rust ones it names.
 *
 * #329's question is about import forms, and an import form is exactly the
 * thing each language spells differently -- so a number taken on one
 * language, or on one repository's house style, says nothing about the
 * others. The corpus is listed by reading the directory rather than by
 * naming its members, so a clone added later is measured without anybody
 * remembering to add it here.
 */
const CORPUS = `${HOME}/board-ai/.corpus`;
const corpusTrees = existsSync(CORPUS)
  ? readdirSync(CORPUS)
    .filter((entry) => !entry.startsWith("."))
    .map((entry) => path.join(CORPUS, entry))
    .filter((entry) => statSync(entry).isDirectory())
  : [];
const trees = (roots.length > 0 ? roots : [
  path.resolve("src"),
  path.resolve("scripts"),
  path.resolve("rust-test"),
  `${HOME}/orangutan`,
  `${HOME}/board-ai/graphify`,
  `${HOME}/mundane`,
  `${HOME}/infrarouter`,
  ...corpusTrees,
]).filter((tree) => existsSync(tree)).map(real);

const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", "target", "dist", "build", "out", "vendor", ".venv", ".claude",
  "coverage", ".next", ".nuxt", ".output", ".turbo", ".yarn", ".cache",
]);

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries: string[];
    try { entries = readdirSync(directory); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith(".") && entry !== ".") continue;
      if (SKIP_DIRECTORIES.has(entry)) continue;
      const full = path.join(directory, entry);
      let info;
      try { info = statSync(full); } catch { continue; }
      if (info.isDirectory()) walk(full);
      else if (languageOf(entry) !== undefined) found.push(full);
    }
  };
  walk(root);
  return found;
}

function isOutsideTree(declaringFile: string, tree: string): boolean {
  if (declaringFile.includes(`${path.sep}node_modules${path.sep}`)) return true;
  const rel = path.relative(tree, declaringFile);
  return rel.startsWith("..") || path.isAbsolute(rel);
}

/**
 * Progress, on stderr so it never lands in a report somebody pastes.
 *
 * This reads fifteen repositories and asks three language servers about them,
 * which is tens of minutes. A run with no output is a run nobody can tell
 * apart from a hang -- and the first attempt at this script spent 48 minutes
 * looking exactly like one before it ran out of memory.
 */
const say = (line: string) => process.stderr.write(`${new Date().toLocaleTimeString()} ${line}\n`);

const bump = <K,>(map: Map<K, number>, key: K, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const bumpIn = <K,>(map: Map<Language, Map<K, number>>, language: Language, key: K) => {
  const inner = map.get(language) ?? new Map<K, number>();
  map.set(language, inner);
  bump(inner, key);
};

/* ----------------------------------------------------------------- the run */

/** Section 1: sites in a closed body, placed in another file. */
const closedBodies = new Map<Language, number>();
const landings = new Map<Language, number>();
/** Of those, how many the reader can name where it comes to rest. */
const named = new Map<Language, number>();
/** Section 2: the written spelling against the declared one. */
const spelling = new Map<Language, Map<"same" | "renamed", number>>();

/** One site the compiler will be asked about. */
interface Pending {
  tree: string;
  file: string;
  language: Language;
  site: CallSitePlaced;
  routine: string;
}
const pending: Pending[] = [];

/** Section 3's tallies, filled per tree as each one is read. */
type Agreement = "agreed" | "wrong-name" | "wrong-file" | "silent" | "no-checker";
const refereed = new Map<Language, Map<Agreement, number>>();
const cases: Array<Pending & { why: Agreement; said?: Declared }> = [];
const unavailable = new Map<string, string>();
const checkerLabels = new Set<string>();

/** One tree's tallies, as they cross between a child process and this one. */
interface Tallies {
  closedBodies: Array<[Language, number]>;
  landings: Array<[Language, number]>;
  named: Array<[Language, number]>;
  spelling: Array<[Language, Array<["same" | "renamed", number]>]>;
  refereed: Array<[Language, Array<[Agreement, number]>]>;
  cases: Array<{ file: string; line: number; name: string; declaredAs: string; at: string; why: Agreement; said?: Declared; routine: string; tree: string; language: Language }>;
  unavailable: Array<[string, string]>;
  labels: string[];
}

const merge = <K,>(into: Map<Language, Map<K, number>>, from: Array<[Language, Array<[K, number]>]>) => {
  for (const [language, rows] of from) {
    for (const [key, count] of rows) {
      const inner = into.get(language) ?? new Map<K, number>();
      into.set(language, inner);
      inner.set(key, (inner.get(key) ?? 0) + count);
    }
  }
};

if (!oneTree && trees.length > 1) {
  /*
   * The parent. Each tree is measured by a child of this process, which then
   * exits -- see `oneTree`. A child that dies is reported and skipped rather
   * than taking the run with it.
   */
  const { spawnSync } = await import("node:child_process");
  /*
   * Each child's answer is kept on disk, so a second run costs only the
   * trees that have not been measured yet. A pass over this corpus is tens
   * of minutes and every previous attempt at it was thrown away whole by
   * something unrelated -- a reboot, a crash in the sixth repository, a
   * kill. `--fresh` measures everything again.
   */
  const KEEP = process.env.WRONG_ROUTINE_OUT ?? path.join(HOME, "board-ai-329-out", "wrong-routine");
  mkdirSync(KEEP, { recursive: true });
  for (const tree of trees) {
    const kept = path.join(KEEP, `${path.basename(tree)}.json`);
    let printed: string | undefined;
    if (!flags.has("--fresh") && existsSync(kept)) {
      printed = readFileSync(kept, "utf8");
      say(`${path.basename(tree)} -- kept from an earlier run`);
    } else {
      say(`measuring ${path.basename(tree)}`);
      const run = spawnSync(process.execPath, [
        ...process.execArgv, process.argv[1]!, "--one", tree, ...(refereeAll ? ["--all"] : []),
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
        say(`  ${path.basename(tree)} did not finish (${why})`);
        continue;
      }
      writeFileSync(kept, out);
      printed = out;
    }
    const got = JSON.parse(printed) as Tallies;
    for (const [language, count] of got.closedBodies) bump(closedBodies, language, count);
    for (const [language, count] of got.landings) bump(landings, language, count);
    for (const [language, count] of got.named) bump(named, language, count);
    merge(spelling, got.spelling);
    merge(refereed, got.refereed);
    for (const one of got.cases) {
      cases.push({
        tree: one.tree, file: one.file, language: one.language, routine: one.routine,
        site: { name: one.name, line: one.line, declaredAs: one.declaredAs, file: one.at, receiver: false },
        why: one.why, ...(one.said ? { said: one.said } : {}),
      });
    }
    for (const [where, why] of got.unavailable) unavailable.set(where, why);
    for (const label of got.labels) checkerLabels.add(label);
  }
  report();
  process.exit(0);
}

for (const tree of trees) {
  say(`reading ${path.basename(tree)}`);
  const workspace = createWorkspace(tree);
  const configs: ConfigCache = new Map();
  /** The referee's quota for this tree, per language. See `SAMPLE`. */
  const sampledHere = new Map<Language, number>();
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
   * The receiver resolver, so the population here is the one the product
   * reads (#328 wired this into every path that checks a board). TypeScript's
   * answers in process; Python's and Rust's arrive over a language server and
   * are not asked for here, so their sites are the ones the text alone places.
   */
  let tsChecker: ReturnType<typeof createTsReferee> | undefined;
  try { tsChecker = createTsReferee(tree); } catch { tsChecker = undefined; }
  const resolveReceiver = (
    at: { start: number; end: number }, file: string,
  ): ReceiverResolution | undefined => {
    const answer = tsChecker?.typeAt(file, at.start, at.end);
    if (!answer || answer.head === "any" || answer.head === "unknown" || /error/i.test(answer.head)) {
      return undefined;
    }
    if (answer.declaringFile) {
      if (isOutsideTree(answer.declaringFile, tree)) return { kind: "external" };
      return {
        kind: "declared", file: path.relative(tree, answer.declaringFile), concrete: answer.concrete,
      };
    }
    return { kind: "type", name: answer.head };
  };

  for (const file of sourceFiles(tree)) {
    const rel = path.relative(tree, file);
    const source = read(rel);
    if (source === undefined) continue;
    const language = languageOf(rel)!;

    const reading = callSitesIn({
      file: rel, source, language, imports: imports(rel, source), open,
      ...(tsChecker ? { resolveReceiver: (at) => resolveReceiver(at, file) } : {}),
    });
    if (!reading.read) continue;

    for (const body of reading.bodies) {
      /*
       * The population is the one the verdict fires on: a body whose every
       * call site was placed. An open body cannot accuse from anything, so a
       * site inside one says nothing about this reader's name answer.
       */
      const closed = body.sites.length > 0 && body.sites.every((one) => !one.why);
      if (!closed) continue;
      bump(closedBodies, language);
      for (const site of body.sites) {
        // A call that stays in its own file is not the shape: the arrow's two
        // ends are different files whenever this verdict is reached.
        if (!site.file || site.file === rel || site.file === EXTERNAL_RECEIVER) continue;
        bump(landings, language);
        if (site.declaredAs === undefined) continue;
        bump(named, language);
        bumpIn(spelling, language, site.name === site.declaredAs ? "same" : "renamed");
        if (!site.nameAt) continue;
        const asked = sampledHere.get(language) ?? 0;
        if (!refereeAll && asked >= SAMPLE) continue;
        sampledHere.set(language, asked + 1);
        pending.push({ tree, file: rel, language, site, routine: body.routine });
      }
    }
  }

  /*
   * Refereed here rather than after every tree has been read, so one tree's
   * compiler program, parse trees and file texts are all released before the
   * next is opened. Holding fifteen repositories at once is what ran the
   * first version out of eight gigabytes.
   */
  await referee(tree, pending.splice(0), read);
  say(`  done ${path.basename(tree)}`);
}

/* ------------------------------------------------------- section 3: referee */

/**
 * What a real compiler says about the sites this tree produced.
 *
 * Called once per tree, before the next is opened: a language server and a
 * compiler program are both expensive to hold, and holding fifteen of them is
 * how the first version of this ran out of memory without printing anything.
 */
async function referee(
  tree: string, sites: Pending[], read: (rel: string) => string | undefined,
): Promise<void> {
  if (sites.length === 0) return;
  say(`  refereeing ${sites.length} sites in ${path.basename(tree)}`);
  const checkers = new Map<string, Promise<CallChecker | { unavailable: string }>>();
  const checkerOf = (language: Language) => {
    const family = language === "tsx" || language === "js" ? "ts" : language;
    if (!checkers.has(family)) {
      checkers.set(family, checkerFor(tree, language).then((made) => {
        if ("unavailable" in made) unavailable.set(`${path.basename(tree)} ${family}`, made.unavailable);
        else checkerLabels.add(made.label);
        return made;
      }));
    }
    return checkers.get(family)!;
  };

  const BATCH = 16;
  for (let start = 0; start < sites.length; start += BATCH) {
    await Promise.all(sites.slice(start, start + BATCH).map(async (one) => {
      const checker = await checkerOf(one.language);
      if ("unavailable" in checker) {
        bumpIn(refereed, one.language, "no-checker");
        return;
      }
      const absolute = path.join(tree, one.file);
      const source = read(one.file);
      if (source === undefined) return;
      const said = await checker.definitionAt(absolute, source, one.site.nameAt!);
      if (!said) { bumpIn(refereed, one.language, "silent"); return; }
      /*
       * The compiler answers with an absolute path; the reader answers with a
       * repo-relative one. A definition outside the tree is a definition the
       * reader placed inside it, which is a disagreement about the file.
       */
      const placed = path.join(tree, one.site.file!);
      if (path.resolve(said.file) !== path.resolve(placed)) {
        bumpIn(refereed, one.language, "wrong-file");
        cases.push({ ...one, why: "wrong-file", said });
        return;
      }
      /*
       * The same test `landingOf` applies: the line the compiler points at
       * spells the name. Reading the line rather than asking for a symbol
       * name keeps this referee independent of how either side spells a
       * declaration.
       */
      let declaredLine = "";
      try {
        const text = readFileSync(said.file, "utf8").split("\n");
        declaredLine = text[said.line] ?? "";
      } catch { /* unreadable; treated as a disagreement below */ }
      const spells = new RegExp(`(?<![\\w$])${one.site.declaredAs!.replace(/[$]/g, "\\$")}(?![\\w$])`);
      if (spells.test(declaredLine)) bumpIn(refereed, one.language, "agreed");
      else {
        bumpIn(refereed, one.language, "wrong-name");
        cases.push({ ...one, why: "wrong-name", said });
      }
    }));
  }
  for (const made of checkers.values()) {
    const checker = await made;
    if (!("unavailable" in checker)) checker.close();
  }
}

/* ------------------------------------------------------------------ report */

/**
 * The three sections. A function because the parent process prints them after
 * merging its children's tallies, before any of the reading code below has
 * run in it at all.
 */
function report(): void {

  const LANGUAGES: Language[] = ["ts", "tsx", "js", "python", "rust"];
  const pad = (text: string | number, width: number) => String(text).padStart(width);
  const seen = LANGUAGES.filter((language) => (closedBodies.get(language) ?? 0) > 0);

  console.log(`\n# Which routine a call reaches (#329)\n`);
  console.log(`trees: ${trees.map((tree) => path.basename(tree)).join(", ")}`);
  console.log(`referee: ${[...checkerLabels].join(", ") || "none available"}`
    + (refereeAll ? ", every site" : `, up to ${SAMPLE} sites per language per tree`));

  console.log(`\n## 1. The shape, and how much of it the reader can name\n`);
  console.log(`${pad("", 8)}${pad("closed", 9)}${pad("landings", 10)}${pad("named", 8)}${pad("", 8)}`);
  for (const language of seen) {
    const land = landings.get(language) ?? 0;
    const know = named.get(language) ?? 0;
    console.log(
      `${pad(language, 8)}${pad(closedBodies.get(language) ?? 0, 9)}${pad(land, 10)}`
      + `${pad(know, 8)}${pad(land === 0 ? "n/a" : `${((know / land) * 100).toFixed(0)}%`, 8)}`,
    );
  }
  console.log(
    "\nclosed = bodies whose every call site was placed. landings = calls in one"
    + "\nthat land in another file -- the shape #329 fires on. named = the reader"
    + "\ncan say which routine it comes to rest at; the rest stay silent.",
  );

  console.log(`\n## 2. What the call site spells, against what the far side declares\n`);
  console.log(`${pad("", 8)}${pad("same", 8)}${pad("renamed", 9)}`);
  for (const language of seen) {
    const row = spelling.get(language);
    console.log(
      `${pad(language, 8)}${pad(row?.get("same") ?? 0, 8)}${pad(row?.get("renamed") ?? 0, 9)}`,
    );
  }
  console.log(
    "\nrenamed = an import gave the call a different spelling than the far side"
    + "\ndeclares. Every one of these is an arrow a name comparison would have"
    + "\ncalled wrong while it was right.",
  );

  console.log(`\n## 3. The referee: does a compiler agree about the name?\n`);
  const COLUMNS: Agreement[] = ["agreed", "wrong-name", "wrong-file", "silent", "no-checker"];
  console.log(`${pad("", 8)}${COLUMNS.map((one) => pad(one, 12)).join("")}`);
  for (const language of seen) {
    const row = refereed.get(language);
    if (!row) continue;
    console.log(`${pad(language, 8)}${COLUMNS.map((one) => pad(row.get(one) ?? 0, 12)).join("")}`);
  }
  console.log(
    "\nwrong-name and wrong-file are the sites a `wrong-routine` verdict must"
    + "\nnot rest on: the reader would name a routine the compiler does not.",
  );
  for (const [where, why] of unavailable) console.log(`  no checker: ${where} -- ${why}`);
  for (const [tree, why] of unfinished) console.log(`  not measured: ${tree} -- ${why}`);

  if (showCases && cases.length > 0) {
    console.log(`\n## The disagreements\n`);
    for (const one of cases.slice(0, refereeAll ? cases.length : 40)) {
      console.log(
        `  ${one.why}  ${path.basename(one.tree)}/${one.file}:${one.site.line}`
        + ` ${one.routine} -> ${one.site.name} as ${one.site.declaredAs}`
        + ` in ${one.site.file}; compiler says ${one.said ? `${one.said.file}:${one.said.line + 1}` : "nothing"}`,
      );
    }
  }
  console.log();
}

/*
 * A child measuring one tree hands its tallies back as JSON on stdout and
 * says nothing else; the parent merges them and prints. A lone tree named on
 * the command line prints its own report, which is what makes a single
 * repository debuggable by hand.
 */
if (oneTree) {
  const rows = <K,>(map: Map<Language, Map<K, number>>) =>
    [...map].map(([language, inner]) => [language, [...inner]] as const);
  process.stdout.write(JSON.stringify({
    closedBodies: [...closedBodies],
    landings: [...landings],
    named: [...named],
    spelling: rows(spelling),
    refereed: rows(refereed),
    cases: cases.map((one) => ({
      tree: one.tree, file: one.file, line: one.site.line, name: one.site.name,
      declaredAs: one.site.declaredAs ?? "", at: one.site.file ?? "", routine: one.routine,
      language: one.language,
      why: one.why, ...(one.said ? { said: one.said } : {}),
    })),
    unavailable: [...unavailable],
    labels: [...checkerLabels],
  }));
} else {
  report();
}
