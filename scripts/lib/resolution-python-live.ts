/**
 * `@calls`' closed-body absence licence, wired live for Python (#243).
 *
 * #233 built this for TypeScript against a synchronous, in-memory `ts.Program`:
 * `CallSide.resolveReceiver` is called deep inside a synchronous engine walk
 * (`calls.ts`'s `placeOf`), so a synchronous resolver was the only kind
 * possible to plug in there. Pyright over its own language-server protocol
 * (`resolution-python-lsp.ts`) is not that -- every answer is a network-shaped
 * round trip to a spawned process, and `CallSide.resolveReceiver`'s own type
 * (`(at) => ReceiverResolution | undefined`) has no `Promise` in it.
 *
 * Rather than push `async` through `calls.ts`, `callSitesIn` and every caller
 * of `checkDrift` -- a change #236's own closing comment never asked for and
 * #226's whole axis was designed without needing -- this answers the
 * question ahead of time instead. `scripts/check-drift.mjs` runs `checkDrift`
 * once with a *recording* resolver that answers every query with `undefined`
 * but remembers what it was asked, awaits pyright for each one exactly once,
 * and only then runs the real, printed check with a synchronous resolver that
 * is nothing but a lookup into what was already answered. Two synchronous
 * passes over the same, unchanged input plus one batch of real async work
 * between them, rather than one pass that cannot exist with this signature.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  createPyrightLspReferee, isOutsideTree,
  type PyrightLspReferee,
} from "./resolution-python-lsp";

/** Structurally `src/engine/calls.ts`'s `ReceiverResolution` -- not imported, for the same reason `resolution-ts.ts` does not import it: the engine holds no dependency on anything under `scripts/lib`. */
export type PythonReceiverResolution =
  | { kind: "declared"; file: string; concrete: boolean }
  | { kind: "external" };

/**
 * Whether a `class Foo(Bases):` header, read as one line of text, names a
 * base that makes it the hazard item 14 already named for TypeScript's
 * interface case: a type whose *methods* can be satisfied by more than one
 * class, so the file it is declared in is not necessarily the file a call
 * through it actually lands in.
 *
 * `abc.ABC`/`ABCMeta` and `typing.Protocol`/`Protocol` are Python's two
 * named shapes of that -- confirmed live before this was written (see the
 * PR this shipped in), the same way #233's own guard was confirmed against
 * a real `ts.Program` rather than assumed from the language's docs:
 * `textDocument/typeDefinition` on a receiver typed as either one answers
 * with the `Protocol`/`ABC`'s own declaration, never the concrete class
 * that actually satisfies it at runtime -- the identical shared-limitation
 * shape, one protocol over.
 *
 * `undefined` -- not a recognisable one-line `class ... :` header at all,
 * a decorator line, a signature split across lines -- withholds rather than
 * guesses, `HEADER_SCAN`'s own stance (`src/engine/licence.ts`) reused here:
 * a smaller sample is never a wrong one. A caller must still return a
 * `boolean` for `PythonReceiverResolution.concrete`, so `undefined` here
 * means "treat as not concrete" one layer up -- the safe direction, since
 * the risk this guards against is a false accusation, not a missed one.
 */
export function isConcreteClassLine(lineText: string): boolean | undefined {
  const withBases = /\bclass\s+\w+\s*\(([^)]*)\)\s*:/.exec(lineText);
  if (withBases) {
    const bases = withBases[1]!;
    if (/\b(?:abc\.)?ABC\b/.test(bases) || /\b(?:typing\.)?Protocol\b/.test(bases)) return false;
    if (/metaclass\s*=\s*(?:abc\.)?ABCMeta/.test(bases)) return false;
    return true;
  }
  if (/\bclass\s+\w+\s*:/.test(lineText)) return true; // no base list at all -- plainly concrete.
  return undefined;
}

/**
 * One receiver query, as `scripts/check-drift.mjs`'s recording pass gathers
 * it: everything `resolveReceiverLive` below needs and nothing it can derive
 * on its own, since the recording pass runs with no live referee at all.
 */
export interface PythonReceiverQuery {
  /** Repo-relative, matching `CallSide.file`. */
  file: string;
  at: { start: number; end: number };
}

/**
 * `PythonReceiverQuery` plus the one live answer it resolved to, keyed the
 * way `PythonClosedBodyCache.get` reads it back: `${file}:${start}:${end}`.
 * `undefined` is a real, cached answer -- "asked, pyright had nothing" --
 * not the same as a key that was never asked at all, which is why the cache
 * itself is a `Map` rather than a plain object with `?? default`.
 */
function queryKey(file: string, at: { start: number; end: number }): string {
  return `${file}:${at.start}:${at.end}`;
}

export interface PythonClosedBodyCache {
  get(file: string, at: { start: number; end: number }): PythonReceiverResolution | undefined;
}

/**
 * Resolves every recorded query once, against one live pyright process, and
 * hands back a synchronous cache -- the async-to-sync seam this whole file
 * exists for.
 *
 * `root` is the tree `file`s in every query are relative to, matching
 * `isOutsideTree`'s own contract. Reads each file's source at most once
 * (`memberRangeAfter`/`isConcreteClassLine` both need the text, not just
 * the range), rather than once per query -- most bodies ask about more than
 * one receiver in the same file.
 */
export async function resolvePythonReceivers(
  root: string,
  queries: readonly PythonReceiverQuery[],
): Promise<{ cache: PythonClosedBodyCache; close: () => void }> {
  const cache = new Map<string, PythonReceiverResolution | undefined>();
  if (queries.length === 0) {
    return { cache: { get: () => undefined }, close: () => {} };
  }

  const sources = new Map<string, string>();
  const sourceOf = (file: string): string => {
    const absolute = path.resolve(root, file);
    let text = sources.get(absolute);
    if (text === undefined) {
      text = readFileSync(absolute, "utf8");
      sources.set(absolute, text);
    }
    return text;
  };
  const declarationLines = new Map<string, string[]>();
  const lineOf = (declaringFile: string, line: number): string => {
    let lines = declarationLines.get(declaringFile);
    if (lines === undefined) {
      lines = readFileSync(declaringFile, "utf8").split("\n");
      declarationLines.set(declaringFile, lines);
    }
    return lines[line] ?? "";
  };

  let referee: PyrightLspReferee;
  try {
    referee = await createPyrightLspReferee(root);
  } catch {
    // No referee reachable (no network the first time `npx` needs to fetch
    // pyright, no node -- anything `createPyrightLspReferee` cannot itself
    // recover from). Every query stays unresolved, costing nothing beyond
    // what `@calls` already withheld before this axis existed for Python.
    return { cache: { get: () => undefined }, close: () => {} };
  }

  const first = queries[0]!;
  try {
    await referee.warmUp(path.resolve(root, first.file), sourceOf(first.file), first.at.start);

    for (const query of queries) {
      const key = queryKey(query.file, query.at);
      if (cache.has(key)) continue;
      const absolute = path.resolve(root, query.file);
      const source = sourceOf(query.file);
      const location = await referee.typeDeclarationLocationAt(
        absolute, source, query.at.start, query.at.end,
      );
      if (!location) { cache.set(key, undefined); continue; }
      if (isOutsideTree(location.file, root)) { cache.set(key, { kind: "external" }); continue; }
      const lineText = lineOf(location.file, location.line);
      const concrete = isConcreteClassLine(lineText) ?? false;
      cache.set(key, { kind: "declared", file: path.relative(root, location.file), concrete });
    }
  } catch {
    // A query mid-batch failed in a way `typeDeclarationLocationAt` itself
    // does not already turn into `undefined` (the referee's own process
    // died, say). Whatever is already cached stays cached; anything not
    // yet asked stays unresolved -- the same "silence over a guess" rule
    // every branch above already follows.
  }

  return {
    cache: { get: (file, at) => cache.get(queryKey(file, at)) },
    close: () => referee.close(),
  };
}
