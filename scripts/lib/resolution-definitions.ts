/**
 * "Go to definition" at a call's own name, in batch, for the languages whose
 * checker is a language server (#reach).
 *
 * `ClosedBodyReferee.declarationAt` has existed since #255 and has only ever
 * been answered for TypeScript, where `ts.Program` is in-process and
 * synchronous. Python's and Rust's servers answer the same question
 * (`methodDeclarationLocationAt` on both clients) and nothing asked them,
 * because the engine's own hook is synchronous and theirs are not.
 *
 * `resolution-python-live.ts` settled that seam already: record what would be
 * asked, answer it all at once, read the answers back synchronously. This is
 * the same seam for a different question, and it is a separate file rather
 * than a fourth export on each client because the shape is shared and the two
 * clients are not -- pyright is one server per tree, rust-analyzer is one per
 * crate root, and folding both into either client would put half of each
 * language's setup in the other's file.
 *
 * ## Why this question and not the receiver's type
 *
 * They are not the same question and Rust is where the difference shows.
 * `Orangutan::new(addr)` is a constructor, spelled the way Rust spells them:
 * a *type* at the receiver position, not a value. `typeDefinition` has
 * nothing to answer about it -- `resolveRustReceivers` counts these as
 * `pathReceiver` and calls them "the single biggest reason Rust's reach is
 * below TypeScript's". Asked as a definition instead, at `new`'s own
 * position, rust-analyzer points straight at `impl Orangutan { fn new }`.
 *
 * ## What a caller may do with the answer
 *
 * Follow it, and nothing else. A definition can name a trait method or an
 * interface method whose implementation lives on whatever satisfies it, which
 * is item 14's hazard (docs/claim-vocabulary.md) in the one shape a location
 * cannot distinguish. `reach.ts` follows these hops and keeps the site open,
 * so no accusation rests on one. `"outside"` is the exception and settles a
 * site: a call the compiler places outside the repository provably is not a
 * routine in it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { createPyrightLspReferee } from "./resolution-python-lsp";
import { cargoRootsIn } from "./resolution-rust-receivers";
import { createRustAnalyzerReferee, isOutsideRustTree, type RustLspReferee } from "./resolution-rust-lsp";
import { isOutsideTree } from "./resolution-ts";

/** Structurally `ClosedBodyReferee.declarationAt`'s answer, not imported -- the engine holds no dependency on anything under `scripts/lib`. */
export type DefinitionAnswer = { file: string; line: number } | "outside";

export interface DefinitionQuery {
  /** Repo-relative, matching `CallSide.file`. */
  file: string;
  at: { start: number; end: number };
}

export interface DefinitionCache {
  get(file: string, at: { start: number; end: number }): DefinitionAnswer | undefined;
}

export interface DefinitionAnswers {
  cache: DefinitionCache;
  close: () => void;
  /** Whether any server started. False when the tool is absent or nothing claimed a query. */
  started: boolean;
}

const queryKey = (file: string, at: { start: number; end: number }): string =>
  `${file}:${at.start}:${at.end}`;

const EMPTY: DefinitionAnswers = { cache: { get: () => undefined }, close: () => {}, started: false };

/** How many questions are in flight at once. The same number the receiver resolvers use. */
const CONCURRENCY = 32;

/** Each file read at most once, however many queries land in it. */
function readerOf(root: string): (file: string) => string {
  const sources = new Map<string, string>();
  return (file) => {
    const absolute = path.resolve(root, file);
    let text = sources.get(absolute);
    if (text === undefined) {
      try { text = readFileSync(absolute, "utf8"); } catch { text = ""; }
      sources.set(absolute, text);
    }
    return text;
  };
}

/**
 * Runs `ask` over every query, several at a time, writing into `cache`.
 *
 * A key is claimed before the question is put, so the same call site asked
 * twice in one batch costs one round trip -- and a claimed key that comes
 * back with nothing stays a real cached answer of "asked, nothing said",
 * which is why the cache is a `Map` rather than a lookup with a default.
 */
async function run(
  queries: readonly DefinitionQuery[],
  cache: Map<string, DefinitionAnswer | undefined>,
  ask: (query: DefinitionQuery) => Promise<DefinitionAnswer | undefined>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const query = queries[cursor++];
      if (query === undefined) return;
      const key = queryKey(query.file, query.at);
      if (cache.has(key)) continue;
      cache.set(key, undefined);
      try {
        const answer = await ask(query);
        if (answer) cache.set(key, answer);
      } catch {
        // A question that failed in a way the client does not itself turn
        // into `undefined` -- its process died mid-batch, say. Unresolved,
        // never guessed at.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queries.length) }, worker));
}

/** Rust: one rust-analyzer per crate root, because it resolves against a crate graph. */
export async function resolveRustDefinitions(
  root: string,
  queries: readonly DefinitionQuery[],
  skip: ReadonlySet<string> = new Set(["node_modules", ".git", "target", "vendor"]),
  pool?: RefereePool<RustLspReferee>,
): Promise<DefinitionAnswers> {
  if (queries.length === 0) return EMPTY;
  const crateRoots = cargoRootsIn(root, skip);
  if (crateRoots.length === 0) return EMPTY;

  const byCrate = new Map<string, DefinitionQuery[]>();
  for (const query of queries) {
    const absolute = path.resolve(root, query.file);
    const owner = crateRoots
      .filter((one) => absolute === one || absolute.startsWith(one + path.sep))
      .sort((a, b) => b.length - a.length)[0];
    if (!owner) continue;
    const list = byCrate.get(owner) ?? [];
    list.push(query);
    byCrate.set(owner, list);
  }

  const cache = new Map<string, DefinitionAnswer | undefined>();
  const sourceOf = readerOf(root);
  const mine = pool ?? refereePool<RustLspReferee>();
  let started = false;

  for (const [crate, crateQueries] of byCrate) {
    // #237's settled distribution decision: a server that will not start is
    // silence, not a fetcher and not a retry.
    const referee = await mine.get(crate, () => createRustAnalyzerReferee(crate));
    if (!referee) continue;
    started = true;
    // Asking before rust-analyzer says it has finished indexing is what made
    // #246's first reading swing between 68.7% and 13.6% on identical input.
    await referee.warmUp();
    await run(crateQueries, cache, async (query) => {
      const found = await referee.methodDeclarationLocationAt(
        path.resolve(root, query.file), sourceOf(query.file), query.at.start, query.at.end,
      );
      if (!found) return undefined;
      if (isOutsideRustTree(found.file, root)) return "outside";
      return { file: path.relative(root, found.file), line: found.line + 1 };
    });
  }

  return {
    cache: { get: (file, at) => cache.get(queryKey(file, at)) },
    // A pool the caller owns is the caller's to close; one made here is ours.
    close: () => { if (!pool) mine.close(); },
    started,
  };
}

/** Python: one pyright for the whole tree. */
export async function resolvePythonDefinitions(
  root: string,
  queries: readonly DefinitionQuery[],
  pool?: RefereePool<Awaited<ReturnType<typeof createPyrightLspReferee>>>,
): Promise<DefinitionAnswers> {
  if (queries.length === 0) return EMPTY;
  const sourceOf = readerOf(root);
  const mine = pool ?? refereePool<Awaited<ReturnType<typeof createPyrightLspReferee>>>();
  // Nothing reachable -- no network the first time `npx` needs pyright, no
  // node. Every query stays unresolved, which costs nothing beyond the
  // silence there was before this file existed.
  const referee = await mine.get(root, () => createPyrightLspReferee(root));
  if (!referee) return EMPTY;

  const first = queries[0]!;
  try {
    await referee.warmUp(path.resolve(root, first.file), sourceOf(first.file), first.at.start);
  } catch {
    // Warming up only buys speed; every query below still gets its own answer.
  }

  const cache = new Map<string, DefinitionAnswer | undefined>();
  await run(queries, cache, async (query) => {
    const absolute = path.resolve(root, query.file);
    const found = await referee.methodDeclarationLocationAt(
      absolute, sourceOf(query.file), query.at.start, query.at.end,
    );
    if (!found) return undefined;
    if (isOutsideTree(found.file, root)) return "outside";
    return { file: path.relative(root, found.file), line: found.line + 1 };
  });

  return {
    cache: { get: (file, at) => cache.get(queryKey(file, at)) },
    close: () => { if (!pool) mine.close(); },
    started: true,
  };
}

/* ------------------------------------------------------- sharing a server */

/**
 * One language server per key, shared between everything that asks for it.
 *
 * Both resolvers in this file, and both receiver resolvers beside it, own
 * their servers' lifetimes -- which is right when each is the only caller and
 * wrong the moment two of them run over the same tree in the same check.
 * Measured on `rust-test`: three crate roots, two resolvers, three rounds, and
 * rust-analyzer started **six** times for 106 questions. Sixty-four seconds,
 * almost none of it answering anything. Pooled, a crate's server is started
 * once and asked by both.
 *
 * A `Promise` per key rather than a referee, so two callers racing for the
 * same crate wait on one startup instead of beginning two. A key whose
 * startup failed is remembered as `undefined` and not retried: rust-analyzer
 * missing is not a transient condition, and #237's settled answer to it is
 * silence rather than a retry loop.
 */
export interface RefereePool<T> {
  get(key: string, start: () => Promise<T>): Promise<T | undefined>;
  close(): void;
}

export function refereePool<T extends { close(): void }>(
  /**
   * When given, the pool stops **starting** servers after this moment. One
   * already up keeps answering for as long as its caller asks.
   *
   * This is where the ceiling has to be, and finding that out took two
   * attempts. A budget checked between batches does not bound anything: a
   * single batch over `rust-test`'s three crate roots is sixty seconds, and
   * the check happens after it. Pooling the servers did not move it either.
   * What costs is a language server *loading a project* -- cargo metadata and
   * a fresh index, once per crate root -- and the only way to bound that is
   * to stop asking for the next one.
   *
   * Degrading this way costs confirmations in the crates that were not
   * reached and can never produce a wrong answer, which is the direction
   * everything here errs in.
   */
  until?: number,
): RefereePool<T> {
  const open = new Map<string, Promise<T | undefined>>();
  return {
    get(key, start) {
      let held = open.get(key);
      if (!held) {
        if (until !== undefined && Date.now() >= until) return Promise.resolve(undefined);
        held = start().catch(() => undefined);
        open.set(key, held);
      }
      return held;
    },
    close() {
      for (const held of open.values()) held.then((one) => one?.close(), () => {});
      open.clear();
    },
  };
}
