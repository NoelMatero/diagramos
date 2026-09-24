/**
 * The second opinion a `@calls` or `@accesses` check gets when the text alone
 * cannot say what a value is (#328).
 *
 * ## What it is for
 *
 * A call written `thing.render()` can only be followed once something says
 * what `thing` is. The reader works that out from the text where it can; where
 * it cannot, the check stops and the arrow goes quiet. #324 counted how often:
 * a receiver whose type is not written down is the single largest reason a
 * `@calls` arrow is never answered at all, 79 of the 168 arrows whose call
 * list could not be closed.
 *
 * The compiler knows the answer. Until this file existed, only the standalone
 * `check-drift` CLI ever asked it: the resolver lived under `scripts/`, the
 * packaged build ships `src/` alone, and so the MCP server -- the thing that
 * runs when Claude draws a board and when anybody calls `check_drift` -- and
 * `bench:planted` both ran the weaker check without saying so.
 *
 * ## What it answers, and what it does not
 *
 * TypeScript only, in process and synchronously, which is what makes it
 * usable from a `checkDrift` call that cannot await anything. Python's and
 * Rust's resolvers answer over a language server: they need a recording pass
 * that collects every question first, starts a server, and asks them in
 * batches (`scripts/check-drift.mjs`'s `harvestFor`). That is asynchronous by
 * construction and takes seconds, so it stays where it is -- the CLI -- and a
 * Python or Rust board checked from the MCP server gets the text reading.
 * `refereeLanguages` says which is which so a caller can tell somebody.
 *
 * A tree with no TypeScript installed gets `undefined` and the same text
 * reading as before, never a crash: see `referee-ts.ts` on why the module is
 * required rather than imported.
 */
import path from "node:path";

import type { ClosedBodyReferee, DriftReport } from "./drift";
import { languageOf } from "./parse";
import { createTsReferee, isOutsideTree, receiverResolutionFrom } from "./referee-ts";

/** The languages `createClosedBodyReferee` can answer for. */
export const REFEREE_LANGUAGES = ["typescript"] as const;

/**
 * A referee for `root`, or `undefined` when nothing here can answer.
 *
 * Built once per root and held: `createTsReferee` keeps its `ts.Program`s warm
 * across calls and re-verifies each one against its files' modification times
 * before trusting it (#234), so a long-lived caller that holds this across
 * many edits gets fresh answers without paying to rebuild the program per
 * check. Building a new referee per check would throw that away and pay the
 * full type-check every time.
 */
export function createClosedBodyReferee(root: string): ClosedBodyReferee | undefined {
  let ts;
  try {
    ts = createTsReferee(root);
  } catch {
    // A tree the walk cannot read, a tsconfig.json that is not JSON, anything
    // `createTsReferee` itself cannot recover from. No referee is an answer;
    // the text reading is what ran before this file existed.
    return undefined;
  }
  if (!ts) return undefined;
  return {
    resolveReceiver: (file, at) => {
      if (languageOf(file) === "python" || languageOf(file) === "rust") return undefined;
      return receiverResolutionFrom(ts.typeAt(path.resolve(root, file), at.start, at.end), root);
    },
    declarationAt: (file, at) => {
      if (languageOf(file) === "python" || languageOf(file) === "rust") return undefined;
      const found = ts.symbolDeclarationLocationAt(path.resolve(root, file), at.start, at.end);
      if (!found) return undefined;
      if (isOutsideTree(found.file, root)) return "outside";
      return { file: path.relative(root, found.file), line: found.line + 1 };
    },
    kindAt: (file, at) => {
      if (languageOf(file) === "python" || languageOf(file) === "rust") return undefined;
      return ts.kindAt(path.resolve(root, file), at.start, at.end);
    },
  };
}

/**
 * The referee for the root last asked about, held for the life of the process.
 *
 * The MCP server checks the same workspace over and over, and the cost this
 * whole file has to justify is building a `ts.Program`. Sharing the referee
 * across checks is what turns that into a once-per-process cost rather than a
 * once-per-check one; the freshness check inside it is what keeps the sharing
 * honest when the files change underneath.
 *
 * **One root, not a map of them,** and that is not a simplification. A
 * referee holds every `ts.Program` it has built, a program for a real
 * repository is hundreds of megabytes, and the first thing that asked about
 * more than one root -- `bench:planted`, walking fifteen pinned clones -- ran
 * out of heap at the eleventh. A caller that serves one workspace (the MCP
 * server, the live board) never notices the limit; one that walks projects in
 * turn drops each as it leaves it, which is the behaviour it wanted anyway.
 */
let held: { root: string; referee: ClosedBodyReferee | undefined } | undefined;
export function refereeFor(root: string): ClosedBodyReferee | undefined {
  const key = path.resolve(root);
  if (held?.root !== key) held = { root: key, referee: createClosedBodyReferee(key) };
  return held.referee;
}

/**
 * A check, run again with the referee when the first run left something a
 * second opinion could change.
 *
 * The guard is what makes this affordable at draw time. Building a
 * `ts.Program` for a repository is the whole cost of this file, and a board
 * whose arrows all confirmed is not going to be improved by a compiler --
 * neither is one whose boxes were skipped for want of an anchor. What is
 * left is the unconfirmed and the accused, and those are the only two worth
 * paying for. A board with none of either pays one ordinary check and
 * nothing else; the first board that has one pays the program build once for
 * the whole process, because `refereeFor` holds it.
 *
 * The second run cannot lose a confirmation the first one found: a call the
 * text showed is still there when a resolver is added, and the resolver only
 * ever places sites the text could not. So stopping early on a clean board is
 * the same answer, not a cheaper worse one.
 *
 * The same shape `scripts/check-drift.mjs` has used since #226, which is where
 * it was proven; this is that guard where the rest of the product can reach it.
 */
export function refereedCheck(
  root: string,
  run: (referee?: ClosedBodyReferee) => DriftReport,
): DriftReport {
  const first = run(undefined);
  if (!wouldHelp(first)) return first;
  const referee = refereeFor(root);
  return referee ? run(referee) : first;
}

/**
 * Whether the first pass stopped on something this referee could answer.
 *
 * The compiler is only asked about one thing: what a value is. So the gate is
 * not "is anything unsettled" but "did the reader refuse for the reason a
 * type answer fixes" -- which the check already records per claim, because
 * #324 made it record why every reading stopped. A board full of arrows the
 * reader simply found no call for has nothing here to gain and does not pay
 * for a program.
 *
 * Asked this way rather than by language on purpose. An unconfirmed arrow
 * carries node ids, not paths, so "is any of this TypeScript" is not a
 * question the report can answer -- but "did a receiver stop the reading" is,
 * and it is the sharper question anyway.
 *
 * The second reason is the other end of the same question (#343): an arrow
 * every reader withheld on, whose end is a value the text cannot say is
 * callable or a type -- `ctx = makeContext()` at the head of an `@calls`.
 * `endsUnsettled` counts those on the pass with no compiler, and a compiler's
 * answer is what turns one into a red or leaves it alone.
 *
 * `@accesses` is not on this list although it takes `declarationAt` too. Its
 * own refusals name what the member list could not say (`no-members`,
 * `aliased`, `incomplete`), never a receiver -- there is no reason in its
 * vocabulary a type answer would move, and the benchmark agrees: `@accesses`
 * scores the same with the referee as without it. If that changes, this is
 * the function to widen.
 */
export function wouldHelp(report: DriftReport): boolean {
  const { callsWithheld, callsNotClosed, endsUnsettled } = report.claims;
  return (callsNotClosed.receiver ?? 0) > 0
    || (callsNotClosed["abstract-receiver"] ?? 0) > 0
    || (callsWithheld.receiver ?? 0) > 0
    || endsUnsettled > 0;
}
