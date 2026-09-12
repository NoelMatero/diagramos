#!/usr/bin/env node
/**
 * Can "this code never reaches that" be proved often enough to catch a false
 * arrow? (#58)
 *
 *   npm run measure:reach                           -- every pinned repository in .corpus
 *   npm run measure:reach -- --only=ripgrep         -- some of them
 *   npm run measure:reach -- --all                  -- every door and every case, not the first few
 *   npm run measure:reach -- --no-checker           -- skip the language-server referee, most of the run
 *   npm run measure:reach -- --no-prune             -- never rule a caller out on where the reader placed its call
 *   npm run measure:reach -- --only=pallets-flask --trace=<file>
 *                                                    -- score both walks against the tests as they ran
 *
 * **A measurement. No word ships from it and nothing here can colour a diagram.**
 *
 * ## The question
 *
 * An arrow "A -> D" onto a door -- the routine that talks to a file, a socket
 * or another process -- is false when A cannot reach D. Confirming it is easy:
 * find one path. Calling it *wrong* means proving no path exists, and this
 * repository has always answered that question **forwards**: enumerate every
 * call A makes, resolve each one, recurse. #217 and #221 measured what that
 * costs at one level, and #256 put it at about half of TypeScript bodies with a
 * real type checker, a quarter of Python's and a sixth of Rust's. Forwards, a
 * path of three bodies needs all three, so the rate is those numbers multiplied.
 *
 * ## Why backwards is a different question, not the same one reversed
 *
 * Forwards, a call this reader cannot place could go **anywhere**, so one of
 * them anywhere on the frontier ends the proof. Backwards, the same call has an
 * unknown target but a **known caller**: start at the door and walk incoming
 * uses, and a use that might lead into the set adds exactly one routine -- the
 * one it is written in. So `S(D)`, every routine that could possibly reach `D`,
 * can be over-approximated at a bounded price, and over-approximating is sound
 * in the direction that matters: a routine outside `S(D)` cannot reach it. The
 * share of routines outside is the ceiling on catching a false arrow.
 *
 * ## Two walks, because the first had a hole both of its referees shared
 *
 * `calls` indexes a routine by the names it **calls**. That is blind to two
 * shapes, and a probe over all three languages confirmed both: a function handed
 * over as a value -- `map(door, items)`, `items.forEach(door)`, `let f = door` --
 * leaves no call to `door` anywhere; and a call through a parameter or variable,
 * `fn()`, leaves a name that matches no routine. Either one puts a routine that
 * reaches the door outside the set.
 *
 * `mentions` indexes every name a routine's text **uses**, called or not, and
 * treats a bare call to a name the file binds -- a parameter, a local, a
 * module-level alias -- as a call to anything. The two shares are printed side
 * by side, and the gap between them is what soundness against those shapes costs.
 *
 * Both walks live in `scripts/lib/reach.ts`, where each shape has a test.
 *
 * ## Three referees, and which blind spot each one has
 *
 * - **The premise**: call sites are enumerable. `scripts/lib/call-scan.ts` finds
 *   calls by the shape of `name(`, sharing no tree-sitter query with the reader,
 *   and the run prints what it saw that the reader did not.
 * - **The answer, statically**: for a sample of routines placed outside a set,
 *   each language's own checker is asked "go to definition" at every call. Blind
 *   to the shapes above, because it asks about call sites and a value is not one.
 * - **The answer, as the code ran** (`--trace`): a record of which repository
 *   functions called which while the test suite actually ran, from
 *   `scripts/lib/reach_trace.py`. Library frames, tests and lambdas in between
 *   are passed through, so a callback a library fires, a function stored and
 *   called later, a framework dispatching to a method -- every shape no reader
 *   here follows -- is an edge. A routine that reached a door at runtime and
 *   sits outside that door's set is a false accusation the walk would have made.
 *   It shares nothing with either walk: no parse, no index, no name. It sees
 *   only what the tests ran, so it can find false accusations and never prove
 *   there are none.
 *
 * Nothing here uses a type checker to build a set: tier 1 only.
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { checkerFor, type CallChecker } from "./lib/call-receivers";
import {
  anythingCallers, constructs, couldReach, familyOf, mayLeadInto, readRepo, WALKS,
  type Family, type Routine, type Walk,
} from "./lib/reach";

import { LICENCES } from "../src/engine/licence";
import { type OutsideKind } from "../src/engine/outside";
import { initEngine } from "../src/engine/parse";

const HOME = process.env.HOME ?? "/Users/noelmatero";
const argv = process.argv.slice(2);
const option = (name: string) => argv.find((one) => one.startsWith(`--${name}=`))?.slice(name.length + 3);
const showAll = argv.includes("--all");
const noChecker = argv.includes("--no-checker");
const walkOptions = { prune: !argv.includes("--no-prune") };
const only = option("only")?.split(",").filter(Boolean);
const tracePath = option("trace");
/** Routines per language whose outside-the-set verdict the checker is asked about. */
const sampleSize = Number(option("sample") ?? 120);
const CASES = showAll ? Infinity : 10;

const CORPUS = existsSync(path.resolve(".corpus")) ? path.resolve(".corpus") : `${HOME}/board-ai/.corpus`;

interface Repo { name: string; dir: string; state: "pinned" | "moved" | "missing" }

const repos: Repo[] = LICENCES.flatMap((licence) => licence.corpus.map((entry) => {
  const candidates = [entry.name.replace("/", "-"), entry.name.split("/").pop()!];
  const dir = candidates.map((one) => path.join(CORPUS, one)).find((one) => existsSync(one)) ?? path.join(CORPUS, candidates[0]!);
  let state: Repo["state"] = "missing";
  if (existsSync(dir)) {
    let head = "";
    try { head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
    state = head === entry.commit ? "pinned" : "moved";
  }
  return { name: entry.name, dir, state };
}))
  .filter((repo, index, all) => all.findIndex((other) => other.dir === repo.dir) === index)
  .filter((repo) => !only || only.some((one) => repo.dir.endsWith(`/${one}`) || repo.name === one));

await initEngine();

/** A stable spread over routine ids: the same sample every run. */
const sampleKey = (id: string) => createHash("sha1").update(id).digest("hex");

/* -- the recorded run ----------------------------------------------------- */

/** `[fromFile, fromName, fromLine, toFile, toName, toLine, through, count]`, as `reach_trace.py` writes them. */
type TraceEdge = [string, string, number, string, string, number, boolean, number];
interface Trace { root: string; testsCollected: number; testsFailed: number; edges: TraceEdge[] }

const trace: Trace | undefined = tracePath ? JSON.parse(readFileSync(tracePath, "utf8")) as Trace : undefined;

interface TraceScore {
  repo: string;
  edges: number;
  through: number;
  unmatched: number;
  doorsReached: number;
  pairs: number;
  missedEdges: Record<Walk, Array<{ from: string; to: string; through: boolean }>>;
  falseAccusations: Record<Walk, Array<{ routine: string; door: string }>>;
}
let traceScore: TraceScore | undefined;

/* -- the run -------------------------------------------------------------- */

interface DoorRow { repo: string; door: string; kind: OutsideKind; reaching: Record<Walk, number>; routines: number }
interface LanguageTally { doors: number; total: number; reaching: Record<Walk, number>; anything: Record<Walk, number> }

const rows: DoorRow[] = [];
const perLanguage = new Map<Family, LanguageTally>();
const refereeTotals = new Map<string, { seen: number; unseen: number }>();
const outsideSamples: Array<{ repo: Repo; routine: Routine; door: Routine; set: Set<string>; at: Map<string, string> }> = [];

for (const repo of repos) {
  if (repo.state === "missing") continue;
  const read = readRepo(repo.dir);
  const doors = [...read.routines.values()].filter((one) => one.door);
  /*
   * Which routine a declaration line belongs to. The checker answers with a
   * file and a line, and matching only the file calls every call between two
   * routines of one file a landing in the set.
   */
  const at = new Map<string, string>();
  for (const one of read.routines.values()) at.set(`${one.file}:${one.line}`, one.id);
  refereeTotals.set(repo.name, { seen: read.refereeSites, unseen: read.refereeUnseen });

  const setsOf = new Map<string, Record<Walk, Set<string>>>();
  for (const door of doors) {
    const family = familyOf(door.language)!;
    const sameLanguage = [...read.routines.values()].filter((one) => familyOf(one.language) === family);
    const tally = perLanguage.get(family)
      ?? { doors: 0, total: 0, reaching: { calls: 0, mentions: 0 }, anything: { calls: 0, mentions: 0 } };
    perLanguage.set(family, tally);
    tally.doors += 1;
    tally.total += sameLanguage.length;
    const sets = {} as Record<Walk, Set<string>>;
    const reaching = {} as Record<Walk, number>;
    for (const walk of WALKS) {
      const { set, fromAnything } = couldReach(door, read, walk, walkOptions);
      sets[walk] = set;
      /*
       * Names match across languages on purpose -- Python reaches Rust through
       * pyo3, and over-including is the safe direction -- but a share is only
       * meaningful inside one language. Counting the whole set printed 15872.7%
       * for a JavaScript door in pydantic, whose set was mostly Python.
       */
      reaching[walk] = sameLanguage.filter((one) => set.has(one.id)).length;
      tally.reaching[walk] += reaching[walk];
      tally.anything[walk] += fromAnything;
    }
    setsOf.set(door.id, sets);
    rows.push({ repo: repo.name, door: door.id, kind: door.door!, reaching, routines: sameLanguage.length });

    // Spread by a hash of the id, never walk order: walk order put every Python
    // sample in `docs/conf.py`, a file pyright does not index.
    const candidates = sameLanguage
      .filter((one) => !sets.mentions.has(one.id) && one.sites.length > 0)
      .sort((a, b) => sampleKey(a.id).localeCompare(sampleKey(b.id)))
      .slice(0, 3);
    for (const candidate of candidates) outsideSamples.push({ repo, routine: candidate, door, set: sets.mentions, at });
  }

  if (trace && existsSync(repo.dir) && realpathSync(repo.dir) === trace.root) {
    const score: TraceScore = {
      repo: repo.name, edges: 0, through: 0, unmatched: 0, doorsReached: 0, pairs: 0,
      missedEdges: { calls: [], mentions: [] }, falseAccusations: { calls: [], mentions: [] },
    };
    const callersOf = new Map<string, Set<string>>();
    for (const [fromFile, fromName, , toFile, toName, , through] of trace.edges) {
      const from = `${fromFile}#${fromName}`;
      const to = `${toFile}#${toName}`;
      const caller = read.routines.get(from);
      const callee = read.routines.get(to);
      if (!caller || !callee) { score.unmatched += 1; continue; }
      if (from === to) continue;
      score.edges += 1;
      if (through) score.through += 1;
      callersOf.set(to, (callersOf.get(to) ?? new Set()).add(from));
      for (const walk of WALKS) {
        const seen = anythingCallers(read, walk).has(from) || mayLeadInto(caller, callee, walk, walkOptions)
          || (walk === "mentions" && constructs(read, caller, callee));
        if (!seen) score.missedEdges[walk].push({ from, to, through });
      }
    }
    for (const door of doors) {
      // Every routine the tests saw reach this door, through anything at all.
      const reached = new Set<string>();
      const frontier = [door.id];
      while (frontier.length > 0) {
        const current = frontier.pop()!;
        for (const caller of callersOf.get(current) ?? []) {
          if (reached.has(caller) || caller === door.id) continue;
          reached.add(caller);
          frontier.push(caller);
        }
      }
      if (reached.size === 0) continue;
      score.doorsReached += 1;
      score.pairs += reached.size;
      const sets = setsOf.get(door.id)!;
      for (const walk of WALKS) {
        for (const routine of reached) {
          if (!sets[walk].has(routine)) score.falseAccusations[walk].push({ routine, door: door.id });
        }
      }
    }
    traceScore = score;
  }
}

/* -- the static referee: is "outside the set" true, call by call? --------- */

interface Checked { wrong: number; asked: number; silent: number; sites: number; answers: number }
const checkedBy = new Map<Family, Checked>();
const staticFalse: Array<{ routine: string; door: string; landed: string }> = [];

if (!noChecker) {
  const byFamily = new Map<Family, typeof outsideSamples>();
  for (const one of outsideSamples) {
    const family = familyOf(one.routine.language)!;
    const list = byFamily.get(family) ?? [];
    if (list.length < sampleSize) list.push(one);
    byFamily.set(family, list);
  }
  for (const [family, samples] of byFamily) {
    const byRepo = new Map<string, typeof samples>();
    for (const one of samples) byRepo.set(one.repo.dir, [...(byRepo.get(one.repo.dir) ?? []), one]);
    for (const [dir, group] of byRepo) {
      const made = await checkerFor(dir, group[0]!.routine.language);
      if ("unavailable" in made) continue;
      const checker: CallChecker = made;
      for (const one of group) {
        const tally = checkedBy.get(family) ?? { wrong: 0, asked: 0, silent: 0, sites: 0, answers: 0 };
        checkedBy.set(family, tally);
        tally.asked += 1;
        const absolute = path.join(dir, one.routine.file);
        let source: string;
        try { source = readFileSync(absolute, "utf8"); } catch { continue; }
        let answered = false;
        for (const site of one.routine.sites.slice(0, 40)) {
          // The reader's own byte range: a text search lands on the import.
          if (!site.name || !site.nameAt) continue;
          tally.sites += 1;
          const declared = await checker.definitionAt(absolute, source, site.nameAt);
          if (!declared) continue;
          tally.answers += 1;
          answered = true;
          const landed = one.at.get(`${path.relative(dir, declared.file)}:${declared.line + 1}`);
          if (landed && one.set.has(landed)) {
            tally.wrong += 1;
            staticFalse.push({ routine: one.routine.id, door: one.door.id, landed });
            break;
          }
        }
        if (!answered) tally.silent += 1;
      }
      checker.close();
    }
  }
}

/* -- the report ----------------------------------------------------------- */

const percent = (part: number, whole: number) => (whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`);

console.log();
console.log("CORPUS");
for (const repo of repos) console.log(`  ${repo.name.padEnd(24)} ${repo.state}`);

console.log();
console.log("COULD-REACH -- routines that might reach a door; every routine outside is a refutable arrow");
for (const [family, tally] of perLanguage) {
  const perDoor = tally.total / tally.doors;
  console.log(`  ${family.padEnd(7)} ${tally.doors} doors, ${Math.round(perDoor)} routines in the door's language on average`);
  for (const walk of WALKS) {
    const set = tally.reaching[walk] / tally.doors;
    console.log(`    ${walk.padEnd(9)} ${Math.round(set)} could reach (${percent(set, perDoor)}), `
      + `${percent(perDoor - set, perDoor)} refutable -- ${Math.round(tally.anything[walk] / tally.doors)} joined `
      + `every set because they call something that could be anything`);
  }
}

console.log();
console.log("PER DOOR, by the mentions walk -- widest first, which is where it gives up the most");
const widest = [...rows].sort((a, b) => (b.reaching.mentions / b.routines) - (a.reaching.mentions / a.routines));
for (const row of widest.slice(0, showAll ? Infinity : 15)) {
  console.log(`  ${percent(row.reaching.mentions, row.routines).padStart(6)}  (calls ${percent(row.reaching.calls, row.routines).padStart(6)})  `
    + `${row.kind.padEnd(8)} ${row.repo}/${row.door}`);
}

console.log();
console.log("THE PREMISE, REFEREED -- call names the text scan saw in a file that the reader did not");
for (const [repo, tally] of refereeTotals) {
  if (tally.seen === 0) continue;
  console.log(`  ${repo.padEnd(24)} ${tally.unseen} of ${tally.seen} (${percent(tally.unseen, tally.seen)})`);
}

console.log();
console.log("THE ANSWER, STATICALLY -- routines outside a door's mentions set, every call asked of the checker");
if (noChecker) console.log("  skipped (--no-checker).");
else if (checkedBy.size === 0) console.log("  no checker answered.");
for (const [family, tally] of checkedBy) {
  console.log(`  ${family.padEnd(7)} ${tally.asked} routines asked: ${tally.wrong} reach the set after all `
    + `(${percent(tally.wrong, tally.asked)}), ${tally.silent} unanswered -- `
    + `${tally.answers} of ${tally.sites} call sites answered (${percent(tally.answers, tally.sites)})`);
}
for (const one of staticFalse.slice(0, CASES)) console.log(`      ${one.routine} -> ${one.door}: reaches ${one.landed}`);

console.log();
console.log("THE ANSWER, AS THE CODE RAN -- the recorded test run, against both walks");
if (!trace) {
  console.log("  no --trace given.");
} else if (!traceScore) {
  console.log(`  the trace is of ${trace.root}, which is not a repository this run read.`);
} else {
  const score = traceScore;
  console.log(`  ${score.repo}: ${trace.testsCollected} tests collected, ${trace.testsFailed} failed; `
    + `${score.edges} call edges between its own routines (${score.through} through code that is not), `
    + `${score.unmatched} not matched to a routine this run read`);
  console.log(`  ${score.doorsReached} doors reached by the tests, from ${score.pairs} (routine, door) pairs`);
  for (const walk of WALKS) {
    const missed = score.missedEdges[walk];
    const through = missed.filter((one) => one.through).length;
    console.log(`    ${walk.padEnd(9)} ${score.falseAccusations[walk].length} false accusations `
      + `(${percent(score.falseAccusations[walk].length, score.pairs)} of pairs); `
      + `${missed.length} edges it cannot see, ${through} of them through other code`);
  }
  for (const walk of WALKS) {
    const cases = score.falseAccusations[walk];
    if (cases.length === 0) continue;
    console.log(`  false accusations, ${walk}:`);
    for (const one of cases.slice(0, CASES)) console.log(`      ${one.routine} reaches ${one.door}`);
    if (cases.length > CASES) console.log(`      ... and ${cases.length - CASES} more (--all)`);
  }
  const missed = score.missedEdges.mentions;
  if (missed.length > 0) {
    console.log("  edges the mentions walk cannot see:");
    for (const one of missed.slice(0, CASES)) {
      console.log(`      ${one.from} -> ${one.to}${one.through ? "  (through other code)" : ""}`);
    }
    if (missed.length > CASES) console.log(`      ... and ${missed.length - CASES} more (--all)`);
  }
}
