#!/usr/bin/env node
/**
 * How far the engine can follow a chain of calls, and how often it is wrong
 * when it tries.
 *
 *   npm run measure:reach
 *   npm run measure:reach -- --only=rust --all
 *   npm run measure:reach -- --seeds=40 <tree>...
 *
 * The question. An arrow `A -> B` between two routines is right when A really
 * reaches B and wrong when it provably cannot. Both halves of the engine stop
 * near one step: the confirming search never leaves the file it started in,
 * and the only word that may say wrong (`@calls`) is about a direct call and
 * needs every call in one body resolved before it will say even that. So a
 * true arrow through a helper in another file cannot be confirmed, and a made
 * up arrow between two routines with no chain between them cannot be called
 * wrong.
 *
 * Four counts per language, and they are not equally weighted. A wrong
 * accusation is the expensive one -- `licence.ts` is one long argument for
 * why -- and a missed confirmation is merely a shrug:
 *
 *   confirmed        the referee found a chain, the reader said reached
 *   wrongly confirmed  no chain, and the reader said reached anyway
 *   wrongly accused    a chain exists, and the reader said it never reaches
 *   answered at all    neither of the two silences, as a share of asks
 *
 * The referee is in `scripts/lib/reach-graph.ts`: `tsc` for TypeScript,
 * pyright for Python, rust-analyzer for Rust, and it shares no line of
 * machinery with the reader. The question set is in `scripts/lib/reach-asks.ts`,
 * which explains what a negative ask has to earn before it counts as one.
 *
 * A run prints and never fails. What it finds becomes a test.
 */
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { callsBetween, type CallSide } from "../src/engine/calls";
import { readDependencies } from "../src/engine/deps";
import { checkSymbolEdge, createWorkspace } from "../src/engine/drift";
import { declarationMentions, declarationsOf, reaches } from "../src/engine/body";
import { initEngine, languageOf, resetEngineCache, type Language } from "../src/engine/parse";
import { newReachCache, reachBetween, type ReachCache, type ReachVerdict } from "../src/engine/reach";
import type { ConfigCache } from "../src/engine/resolve";

import { asksFrom, type Ask } from "./lib/reach-asks";
import { refereeGraph } from "./lib/reach-graph";

await initEngine();

const flags = new Set(process.argv.slice(2).filter((one) => one.startsWith("--")));
const roots = process.argv.slice(2).filter((one) => !one.startsWith("--"));
const value = (name: string, fallback: number): number => {
  const found = [...flags].find((one) => one.startsWith(`--${name}=`));
  return found ? Number(found.slice(name.length + 3)) : fallback;
};
const only = [...flags].find((one) => one.startsWith("--only="))?.slice("--only=".length);
const showAll = flags.has("--all");
const dumpTo = [...flags].find((one) => one.startsWith("--dump="))?.slice("--dump=".length);
const SEEDS = value("seeds", 30);
const BUDGET = value("budget", 120);
const DEPTH = value("depth", 6);
const PER_SEED = value("per-seed", 4);
const PER_SEED_NEVER = value("per-seed-never", 12);
/**
 * `--unguarded` also asks about never-pairs whose tail name *is* written on
 * the closure -- the ones the callback guard rejects.
 *
 * Never scored. It answers one question and only one: how much of the
 * population the product would face does the sound population cover.
 */
const unguarded = flags.has("--unguarded");

/**
 * Which repositories answer for which language, and why these.
 *
 * Two per language, one small enough to read by hand when a disagreement
 * needs explaining and one big enough that its chains are somebody else's
 * design rather than a test fixture's. All are `.corpus` clones, pinned by
 * `measure:licence`, so the numbers are reproducible from the commits in
 * `licence.ts`.
 */
const CORPUS: Array<{ tree: string; language: Language }> = [
  { tree: ".corpus/vuejs-core", language: "ts" },
  { tree: ".corpus/TanStack-query", language: "ts" },
  { tree: ".corpus/pallets-flask", language: "python" },
  { tree: ".corpus/encode-httpx", language: "python" },
  { tree: ".corpus/anyhow", language: "rust" },
  { tree: ".corpus/ripgrep", language: "rust" },
];

const real = (tree: string) => { try { return realpathSync(tree); } catch { return tree; } };

/*
 * A tree named on the command line needs its language named too, because the
 * referee is chosen by language and a tree is rarely one language only. So
 * `--only=` is what says which, and it is required there rather than
 * defaulted: a default would silently measure a Rust tree with `tsc`.
 */
const trees = (roots.length > 0
  ? roots.map((tree) => ({ tree, language: (only ?? "ts") as Language }))
  : CORPUS.filter((one) => !only || one.language === only))
  .filter((one) => existsSync(one.tree));

/* ------------------------------------------------------------- the readers */

type Answer =
  | { said: "reached" }
  | { said: "never" }
  | { said: "quiet"; why: string; doubts?: readonly string[] };

/** Everything a reader needs to be asked one pair, built once per tree. */
interface Sides {
  workspace: ReturnType<typeof createWorkspace>;
  side(rel: string): (CallSide & { routine: string }) | undefined;
}

function sidesFor(tree: string): Sides {
  const workspace = createWorkspace(tree);
  const configs: ConfigCache = new Map();
  const sources = new Map<string, string | undefined>();
  const importsOf = new Map<string, CallSide["imports"]>();

  const read = (rel: string): string | undefined => {
    if (sources.has(rel)) return sources.get(rel);
    const absolute = workspace.resolve(rel);
    const text = absolute && workspace.stat(absolute) === "file" ? workspace.read(absolute) : undefined;
    sources.set(rel, text);
    return text;
  };
  const imports = (rel: string, source: string): CallSide["imports"] => {
    const cached = importsOf.get(rel);
    if (cached) return cached;
    const declared = readDependencies(rel, source, workspace, configs)?.dependencies ?? [];
    const list = declared.map((one) => ({ specifier: one.specifier, ...(one.file ? { file: one.file } : {}) }));
    importsOf.set(rel, list);
    return list;
  };
  const open = (rel: string) => {
    const source = read(rel);
    const language = languageOf(rel);
    if (source === undefined || !language) return undefined;
    return { source, language, imports: imports(rel, source) };
  };
  return {
    workspace,
    side(rel) {
      const source = read(rel);
      const language = languageOf(rel);
      if (source === undefined || !language) return undefined;
      return { file: rel, source, language, imports: imports(rel, source), open, routine: "" };
    },
  };
}

/**
 * The **before** column, written out here rather than read off the engine.
 *
 * This is what `checkSymbolEdge` did at ef70af9, in the three lines that made
 * it up: both ends tried, a body "reaches" the far end when it *names* the far
 * end's symbol anywhere -- comments and strings excluded, members included --
 * following calls as deep as they go inside the one file it started in, and a
 * declaration read instead when one end holds no code.
 *
 * It is spelled out because the alternative does not work. Calling the live
 * `checkSymbolEdge` for this column measured the engine against itself: the
 * moment #reach put two guards inside it, the "before" number moved with the
 * "after" one and a regression would have been invisible. Written from
 * `reaches` and `declarationMentions`, which are unchanged primitives, the
 * column stays fixed and the comparison keeps meaning something. It
 * reproduces the figures it was first measured at -- 232 confirmations on the
 * TypeScript corpus, 182 on Python, 309 on Rust.
 *
 * `unreached` is *not* an accusation -- it printed amber, as
 * `no-call-either-way` -- so it lands in `quiet` here. Reporting it as a
 * "never" would credit the old engine with a verdict it never gave.
 */
function readerToday(ask: Ask, sides: Sides): Answer {
  let asked = false;
  for (const [start, target] of [[ask.from, ask.to], [ask.to, ask.from]] as const) {
    const absolute = sides.workspace.resolve(start.file);
    const language = languageOf(start.file);
    if (!absolute || !language) continue;
    const source = sides.workspace.read(absolute);
    const verdict = reaches(source, start.name, [target.name], language);
    if (verdict === undefined) continue;
    asked = true;
    if (verdict) return { said: "reached" };
  }
  // The declaration search (#144), which only ran when one end held no code.
  for (const [start, target] of [[ask.from, ask.to], [ask.to, ask.from]] as const) {
    const absolute = sides.workspace.resolve(start.file);
    const language = languageOf(start.file);
    if (!absolute || !language) continue;
    const source = sides.workspace.read(absolute);
    if (declarationsOf(source, start.name, language).some((one) => one.kind === "callable")) continue;
    if (declarationMentions(source, start.name, [target.name], language)) return { said: "reached" };
  }
  return { said: "quiet", why: asked ? "no-call-either-way" : "unreadable" };
}

/** The **after** column's first channel: the live engine's own body search. */
function liveSymbolEdge(ask: Ask, sides: Sides): Answer {
  const end = (at: { file: string; name: string }) => ({
    file: sides.workspace.resolve(at.file)!,
    path: at.file,
    symbols: [at.name],
  });
  const edge = checkSymbolEdge(end(ask.from), end(ask.to), sides.workspace);
  if (edge.verdict === "reached") return { said: "reached" };
  return { said: "quiet", why: edge.verdict === "unreached" ? "no-call-either-way" : "unreadable" };
}

/** What `@calls` says about the same pair, for the column beside it. */
function readerCalls(ask: Ask, sides: Sides): string {
  const tail = sides.side(ask.from.file);
  const head = sides.side(ask.to.file);
  if (!tail || !head) return "unreadable";
  const verdict = callsBetween(
    { ...tail, routine: ask.from.name },
    { ...head, names: [ask.to.name] },
  );
  return verdict.verdict === "withheld" ? `withheld:${verdict.why}` : verdict.verdict;
}

/**
 * What the engine says with the new reader in it -- which is the old channel
 * plus the new one, not the new one alone.
 *
 * The engine's own body search stays first -- guards and all, which is the
 * point: those guards are part of what #reach changed, and a column that
 * skipped them would credit the walk with work it does not do and hide what
 * the guards cost. Measuring the walk alone would also report a regression
 * wherever that channel already answered.
 */
function readerReach(ask: Ask, sides: Sides, cache: ReachCache): { answer: Answer; verdict: ReachVerdict } {
  const already = liveSymbolEdge(ask, sides);
  if (already.said === "reached") {
    return { answer: already, verdict: { verdict: "reached", via: [ask.from.name, ask.to.name], hops: [] } };
  }
  const tail = sides.side(ask.from.file);
  const head = sides.side(ask.to.file);
  if (!tail || !head) return { answer: { said: "quiet", why: "unreadable" }, verdict: { verdict: "withheld", why: "unreadable" } };
  const verdict = reachBetween(
    { ...tail, routine: ask.from.name },
    { ...head, names: [ask.to.name] },
    { cache },
  );
  if (verdict.verdict === "reached") return { answer: { said: "reached" }, verdict };
  if (verdict.verdict === "never") return { answer: { said: "never" }, verdict };
  /*
   * The doubt, not just the word. `open-body` is 276 of one corpus's 324
   * refusals on the never side, and "a call somewhere on the closure could
   * not be placed" is not something anybody can aim a fix at. Which kind of
   * call it was is.
   */
  return {
    answer: {
      said: "quiet",
      why: verdict.detail ? `${verdict.why}:${verdict.detail}` : verdict.why,
      /*
       * Every kind of doubt on the closure, not just the first. A closure
       * closes when all its sites place, so "which reader would settle this
       * refusal" is a question about the whole set: one kind means one reader
       * would do it, two kinds mean two readers both have to.
       */
      ...(verdict.verdict === "withheld" && verdict.doubts ? { doubts: verdict.doubts } : {}),
    },
    verdict,
  };
}

/* ---------------------------------------------------------------- the ledger */

interface Ledger {
  /** Asks put, by truth. */
  asked: Map<Ask["truth"], number>;
  /** Right answers. */
  confirmed: number;
  refuted: number;
  /** Wrong answers, the two that cost. */
  wronglyConfirmed: number;
  wronglyAccused: number;
  /** Silences, by reason, and kept apart by which question was asked: a
   * refusal on a reaching pair costs a confirmation, and a refusal on a
   * never-reaching one costs an accusation nobody was going to be given
   * anyway. One number for both hides which of the two is the problem. */
  quiet: Map<string, number>;
  quietNever: Map<string, number>;
  /**
   * Never-pair refusals grouped by the **whole set** of doubts on the
   * closure, so the report can say what a new reader would buy.
   *
   * The histogram beside this one counts first doubts, which cannot answer
   * that: a closure is conjunctive, and settling the commonest single doubt
   * buys nothing on a closure that also has a different one. A row naming one
   * kind is a refusal one reader would turn into an answer.
   */
  blockedBy: Map<string, number>;
  /**
   * What the reader said about never-pairs the callback guard rejected.
   *
   * Not a score: the referee is not ground truth on these, which is what the
   * guard exists to say. It is a coverage figure. A `never` here is the
   * reader answering on a pair this benchmark cannot certify, and the count
   * of those against the count it can is the whole argument about whether
   * the verdict is licensable from this measurement at all.
   */
  unguardedSaid: Map<string, number>;
  /** Confirmations by referee distance, so depth is visible. */
  byDistance: Map<number, { asked: number; confirmed: number }>;
  /**
   * The sentinel control: the same head, asked about a name nothing declares.
   *
   * A recall figure is agreement with itself unless something could have made
   * it lower, and "0 wrongly confirmed" has two causes that look identical --
   * the reader is careful, or the population could never have caught it out.
   * This is the cheap live version of the guard: a name in the far file that
   * does not exist must never come back reached, whatever else is true.
   * `measure:calls` calls its own copy INVENTED and the bar is the same here.
   *
   * The expensive version is the never-reaching population itself, and on its
   * first run it was not vacuous at all: it caught the body search confirming
   * 51 `anyhow` arrows on a name that meant something else.
   */
  invented: number;
  sentinels: number;
}

const ledger = (): Ledger => ({
  asked: new Map(), confirmed: 0, refuted: 0, wronglyConfirmed: 0, wronglyAccused: 0,
  quiet: new Map(), quietNever: new Map(), blockedBy: new Map(), unguardedSaid: new Map(),
  byDistance: new Map(), invented: 0, sentinels: 0,
});

const bump = <K,>(map: Map<K, number>, key: K, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

function record(into: Ledger, ask: Ask, answer: Answer): void {
  /*
   * A guard-rejected never-ask is counted and never scored. The referee found
   * no static path, and the tail's name is written on the closure -- so a
   * callback could be carrying the call and the referee would not know.
   * Scoring it either way would be inventing ground truth.
   */
  if (ask.named) { bump(into.unguardedSaid, answer.said); return; }
  bump(into.asked, ask.truth);
  if (ask.truth === "reaches") {
    const at = into.byDistance.get(ask.distance) ?? { asked: 0, confirmed: 0 };
    at.asked += 1;
    if (answer.said === "reached") at.confirmed += 1;
    into.byDistance.set(ask.distance, at);
  }
  if (answer.said === "quiet") {
    bump(ask.truth === "reaches" ? into.quiet : into.quietNever, answer.why);
    if (ask.truth === "never" && answer.doubts && answer.doubts.length > 0) {
      bump(into.blockedBy, [...answer.doubts].sort().join("+"));
    }
    return;
  }
  if (ask.truth === "reaches") {
    if (answer.said === "reached") into.confirmed += 1;
    else into.wronglyAccused += 1;
  } else {
    if (answer.said === "never") into.refuted += 1;
    else into.wronglyConfirmed += 1;
  }
}

/* ------------------------------------------------------------------ the run */

interface Row {
  language: Language;
  today: Ledger;
  reach: Ledger;
  /**
   * What `@calls` said, by verdict, on each population.
   *
   * The first column is the one that costs: a `refuted` or a `backwards` on a
   * pair that genuinely reaches is a red on correct code. The second is the
   * word doing its job, and both belong in the same report -- a change that
   * removed the first by killing the second would look like a win in one
   * column and be a loss.
   */
  callsOnReaching: Map<string, number>;
  callsOnNever: Map<string, number>;
  seeds: number;
  complete: number;
  stopped: Map<string, number>;
  routines: number;
  refereeLabels: Set<string>;
  /**
   * Milliseconds the reader itself spent, and on how many asks.
   *
   * The referee's time is not in here and should not be: a language server
   * answering "go to definition" ten thousand times is what makes a run take
   * forty minutes, and none of it is what a board check pays. This is the
   * number a board check pays.
   */
  readerMs: number;
  readerAsks: number;
}

const rows = new Map<Language, Row>();
const rowFor = (language: Language): Row => {
  const found = rows.get(language) ?? {
    language, today: ledger(), reach: ledger(), callsOnReaching: new Map(), callsOnNever: new Map(),
    seeds: 0, complete: 0, stopped: new Map(), routines: 0, refereeLabels: new Set<string>(),
    readerMs: 0, readerAsks: 0,
  };
  rows.set(language, found);
  return found;
};

interface Wrong { tree: string; ask: Ask; reader: "today" | "reach"; said: string; detail?: string }
const wrongs: Wrong[] = [];
const dumped: unknown[] = [];

for (const { tree, language: declared } of trees) {
  const absolute = real(path.resolve(tree));
  const language = declared ?? "ts";
  process.stderr.write(`reading ${tree} (${language}) ...\n`);
  const graph = await refereeGraph(absolute, language);
  const row = rowFor(language);
  row.routines += graph.nodes.size;
  row.refereeLabels.add(graph.label);

  const set = await asksFrom(graph, absolute, language, {
    seeds: SEEDS, budget: BUDGET, depth: DEPTH, perSeed: PER_SEED, perSeedNever: PER_SEED_NEVER,
    unguarded,
  });
  row.seeds += set.seeds;
  row.complete += set.complete;
  for (const [why, count] of set.stopped) bump(row.stopped, why, count);
  graph.close();
  process.stderr.write(`  ${graph.nodes.size} routines, ${set.asks.length} asks `
    + `(${set.complete}/${set.seeds} closures complete)\n`);

  const sides = sidesFor(absolute);
  const cache: ReachCache = newReachCache();
  const SENTINEL = "zzNotARealRoutineName";
  for (const ask of set.asks) {
    if (ask.truth === "reaches") {
      const control: Ask = { ...ask, to: { ...ask.to, name: SENTINEL } };
      for (const [book, said] of [
        [row.today, readerToday(control, sides).said],
        [row.reach, readerReach(control, sides, cache).answer.said],
      ] as const) {
        book.sentinels += 1;
        if (said === "reached") book.invented += 1;
      }
    }
    const today = readerToday(ask, sides);
    record(row.today, ask, today);
    const began = performance.now();
    const { answer: reach, verdict } = readerReach(ask, sides, cache);
    row.readerMs += performance.now() - began;
    row.readerAsks += 1;
    record(row.reach, ask, reach);
    bump(ask.truth === "reaches" ? row.callsOnReaching : row.callsOnNever, readerCalls(ask, sides));
    if (ask.truth === "reaches" && today.said === "never") {
      wrongs.push({ tree, ask, reader: "today", said: "never" });
    }
    if (ask.truth === "never" && today.said === "reached") {
      wrongs.push({ tree, ask, reader: "today", said: "reached" });
    }
    if (ask.truth === "reaches" && reach.said === "never") {
      wrongs.push({ tree, ask, reader: "reach", said: "never",
        detail: verdict.verdict === "never" ? `closure of ${verdict.checked}` : undefined });
    }
    if (ask.truth === "never" && reach.said === "reached") {
      wrongs.push({ tree, ask, reader: "reach", said: "reached",
        detail: verdict.verdict === "reached" ? verdict.via.join(" -> ") : undefined });
    }
    if (dumpTo) {
      dumped.push({
        tree, language, from: ask.from, to: ask.to, truth: ask.truth, distance: ask.distance,
        chain: ask.chain, closure: ask.closure, today: today.said,
        todayWhy: today.said === "quiet" ? today.why : undefined,
        reach: reach.said, reachWhy: reach.said === "quiet" ? reach.why : undefined,
      });
    }
  }
  resetEngineCache();
}

/* ------------------------------------------------------------------- report */

const percent = (part: number, whole: number) =>
  whole === 0 ? "   n/a" : `${((part / whole) * 100).toFixed(1)}%`.padStart(6);
const total = (map: Map<unknown, number>) => [...map.values()].reduce((a, b) => a + b, 0);

const LANGUAGES: Language[] = ["ts", "tsx", "python", "rust", "js"];

console.log();
console.log("MEASURE REACH -- how many steps can the engine follow, and at what cost?");
console.log(`  ${trees.length} trees, seeds=${SEEDS} budget=${BUDGET} depth=${DEPTH} per-seed=${PER_SEED}`);
console.log();

for (const language of LANGUAGES) {
  const row = rows.get(language);
  if (!row) continue;
  console.log(`${language.toUpperCase()}  ${row.routines} routines the referee read, `
    + `referee: ${[...row.refereeLabels].join(", ")}`);
  console.log(`  ${row.seeds} seeds, ${row.complete} with a complete forward closure`
    + (row.stopped.size > 0
      ? `; the rest stopped: ${[...row.stopped].map(([w, c]) => `${w} ${c}`).join(", ")}`
      : ""));
  const reaching = row.today.asked.get("reaches") ?? 0;
  const never = row.today.asked.get("never") ?? 0;
  console.log(`  ${reaching} asks the referee says do reach, ${never} it says never do`);
  console.log(`  the reader spent ${(row.readerMs / 1000).toFixed(1)}s over ${row.readerAsks} asks`
    + ` -- ${(row.readerMs / Math.max(1, row.readerAsks)).toFixed(1)} ms each, warm`);
  console.log();
  console.log("    reader   confirmed  of true   wrongly-confirmed  never   wrongly-accused  answered");
  for (const [name, book] of [["today", row.today], ["reach", row.reach]] as const) {
    console.log(
      `    ${name.padEnd(9)}`
      + `${String(book.confirmed).padStart(9)}`
      + `${percent(book.confirmed, reaching).padStart(10)}`
      + `${String(book.wronglyConfirmed).padStart(20)}`
      + `${String(book.refuted).padStart(8)}`
      + `${String(book.wronglyAccused).padStart(18)}`
      + `${percent(book.confirmed + book.refuted + book.wronglyConfirmed + book.wronglyAccused,
        reaching + never).padStart(10)}`,
    );
  }
  console.log();
  console.log("    control -- the same head asked about a name nothing declares; the bar is zero");
  for (const [name, book] of [["today", row.today], ["reach", row.reach]] as const) {
    console.log(`      ${name.padEnd(7)} confirmed ${book.invented} of ${book.sentinels}`);
  }
  console.log();
  for (const [name, book] of [["today", row.today], ["reach", row.reach]] as const) {
    const distances = [...book.byDistance.keys()].sort((a, b) => a - b);
    if (distances.length === 0) continue;
    console.log(`    ${name} by referee distance: `
      + distances.map((at) => {
        const cell = book.byDistance.get(at)!;
        return `${at} step${at === 1 ? "" : "s"} ${cell.confirmed}/${cell.asked}`;
      }).join("   "));
  }
  console.log();
  for (const [name, book] of [["today", row.today], ["reach", row.reach]] as const) {
    for (const [which, held] of [["on a reaching pair", book.quiet], ["on a never pair", book.quietNever]] as const) {
      if (held.size === 0) continue;
      const reasons = [...held].sort((a, b) => b[1] - a[1]);
      console.log(`    ${name} stayed quiet ${total(held)}x ${which}: `
        + reasons.map(([why, count]) => `${why} ${count}`).join(", "));
    }
  }
  console.log();
  for (const [name, book] of [["today", row.today], ["reach", row.reach]] as const) {
    const total_ = total(book.unguardedSaid);
    if (total_ === 0) continue;
    const answered = (book.unguardedSaid.get("never") ?? 0) + (book.unguardedSaid.get("reached") ?? 0);
    console.log(`    ${name} on the ${total_} never-pairs the callback guard rejects `
      + `(not ground truth, never scored): `
      + [...book.unguardedSaid].sort((a, b) => b[1] - a[1]).map(([said, n]) => `${said} ${n}`).join(", ")
      + ` -- ${answered} answered on evidence this benchmark cannot certify`);
  }
  if (row.reach.unguardedSaid.size > 0) console.log();
  const blocked = row.reach.blockedBy;
  if (blocked.size > 0) {
    const single = [...blocked].filter(([kinds]) => !kinds.includes("+"));
    console.log(`    what a refutation is waiting on, by the whole set of doubts `
      + `(${total(blocked)} refusals, ${single.reduce((sum, [, n]) => sum + n, 0)} of them one kind only):`);
    for (const [kinds, count] of [...blocked].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`      ${String(count).padStart(5)}  ${kinds}`);
    }
    console.log();
  }
  for (const [which, book] of [["reaching", row.callsOnReaching], ["never", row.callsOnNever]] as const) {
    if (book.size === 0) continue;
    console.log(`    @calls on the ${which} pairs: `
      + [...book].sort((a, b) => b[1] - a[1])
        .map(([verdict, count]) => `${verdict} ${count}`).join(", "));
  }
  console.log();
}

if (wrongs.length > 0) {
  console.log(`WRONG ANSWERS (${wrongs.length})`);
  for (const one of wrongs.slice(0, showAll ? wrongs.length : 25)) {
    const { ask } = one;
    console.log(`  [${one.reader}] said ${one.said}: ${ask.from.file}#${ask.from.name}`
      + ` -> ${ask.to.file}#${ask.to.name} (${one.tree})`);
    if (ask.truth === "reaches") console.log(`      referee chain: ${ask.chain.join(" -> ")}`);
    else console.log(`      referee closure: ${ask.closure} routines, complete`);
    if (one.detail) console.log(`      reader: ${one.detail}`);
  }
  if (!showAll && wrongs.length > 25) console.log(`  ... ${wrongs.length - 25} more, --all to see them`);
  console.log();
}

if (dumpTo) {
  writeFileSync(dumpTo, JSON.stringify(dumped, null, 2));
  console.log(`every ask written to ${dumpTo}`);
}
