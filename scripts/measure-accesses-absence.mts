#!/usr/bin/env node
/**
 * Would `@accesses` be right to say a routine does NOT read a member? (#255)
 *
 *   npm run measure:accesses-absence                     -- this repo, rust-test, orangutan,
 *                                                           graphify, infrarouter
 *   npm run measure:accesses-absence -- <path>...        -- any trees you like
 *   npm run measure:accesses-absence -- --all            -- every dispute, not the first few
 *   npm run measure:accesses-absence -- --json <path>... -- counts as JSON
 *   npm run measure:accesses-absence -- --merge <file.json>...
 *
 * **A measurement. Nothing here can colour a diagram.**
 *
 * `measure:accesses-closed` says how often a body is one where every read was
 * seen and placed -- region A. This asks the question the gate in `AGENTS.md`
 * asks before anything may say wrong: inside that region, how often would the
 * accusation be false?
 *
 * ## The population
 *
 * Every ask a region-A refutation would answer "does not read":
 *
 *     (routine R, type X, member M)
 *       R is a named region-A body whose every read the checker placed at a file
 *       X is a type declared in this repository that R reads at least one member off
 *       M is a member read off X somewhere in the same tree
 *       and the reader places no read of M off X inside R
 *
 * `M` comes from members that really are read off X, not from X's whole
 * declaration. An arrow naming a member nobody reads is refuted correctly and
 * easily, and counting those would dilute the rate with the easy half -- the
 * mistake #250 found in item 18, measured on the quarter that was simple.
 *
 * ## The referee
 *
 * `scripts/lib/access-scan.ts`: a text scan sharing no tree-sitter query and
 * no type checker with the reader. For each ask it looks for `.M` inside R's
 * lines. It cannot say what `.M` is read off, so it disputes every ask where
 * `M` is read off anything at all -- an over-count, in the direction that
 * makes the accusation look worse. Each dispute is then sorted by what the
 * reader itself saw at that member, because those classes are where a false
 * red would live:
 *
 *   never-seen        the reader has no read of M in R at all: a blind spot
 *   placed-elsewhere  the reader placed a read of M on another repository type
 *   placed-outside    the reader placed a read of M on a type outside the repo
 *
 * `placed-elsewhere` is only a false red if the checker's placement is wrong,
 * and this referee cannot decide that. Rust and Python have an independent
 * checker that can (`rustc`, #257; mypy, #260). TypeScript has none (#260),
 * and the report says so beside its row rather than borrowing a figure.
 *
 * Names the referee deliberately does not report -- `BUILT_IN` -- could never
 * be disputed, so an ask about one would read as agreement nobody checked.
 * Those are counted as `unrefereed` and kept out of the rate.
 *
 * ## The other way an accusation is false
 *
 * If `draw()` calls `paint()` and paint reads `width` off Config, then `draw
 * --[width]--> Config` is an arrow a person would call right. `HELPER` counts
 * the asks where a one-hop callee in this repository reads M off X. Whether
 * that makes a red false depends on what the word means, which is not a
 * measurement -- so it is its own column and never folded into the rate.
 *
 * ## Two designs, measured over the same bodies
 *
 * **By type**, above: refute (R, X, M) when R reads M off no receiver the
 * checker places at X. It needs a type checker for every receiver, and it has
 * three ways to be wrong that a type answer creates -- a read off an interface
 * that mirrors X (`shadowNames`), a read off `Partial<X>` or `Readonly<X>`,
 * which the checker places in its own library, and a read off a type with no
 * single declaration such as `X | undefined`.
 *
 * **By name**: refute (R, M) when a named body with no unnamed read contains
 * no read of anything called M at all. It needs no type checker. A read of X.M
 * is written `something.M` whatever `something` turns out to be, so where no
 * `.M` appears the body does not read M off X -- and every one of the three
 * failures above is a body that *does* contain `.M`, which this design never
 * asks about. What it gives up is refuting in a body that reads M off
 * something else.
 *
 * By name, the ask pool is every member read anywhere in the same file: a
 * member somebody really reads, near enough that an author could draw it.
 *
 * ## Helpers, and the rule the by-name red follows
 *
 * `draw()` does not read `width`, but it calls `paint()`, which does. The
 * right board for that is `draw --calls--> paint --accesses--> Config`, and a
 * red on `draw --accesses--> Config` would be telling somebody their board is
 * wrong when it is only drawn at one level of abstraction too high. So the red
 * stays quiet whenever a function the body calls *visibly* reads the member.
 *
 * Seeing that function is the hard part. Every call is settled before
 * anything is asked: placed by the call reader at a routine in this
 * repository; placed outside it; or, failing both, looked up with the "go to
 * definition" #254 built -- `tsc`, pyright or rust-analyzer at the call's own
 * name -- and then found as the routine whose body holds that line. A call
 * that still lands nowhere does not silence the red. It is counted, per ask,
 * as a red in a body that calls something nobody could see into.
 *
 * `--no-tier2` skips every checker: no receiver types, no lookup. It leaves
 * only the by-name section, runs over the whole corpus in one process in
 * under a minute, and shows what a caller with no checker sees -- which is
 * what the MCP server's own draw-time check sees today.
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { BUILT_IN, refereeRoutines } from "./lib/access-scan";
import { checkerFor, type Declared, type NameRange } from "./lib/call-receivers";
import { resolvePythonReceivers } from "./lib/resolution-python-live";
import { resolveRustReceivers } from "./lib/resolution-rust-receivers";
import { createTsReferee, isOutsideTree, receiverResolutionFrom } from "./lib/resolution-ts";
import { sourceFiles } from "./lib/source-files";
import {
  callSitesIn, EXTERNAL_RECEIVER,
  type BodyCallSites, type CallSide, type ReceiverResolution,
} from "../src/engine/calls";
import { readDependencies } from "../src/engine/deps";
import { createWorkspace } from "../src/engine/drift";
import { initEngine, languageOf, type Language } from "../src/engine/parse";
import type { ConfigCache } from "../src/engine/resolve";
import { memberReadsIn, type MemberReadSite, type RoutineReads } from "../src/engine/resolution";

await initEngine();

const HOME = process.env.HOME ?? "/Users/noelmatero";
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((one) => one.startsWith("--")));
const roots = argv.filter((one) => !one.startsWith("--"));
const showAll = flags.has("--all");
const asJson = flags.has("--json");
const merging = flags.has("--merge");
const noTier2 = flags.has("--no-tier2");

const trees = (roots.length > 0 ? roots : [
  "src", "scripts", "rust-test",
  `${HOME}/orangutan`, `${HOME}/board-ai/graphify/graphify`, `${HOME}/infrarouter`,
]).map((tree) => path.resolve(tree)).filter((tree) => existsSync(tree));

const LANGUAGES: Language[] = ["rust", "ts", "tsx", "python", "js"];
const LSP_LANGUAGES = new Set<Language>(["python", "rust"]);
const RUST_SKIP = new Set(["target", "node_modules", ".git", "dist", "out", "vendor", ".venv", ".claude"]);
type Resolve = (at: { start: number; end: number }) => ReceiverResolution | undefined;
const TS_FAMILY = new Set<Language>(["ts", "tsx", "js"]);
/** pyright and rust-analyzer take questions in parallel; #262 found 32 safe for pyright. */
const LOOKUP_CONCURRENCY = 16;

/**
 * Whether a declaration a checker pointed at is outside the repository.
 *
 * `isOutsideTree` decides it by path: `node_modules`, or not under the tree.
 * A Python virtualenv or a Rust `target` directory can sit *inside* a project,
 * and a declaration there is a dependency's, not a helper anybody draws -- so
 * those count as outside too. Compared against the tree's real path as well,
 * because rust-analyzer and pyright answer with resolved symlinks.
 */
function outsideRepo(file: string, tree: string, realTree: string): boolean {
  if (/[\\/](site-packages|dist-packages|\.venv|venv|target|typeshed[\w-]*)[\\/]/.test(file)) return true;
  return isOutsideTree(file, tree) && isOutsideTree(file, realTree);
}

interface Tally {
  /** Named bodies where every read was placed and nothing reads a member unnamed. */
  regionA: number;
  /**
   * Region-A bodies with a read the checker did not place at a file -- the
   * text named its type, or the checker named one without a declaration.
   * Such a read cannot be matched to a box, so a refutation there would rest
   * on a read nobody can attribute. Not asked, and counted as the cost.
   */
  unkeyed: number;
  /** Keyed bodies that read at least one member off a repository type. */
  askable: number;
  asked: number;
  agreed: number;
  disputed: number;
  neverSeen: number;
  placedElsewhere: number;
  /** ...of those, onto a type the checker says is not concrete. */
  elsewhereAbstract: number;
  placedOutside: number;
  /** Asks about a name the referee is built not to report. Out of the rate. */
  unrefereed: number;
  /** Asks where a one-hop callee reads M off X. */
  helper: number;
  /** Asks in bodies whose calls could not all be followed. */
  helperUnknown: number;
  /**
   * #233's guard, the rule `@calls` already accuses under: no absence may rest
   * on a body with a read off an interface or an abstract type, because the
   * declaration is not necessarily the thing reached at runtime.
   *
   * Found here the same way. `shadowNames(tree: Tree)` in `signature.ts` reads
   * `tree.rootNode` off a local `interface Tree` that mirrors `parse.ts`'s --
   * and at runtime it *is* the `parse.ts` tree, because TypeScript checks shape
   * and not name. The one genuine dispute on this repository's own source.
   */
  guardedBodies: number;
  guardedAsked: number;
  guardedAgreed: number;
  guardedDisputed: number;
}

/** The by-name design's counts, per language. */
interface NameTally {
  named: number;
  /** Named bodies that read no member at all. Closed for free, held apart. */
  readless: number;
  withReads: number;
  /** Bodies with a read that has no `.name`: destructured, spread, computed, a macro. */
  hazard: number;
  /** Named bodies with reads and no hazard: the region. */
  region: number;
  asked: number;
  agreed: number;
  disputed: number;
  /** ...of which the referee's `.M` is on the body's first or last line, shared with code around it. */
  disputedOnEdge: number;
  unrefereed: number;
  /** Asks where a function the body calls visibly reads something called M: the red stays quiet. */
  helper: number;
  /** Asks with no visible helper, in a body with a call nobody could settle: red, and a helper might exist. */
  helperMaybe: number;
  /** How each call in a region body was settled, counted once per call. */
  callsInRepo: number;
  callsOutside: number;
  callsSilent: number;
  callsNoBody: number;
  callsNoName: number;
  callsNoChecker: number;
}
const nameTallies = new Map<Language, NameTally>();
function nameTally(language: Language): NameTally {
  let found = nameTallies.get(language);
  if (!found) {
    found = {
      named: 0, readless: 0, withReads: 0, hazard: 0, region: 0, asked: 0, agreed: 0,
      disputed: 0, disputedOnEdge: 0, unrefereed: 0, helper: 0, helperMaybe: 0,
      callsInRepo: 0, callsOutside: 0, callsSilent: 0, callsNoBody: 0, callsNoName: 0, callsNoChecker: 0,
    };
    nameTallies.set(language, found);
  }
  return found;
}
interface NameDispute { language: Language; file: string; routine: string; span: string; line: number; member: string; edge: boolean; helper: boolean }
const nameDisputes: NameDispute[] = [];

const tallies = new Map<Language, Tally>();
function tally(language: Language): Tally {
  let found = tallies.get(language);
  if (!found) {
    found = {
      regionA: 0, unkeyed: 0, askable: 0, asked: 0, agreed: 0, disputed: 0,
      neverSeen: 0, placedElsewhere: 0, elsewhereAbstract: 0, placedOutside: 0,
      unrefereed: 0, helper: 0, helperUnknown: 0,
      guardedBodies: 0, guardedAsked: 0, guardedAgreed: 0, guardedDisputed: 0,
    };
    tallies.set(language, found);
  }
  return found;
}

interface Dispute {
  language: Language;
  file: string;
  routine: string;
  line: number;
  member: string;
  type: string;
  kind: "never-seen" | "placed-elsewhere" | "placed-outside";
  elsewhere?: string;
  /**
   * The type the reader placed it on is an interface or abstract. Not called
   * `abstract`: tree-sitter reads that as the keyword and stops parsing the
   * file, which `engine-deps.test.ts` reports as a file nobody can trust.
   */
  notConcrete?: boolean;
  /** The file the reader placed it in declares a type with a parent: a subclass risk. */
  elsewhereInherits?: boolean;
  helper: boolean;
  /** Whether #233's guard would have kept this body from accusing at all. */
  guarded: boolean;
}
const disputes: Dispute[] = [];

interface FileReading {
  relative: string;
  source: string;
  language: Language;
  routines: RoutineReads[];
  bodies: BodyCallSites[];
}

/**
 * A type declaration with a parent, spelled in any of the three languages.
 *
 * Only used to sort disputes for reading, never to decide anything: a read
 * placed on a subclass is a read of the base's member when the base declares
 * it, and an arrow drawn at the base is then right while the placement says
 * otherwise. Crude on purpose, and it over-flags.
 */
const HERITAGE = /\b(class|interface)\s+\w+[^{\n]*\b(extends|implements)\b|\bclass\s+\w+\s*\([^)]*\w[^)]*\)\s*:|\bimpl\b[^{\n]*\bfor\b/;

const placedAtAll = (site: MemberReadSite) => site.verdict.verdict === "resolved" || site.placed !== undefined;
const keyed = (site: MemberReadSite) => site.placed?.kind === "declared" || site.placed?.kind === "external";

if (!merging) {
  for (const tree of trees) {
    const files = sourceFiles(tree);
    const label = path.basename(tree);
    console.error(`  [${label}] ${files.length} files`);

    const workspace = createWorkspace(tree);
    const configs: ConfigCache = new Map();
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
    const sideFor = (relative: string, source: string, language: Language, resolve?: Resolve): CallSide => ({
      file: relative, source, language, imports: imports(relative, source), open,
      ...(resolve ? { resolveReceiver: resolve } : {}),
    });

    const readings: FileReading[] = [];
    const readWith = (relative: string, language: Language, resolve: Resolve | undefined) => {
      const source = read(relative);
      if (source === undefined) return;
      const reads = memberReadsIn(source, language, resolve);
      const calls = callSitesIn(sideFor(relative, source, language, resolve));
      if (!reads.read || !calls.read) return;
      readings.push({ relative, source, language, routines: reads.routines, bodies: calls.bodies });
    };

    /* ------------------------------------------------ TypeScript, in process */
    let tsReferee: ReturnType<typeof createTsReferee> | undefined;
    if (!noTier2) {
      try { tsReferee = createTsReferee(tree); } catch { tsReferee = undefined; }
    }
    for (const file of files) {
      const language = languageOf(file);
      if (!language || LSP_LANGUAGES.has(language)) continue;
      const relative = path.relative(tree, file);
      const resolve: Resolve | undefined = tsReferee
        ? (at) => receiverResolutionFrom(tsReferee!.typeAt(file, at.start, at.end), tree)
        : undefined;
      readWith(relative, language, resolve);
    }

    /* ------------------------------ Python and Rust, recorded and resolved */
    for (const language of LSP_LANGUAGES) {
      const inLanguage = files.filter((one) => languageOf(one) === language).map((one) => path.relative(tree, one));
      if (inLanguage.length === 0) continue;
      if (noTier2) {
        for (const relative of inLanguage) readWith(relative, language, undefined);
        continue;
      }
      const queries: Array<{ file: string; at: { start: number; end: number } }> = [];
      for (const relative of inLanguage) {
        const source = read(relative);
        if (source === undefined) continue;
        const record: Resolve = (at) => { queries.push({ file: relative, at }); return undefined; };
        memberReadsIn(source, language, record);
        callSitesIn(sideFor(relative, source, language, record));
      }
      if (queries.length === 0) continue;
      console.error(`  [${label}/${language}] ${queries.length} receivers to resolve`);
      const answers = language === "python"
        ? await resolvePythonReceivers(tree, queries)
        : await resolveRustReceivers(tree, queries, RUST_SKIP);
      /*
       * Closed at once: every answer this run needs is already in `answers.cache`,
       * and a live language server is an open child process Node will not exit
       * past. Left open, a run printed its whole report and then sat idle forever
       * -- the hazard `check-drift.mjs` records for the same resolver.
       */
      answers.close();
      for (const relative of inLanguage) readWith(relative, language, (at) => answers.cache.get(relative, at));
    }

    /* ------------------------------------------- what the asks are drawn from */
    const candidates = new Map<string, Set<string>>();
    const pairsByRoutine = new Map<string, Map<string, Set<string>>>();
    for (const reading of readings) {
      const byName = new Map<string, Set<string>>();
      for (const routine of reading.routines) {
        for (const site of routine.sites) {
          if (site.placed?.kind !== "declared") continue;
          const members = candidates.get(site.placed.file) ?? new Set<string>();
          members.add(site.member);
          candidates.set(site.placed.file, members);
          if (!routine.routine) continue;
          const pairs = byName.get(routine.routine) ?? new Set<string>();
          pairs.add(`${site.placed.file}#${site.member}`);
          byName.set(routine.routine, pairs);
        }
      }
      pairsByRoutine.set(reading.relative, byName);
    }

    /* ------------------------------------------------ the asking, by name */
    const realTree = realpathSync(tree);
    const readingOf = new Map(readings.map((one) => [one.relative, one]));
    const relativeOf = (file: string) => {
      const inReal = path.relative(realTree, file);
      return inReal.startsWith("..") || path.isAbsolute(inReal) ? path.relative(tree, file) : inReal;
    };
    const namesByRoutine = new Map<string, Map<string, Set<string>>>();
    for (const reading of readings) {
      const byName = new Map<string, Set<string>>();
      for (const routine of reading.routines) {
        if (!routine.routine) continue;
        const names = byName.get(routine.routine) ?? new Set<string>();
        for (const site of routine.sites) names.add(site.member);
        byName.set(routine.routine, names);
      }
      namesByRoutine.set(reading.relative, byName);
    }

    const inRegion = (routine: RoutineReads) =>
      routine.routine !== "" && routine.sites.length > 0 && routine.hazards.length === 0;
    const bodyOf = (reading: FileReading, routine: RoutineReads) => {
      const sameLine = reading.bodies.filter((one) => one.line === routine.line);
      return sameLine.length === 1 ? sameLine[0] : sameLine.find((one) => one.routine === routine.routine);
    };
    type CallSite = BodyCallSites["sites"][number];
    const syntactic = (site: CallSite) =>
      site.file !== undefined && site.file !== EXTERNAL_RECEIVER ? namesByRoutine.get(site.file)?.get(site.name) : undefined;

    /*
     * The lookup, done once per tree before anything is asked, because
     * pyright and rust-analyzer answer asynchronously and the asking below
     * does not. Only calls the reader could not already place at a routine
     * are looked up.
     */
    const lookupKey = (relative: string, at: NameRange) => `${relative}:${at.start}:${at.end}`;
    const looked = new Map<string, Declared | undefined>();
    if (!noTier2) {
      const pending = new Map<Language, Array<{ relative: string; source: string; at: NameRange }>>();
      for (const reading of readings) {
        for (const routine of reading.routines) {
          if (!inRegion(routine)) continue;
          for (const site of bodyOf(reading, routine)?.sites ?? []) {
            if (site.file === EXTERNAL_RECEIVER || syntactic(site) || !site.nameAt) continue;
            const family: Language = TS_FAMILY.has(reading.language) ? "ts" : reading.language;
            const queue = pending.get(family) ?? [];
            queue.push({ relative: reading.relative, source: reading.source, at: site.nameAt });
            pending.set(family, queue);
          }
        }
      }
      for (const [language, queries] of pending) {
        const checker = await checkerFor(tree, language);
        if ("unavailable" in checker) {
          console.error(`  [${label}/${language}] no lookup: ${checker.unavailable}`);
          continue;
        }
        console.error(`  [${label}/${language}] ${queries.length} call names to look up with ${checker.label}`);
        const startedAt = Date.now();
        let next = 0;
        await Promise.all(Array.from({ length: LOOKUP_CONCURRENCY }, async () => {
          while (next < queries.length) {
            const query = queries[next++]!;
            let answer: Declared | undefined;
            try {
              answer = await checker.definitionAt(path.join(tree, query.relative), query.source, query.at);
            } catch {
              answer = undefined;
            }
            looked.set(lookupKey(query.relative, query.at), answer);
          }
        }));
        checker.close();
        console.error(`  [${label}/${language}] looked up in ${Math.round((Date.now() - startedAt) / 1000)}s`);
      }
    }

    type Settled =
      | { kind: "repo"; names: Set<string> }
      | { kind: "outside" }
      | { kind: "unknown"; why: "silent" | "no-body" | "no-name" | "no-checker" };
    const settle = (reading: FileReading, site: CallSite): Settled => {
      if (site.file === EXTERNAL_RECEIVER) return { kind: "outside" };
      const placed = syntactic(site);
      if (placed) return { kind: "repo", names: placed };
      if (!site.nameAt) return { kind: "unknown", why: "no-name" };
      const key = lookupKey(reading.relative, site.nameAt);
      if (!looked.has(key)) return { kind: "unknown", why: "no-checker" };
      const declared = looked.get(key);
      if (!declared) return { kind: "unknown", why: "silent" };
      if (outsideRepo(declared.file, tree, realTree)) return { kind: "outside" };
      const line = declared.line + 1;
      /*
       * The innermost named routine whose body holds the declaration's line.
       * A method signature in an interface, or a type, has no body here, and
       * then nobody can see what the function reads.
       */
      const holding = readingOf.get(relativeOf(declared.file))?.routines
        .filter((one) => one.routine !== "" && one.line <= line && line <= one.endLine)
        .sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0];
      if (!holding) return { kind: "unknown", why: "no-body" };
      return { kind: "repo", names: new Set(holding.sites.map((one) => one.member)) };
    };

    for (const reading of readings) {
      const refereeReads = refereeRoutines(reading.source, reading.language)
        .flatMap((one) => one.reads)
        .filter((one) => !BUILT_IN.has(one.name));
      const pool = new Set(reading.routines.flatMap((one) => one.sites.map((site) => site.member)));

      for (const routine of reading.routines) {
        if (!routine.routine) continue;
        const into = nameTally(reading.language);
        into.named += 1;
        if (routine.sites.length === 0) { into.readless += 1; continue; }
        into.withReads += 1;
        if (routine.hazards.length > 0) { into.hazard += 1; continue; }
        into.region += 1;

        const own = new Set(routine.sites.map((site) => site.member));
        const inSpan = new Map<string, number>();
        for (const one of refereeReads) {
          if (one.line < routine.line || one.line > routine.endLine) continue;
          if (!inSpan.has(one.name)) inSpan.set(one.name, one.line);
        }

        const body = bodyOf(reading, routine);
        const reached = new Set<string>();
        let maybe = body === undefined;
        for (const site of body?.sites ?? []) {
          const settled = settle(reading, site);
          if (settled.kind === "repo") {
            into.callsInRepo += 1;
            for (const name of settled.names) reached.add(name);
          } else if (settled.kind === "outside") {
            into.callsOutside += 1;
          } else {
            maybe = true;
            if (settled.why === "silent") into.callsSilent += 1;
            else if (settled.why === "no-body") into.callsNoBody += 1;
            else if (settled.why === "no-name") into.callsNoName += 1;
            else into.callsNoChecker += 1;
          }
        }

        for (const member of pool) {
          if (own.has(member)) continue;
          if (BUILT_IN.has(member)) { into.unrefereed += 1; continue; }
          into.asked += 1;
          const helper = reached.has(member);
          if (helper) into.helper += 1;
          else if (maybe) into.helperMaybe += 1;
          const line = inSpan.get(member);
          if (line === undefined) { into.agreed += 1; continue; }
          into.disputed += 1;
          const edge = line === routine.line || line === routine.endLine;
          if (edge) into.disputedOnEdge += 1;
          nameDisputes.push({
            language: reading.language, file: path.join(label, reading.relative), routine: routine.routine,
            span: `${routine.line}-${routine.endLine}`, line, member, edge, helper,
          });
        }
      }
    }

    /* ------------------------------------------------ the asking, by type */
    if (noTier2) continue;
    for (const reading of readings) {
      const refereeReads = refereeRoutines(reading.source, reading.language)
        .flatMap((one) => one.reads)
        .filter((one) => !BUILT_IN.has(one.name));

      for (const routine of reading.routines) {
        if (!routine.routine || routine.sites.length === 0 || routine.hazards.length > 0) continue;
        if (!routine.sites.every(placedAtAll)) continue;
        const into = tally(reading.language);
        into.regionA += 1;
        if (!routine.sites.every(keyed)) { into.unkeyed += 1; continue; }

        const own = new Map<string, Set<string>>();
        const readsOf = new Map<string, MemberReadSite[]>();
        for (const site of routine.sites) {
          readsOf.set(site.member, [...(readsOf.get(site.member) ?? []), site]);
          if (site.placed?.kind !== "declared") continue;
          own.set(site.placed.file, (own.get(site.placed.file) ?? new Set()).add(site.member));
        }
        if (own.size === 0) continue;
        into.askable += 1;
        const guarded = routine.sites.some((site) => site.placed?.kind === "declared" && site.placed.concrete === false);
        if (!guarded) into.guardedBodies += 1;

        const inSpan = new Map<string, number>();
        for (const one of refereeReads) {
          if (one.line < routine.line || one.line > routine.endLine) continue;
          if (!inSpan.has(one.name)) inSpan.set(one.name, one.line);
        }

        /*
         * One hop, and `undefined` when any call cannot be followed: an unknown
         * is not a callee that reads nothing.
         */
        const sameLine = reading.bodies.filter((one) => one.line === routine.line);
        const body = sameLine.length === 1 ? sameLine[0] : sameLine.find((one) => one.routine === routine.routine);
        let calleePairs: Set<string> | undefined = body ? new Set() : undefined;
        for (const site of body?.sites ?? []) {
          if (site.file === undefined) { calleePairs = undefined; break; }
          if (site.file === EXTERNAL_RECEIVER) continue;
          const pairs = pairsByRoutine.get(site.file)?.get(site.name);
          if (!pairs) { calleePairs = undefined; break; }
          for (const pair of pairs) calleePairs!.add(pair);
        }

        for (const [type, members] of own) {
          for (const member of candidates.get(type) ?? []) {
            if (members.has(member)) continue;
            if (BUILT_IN.has(member)) { into.unrefereed += 1; continue; }
            into.asked += 1;
            if (!guarded) into.guardedAsked += 1;
            const helper = calleePairs?.has(`${type}#${member}`) ?? false;
            if (calleePairs === undefined) into.helperUnknown += 1;
            else if (helper) into.helper += 1;

            const line = inSpan.get(member);
            if (line === undefined) {
              into.agreed += 1;
              if (!guarded) into.guardedAgreed += 1;
              continue;
            }
            into.disputed += 1;
            if (!guarded) into.guardedDisputed += 1;

            const seen = readsOf.get(member) ?? [];
            const elsewhere = seen.find((site) => site.placed?.kind === "declared" && site.placed.file !== type);
            let kind: Dispute["kind"];
            if (seen.length === 0) { kind = "never-seen"; into.neverSeen += 1; }
            else if (elsewhere) {
              kind = "placed-elsewhere"; into.placedElsewhere += 1;
              if (elsewhere.placed?.kind === "declared" && elsewhere.placed.concrete === false) into.elsewhereAbstract += 1;
            } else { kind = "placed-outside"; into.placedOutside += 1; }

            disputes.push({
              language: reading.language, file: path.join(label, reading.relative), routine: routine.routine,
              line, member, type, kind, helper, guarded,
              ...(elsewhere?.placed?.kind === "declared"
                ? {
                  elsewhere: elsewhere.placed.file,
                  notConcrete: elsewhere.placed.concrete === false,
                  elsewhereInherits: HERITAGE.test(read(elsewhere.placed.file) ?? ""),
                }
                : {}),
            });
          }
        }
      }
    }
  }
}

/* ---------------------------------------------------------------- the report */

type Counts = Record<string, number>;
interface Measured {
  trees: string[];
  tallies: Record<string, Counts>;
  disputes: Dispute[];
  names: Record<string, Counts>;
  nameDisputes: NameDispute[];
}

function add(into: Record<string, unknown>, from: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(from)) {
    if (typeof value === "number") into[key] = ((into[key] as number | undefined) ?? 0) + value;
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      const child = (into[key] as Record<string, unknown> | undefined) ?? {};
      add(child, value as Record<string, unknown>);
      into[key] = child;
    }
  }
}

const data: Measured = merging
  ? roots.reduce<Measured>((total, file) => {
    const one = JSON.parse(readFileSync(file, "utf8")) as Measured;
    total.trees.push(...one.trees);
    total.disputes.push(...one.disputes);
    total.nameDisputes.push(...one.nameDisputes);
    add(total.tallies as Record<string, unknown>, one.tallies as Record<string, unknown>);
    add(total.names as Record<string, unknown>, one.names as Record<string, unknown>);
    return total;
  }, { trees: [], tallies: {}, disputes: [], names: {}, nameDisputes: [] })
  : {
    trees,
    tallies: Object.fromEntries([...tallies].map(([language, one]) => [language, { ...one }])) as Record<string, Counts>,
    disputes,
    names: Object.fromEntries([...nameTallies].map(([language, one]) => [language, { ...one }])) as Record<string, Counts>,
    nameDisputes,
  };

if (asJson) {
  console.log(JSON.stringify(data));
  process.exit(0);
}

const percent = (part: number, whole: number) => (whole === 0 ? "  n/a" : `${((part / whole) * 100).toFixed(2)}%`);
const num = (value: unknown) => (typeof value === "number" ? value : 0);
const cap = (count: number, few: number) => (showAll ? count : Math.min(count, few));
const ORACLE: Partial<Record<Language, string>> = {
  rust: "rustc can decide these (#257)",
  python: "mypy can decide these (#260)",
  ts: "NO independent checker exists (#260)",
  tsx: "NO independent checker exists (#260)",
};

console.log("\nMEASURE ACCESSES-ABSENCE -- would 'this routine does not read that member' be wrong? (#255)");
console.log(`  ${data.trees.length} trees\n`);

console.log("BY NAME -- refute when a body with no unnamed read contains no `.member` at all.");
console.log("  No type checker. Pool: every member read anywhere in the same file.");
console.log("  language   named  no reads  with reads  hazard   REGION   share      asked  disputed  on an edge    rate");
for (const language of LANGUAGES) {
  const one = data.names[language];
  if (!one || num(one.named) === 0) continue;
  console.log(
    " ", language.padEnd(8), String(num(one.named)).padStart(6), String(num(one.readless)).padStart(9),
    String(num(one.withReads)).padStart(11), String(num(one.hazard)).padStart(7),
    String(num(one.region)).padStart(8), percent(num(one.region), num(one.withReads)).padStart(8),
    String(num(one.asked)).padStart(10), String(num(one.disputed)).padStart(9),
    String(num(one.disputedOnEdge)).padStart(11), percent(num(one.disputed), num(one.asked)).padStart(8),
  );
}
console.log("\n  `on an edge`: the referee's `.member` is on the body's first or last line, which the");
console.log("  body shares with the code around it -- `rows.sort(key=lambda r: ..)`. The referee");
console.log("  reports lines, not positions, so it cannot tell whose read that is.");
console.log("\n  HELPERS -- the red stays quiet when a function the body calls visibly reads the member.");
console.log("  language     asked  quiet: a helper reads it   red, a call nobody could see into   red, every call seen   unrefereed names");
for (const language of LANGUAGES) {
  const one = data.names[language];
  if (!one || num(one.asked) === 0) continue;
  const clean = num(one.asked) - num(one.helper) - num(one.helperMaybe);
  console.log(
    " ", language.padEnd(8), String(num(one.asked)).padStart(9),
    `${num(one.helper)} (${percent(num(one.helper), num(one.asked))})`.padStart(26),
    `${num(one.helperMaybe)} (${percent(num(one.helperMaybe), num(one.asked))})`.padStart(36),
    `${clean} (${percent(clean, num(one.asked))})`.padStart(23),
    String(num(one.unrefereed)).padStart(18),
  );
}
console.log("\n  HOW EACH CALL IN A REGION BODY WAS SETTLED, once per call.");
console.log("  language   in this repo    outside   checker silent   declared, no body   no name   no checker");
for (const language of LANGUAGES) {
  const one = data.names[language];
  if (!one || num(one.region) === 0) continue;
  console.log(
    " ", language.padEnd(8), String(num(one.callsInRepo)).padStart(12), String(num(one.callsOutside)).padStart(10),
    String(num(one.callsSilent)).padStart(16), String(num(one.callsNoBody)).padStart(19),
    String(num(one.callsNoName)).padStart(9), String(num(one.callsNoChecker)).padStart(12),
  );
}
if (data.nameDisputes.length > 0) {
  console.log(`\n  BY-NAME DISPUTES -- ${data.nameDisputes.length}`);
  for (const one of data.nameDisputes.slice(0, cap(data.nameDisputes.length, 20))) {
    console.log(`    ${one.file}:${one.line} ${one.routine}() [${one.span}] reads ${one.member}${one.edge ? " [edge]" : ""}${one.helper ? " [helper]" : ""}`);
  }
  if (data.nameDisputes.length > cap(data.nameDisputes.length, 20)) {
    console.log(`    ... and ${data.nameDisputes.length - 20} more (--all prints every one)`);
  }
}

if (Object.values(data.tallies).every((one) => num(one.regionA) === 0)) process.exit(0);
console.log("\nBY TYPE -- refute when no receiver the checker places at the type reads the member.");
console.log("  language  region A  unkeyed  askable     asked    agreed  disputed  dispute rate");
for (const language of LANGUAGES) {
  const one = data.tallies[language];
  if (!one || num(one.regionA) === 0) continue;
  console.log(
    " ", language.padEnd(8), String(num(one.regionA)).padStart(8), String(num(one.unkeyed)).padStart(8),
    String(num(one.askable)).padStart(8), String(num(one.asked)).padStart(9), String(num(one.agreed)).padStart(9),
    String(num(one.disputed)).padStart(9), percent(num(one.disputed), num(one.asked)).padStart(13),
  );
}

console.log("\n  WITH #233's GUARD -- no absence from a body with a read off an interface or an");
console.log("  abstract type, the rule `@calls` already accuses under.");
console.log("  language   bodies left  of askable     asked    agreed  disputed  dispute rate");
for (const language of LANGUAGES) {
  const one = data.tallies[language];
  if (!one || num(one.askable) === 0) continue;
  console.log(
    " ", language.padEnd(8), String(num(one.guardedBodies)).padStart(12),
    percent(num(one.guardedBodies), num(one.askable)).padStart(11),
    String(num(one.guardedAsked)).padStart(9), String(num(one.guardedAgreed)).padStart(9),
    String(num(one.guardedDisputed)).padStart(9),
    percent(num(one.guardedDisputed), num(one.guardedAsked)).padStart(13),
  );
}

console.log("\n  DISPUTED, by what the reader saw at that member. The dispute rate is an upper");
console.log("  bound: the referee cannot say what `.member` is read off, so it disputes a read");
console.log("  off anything. `placed-elsewhere` is a false red only if the placement is wrong.");
console.log("  language  never-seen  placed-elsewhere  (of it abstract)  placed-outside   who can decide");
for (const language of LANGUAGES) {
  const one = data.tallies[language];
  if (!one || num(one.asked) === 0) continue;
  console.log(
    " ", language.padEnd(8), String(num(one.neverSeen)).padStart(10), String(num(one.placedElsewhere)).padStart(17),
    String(num(one.elsewhereAbstract)).padStart(17), String(num(one.placedOutside)).padStart(15),
    `   ${ORACLE[language] ?? ""}`,
  );
}

console.log("\n  HELPER -- asks where a one-hop callee reads that member off that type. An arrow a");
console.log("  person would call right, which a direct-read refutation would turn red. Not part of");
console.log("  the rate: whether it is false depends on what the word means.");
console.log("  language     asked   helper    share   calls not all followed   unrefereed names");
for (const language of LANGUAGES) {
  const one = data.tallies[language];
  if (!one || num(one.asked) === 0) continue;
  console.log(
    " ", language.padEnd(8), String(num(one.asked)).padStart(9), String(num(one.helper)).padStart(8),
    percent(num(one.helper), num(one.asked) - num(one.helperUnknown)).padStart(8),
    String(num(one.helperUnknown)).padStart(24), String(num(one.unrefereed)).padStart(18),
  );
}

for (const kind of ["never-seen", "placed-elsewhere", "placed-outside"] as const) {
  const these = data.disputes.filter((one) => one.kind === kind);
  if (these.length === 0) continue;
  console.log(`\n  ${kind.toUpperCase()} -- ${these.length}`);
  for (const one of these.slice(0, cap(these.length, 15))) {
    const notes = [one.notConcrete ? "abstract" : "", one.elsewhereInherits ? "has a parent" : ""].filter(Boolean).join(", ");
    const where = one.elsewhere ? ` (reader: off ${one.elsewhere}${notes ? `, ${notes}` : ""})` : "";
    const tags = `${one.helper ? " [helper]" : ""}${one.guarded ? " [guarded]" : ""}`;
    console.log(`    ${one.file}:${one.line} ${one.routine} reads ${one.member}, asked off ${one.type}${where}${tags}`);
  }
  if (these.length > cap(these.length, 15)) console.log(`    ... and ${these.length - 15} more (--all prints every one)`);
}

// Explicit, like the JSON path: nothing left to wait for once the report is out.
process.exit(0);
