#!/usr/bin/env node
/**
 * Re-check "+ resolved calls buys 1.4%" against `reach.ts` (#203, #271).
 *
 *   npm run measure:dataflow-reach              -- the seven default trees
 *   npm run measure:dataflow-reach -- <path>... -- any trees you like
 *
 * #203's third section resolves a callee by **name** -- declared in this file,
 * imported from a file this repository holds, or forwarded through one barrel --
 * reads the callee's body, and asks whether the argument gets out. Over the
 * corpus it freed 370 values, 1.4%, and #203 concluded from that number that
 * the next thing to build is not a bigger call graph.
 *
 * Since then `reach.ts` shipped a real interprocedural walk that places calls
 * that resolver cannot. So the question is whether 1.4% was a fact about
 * crossing a call boundary or a fact about a weak resolver. This asks it, and
 * the two halves of the answer are different in kind.
 *
 * ## Half one: the sites the reader records and the resolver refuses
 *
 * `settleCalls` gives up on a call with `callee-not-resolved`, 64.2% of the
 * calls that still trap a value. Some of those `callSitesIn` places. Each one
 * it places is a call the escape analysis could have followed and did not, so
 * this is straightforward headroom -- and it is measured against the *same*
 * resolver the report uses, imported rather than reimplemented
 * (`scripts/lib/dataflow-index.ts`), because a copy drifting by one rule would
 * answer this question with its own bugs.
 *
 * ## Half two: the sites the reader never records, which is the larger thing
 *
 * `calleeName` in `dataflow.ts` answers for a bare name and for `self.foo()` /
 * `this.foo()`, and returns nothing for any other receiver. `body.calls` is
 * only appended to `if (callee)`. So `store.keep(v)` makes `v` escape
 * `passed-to-a-call` and writes **no call site at all** -- `settleCalls` never
 * sees a call to resolve, and the value is a permanent exit no resolver can
 * reach. `callee-is-a-method` is a member of the `Unresolved` union that the
 * report has never once printed, because the site never arrives to be refused.
 *
 * That means 1.4% is not "what crossing a call boundary is worth". It is what
 * crossing a call boundary is worth *for bare calls*, and the values whose only
 * call-shaped exit is a method call were never in the population at all. This
 * counts them.
 *
 * ## What a placement may be spent on, which is the actual answer
 *
 * `reach.ts` places a method call by reading the receiver's type out of the text
 * (`resolveReceiversIn`), and it is explicit that this is licenced for
 * **confirmation only**. `blocking()` makes any receiver site whose type is not
 * known to be a *concrete* class a doubt, so the `never` verdict is withheld on
 * it: the method reached at runtime can live on a different class than the one
 * the declared type names. A confirmation resting on a misread type is still a
 * confirmation; an accusation resting on one is a false red.
 *
 * The escape analysis is a refutation -- "this value never left this body" is an
 * absence offered as proof. So the number that answers #203 is not "how many
 * more calls does `reach.ts` place". It is "how many more does it place that a
 * refutation may rest on", which is the `refutation-safe` column below.
 * Quoting the other column would be buying the 1.4% back with exactly the move
 * `reach.ts` refuses to make.
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { indexOf } from "./lib/dataflow-index";
import { sourceFiles } from "./lib/source-files";

import { callSitesIn, EXTERNAL_RECEIVER, type CallSide, type CallSitePlaced } from "../src/engine/calls";
import { readDependencies } from "../src/engine/deps";
import { createWorkspace } from "../src/engine/drift";
import { initEngine, languageOf, type Language } from "../src/engine/parse";
import { blocking, textReceivers } from "../src/engine/reach";
import { type ConfigCache } from "../src/engine/resolve";

await initEngine();

const HOME = process.env.HOME ?? "";
const roots = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));

/** The same seven trees `measure:dataflow` reads, so the two numbers compare. */
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

/* Half one: call sites the reader records, by what each resolver did. */
const recorded = new Map<Language, number>();
const byName = new Map<Language, number>();
/** The resolver refused and `callSitesIn` placed the name to a file. */
const reachOnly = new Map<Language, number>();
/**
 * And a routine of that name is actually in that file -- the real headroom.
 *
 * Placing the *name* is not enough and the difference is not pedantic. The
 * escape analysis has to read the callee's **body**, and `callSitesIn` answers
 * the file a name is bound in, which for a local variable holding a function is
 * the calling file itself: `convert.ts:37` calls `getConverter`, a local bound
 * from a dynamic `import()` of the vendor bundle, and the site places to
 * `convert.ts` where no such routine is declared. Counting that as headroom
 * would have reported a resolver gain that cannot be spent.
 */
const reachOnlyRoutine = new Map<Language, number>();
/** Of those, the ones a refutation may rest on -- `blocking()` says. */
const reachOnlySafe = new Map<Language, number>();
const neither = new Map<Language, number>();
/** A site the reader records that `callSitesIn` has no matching site for. */
const unmatched = new Map<Language, number>();
const reachOnlyWhere = new Map<string, number>();
const reachOnlyExamples: string[] = [];

/* Half two: values whose call-shaped exit is a call the reader cannot name. */
const passedValues = new Map<Language, number>();
/** At least one of the calls it went to has an empty callee. */
const passedUnnamed = new Map<Language, number>();
/**
 * No site at all, which is what this measurement first found and is now the
 * regression check rather than the finding: it should be ~0.
 */
const passedNoSite = new Map<Language, number>();
const passedUnnamedExamples: string[] = [];

let files = 0;
let bodiesRead = 0;

for (const tree of trees) {
  const index = indexOf(tree);
  const workspace = createWorkspace(tree);
  const configs: ConfigCache = new Map();
  const importsCache = new Map<string, CallSide["imports"]>();

  const importsFor = (rel: string): CallSide["imports"] => {
    const cached = importsCache.get(rel);
    if (cached) return cached;
    const source = index.read(rel);
    const declared = source === undefined
      ? []
      : readDependencies(rel, source, workspace, configs)?.dependencies ?? [];
    const list = declared.map((one) =>
      ({ specifier: one.specifier, ...(one.file ? { file: one.file } : {}) }));
    importsCache.set(rel, list);
    return list;
  };

  /** The opener `reach.ts` walks other files with. */
  const open = (file: string): { source: string; language: Language; imports: CallSide["imports"] } | undefined => {
    const source = index.read(file);
    const language = languageOf(file);
    if (source === undefined || !language || source.length > 400_000) return undefined;
    return { source, language, imports: importsFor(file) };
  };

  for (const file of sourceFiles(tree)) {
    const language = languageOf(file);
    if (!language) continue;
    const rel = path.relative(tree, file);
    const source = index.read(rel);
    if (source === undefined || source.length > 400_000) continue;

    // The reader's own bodies, so the population is exactly the report's.
    const bodies = index.bodiesFor(rel).filter((body) => body.scope === "routine");
    if (bodies.length === 0) continue;
    files += 1;

    const side: CallSide = {
      file: rel,
      source,
      language,
      imports: importsFor(rel),
      open,
      // Exactly what `reach.ts` wires into every file on its own walk.
      resolveReceiver: textReceivers(source, language),
    };
    const reading = callSitesIn(side);
    if (!reading.read) continue;

    /* Placed sites, by routine and line, so a recorded call can find its own. */
    const placed = new Map<string, CallSitePlaced[]>();
    for (const body of reading.bodies) {
      for (const site of body.sites) {
        const key = `${body.routine}\u0000${site.line}\u0000${site.name}`;
        const list = placed.get(key);
        if (list) list.push(site);
        else placed.set(key, [site]);
      }
    }

    const resolve = index.resolver(rel);

    for (const body of bodies) {
      bodiesRead += 1;

      /* -- half one: the sites the reader records -- */
      for (const call of body.calls) {
        if (!call.callee) continue;
        bump(recorded, language);
        const site = placed.get(`${body.routine}\u0000${call.line}\u0000${call.callee}`)?.[0];
        const resolved = resolve(call.callee);
        if (resolved) { bump(byName, language); continue; }
        if (!site) { bump(unmatched, language); continue; }
        if (!site.file) { bump(neither, language); continue; }
        bump(reachOnly, language);
        // A body to read, on the same standard the name resolver holds itself to.
        const there = site.file === EXTERNAL_RECEIVER
          ? []
          : index.bodiesFor(site.file).filter((one) => one.routine === call.callee);
        const readable = there.length === 1;
        if (readable) {
          bump(reachOnlyRoutine, language);
          if (!blocking(site)) bump(reachOnlySafe, language);
        }
        bump(reachOnlyWhere, site.file === EXTERNAL_RECEIVER
          ? "placed outside the repository -- no body to read"
          : !readable ? "placed in a repository file, but no one routine of that name there"
            : blocking(site) ? "a body to read, confirmation only"
              : "a body to read, refutation-safe");
        if (readable && reachOnlyExamples.length < 12) {
          reachOnlyExamples.push(
            `${rel}:${call.line} ${body.routine} -> ${call.callee} (${site.file})`
            + (blocking(site) ? "  confirmation only" : ""),
          );
        }
      }

      /* -- half two: values the reader wrote no site for -- */
      const handedTo = new Set<string>();
      const handedToUnnamed = new Set<string>();
      for (const call of body.calls) {
        for (const name of call.passed) {
          handedTo.add(name);
          if (!call.callee) handedToUnnamed.add(name);
        }
      }
      for (const local of body.locals) {
        if (local.why) continue;
        if (!local.escapes.includes("passed-to-a-call")) continue;
        bump(passedValues, language);
        if (!handedTo.has(local.name)) { bump(passedNoSite, language); continue; }
        if (!handedToUnnamed.has(local.name)) continue;
        bump(passedUnnamed, language);
        if (passedUnnamedExamples.length < 12) {
          passedUnnamedExamples.push(`${rel}:${local.line} ${body.routine} / ${local.name}`);
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
console.log("MEASURE DATAFLOW x REACH -- re-checking #203's 1.4% against the real call graph");
console.log(`  ${trees.length} trees, ${files} files, ${bodiesRead} routine bodies`);
console.log("  Call sites placed by `callSitesIn` with `reach.ts`'s own receiver resolver");
console.log("  wired in, beside the name resolver `measure:dataflow` section 3 uses --");
console.log("  imported from the same module, not reimplemented.");
console.log("");

console.log("1 - THE SITES THE READER RECORDS, and what each resolver did with them");
console.log("");
console.log("  " + "language".padEnd(10) + "sites".padStart(8) + "by name".padStart(9)
  + "name placed".padStart(13) + "body there".padStart(12) + "refut-safe".padStart(12)
  + "neither".padStart(9) + "no site".padStart(9));
for (const language of LANGUAGES) {
  const sites = recorded.get(language) ?? 0;
  if (sites === 0) continue;
  console.log("  " + language.padEnd(10) + String(sites).padStart(8)
    + String(byName.get(language) ?? 0).padStart(9)
    + String(reachOnly.get(language) ?? 0).padStart(13)
    + String(reachOnlyRoutine.get(language) ?? 0).padStart(12)
    + String(reachOnlySafe.get(language) ?? 0).padStart(12)
    + String(neither.get(language) ?? 0).padStart(9)
    + String(unmatched.get(language) ?? 0).padStart(9));
}
console.log("  " + "all".padEnd(10) + String(total(recorded)).padStart(8)
  + String(total(byName)).padStart(9) + String(total(reachOnly)).padStart(13)
  + String(total(reachOnlyRoutine)).padStart(12)
  + String(total(reachOnlySafe)).padStart(12) + String(total(neither)).padStart(9)
  + String(total(unmatched)).padStart(9));
console.log("");
console.log(`  reach places the name on ${total(reachOnly)} of the `
  + `${total(recorded) - total(byName)} sites the name resolver refuses, and on`);
console.log(`  ${total(reachOnlyRoutine)} of those there is one routine of that name to read `
  + `(${share(total(reachOnlyRoutine), total(recorded) - total(byName))} of the refusals).`);
console.log(`  ${total(reachOnlySafe)} of those may carry a refutation.`);
console.log("");
console.log("  `name placed` minus `body there` is the gap that looks like headroom and is");
console.log("  not: a name bound to a local holding a function places to the calling file,");
console.log("  where no such routine is declared.");
console.log("");
console.log("  `no site` is this measurement's own edge, not a reader defect: the two");
console.log("  readers name a routine differently in places, so a recorded call finds no");
console.log("  site to compare against. Counted rather than dropped.");
if (total(reachOnly) > 0) {
  console.log("");
  for (const [where, count] of [...reachOnlyWhere].sort((a, b) => b[1] - a[1])) {
    console.log("    " + where.padEnd(48) + String(count).padStart(6));
  }
  console.log("");
  for (const one of reachOnlyExamples) console.log("    " + one);
}

console.log("");
console.log("2 - THE VALUES NO RESOLVER CAN REACH, because the call cannot be named");
console.log("");
console.log("  " + "language".padEnd(10) + "passed to a call".padStart(18)
  + "to an unnamed one".padStart(19) + "share".padStart(8) + "no site".padStart(9));
for (const language of LANGUAGES) {
  const all = passedValues.get(language) ?? 0;
  if (all === 0) continue;
  const unnamed = passedUnnamed.get(language) ?? 0;
  console.log("  " + language.padEnd(10) + String(all).padStart(18)
    + String(unnamed).padStart(19) + share(unnamed, all).padStart(8)
    + String(passedNoSite.get(language) ?? 0).padStart(9));
}
console.log("  " + "all".padEnd(10) + String(total(passedValues)).padStart(18)
  + String(total(passedUnnamed)).padStart(19)
  + share(total(passedUnnamed), total(passedValues)).padStart(8)
  + String(total(passedNoSite)).padStart(9));
console.log("");
console.log("  A value handed to at least one call whose callee this reader cannot name --");
console.log("  `store.keep(v)`, `os.replace(v, p)`. `calleeName` answers for a bare name");
console.log("  and for `self.foo()` / `this.foo()` and nothing else, so there is no name to");
console.log("  look up and the call refuses as `callee-is-a-method`. Counted, which is the");
console.log("  change: it used to be recorded nowhere and so absent from the question in");
console.log("  the numerator and the denominator alike.");
console.log("");
console.log("  `no site` is a value the reader sees go to a call and cannot attribute to a");
console.log("  parameter *position*, which is a different limit and not the one above. It is");
console.log("  overwhelmingly a spread: `emit(...read)` records the call with `args=[-]`,");
console.log("  because `...read` may arrive as no parameters, one, or many, and which");
console.log("  position a value came in at is exactly what makes a call resolvable. Where");
console.log("  the spread goes into a modelled collection -- `names.push(...read)` -- there");
console.log("  is no site at all, because that branch is the collection write and returns");
console.log("  before one is made. Undecidable rather than unwritten, so it is named here");
console.log("  and not fixed.");
if (passedUnnamedExamples.length > 0) {
  console.log("");
  for (const one of passedUnnamedExamples) console.log("    " + one);
}

console.log("");
console.log("3 - WHAT THIS SAYS ABOUT THE 1.4%");
console.log("");
console.log(`  Refused sites where reach places the name:         ${total(reachOnly)}`);
console.log(`  ... and a routine of that name is there to read:    ${total(reachOnlyRoutine)}`);
console.log(`  ... and a refutation may rest on it:               ${total(reachOnlySafe)}`);
console.log(`  Values whose exit is a call that cannot be named:  ${total(passedUnnamed)}`);
console.log(`  Values with no site recorded at all:              ${total(passedNoSite)}`);
console.log("");
console.log("  The first two bound what `reach.ts` could add to section 3 as it stands.");
console.log("  Anything reach places that is not refutation-safe, it places for");
console.log("  confirmation only; spending that on an accusation is the false red");
console.log("  `licence.ts` exists to stop, and `blocking()` is `reach.ts` refusing to.");
console.log("");
console.log("  The third number is not headroom for a resolver at all. It is the");
console.log("  population that refuses as `callee-is-a-method`, and no call graph reaches");
console.log("  it: naming `x.foo()` needs the type of `x`, and resting a *refutation* on a");
console.log("  type read out of the text is what `blocking()` refuses. The fourth number");
console.log("  is the regression check, and it is the one that used to be the third.");
console.log("");
