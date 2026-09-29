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
 * `referee-python.ts` settled that seam already: record what would be
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

import { createPyrightLspReferee, WARM_UP_CANDIDATES } from "./referee-python-lsp";
import { pythonDefinitionRunsThere } from "./referee-python";
import { cargoRootsIn, rustDefinitionRunsThere } from "./referee-rust";
import { createRustAnalyzerReferee, isOutsideRustTree, type RustLspReferee } from "./referee-rust-lsp";
import { isOutsideTree, relativeInTree } from "./referee-ts";
import type { DeclaredAt, ImportTarget, MemberTarget, TypeParts } from "./compiler-questions";
import type { ValueKind } from "./parts";

/** Structurally `ClosedBodyReferee.declarationAt`'s answer, not imported -- the engine holds no dependency on anything under `scripts/lib`. */
export type DefinitionAnswer = { file: string; line: number; concrete?: boolean } | "outside";

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

/**
 * A question that carries more than a position (#393): the target a
 * `fitsAt` is asked against, the member a `memberAt` is asked for. Part of
 * the key, so the same position asked about two targets is two questions.
 */
export interface QuestionQuery extends DefinitionQuery {
  extra?: string;
}

const questionKey = (file: string, at: { start: number; end: number }, extra?: string): string =>
  extra === undefined ? queryKey(file, at) : `${queryKey(file, at)}:${extra}`;

const EMPTY: DefinitionAnswers = { cache: { get: () => undefined }, close: () => {}, started: false };

/**
 * Whether a definition's own language says a call landing there runs there
 * (#351). A file that cannot be read is not one a verdict may rest on.
 */
function landsWhereItRuns(
  rule: (source: string, line: number) => boolean,
  sourceOf: (file: string) => string,
  file: string,
  line: number,
): boolean {
  try {
    return rule(sourceOf(file), line);
  } catch {
    return false;
  }
}

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
async function run<Answer>(
  queries: readonly DefinitionQuery[],
  cache: Map<string, Answer | undefined>,
  ask: (query: DefinitionQuery) => Promise<Answer | undefined>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const query = queries[cursor++];
      if (query === undefined) return;
      const key = questionKey(query.file, query.at, (query as QuestionQuery).extra);
      if (cache.has(key)) continue;
      cache.set(key, undefined);
      try {
        // `false` is an answer (#393's `fitsAt`), so only `undefined` is none.
        const answer = await ask(query);
        if (answer !== undefined) cache.set(key, answer);
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
      const file = path.relative(root, found.file);
      return { file, line: found.line + 1, concrete: landsWhereItRuns(rustDefinitionRunsThere, sourceOf, file, found.line + 1) };
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

  try {
    await referee.warmUp(queries.slice(0, WARM_UP_CANDIDATES).map((query) => ({
      file: path.resolve(root, query.file),
      source: sourceOf(query.file),
      start: query.at.start,
    })));
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
    const file = path.relative(root, found.file);
    return { file, line: found.line + 1, concrete: landsWhereItRuns(pythonDefinitionRunsThere, sourceOf, file, found.line + 1) };
  });

  return {
    cache: { get: (file, at) => cache.get(queryKey(file, at)) },
    close: () => { if (!pool) mine.close(); },
    started: true,
  };
}

/** `DefinitionAnswers`' shape, for the kind of a value rather than a definition. */
export interface KindAnswers {
  cache: { get(file: string, at: { start: number; end: number }): ValueKind | undefined };
  close: () => void;
  started: boolean;
}

const NO_KINDS: KindAnswers = { cache: { get: () => undefined }, close: () => {}, started: false };

/**
 * Python: what each value at an arrow's end is, from the same one pyright
 * (#343). Asked at a declaration's own name, which is where the wrong-kind
 * check (`parts.ts`) wants its answer; `valueKindAt` says what is asked.
 */
export async function resolvePythonKinds(
  root: string,
  queries: readonly DefinitionQuery[],
  pool?: RefereePool<Awaited<ReturnType<typeof createPyrightLspReferee>>>,
): Promise<KindAnswers> {
  if (queries.length === 0) return NO_KINDS;
  const sourceOf = readerOf(root);
  const mine = pool ?? refereePool<Awaited<ReturnType<typeof createPyrightLspReferee>>>();
  const referee = await mine.get(root, () => createPyrightLspReferee(root));
  if (!referee) return NO_KINDS;
  try {
    await referee.warmUp(queries.slice(0, WARM_UP_CANDIDATES).map((query) => ({
      file: path.resolve(root, query.file),
      source: sourceOf(query.file),
      start: query.at.start,
    })));
  } catch {
    // Warming up only buys speed; every query below still gets its own answer.
  }
  const cache = new Map<string, ValueKind | undefined>();
  await run(queries, cache, (query) =>
    referee.valueKindAt(path.resolve(root, query.file), sourceOf(query.file), query.at.start));
  return {
    cache: { get: (file, at) => cache.get(queryKey(file, at)) },
    close: () => { if (!pool) mine.close(); },
    started: true,
  };
}

/** `DefinitionAnswers`' shape, for every class a class derives from. */
export interface AncestorAnswers {
  cache: { get(file: string, at: { start: number; end: number }): Array<{ file: string; line: number }> | undefined };
  close: () => void;
  started: boolean;
}

/**
 * Python: every class each class named at a query derives from, from the
 * same one pyright (#362's review). The whole walk up is one answer, so a
 * check that gets one round of questions still learns about a grandparent.
 * Repo-relative, 1-based, and nothing from outside the tree -- the head a
 * caller compares against is always in it.
 */
export async function resolvePythonAncestors(
  root: string,
  queries: readonly DefinitionQuery[],
  pool?: RefereePool<Awaited<ReturnType<typeof createPyrightLspReferee>>>,
): Promise<AncestorAnswers> {
  const nothing: AncestorAnswers = { cache: { get: () => undefined }, close: () => {}, started: false };
  if (queries.length === 0) return nothing;
  const sourceOf = readerOf(root);
  const mine = pool ?? refereePool<Awaited<ReturnType<typeof createPyrightLspReferee>>>();
  const referee = await mine.get(root, () => createPyrightLspReferee(root));
  if (!referee) return nothing;
  try {
    await referee.warmUp(queries.slice(0, WARM_UP_CANDIDATES).map((query) => ({
      file: path.resolve(root, query.file),
      source: sourceOf(query.file),
      start: query.at.start,
    })));
  } catch {
    // Warming up only buys speed; every query below still gets its own answer.
  }
  const cache = new Map<string, Array<{ file: string; line: number }> | undefined>();
  await run(queries, cache, async (query) => {
    const found = await referee.ancestorsAt(path.resolve(root, query.file), sourceOf(query.file), query.at.start);
    return found
      ?.filter((one) => !isOutsideTree(one.file, root))
      .map((one) => ({ file: path.relative(root, one.file), line: one.line + 1 }));
  });
  return {
    cache: { get: (file, at) => cache.get(queryKey(file, at)) },
    close: () => { if (!pool) mine.close(); },
    started: true,
  };
}

/* ------------------------------------------- the questions a red rests on */

/**
 * The four questions of #393 (`compiler-questions.ts`), in batch, for the
 * languages whose checker is a language server. One shape for all of them:
 * answers read back by position and, where the question carries one, its
 * `extra` -- the target a `fitsAt` asks about, the member a `memberAt` asks
 * for.
 */
export interface QuestionAnswers<Answer> {
  cache: { get(file: string, at: { start: number; end: number }, extra?: string): Answer | undefined };
  close: () => void;
  started: boolean;
}

type Pyright = Awaited<ReturnType<typeof createPyrightLspReferee>>;

/** Python's questions, all put to the one pyright the tree has. */
async function askPyright<Answer>(
  root: string,
  queries: readonly QuestionQuery[],
  pool: RefereePool<Pyright> | undefined,
  ask: (referee: Pyright, query: QuestionQuery, absolute: string, source: string) => Promise<Answer | undefined>,
): Promise<QuestionAnswers<Answer>> {
  const nothing: QuestionAnswers<Answer> = { cache: { get: () => undefined }, close: () => {}, started: false };
  if (queries.length === 0) return nothing;
  const sourceOf = readerOf(root);
  const mine = pool ?? refereePool<Pyright>();
  const referee = await mine.get(root, () => createPyrightLspReferee(root));
  if (!referee) return nothing;
  try {
    await referee.warmUp(queries.slice(0, WARM_UP_CANDIDATES).map((query) => ({
      file: path.resolve(root, query.file), source: sourceOf(query.file), start: query.at.start,
    })));
  } catch {
    // Warming up only buys speed; every query below still gets its own answer.
  }
  const cache = new Map<string, Answer | undefined>();
  await run(queries, cache, (query) => ask(referee, query, path.resolve(root, query.file), sourceOf(query.file)));
  return {
    cache: { get: (file, at, extra) => cache.get(questionKey(file, at, extra)) },
    close: () => { if (!pool) mine.close(); },
    started: true,
  };
}

/** Rust's questions, each put to the rust-analyzer of the crate its file is in. */
async function askRustAnalyzer<Answer>(
  root: string,
  queries: readonly QuestionQuery[],
  pool: RefereePool<RustLspReferee> | undefined,
  ask: (referee: RustLspReferee, query: QuestionQuery, absolute: string, source: string) => Promise<Answer | undefined>,
): Promise<QuestionAnswers<Answer>> {
  const nothing: QuestionAnswers<Answer> = { cache: { get: () => undefined }, close: () => {}, started: false };
  if (queries.length === 0) return nothing;
  const crateRoots = cargoRootsIn(root, new Set(["node_modules", ".git", "target", "vendor"]));
  const byCrate = new Map<string, QuestionQuery[]>();
  for (const query of queries) {
    const absolute = path.resolve(root, query.file);
    const owner = crateRoots
      .filter((one) => absolute === one || absolute.startsWith(one + path.sep))
      .sort((a, b) => b.length - a.length)[0];
    if (!owner) continue;
    byCrate.set(owner, [...(byCrate.get(owner) ?? []), query]);
  }
  if (byCrate.size === 0) return nothing;
  const cache = new Map<string, Answer | undefined>();
  const sourceOf = readerOf(root);
  const mine = pool ?? refereePool<RustLspReferee>();
  let started = false;
  for (const [crate, crateQueries] of byCrate) {
    const referee = await mine.get(crate, () => createRustAnalyzerReferee(crate));
    if (!referee) continue;
    started = true;
    await referee.warmUp();
    await run(crateQueries, cache, (query) => ask(referee, query, path.resolve(root, query.file), sourceOf(query.file)));
  }
  return {
    cache: { get: (file, at, extra) => cache.get(questionKey(file, at, extra)) },
    close: () => { if (!pool) mine.close(); },
    started,
  };
}

/** An absolute answer as a place in the repository, or `"outside"`. */
function placedIn(
  root: string, file: string, line: number, outside: (file: string, tree: string) => boolean = isOutsideTree,
): DeclaredAt | "outside" {
  const home = relativeInTree(file, root, outside);
  return home === undefined ? "outside" : { file: home, line: line + 1 };
}

/** Python `typePartsAt`: named parts, from pyright's printed type. */
export function resolvePythonTypeParts(
  root: string, queries: readonly QuestionQuery[], pool?: RefereePool<Pyright>,
): Promise<QuestionAnswers<TypeParts>> {
  return askPyright(root, queries, pool, (referee, query, absolute, source) =>
    referee.typePartsAt(absolute, source, query.at.start, query.at.end));
}

/** Python `fitsAt`. `extra` is the target, as `fitsKey` writes it. */
export function resolvePythonFits(
  root: string, queries: readonly QuestionQuery[], pool?: RefereePool<Pyright>,
): Promise<QuestionAnswers<boolean>> {
  return askPyright(root, queries, pool, (referee, query, absolute, source) => {
    const target = fitsTarget(query.extra);
    if (!target) return Promise.resolve(undefined);
    return referee.fitsAt(absolute, source, query.at.start, query.at.end, {
      file: path.resolve(root, target.file), line: target.line - 1,
    });
  });
}

/** Python `importTargetAt`. */
export function resolvePythonImports(
  root: string, queries: readonly QuestionQuery[], pool?: RefereePool<Pyright>,
): Promise<QuestionAnswers<ImportTarget>> {
  return askPyright(root, queries, pool, async (referee, query, absolute, source) => {
    const found = await referee.importTargetAt(absolute, source, query.at.start, query.at.end);
    if (found === undefined) return undefined;
    const home = relativeInTree(found, root);
    return home === undefined ? "outside" : { file: home };
  });
}

/** Python `memberAt`. `extra` is the member's name. */
export function resolvePythonMembers(
  root: string, queries: readonly QuestionQuery[], pool?: RefereePool<Pyright>,
): Promise<QuestionAnswers<MemberTarget[]>> {
  return askPyright(root, queries, pool, async (referee, query, absolute, source) => {
    if (!query.extra) return undefined;
    const found = await referee.memberAt(absolute, source, query.at.start, query.at.end, query.extra);
    return found?.map((one) => placedIn(root, one.file, one.line));
  });
}

/** Rust `typePartsAt`: every part placed. */
export function resolveRustTypeParts(
  root: string, queries: readonly QuestionQuery[], pool?: RefereePool<RustLspReferee>,
): Promise<QuestionAnswers<TypeParts>> {
  return askRustAnalyzer(root, queries, pool, async (referee, query, absolute, source) => {
    const found = await referee.typePartsAt(absolute, source, query.at.start, query.at.end);
    if (!found) return undefined;
    return {
      whole: found.whole,
      parts: found.parts.map((one) => ({ name: one.name, at: placedIn(root, one.file, one.line, isOutsideRustTree) })),
    };
  });
}

/** Rust `importTargetAt`, for a `use` path or a macro's. */
export function resolveRustImports(
  root: string, queries: readonly QuestionQuery[], pool?: RefereePool<RustLspReferee>,
): Promise<QuestionAnswers<ImportTarget>> {
  return askRustAnalyzer(root, queries, pool, async (referee, query, absolute, source) => {
    const found = await referee.importTargetAt(absolute, source, query.at.start, query.at.end);
    if (found === undefined) return undefined;
    const home = relativeInTree(found, root, isOutsideRustTree);
    return home === undefined ? "outside" : { file: home };
  });
}

/** How a `fitsAt` target travels as a question's `extra`, and back. */
export function fitsKey(target: DeclaredAt): string {
  return `${target.file}#${target.line}`;
}

function fitsTarget(extra: string | undefined): DeclaredAt | undefined {
  const match = extra === undefined ? null : /^(.*)#(\d+)$/.exec(extra);
  return match ? { file: match[1]!, line: Number(match[2]) } : undefined;
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
   *
   * A function rather than a number when the pool outlives the check (#337).
   * The MCP server holds one pool for the life of the process so the servers
   * in it stay warm between checks, and a deadline fixed at construction
   * would mean that process refusing to start a server ever again fifteen
   * seconds after it booted. Asked per call, each check gets its own.
   */
  until?: number | (() => number),
): RefereePool<T> {
  const open = new Map<string, Promise<T | undefined>>();
  const deadline = (): number | undefined =>
    (typeof until === "function" ? until() : until);
  return {
    get(key, start) {
      let held = open.get(key);
      if (!held) {
        const by = deadline();
        if (by !== undefined && Date.now() >= by) return Promise.resolve(undefined);
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
