#!/usr/bin/env node
/**
 * What can a receiver's type be worked out to be from the text alone? (#227)
 *
 *   npm run measure:resolution                 -- this repo, graphify, rust-test,
 *                                                  orangutan, mundane, infrarouter
 *   npm run measure:resolution -- <path>...    -- any trees you like
 *   npm run measure:resolution -- --all        -- every disagreement, not the first few
 *
 * **A measurement. No word ships from it and nothing here is wired into
 * `drift.ts` or `claim.ts`.** Sub-issue of #226, which found the wall: the
 * engine has no notion of a value's type, and #221 found the cost of that --
 * `receiver` (`x.foo()`, where the text never says what `x` is) is the sole
 * reason 28.8% of otherwise-open call bodies stay open, more than every other
 * reason combined. This measures how much of that a *syntactic* reader closes
 * on its own, before anything decides whether a real type checker (tier 2:
 * pyright, tsc, rust-analyzer) is a nice-to-have or a hard requirement.
 *
 * ## The referee
 *
 * Required, and it is the whole reason this is a measurement rather than a
 * prototype. `scripts/lib/resolution-ts.ts` asks the TypeScript compiler what
 * it thinks the same receiver is, at the same position; `scripts/lib/
 * resolution-python.ts` asks pyright the same question through `reveal_type`.
 * Three columns, and the third is the only one that matters:
 *
 *     AGREED     resolver and checker name the same type
 *     REFUSED    the checker itself has no real opinion either -- not a failure
 *     WRONG      resolver named a type and the checker names a different one  <- bar is zero
 *
 * Rust has no comparable harness here (#227 says so plainly) and is reported
 * on the two columns it can support -- resolved and withheld -- rather than
 * against an invented referee.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { createTsReferee } from "./lib/resolution-ts";
import { refereePythonTypes, type ResolutionQuery } from "./lib/resolution-python";

import { createWorkspace } from "../src/engine/drift";
import { initEngine, languageOf, type Language } from "../src/engine/parse";
import {
  resolveReceiversIn, shapeDisagreementsIn,
  type ResolutionShape, type ResolutionWithheld,
} from "../src/engine/resolution";

await initEngine();

const HOME = process.env.HOME ?? "/Users/noelmatero";
const flags = new Set(process.argv.slice(2).filter((one) => one.startsWith("--")));
const roots = process.argv.slice(2).filter((one) => !one.startsWith("--"));
const showAll = flags.has("--all");
const cap = (count: number) => (showAll ? count : Math.min(count, 12));

const real = (tree: string) => { try { return realpathSync(tree); } catch { return tree; } };

/* Same corpus `measure:closed-bodies` and `measure:calls` read, so #221's
 * numbers and this measurement's are about the same population. */
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
const bump = <K,>(map: Map<K, number>, key: K, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const bumpNested = <K,>(map: Map<Language, Map<K, number>>, language: Language, key: K) => {
  const inner = map.get(language) ?? new Map<K, number>();
  bump(inner, key);
  map.set(language, inner);
};

/* ------------------------------------------------------------------ tallies */

const files = new Map<Language, number>();
const receiverSites = new Map<Language, number>();
const resolvedCount = new Map<Language, number>();
const byShape = new Map<Language, Map<ResolutionShape, number>>();
const byWithheld = new Map<Language, Map<ResolutionWithheld, number>>();
const disagreementCount = new Map<Language, number>();
const disagreementExamples: Array<{ tree: string; file: string; line: number; name: string; annotation: string; construction: string }> = [];

interface RefereeTally { agreed: number; refused: number; wrong: number }
const referee = new Map<Language, RefereeTally>();
interface WrongCase { tree: string; file: string; line: number; ours: string; referee: string; shape: ResolutionShape }
const wrongCases: WrongCase[] = [];
const unrefereedLanguages = new Set<Language>();

/** Resolved sites collected per tree, so the referee can be asked once per tree. */
interface Collected {
  file: string; absolute: string; line: number; start: number; end: number;
  type: string; shape: ResolutionShape; language: Language;
}

for (const tree of trees) {
  const workspace = createWorkspace(tree);
  const collectedTs: Collected[] = [];
  const collectedPy: Collected[] = [];
  const pySources = new Map<string, string>();

  for (const file of sourceFiles(tree)) {
    const rel = path.relative(tree, file);
    const language = languageOf(rel);
    if (!language) continue;
    const absolute = workspace.resolve(rel);
    if (!absolute || workspace.stat(absolute) !== "file") continue;
    let source: string;
    try { source = workspace.read(absolute); } catch { continue; }
    bump(files, language);

    const reading = resolveReceiversIn(source, language);
    if (reading.read) {
      for (const routine of reading.routines) {
        for (const site of routine.sites) {
          bump(receiverSites, language);
          if (site.verdict.verdict === "resolved") {
            bump(resolvedCount, language);
            bumpNested(byShape, language, site.verdict.evidence.shape);
            const collected: Collected = {
              // The call site's own line, for the referee -- `reveal_type`
              // has to be inserted where the receiver is *used*, not where
              // its type was declared. Using the evidence's line here put the
              // insertion above the binding itself for every shape where the
              // two differ, which is most of them, and pyright correctly
              // reported the name as unbound at that point instead of naming
              // its type -- a bug in this harness, not a disagreement.
              file: rel, absolute, line: site.line,
              start: site.at.start, end: site.at.end,
              type: site.verdict.evidence.type, shape: site.verdict.evidence.shape, language,
            };
            if (language === "ts" || language === "tsx" || language === "js") collectedTs.push(collected);
            else if (language === "python") { collectedPy.push(collected); pySources.set(rel, source); }
          } else {
            bumpNested(byWithheld, language, site.verdict.why);
          }
        }
      }
    }

    const disagreements = shapeDisagreementsIn(source, language);
    if (disagreements.length > 0) {
      bump(disagreementCount, language, disagreements.length);
      for (const one of disagreements.slice(0, 3)) {
        disagreementExamples.push({ tree: path.basename(tree), file: rel, ...one });
      }
    }
  }

  /* --------------------------------------------------------- the referee, TS */
  if (collectedTs.length > 0) {
    let tsReferee;
    try {
      tsReferee = createTsReferee(tree);
    } catch (error) {
      unrefereedLanguages.add("ts");
      tsReferee = undefined;
    }
    if (tsReferee) {
      for (const site of collectedTs) {
        const tally = referee.get(site.language) ?? { agreed: 0, refused: 0, wrong: 0 };
        const answer = tsReferee.typeAt(site.absolute, site.start, site.end);
        if (!answer || answer.head === "any" || answer.head === "unknown" || /error/i.test(answer.head)) {
          tally.refused += 1;
        } else if (answer.head === site.type) {
          tally.agreed += 1;
        } else {
          tally.wrong += 1;
          wrongCases.push({
            tree: path.basename(tree), file: site.file, line: site.line,
            ours: site.type, referee: answer.head, shape: site.shape,
          });
        }
        referee.set(site.language, tally);
      }
    }
  }

  /* ---------------------------------------------------------- the referee, Python */
  if (collectedPy.length > 0) {
    const queries: ResolutionQuery[] = collectedPy.map((site, index) => ({
      id: `${site.file}#${index}`, file: site.file, line: site.line, start: site.start, end: site.end,
    }));
    let answers;
    try {
      answers = refereePythonTypes(tree, pySources, queries);
    } catch (error) {
      unrefereedLanguages.add("python");
      answers = new Map();
      console.error(`  pyright referee failed on ${path.basename(tree)}: ${(error as Error).message}`);
    }
    collectedPy.forEach((site, index) => {
      const tally = referee.get("python") ?? { agreed: 0, refused: 0, wrong: 0 };
      const answer = answers.get(`${site.file}#${index}`);
      if (!answer || answer.head === "Unknown" || /error/i.test(answer.head)) {
        tally.refused += 1;
      } else if (answer.head === site.type) {
        tally.agreed += 1;
      } else {
        tally.wrong += 1;
        wrongCases.push({
          tree: path.basename(tree), file: site.file, line: site.line,
          ours: site.type, referee: answer.head, shape: site.shape,
        });
      }
      referee.set("python", tally);
    });
  }
}

/* -------------------------------------------------------------------- report */

const percent = (part: number, whole: number) =>
  whole === 0 ? "   n/a" : `${((part / whole) * 100).toFixed(1)}%`.padStart(6);
const total = (map: Map<Language, number>) => [...map.values()].reduce((a, b) => a + b, 0);

console.log();
console.log("MEASURE RESOLUTION -- what can a receiver's type be worked out to be from the text alone? (#227)");
console.log(`  ${trees.length} trees, ${total(files)} files read`);
console.log("  Every `x.foo()` and `self.field.foo()` in the corpus, resolved to a type or");
console.log("  withheld with a named reason. Nothing here accuses -- see the module doc.");
console.log();

console.log("1 · RECEIVERS RESOLVED -- of every x.foo() in the corpus, what share names its type");
console.log();
console.log("  " + "language".padEnd(10) + "receivers".padStart(11) + "resolved".padStart(10) + "  share");
for (const language of LANGUAGES) {
  const all = receiverSites.get(language) ?? 0;
  if (all === 0) continue;
  const got = resolvedCount.get(language) ?? 0;
  console.log("  " + language.padEnd(10) + String(all).padStart(11) + String(got).padStart(10)
    + "  " + percent(got, all).padStart(8));
}
console.log("  " + "all".padEnd(10) + String(total(receiverSites)).padStart(11)
  + String(total(resolvedCount)).padStart(10) + "  " + percent(total(resolvedCount), total(receiverSites)).padStart(8));
console.log();

console.log("2 · BY SHAPE -- which of #227's table pays, and how much");
console.log();
for (const language of LANGUAGES) {
  const shapes = byShape.get(language);
  if (!shapes || shapes.size === 0) continue;
  console.log(`  ${language}:`);
  for (const [shape, count] of [...shapes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${shape.padEnd(20)} ${String(count).padStart(6)}`);
  }
}
console.log();

console.log("3 · REFUSALS BY REASON, named and counted");
console.log();
for (const language of LANGUAGES) {
  const reasons = byWithheld.get(language);
  if (!reasons || reasons.size === 0) continue;
  const withheldTotal = [...reasons.values()].reduce((a, b) => a + b, 0);
  console.log(`  ${language} (${withheldTotal} withheld):`);
  for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason.padEnd(20)} ${String(count).padStart(6)}  ${percent(count, withheldTotal).trim()}`);
  }
}
console.log();

console.log("4 · THE REFEREE -- does a real type checker agree?");
console.log();
console.log("  " + "language".padEnd(10) + "agreed".padStart(9) + "refused".padStart(10) + "wrong".padStart(9) + "  wrong share");
for (const language of ["ts", "tsx", "js", "python"] as Language[]) {
  const tally = referee.get(language);
  if (!tally) continue;
  const askedOf = tally.agreed + tally.refused + tally.wrong;
  console.log("  " + language.padEnd(10) + String(tally.agreed).padStart(9) + String(tally.refused).padStart(10)
    + String(tally.wrong).padStart(9) + "  " + percent(tally.wrong, askedOf).padStart(10));
}
console.log();
console.log("  Rust has no comparable referee here (#227 says so plainly) -- reported on the");
console.log("  two columns it can support, section 1 and section 3, rather than against one");
console.log("  invented for the occasion.");
console.log();
if (unrefereedLanguages.size > 0) {
  console.log(`  Referee unavailable for: ${[...unrefereedLanguages].join(", ")} on at least one tree`
    + " -- see stderr above.");
  console.log();
}

if (wrongCases.length > 0) {
  console.log(`  WRONG -- the number that has to be read and explained, not just printed: ${wrongCases.length}`);
  for (const one of wrongCases.slice(0, cap(wrongCases.length))) {
    console.log(`    ${one.tree}/${one.file}:${one.line} [${one.shape}] we said ${one.ours}, referee said ${one.referee}`);
  }
  if (wrongCases.length > cap(wrongCases.length)) {
    console.log(`    ... and ${wrongCases.length - cap(wrongCases.length)} more`);
  }
  console.log();
}

console.log("5 · SHAPE DISAGREEMENT -- `const x: Base = new Child()` has two true answers");
console.log();
for (const language of LANGUAGES) {
  const count = disagreementCount.get(language) ?? 0;
  if (count === 0) continue;
  console.log(`  ${language}: ${count} bindings where the annotation and the construction name different types`);
}
if (disagreementExamples.length > 0) {
  console.log();
  for (const one of disagreementExamples.slice(0, cap(disagreementExamples.length))) {
    console.log(`    ${one.tree}/${one.file}:${one.line} ${one.name} -- annotated ${one.annotation}, constructed ${one.construction}`);
  }
}
console.log("  The main verdict prefers the annotation (see `classify` in `resolution.ts`);");
console.log("  this is the count of times that preference actually chose between two answers");
console.log("  that were both true, rather than confirming one and ignoring the other.");
console.log();

console.log("6 · WHAT THIS ANSWERS");
console.log();
const headline = percent(total(resolvedCount), total(receiverSites));
console.log(`  ${headline.trim()} of receiver call sites in this corpus resolve from the text alone,`);
console.log(`  no type checker involved. That is the number #226's tier-2 decision rests on:`);
console.log("  the higher this is, reading the text is most of the way there and a real");
console.log("  checker is an upgrade; the lower it is, tier 2 is closer to a hard requirement.");
console.log();
const wrongTotal = [...referee.values()].reduce((a, b) => a + b.wrong, 0);
const askedTotal = [...referee.values()].reduce((a, b) => a + b.agreed + b.refused + b.wrong, 0);
console.log(`  Against a real type checker: ${wrongTotal} wrong of ${askedTotal} checked `
  + `(${percent(wrongTotal, askedTotal).trim()}). ${wrongTotal === 0 ? "Zero -- every checked answer this reader gave a real checker also gives." : "Read every WRONG case above before trusting this reader's evidence rules."}`);
console.log();
