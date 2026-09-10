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
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { refereeRoutines, stripNoise } from "./lib/call-scan";
import { resolvePythonReceivers } from "./lib/resolution-python-live";
import { resolveRustReceivers } from "./lib/resolution-rust-receivers";
import { createTsReferee } from "./lib/resolution-ts";

import {
  callSitesIn, EXTERNAL_RECEIVER, type BodyCallSites, type CallSide, type ReceiverResolution,
} from "../src/engine/calls";
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
  /* #256's Rust scale. `rust-test` above is two crates and 8 files, which says
   * nothing about rust-analyzer's reach at size; these are the pinned
   * repositories `measure:licence` clones and `measure:resolution` already
   * reads for the same reason. Skipped silently when the corpus has not been
   * cloned, the same as every other tree. They carry no TypeScript and no
   * Python, so item 13's own figures are unaffected by their being here. */
  `${HOME}/board-ai/.corpus/ripgrep`,
  `${HOME}/board-ai/.corpus/anyhow`,
]).filter((tree) => existsSync(tree)).map(real);

/**
 * Prunes while walking rather than listing then filtering -- `execFileSync`d
 * `find` piped to a JS filter threw `ENOBUFS` and lost a whole tree silently
 * (a blanket `catch` read the crash as "no files here") the moment
 * `measure-resolution.mts` hit the same bug on this same corpus (#226): a
 * monorepo with real dependencies installed is enough files that `find`'s
 * stdout overflows the default buffer. This never lists `node_modules` in the
 * first place, so there is no buffer to overflow.
 */
const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", "target", "dist", "build", "out", "vendor", ".venv", ".claude",
  "coverage", ".next", ".nuxt", ".output", ".turbo", ".yarn", ".cache",
]);

function sourceFiles(root: string): string[] {
  const found: string[] = [];
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
      else if (languageOf(entry) !== undefined) found.push(full);
    }
  };
  walk(root);
  return found;
}

const LANGUAGES: Language[] = ["rust", "ts", "tsx", "python", "js"];

/**
 * Whether a type's own declaration, an absolute path the compiler names,
 * sits outside this tree entirely -- a language builtin (`lib.*.d.ts`, itself
 * inside some `node_modules/typescript`) or a package's own declaration file.
 * Checked by path rather than by name: `Assertion` from `vitest` and a
 * repository's own `Assertion` class print identically, and only where they
 * are actually declared tells the two apart.
 */
function isOutsideTree(declaringFile: string, tree: string): boolean {
  if (declaringFile.includes(`${path.sep}node_modules${path.sep}`)) return true;
  const rel = path.relative(tree, declaringFile);
  return rel.startsWith("..") || path.isAbsolute(rel);
}

/* ------------------------------------------------------------------ the run */

/** Body-size bands, because a one-liner closing is not the finding a big one is. */
const BANDS = [
  { name: "1-5 lines", least: 1, most: 5 },
  { name: "6-15 lines", least: 6, most: 15 },
  { name: "16-50 lines", least: 16, most: 50 },
  { name: "51+ lines", least: 51, most: Number.POSITIVE_INFINITY },
];

const bump = <K,>(map: Map<K, number>, key: K, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

/**
 * #233's cost for one body: a closed body carrying a placement whose type is
 * not concrete is withheld by `callsBetween` rather than accused from, so this
 * is the refusal that guard actually spends. The closure test is re-asked here
 * rather than threaded out of `bumpClosure` -- a body only spends the cost if
 * `callsBetween` would otherwise have been free to accuse from it.
 */
function bumpGuardCost(body: BodyCallSites, language: Language): void {
  const isClosed = body.sites.length > 0 && body.sites.every((one) => !one.why);
  if (isClosed && body.sites.some((one) => one.receiver && one.concrete === false)) {
    bump(closedBlockedByGuard, language);
  }
}

/**
 * The closure/blocker tally section 1 and 2 compute inline for the baseline
 * reading, factored out so the tier-2 reading (#226) counts the same way
 * without repeating it -- the two numbers have to mean the same thing or the
 * comparison is meaningless.
 */
function bumpClosure(
  bodiesRead: BodyCallSites[], language: Language,
  bodiesMap: Map<Language, number>, closedMap: Map<Language, number>,
  calllessMap: Map<Language, number>, openMap: Map<Language, number>,
  soleMap: Map<Language, Map<string, number>>, anyMap: Map<Language, Map<string, number>>,
  /** Per *site*, not per body -- the unit `resolverAnswers` counts in, so the
   *  two can be compared directly instead of comparing a body count against
   *  a query count and calling it a check. */
  siteReasonMap: Map<Language, Map<string, number>>,
): void {
  for (const body of bodiesRead) {
    bump(bodiesMap, language);
    const blocking = body.sites.filter((one) => one.why);
    const isClosed = body.sites.length > 0 && blocking.length === 0;
    if (body.sites.length === 0) bump(calllessMap, language);
    else if (isClosed) bump(closedMap, language);
    else bump(openMap, language);

    // Receiver sites only -- a bare, unimported `foo()` can land in the same
    // `unbound`/`unplaced` buckets and has nothing to do with a resolver.
    const perSite = siteReasonMap.get(language) ?? new Map<string, number>();
    for (const site of blocking) { if (site.receiver) bump(perSite, site.why!); }
    siteReasonMap.set(language, perSite);

    if (blocking.length > 0) {
      const reasons = new Set(blocking.map((one) => one.why!));
      const perAny = anyMap.get(language) ?? new Map<string, number>();
      for (const reason of reasons) bump(perAny, reason);
      anyMap.set(language, perAny);
      if (reasons.size === 1) {
        const per = soleMap.get(language) ?? new Map<string, number>();
        bump(per, [...reasons][0]!);
        soleMap.set(language, per);
      }
    }
  }
}

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

/**
 * #226's follow-up, named in `docs/claim-vocabulary.md` when #221's
 * recommendation was reaffirmed: does a real checker close what syntax
 * alone could not? The same `resolveReceiver` reading run a second time with
 * tier 2 wired in as the receiver resolver -- every tally below has the same
 * meaning as its untagged twin above, just counted on that second reading.
 *
 * ts/tsx/js when this was written, because TypeScript was the only language
 * with a tier-2 resolver then. Python got one at #235/#243 and Rust at #246,
 * and #256 is the same question asked of both -- so item 13's 50.3% stops
 * being the figure steering three languages from a measurement of one.
 */
const bodiesTier2 = new Map<Language, number>();
const closedTier2 = new Map<Language, number>();
const calllessTier2 = new Map<Language, number>();
const openTier2 = new Map<Language, number>();
const soleBlockerTier2 = new Map<Language, Map<string, number>>();
const anyBlockerTier2 = new Map<Language, Map<string, number>>();
const TIER2_LANGUAGES = new Set<Language>(["ts", "tsx", "js", "python", "rust"]);
/** The two whose resolver answers over a language server, so the reading is a
 *  record-then-resolve pair rather than one synchronous pass. */
const LSP_TIER2_LANGUAGES = new Set<Language>(["python", "rust"]);

/**
 * What each language-server resolver cost and could not reach, for the honesty
 * the issue asks for by name: a low closed share has to be readable as the
 * resolver's reach rather than as the reader failing.
 */
interface LspRun {
  language: Language;
  tree: string;
  /** Receiver queries the reader asked, before any were answered. */
  asked: number;
  /** Distinct queries, since the reader asks about one site once per reading. */
  distinct: number;
  started: boolean;
  /** Seconds the resolver spent, so the runtime cost is on the record. */
  seconds: number;
  /** Rust only: queries in a file no `Cargo.toml` claims, never asked. */
  unclaimed?: number;
  /** Rust only: answers whose declaration line names no type (#246's `notAType`). */
  notATypeDeclaration?: number;
  /** Rust only: a type spelled as a path (`String::new()`), never asked. */
  pathReceiver?: number;
  /** Rust only: a receiver `rustTypeAnchorFor` would place no cursor in, never asked. */
  anchorWithheld?: number;
  /** Python only: answers withheld because their line declares no type (#259). */
  withheldNoType?: number;
  /** Rust only: false when a server never said it had finished indexing. */
  primedCleanly?: boolean;
}
const lspRuns: LspRun[] = [];

/**
 * What `resolveReceiver` actually answered, every query, no correlation
 * needed after the fact -- counted right where the answer is decided,
 * which is the fix for the imprecise line-matching an earlier session's
 * probe used and got wrong on its very first sample.
 */
interface ResolverTally { type: number; declared: number; external: number; none: number }
const resolverAnswers = new Map<Language, ResolverTally>();
/** Per-site (not per-body) reason tally for the tier-2 reading -- the same
 *  unit `resolverAnswers` counts in. */
const siteReasonTier2 = new Map<Language, Map<string, number>>();

/**
 * The safety measurement this whole feature needs before anything may
 * accuse on it (AGENTS.md's gate): of every receiver call this session's
 * `declared`/`external`/`type` mechanism actually *placed*, how often does
 * an independent question -- `getSymbolAtLocation` on the method itself,
 * not `getTypeAtLocation` on the receiver -- land somewhere else?
 *
 * Not fully independent, and said so rather than overclaimed: both the
 * placement and this check ultimately ask the same compiler, so a shape
 * neither one can see (the concrete class behind an interface-typed
 * receiver, decided only at runtime) will not show up as WRONG here even
 * though it is a real gap. What this *does* catch is everything else --
 * a plumbing bug in this session's own node-finding or path conversion,
 * an inherited method the receiver's declared type does not itself carry,
 * an overload resolving to a different signature than the one assumed.
 */
interface PlacementTally { agreed: number; wrong: number; refused: number }
const placementReferee = new Map<Language, PlacementTally>();
interface PlacementWrong { tree: string; file: string; line: number; placed: string; referee: string }
const placementWrongCases: PlacementWrong[] = [];

/**
 * #233's cost: of the bodies tier 2 finds closed, how many carry at least one
 * `declared` placement whose type is not concrete (an interface, an abstract
 * class, a bare type parameter) -- the shape the WRONG check above cannot see
 * because it asks the same compiler the same question. `callsBetween`'s
 * closed-body absence licence refuses every one of these rather than accuse
 * on a placement that could be agreeing with a wrong one, so this is the
 * refusal rate that guard actually spends, not an estimate of it.
 */
const closedBlockedByGuard = new Map<Language, number>();

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

  // Built once per tree, lazily per package inside it (see `createTsReferee`'s
  // own doc) -- the same referee #226's tier-2 measurement uses, asked here
  // as a resolver rather than as a check on a syntax-only answer.
  let tsChecker: ReturnType<typeof createTsReferee> | undefined;
  try { tsChecker = createTsReferee(tree); } catch { tsChecker = undefined; }
  const resolveReceiver = (at: { start: number; end: number }, file: string, language: Language): ReceiverResolution | undefined => {
    const tally = resolverAnswers.get(language) ?? { type: 0, declared: 0, external: 0, none: 0 };
    resolverAnswers.set(language, tally);
    const answer = tsChecker?.typeAt(file, at.start, at.end);
    if (!answer || answer.head === "any" || answer.head === "unknown" || /error/i.test(answer.head)) {
      tally.none += 1;
      return undefined;
    }
    if (answer.declaringFile) {
      if (isOutsideTree(answer.declaringFile, tree)) { tally.external += 1; return { kind: "external" }; }
      // Repo-local, and the compiler already knows exactly which file --
      // stronger than a name search, and it catches what one cannot: a
      // receiver's type this file never imports by name at all, only the
      // function that produced it.
      const relDeclared = path.relative(tree, answer.declaringFile);
      tally.declared += 1;
      return { kind: "declared", file: relDeclared, concrete: answer.concrete };
    }
    tally.type += 1;
    return { kind: "type", name: answer.head };
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

    // Python and Rust answer over a language server, so their reading cannot
    // happen here -- see the record-then-resolve pass after this loop.
    if (TIER2_LANGUAGES.has(language) && !LSP_TIER2_LANGUAGES.has(language)) {
      const tier2Reading = callSitesIn({
        file: rel, source, language, imports: imports(rel, source), open,
        resolveReceiver: (at) => resolveReceiver(at, file, language),
      });
      if (tier2Reading.read) {
        bumpClosure(
          tier2Reading.bodies, language, bodiesTier2, closedTier2, calllessTier2, openTier2,
          soleBlockerTier2, anyBlockerTier2, siteReasonTier2,
        );
        for (const body of tier2Reading.bodies) {
          bumpGuardCost(body, language);
          for (const site of body.sites) {
            if (!site.receiver || !site.file || !site.memberAt) continue;
            const refereeDecl = tsChecker?.symbolDeclarationAt(file, site.memberAt.start, site.memberAt.end);
            const tally = placementReferee.get(language) ?? { agreed: 0, wrong: 0, refused: 0 };
            placementReferee.set(language, tally);
            if (!refereeDecl) { tally.refused += 1; continue; }
            const refereeOutside = isOutsideTree(refereeDecl, tree);
            const refereeRel = refereeOutside ? EXTERNAL_RECEIVER : path.relative(tree, refereeDecl);
            if (refereeRel === site.file) { tally.agreed += 1; continue; }
            tally.wrong += 1;
            if (placementWrongCases.length < 30) {
              placementWrongCases.push({
                tree: path.basename(tree), file: rel, line: site.line,
                placed: site.file, referee: refereeRel,
              });
            }
          }
        }
      }
    }

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

  /* ------------------------------------------ tier 2 over a language server (#256)
   *
   * Python's and Rust's resolvers answer over LSP, and `CallSide.resolveReceiver`
   * is synchronous, so the reading above cannot ask them mid-walk.
   * `resolution-python-live.ts` already solved this for the live checker and the
   * shape is reused rather than reinvented: read once with a resolver that
   * records every question and answers none, resolve the whole batch, then read
   * again with a synchronous lookup into what came back. Two readings of
   * unchanged input, which is what makes the second one comparable to the
   * baseline above rather than to a different population.
   */
  for (const language of LSP_TIER2_LANGUAGES) {
    const inLanguage = sourceFiles(tree).filter((one) => languageOf(path.basename(one)) === language);
    if (inLanguage.length === 0) continue;

    const relOf = (file: string) => path.relative(tree, file);
    const readWith = (
      resolveReceiver: (rel: string) => ((at: { start: number; end: number }) => ReceiverResolution | undefined),
    ) => inLanguage.flatMap((file) => {
      const rel = relOf(file);
      const source = read(rel);
      if (source === undefined) return [];
      const reading = callSitesIn({
        file: rel, source, language, imports: imports(rel, source), open,
        resolveReceiver: resolveReceiver(rel),
      });
      return reading.read ? [reading.bodies] : [];
    });

    const queries: Array<{ file: string; at: { start: number; end: number } }> = [];
    readWith((rel) => (at) => { queries.push({ file: rel, at }); return undefined; });
    if (queries.length === 0) continue;
    const distinct = new Set(queries.map((one) => `${one.file}:${one.at.start}:${one.at.end}`)).size;

    console.error(`  [${language}] ${distinct} receiver sites to resolve on ${path.basename(tree)}`);
    const startedAt = Date.now();
    const answers = language === "python"
      ? await resolvePythonReceivers(tree, queries)
      : await resolveRustReceivers(tree, queries, SKIP_DIRECTORIES);
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    console.error(`  [${language}] done in ${seconds}s`);

    const tally = resolverAnswers.get(language) ?? { type: 0, declared: 0, external: 0, none: 0 };
    resolverAnswers.set(language, tally);
    for (const query of queries) {
      const answer = answers.cache.get(query.file, query.at);
      if (!answer) tally.none += 1;
      else if (answer.kind === "external") tally.external += 1;
      else tally.declared += 1;
    }

    for (const bodies of readWith((rel) => (at) => answers.cache.get(rel, at))) {
      bumpClosure(
        bodies, language, bodiesTier2, closedTier2, calllessTier2, openTier2,
        soleBlockerTier2, anyBlockerTier2, siteReasonTier2,
      );
      for (const body of bodies) bumpGuardCost(body, language);
    }

    lspRuns.push({
      language, tree: path.basename(tree), asked: queries.length, distinct, seconds,
      started: answers.started,
      ...("primedCleanly" in answers ? { primedCleanly: answers.primedCleanly } : {}),
      ...("unclaimed" in answers ? { unclaimed: answers.unclaimed } : {}),
      ...("notATypeDeclaration" in answers
        ? { notATypeDeclaration: answers.notATypeDeclaration } : {}),
      ...("pathReceiver" in answers ? { pathReceiver: answers.pathReceiver } : {}),
      ...("anchorWithheld" in answers ? { anchorWithheld: answers.anchorWithheld } : {}),
      ...("withheldNoType" in answers ? { withheldNoType: answers.withheldNoType } : {}),
    });
    answers.close();
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

console.log("6 · TIER 2 (#226, #256) -- does a real checker flip the ceiling section 1 found?");
console.log();
console.log("  Every language with a tier-2 resolver: `tsc` in process (#226), pyright over");
console.log("  its language server (#235/#243), rust-analyzer over its own (#246). This run");
console.log("  also asks *where* a resolved type is declared: a receiver whose type provably");
console.log("  lives outside this tree (a language builtin, a package) is placed immediately,");
console.log("  on the same footing as one the text names -- neither leaves the call's");
console.log("  destination in doubt.");
console.log();
console.log("  The same reading, run a second time with the resolver wired in -- every");
console.log("  `x.foo()` `placeOf` would otherwise give up on is asked of a real checker");
console.log("  before it is counted `receiver`. Per language, because the resolvers do not");
console.log("  reach equally far and a closed share is only readable beside the reach it");
console.log("  rests on (section 6b).");
console.log();
const tsxLangs = [...TIER2_LANGUAGES];
console.log("  " + "language".padEnd(10) + "with calls".padStart(12) + "closed t1".padStart(11)
  + "  share" + "closed t2".padStart(12) + "  share");
for (const language of tsxLangs) {
  const perBodies = bodies.get(language) ?? 0;
  if (perBodies === 0) continue;
  const perWithCalls = perBodies - (callless.get(language) ?? 0);
  const perTier2WithCalls = (bodiesTier2.get(language) ?? 0) - (calllessTier2.get(language) ?? 0);
  const perClosed = closed.get(language) ?? 0;
  const perClosedTier2 = closedTier2.get(language) ?? 0;
  console.log("  " + language.padEnd(10)
    + String(perWithCalls).padStart(12)
    + String(perClosed).padStart(11) + "  " + percent(perClosed, perWithCalls).padStart(8)
    + String(perClosedTier2).padStart(12) + "  " + percent(perClosedTier2, perTier2WithCalls).padStart(8));
}
console.log();
const baselineBodies = tsxLangs.reduce((sum, one) => sum + (bodies.get(one) ?? 0), 0);
const baselineCallless = tsxLangs.reduce((sum, one) => sum + (callless.get(one) ?? 0), 0);
const baselineClosed = tsxLangs.reduce((sum, one) => sum + (closed.get(one) ?? 0), 0);
const baselineOpen = tsxLangs.reduce((sum, one) => sum + (open_.get(one) ?? 0), 0);
const baselineWithCalls = baselineBodies - baselineCallless;
const tier2Bodies = total(bodiesTier2);
const tier2Callless = total(calllessTier2);
const tier2Closed = total(closedTier2);
const tier2Open = total(openTier2);
const tier2WithCalls = tier2Bodies - tier2Callless;
console.log("  " + "".padEnd(10) + "with calls".padStart(12) + "closed".padStart(8) + "  share");
console.log("  " + "tier 1".padEnd(10) + String(baselineWithCalls).padStart(12)
  + String(baselineClosed).padStart(8) + "  " + percent(baselineClosed, baselineWithCalls).padStart(8));
console.log("  " + "tier 2".padEnd(10) + String(tier2WithCalls).padStart(12)
  + String(tier2Closed).padStart(8) + "  " + percent(tier2Closed, tier2WithCalls).padStart(8));
console.log();
if (tier2Bodies !== baselineBodies) {
  console.log(`  Population mismatch: tier 1 read ${baselineBodies} bodies in these languages,`);
  console.log(`  tier 2's pass read ${tier2Bodies} -- a file one walk skipped, or one a project's`);
  console.log("  own configuration adds. Read as a caveat on the comparison above, not as a");
  console.log("  second finding.");
  console.log();
}
const receiverSoleTier2 = totalOf(soleBlockerTier2, "receiver");
const receiverSoleBaseline = tsxLangs.reduce(
  (sum, one) => sum + ((soleBlocker.get(one)?.get("receiver")) ?? 0), 0,
);
console.log(`  \`receiver\` as the sole blocker: ${receiverSoleBaseline} bodies at tier 1, `
  + `${receiverSoleTier2} at tier 2`);
console.log(`  (${percent(receiverSoleBaseline, baselineOpen).trim()} of open bodies, then `
  + `${percent(receiverSoleTier2, tier2Open).trim()}). This is the number #221's`);
console.log("  \"don't build it\" rested on, and the one the reaffirm note in");
console.log("  `docs/claim-vocabulary.md` named as unmeasured until tier 2 existed.");
console.log();
console.log(`  But the closed share above only moved ${baselineClosed} -> ${tier2Closed}, `
  + `+${tier2Closed - baselineClosed} bodies -- nowhere near`);
console.log(`  the ${receiverSoleBaseline - receiverSoleTier2} bodies whose sole blocker stopped being \`receiver\`. Where did`);
console.log("  the rest go? Every reason a resolved receiver can narrow into, same reading:");
console.log();
console.log("  " + "reason".padEnd(12) + "sole blocker".padStart(14) + "  of open"
  + "present at all".padStart(16));
const reasonNamesTier2 = [...new Set([
  ...[...anyBlockerTier2.values()].flatMap((per) => [...per.keys()]),
])].sort((a, b) => totalOf(soleBlockerTier2, b) - totalOf(soleBlockerTier2, a));
for (const reason of reasonNamesTier2) {
  console.log("  " + reason.padEnd(12)
    + String(totalOf(soleBlockerTier2, reason)).padStart(14)
    + "  " + percent(totalOf(soleBlockerTier2, reason), tier2Open).padStart(8)
    + String(totalOf(anyBlockerTier2, reason)).padStart(16));
}
console.log();
console.log("  Most of what used to land here is now placed immediately instead: a type");
console.log("  whose own declaration the compiler can point to -- inside this tree");
console.log("  (`declared`) or outside it (`external`) -- closes the call without a name");
console.log("  match at all. What's left in `unbound`/`unplaced` is exactly the queries");
console.log("  where the resolver could not get a declaring file at all (`type`, the");
console.log("  fallback) plus the small remainder `placeName`'s own name search still");
console.log("  could not close even with a repo-relative file in hand -- counted by what");
console.log("  the resolver actually answered, not reconstructed after the fact:");
console.log();
console.log("  " + "language".padEnd(10) + "declared".padStart(10) + "external".padStart(10)
  + "type (no file)".padStart(16) + "none".padStart(8));
for (const language of tsxLangs) {
  const tally = resolverAnswers.get(language);
  if (!tally) continue;
  console.log("  " + language.padEnd(10) + String(tally.declared).padStart(10) + String(tally.external).padStart(10)
    + String(tally.type).padStart(16) + String(tally.none).padStart(8));
}
console.log();
console.log("  `type (no file)` is the honest ceiling on this whole approach: a union or a");
console.log("  bare primitive has no single declaration for `getSymbol()` to return, so no");
console.log("  amount of import-tracing or file-matching reaches it. Compared site-for-site,");
console.log("  not body-against-query -- the mismatch an earlier session's check made:");
console.log();
const siteUnboundOrUnplaced = tsxLangs.reduce((sum, one) => {
  const per = siteReasonTier2.get(one);
  return sum + (per?.get("unbound") ?? 0) + (per?.get("unplaced") ?? 0);
}, 0);
const noFileOrNone = tsxLangs.reduce((sum, one) => {
  const tally = resolverAnswers.get(one);
  return sum + (tally?.type ?? 0) + (tally?.none ?? 0);
}, 0);
console.log(`  unbound + unplaced sites: ${siteUnboundOrUnplaced}`);
console.log(`  type (no file) + none, same population: ${noFileOrNone}`);
if (siteUnboundOrUnplaced <= noFileOrNone) {
  console.log("  The site count is at or below the ceiling -- `declared`/`external` are not");
  console.log("  leaving a further name-search gap behind them at any real size. What's left");
  console.log("  is the structural residue this approach was never going to reach.");
} else {
  console.log(`  ${siteUnboundOrUnplaced - noFileOrNone} more sites are unbound/unplaced than the resolver's own`);
  console.log("  ceiling accounts for -- a real remaining gap, worth a fixture and a fix");
  console.log("  rather than accepting the number as final.");
}
console.log();

console.log("6b · WHAT EACH LANGUAGE'S NUMBER RESTS ON, and what it cost (#256)");
console.log();
console.log("  A closed share is a fact about the resolver's reach as much as about the code,");
console.log("  and the three resolvers do not reach equally far. Read a low share here as the");
console.log("  reach below it, not as the reader failing.");
console.log();
console.log("  `never asked` is counted apart from a refusal, because the two mean opposite");
console.log("  things: a file no crate manifest claims, or a receiver that is a type spelled as");
console.log("  a path (`String::new()`, how Rust writes a constructor) has no value at that");
console.log("  position for any checker to have an opinion about. Folding those into the");
console.log("  denominator would report Rust's constructor spelling as a resolver failure.");
console.log();
const neverAskedOf = (language: Language) => lspRuns
  .filter((one) => one.language === language)
  .reduce((sum, one) => sum
    + (one.unclaimed ?? 0) + (one.pathReceiver ?? 0) + (one.anchorWithheld ?? 0), 0);
console.log("  " + "language".padEnd(10) + "queries".padStart(9) + "never asked".padStart(13)
  + "asked".padStart(8) + "answered".padStart(10) + "  reach of asked");
for (const language of tsxLangs) {
  const tally = resolverAnswers.get(language);
  if (!tally) continue;
  const queries = tally.declared + tally.external + tally.type + tally.none;
  const neverAsked = neverAskedOf(language);
  const asked = queries - neverAsked;
  const answered = tally.declared + tally.external;
  console.log("  " + language.padEnd(10) + String(queries).padStart(9)
    + String(neverAsked).padStart(13) + String(asked).padStart(8)
    + String(answered).padStart(10) + "  " + percent(answered, asked).padStart(8));
}
console.log();
if (lspRuns.length > 0) {
  console.log("  The two language-server resolvers, per tree -- a round trip per receiver, so");
  console.log("  this is the most expensive measurement in the repository and its cost belongs");
  console.log("  on the record rather than in a reader's surprise:");
  console.log();
  let lspSeconds = 0;
  for (const one of lspRuns) {
    lspSeconds += one.seconds;
    const notes = [
      one.started ? undefined : "no resolver ran on this tree at all",
      // Only meaningful when a server actually ran: with no crate for it to
      // index, "never reported finished indexing" would restate the line above
      // as if it were a second fault.
      one.started && one.primedCleanly === false
        ? "a server never reported finished indexing" : undefined,
      one.unclaimed ? `${one.unclaimed} in a file no Cargo.toml claims` : undefined,
      one.pathReceiver ? `${one.pathReceiver} a type spelled as a path` : undefined,
      one.anchorWithheld ? `${one.anchorWithheld} no anchor to ask at` : undefined,
      one.notATypeDeclaration
        ? `${one.notATypeDeclaration} answered a line that declares no type` : undefined,
      one.withheldNoType
        ? `${one.withheldNoType} answered a line that declares no type (#259)` : undefined,
    ].filter(Boolean);
    /*
     * Queries, not distinct sites, because every count after the colon is a
     * count of queries -- printing one against the other made a tree read as
     * having more unclaimed sites than sites.
     */
    console.log(`    ${one.language}/${one.tree}: ${one.asked} queries`
      + ` (${one.distinct} distinct sites) in ${one.seconds}s`
      + (notes.length > 0 ? ` -- ${notes.join("; ")}` : ""));
  }
  console.log();
  console.log(`  ${lspSeconds}s of that total is language-server time.`);
  console.log();
}
console.log("  Where each resolver's own wrongness is measured, since it is not measured here:");
console.log("  `measure:resolution` and `docs/claim-vocabulary.md`. TypeScript's is section 7");
console.log("  below, on this run's own placements. Python's and Rust's are that other script's");
console.log("  -- Python checked against mypy, Rust against rustc, both independently of this");
console.log("  reading. A closed share is a coverage figure and never stands in for one.");
console.log();

console.log("7 · IS IT WRONG -- the gate AGENTS.md requires before anything may accuse on this");
console.log();
console.log("  Every closed-share and ceiling number above says how *much* this reads. This");
console.log("  is the only section that asks how often it is *right*. ts/tsx/js only -- it asks");
console.log("  `tsc` a second question in process, and neither language server here answers");
console.log("  one comparable. Python's and Rust's wrongness figures are `measure:resolution`'s");
console.log("  own, against oracles that share nothing with their reader. For every");
console.log("  receiver call");
console.log("  this session's placement actually placed, a second, more direct question --");
console.log("  what does the method itself (`getSymbolAtLocation` on `foo` in `x.foo()`)");
console.log("  resolve to, not what kind of thing `x` is -- is asked of the same compiler and");
console.log("  compared against what was placed.");
console.log();
console.log("  " + "language".padEnd(10) + "agreed".padStart(9) + "wrong".padStart(8)
  + "refused".padStart(10) + "  wrong share");
let placementAgreed = 0, placementWrong = 0, placementRefused = 0;
for (const language of ["ts", "tsx", "js"] as Language[]) {
  const tally = placementReferee.get(language);
  if (!tally) continue;
  placementAgreed += tally.agreed; placementWrong += tally.wrong; placementRefused += tally.refused;
  const asked = tally.agreed + tally.wrong;
  console.log("  " + language.padEnd(10) + String(tally.agreed).padStart(9) + String(tally.wrong).padStart(8)
    + String(tally.refused).padStart(10) + "  " + percent(tally.wrong, asked).padStart(8));
}
console.log();
if (placementWrongCases.length > 0) {
  console.log(`  WRONG -- read every one before trusting this reader's placements: ${placementWrong}`);
  for (const one of placementWrongCases.slice(0, cap(placementWrongCases.length))) {
    console.log(`    ${one.tree}/${one.file}:${one.line} placed ${one.placed}, referee says ${one.referee}`);
  }
  if (placementWrong > placementWrongCases.length) {
    console.log(`    ... and ${placementWrong - placementWrongCases.length} more`);
  }
  console.log();
}
console.log(`  ${placementWrong} wrong of ${placementAgreed + placementWrong} checked `
  + `(${percent(placementWrong, placementAgreed + placementWrong).trim()}), ${placementRefused} the referee itself`);
console.log("  could not answer (an overload, a computed member, a position it has no opinion");
console.log("  on) and are not counted either way. Caveat that has to travel with this number:");
console.log("  the placement and this check both ultimately ask the same compiler, so a shape");
console.log("  neither can see -- the concrete class behind an interface-typed receiver,");
console.log("  decided only at runtime -- would not show up as WRONG here even though it is a");
console.log("  real gap. This catches plumbing bugs, not that specific blind spot.");
console.log();

console.log("7b · THE INTERFACE GUARD'S COST (#233)");
console.log();
console.log("  Section 7's blind spot is not hypothetical once something accuses on a closed");
console.log("  body: `callsBetween` refuses to, for any closed body carrying a `declared`");
console.log("  placement whose type is an interface, an abstract class, or a bare type");
console.log("  parameter, rather than risk agreeing with a wrong one. Python spells the same");
console.log("  hazard `Protocol`/`ABC` and Rust spells it `trait`, and each language's own");
console.log("  resolver reads it off the declaration. This is that refusal, measured rather");
console.log("  than assumed:");
console.log();
console.log("  " + "language".padEnd(10) + "closed".padStart(8) + "blocked".padStart(9) + "  share");
let guardClosed = 0, guardBlocked = 0;
for (const language of tsxLangs) {
  const closed = closedTier2.get(language) ?? 0;
  const blocked = closedBlockedByGuard.get(language) ?? 0;
  guardClosed += closed; guardBlocked += blocked;
  if (closed === 0) continue;
  console.log("  " + language.padEnd(10) + String(closed).padStart(8) + String(blocked).padStart(9)
    + "  " + percent(blocked, closed).padStart(8));
}
console.log();
console.log(`  ${percent(guardBlocked, guardClosed).trim()} of closed bodies (${guardBlocked} of `
  + `${guardClosed}) carry the one known shape that could make a closed-body accusation`);
console.log("  wrong, and stay withheld rather than refuted. Coverage spent on trust, per");
console.log("  AGENTS.md's own argument for why that is the right trade.");
console.log();

console.log("8 · WHAT THIS ANSWERS");
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
