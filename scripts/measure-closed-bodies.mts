#!/usr/bin/env node
/**
 * Is there a closed region hiding in `@calls`? (#217)
 *
 *   npm run measure:closed-bodies                 -- this repo, orangutan, graphify,
 *                                                    mundane, infrarouter, rust-test
 *   npm run measure:closed-bodies -- <path>...    -- any trees you like
 *   npm run measure:closed-bodies -- --all        -- every disagreement, not the first few
 *
 * **A measurement. No word ships from it and nothing here can colour a diagram.**
 *
 * ## The question, and why it is worth asking
 *
 * #187 closes at 56.1% coverage, 89.2% once two more words ship. That figure
 * counts *relationships that have a word*. It is not the share of wrong arrows
 * that get caught, and #217 argues the gap is large -- the biggest single hole
 * being that `@calls`, `@builds` and `@needs` refute from a **presence**. They
 * say wrong by finding the relationship running the other way. So an arrow drawn
 * between two things that are simply unrelated gets **silence**, and `invokes`
 * is the largest population in the vocabulary: the most likely way somebody
 * draws a wrong arrow is the way nothing notices.
 *
 * The hypothesis this script tests:
 *
 *   A routine's call sites are syntactically enumerable -- `calls.ts` reads
 *   them. What is not enumerable is what each one RESOLVES to. But if EVERY
 *   call in a body resolved, the set of things that body calls is complete, and
 *   "this routine does not call that one" becomes refutable from an absence, on
 *   the same footing a signature is.
 *
 * `measure:calls` already reports the refusal reasons -- unbound, unplaced,
 * dynamic, receiver, macro, ambiguous, computed -- but it reports them **per
 * ask**. A body may refuse one question and answer the next. Nobody has reported
 * them **per body**, and that is the number the hypothesis needs, because a
 * closed region is a property of a body rather than of a question.
 *
 * ## The referee
 *
 * Counting call sites one way and calling that the answer is the mistake
 * `licence.ts` exists to prevent, so the enumeration is checked against
 * `scripts/lib/call-scan.ts` -- the text scan `measure:calls` uses and
 * `licence.ts` cites for every `calls` square in the grid. It bounds a routine
 * by braces, or by indentation in Python, finds calls by the shape of `name(`,
 * and shares no tree-sitter query and no import resolution with the reader.
 *
 * The premise being refereed is the load-bearing one. "Call sites are
 * enumerable" is the whole basis of the closure claim: if the referee sees call
 * sites the reader does not, a body called closed is not closed, and every
 * number below is worthless in the damaging direction.
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { refereeRoutines, stripNoise } from "./lib/call-scan";

import { callSitesIn, type BodyCallSites, type CallSide } from "../src/engine/calls";
import { readDependencies } from "../src/engine/deps";
import { createWorkspace } from "../src/engine/drift";
import { mayAccuse } from "../src/engine/licence";
import { initEngine, languageOf, type Language } from "../src/engine/parse";
import type { ConfigCache } from "../src/engine/resolve";

await initEngine();

const HOME = process.env.HOME ?? "/Users/noelmatero";
const flags = new Set(process.argv.slice(2).filter((one) => one.startsWith("--")));
const roots = process.argv.slice(2).filter((one) => !one.startsWith("--"));
const showAll = flags.has("--all");
const cap = (count: number) => (showAll ? count : Math.min(count, 12));

const real = (tree: string) => { try { return realpathSync(tree); } catch { return tree; } };

/*
 * The same trees `measure:calls` reads, so the two reports describe one corpus
 * and a reason count here can be compared with a refusal count there.
 */
const trees = (roots.length > 0 ? roots : [
  path.resolve("src"),
  path.resolve("scripts"),
  path.resolve("rust-test"),
  `${HOME}/orangutan`,
  `${HOME}/board-ai/graphify`,
  `${HOME}/mundane`,
  `${HOME}/infrarouter`,
]).filter((tree) => existsSync(tree)).map(real);

function sourceFiles(root: string): string[] {
  try {
    return execFileSync("find", [root, "-type", "f"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((file) => !/\/(target|node_modules|\.git|dist|out|vendor|\.venv|\.claude)\//.test(file))
      .filter((file) => languageOf(file) !== undefined);
  } catch {
    return [];
  }
}

const LANGUAGES: Language[] = ["rust", "ts", "tsx", "python", "js"];

/* ------------------------------------------------------------------ the run */

/** Body-size bands, because a one-liner closing is not the finding a big one is. */
const BANDS = [
  { name: "1-5 lines", least: 1, most: 5 },
  { name: "6-15 lines", least: 6, most: 15 },
  { name: "16-50 lines", least: 16, most: 50 },
  { name: "51+ lines", least: 51, most: Number.POSITIVE_INFINITY },
];

const bump = <K,>(map: Map<K, number>, key: K, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

const files = new Map<Language, number>();
const bodies = new Map<Language, number>();
/** Bodies with at least one call site and no unplaced one. */
const closed = new Map<Language, number>();
/** Bodies with no call sites at all. Closed trivially and separately reported. */
const callless = new Map<Language, number>();
const open_ = new Map<Language, number>();
/** Per language, how many bodies each reason was the *only* thing blocking. */
const soleBlocker = new Map<Language, Map<string, number>>();
/** Per language, how many open bodies carried each reason at all. */
const anyBlocker = new Map<Language, Map<string, number>>();
const sites = new Map<Language, number>();
const placedSites = new Map<Language, number>();
/** Per band, bodies with calls and bodies closed. */
const byBand = new Map<string, { withCalls: number; closed: number }>();
/** The same, per language, for the band the report names. */
const unlicensed = new Set<Language>();

/** Referee disagreement about how many call sites a body has. */
interface Disagreement {
  file: string;
  routine: string;
  reader: number;
  referee: number;
  /** Names the referee saw and the reader did not, which is the dangerous half. */
  unseen: string[];
}
const readerSawFewer: Disagreement[] = [];
const readerSawMore: Disagreement[] = [];
let refereed = 0;
let refereeAgreed = 0;
/** Bodies called closed where the referee saw a call site the reader did not. */
const closedButUnrefereed: Disagreement[] = [];
const refusedFiles = new Map<string, number>();

for (const tree of trees) {
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

  for (const file of sourceFiles(tree)) {
    const rel = path.relative(tree, file);
    const source = read(rel);
    if (source === undefined) continue;
    const language = languageOf(rel)!;
    if (!mayAccuse("calls", language)) unlicensed.add(language);

    const reading = callSitesIn({
      file: rel, source, language, imports: imports(rel, source), open,
    });
    if (!reading.read) { bump(refusedFiles, reading.why); continue; }
    bump(files, language);

    /*
     * The referee's reading of the same file, indexed by routine name. A name
     * declared twice in one file is dropped from the comparison rather than
     * guessed at -- the referee cannot tell the two apart either, and pairing
     * them by name would manufacture a disagreement out of the pairing.
     */
    const scanned = refereeRoutines(stripNoise(source, language), language);
    const seenTwice = new Set<string>();
    const byName = new Map<string, (typeof scanned)[number]>();
    for (const one of scanned) {
      if (byName.has(one.name)) seenTwice.add(one.name);
      byName.set(one.name, one);
    }
    /*
     * A name either reading finds twice in one file is dropped from the
     * comparison. Both directions matter and only one was obvious: pairing two
     * reader bodies against one referee body blamed the reader for a
     * disagreement the pairing invented.
     */
    for (const one of reading.bodies) {
      if (reading.bodies.filter((two) => two.routine === one.routine).length > 1) {
        seenTwice.add(one.routine);
      }
    }

    for (const body of reading.bodies) {
      bump(bodies, language);
      bump(sites, language, body.sites.length);
      bump(placedSites, language, body.sites.filter((one) => one.file).length);

      const blocking = body.sites.filter((one) => one.why);
      const isClosed = body.sites.length > 0 && blocking.length === 0;
      if (body.sites.length === 0) bump(callless, language);
      else if (isClosed) bump(closed, language);
      else bump(open_, language);

      if (blocking.length > 0) {
        const reasons = new Set(blocking.map((one) => one.why!));
        const perAny = anyBlocker.get(language) ?? new Map<string, number>();
        for (const reason of reasons) bump(perAny, reason);
        anyBlocker.set(language, perAny);
        /*
         * The reason worth naming is the one that is on its own -- remove it
         * and the body closes. A body blocked by three different things is not
         * a target for a fix, and counting it under all three would make every
         * column look like the bottleneck.
         */
        if (reasons.size === 1) {
          const per = soleBlocker.get(language) ?? new Map<string, number>();
          bump(per, [...reasons][0]!);
          soleBlocker.set(language, per);
        }
      }

      if (body.sites.length > 0) {
        const band = BANDS.find((one) => body.lines >= one.least && body.lines <= one.most)!;
        const cell = byBand.get(band.name) ?? { withCalls: 0, closed: 0 };
        cell.withCalls += 1;
        if (isClosed) cell.closed += 1;
        byBand.set(band.name, cell);
      }

      /* ------------------------------------------------------ the referee */
      const twin = seenTwice.has(body.routine) ? undefined : byName.get(body.routine);
      if (!twin) continue;
      /*
       * The referee's constructions are dropped here rather than in the scan.
       * `new Foo(..)` is not a call node in any of these grammars and the
       * referee's own `NOT_CALLS` says counting one would blame the reader for a
       * distinction the language makes -- but that list can only skip the word
       * `new`, not the name after it. `measure:calls` never noticed because its
       * population is names the tree declares exactly once, which drops `new
       * Set(..)` on its own. Comparing raw counts has no such filter.
       */
      const refereeCalls = twin.calls.filter((one) => !one.construction);
      refereed += 1;
      if (refereeCalls.length === body.sites.length) { refereeAgreed += 1; continue; }

      /*
       * Compared by name and multiplicity rather than by count alone: two
       * readings that differ by one in each direction agree on a total and
       * disagree about the body, and the direction is the whole finding.
       */
      const readerNames = countNames(body.sites.map((one) => one.name).filter(Boolean));
      const refereeNames = countNames(refereeCalls.map((one) => one.name));
      const unseen: string[] = [];
      for (const [name, count] of refereeNames) {
        const mine = readerNames.get(name) ?? 0;
        if (count > mine) unseen.push(`${name}${count - mine > 1 ? ` x${count - mine}` : ""}`);
      }
      const one = {
        file: `${path.basename(tree)}/${rel}`,
        routine: body.routine,
        reader: body.sites.length,
        referee: refereeCalls.length,
        unseen,
      };
      if (refereeCalls.length > body.sites.length) {
        readerSawFewer.push(one);
        if (isClosed && unseen.length > 0) closedButUnrefereed.push(one);
      } else {
        readerSawMore.push(one);
      }
    }
  }
}

function countNames(names: string[]): Map<string, number> {
  const found = new Map<string, number>();
  for (const name of names) found.set(name, (found.get(name) ?? 0) + 1);
  return found;
}

/* ------------------------------------------------------------------- report */

const percent = (part: number, whole: number) =>
  whole === 0 ? "   n/a" : `${((part / whole) * 100).toFixed(1)}%`.padStart(6);
const total = (map: Map<Language, number>) => [...map.values()].reduce((a, b) => a + b, 0);
const totalOf = (map: Map<Language, Map<string, number>>, reason: string) =>
  [...map.values()].reduce((sum, per) => sum + (per.get(reason) ?? 0), 0);

console.log();
console.log("MEASURE CLOSED BODIES -- is there a closed region hiding in `@calls`? (#217)");
console.log(`  ${trees.length} trees, ${total(files)} files, ${total(bodies)} routine bodies read`);
console.log("  A body is closed when it has at least one call site and the reader placed");
console.log("  every one of them. Only then is its call set complete, and only then could");
console.log("  \"this routine does not call that one\" refute from an absence.");
console.log("  Receiver calls (`x.foo()`) count as unplaced, because they are: the reader");
console.log("  cannot say whose `foo` that is.");
console.log();

console.log("1 · THE CLOSED SHARE -- bodies whose every call site resolved");
console.log();
console.log("  " + "language".padEnd(10) + "bodies".padStart(8) + "with calls".padStart(12)
  + "closed".padStart(8) + "  of those" + "callless".padStart(10) + "open".padStart(8));
for (const language of LANGUAGES) {
  const all = bodies.get(language) ?? 0;
  if (all === 0) continue;
  const none = callless.get(language) ?? 0;
  const shut = closed.get(language) ?? 0;
  console.log("  " + language.padEnd(10)
    + String(all).padStart(8)
    + String(all - none).padStart(12)
    + String(shut).padStart(8)
    + "  " + percent(shut, all - none).padStart(8)
    + String(none).padStart(10)
    + String(open_.get(language) ?? 0).padStart(8));
}
const withCalls = total(bodies) - total(callless);
console.log("  " + "all".padEnd(10)
  + String(total(bodies)).padStart(8)
  + String(withCalls).padStart(12)
  + String(total(closed)).padStart(8)
  + "  " + percent(total(closed), withCalls).padStart(8)
  + String(total(callless)).padStart(10)
  + String(total(open_)).padStart(8));
console.log();
console.log("  `callless` is reported apart and excluded from the share, the way");
console.log("  `measure:dataflow` splits out values nothing is ever done with. A body that");
console.log("  closes because it calls nothing proves nothing: there is no call set to be");
console.log("  complete about, so no arrow could be refuted by its being complete.");
console.log();
console.log(`  Call sites: ${total(placedSites)} of ${total(sites)} placed `
  + `(${percent(total(placedSites), total(sites)).trim()}). The per-site figure is much`);
console.log("  friendlier than the per-body one, and that gap is the finding: closure is");
console.log("  conjunctive, so one unplaced call in a body of twenty opens the body.");
console.log();

console.log("2 · WHAT BLOCKS A BODY -- and which reason a fix would have to target");
console.log();
console.log("  " + "reason".padEnd(12) + "sole blocker".padStart(14) + "  of open"
  + "present at all".padStart(16));
const reasonNames = [...new Set([
  ...[...anyBlocker.values()].flatMap((per) => [...per.keys()]),
])].sort((a, b) => totalOf(soleBlocker, b) - totalOf(soleBlocker, a));
for (const reason of reasonNames) {
  console.log("  " + reason.padEnd(12)
    + String(totalOf(soleBlocker, reason)).padStart(14)
    + "  " + percent(totalOf(soleBlocker, reason), total(open_)).padStart(8)
    + String(totalOf(anyBlocker, reason)).padStart(16));
}
console.log();
console.log("  `sole blocker` is the count of open bodies where this was the *only* reason");
console.log("  present -- remove it and the body closes. That is the number a fix would move.");
console.log("  `present at all` double-counts a body blocked by several things, so it sums to");
console.log("  more than the open count and is the wrong column to quote.");
console.log();

console.log("3 · HOW IT MOVES WITH BODY SIZE");
console.log();
console.log("  " + "lines".padEnd(14) + "with calls".padStart(12) + "closed".padStart(8) + "  share");
for (const band of BANDS) {
  const cell = byBand.get(band.name);
  if (!cell || cell.withCalls === 0) continue;
  console.log("  " + band.name.padEnd(14)
    + String(cell.withCalls).padStart(12)
    + String(cell.closed).padStart(8)
    + "  " + percent(cell.closed, cell.withCalls).padStart(8));
}
console.log();
console.log("  A one-line function closing is not the same finding as a fifty-line one");
console.log("  closing. If the share collapses as bodies grow, the closed region is real and");
console.log("  empty -- it exists only where there was nothing much to be wrong about.");
console.log();

console.log("4 · THE REFEREE -- did the reader see every call site there is?");
console.log(`  Bodies both readings found: ${refereed}, agreed on the site count: `
  + `${refereeAgreed} (${percent(refereeAgreed, refereed).trim()})`);
console.log("  The referee is `scripts/lib/call-scan.ts`: a text scan that bounds a routine");
console.log("  by braces, or by indentation in Python, and finds calls by the shape of");
console.log("  `name(`. It shares no tree-sitter query and no import resolution with the");
console.log("  reader, so agreeing means two unrelated readings agree.");
console.log();
console.log(`  READER SAW FEWER -- the dangerous direction: ${readerSawFewer.length}`);
console.log("    A call site the reader never enumerated cannot be unplaced, so a body can");
console.log("    be called closed while something in it was never looked at. This is the");
console.log("    number that decides whether section 1 means anything.");
for (const one of readerSawFewer.slice(0, cap(readerSawFewer.length))) {
  console.log(`    ${one.file} ${one.routine} -- reader ${one.reader}, referee ${one.referee}`
    + (one.unseen.length > 0 ? ` (${one.unseen.slice(0, 6).join(", ")})` : ""));
}
if (readerSawFewer.length > cap(readerSawFewer.length)) {
  console.log(`    ... and ${readerSawFewer.length - cap(readerSawFewer.length)} more`);
}
console.log();
console.log(`  CLOSED AND UNREFEREED -- called closed, referee saw a call it missed: ${closedButUnrefereed.length}`);
console.log("    The bar is what matters here. Each one is a body section 1 counts as having");
console.log("    a complete call set, where a second reading found something in it the first");
console.log("    never enumerated -- so it is a body whose closure rests on not having looked.");
for (const one of closedButUnrefereed) {
  console.log(`    ${one.file} ${one.routine} -- reader ${one.reader}, referee ${one.referee}`
    + ` (${one.unseen.slice(0, 6).join(", ")})`);
}
console.log(`    Against ${total(closed)} closed bodies, so the closed share is overstated by`);
console.log(`    at most ${percent(closedButUnrefereed.length, total(closed)).trim()} on this axis.`);
console.log();
console.log(`  READER SAW MORE: ${readerSawMore.length}`);
console.log("    The safe direction, and mostly the referee's own blind spot -- it cannot see");
console.log("    a call split across lines, and it credits a nested closure to the routine");
console.log("    around it by design. Named for completeness rather than as a fault.");
for (const one of readerSawMore.slice(0, cap(Math.min(readerSawMore.length, 6)))) {
  console.log(`    ${one.file} ${one.routine} -- reader ${one.reader}, referee ${one.referee}`);
}
if (readerSawMore.length > 6 && !showAll) {
  console.log(`    ... and ${readerSawMore.length - 6} more`);
}
console.log();

const unseenTally = new Map<string, number>();
for (const one of readerSawFewer) {
  for (const name of one.unseen) unseenTally.set(name.split(" x")[0]!, (unseenTally.get(name.split(" x")[0]!) ?? 0) + 1);
}
console.log("  WHAT THE READER WAS SAID TO HAVE MISSED, by name");
console.log("    Named because the shape of the residual is the finding, not its size. A");
console.log("    token that is a keyword in the language is the referee counting `name(`");
console.log("    where the language has no call -- its `NOT_CALLS` list cannot cover the");
console.log("    name after `new`, and it does not list `async` or `of` at all.");
for (const [name, count] of [...unseenTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`    ${name.padEnd(18)} ${count}`);
}
console.log();

if (refusedFiles.size > 0) {
  console.log("  FILES THE READER WOULD NOT OPEN");
  for (const [why, count] of [...refusedFiles.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${why.padEnd(14)} ${count}`);
  }
  console.log();
}
if (unlicensed.size > 0) {
  console.log(`  Languages with no measured \`calls\` licence: ${[...unlicensed].join(", ")}.`);
  console.log("  Counted anyway -- this is not a verdict and licences gate accusations, not");
  console.log("  arithmetic. It matters for what could be built on the number, not for it.");
  console.log();
}

console.log("5 · FLOOR OR CEILING, and which");
console.log();
console.log("  The closed share in section 1 is a CEILING. Three things inflate it and one");
console.log("  deflates it, and the three are reader limits while the one is a definition:");
console.log();
console.log("    inflates -- a call site the reader never enumerated cannot be unplaced,");
console.log("                so anything in section 4's first column is a body counted");
console.log("                closed on an incomplete reading");
console.log("    inflates -- a specifier that resolves to a file counts as placed even");
console.log("                where the opener could not be consulted, so a barrel with an");
console.log("                unreadable far end is optimistic");
console.log("    inflates -- a call written inside a macro is invisible in three of the");
console.log("                grammars; it is counted as a doubt where a `token_tree`");
console.log("                appears, and a macro that expands to a call leaves no node");
console.log("    deflates -- a receiver call is counted unplaced even where a person could");
console.log("                say what it reaches. That is deliberate and it is the honest");
console.log("                reading: the *text* does not say, which is the standard every");
console.log("                other refusal here is held to");
console.log();
console.log("  So the true closed share is at most what section 1 prints, and the deflating");
console.log("  half is not a limitation to be fixed -- it is the question. If receiver calls");
console.log("  dominate section 2, then closing this region means resolving dynamic");
console.log("  dispatch, which is a type system rather than a word.");
console.log();

const shut = total(closed);
const bigBand = byBand.get("51+ lines");
const smallBand = byBand.get("1-5 lines");
const receiverSole = totalOf(soleBlocker, "receiver");

console.log("6 · WHAT THIS ANSWERS");
console.log();
console.log(`  ${shut} of ${withCalls} bodies that call anything have a call set this reader can`);
console.log(`  enumerate completely: ${percent(shut, withCalls).trim()}. That is the ceiling on how much of`);
console.log("  `@calls` could ever refute from an absence, and it is small.");
console.log();
if (smallBand && bigBand) {
  console.log(`  It is also concentrated in the wrong place. ${percent(smallBand.closed, smallBand.withCalls).trim()} of bodies of five lines`);
  console.log(`  or fewer close; ${percent(bigBand.closed, bigBand.withCalls).trim()} of bodies over fifty do -- ${bigBand.closed} of ${bigBand.withCalls}. A refutation`);
  console.log("  available only on short functions is not worth a word: the arrow somebody");
  console.log("  draws between two large routines is exactly the one it would stay silent on.");
}
console.log();
console.log(`  The reason is one reason. \`receiver\` is the sole blocker in ${receiverSole} open bodies,`);
console.log(`  ${percent(receiverSole, total(open_)).trim()} of them, more than every other reason together. \`x.foo()\` is how`);
console.log("  ordinary code is written, and placing it means knowing the type of `x`. That is");
console.log("  a type system, not a claim word -- and it is the same wall #203 names.");
console.log();
console.log("  So the closed region is real and nearly empty. Two unrelated things joined by");
console.log("  a `@calls` arrow stays silent, and this measurement says that cannot be fixed");
console.log("  by enumerating call sites, because the sets do not close where it matters.");
console.log();
console.log("  Anything built on this would also need the licence grid (#209): it would be an");
console.log("  accusation from an absence, in a language, and no language here has been");
console.log("  measured for that. The numbers above are not a licence and do not stand in for");
console.log("  one -- they say the licence would not be worth earning.");
console.log();
