#!/usr/bin/env node
/**
 * Is there a closed region hiding in `@accesses`'s routine end? (#255)
 *
 *   npm run measure:accesses-closed                 -- this repo, rust-test, orangutan,
 *                                                      graphify, mundane, infrarouter
 *   npm run measure:accesses-closed -- <path>...    -- any trees you like
 *   npm run measure:accesses-closed -- --all        -- every disagreement, not the first few
 *   npm run measure:accesses-closed -- --no-tier2   -- syntax only, no type checkers
 *
 * **A measurement. No word ships from it and nothing here can colour a
 * diagram.**
 *
 * ## The question
 *
 * `@accesses` says a routine reads a member off a type. It refutes at the
 * **type** end -- the type has no such field, so the arrow is wrong -- and it
 * is silent at the **routine** end: it cannot say *"this routine does not read
 * that field."* Draw the arrow from a routine that never touches the field and
 * the answer is silence.
 *
 * Making that end accuse means refuting from an **absence**, which is the
 * dangerous kind. "This routine does not read that field" is only true if
 * every read in the body was seen -- one receiver that could not be placed and
 * the absence is the reader's blindness rather than the code's silence. So the
 * hypothesis is the one `@calls`' closed-body absence already stands on (#233):
 *
 *   A body's member reads are syntactically enumerable -- `resolution.ts`
 *   reads them. What is not enumerable is what each one is read OFF. But if
 *   EVERY read in a body resolved, the set of members that body reads is
 *   complete, and "this routine does not read that member" becomes refutable.
 *
 * ## Two regions, because a helper is a real objection
 *
 * If `draw()` calls `paint()` and *paint* reads `width`, does `draw` read
 * `width`? On a diagram, most people would say yes. So refuting on direct
 * reads alone risks a red on an arrow that is morally right, and requiring
 * every call to be followed as well shrinks the region. Both are measured
 * rather than argued:
 *
 *     REGION A   every member read in the body resolved
 *     REGION B   region A, and every call in the body was placed as well
 *
 * and the price of choosing A is measured directly: among region-A bodies,
 * how many reach a member through a call they make that they do not read
 * themselves. That is a floor rather than a ceiling -- it follows one hop, and
 * a helper's helper is not counted.
 *
 * ## The referee
 *
 * The premise being refereed is the load-bearing one. "A body's reads are
 * enumerable" is the whole basis of the closure claim: if the referee sees a
 * read the reader does not, a body called closed is not closed, and every
 * number below is worthless in the damaging direction.
 *
 * `scripts/lib/access-scan.ts` -- the text scan `measure:accesses` uses and
 * `licence.ts` cites for every `accesses` square in the grid. It shares no
 * tree-sitter query with the reader. It has itself been wrong seven ways
 * (#222), which is why the column that matters below is the one where the
 * referee saw a read inside a body this reader had called closed.
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { distinctReads, refereeRoutines } from "./lib/access-scan";
import { resolvePythonReceivers } from "./lib/resolution-python-live";
import { resolveRustReceivers } from "./lib/resolution-rust-receivers";
import { createTsReferee, receiverResolutionFrom } from "./lib/resolution-ts";
import { sourceFiles } from "./lib/source-files";
import type { ReceiverResolution } from "../src/engine/calls";
import { initEngine, languageOf, type Language } from "../src/engine/parse";
import { memberReadsIn, type MemberReadSite, type ReadHazard } from "../src/engine/resolution";

await initEngine();

const HOME = process.env.HOME ?? "/Users/noelmatero";
const flags = new Set(process.argv.slice(2).filter((one) => one.startsWith("--")));
const roots = process.argv.slice(2).filter((one) => !one.startsWith("--"));
const showAll = flags.has("--all");
const noTier2 = flags.has("--no-tier2");

const trees = (roots.length > 0 ? roots : [
  path.resolve("src"),
  path.resolve("scripts"),
  path.resolve("rust-test"),
  `${HOME}/orangutan`,
  `${HOME}/board-ai/graphify/graphify`,
  `${HOME}/mundane`,
  `${HOME}/infrarouter`,
]).filter((tree) => existsSync(tree));

const LANGUAGES: Language[] = ["rust", "ts", "tsx", "python", "js"];
const LSP_LANGUAGES: Language[] = ["python", "rust"];

/** Which tier a column is about, so the two are never folded into one. */
type Tier = "tier1" | "tier2";

interface Tally {
  /** Every routine the reader read, whatever it contained. */
  routines: number;
  /** Routines with no member read at all. Closed for free, so held apart. */
  readless: number;
  /** Routines with at least one member read: the population that matters. */
  withReads: number;
  reads: number;
  resolved: number;
  /** Every read in the body resolved. Not yet a closed region -- see below. */
  placedAll: number;
  /** ...and nothing in it reads a member without naming one: REGION A. */
  closed: number;
  /** ...and no computed access either: REGION A, strict. */
  closedStrict: number;
  /** Bodies knocked out by each hazard, counted once per body. */
  hazard: Map<string, number>;
  /** Reasons a body stayed open, counted per body rather than per read. */
  anyBlocker: Map<string, number>;
  soleBlocker: Map<string, number>;
}

const tallies = new Map<Tier, Map<Language, Tally>>([["tier1", new Map()], ["tier2", new Map()]]);
function tally(tier: Tier, language: Language): Tally {
  const per = tallies.get(tier)!;
  let found = per.get(language);
  if (!found) {
    found = {
      routines: 0, readless: 0, withReads: 0, reads: 0, resolved: 0,
      placedAll: 0, closed: 0, closedStrict: 0, hazard: new Map(),
      anyBlocker: new Map(), soleBlocker: new Map(),
    };
    per.set(language, found);
  }
  return found;
}

const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

/** Whether one read counts as placed, at this tier. */
function placed(site: MemberReadSite, tier: Tier): boolean {
  if (site.verdict.verdict === "resolved") return true;
  return tier === "tier2" && site.placed !== undefined;
}

/** Why a read is not placed, at this tier. The reader's own word for it. */
function blockedBy(site: MemberReadSite): string {
  return site.verdict.verdict === "withheld" ? site.verdict.why : "resolved";
}

interface RoutineReading {
  routine: string;
  line: number;
  endLine: number;
  sites: MemberReadSite[];
  hazards: ReadHazard[];
}

/** Whether a body reads members without naming them, and which way. */
function hazardKinds(routine: RoutineReading): Set<string> {
  return new Set(routine.hazards.map((one) => one.kind));
}

function count(tier: Tier, language: Language, routines: RoutineReading[]): void {
  const into = tally(tier, language);
  for (const routine of routines) {
    into.routines += 1;
    if (routine.sites.length === 0) { into.readless += 1; continue; }
    into.withReads += 1;
    into.reads += routine.sites.length;

    const open = new Set<string>();
    for (const site of routine.sites) {
      if (placed(site, tier)) { into.resolved += 1; continue; }
      open.add(blockedBy(site));
    }
    if (open.size > 0) {
      for (const why of open) bump(into.anyBlocker, why);
      if (open.size === 1) bump(into.soleBlocker, [...open][0]!);
      continue;
    }

    /*
     * Every read placed. That is NOT yet a closed region: a body can read a
     * member with no `.name` written for it anywhere, and the referee is
     * blind to those in exactly the way this reader is, so no disagreement
     * would ever surface one. Subtracted here rather than reported alongside,
     * because a region that includes them is a licence to accuse on a body
     * nobody has fully read.
     */
    into.placedAll += 1;
    const hazards = hazardKinds(routine);
    for (const kind of hazards) bump(into.hazard, kind);
    if (hazards.has("destructured") || hazards.has("spread")) continue;
    into.closed += 1;
    if (!hazards.has("computed")) into.closedStrict += 1;
  }
}

/* ------------------------------------------------------- the referee's check */

/**
 * Bodies this reader called closed where the referee saw a read it did not.
 *
 * The only column that can invalidate the region, so it is counted separately
 * from every other disagreement: a body wrongly called closed is a body a
 * refutation would be licensed from on evidence the reader does not have.
 */
/**
 * Members the referee saw in a file that this reader saw nowhere in it.
 *
 * **Checked per file, not per body, and that is the referee's limit rather
 * than a choice.** `access-scan.ts` reports a read's *line*, and
 * `list.some((x) => x.width)` puts `.some` and the callback's opening on the
 * same line -- so a read belonging to the enclosing scope falls inside the
 * callback's span and reads as one this reader missed. Pairing by line
 * produced 77 of those and every one I opened was that. Byte offsets would
 * fix it and the referee does not have them.
 *
 * Per file the attribution errors cancel: a member the referee saw and this
 * reader saw nowhere at all is a genuine blind spot, whichever body it sits
 * in. That is the premise this region rests on -- "a body's reads are
 * enumerable" -- and it is the claim worth refereeing.
 */
const unseen: Array<{ file: string; member: string; line: number }> = [];
const refereeAsked = new Map<Language, number>();
const refereeAgreed = new Map<Language, number>();

function referee(
  file: string, source: string, language: Language, routines: RoutineReading[],
): void {
  const seen = refereeRoutines(source, language);
  if (seen.length === 0) return;

  const mine = new Set(routines.flatMap((one) => one.sites.map((site) => site.member)));
  const theirs = new Map<string, number>();
  for (const routine of seen) {
    for (const read of distinctReads(routine)) {
      if (!theirs.has(read.name)) theirs.set(read.name, read.line);
    }
  }
  if (theirs.size === 0) return;

  refereeAsked.set(language, (refereeAsked.get(language) ?? 0) + theirs.size);
  for (const [member, line] of theirs) {
    if (mine.has(member)) {
      refereeAgreed.set(language, (refereeAgreed.get(language) ?? 0) + 1);
      continue;
    }
    unseen.push({ file, member, line });
  }
}

/* ------------------------------------------------------------------- the run */

const resolverAnswers = new Map<Language, { answered: number; none: number }>();

for (const tree of trees) {
  const files = sourceFiles(tree);
  const label = path.basename(tree);
  console.error(`  [${label}] ${files.length} files`);

  /* ---------------------------------------------------------- tier 1, and ts */
  const tsReferee = noTier2 ? undefined : (() => {
    try { return createTsReferee(tree); } catch { return undefined; }
  })();

  for (const file of files) {
    const language = languageOf(file);
    if (!language) continue;
    let source: string;
    try { source = readFileSync(file, "utf8"); } catch { continue; }

    const tier1 = memberReadsIn(source, language);
    if (!tier1.read) continue;
    count("tier1", language, tier1.routines);

    if (noTier2) continue;
    if (language === "ts" || language === "tsx" || language === "js") {
      if (!tsReferee) { count("tier2", language, tier1.routines); continue; }
      const answer = (at: { start: number; end: number }): ReceiverResolution | undefined => {
        const tally = resolverAnswers.get(language) ?? { answered: 0, none: 0 };
        resolverAnswers.set(language, tally);
        const found = receiverResolutionFrom(tsReferee.typeAt(file, at.start, at.end), tree);
        if (found) tally.answered += 1; else tally.none += 1;
        return found;
      };
      const tier2 = memberReadsIn(source, language, answer);
      if (!tier2.read) continue;
      count("tier2", language, tier2.routines);
      referee(path.relative(tree, file), source, language, tier2.routines);
    }
  }

  /* ------------------------------------------- tier 2 over a language server
   *
   * Python's and Rust's resolvers answer over LSP and `memberReadsIn` is
   * synchronous, so the reading above cannot ask them mid-walk. The shape
   * `resolution-python-live.ts` already solved for the live checker is reused
   * rather than reinvented: read once with a resolver that records every
   * question and answers none, resolve the whole batch, then read again with a
   * synchronous lookup into what came back.
   */
  if (noTier2) continue;
  for (const language of LSP_LANGUAGES) {
    const inLanguage = files.filter((one) => languageOf(one) === language);
    if (inLanguage.length === 0) continue;

    const read = (file: string) => {
      try { return readFileSync(file, "utf8"); } catch { return undefined; }
    };
    const queries: Array<{ file: string; at: { start: number; end: number } }> = [];
    for (const file of inLanguage) {
      const source = read(file);
      if (source === undefined) continue;
      memberReadsIn(source, language, (at) => {
        queries.push({ file: path.relative(tree, file), at });
        return undefined;
      });
    }
    if (queries.length === 0) continue;

    console.error(`  [${label}/${language}] ${queries.length} read receivers to resolve`);
    const startedAt = Date.now();
    const answers = language === "python"
      ? await resolvePythonReceivers(tree, queries)
      : await resolveRustReceivers(tree, queries, new Set(["target", "node_modules", ".git", "dist", "out", "vendor", ".venv", ".claude"]));
    console.error(`  [${label}/${language}] done in ${Math.round((Date.now() - startedAt) / 1000)}s`);

    const tally = resolverAnswers.get(language) ?? { answered: 0, none: 0 };
    resolverAnswers.set(language, tally);
    for (const query of queries) {
      if (answers.cache.get(query.file, query.at)) tally.answered += 1; else tally.none += 1;
    }

    for (const file of inLanguage) {
      const source = read(file);
      if (source === undefined) continue;
      const rel = path.relative(tree, file);
      const tier2 = memberReadsIn(source, language, (at) => answers.cache.get(rel, at));
      if (!tier2.read) continue;
      count("tier2", language, tier2.routines);
      referee(rel, source, language, tier2.routines);
    }
  }
}

/* ---------------------------------------------------------------- the report */

const percent = (part: number, whole: number) =>
  whole === 0 ? "  n/a" : `${((part / whole) * 100).toFixed(1)}%`;
const cap = (count: number, few: number) => (showAll ? count : Math.min(count, few));

console.log("\nMEASURE ACCESSES-CLOSED -- is there a region the routine end could accuse from? (#255)");
console.log(`  ${trees.length} trees\n`);

for (const tier of ["tier1", "tier2"] as Tier[]) {
  const per = tallies.get(tier)!;
  if ([...per.values()].every((one) => one.withReads === 0)) continue;
  console.log(tier === "tier1"
    ? "A · FROM THE TEXT ALONE -- no type checker asked"
    : "B · WITH THE REAL TYPE CHECKER -- tsc, pyright, rust-analyzer");
  console.log("  language  routines  no reads  with reads    reads  reads placed  all placed  REGION A  share  strict");
  for (const language of LANGUAGES) {
    const one = per.get(language);
    if (!one || one.routines === 0) continue;
    console.log(
      " ", language.padEnd(8),
      String(one.routines).padStart(8), String(one.readless).padStart(9),
      String(one.withReads).padStart(11), String(one.reads).padStart(8),
      percent(one.resolved, one.reads).padStart(13),
      String(one.placedAll).padStart(11),
      String(one.closed).padStart(9), percent(one.closed, one.withReads).padStart(7),
      percent(one.closedStrict, one.withReads).padStart(7),
    );
  }
  console.log();
}

console.log("  READS WITH NO `.name` -- bodies where every read placed, knocked out anyway");
console.log("  because something in them reads a member without naming one. The referee");
console.log("  cannot find these: it is blind to them in the same way the reader is.");
for (const language of LANGUAGES) {
  const one = tallies.get("tier2")!.get(language);
  if (!one || one.hazard.size === 0) continue;
  const kinds = [...one.hazard.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`   ${language.padEnd(7)}`, kinds.map(([kind, count]) => `${kind} ${count}`).join(", "));
}

console.log();
console.log("  WHAT KEPT A BODY OPEN -- counted per body, and `sole` is the one that would");
console.log("  close it on its own. Per language, tier 2.");
for (const language of LANGUAGES) {
  const one = tallies.get("tier2")!.get(language);
  if (!one || one.soleBlocker.size === 0) continue;
  const sole = [...one.soleBlocker.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap(99, 6));
  console.log(`   ${language.padEnd(7)} sole:`, sole.map(([why, count]) => `${why} ${count}`).join(", "));
}

console.log("\n  THE CHECKER'S REACH -- questions it answered, so a low share is read as reach");
console.log("  rather than as the checker failing.");
for (const language of LANGUAGES) {
  const one = resolverAnswers.get(language);
  if (!one) continue;
  const asked = one.answered + one.none;
  console.log(`   ${language.padEnd(7)} ${asked} asked, ${one.answered} answered (${percent(one.answered, asked)})`);
}

console.log("\n  THE REFEREE ON THE PREMISE -- the region rests on a body's reads being");
console.log("  enumerable. Per file, because the referee reports a line and a callback");
console.log("  shares its line with the call it is passed to; per body the attribution is");
console.log("  not sound and every disagreement it produced was that.");
for (const language of LANGUAGES) {
  const asked = refereeAsked.get(language);
  if (!asked) continue;
  console.log(`   ${language.padEnd(7)} ${asked} members the referee read, ${refereeAgreed.get(language) ?? 0} this reader also read (${percent(refereeAgreed.get(language) ?? 0, asked)})`);
}
console.log(`\n  UNSEEN -- a member the referee read that this reader read nowhere: ${unseen.length}`);
console.log("    Each one is a way a body can be called closed while a read in it was");
console.log("    never seen, which is what a routine-end refutation would rest on.");
for (const one of unseen.slice(0, cap(unseen.length, 15))) {
  console.log(`    ${one.file}:${one.line} ${one.member}`);
}
if (unseen.length > cap(unseen.length, 15)) {
  console.log(`    ... and ${unseen.length - 15} more (--all prints every one)`);
}
