#!/usr/bin/env node
/**
 * What can a receiver's type be worked out to be from the text alone? (#227)
 *
 *   npm run measure:resolution                 -- this repo, graphify, rust-test,
 *                                                  orangutan, mundane, infrarouter
 *   npm run measure:resolution -- <path>...    -- any trees you like
 *   npm run measure:resolution -- --all        -- every disagreement, not the first few
 *
 * The npm script raises Node's heap to 8 GiB. Section 6 (#226) builds a real
 * `ts.Program` per package in every monorepo tree, and a package the size of
 * one of `mundane`'s -- everything a real app pulls from `node_modules` --
 * has run past the 2 GiB default on its own. Run this file directly with
 * `tsx` instead of through the npm script and that section is the one that
 * crashes, with a heap trace and no other clue why.
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
 *
 * ## Sections 8-9 (#235): Python's version of the #227 -> #230 numbers
 *
 * Everything above answers "what type is this receiver called," through
 * `reveal_type`. It has no opinion on where anything is *declared* -- the
 * question that took TypeScript from item 11's 9.5% (syntax alone) to item
 * 12's 97.8% (a real compiler, no reader gate) and, further, to item 13's
 * 50.3% of whole call bodies closed. `scripts/lib/resolution-python-lsp.ts`
 * asks pyright the same question over LSP (`pyright-langserver --stdio`):
 * `textDocument/typeDefinition` on a receiver for where its *type* is
 * declared (section 8, `typeAt().declaringFile`'s counterpart), and
 * `textDocument/definition` on the method name itself for where the method
 * actually called is declared (section 9's safety check, `symbolDeclarationAt`'s
 * counterpart) -- confirmed against a live server, not assumed from pyright's
 * docs, that both LSP methods answer the way TypeScript's compiler API does.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { createTsReferee } from "./lib/resolution-ts";
import { refereePythonTypes, type ResolutionQuery } from "./lib/resolution-python";
import { createPyrightLspReferee, isOutsideTree as isOutsidePyTree, memberRangeAfter } from "./lib/resolution-python-lsp";
import {
  aliasIndexOf, bareTypeName, createRustAnalyzerReferee, declaredTypeOnLine, isAliasFor,
  isOutsideRustTree, rustMemberRangeAfter,
} from "./lib/resolution-rust-lsp";

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
  /* #246's Rust corpus. `rust-test` above is two crates; these are the pinned
   * repositories `measure:licence` already clones, and the only trees here big
   * enough to say anything about rust-analyzer at real scale. Skipped silently
   * when the corpus has not been cloned, the same as every other tree. */
  `${HOME}/board-ai/.corpus/ripgrep`,
  `${HOME}/board-ai/.corpus/anyhow`,
]).filter((tree) => existsSync(tree)).map(real);

/**
 * `find`, piped through `execFileSync`, silently returned nothing for any
 * tree big enough to overflow its stdout buffer -- `ENOBUFS`, caught by the
 * blanket `catch` below, read as "no files here" rather than "the walk
 * failed." Installing a monorepo's dependencies for the first time (#226)
 * is exactly what pushes a tree over that line: `mundane` alone put 126,371
 * files under `find`'s stdout once its `node_modules` existed, and the whole
 * tree vanished from the corpus with no error printed. Skipping
 * `node_modules` (and friends) *during* the walk, the way
 * `scripts/lib/resolution-ts.ts` and `scripts/lib/licence.ts` already do,
 * never lists those files in the first place -- there is no buffer to
 * overflow because the walk never descends into them.
 */
const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", "target", "dist", "build", "out", "vendor", ".venv", ".claude",
  "coverage", ".next", ".nuxt", ".output", ".turbo", ".yarn", ".cache",
]);

function sourceFiles(root: string): string[] {
  const files: string[] = [];
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
      else if (languageOf(entry) !== undefined) files.push(full);
    }
  };
  walk(root);
  return files;
}

/**
 * The crate roots inside a tree: every directory holding a `Cargo.toml` that no
 * *other* `Cargo.toml` directory already contains. A cargo workspace's members
 * each have their own manifest, and starting a language server per member would
 * index the same workspace once per crate; the shallowest manifest is the one
 * rust-analyzer wants, and it finds the members itself.
 */
function cargoRoots(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    if (existsSync(path.join(directory, "Cargo.toml"))) { found.push(directory); return; }
    let entries: string[];
    try { entries = readdirSync(directory); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith(".") || SKIP_DIRECTORIES.has(entry)) continue;
      const full = path.join(directory, entry);
      try { if (statSync(full).isDirectory()) walk(full); } catch { /* unreadable */ }
    }
  };
  walk(root);
  return found;
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

/**
 * #226's actual open question, not yet asked anywhere: of every receiver, not
 * only the ones tier 1 already named, how many does a real compiler answer?
 * Section 4 above only ever queries the referee about sites tier 1 resolved --
 * it measures tier 1's accuracy, not tier 2's reach. `total` is every ts/tsx/js
 * receiver site in the corpus; `tier1` is how many of those tier 1 already
 * named (matches section 1's ts/tsx/js share); `tier2` is how many the same
 * `tsReferee` used in section 4 answers with something other than
 * any/unknown/error, asked with no gate at all -- `not-a-name` sites included,
 * since a compiler can type an arbitrary expression a bound-name reader
 * cannot. `either` is the ceiling a fallback chain (tier 2, tier 1 when tier 2
 * is unavailable) would actually reach.
 */
interface Tier2Tally { total: number; tier1: number; tier2: number; either: number }
const tier2 = new Map<Language, Tier2Tally>();

/**
 * #235's version of the `tier2` tally above, for Python's declaring-file
 * question rather than TypeScript's. `lsp` is how many of every Python
 * receiver site (tier 1's `reveal_type` gate or not) `typeDeclarationAt`
 * answers with a real file.
 */
interface PyLspCoverage { total: number; tier1: number; lsp: number; either: number }
const pyLspCoverage: PyLspCoverage = { total: 0, tier1: 0, lsp: 0, either: 0 };
let pyLspUnavailable = false;

/**
 * #235's version of item 14: does the type-of-the-receiver question and the
 * what-does-the-method-resolve-to question agree once both answer? Counted
 * only where both `typeDeclarationAt` and `methodDeclarationAt` name
 * something -- one refusing is section 8's coverage gap, not a disagreement.
 */
interface PyLspSafety { agree: number; disagree: number }
const pyLspSafety: PyLspSafety = { agree: 0, disagree: 0 };
interface PyDisagreement { tree: string; file: string; line: number; method: string; typeSaid: string; methodSaid: string }
const pyDisagreements: PyDisagreement[] = [];

/**
 * #246's version of the two tallies above, for Rust. Same two questions, same
 * two columns, one addition Python did not need.
 *
 * `indexable` is that addition. pyright answers about any `.py` file under the
 * root it was given; rust-analyzer answers only about files that belong to a
 * *crate*, and a crate is a `Cargo.toml` away, not a directory away. A tree can
 * hold real Rust that no crate claims -- `rust-test/src` is exactly that, three
 * `.rs` files with no manifest above them -- and rust-analyzer will never
 * resolve a receiver in one, correctly, because there is no crate graph to
 * resolve it against. Folding those into `total` would report a tool limitation
 * as a coverage failure, so both denominators are printed and the report says
 * which is which.
 */
interface RustLspCoverage { total: number; indexable: number; tier1: number; lsp: number; either: number }
const rustLspCoverage: RustLspCoverage = { total: 0, indexable: 0, tier1: 0, lsp: 0, either: 0 };
let rustLspUnavailable = false;
let rustAnalyzerVersion = "";
/** A crate whose server never said it had finished indexing -- see `warmUp`. */
let rustPrimeTimedOut = false;
interface RustLspSafety { agree: number; disagree: number }
const rustLspSafety: RustLspSafety = { agree: 0, disagree: 0 };
interface RustDisagreement {
  tree: string; file: string; line: number; method: string; typeSaid: string; methodSaid: string;
}
const rustDisagreements: RustDisagreement[] = [];

/**
 * The check that replaces the file comparison above, because that one cannot
 * measure wrongness in Rust -- see `declaredTypeOnLine`. Two parts, and the
 * first covers the whole answered population rather than only its
 * disagreements, which is the gap that made a first reading of this
 * measurement claim "0 wrong of 252" on the strength of having inspected 29.
 *
 * `notAType` is the whole-population sanity check: `textDocument/typeDefinition`
 * should always land on a type's own declaration, so an answer whose target
 * line declares no type means the anchor resolved to something that is not a
 * type at all. That is item 17's Python placement bug restated, and it is a
 * real failure whichever file it names.
 *
 * `agreed`/`wrong` is the referee proper, and it is independent in the way
 * `AGENTS.md`'s gate requires: `src/engine/resolution.ts` reads a type *name*
 * out of the text with no compiler involved, and rust-analyzer lands on a
 * declaration whose own line states a name. Two mechanisms sharing nothing,
 * asked the same question. Counted only where both answer -- tier 1 withholding
 * is coverage, not disagreement.
 */
interface RustPlacement {
  answered: number; notAType: number; agreed: number; wrong: number; shapeName: number;
  /** Of `wrong`, the ones that are one type under two names -- see `aliasIndexOf`. */
  aliased: number;
}
const rustPlacement: RustPlacement = {
  answered: 0, notAType: 0, agreed: 0, wrong: 0, shapeName: 0, aliased: 0,
};

/**
 * Names `src/engine/resolution.ts` gives a *shape* rather than a type: an
 * array annotation reads as `Array`, an object literal type as `Object`. Real
 * names in TypeScript, where `Array` is a declared type; in Rust `[T; N]` has
 * no declaration named `Array` for rust-analyzer to land on, so comparing the
 * two is a category error rather than a disagreement. Counted on their own so
 * the referee's number is about answers that could actually match.
 */
const SHAPE_NAMES = new Set(["Array", "Object", "ReadonlyArray"]);

interface RustPlacementCase {
  tree: string; file: string; line: number; ours: string; referee: string; shape: string;
  where: string; aliased: boolean;
}
const rustPlacementWrong: RustPlacementCase[] = [];
const rustNotATypeCases: Array<{ tree: string; file: string; line: number; target: string }> = [];
/** What rust-analyzer landed on, by kind -- `trait` here is worth seeing on its own. */
const rustDeclaredKinds = new Map<string, number>();

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
  /** Every ts/tsx/js receiver site in this tree, resolved or not -- see the
   *  `tier2` tally's own doc for why this is a separate list from `collectedTs`. */
  const collectedTier2: Array<{
    absolute: string; start: number; end: number; tier1Resolved: boolean; language: Language;
  }> = [];
  /** #235's version of `collectedTier2`: every Python receiver site, resolved
   *  or not, plus what `pyLspCoverage`/`pyLspSafety` need that `Collected`
   *  does not carry -- the method name, to find its own byte range later. */
  const collectedPyAll: Array<{
    file: string; absolute: string; line: number; start: number; end: number; method: string; tier1Resolved: boolean;
  }> = [];
  const pySourcesAll = new Map<string, string>();
  /** #246's version of `collectedPyAll`: every Rust receiver site, resolved or not. */
  const collectedRustAll: Array<{
    file: string; absolute: string; line: number; start: number; end: number; method: string;
    tier1Resolved: boolean;
    /** What the syntactic reader named, for the independent referee -- see `rustPlacement`. */
    tier1Type?: string; tier1Shape?: string;
  }> = [];
  const rustSourcesAll = new Map<string, string>();

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
          if (language === "ts" || language === "tsx" || language === "js") {
            collectedTier2.push({
              absolute, start: site.at.start, end: site.at.end,
              tier1Resolved: site.verdict.verdict === "resolved", language,
            });
          }
          if (language === "python") {
            collectedPyAll.push({
              file: rel, absolute, line: site.line, start: site.at.start, end: site.at.end,
              method: site.method, tier1Resolved: site.verdict.verdict === "resolved",
            });
            pySourcesAll.set(rel, source);
          }
          if (language === "rust") {
            collectedRustAll.push({
              file: rel, absolute, line: site.line, start: site.at.start, end: site.at.end,
              method: site.method, tier1Resolved: site.verdict.verdict === "resolved",
              ...(site.verdict.verdict === "resolved"
                ? { tier1Type: site.verdict.evidence.type, tier1Shape: site.verdict.evidence.shape }
                : {}),
            });
            rustSourcesAll.set(rel, source);
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
  if (collectedTs.length > 0 || collectedTier2.length > 0) {
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

      // The tier-2 ceiling: the same compiler, asked with no gate at all --
      // not just the sites tier 1 already resolved. See the `tier2` tally's doc.
      for (const site of collectedTier2) {
        const tally = tier2.get(site.language) ?? { total: 0, tier1: 0, tier2: 0, either: 0 };
        tally.total += 1;
        if (site.tier1Resolved) tally.tier1 += 1;
        const answer = tsReferee.typeAt(site.absolute, site.start, site.end);
        const tier2Resolved = !!answer && answer.head !== "any" && answer.head !== "unknown"
          && !/error/i.test(answer.head);
        if (tier2Resolved) tally.tier2 += 1;
        if (site.tier1Resolved || tier2Resolved) tally.either += 1;
        tier2.set(site.language, tally);
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

  /* ------------------------------------------------------ the referee, Python LSP (#235) */
  if (collectedPyAll.length > 0) {
    let lspReferee: Awaited<ReturnType<typeof createPyrightLspReferee>> | undefined;
    try {
      lspReferee = await createPyrightLspReferee(tree);
    } catch (error) {
      pyLspUnavailable = true;
      console.error(`  pyright LSP referee failed to start on ${path.basename(tree)}: ${(error as Error).message}`);
    }
    if (lspReferee) {
      const startedAt = Date.now();
      const first = collectedPyAll[0]!;
      await lspReferee.warmUp(first.absolute, pySourcesAll.get(first.file)!, first.start);

      /*
       * A progress line, not silence: every other referee in this file
       * answers its whole tree in well under a second, so nothing else here
       * prints until the final report. This one does not -- one LSP round
       * trip per receiver, not one pyright invocation per tree, is the cost
       * of asking a *position* rather than reading a batched diagnostics
       * report (see this file's module doc, sections 8-9). At `graphify`'s
       * own size (22,449 receiver sites) a silent multi-minute wait reads
       * indistinguishably from a hang; `PROGRESS_EVERY` queries is often
       * enough to show it is moving without spamming stderr on a small tree.
       */
      const PROGRESS_EVERY = 200;
      console.error(`  [python-lsp] ${collectedPyAll.length} receiver sites to ask on ${path.basename(tree)}`);
      let asked = 0;
      const CONCURRENCY = 32;
      let cursor = 0;
      async function worker(): Promise<void> {
        for (;;) {
          const i = cursor++;
          if (i >= collectedPyAll.length) return;
          const site = collectedPyAll[i]!;
          asked++;
          if (asked % PROGRESS_EVERY === 0) {
            console.error(`  [python-lsp] ${asked}/${collectedPyAll.length} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
          }
          const source = pySourcesAll.get(site.file)!;
          pyLspCoverage.total += 1;
          if (site.tier1Resolved) pyLspCoverage.tier1 += 1;

          const typeDeclaring = await lspReferee!.typeDeclarationAt(site.absolute, source, site.start, site.end);
          const lspResolved = typeDeclaring !== undefined;
          if (lspResolved) pyLspCoverage.lsp += 1;
          if (site.tier1Resolved || lspResolved) pyLspCoverage.either += 1;

          if (typeDeclaring === undefined) continue;
          const memberRange = memberRangeAfter(source, site.end, site.method);
          if (!memberRange) continue; // a shape `memberRangeAfter` did not expect -- withheld, not guessed at.
          const methodDeclaring = await lspReferee!.methodDeclarationAt(
            site.absolute, source, memberRange.start, memberRange.end,
          );
          if (methodDeclaring === undefined) continue; // section 8's coverage gap, not a disagreement.

          const classify = (file: string) => (isOutsidePyTree(file, tree) ? "external" : path.relative(tree, file));
          const typeSaid = classify(typeDeclaring);
          const methodSaid = classify(methodDeclaring);
          if (typeSaid === methodSaid) {
            pyLspSafety.agree += 1;
          } else {
            pyLspSafety.disagree += 1;
            if (showAll || pyDisagreements.length < 50) {
              pyDisagreements.push({ tree: path.basename(tree), file: site.file, line: site.line, method: site.method, typeSaid, methodSaid });
            }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, collectedPyAll.length) }, worker));
      console.error(`  [python-lsp] done: ${collectedPyAll.length} sites in ${Math.round((Date.now() - startedAt) / 1000)}s`);
      lspReferee.close();
    }
  }

  /* ------------------------------------------------------ the referee, Rust LSP (#246) */
  if (collectedRustAll.length > 0) {
    /*
     * One server per crate root, not per tree. See `cargoRoots`: rust-analyzer
     * resolves against a crate graph, so a receiver in a file no `Cargo.toml`
     * claims has no answer available to it at all -- counted in `total`,
     * excluded from `indexable`, and never asked.
     */
    const roots = cargoRoots(tree);
    /* One scan per tree, not per disagreement -- an alias may be declared in a
     * file that holds no receiver site of its own. */
    const aliases = aliasIndexOf(sourceFiles(tree)
      .filter((one) => languageOf(path.basename(one)) === "rust")
      .map((one) => { try { return readFileSync(one, "utf8"); } catch { return ""; } }));
    const sitesByRoot = new Map<string, typeof collectedRustAll>();
    for (const site of collectedRustAll) {
      rustLspCoverage.total += 1;
      const owner = roots
        .filter((one) => site.absolute === one || site.absolute.startsWith(one + path.sep))
        .sort((a, b) => b.length - a.length)[0];
      if (!owner) continue; // real Rust that no crate claims -- see `RustLspCoverage`.
      rustLspCoverage.indexable += 1;
      const list = sitesByRoot.get(owner) ?? [];
      list.push(site);
      sitesByRoot.set(owner, list);
    }

    for (const [root, sites] of sitesByRoot) {
      let rustReferee: Awaited<ReturnType<typeof createRustAnalyzerReferee>> | undefined;
      try {
        rustReferee = await createRustAnalyzerReferee(root);
      } catch (error) {
        rustLspUnavailable = true;
        console.error(`  rust-analyzer referee failed to start on ${path.basename(root)}: ${(error as Error).message}`);
      }
      if (!rustReferee) {
        // Not asked is not the same as asked and refused: these sites stay in
        // `total` and `indexable` but must not be counted as coverage misses.
        rustLspCoverage.indexable -= sites.length;
        continue;
      }
      if (!rustAnalyzerVersion) rustAnalyzerVersion = rustReferee.version();
      const startedAt = Date.now();
      // Waits for rust-analyzer's own "done indexing" notification. Asking
      // before it arrives is what made this measurement's first reading swing
      // between 68.7% and 13.6% on identical input.
      await rustReferee.warmUp();
      if (!rustReferee.primedCleanly()) {
        rustPrimeTimedOut = true;
        console.error(`  [rust-lsp] ${path.basename(root)} never reported finished indexing`
          + " -- its answers are not trustworthy and are reported separately");
      }

      const PROGRESS_EVERY = 200;
      console.error(`  [rust-lsp] ${sites.length} receiver sites to ask on ${path.relative(tree, root) || path.basename(root)}`);
      let asked = 0;
      const CONCURRENCY = 32;
      let cursor = 0;
      async function worker(): Promise<void> {
        for (;;) {
          const i = cursor++;
          if (i >= sites.length) return;
          const site = sites[i]!;
          asked++;
          if (asked % PROGRESS_EVERY === 0) {
            console.error(`  [rust-lsp] ${asked}/${sites.length} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
          }
          const source = rustSourcesAll.get(site.file)!;
          if (site.tier1Resolved) rustLspCoverage.tier1 += 1;

          const declaringLocation = await rustReferee!.typeDeclarationLocationAt(
            site.absolute, source, site.start, site.end,
          );
          const typeDeclaring = declaringLocation?.file;
          const lspResolved = typeDeclaring !== undefined;
          if (lspResolved) rustLspCoverage.lsp += 1;
          if (site.tier1Resolved || lspResolved) rustLspCoverage.either += 1;

          if (typeDeclaring === undefined || declaringLocation === undefined) continue;

          /*
           * The placement check, over every answered site rather than only the
           * ones the file comparison below happens to flag. See `rustPlacement`.
           */
          rustPlacement.answered += 1;
          const targetLine = (() => {
            try { return readFileSync(declaringLocation.file, "utf8").split("\n")[declaringLocation.line] ?? ""; }
            catch { return ""; }
          })();
          const declared = declaredTypeOnLine(targetLine);
          if (!declared) {
            rustPlacement.notAType += 1;
            if (showAll || rustNotATypeCases.length < 50) {
              rustNotATypeCases.push({
                tree: path.basename(tree), file: site.file, line: site.line,
                target: `${path.relative(tree, declaringLocation.file)}:${declaringLocation.line + 1} ${targetLine.trim().slice(0, 70)}`,
              });
            }
          } else {
            bump(rustDeclaredKinds, declared.kind);
            if (site.tier1Type && SHAPE_NAMES.has(site.tier1Type)) {
              rustPlacement.shapeName += 1;
            } else if (site.tier1Type) {
              if (bareTypeName(site.tier1Type) === declared.name) rustPlacement.agreed += 1;
              else {
                rustPlacement.wrong += 1;
                const aliased = isAliasFor(site.tier1Type, declared.name, aliases);
                if (aliased) rustPlacement.aliased += 1;
                if (showAll || rustPlacementWrong.length < 100) {
                  rustPlacementWrong.push({
                    tree: path.basename(tree), file: site.file, line: site.line,
                    ours: site.tier1Type, referee: `${declared.kind} ${declared.name}`,
                    shape: site.tier1Shape ?? "?",
                    where: `${path.relative(tree, declaringLocation.file)}:${declaringLocation.line + 1}`,
                    aliased,
                  });
                }
              }
            }
          }
          const memberRange = rustMemberRangeAfter(source, site.end, site.method);
          if (!memberRange) continue; // a shape the scan did not expect -- withheld, not guessed at.
          const methodDeclaring = await rustReferee!.methodDeclarationAt(
            site.absolute, source, memberRange.start, memberRange.end,
          );
          if (methodDeclaring === undefined) continue; // a coverage gap, not a disagreement.

          const classify = (file: string) => (isOutsideRustTree(file, tree) ? "external" : path.relative(tree, file));
          const typeSaid = classify(typeDeclaring);
          const methodSaid = classify(methodDeclaring);
          if (typeSaid === methodSaid) {
            rustLspSafety.agree += 1;
          } else {
            rustLspSafety.disagree += 1;
            if (showAll || rustDisagreements.length < 200) {
              rustDisagreements.push({
                tree: path.basename(tree), file: site.file, line: site.line,
                method: site.method, typeSaid, methodSaid,
              });
            }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sites.length) }, worker));
      console.error(`  [rust-lsp] done: ${sites.length} sites in ${Math.round((Date.now() - startedAt) / 1000)}s`);
      rustReferee.close();
    }
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

console.log("6 · TIER 2 CEILING -- what a real compiler answers, asked at every receiver (ts/tsx/js)");
console.log();
console.log("  Not gated on tier 1: every receiver site is asked, `not-a-name` included -- a");
console.log("  compiler can type an arbitrary expression a bound-name reader cannot. Section 4");
console.log("  above measures tier 1's accuracy where it already had an opinion; this measures");
console.log("  tier 2's reach where tier 1 had none, which is the number #226 needs before tier");
console.log("   2 is more than a recommendation with no ceiling attached to it.");
console.log();
console.log("  " + "language".padEnd(10) + "receivers".padStart(11) + "tier1".padStart(15)
  + "tier2".padStart(15) + "combined".padStart(15));
const tier2All: Tier2Tally = { total: 0, tier1: 0, tier2: 0, either: 0 };
const cell = (count: number, whole: number) => `${String(count).padStart(6)} ${percent(count, whole)}`;
for (const language of ["ts", "tsx", "js"] as Language[]) {
  const tally = tier2.get(language);
  if (!tally) continue;
  tier2All.total += tally.total; tier2All.tier1 += tally.tier1;
  tier2All.tier2 += tally.tier2; tier2All.either += tally.either;
  console.log("  " + language.padEnd(10) + String(tally.total).padStart(11)
    + cell(tally.tier1, tally.total).padStart(15) + cell(tally.tier2, tally.total).padStart(15)
    + cell(tally.either, tally.total).padStart(15));
}
if (tier2All.total > 0) {
  console.log("  " + "all".padEnd(10) + String(tier2All.total).padStart(11)
    + cell(tier2All.tier1, tier2All.total).padStart(15) + cell(tier2All.tier2, tier2All.total).padStart(15)
    + cell(tier2All.either, tier2All.total).padStart(15));
}
console.log();

console.log("7 · WHAT THIS ANSWERS");
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
if (tier2All.total > 0) {
  console.log(`  Tier 2 (ts/tsx/js): ${percent(tier2All.tier2, tier2All.total).trim()} of receivers answer from`);
  console.log(`  the compiler alone, no reader gate, vs ${percent(tier2All.tier1, tier2All.total).trim()} tier 1 reaches on the`);
  console.log(`  same population. Combined ceiling: ${percent(tier2All.either, tier2All.total).trim()}.`);
  console.log();
}

console.log("8 · PYTHON DECLARING FILE -- pyright's LSP, asked at every receiver (#235)");
console.log();
console.log("  Not \"what type is this\" (sections 1-4) -- \"where is that type's own");
console.log("  declaration.\" `textDocument/typeDefinition`, asked at every receiver, `not-a-name`");
console.log("  included, the same no-gate shape as section 6's ts/tsx/js tier2 tally. This is");
console.log("  Python's version of the number that took TypeScript from syntax alone to a real compiler.");
console.log();
if (pyLspCoverage.total > 0) {
  console.log("  " + "receivers".padStart(11) + "tier1".padStart(15) + "lsp".padStart(15) + "combined".padStart(15));
  console.log("  " + String(pyLspCoverage.total).padStart(11)
    + cell(pyLspCoverage.tier1, pyLspCoverage.total).padStart(15)
    + cell(pyLspCoverage.lsp, pyLspCoverage.total).padStart(15)
    + cell(pyLspCoverage.either, pyLspCoverage.total).padStart(15));
} else {
  console.log("  No Python receiver sites in this corpus.");
}
if (pyLspUnavailable) {
  console.log();
  console.log("  The LSP referee failed to start on at least one tree -- see stderr above.");
}
console.log();

console.log("9 · PYTHON SAFETY CHECK -- does the receiver's type and the method actually");
console.log("    called agree on where they live? (#235's version of TypeScript's own safety check)");
console.log();
console.log("  Restricted to sites where BOTH questions answered -- one refusing is section 8's");
console.log("  coverage gap, not a disagreement here. `external` counts as one answer regardless");
console.log("  of which typeshed file it names, the same collapse `isOutsideTree` already makes");
console.log("  for TypeScript.");
console.log();
const pySafetyTotal = pyLspSafety.agree + pyLspSafety.disagree;
if (pySafetyTotal > 0) {
  console.log(`  ${pySafetyTotal} sites checked, ${pyLspSafety.disagree} disagreed `
    + `(${percent(pyLspSafety.disagree, pySafetyTotal).trim()}).`);
  if (pyDisagreements.length > 0) {
    console.log();
    for (const one of pyDisagreements.slice(0, cap(pyDisagreements.length))) {
      console.log(`    ${one.tree}/${one.file}:${one.line} .${one.method}(...) -- receiver's type says `
        + `${one.typeSaid}, the method itself says ${one.methodSaid}`);
    }
    if (pyDisagreements.length > cap(pyDisagreements.length)) {
      console.log(`    ... and ${pyDisagreements.length - cap(pyDisagreements.length)} more`);
    }
  }
} else {
  console.log("  No site had both questions answered -- nothing to check yet.");
}
console.log();

console.log("10 · RUST DECLARING FILE -- rust-analyzer's LSP, asked at every receiver (#246)");
console.log();
console.log("  Section 8's question, asked of Rust. `textDocument/typeDefinition` at every");
console.log("  receiver, `not-a-name` included, no tier-1 gate.");
console.log();
console.log("  Two denominators, because rust-analyzer needs a crate and pyright needs only a");
console.log("  directory: `receivers` is every Rust receiver in the corpus, `in a crate` is the");
console.log("  ones under a Cargo.toml. A receiver in a loose .rs file has no crate graph to");
console.log("  resolve against and is a fact about the corpus, not a miss by the tool.");
console.log();
if (rustLspCoverage.total > 0) {
  const base = rustLspCoverage.indexable;
  console.log("  " + "receivers".padStart(11) + "in a crate".padStart(15)
    + "tier1".padStart(15) + "lsp".padStart(15) + "combined".padStart(15));
  console.log("  " + String(rustLspCoverage.total).padStart(11)
    + cell(rustLspCoverage.indexable, rustLspCoverage.total).padStart(15)
    + cell(rustLspCoverage.tier1, base).padStart(15)
    + cell(rustLspCoverage.lsp, base).padStart(15)
    + cell(rustLspCoverage.either, base).padStart(15));
  console.log();
  console.log("  tier1/lsp/combined are shares of `in a crate`, not of `receivers`.");
  if (rustAnalyzerVersion) console.log(`  rust-analyzer ${rustAnalyzerVersion}`);
} else {
  console.log("  No Rust receiver sites in this corpus.");
}
if (rustLspUnavailable) {
  console.log();
  console.log("  The rust-analyzer referee failed to start on at least one crate -- see stderr");
  console.log("  above. Those sites are excluded from `in a crate` rather than counted as misses.");
}
if (rustPrimeTimedOut) {
  console.log();
  console.log("  At least one crate never reported that it had finished indexing, so its");
  console.log("  answers were collected without the readiness gate this measurement depends on.");
  console.log("  Treat the numbers above as a lower bound, not a reading.");
}
console.log();

console.log("11 · RUST SAFETY CHECK -- does the receiver's type and the method actually");
console.log("     called agree on where they live? (#246's version of sections 9 and 14)");
console.log();
console.log("  Restricted to sites where BOTH questions answered. `external` collapses the");
console.log("  standard library, a registry dependency, and anything under `target/` into one");
console.log("  answer, the same collapse `isOutsideTree` already makes for the other two languages.");
console.log();
const rustSafetyTotal = rustLspSafety.agree + rustLspSafety.disagree;
if (rustSafetyTotal > 0) {
  console.log(`  ${rustSafetyTotal} sites checked, ${rustLspSafety.disagree} disagreed `
    + `(${percent(rustLspSafety.disagree, rustSafetyTotal).trim()}).`);
  if (rustDisagreements.length > 0) {
    console.log();
    for (const one of rustDisagreements.slice(0, cap(rustDisagreements.length))) {
      console.log(`    ${one.tree}/${one.file}:${one.line} .${one.method}(...) -- receiver's type says `
        + `${one.typeSaid}, the method itself says ${one.methodSaid}`);
    }
    if (rustDisagreements.length > cap(rustDisagreements.length)) {
      console.log(`    ... and ${rustDisagreements.length - cap(rustDisagreements.length)} more`);
    }
  }
} else {
  console.log("  No site had both questions answered -- nothing to check yet.");
}
console.log();

console.log("12 · RUST PLACEMENT -- did it land on the right type? (#246's real wrongness check)");
console.log();
console.log("  The check above compares files, and Rust splits a type from its methods across");
console.log("  files as a matter of course, so a disagreement there says nothing about whether");
console.log("  the answer is right. What does not split is the type's identity, so this checks");
console.log("  that instead -- and over every answered site, not only the flagged ones.");
console.log();
if (rustPlacement.answered > 0) {
  console.log(`  Answered sites: ${rustPlacement.answered}`);
  console.log();
  console.log("  a) Did it land on a type declaration at all? An answer that is not a type's own");
  console.log("     declaration means the anchor resolved to something else entirely.");
  console.log(`     not a type declaration: ${rustPlacement.notAType} `
    + `(${percent(rustPlacement.notAType, rustPlacement.answered).trim()})`);
  for (const one of rustNotATypeCases.slice(0, cap(rustNotATypeCases.length))) {
    console.log(`       ${one.tree}/${one.file}:${one.line} -> ${one.target}`);
  }
  console.log();
  console.log("     What it landed on, by kind:");
  for (const [kind, count] of [...rustDeclaredKinds.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`       ${kind.padEnd(8)} ${String(count).padStart(6)}`);
  }
  console.log();
  console.log("  b) Does it name the same type the syntactic reader read from the text? The two");
  console.log("     share no machinery -- `resolution.ts` reads a name, rust-analyzer resolves a");
  console.log("     declaration -- which is what makes this a referee and not a second opinion.");
  const placementChecked = rustPlacement.agreed + rustPlacement.wrong;
  if (placementChecked > 0) {
    console.log(`     ${placementChecked} sites where both named a type, `
      + `${rustPlacement.wrong} disagreed (${percent(rustPlacement.wrong, placementChecked).trim()}).`);
    console.log(`     Set aside, not counted either way: ${rustPlacement.shapeName} where the reader`);
    console.log("     named a shape (`Array`) rather than a type -- see SHAPE_NAMES.");
    console.log();
    console.log(`     This checks ${placementChecked} of ${rustPlacement.answered} answered sites `
      + `(${percent(placementChecked, rustPlacement.answered).trim()}), and that is a ceiling, not`);
    console.log("     an oversight: an independent check needs the syntactic reader to have named");
    console.log("     a type too, and it names one for about a fifth of receivers. The rest have an");
    console.log("     answer with nothing independent to weigh it against. Asking rust-analyzer a");
    console.log("     second way does not fix that -- `hover` at the same position resolves through");
    console.log("     the same aliases and agrees by construction, confirmed live.");
    console.log();
    const unexplained = rustPlacement.wrong - rustPlacement.aliased;
    console.log("  c) Of the disagreements, how many are one type under two names? A type alias");
    console.log("     (`type Range = Match;`) or an import rename: rust-analyzer resolves through");
    console.log("     both and never reports the local name, while the reader reports what the");
    console.log("     text says. Not a misread -- but the two names do live in different files,");
    console.log("     and a board points at a file, so this is reported rather than discounted.");
    console.log(`     alias or rename: ${rustPlacement.aliased} of ${rustPlacement.wrong}`
      + ` (${percent(rustPlacement.aliased, rustPlacement.wrong).trim()} of disagreements)`);
    console.log(`     everything else:  ${unexplained} `
      + `-- ${percent(unexplained, placementChecked).trim()} of sites checked`);
    console.log("     That second figure is the one comparable to the other languages' bars; the");
    console.log("     first is a naming difference this measurement cannot call an error.");
    if (rustPlacementWrong.length > 0) {
      console.log();
      for (const one of rustPlacementWrong.slice(0, cap(rustPlacementWrong.length))) {
        console.log(`       ${one.tree}/${one.file}:${one.line} [${one.shape}] we said `
          + `${one.ours}, it landed on ${one.referee} (${one.where})`
          + `${one.aliased ? " -- alias/rename" : ""}`);
      }
      if (rustPlacementWrong.length > cap(rustPlacementWrong.length)) {
        console.log(`       ... and ${rustPlacementWrong.length - cap(rustPlacementWrong.length)} more`);
      }
    }
  } else {
    console.log("     No site had both a syntactic type name and an answer -- nothing to check.");
  }
} else {
  console.log("  No answered Rust sites -- nothing to check.");
}
console.log();
