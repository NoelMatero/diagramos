#!/usr/bin/env node
/**
 * Is there a closed region hiding in `@accesses`'s routine end? (#255)
 *
 *   npm run measure:accesses-closed                 -- this repo, rust-test, orangutan,
 *                                                      graphify, mundane, infrarouter
 *   npm run measure:accesses-closed -- <path>...    -- any trees you like
 *   npm run measure:accesses-closed -- --all        -- every disagreement, not the first few
 *   npm run measure:accesses-closed -- --no-tier2   -- syntax only, no type checkers
 *   npm run measure:accesses-closed -- --json <path>...     -- tallies as JSON
 *   npm run measure:accesses-closed -- --merge <file.json>... -- one report from several
 *
 * `mundane` does not fit in one process. The TypeScript referee keeps up to 24
 * compiled programs in memory and a monorepo package pulls its whole
 * `node_modules` into each, so the default run exhausts an 8 GiB heap there.
 * It is measured one package per process and merged:
 *
 *   for d in ~/mundane/apps/* ~/mundane/packages/*; do
 *     npm run -s measure:accesses-closed -- --json "$d" \
 *       > "out/mundane-$(basename "$(dirname "$d")")-$(basename "$d").json"
 *   done
 *
 * The group goes in the file name because `apps/graph` and `packages/graph`
 * are both called `graph`. Fourteen files sit outside both directories, all
 * of them skill examples under `.agents`, and are not read.
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
import {
  callSitesIn, EXTERNAL_RECEIVER,
  type BodyCallSites, type CallSide, type ReceiverResolution,
} from "../src/engine/calls";
import { readDependencies } from "../src/engine/deps";
import { createWorkspace } from "../src/engine/drift";
import type { ConfigCache } from "../src/engine/resolve";
import { initEngine, languageOf, type Language } from "../src/engine/parse";
import { memberReadsIn, type MemberReadSite, type ReadHazard } from "../src/engine/resolution";

await initEngine();

const HOME = process.env.HOME ?? "/Users/noelmatero";
const flags = new Set(process.argv.slice(2).filter((one) => one.startsWith("--")));
const roots = process.argv.slice(2).filter((one) => !one.startsWith("--"));
const showAll = flags.has("--all");
const noTier2 = flags.has("--no-tier2");
/**
 * Print the tallies as JSON instead of a table.
 *
 * The corpus does not fit in one process: `mundane` is 1,175 files and
 * building a `ts.Program` per package in it is what the 8 GiB heap on
 * `measure:resolution` exists for, and it was still killed here. So the run
 * is split and the halves are added up -- by a reader that cannot misread a
 * column, rather than by eye.
 */
const asJson = flags.has("--json");

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
  /**
   * Routines with no name: callbacks, `rows.map((row) => ..)`.
   *
   * Not in the population, and counted so the exclusion is on the record
   * rather than silent. `accesses.ts` finds the tail of an arrow by name, so
   * no board can ever ask this word about one of these -- and the reads
   * inside one are already counted, in the named routine that encloses it.
   * Pairing this reader's bodies with `callSitesIn`'s found the problem: all
   * 501 bodies that did not pair were anonymous, and all 550 named ones did.
   */
  anonymous: number;
  /** Every named routine the reader read, whatever it contained. */
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
  /** Bodies knocked out by each hazard, counted once per body. */
  hazard: Map<string, number>;
  /** Bodies with exactly one kind of hazard -- what fixing that kind would return. */
  soleHazard: Map<string, number>;
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
      anonymous: 0, routines: 0, readless: 0, withReads: 0, reads: 0, resolved: 0,
      placedAll: 0, closed: 0, hazard: new Map(), soleHazard: new Map(),
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
    if (routine.routine === "") { into.anonymous += 1; continue; }
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
    if (hazards.size === 1) bump(into.soleHazard, [...hazards][0]!);
    /*
     * Every kind knocks the body out, `computed` included. The first version
     * of this let `c[k]` stay in on the grounds that it is usually an array
     * index -- but "usually" is a guess about a body, and `c[k]` on a Config
     * reads whichever member `k` names. `soleHazard` says what telling the two
     * apart would buy back, which is a coverage question and not a trust one.
     */
    if (hazards.size > 0) continue;
    into.closed += 1;
  }
}

/** Whether a body is in region A at this tier. The same rule `count` applies. */
function inRegionA(routine: RoutineReading, tier: Tier): boolean {
  if (routine.routine === "") return false;
  if (routine.sites.length === 0) return false;
  if (routine.sites.some((site) => !placed(site, tier))) return false;
  return routine.hazards.length === 0;
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

/**
 * What choosing region A over region B costs, measured rather than argued.
 *
 * If `draw()` calls `paint()` and *paint* reads `width`, most people drawing
 * a board would say `draw` reads `width`. A refutation from region A -- every
 * direct read placed -- is wrong about exactly those bodies. So for every
 * region-A body this follows each call one hop into the repository and asks
 * whether the callee reads a member the body does not read itself.
 *
 * **Type-aware, and one hop.** A pair is a member *and the type it was read
 * off*: `draw --[width]--> Config` is only contradicted by a callee reading
 * `width` off Config, not by one reading a `width` off anything at all. The
 * first version compared names alone and reported half of all members as
 * reachable through a helper, which is a number about spelling.
 *
 * A type is keyed by the repository file the checker says declares it. A
 * type outside the repository, or one the checker named without placing, is
 * left out on both sides: no board has a box for `string`. Spot-checked
 * against the source: of 84 bodies that reached a pair through a callee, 1
 * did so only through a member it already read under a different key.
 *
 * A helper's helper is not followed, so the true reach is larger. Every body
 * whose calls could not all be followed is counted in its own column, never
 * assumed clean.
 */

/**
 * The type a read was read off, as a key two readings can be compared by --
 * only for a type declared in this repository.
 *
 * A board only has a box for a type the repository declares, so only those
 * pairs can be on an arrow. The first type-aware run also kept types the
 * checker named without a declaring file, and they were `string#endsWith`
 * and `Node | undefined#text`: 178 of 620 reached pairs, none of them a thing
 * anybody draws. Dropped on both sides, so the comparison stays symmetric.
 */
function typeKeyOf(site: MemberReadSite): string | undefined {
  return site.placed?.kind === "declared" ? `file:${site.placed.file}` : undefined;
}

/** Every (type, member) pair a list of reads touches, in-repository types only. */
function pairsOf(sites: MemberReadSite[]): Set<string> {
  const pairs = new Set<string>();
  for (const site of sites) {
    const key = typeKeyOf(site);
    if (key) pairs.add(`${key}#${site.member}`);
  }
  return pairs;
}
interface HelperCost {
  regionA: number;
  /** Makes no call. Regions A and B agree about these. */
  callless: number;
  /** No call reading was found on the same line. Unknown, not clean. */
  unmatched: number;
  /** At least one call nobody could place. Unknown, not clean. */
  unplaced: number;
  /** Placed in this repository at a file with no routine of that name. Unknown. */
  calleeUnread: number;
  /** Every call followed, and no callee reads a member this body does not. */
  clean: number;
  /** Every call followed, and a callee reads a member this body does not. */
  reaches: number;
  /** Of `clean` + `reaches`, bodies with a call that leaves the repository. */
  external: number;
  /** Distinct (type, member) pairs read directly, summed over `clean` + `reaches`. */
  ownMembers: number;
  /** Distinct (type, member) pairs reached only through a callee, same bodies. */
  viaHelper: number;
  /**
   * Why a call could not be placed, per call site, in `unplaced` bodies.
   *
   * Reported rather than lumped, because the first run lumped them and the
   * lump was mostly `name.replace(..)` and `Number(..)` -- built-ins that can
   * never be a helper in this repository. A reader of the table needs to see
   * that before deciding region B is small for a reason that matters.
   */
  unplacedWhy: Record<string, number>;
}
const helperCost = new Map<Language, HelperCost>();
function helper(language: Language): HelperCost {
  let found = helperCost.get(language);
  if (!found) {
    found = {
      regionA: 0, callless: 0, unmatched: 0, unplaced: 0, calleeUnread: 0,
      clean: 0, reaches: 0, external: 0, ownMembers: 0, viaHelper: 0, unplacedWhy: {},
    };
    helperCost.set(language, found);
  }
  return found;
}

function followCalls(
  language: Language,
  routines: RoutineReading[],
  bodies: BodyCallSites[],
  membersOf: (file: string, routine: string) => Set<string> | undefined,
): void {
  const into = helper(language);
  for (const routine of routines) {
    if (!inRegionA(routine, "tier2")) continue;
    into.regionA += 1;

    /*
     * Paired by the line the routine opens on, and by name where two open on
     * one line. Both readers take that line from the declaration's own start,
     * so a miss here is a shape the two disagree about rather than a body
     * with no calls -- and it is counted as unknown for that reason.
     */
    const sameLine = bodies.filter((body) => body.line === routine.line);
    const body = sameLine.length === 1
      ? sameLine[0]
      : sameLine.find((one) => one.routine === routine.routine);
    if (!body) { into.unmatched += 1; continue; }
    if (body.sites.length === 0) { into.callless += 1; continue; }
    const unplacedSites = body.sites.filter((site) => site.file === undefined);
    if (unplacedSites.length > 0) {
      into.unplaced += 1;
      for (const site of unplacedSites) {
        const key = `${site.why}/${site.receiver ? "receiver" : "bare"}`;
        into.unplacedWhy[key] = (into.unplacedWhy[key] ?? 0) + 1;
      }
      continue;
    }

    const own = pairsOf(routine.sites);
    const reached = new Set<string>();
    let unread = false;
    let leaves = false;
    for (const site of body.sites) {
      if (site.file === EXTERNAL_RECEIVER) { leaves = true; continue; }
      const members = membersOf(site.file!, site.name);
      if (!members) { unread = true; break; }
      for (const pair of members) if (!own.has(pair)) reached.add(pair);
    }
    if (unread) { into.calleeUnread += 1; continue; }

    if (leaves) into.external += 1;
    into.ownMembers += own.size;
    into.viaHelper += reached.size;
    if (reached.size > 0) into.reaches += 1; else into.clean += 1;
  }
}

const merging = flags.has("--merge");

if (!merging) {
  for (const tree of trees) {
    const files = sourceFiles(tree);
    const label = path.basename(tree);
    console.error(`  [${label}] ${files.length} files`);

    const workspace = createWorkspace(tree);
    const configs: ConfigCache = new Map();
    const relOf = (file: string) => path.relative(tree, file);

    const sources = new Map<string, string | undefined>();
    const read = (relative: string): string | undefined => {
      if (sources.has(relative)) return sources.get(relative);
      const absolute = workspace.resolve(relative);
      const text = absolute && workspace.stat(absolute) === "file" ? workspace.read(absolute) : undefined;
      sources.set(relative, text);
      return text;
    };
    const importsOf = new Map<string, CallSide["imports"]>();
    const imports = (relative: string, source: string): CallSide["imports"] => {
      const cached = importsOf.get(relative);
      if (cached) return cached;
      const declared = readDependencies(relative, source, workspace, configs)?.dependencies ?? [];
      const list = declared.map((one) => ({ specifier: one.specifier, ...(one.file ? { file: one.file } : {}) }));
      importsOf.set(relative, list);
      return list;
    };
    const open = (relative: string) => {
      const source = read(relative);
      const language = languageOf(relative);
      if (source === undefined || !language) return undefined;
      return { source, language, imports: imports(relative, source) };
    };
    const sideFor = (
      relative: string, source: string, language: Language,
      resolveReceiver?: (at: { start: number; end: number }) => ReceiverResolution | undefined,
    ): CallSide => ({
      file: relative, source, language, imports: imports(relative, source), open,
      ...(resolveReceiver ? { resolveReceiver } : {}),
    });

    /**
     * The checker to read a callee with, per language, so its reads are keyed
     * by type the same way the caller's were. TypeScript is asked in process;
     * Python and Rust are looked up in the batch their pass already resolved,
     * which is set before any body in that language is followed.
     */
    const resolverFor = new Map<Language, (file: string) => ((at: { start: number; end: number }) => ReceiverResolution | undefined) | undefined>();

    /** Every (type, member) pair a routine of this name reads. */
    const readsByRoutine = new Map<string, Map<string, Set<string>> | null>();
    const membersOf = (relative: string, routine: string): Set<string> | undefined => {
      if (!readsByRoutine.has(relative)) {
        const source = read(relative);
        const language = languageOf(relative);
        const resolve = language ? resolverFor.get(language)?.(relative) : undefined;
        const reading = source !== undefined && language ? memberReadsIn(source, language, resolve) : undefined;
        if (!reading?.read) readsByRoutine.set(relative, null);
        else {
          const byName = new Map<string, Set<string>>();
          for (const one of reading.routines) {
            if (!one.routine) continue;
            const set = byName.get(one.routine) ?? new Set<string>();
            for (const pair of pairsOf(one.sites)) set.add(pair);
            byName.set(one.routine, set);
          }
          readsByRoutine.set(relative, byName);
        }
      }
      return readsByRoutine.get(relative)?.get(routine) ?? undefined;
    };

    /* -------------------------------------------------------- tier 1, and ts */
    const tsReferee = noTier2 ? undefined : (() => {
      try { return createTsReferee(tree); } catch { return undefined; }
    })();
    if (tsReferee) {
      const inProcess = (relative: string) => (at: { start: number; end: number }) =>
        receiverResolutionFrom(tsReferee.typeAt(path.join(tree, relative), at.start, at.end), tree);
      for (const language of ["ts", "tsx", "js"] as Language[]) resolverFor.set(language, inProcess);
    }

    for (const file of files) {
      const language = languageOf(file);
      if (!language) continue;
      const relative = relOf(file);
      const source = read(relative);
      if (source === undefined) continue;

      const tier1 = memberReadsIn(source, language);
      if (!tier1.read) continue;
      count("tier1", language, tier1.routines);

      if (noTier2 || LSP_LANGUAGES.includes(language)) continue;
      const ask = tsReferee
        ? (at: { start: number; end: number }) => receiverResolutionFrom(tsReferee.typeAt(file, at.start, at.end), tree)
        : undefined;
      const answer = ask
        ? (at: { start: number; end: number }): ReceiverResolution | undefined => {
          const tally = resolverAnswers.get(language) ?? { answered: 0, none: 0 };
          resolverAnswers.set(language, tally);
          const found = ask(at);
          if (found) tally.answered += 1; else tally.none += 1;
          return found;
        }
        : undefined;
      const tier2 = memberReadsIn(source, language, answer);
      if (!tier2.read) continue;
      count("tier2", language, tier2.routines);
      referee(relative, source, language, tier2.routines);

      // Asked through `ask`, not `answer`: the reach column is about reads.
      const calls = callSitesIn(sideFor(relative, source, language, ask));
      if (calls.read) followCalls(language, tier2.routines, calls.bodies, membersOf);
    }

    /* ----------------------------------------- tier 2 over a language server
     *
     * Python's and Rust's resolvers answer over LSP and both readers here are
     * synchronous, so the reading above cannot ask them mid-walk. The shape
     * `resolution-python-live.ts` already solved for the live checker is
     * reused: read once with a resolver that records every question and
     * answers none, resolve the whole batch -- read receivers and call
     * receivers together, one server round -- then read again through a
     * synchronous lookup into what came back.
     */
    if (noTier2) continue;
    for (const language of LSP_LANGUAGES) {
      const inLanguage = files.filter((one) => languageOf(one) === language);
      if (inLanguage.length === 0) continue;

      const readQueries: Array<{ file: string; at: { start: number; end: number } }> = [];
      const callQueries: Array<{ file: string; at: { start: number; end: number } }> = [];
      for (const file of inLanguage) {
        const relative = relOf(file);
        const source = read(relative);
        if (source === undefined) continue;
        memberReadsIn(source, language, (at) => { readQueries.push({ file: relative, at }); return undefined; });
        callSitesIn(sideFor(relative, source, language, (at) => { callQueries.push({ file: relative, at }); return undefined; }));
      }
      const queries = [...readQueries, ...callQueries];
      if (queries.length === 0) continue;

      console.error(`  [${label}/${language}] ${readQueries.length} read and ${callQueries.length} call receivers to resolve`);
      const startedAt = Date.now();
      const answers = language === "python"
        ? await resolvePythonReceivers(tree, queries)
        : await resolveRustReceivers(tree, queries, new Set(["target", "node_modules", ".git", "dist", "out", "vendor", ".venv", ".claude"]));
      console.error(`  [${label}/${language}] done in ${Math.round((Date.now() - startedAt) / 1000)}s`);

      resolverFor.set(language, (relative) => (at) => answers.cache.get(relative, at));

      const tally = resolverAnswers.get(language) ?? { answered: 0, none: 0 };
      resolverAnswers.set(language, tally);
      for (const query of readQueries) {
        if (answers.cache.get(query.file, query.at)) tally.answered += 1; else tally.none += 1;
      }

      for (const file of inLanguage) {
        const relative = relOf(file);
        const source = read(relative);
        if (source === undefined) continue;
        const lookup = (at: { start: number; end: number }) => answers.cache.get(relative, at);
        const tier2 = memberReadsIn(source, language, lookup);
        if (!tier2.read) continue;
        count("tier2", language, tier2.routines);
        referee(relative, source, language, tier2.routines);
        const calls = callSitesIn(sideFor(relative, source, language, lookup));
        if (calls.read) followCalls(language, tier2.routines, calls.bodies, membersOf);
      }
    }
  }
}

/* ---------------------------------------------------------------- the report */

type Counts = Record<string, number>;
interface Measured {
  trees: string[];
  tallies: Record<Tier, Record<string, Record<string, number | Counts>>>;
  helper: Record<string, Record<string, number | Counts>>;
  resolverAnswers: Record<string, Counts>;
  refereeAsked: Counts;
  refereeAgreed: Counts;
  unseen: Array<{ file: string; member: string; line: number }>;
}

function measured(): Measured {
  const plain = (map: Map<string, number>) => Object.fromEntries(map);
  return {
    trees,
    tallies: Object.fromEntries([...tallies].map(([tier, per]) => [
      tier,
      Object.fromEntries([...per].map(([language, one]) => [language, {
        ...one,
        hazard: plain(one.hazard), soleHazard: plain(one.soleHazard),
        anyBlocker: plain(one.anyBlocker), soleBlocker: plain(one.soleBlocker),
      }])),
    ])) as unknown as Measured["tallies"],
    helper: Object.fromEntries([...helperCost].map(([language, one]) => [language, { ...one }])),
    resolverAnswers: Object.fromEntries(resolverAnswers),
    refereeAsked: Object.fromEntries(refereeAsked),
    refereeAgreed: Object.fromEntries(refereeAgreed),
    unseen,
  };
}

/**
 * Add two readings of the same shape, number by number.
 *
 * Every leaf here is a count, so a sum is the right way to combine them --
 * there is no rate anywhere in the JSON, on purpose, because averaging two
 * percentages over different populations is how a merged figure goes wrong.
 */
function add(into: Record<string, unknown>, from: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(from)) {
    if (typeof value === "number") {
      into[key] = ((into[key] as number | undefined) ?? 0) + value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const child = (into[key] as Record<string, unknown> | undefined) ?? {};
      add(child, value as Record<string, unknown>);
      into[key] = child;
    }
  }
}

function merged(files: string[]): Measured {
  const total: Measured = {
    trees: [], tallies: { tier1: {}, tier2: {} }, helper: {}, resolverAnswers: {},
    refereeAsked: {}, refereeAgreed: {}, unseen: [],
  };
  for (const file of files) {
    const one = JSON.parse(readFileSync(file, "utf8")) as Measured;
    total.trees.push(...one.trees);
    total.unseen.push(...one.unseen);
    const { trees: _t, unseen: _u, ...counts } = one;
    add(total as unknown as Record<string, unknown>, counts as unknown as Record<string, unknown>);
  }
  return total;
}

const data = merging ? merged(roots) : measured();

if (asJson) {
  console.log(JSON.stringify(data));
  process.exit(0);
}

const percent = (part: number, whole: number) =>
  whole === 0 ? "  n/a" : `${((part / whole) * 100).toFixed(1)}%`;
const cap = (count: number, few: number) => (showAll ? count : Math.min(count, few));
const num = (value: unknown) => (typeof value === "number" ? value : 0);
const counts = (value: unknown) => (value && typeof value === "object" ? value as Counts : {});
const listed = (value: unknown, few = 6) => Object.entries(counts(value))
  .sort((a, b) => b[1] - a[1]).slice(0, cap(99, few))
  .map(([why, n]) => `${why} ${n}`).join(", ");

console.log("\nMEASURE ACCESSES-CLOSED -- is there a region the routine end could accuse from? (#255)");
console.log(`  ${data.trees.length} trees${merging ? `, merged from ${roots.length} runs` : ""}\n`);

for (const tier of ["tier1", "tier2"] as Tier[]) {
  const per = data.tallies[tier];
  if (Object.values(per).every((one) => num(one.withReads) === 0)) continue;
  console.log(tier === "tier1"
    ? "A · FROM THE TEXT ALONE -- no type checker asked"
    : "B · WITH THE REAL TYPE CHECKER -- tsc, pyright, rust-analyzer");
  if (tier === "tier1") {
    console.log("  Named routines only: a board finds an arrow's tail by name. `anonymous` is");
    console.log("  every callback left out, and its reads are counted in the routine around it.");
  }
  console.log("  language  anonymous  routines  no reads  with reads     reads  reads placed  all placed  REGION A   share");
  for (const language of LANGUAGES) {
    const one = per[language];
    if (!one || num(one.routines) === 0) continue;
    console.log(
      " ", language.padEnd(8), String(num(one.anonymous)).padStart(9),
      String(num(one.routines)).padStart(9), String(num(one.readless)).padStart(9),
      String(num(one.withReads)).padStart(11), String(num(one.reads)).padStart(9),
      percent(num(one.resolved), num(one.reads)).padStart(13),
      String(num(one.placedAll)).padStart(11),
      String(num(one.closed)).padStart(9), percent(num(one.closed), num(one.withReads)).padStart(7),
    );
  }
  console.log();
}

console.log("  READS WITH NO `.name` -- bodies where every read placed, knocked out anyway.");
console.log("  The referee is blind to these in the same way the reader is. `sole` is what");
console.log("  handling that one kind would give back.");
for (const language of LANGUAGES) {
  const one = data.tallies.tier2[language];
  if (!one || Object.keys(counts(one.hazard)).length === 0) continue;
  console.log(`   ${language.padEnd(7)} any: ${listed(one.hazard)}   sole: ${listed(one.soleHazard)}`);
}

console.log("\n  WHAT KEPT A BODY OPEN -- per body; `sole` would close it on its own. Tier 2.");
for (const language of LANGUAGES) {
  const one = data.tallies.tier2[language];
  if (!one || Object.keys(counts(one.soleBlocker)).length === 0) continue;
  console.log(`   ${language.padEnd(7)} sole: ${listed(one.soleBlocker)}`);
}

console.log("\nC · REGION B -- does following each call one hop change the answer? Tier 2.");
console.log("  Among region-A bodies. `reaches` is a body whose callee reads a member it does");
console.log("  not read itself: a refutation from region A would be wrong about that member.");
console.log("  A member counts only if read off the same type. One hop, so it under-counts.");
console.log("  language  region A  no calls  followed  clean  reaches  unknown   REGION B   share   via a helper");
for (const language of LANGUAGES) {
  const one = data.helper[language];
  if (!one || num(one.regionA) === 0) continue;
  const followed = num(one.clean) + num(one.reaches);
  const unknown = num(one.unmatched) + num(one.unplaced) + num(one.calleeUnread);
  const regionB = num(one.callless) + followed;
  const withReads = num(data.tallies.tier2[language]?.withReads);
  console.log(
    " ", language.padEnd(8), String(num(one.regionA)).padStart(8), String(num(one.callless)).padStart(9),
    String(followed).padStart(9), String(num(one.clean)).padStart(6), String(num(one.reaches)).padStart(8),
    String(unknown).padStart(8), String(regionB).padStart(10), percent(regionB, withReads).padStart(7),
    `${percent(num(one.viaHelper), num(one.ownMembers) + num(one.viaHelper))} of pairs`.padStart(18),
  );
}
console.log("  unknown, split: ");
for (const language of LANGUAGES) {
  const one = data.helper[language];
  if (!one || num(one.regionA) === 0) continue;
  console.log(`   ${language.padEnd(7)} unplaced call ${num(one.unplaced)}, callee not a routine ${num(one.calleeUnread)}, unmatched ${num(one.unmatched)}, leaves the repo ${num(one.external)}`);
  console.log(`   ${"".padEnd(7)} why unplaced, per call: ${listed(one.unplacedWhy, 8)}`);
}

console.log("\n  THE CHECKER'S REACH -- read receivers it answered, so a low share reads as");
console.log("  reach rather than as the checker failing.");
for (const language of LANGUAGES) {
  const one = data.resolverAnswers[language];
  if (!one) continue;
  const asked = num(one.answered) + num(one.none);
  console.log(`   ${language.padEnd(7)} ${asked} asked, ${num(one.answered)} answered (${percent(num(one.answered), asked)})`);
}

console.log("\n  THE REFEREE ON THE PREMISE -- a body's reads being enumerable. Per file,");
console.log("  because the referee reports a line and a callback shares its line with the");
console.log("  call it is passed to; per body that attribution is not sound.");
for (const language of LANGUAGES) {
  const asked = num(data.refereeAsked[language]);
  if (!asked) continue;
  const agreed = num(data.refereeAgreed[language]);
  console.log(`   ${language.padEnd(7)} ${asked} members the referee read, ${agreed} this reader also read (${percent(agreed, asked)})`);
}
console.log(`\n  UNSEEN -- a member the referee read that this reader read nowhere: ${data.unseen.length}`);
console.log("    Each is a way a body can look closed while a read in it was never seen.");
for (const one of data.unseen.slice(0, cap(data.unseen.length, 15))) {
  console.log(`    ${one.file}:${one.line} ${one.member}`);
}
if (data.unseen.length > cap(data.unseen.length, 15)) {
  console.log(`    ... and ${data.unseen.length - 15} more (--all prints every one)`);
}
