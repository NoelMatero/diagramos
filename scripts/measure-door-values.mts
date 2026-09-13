#!/usr/bin/env node
/**
 * Can "does this value reach a door?" be built on the reader we have? (#203)
 *
 *   npm run measure:door-values              -- the seven default trees
 *   npm run measure:door-values -- <path>... -- any trees you like
 *
 * #270 enumerated the doors -- the calls that touch files, the network and
 * other processes (`outside.ts`) -- and answered the *routine* version of the
 * question with a backward walk, at 0 false "never" on 90 real paths. The
 * value version is the obvious next slice, and it is the one #203 keeps
 * arriving at:
 *
 *   > This value is created here. Does it ever reach something that writes it
 *   > to a file, sends it over the network, or hands it to another process?
 *
 * Before building that on `dataflow.ts`, one thing has to be true: the reader
 * has to record a call site for the door, so a value can be watched going
 * through it.
 *
 * The first run of this said it usually did not, and that was the finding.
 * `calleeName` answers for a bare name and for `self.foo()` / `this.foo()`, and
 * `body.calls` was appended to `if (callee)`, so a door written on a receiver
 * was recorded nowhere: ts 206 of 239 doors had a site and **python 16 of
 * 127**, because Python spells almost every one `os.replace`, `shutil.rmtree`,
 * `subprocess.run`. A question asking "does this value ever reach a door" would
 * have answered **no** for a value handed straight out of one -- an accusation
 * from a blind spot, about the one shape the question exists to catch.
 *
 * The site is now recorded with an empty callee. That is enough, and the reason
 * is the useful part: **the door question does not need the name.**
 * `outside.ts` knows `os.replace` is a door from the *import*, not from
 * resolving a callee, so an unnameable site is still a place to watch. What was
 * missing was the site, not the name.
 *
 * So this now reports two columns that used to be one: whether a site exists at
 * all, which is what the door question rests on, and whether the reader could
 * also name it, which is what the *escape* question needs and still cannot get
 * for a receiver.
 *
 * `writes` is the half that matters most. A door that only *reads* -- `open(p)`,
 * `stat(f)` -- takes a path and hands nothing out, so a value reaching one is
 * not the leak the question is about. A door call that takes an argument the
 * body holds is.
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { indexOf } from "./lib/dataflow-index";
import { sourceFiles } from "./lib/source-files";

import { initEngine, languageOf, type Language } from "../src/engine/parse";
import { outsideCallsIn, type OutsideKind } from "../src/engine/outside";

await initEngine();

const HOME = process.env.HOME ?? "";
const roots = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));

/** The same seven trees the other dataflow measurements read. */
const trees = roots.length > 0 ? roots : [
  path.resolve("src"),
  path.resolve("scripts"),
  path.resolve("rust-test"),
  `${HOME}/orangutan`,
  `${HOME}/board-ai/graphify/graphify`,
  `${HOME}/mundane`,
  `${HOME}/infrarouter`,
].filter((tree) => existsSync(tree));

const bump = <K,>(map: Map<K, number>, key: K, by = 1) =>
  map.set(key, (map.get(key) ?? 0) + by);

/** Door calls found by `outside.ts`, and whether the reader wrote a site down. */
const doors = new Map<Language, number>();
const doorsInRoutine = new Map<Language, number>();
const doorsWithSite = new Map<Language, number>();
/** Of those, the ones the reader could also put a name to. */
const doorsNamed = new Map<Language, number>();
const doorsByKind = new Map<OutsideKind, number>();
const doorsWithSiteByKind = new Map<OutsideKind, number>();
/** The door's own spelling, so the shape that is missed is nameable. */
const missedQualified = new Map<string, number>();
const missedExamples: string[] = [];
const foundExamples: string[] = [];

let files = 0;

for (const tree of trees) {
  const index = indexOf(tree);

  for (const file of sourceFiles(tree)) {
    const language = languageOf(file);
    if (!language) continue;
    const rel = path.relative(tree, file);
    const source = index.read(rel);
    if (source === undefined || source.length > 400_000) continue;

    const outside = outsideCallsIn(source, language);
    if (!outside.read) continue;
    const open = outside.calls.filter((call) => call.reading.verdict === "outside");
    if (open.length === 0) continue;
    files += 1;

    const bodies = index.bodiesFor(rel).filter((body) => body.scope === "routine");
    /*
     * Every call the reader recorded, by routine and line, and whether it could
     * put a name to it.
     *
     * The name is what the door question does *not* need, which is the point.
     * `outside.ts` already knows `os.replace` is a door, from the import rather
     * than from resolving anything -- so a site with an empty callee is still a
     * place a value can be watched going out. What matters is that a site exists
     * at all: before #203's change there was none for a qualified call, and a
     * value handed through one went out unwatched.
     */
    const recorded = new Map<string, { named: Set<string>; unnamed: number }>();
    for (const body of bodies) {
      for (const call of body.calls) {
        const key = `${body.routine}\u0000${call.line}`;
        const at = recorded.get(key) ?? { named: new Set<string>(), unnamed: 0 };
        if (call.callee) at.named.add(call.callee);
        else at.unnamed += 1;
        recorded.set(key, at);
      }
    }

    for (const call of open) {
      if (call.reading.verdict !== "outside") continue;
      const { kind, qualified } = call.reading;
      bump(doors, language);
      bump(doorsByKind, kind);
      /*
       * Only a door written inside a named routine can be compared: the reader's
       * escape half reads routines and nothing else, so a door at a file's top
       * level is outside the population either way.
       */
      if (!call.routine) continue;
      bump(doorsInRoutine, language);

      // The door's own last segment is the name a bare call site would carry.
      const member = qualified.split(".").pop() ?? qualified;
      const at = recorded.get(`${call.routine}\u0000${call.line}`);
      const named = at?.named.has(member) === true;
      if (named || (at?.unnamed ?? 0) > 0) {
        bump(doorsWithSite, language);
        bump(doorsWithSiteByKind, kind);
        if (named) bump(doorsNamed, language);
        if (foundExamples.length < 8) {
          foundExamples.push(`${rel}:${call.line} ${call.routine} -> ${qualified}`
            + (named ? "" : "  (site recorded, callee unnamed)"));
        }
      } else {
        bump(missedQualified, qualified);
        if (missedExamples.length < 14) {
          missedExamples.push(`${rel}:${call.line} ${call.routine} -> ${qualified}`);
        }
      }
    }
  }
}

const LANGUAGES: Language[] = ["rust", "ts", "tsx", "python", "js"];
const total = (map: Map<Language, number>) =>
  LANGUAGES.reduce((sum, language) => sum + (map.get(language) ?? 0), 0);
const share = (part: number, whole: number) =>
  whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;

console.log("");
console.log("MEASURE DOOR VALUES -- can a value-level door question rest on this reader?");
console.log(`  ${trees.length} trees, ${files} files holding at least one door`);
console.log("  Doors from `outside.ts` (#270). Call sites from `dataflow.ts` (#210).");
console.log("");

console.log("1 - DOES THE READER RECORD A CALL SITE FOR THE DOOR?");
console.log("");
console.log("  " + "language".padEnd(10) + "doors".padStart(8) + "in a routine".padStart(14)
  + "site recorded".padStart(15) + "share".padStart(8) + "of those, named".padStart(17));
for (const language of LANGUAGES) {
  const all = doors.get(language) ?? 0;
  if (all === 0) continue;
  const inRoutine = doorsInRoutine.get(language) ?? 0;
  const withSite = doorsWithSite.get(language) ?? 0;
  console.log("  " + language.padEnd(10) + String(all).padStart(8)
    + String(inRoutine).padStart(14) + String(withSite).padStart(15)
    + share(withSite, inRoutine).padStart(8)
    + String(doorsNamed.get(language) ?? 0).padStart(17));
}
console.log("  " + "all".padEnd(10) + String(total(doors)).padStart(8)
  + String(total(doorsInRoutine)).padStart(14) + String(total(doorsWithSite)).padStart(15)
  + share(total(doorsWithSite), total(doorsInRoutine)).padStart(8)
  + String(total(doorsNamed)).padStart(17));
console.log("");
console.log("  A door with no call site is a door the reader cannot see a value go");
console.log("  through, so a value handed straight out of one would read as never having");
console.log("  reached it. `named` is the narrower question the escape half needs and the");
console.log("  door question does not: which routine the call goes to.");

console.log("");
console.log("2 - BY WHAT THE DOOR TOUCHES");
console.log("");
console.log("  " + "kind".padEnd(10) + "doors".padStart(8) + "site recorded".padStart(15)
  + "share".padStart(8));
for (const kind of ["file", "network", "process"] as OutsideKind[]) {
  const all = doorsByKind.get(kind) ?? 0;
  if (all === 0) continue;
  console.log("  " + kind.padEnd(10) + String(all).padStart(8)
    + String(doorsWithSiteByKind.get(kind) ?? 0).padStart(15)
    + share(doorsWithSiteByKind.get(kind) ?? 0, all).padStart(8));
}

console.log("");
console.log("3 - THE DOORS WITH NO SITE, by how they are spelled");
console.log("");
for (const [qualified, count] of [...missedQualified].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log("    " + qualified.padEnd(34) + String(count).padStart(6));
}
console.log("");
console.log("  What is left is the handle shape -- `f.write(row)`, where `f` came back");
console.log("  from `open()`. `outside.ts` does not call that a door at all (it reads as");
console.log("  a method on a value, not a module), so it is outside this population");
console.log("  rather than missed inside it. Knowing `f` is a file needs a type.");
if (missedExamples.length > 0) {
  console.log("");
  console.log("  MISSED");
  for (const one of missedExamples) console.log("    " + one);
}
if (foundExamples.length > 0) {
  console.log("");
  console.log("  RECORDED -- read these too, not only the misses");
  for (const one of foundExamples) console.log("    " + one);
}
console.log("");
