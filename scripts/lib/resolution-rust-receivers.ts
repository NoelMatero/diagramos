/**
 * Rust's receiver resolver for `measure:closed-bodies` (#256).
 *
 * Item 13 of `docs/claim-vocabulary.md` reversed #221's "don't build it" on one
 * number: with a real checker resolving receivers, half of ts/tsx/js call bodies
 * have a call set the reader can enumerate completely, against 10.6% reading
 * text alone. `measure-closed-bodies.mts` asked that question of TypeScript
 * only, because TypeScript was the only language with a tier-2 resolver when it
 * was written. Rust has one since #246. This is the adapter between them.
 *
 * `resolution-python-live.ts` is the shape, for the reason stated in its own
 * doc: `CallSide.resolveReceiver` is synchronous, called deep inside a
 * synchronous engine walk, and an LSP answer is a round trip. So the caller
 * reads once with a recording resolver, awaits every answer here, and reads
 * again with a synchronous lookup into what came back.
 *
 * Two things differ from Python's, both because rust-analyzer differs from
 * pyright rather than by preference:
 *
 *   - **One server per crate root, not one per tree.** rust-analyzer resolves
 *     against a crate graph; a receiver in a file no `Cargo.toml` claims has no
 *     answer available to it at all. `measure-resolution.mts` learned this at
 *     #246 and `cargoRootsIn` is that walk, moved here so both callers share
 *     one definition rather than two that could drift.
 *   - **The concrete guard reads a keyword, not a base list.** Python's
 *     `isConcreteClassLine` looks for `ABC`/`Protocol` among a class's bases;
 *     Rust states the distinction in the declaration keyword itself, which
 *     `declaredTypeOnLine` already reads. A `trait` is the interface hazard item
 *     14 named -- the method reached at runtime lives on whichever type
 *     implements it, not on the trait -- and a `type` alias could name one, so
 *     both withhold.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  createRustAnalyzerReferee, declaredTypeOnLine, isOutsideRustTree, rustTypeAnchorFor,
  type RustLspReferee,
} from "./resolution-rust-lsp";

/** Structurally `src/engine/calls.ts`'s `ReceiverResolution`, not imported -- `resolution-python-live.ts`'s own reason: the engine holds no dependency on anything under `scripts/lib`. */
export type RustReceiverResolution =
  | { kind: "declared"; file: string; concrete: boolean }
  | { kind: "external" };

/**
 * Whether a call through a receiver of this declared kind lands where the
 * declaration is, or somewhere a runtime decides.
 *
 * `struct`, `enum` and `union` are one type with one set of inherent methods.
 * A `trait` is not: the method actually called lives on whatever implements it,
 * which is item 14's hazard in Rust's own spelling, and `dyn Store` picks the
 * implementation at runtime. A `type` alias resolves to something this line does
 * not state, so it withholds for the same reason `isConcreteClassLine` withholds
 * on a header it cannot read -- a smaller sample is never a wrong one.
 */
export function isConcreteRustDeclaration(
  kind: NonNullable<ReturnType<typeof declaredTypeOnLine>>["kind"],
): boolean {
  return kind === "struct" || kind === "enum" || kind === "union";
}

/**
 * The crate roots inside a tree: every directory holding a `Cargo.toml` that no
 * other `Cargo.toml` directory already contains. A cargo workspace's members
 * each have their own manifest, and starting a server per member indexes the
 * same workspace once per crate; the shallowest manifest is the one
 * rust-analyzer wants, and it finds the members itself.
 *
 * `skip` is the caller's own heavy-directory set, passed in rather than repeated
 * here: a `Cargo.toml` under `target/` or `node_modules/` is a dependency's, not
 * this tree's.
 */
export function cargoRootsIn(root: string, skip: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    if (existsSync(path.join(directory, "Cargo.toml"))) { found.push(directory); return; }
    let entries: string[];
    try { entries = readdirSync(directory); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith(".") || skip.has(entry)) continue;
      const full = path.join(directory, entry);
      try { if (statSync(full).isDirectory()) walk(full); } catch { /* unreadable */ }
    }
  };
  walk(root);
  return found;
}

/** One receiver query, as the caller's recording pass gathers it. */
export interface RustReceiverQuery {
  /** Repo-relative, matching `CallSide.file`. */
  file: string;
  at: { start: number; end: number };
}

export interface RustClosedBodyCache {
  get(file: string, at: { start: number; end: number }): RustReceiverResolution | undefined;
}

export interface RustReceiverAnswers {
  cache: RustClosedBodyCache;
  close: () => void;
  /** Whether any server started. False when rust-analyzer is absent, or no crate claims any query. */
  started: boolean;
  /** Every server said it had finished indexing. False means the numbers rest on answers from a server that never did. */
  primedCleanly: boolean;
  /** Queries in a file no `Cargo.toml` claims -- never asked, and not a refusal. */
  unclaimed: number;
  /** Answers whose declaration line names no type at all (#246's own `notAType`). */
  notATypeDeclaration: number;
  /**
   * Receivers that are a type spelled as a path rather than a value --
   * `String::new()`, `Regex::new(..)`, `Vec::new()`. Never asked: there is no
   * value at that position whose type could be declared anywhere, and Rust
   * spells its constructors this way, so this is the single biggest reason
   * Rust's reach is below TypeScript's rather than a refusal to answer.
   */
  pathReceiver: number;
  /**
   * Receivers `rustTypeAnchorFor` would not place a cursor in at all -- a
   * subscript, unbalanced brackets, a trailing `?`, a trailing path call. Never
   * asked, for the reasons that function's own doc measures.
   */
  anchorWithheld: number;
}

function queryKey(file: string, at: { start: number; end: number }): string {
  return `${file}:${at.start}:${at.end}`;
}

/**
 * Resolves every recorded query against one rust-analyzer per crate root, and
 * hands back a synchronous cache.
 *
 * `root` is the tree every query's `file` is relative to. Answers are keyed by
 * file and range, so a query asked twice is resolved once.
 */
export async function resolveRustReceivers(
  root: string,
  queries: readonly RustReceiverQuery[],
  skip: ReadonlySet<string> = new Set(["node_modules", ".git", "target", "vendor"]),
): Promise<RustReceiverAnswers> {
  const cache = new Map<string, RustReceiverResolution | undefined>();
  const empty: RustReceiverAnswers = {
    cache: { get: () => undefined }, close: () => {}, started: false,
    primedCleanly: false, unclaimed: 0, notATypeDeclaration: 0,
    pathReceiver: 0, anchorWithheld: 0,
  };
  if (queries.length === 0) return empty;

  const crateRoots = cargoRootsIn(root, skip);
  if (crateRoots.length === 0) return { ...empty, unclaimed: queries.length };

  /*
   * Each query to the crate root that claims it, longest match first -- a
   * workspace member inside a workspace is claimed by the member's own
   * shallowest manifest, which `cargoRootsIn` already collapsed to one.
   */
  const byCrate = new Map<string, RustReceiverQuery[]>();
  let unclaimed = 0;
  for (const query of queries) {
    const absolute = path.resolve(root, query.file);
    const owner = crateRoots
      .filter((one) => absolute === one || absolute.startsWith(one + path.sep))
      .sort((a, b) => b.length - a.length)[0];
    if (!owner) { unclaimed += 1; continue; }
    const list = byCrate.get(owner) ?? [];
    list.push(query);
    byCrate.set(owner, list);
  }

  const sources = new Map<string, string>();
  const sourceOf = (file: string): string => {
    const absolute = path.resolve(root, file);
    let text = sources.get(absolute);
    if (text === undefined) {
      try { text = readFileSync(absolute, "utf8"); } catch { text = ""; }
      sources.set(absolute, text);
    }
    return text;
  };
  const declarationLines = new Map<string, string[]>();
  const lineOf = (file: string, line: number): string => {
    let lines = declarationLines.get(file);
    if (lines === undefined) {
      try { lines = readFileSync(file, "utf8").split("\n"); } catch { lines = []; }
      declarationLines.set(file, lines);
    }
    return lines[line] ?? "";
  };

  let started = false;
  let primedCleanly = true;
  let notATypeDeclaration = 0;
  let pathReceiver = 0;
  let anchorWithheld = 0;
  const open: RustLspReferee[] = [];

  for (const [crate, crateQueries] of byCrate) {
    let referee: RustLspReferee;
    try {
      referee = await createRustAnalyzerReferee(crate);
    } catch {
      // No rust-analyzer on this machine, or a manifest it will not load.
      // #237's settled distribution decision: silence, not a fetcher. Every
      // query here stays unresolved, costing nothing beyond what
      // `measure:closed-bodies` already withheld for Rust.
      continue;
    }
    open.push(referee);
    started = true;
    // Asking before rust-analyzer says it has finished indexing is what made
    // #246's first reading swing between 68.7% and 13.6% on identical input.
    await referee.warmUp();
    if (!referee.primedCleanly()) primedCleanly = false;

    const CONCURRENCY = 32;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const query = crateQueries[cursor++];
        if (query === undefined) return;
        const key = queryKey(query.file, query.at);
        if (cache.has(key)) continue;
        cache.set(key, undefined); // claimed, so a duplicate is not asked twice.
        try {
          const source = sourceOf(query.file);
          /*
           * Classified before asking, not after failing: `String::new()` is a
           * type spelled as a path, and there is no value at that position for
           * `typeDefinition` to have an answer about. Counting these apart is
           * what makes Rust's reach readable -- they are the constructor
           * spelling, not a resolver refusal -- and skipping the round trip is
           * free besides.
           */
          if (source.slice(query.at.end, query.at.end + 2) === "::") { pathReceiver += 1; continue; }
          if (!rustTypeAnchorFor(source, query.at.start, query.at.end)) { anchorWithheld += 1; continue; }
          const location = await referee.typeDeclarationLocationAt(
            path.resolve(root, query.file), source, query.at.start, query.at.end,
          );
          if (!location) continue;
          if (isOutsideRustTree(location.file, root)) { cache.set(key, { kind: "external" }); continue; }
          const declared = declaredTypeOnLine(lineOf(location.file, location.line));
          if (!declared) {
            /*
             * An in-tree answer whose line declares no type: a generic
             * parameter, a macro-declared type whose target is the
             * `macro_rules!` body. #259 is Python's version of this and its
             * lesson is the same -- a line that declares no type is a wrong
             * file, not an unsafe one -- so it is withheld and counted.
             */
            notATypeDeclaration += 1;
            continue;
          }
          cache.set(key, {
            kind: "declared",
            file: path.relative(root, location.file),
            concrete: isConcreteRustDeclaration(declared.kind),
          });
        } catch {
          // The referee's own process died mid-batch, or a query failed in a
          // way `typeDeclarationLocationAt` does not already turn into
          // `undefined`. Unresolved, never guessed at.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, crateQueries.length) }, worker));
  }

  return {
    cache: { get: (file, at) => cache.get(queryKey(file, at)) },
    close: () => { for (const one of open.splice(0)) one.close(); },
    started,
    primedCleanly: started && primedCleanly,
    unclaimed,
    notATypeDeclaration,
    pathReceiver,
    anchorWithheld,
  };
}
