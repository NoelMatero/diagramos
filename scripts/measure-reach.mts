#!/usr/bin/env node
/**
 * Can "this code never reaches that" be proved often enough to catch a false
 * arrow? (#58)
 *
 *   npm run measure:reach                       -- every pinned repository in .corpus
 *   npm run measure:reach -- --only=ripgrep     -- some of them
 *   npm run measure:reach -- --all              -- every door, not the first few
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
 * costs at one level -- 15.1% of bodies have a fully resolved call set, and
 * with a real type checker about half in TypeScript, a quarter in Python, a
 * sixth in Rust (#256). Forwards, a path of three bodies needs all three, so
 * the rate is those numbers multiplied and the answer is nearly never.
 *
 * ## Why backwards is a different question, not the same one reversed
 *
 * The asymmetry is in what an unreadable call costs.
 *
 * Forwards, a call this reader cannot place could go **anywhere**, so one of
 * them in one body on the frontier destroys the proof. There is no safe way to
 * over-approximate: "it might call anything" is the whole repository.
 *
 * Backwards, the same unreadable call has a **known caller** and an unknown
 * target. Start at the door and walk *incoming* calls: a call site that might
 * be a call to something already in the set adds exactly **one** routine -- the
 * one it is written in. So the set can be over-approximated at a bounded price,
 * and an over-approximation is sound in the direction that matters: if
 * `S(D)` holds every routine that could possibly reach `D`, then a routine
 * outside `S(D)` provably cannot, whatever this reader failed to read.
 *
 * So this counts, per repository and per language, how big `S(D)` is. Every
 * routine outside it is an arrow that could be called wrong. That share is the
 * ceiling on catching a false arrow, and nobody has ever measured it.
 *
 * ## What goes into S(D), all of it conservative
 *
 * - the door itself
 * - any routine with a call site whose name matches something already in the
 *   set, unless the reader placed that call somewhere else with certainty
 * - **every routine holding a call whose name cannot be read at all** --
 *   `handlers[i]()`, `getattr(obj, name)()`. A call with no name could be a
 *   call to anything, so its routine joins the set and everything reaching it
 *   follows. This is the price of soundness and it is counted separately,
 *   because it is the one input that is not about the door at all.
 *
 * Nothing here uses a type checker: this is the pessimistic reading, tier 1
 * only. Tier 2 would shrink `S(D)` by placing receiver calls that currently
 * match on a name alone, so a good number here is a floor rather than a hope.
 *
 * ## The referee
 *
 * Two, because two different premises carry the result.
 *
 * The load-bearing one is that call sites are **enumerable**: a name this
 * reader never saw is a caller nobody added, and that is the one error that
 * makes an accusation false. `scripts/lib/call-scan.ts` bounds routines by
 * braces or indentation and finds calls by the shape of `name(`, sharing no
 * tree-sitter query and no import resolution with the reader, and the run
 * reports what it saw that the reader did not.
 *
 * The second checks the answer rather than the premise: for a sample of
 * routines the walk placed **outside** `S(D)` -- the ones an accusation would
 * rest on -- each language's own checker is asked "go to definition" at every
 * call in that routine, and any answer landing inside `S(D)` is a false
 * accusation this walk would have made.
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { refereeRoutines, stripNoise } from "./lib/call-scan";
import { checkerFor, type CallChecker } from "./lib/call-receivers";
import { sourceFiles } from "./lib/source-files";

import { callSitesIn, type CallSide } from "../src/engine/calls";
import { readDependencies } from "../src/engine/deps";
import { type ConfigCache } from "../src/engine/resolve";
import { createWorkspace } from "../src/engine/drift";
import { LICENCES } from "../src/engine/licence";
import { outsideCallsIn, type OutsideKind } from "../src/engine/outside";
import { initEngine, languageOf, resetEngineCache, type Language } from "../src/engine/parse";

const HOME = process.env.HOME ?? "/Users/noelmatero";
const argv = process.argv.slice(2);
const option = (name: string) => argv.find((one) => one.startsWith(`--${name}=`))?.slice(name.length + 3);
const showAll = argv.includes("--all");
const only = option("only")?.split(",").filter(Boolean);
/** Routines per language whose outside-S(D) verdict the checker is asked about. */
const sampleSize = Number(option("sample") ?? 120);

const CORPUS = existsSync(path.resolve(".corpus")) ? path.resolve(".corpus") : `${HOME}/board-ai/.corpus`;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|benches|examples|fixtures|testing)(\/|$)|\.(test|spec)\.|(^|\/)test_[^/]*\.py$|_test\.(py|rs)$/;

type Family = "ts" | "python" | "rust";
const familyOf = (language: Language): Family | undefined =>
  language === "ts" || language === "tsx" || language === "js" ? "ts"
    : language === "python" ? "python" : language === "rust" ? "rust" : undefined;

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

/**
 * What the text-scan referee is given, with the two Rust shapes that are not
 * calls taken out first.
 *
 * The scan finds a call by the shape of `name(`, which in Rust also matches
 * inside an attribute -- `#[cfg(any(feature = "std"))]` -- and it does not know
 * that a capitalised callee is a tuple-struct or enum-variant construction.
 * Those two were the whole of the first run's 13.0% "unseen" on anyhow: `cfg`
 * 21, `any` 12, `all` 6, then `Err`, `Ok`, `Some`. Neither is a call node in the
 * grammar, so counting them measured the referee rather than the reader.
 *
 * The capitalised half is filtered where the calls are compared, so it stays
 * visible here; this only blanks attributes, keeping every offset intact.
 */
function refereeInput(source: string, language: Language): string {
  const stripped = stripNoise(source, language);
  if (language !== "rust") return stripped;
  return stripped.replace(/#!?\[[^\n]*\]/g, (text) => " ".repeat(text.length));
}

/* -- one repository's routines and the calls written in them -------------- */

/** A routine, as this walk identifies one. `file` is repo-relative. */
interface Routine {
  id: string;
  file: string;
  name: string;
  line: number;
  language: Language;
  /** Names this routine calls, with where the reader placed each when it could. */
  sites: Array<{ name: string; file?: string; nameAt?: { start: number; end: number } }>;
  /** True when some call here has no readable name, so it could call anything. */
  callsSomethingUnnamed: boolean;
  /** A door: this routine talks to the outside directly. */
  door?: OutsideKind;
}

interface Read {
  routines: Map<string, Routine>;
  /** Every routine that names this name in a call, placed or not. */
  callersOfName: Map<string, Routine[]>;
  /** Routines that could call anything, so they join every set. */
  unnamedCallers: Set<string>;
  /** Call names the referee saw in a routine and the reader did not. */
  refereeUnseen: number;
  refereeSites: number;
}

await initEngine();

function readRepo(repo: Repo): Read {
  const workspace = createWorkspace(repo.dir);
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

  const routines = new Map<string, Routine>();
  const callersOfName = new Map<string, Routine[]>();
  const unnamedCallers = new Set<string>();
  let refereeUnseen = 0;
  let refereeSites = 0;

  for (const absolute of sourceFiles(repo.dir)) {
    const language = languageOf(absolute);
    if (!language || !familyOf(language)) continue;
    const rel = path.relative(repo.dir, absolute);
    if (TEST_PATH.test(rel)) continue;
    const source = read(rel);
    if (source === undefined || source.length > 1_000_000) continue;

    const reading = callSitesIn({ file: rel, source, language, imports: imports(rel, source), open });
    if (!reading.read) continue;

    // Doors, by the reader this benchmark already measured (`measure:doors`).
    const outside = outsideCallsIn(source, language);
    const doorRoutines = new Map<string, OutsideKind>();
    for (const call of outside.calls) {
      if (call.reading.verdict !== "outside" || !call.routine) continue;
      doorRoutines.set(call.routine, call.reading.kind);
    }

    for (const body of reading.bodies) {
      const id = `${rel}#${body.routine}`;
      const routine: Routine = {
        id, file: rel, name: body.routine, line: body.line, language,
        sites: body.sites.map((site) => ({
          name: site.name,
          ...(site.file ? { file: site.file } : {}),
          ...(site.nameAt ? { nameAt: site.nameAt } : {}),
        })),
        callsSomethingUnnamed: body.sites.some((site) => site.name === ""),
        ...(doorRoutines.has(body.routine) ? { door: doorRoutines.get(body.routine)! } : {}),
      };
      /*
       * One name, one entry. Two routines of the same name in one file -- an
       * overload set, two `impl` blocks -- collapse here, which can only make
       * a reached set larger, never smaller, and larger is the safe direction.
       */
      routines.set(id, routine);
      if (routine.callsSomethingUnnamed) unnamedCallers.add(id);
      for (const site of routine.sites) {
        if (!site.name) continue;
        const list = callersOfName.get(site.name) ?? [];
        if (list[list.length - 1]?.id !== id) list.push(routine);
        callersOfName.set(site.name, list);
      }
    }

    /*
     * The premise, refereed: a call site the reader never saw is a caller
     * nobody adds, and that is the one error that makes an accusation false.
     *
     * Compared per **file**, not per routine. The two bound a routine
     * differently -- the scan by braces or indentation, the reader by the
     * grammar -- so a call inside a nested closure lands in the outer routine
     * for one and the inner one for the other. Counting that as an unseen call
     * measures the disagreement about where a routine ends, not about whether
     * the call was read, and the first run reported 25.1% on anyhow almost
     * entirely for that reason. The question backward reach actually rests on
     * is whether the name was seen *anywhere in the file*, because that is what
     * the index is keyed on. Attribution is reported separately below.
     */
    const scanned = refereeRoutines(refereeInput(source, language), language);
    const seenInFile = new Set(reading.bodies.flatMap((body) => body.sites.map((site) => site.name)).filter(Boolean));
    for (const one of scanned) {
      for (const call of one.calls) {
        if (call.construction) continue; // not a call node in any of these grammars
        if (language === "rust" && /^[A-Z]/.test(call.name)) continue; // `Ok(..)`: a constructor
        refereeSites += 1;
        if (!seenInFile.has(call.name)) refereeUnseen += 1;
      }
    }
  }
  resetEngineCache();
  return { routines, callersOfName, unnamedCallers, refereeUnseen, refereeSites };
}

/* -- the backward walk ---------------------------------------------------- */

/**
 * Every routine that could possibly reach `door`, over-approximated on purpose.
 *
 * A call site joins its own routine to the set when the name matches something
 * already in it and the reader did not place that call somewhere else. "Did not
 * place it elsewhere" rather than "placed it here" is the conservative half:
 * an unplaced call to a matching name might be the call, so it counts.
 */
function couldReach(door: Routine, read: Read): { set: Set<string>; fromUnnamed: number } {
  const set = new Set<string>([door.id]);
  // A routine calling something with no name could be calling the door, and so
  // could anything that reaches it. Seeded, then closed over like the rest.
  for (const id of read.unnamedCallers) set.add(id);
  const fromUnnamed = set.size - 1;
  const frontier: Routine[] = [...set].map((id) => read.routines.get(id)!).filter(Boolean);
  while (frontier.length > 0) {
    const current = frontier.pop()!;
    for (const caller of read.callersOfName.get(current.name) ?? []) {
      if (set.has(caller.id)) continue;
      const site = caller.sites.find((one) => one.name === current.name);
      // Placed somewhere that is not this routine's file: certainly not this call.
      if (site?.file !== undefined && site.file !== current.file) continue;
      set.add(caller.id);
      frontier.push(caller);
    }
  }
  return { set, fromUnnamed };
}

/** A stable spread over routine ids: the same sample every run. */
const sampleKey = (id: string) => createHash("sha1").update(id).digest("hex");

/* -- the run -------------------------------------------------------------- */

interface DoorRow {
  repo: string;
  door: string;
  kind: OutsideKind;
  language: Language;
  reaching: number;
  routines: number;
  fromUnnamed: number;
}

const rows: DoorRow[] = [];
const perLanguage = new Map<Family, { doors: number; routines: number; reaching: number; unnamed: number; total: number }>();
const refereeTotals = new Map<string, { seen: number; unseen: number }>();
const outsideSamples: Array<{ repo: Repo; routine: Routine; door: Routine; set: Set<string>; at: Map<string, string> }> = [];

for (const repo of repos) {
  if (repo.state === "missing") continue;
  const read = readRepo(repo);
  const doors = [...read.routines.values()].filter((one) => one.door);
  /*
   * Which routine a declaration line belongs to. The checker answers with a
   * file and a line, and matching only the file says "this call lands in
   * app.py", which every call between two routines of one file satisfies --
   * so the first run of this check reported a false accusation for every
   * sample in flask's `app.py` and none of them was one.
   */
  const at = new Map<string, string>();
  for (const one of read.routines.values()) at.set(`${one.file}:${one.line}`, one.id);
  const key = `${repo.name}`;
  refereeTotals.set(key, { seen: read.refereeSites, unseen: read.refereeUnseen });

  for (const door of doors) {
    const { set, fromUnnamed } = couldReach(door, read);
    const family = familyOf(door.language)!;
    const sameLanguage = [...read.routines.values()].filter((one) => familyOf(one.language) === family);
    rows.push({
      repo: repo.name, door: door.id, kind: door.door!, language: door.language,
      reaching: set.size, routines: sameLanguage.length, fromUnnamed,
    });
    const tally = perLanguage.get(family) ?? { doors: 0, routines: 0, reaching: 0, unnamed: 0, total: 0 };
    tally.doors += 1;
    tally.reaching += set.size;
    tally.unnamed += fromUnnamed;
    tally.total += sameLanguage.length;
    perLanguage.set(family, tally);

    /*
     * Routines an accusation would rest on: outside the set, same language.
     *
     * Spread by a hash of the id rather than taken in walk order, which is the
     * same fixed seed every run and a different routine for every door. Taking
     * the first one instead put every Python sample in `docs/conf.py` -- a
     * Sphinx config outside the package, which pyright does not index, so the
     * check reported nothing for eight doors running and looked like a broken
     * checker rather than a sample of one file.
     */
    const candidates = sameLanguage
      .filter((one) => !set.has(one.id) && one.sites.length > 0)
      .sort((a, b) => sampleKey(a.id).localeCompare(sampleKey(b.id)))
      .slice(0, 3);
    for (const candidate of candidates) outsideSamples.push({ repo, routine: candidate, door, set, at });
  }
}

/* -- the second referee: is "outside the set" actually true? -------------- */

interface Checked { language: Language; wrong: number; asked: number; silent: number; sites: number; answers: number }
const checkedBy = new Map<Family, Checked>();
const falseAccusations: Array<{ routine: string; door: string; landed: string }> = [];

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
      const tally = checkedBy.get(family) ?? { language: one.routine.language, wrong: 0, asked: 0, silent: 0, sites: 0, answers: 0 };
      checkedBy.set(family, tally);
      tally.asked += 1;
      const absolute = path.join(dir, one.routine.file);
      let source: string;
      try { source = readFileSync(absolute, "utf8"); } catch { continue; }
      /*
       * Every call in the routine, asked of the checker. A landing inside the
       * set is a path this walk missed, and an accusation it would have made.
       */
      let answered = false;
      for (const site of one.routine.sites.slice(0, 40)) {
        // The reader's own byte range for the call's name. Searching the text
        // for it instead lands on the first mention in the file -- often the
        // import or the declaration -- and the checker then answers a question
        // nobody asked, which is how the first run got no answers at all.
        if (!site.name || !site.nameAt) continue;
        tally.sites += 1;
        const declared = await checker.definitionAt(absolute, source, site.nameAt);
        if (!declared) continue;
        tally.answers += 1;
        answered = true;
        const rel = path.relative(dir, declared.file);
        // The routine that declaration line opens, not merely its file.
        const landed = one.at.get(`${rel}:${declared.line + 1}`);
        if (landed && one.set.has(landed)) {
          tally.wrong += 1;
          falseAccusations.push({ routine: one.routine.id, door: one.door.id, landed });
          break;
        }
      }
      if (!answered) tally.silent += 1;
    }
    checker.close();
  }
}

/* -- the report ----------------------------------------------------------- */

const percent = (part: number, whole: number) => (whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`);

console.log();
console.log("CORPUS");
for (const repo of repos) console.log(`  ${repo.name.padEnd(24)} ${repo.state}`);

console.log();
console.log("COULD-REACH -- routines that might reach a door, over-approximated so the rest is provable");
console.log("  Every routine OUTSIDE the set is an arrow onto that door that could be called wrong.");
for (const [family, tally] of perLanguage) {
  const averageSet = tally.reaching / tally.doors;
  const averageAll = tally.total / tally.doors;
  console.log(`  ${family.padEnd(7)} ${tally.doors} doors, ${Math.round(averageAll)} routines per repo on average: `
    + `${Math.round(averageSet)} could reach (${percent(averageSet, averageAll)}), `
    + `so ${percent(averageAll - averageSet, averageAll)} of arrows onto a door are refutable`);
  console.log(`  ${" ".padEnd(7)} of those, ${Math.round(tally.unnamed / tally.doors)} joined only because they call `
    + `something with no readable name (${percent(tally.unnamed, tally.reaching)} of the set)`);
}

console.log();
console.log("PER DOOR -- widest first, which is where the walk gives up the most");
for (const row of rows.sort((a, b) => (b.reaching / b.routines) - (a.reaching / a.routines)).slice(0, showAll ? Infinity : 20)) {
  console.log(`  ${percent(row.reaching, row.routines).padStart(6)}  ${String(row.reaching).padStart(5)}/${String(row.routines).padEnd(6)} `
    + `${row.kind.padEnd(8)} ${row.repo}/${row.door}`);
}

console.log();
console.log("THE PREMISE, REFEREED -- call sites the text scan saw in a routine the reader did not");
for (const [repo, tally] of refereeTotals) {
  if (tally.seen === 0) continue;
  console.log(`  ${repo.padEnd(24)} ${tally.unseen} of ${tally.seen} (${percent(tally.unseen, tally.seen)})`);
}

console.log();
console.log("THE ANSWER, REFEREED -- routines the walk placed outside a door's set, checked call by call");
if (checkedBy.size === 0) console.log("  no checker answered.");
for (const [family, tally] of checkedBy) {
  console.log(`  ${family.padEnd(7)} ${tally.asked} routines asked: ${tally.wrong} reach the set after all `
    + `(${percent(tally.wrong, tally.asked)}), ${tally.silent} the checker could not answer for `
    + `-- ${tally.answers} of ${tally.sites} call sites answered (${percent(tally.answers, tally.sites)})`);
}
for (const one of falseAccusations.slice(0, showAll ? Infinity : 10)) {
  console.log(`      ${one.routine} -> ${one.door}: reaches ${one.landed}`);
}
