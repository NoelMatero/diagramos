/**
 * The second opinion for the languages whose compiler answers over a pipe
 * (#337 part A, closing #334).
 *
 * ## The bad outcome
 *
 * A call written `thing.render()` can only be followed once something says
 * what `thing` is. `referee.ts` gets a TypeScript board that answer in the
 * same breath, because `tsc` is a library and `checkDrift` can call it
 * mid-walk. pyright and rust-analyzer are separate processes that answer a
 * question at a time over a pipe, so the same question on a Python or Rust
 * board was never asked anywhere but the standalone `check-drift` CLI -- and
 * the board said nothing about having got the weaker check. #337's ranking
 * put 57 missed mistakes on that one wall, every one of them Python or Rust,
 * against TypeScript's zero.
 *
 * ## The shape, which was already proven elsewhere
 *
 * `checkDrift` is synchronous and cannot await a pipe. The way round it has
 * been in `scripts/check-drift.mjs` since #226: run the check silently with a
 * referee that answers nothing and writes down every question it was asked,
 * do the asynchronous work once in batches, then run the real check against a
 * plain synchronous lookup of the answers. Three routes were measured for
 * #337 and this is the cheapest of them, as well as the only one that needs
 * no change to `drift.ts` at all.
 *
 * This file is that machinery where the product can reach it, rather than
 * inside a CLI script, and generalised in one way: it takes the caller's own
 * `run` closure instead of a list of boards, so the recording pass and the
 * real pass are provably the same check of the same board.
 *
 * ## What keeps it affordable
 *
 * The same guard `refereedCheck` uses, for the same reason. One ordinary pass
 * first, with no referee, which starts nothing; a board whose arrows all
 * confirmed has nothing a compiler could add, and neither has one whose boxes
 * were skipped for want of an anchor. Only a board that stopped on a receiver
 * pays for a server. Across the thirty Python and Rust boards in the bench,
 * twelve never ask a single question.
 *
 * Beyond that: the recording pass is what decides which servers start, so a
 * Rust board never wakes pyright; the pool holds one server per tree, so a
 * caller that checks the same workspace over and over pays the start once;
 * and a deadline stops new servers being started, after which the arrows that
 * were not reached fall back to the text reading. Degrading that way loses
 * confirmations and can never produce a wrong accusation, which is the
 * direction everything here errs in.
 */
import type { ClosedBodyReferee, DriftReport } from "./drift";
import { languageOf } from "./parse";
import { refereeFor, wouldHelp } from "./referee";
import {
  refereePool, resolvePythonDefinitions, resolvePythonKinds, resolveRustDefinitions, type RefereePool,
} from "./referee-pool";
import type { PyrightLspReferee } from "./referee-python-lsp";
import type { RustLspReferee } from "./referee-rust-lsp";
import { resolvePythonReceivers } from "./referee-python";
import { resolveRustReceivers } from "./referee-rust";
import { compileCrates, type CompiledCrates } from "./referee-rustc";

/** The languages this file can put a question to, in the order a note names them. */
const LIVE_LANGUAGES = ["python", "rust"] as const;
type LiveLanguage = (typeof LIVE_LANGUAGES)[number];

/**
 * How long the language servers get, in total, to *start*, for one check.
 *
 * Not a limit on answering, which is not where the time goes. `#337`'s
 * per-board table measured thirty real bench boards: the questions themselves
 * are tens to hundreds of milliseconds, and the whole rest of the cost is a
 * server loading a project -- 1.0s to 4.1s, once per tree, and once more per
 * crate root in Rust because rust-analyzer wants cargo metadata and a fresh
 * index for each.
 *
 * Twelve seconds because the slowest board measured is 4.1s and the slowest
 * plausible board is several crate roots of that, while a wait past about
 * fifteen is one somebody kills. It is deliberately not tight: the one board
 * that used to need a tight budget was 17.3s, and that turned out to be a bug
 * in how pyright was warmed up rather than a fact about pyright. Fixed, the
 * same board is 1.9s and nothing measured comes close to this ceiling.
 */
export const SERVER_BUDGET_MS = 12_000;

/**
 * How many times the recording pass runs before the answers are taken as
 * final.
 *
 * One, and the reasoning is `scripts/check-drift.mjs`'s, measured there: a
 * `@calls` closed-body check reads one file's bodies, so every question it
 * will ever ask is asked on the first pass. The cross-file walk is not like
 * that -- it reaches a second file only by placing a call in the first -- but
 * each further round buys one more hop and costs another twenty seconds, on a
 * check that runs every turn.
 */
const ROUNDS = 1;

/** Which second opinion a check actually got, for the board to report (#334). */
export interface RefereeNote {
  /** Languages whose compiler or language server answered questions in this check. */
  answered: readonly string[];
  /** Languages that had questions but no server; their arrows got the text reading. */
  silent: readonly string[];
  /** True when the first pass settled everything, so nothing needed asking. */
  nothingToAsk: boolean;
}

export interface LiveCheck {
  report: DriftReport;
  checkedWith: RefereeNote;
}

export interface LiveOptions {
  /** Total time new servers may be started in. Default `SERVER_BUDGET_MS`. */
  budgetMs?: number;
  /**
   * A pool to take servers from, and to leave running afterwards.
   *
   * Given by a caller that checks the same workspace repeatedly and wants the
   * servers warm between checks -- the MCP server and the live board both do.
   * Left out by a one-shot caller, which gets a pool of its own, closed before
   * this returns: a live language server is an open child-process handle and
   * Node will not reach its own natural exit while one is alive.
   */
  pool?: LiveRefereePool;
  /**
   * Whether a Rust `@calls` arrow the text could not settle may be put to
   * the Rust compiler's own call list (#357). Default on. `false` is for a
   * test that wants the text reading alone, or a caller that must not start
   * a build.
   */
  compiler?: boolean;
}

/**
 * The one pool both languages take servers from.
 *
 * Two clients with nothing in common share it because the pool keys on the
 * tree, not the language: pyright is one server per tree and rust-analyzer is
 * one per crate root, and a board that names both gets one of each rather than
 * one of each per resolver. `check-drift.mjs` found that the hard way --
 * `rust-test` started rust-analyzer six times, three crate roots times two
 * resolvers, for 106 questions.
 */
export type LiveRefereePool = RefereePool<PyrightLspReferee & RustLspReferee>;

/**
 * What each language's batch resolvers are called, behind one shape.
 *
 * `kinds` is the wrong-kind check's question (#343): what the value declared
 * at a name is. Python's is pyright; Rust has none and is never asked, since
 * `drift.ts` puts no Rust value to a compiler.
 */
type Resolvers = {
  receivers: (root: string, queries: Query[], pool: LiveRefereePool) => Promise<Resolved>;
  definitions: (root: string, queries: Query[], pool: LiveRefereePool) => Promise<Resolved>;
  kinds?: (root: string, queries: Query[], pool: LiveRefereePool) => Promise<Resolved>;
};
type Kind = "receiver" | "definition" | "kind";
/*
 * Asked in this order, and the order is the key order here. "Go to
 * definition" goes last (#351): `@calls` puts every call it cannot place to
 * it, and on a Python board those are often positions nothing can answer --
 * `sink.send()` on an untyped parameter -- whose warm-up then waits out
 * pyright's whole ladder. Asked first, that spent the budget and left the
 * wrong-kind check's question unasked; asked after a batch that did get an
 * answer, the server is known to be bound and it waits for nothing.
 */
const BATCHES = { receiver: "receivers", kind: "kinds", definition: "definitions" } as const;
interface Query { file: string; at: { start: number; end: number } }
interface Resolved {
  cache: { get(file: string, at: { start: number; end: number }): unknown };
  close: () => void;
  started: boolean;
}

/*
 * Wrapped rather than passed straight through because Rust's two take a `skip`
 * set that Python's have no use for, and a caller threading `undefined` into a
 * positional slot to reach the pool is how the pool lands in the wrong
 * argument. `check-drift.mjs` wrote that comment first and it was right.
 */
const RESOLVERS: Record<LiveLanguage, Resolvers> = {
  python: {
    receivers: (root, queries, pool) => resolvePythonReceivers(root, queries, pool) as Promise<Resolved>,
    definitions: (root, queries, pool) => resolvePythonDefinitions(root, queries, pool) as Promise<Resolved>,
    kinds: (root, queries, pool) => resolvePythonKinds(root, queries, pool) as Promise<Resolved>,
  },
  rust: {
    receivers: (root, queries, pool) => resolveRustReceivers(root, queries, undefined, pool) as Promise<Resolved>,
    definitions: (root, queries, pool) => resolveRustDefinitions(root, queries, undefined, pool) as Promise<Resolved>,
  },
};

/** A pool of the right shape for `LiveOptions.pool`, for a caller holding one. */
export function liveRefereePool(until?: () => number): LiveRefereePool {
  return refereePool<PyrightLspReferee & RustLspReferee>(until);
}

/**
 * A check, run again with whatever second opinion this repository can give.
 *
 * The asynchronous sibling of `refereedCheck`, and a superset of it: the
 * TypeScript referee still answers in process, and Python's and Rust's are
 * harvested first and read back synchronously. `run` is called once with no
 * referee, then (only if that pass stopped on a receiver) once per recording
 * round, then once more for the answer that is returned.
 */
export async function refereedCheckLive(
  root: string,
  run: (referee?: ClosedBodyReferee) => DriftReport,
  options: LiveOptions = {},
): Promise<LiveCheck> {
  const first = run(undefined);
  /*
   * Two second opinions, each asked only where it can change something. The
   * language servers answer receivers and definitions; the Rust compiler
   * answers a Rust arrow's whole call list (#357), and a board with nothing
   * else open never starts a server for it.
   */
  const askServers = wouldHelp(first);
  const askCompiler = options.compiler !== false && first.claims.callsCompilable > 0;
  if (!askServers && !askCompiler) {
    return { report: first, checkedWith: { answered: [], silent: [], nothingToAsk: true } };
  }

  const until = Date.now() + (options.budgetMs ?? SERVER_BUDGET_MS);
  const pool = options.pool ?? refereePool<PyrightLspReferee & RustLspReferee>(until);
  const ownPool = options.pool === undefined;

  /** The in-process half. Unchanged, and free relative to anything below. */
  const ts = refereeFor(root);

  const none: Answer = () => undefined;
  const answers: Record<LiveLanguage, Record<Kind, Answer>> = {
    python: { receiver: none, definition: none, kind: none },
    rust: { receiver: none, definition: none, kind: none },
  };
  const answered = new Set<string>();
  const silent = new Set<string>();
  const closers: (() => void)[] = [];
  /** Rust tails whose arrows asked for the compiler's list, and the builds that answer them. */
  const compilable = new Set<string>();
  let crates: Promise<CompiledCrates> | undefined;

  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      const fresh: Record<LiveLanguage, Record<(typeof BATCHES)[Kind], Query[]>> = {
        python: { receivers: [], definitions: [], kinds: [] },
        rust: { receivers: [], definitions: [], kinds: [] },
      };
      const asked: Record<Kind, Set<string>> = {
        receiver: new Set(), definition: new Set(), kind: new Set(),
      };

      /*
       * The recording referee. TypeScript is answered for real even on this
       * pass, on purpose: a mixed board reaches its Python files only through
       * the calls the compiler places, so a recording pass that stayed quiet
       * about TypeScript would harvest fewer Python questions than the real
       * pass then asks.
       */
      const record = (
        kind: Kind,
        real: ((file: string, at: { start: number; end: number }) => unknown) | undefined,
      ) => (file: string, at: { start: number; end: number }): never | undefined => {
        const language = languageOf(file);
        if (language !== "python" && language !== "rust") return real?.(file, at) as never;
        if (!askServers || !RESOLVERS[language][BATCHES[kind]]) return undefined;
        const known = answers[language][kind](file, at);
        if (known !== undefined) return known as never;
        const key = `${language}:${file}:${at.start}:${at.end}`;
        if (!asked[kind].has(key)) {
          asked[kind].add(key);
          fresh[language][BATCHES[kind]].push({ file, at });
        }
        return undefined;
      };
      const recording: ClosedBodyReferee = {
        resolveReceiver: record("receiver", ts?.resolveReceiver.bind(ts)) as ClosedBodyReferee["resolveReceiver"],
        declarationAt: record("definition", ts?.declarationAt?.bind(ts)) as ClosedBodyReferee["declarationAt"],
        kindAt: record("kind", ts?.kindAt?.bind(ts)) as ClosedBodyReferee["kindAt"],
        // TypeScript's alone, and answered on the spot: no language server is asked.
        renderableAt: ts?.renderableAt?.bind(ts),
        ...(askCompiler
          ? { compiledCrateOf: (file: string) => { compilable.add(file); return undefined; } }
          : {}),
      };

      try {
        // This pass's own report is never read. Only the questions matter, and
        // the real check below runs again from the same board and workspace.
        run(recording);
      } catch {
        // A board this pass cannot read is one whose real check will say so.
      }

      /*
       * Started before the servers are waited on, so a build and a server's
       * start run side by side inside the one budget rather than one after
       * the other.
       */
      if (compilable.size > 0 && !crates) {
        crates = compileCrates(root, [...compilable], { until });
      }

      let asking = false;
      for (const language of LIVE_LANGUAGES) {
        for (const kind of Object.keys(BATCHES) as Kind[]) {
          const queries = fresh[language][BATCHES[kind]];
          const resolve = RESOLVERS[language][BATCHES[kind]];
          if (queries.length === 0 || !resolve) continue;
          asking = true;
          if (Date.now() >= until) { silent.add(language); continue; }
          const resolved = await resolve(root, queries, pool);
          closers.push(resolved.close);
          if (resolved.started) answered.add(language); else silent.add(language);
          const previous = answers[language][kind];
          answers[language][kind] = (file, at) => previous(file, at) ?? resolved.cache.get(file, at);
        }
      }
      if (!asking) break;
    }

    const compiled = crates ? await crates : undefined;
    if (compiled?.answered) answered.add("rustc");
    else if (crates) silent.add("rustc");

    /*
     * The merged referee the real check reports through. No half knows the
     * others exist; only `languageOf(file)` decides which one a query reaches.
     */
    const merged: ClosedBodyReferee = {
      resolveReceiver: (file, at) => {
        const language = languageOf(file);
        if (language === "python" || language === "rust") {
          return answers[language].receiver(file, at) as never;
        }
        return ts?.resolveReceiver(file, at);
      },
      declarationAt: (file, at) => {
        const language = languageOf(file);
        if (language === "python" || language === "rust") {
          return answers[language].definition(file, at) as never;
        }
        return ts?.declarationAt?.(file, at);
      },
      kindAt: (file, at) => {
        const language = languageOf(file);
        if (language === "python" || language === "rust") {
          return answers[language].kind(file, at) as never;
        }
        return ts?.kindAt?.(file, at);
      },
      renderableAt: (file, at) => ts?.renderableAt?.(file, at),
      ...(compiled?.answered ? { compiledCrateOf: (file: string) => compiled.crateOf(file) } : {}),
    };
    if (ts) answered.add("typescript");

    return {
      report: run(merged),
      checkedWith: {
        answered: [...answered].sort(),
        silent: [...silent].filter((one) => !answered.has(one)).sort(),
        nothingToAsk: false,
      },
    };
  } finally {
    for (const close of closers) close();
    if (ownPool) pool.close();
  }
}

type Answer = (file: string, at: { start: number; end: number }) => unknown;

/**
 * Which check a board got, in words somebody who has not read this file can
 * act on (#334).
 *
 * A board checked with a compiler and a board checked without one are not the
 * same claim, and until this existed they looked identical.
 */
export function refereeSentence(note: RefereeNote): string {
  const NAMES: Record<string, string> = {
    typescript: "the TypeScript compiler",
    python: "pyright",
    rust: "rust-analyzer",
    rustc: "the Rust compiler",
  };
  const list = (names: readonly string[]): string => {
    const spelled = names.map((one) => NAMES[one] ?? one);
    if (spelled.length <= 1) return spelled.join("");
    return `${spelled.slice(0, -1).join(", ")} and ${spelled[spelled.length - 1]}`;
  };
  if (note.nothingToAsk) return "checked against the code; nothing was left for a compiler to settle";
  if (note.answered.length === 0) {
    const missing = note.silent.length > 0 ? ` (${list(note.silent)} did not answer)` : "";
    return `checked against the text only${missing}`;
  }
  const partial = note.silent.length > 0
    ? `; ${list(note.silent)} did not answer, so those arrows got the text reading`
    : "";
  return `checked with ${list(note.answered)}${partial}`;
}
