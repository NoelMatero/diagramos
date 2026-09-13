/**
 * One repository, read once: sources, bindings, bodies, imports -- and the
 * name-based callee resolver `measure:dataflow`'s third section rests on.
 *
 * Lifted out of `scripts/measure-dataflow.mts` unchanged so a second
 * measurement can put a *different* resolver beside this one and have the
 * comparison mean something. A copy would not: the question
 * `measure:dataflow-reach` asks is which call sites this resolver refuses and
 * another places, and a reimplementation drifting by one rule would answer it
 * with its own bugs.
 *
 * The resolver's three answers and its refusal are documented on `resolver`
 * below, and they are the whole of what "+ resolved calls" meant in #203's
 * 1.4%.
 */
import { bindingsIn, callsBetween, type Bindings, type CallSide } from "../../src/engine/calls";
import { readBodies, type Body, type Callee, type Resolver } from "../../src/engine/dataflow";
import { readDependencies } from "../../src/engine/deps";
import { createWorkspace } from "../../src/engine/drift";
import { languageOf } from "../../src/engine/parse";
import { type ConfigCache } from "../../src/engine/resolve";

/** One repository's lazily-built index: sources, bindings, bodies, imports. */
export function indexOf(tree: string, note?: (how: string) => void) {
  const workspace = createWorkspace(tree);
  const configs: ConfigCache = new Map();
  const sources = new Map<string, string | undefined>();
  const bindings = new Map<string, Bindings | undefined>();
  const bodies = new Map<string, Body[]>();
  const importsOf = new Map<string, CallSide["imports"]>();

  const read = (rel: string): string | undefined => {
    if (sources.has(rel)) return sources.get(rel);
    const absolute = workspace.resolve(rel);
    const text = absolute && workspace.stat(absolute) === "file"
      ? workspace.read(absolute)
      : undefined;
    sources.set(rel, text);
    return text;
  };

  const bindingsFor = (rel: string): Bindings | undefined => {
    if (bindings.has(rel)) return bindings.get(rel);
    const source = read(rel);
    const language = languageOf(rel);
    const found = source !== undefined && language
      ? bindingsIn(source, language)
      : undefined;
    bindings.set(rel, found);
    return found;
  };

  const bodiesFor = (rel: string): Body[] => {
    const cached = bodies.get(rel);
    if (cached) return cached;
    const source = read(rel);
    const language = languageOf(rel);
    const found = source !== undefined && language && source.length <= 400_000
      ? readBodies(source, language).bodies
      : [];
    bodies.set(rel, found);
    return found;
  };

  const importsFor = (rel: string): CallSide["imports"] => {
    const cached = importsOf.get(rel);
    if (cached) return cached;
    const source = read(rel);
    const declared = source === undefined
      ? []
      : readDependencies(rel, source, workspace, configs)?.dependencies ?? [];
    const list = declared.map((one) =>
      ({ specifier: one.specifier, ...(one.file ? { file: one.file } : {}) }));
    importsOf.set(rel, list);
    return list;
  };

  /** The routine of that name in that file, if exactly one body carries it. */
  const routineIn = (rel: string, name: string): Callee | undefined => {
    const found = bodiesFor(rel).filter((one) => one.routine === name);
    // Two routines of one name in one file is a question with two answers, and
    // picking one would be inventing the resolution rather than reading it.
    return found.length === 1 ? { body: found[0]!, file: rel } : undefined;
  };

  /**
   * Which routine a called name means, read the way `calls.ts` reads a binding.
   *
   * Three answers and a refusal. Declared here, imported from a file this
   * repository holds, or forwarded through one barrel -- and `undefined` for
   * everything else, which is what keeps a call an exit. A name bound twice, or
   * brought in by a wildcard, is a refusal on the same footing `calls.ts`
   * refuses it: the text does not say which.
   */
  const resolver = (rel: string): Resolver => (callee: string) => {
    const bound = bindingsFor(rel);
    if (!bound || bound.wildcard || bound.ambiguous.has(callee)) return undefined;

    if (bound.local.has(callee)) {
      const own = routineIn(rel, callee);
      if (own) note?.("declared here");
      return own;
    }

    const imported = bound.imported.get(callee);
    if (!imported || imported.namespace) return undefined;
    const from = importsFor(rel).find((one) => one.specifier === imported.specifier);
    if (!from?.file) return undefined;

    const direct = routineIn(from.file, callee);
    if (direct) { note?.("imported"); return direct; }

    /*
     * One hop through a barrel, which `calls.ts` needed for the same reason:
     * `from graphify.extract import extract_objc` where `extract.py` re-exports
     * what `extractors/objc.py` declares. One hop and no further -- a chain of
     * barrels is a call graph, and that is the line this does not cross.
     */
    const onward = bindingsFor(from.file)?.forwarded.get(callee);
    if (!onward) return undefined;
    const next = importsFor(from.file).find((one) => one.specifier === onward.specifier);
    if (!next?.file) return undefined;
    const forwarded = routineIn(next.file, callee);
    if (forwarded) note?.("forwarded once");
    return forwarded;
  };

  /** #189's reader, asked whether the call this resolver followed is there. */
  const confirms = (rel: string, routine: string, callee: Callee): boolean => {
    const source = read(rel);
    const target = read(callee.file);
    const language = languageOf(rel);
    const targetLanguage = languageOf(callee.file);
    if (source === undefined || target === undefined || !language || !targetLanguage) {
      return true; // Nothing to check against is not a disagreement.
    }
    const verdict = callsBetween(
      { file: rel, source, language, imports: importsFor(rel), routine },
      { file: callee.file, source: target, language: targetLanguage,
        imports: importsFor(callee.file), names: [callee.body.routine] },
    );
    // `withheld` is a doubt rather than a contradiction, and this reader has its
    // own reasons to withhold that say nothing about the resolution.
    return verdict.verdict !== "backwards" && verdict.verdict !== "absent";
  };

  return { resolver, confirms, read, bodiesFor, bindingsFor, importsFor };
}
