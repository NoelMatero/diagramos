/**
 * Turning an import specifier into a file in this repository.
 *
 * `import { x } from "./foo"` is easy. `import { x } from "@/engine/foo"` is
 * not: `@/` is a nickname, and what it stands for lives in `tsconfig.json`. A
 * resolver that does not read those nicknames finds no dependency in a project
 * that uses them -- and "no dependency found" is exactly what would let a later
 * check call a *correct* arrow backwards. A false accusation is the one failure
 * this project cannot afford, so the nicknames are read here.
 *
 * This repository has no nicknames at all: no `paths` in its tsconfig, no
 * aliased import anywhere. Which is the point. The hole is invisible from
 * inside our own tree and would only ever have shown up in somebody else's, as
 * an accusation.
 *
 * ## Where the rules came from
 *
 * The alias rules below are ported from Graphify (Apache-2.0, Copyright 2026
 * Safi Shamsi and the Graphify contributors) --
 * `graphify/extractors/resolution.py`. Not the code: the *rules*, which are a
 * table rather than an algorithm, and which they have paid for in bug reports.
 * Each one below names the case it exists for:
 *
 * - `jsconfig.json` counts too, or a plain-JS project gets no nicknames (#2153).
 * - tsconfigs are JSONC in practice -- SvelteKit, NestJS, Vite, T3, Astro all
 *   ship comments and trailing commas by default (#700).
 * - `extends` chains carry the nicknames in every framework template, and since
 *   TypeScript 5.0 it may be an array (#927).
 * - `paths` are relative to `baseUrl`, not to the config, which is the common
 *   monorepo layout.
 * - Every target is tried in declared order; keeping only the first drops
 *   imports whose file lives at a fallback (#1531).
 * - `baseUrl` alone resolves too, and a config with a baseUrl and no paths used
 *   to yield nothing at all (#2153).
 */
import type { Workspace } from "./workspace";

/**
 * Extensions tried when a specifier names no file that exists as written.
 *
 * Declarations come last, and that order is the whole rule: where a module ships
 * both a `.d.ts` and the code it describes, the code is what somebody would draw
 * a box on. They are here at all because a type-only module is a real file with
 * real dependents -- `import { Foo } from "./utils"` where the only `utils` is
 * `utils.d.ts` is an ordinary edge, and leaving it unresolved was 119 of the 121
 * dependencies the compiler found and this did not, across five repositories.
 */
const EXTENSIONS = [
  ".ts", ".tsx", ".mts", ".cts", ".svelte", ".js", ".jsx", ".mjs", ".cjs",
  ".d.ts", ".d.mts", ".d.cts",
];

/** Tried only after every file candidate has lost, the way Node resolves a directory. */
const INDEX_FILES = ["index.ts", "index.tsx", "index.svelte", "index.js", "index.jsx", "index.mjs"];

/**
 * What a package.json `imports` field contributes.
 *
 * Node's own nicknames, and the reason they need separate handling from the
 * tsconfig kind: they are found by walking up to a `package.json` rather than a
 * `tsconfig.json`, they always begin `#`, and their targets are relative to the
 * package rather than to a `baseUrl`. Vite writes almost all of its internal
 * type imports this way -- `#dep-types/connect` -- and 77 of the 84 dependencies
 * the compiler saw there and this did not were exactly that one form.
 */
interface ImportRules {
  kind: "imports";
  /** The directory holding the package.json, repo-relative. */
  root: string;
  /** `#name/*` to targets, in declared order, wildcards left intact. */
  imports: Map<string, string[]>;
  /** The package's own published name, when it has one. */
  name?: string;
  /** Subpath to targets, for resolving the package against its own name. */
  exports: Map<string, string[]>;
  /** The entry to fall back on when there is no `exports` map. */
  main?: string;
}

/** What one config contributes, with every path already repo-relative. */
interface ConfigRules {
  kind?: undefined;
  /** Nickname pattern to targets, in declared order, wildcards left intact. */
  paths: Map<string, string[]>;
  /** The resolution root of last resort, when the config declares one. */
  baseUrl?: string;
}

/**
 * Configs already read, keyed by the directory the lookup started from.
 *
 * Owned by the caller and never module-level: this process outlives a check,
 * and a tsconfig read once and remembered forever is a fact with a shelf life --
 * the exact rot this tool exists to catch.
 */
export type ConfigCache = Map<string, ConfigRules | ImportRules | undefined>;

/** `a/b/../c` -> `a/c`, without needing to know where the repo root is. */
function normalizeRelative(value: string): string {
  const out: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

function directoryOf(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash < 0 ? "" : file.slice(0, slash);
}

function join(directory: string, rest: string): string {
  return normalizeRelative(directory ? `${directory}/${rest}` : rest);
}

/**
 * JSON with comments and trailing commas, which is what a tsconfig actually is.
 *
 * Quoted strings are matched first and handed back untouched, so a `//` inside
 * a path never looks like a comment.
 */
export function stripJsonc(text: string): string {
  const tokens = /"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
  const withoutComments = text.replace(tokens, (token) => (token.startsWith('"') ? token : ""));
  return withoutComments.replace(/,(\s*[}\]])/g, "$1");
}

/** A config file as data, or undefined when it cannot be read or parsed at all. */
function readConfig(relative: string, workspace: Workspace): Record<string, unknown> | undefined {
  const absolute = workspace.resolve(relative);
  if (!absolute || workspace.stat(absolute) !== "file") return undefined;
  let raw: string;
  try {
    raw = workspace.read(absolute);
  } catch {
    return undefined;
  }
  for (const candidate of [raw, stripJsonc(raw)]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // A malformed config is no nicknames, never a failed run: this is
      // somebody else's file and it does not get to break the check.
    }
  }
  return undefined;
}

/** The nearest tsconfig/jsconfig walking up. tsconfig wins when both sit together. */
function findConfig(startDirectory: string, workspace: Workspace): string | undefined {
  let directory: string | undefined = startDirectory;
  while (directory !== undefined) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = join(directory, name);
      const absolute = workspace.resolve(candidate);
      if (absolute && workspace.stat(absolute) === "file") return candidate;
    }
    if (directory === "") break;
    directory = directoryOf(directory);
  }
  return undefined;
}

/** One config plus everything it extends, child overriding parent. Cycle-guarded. */
function rulesFrom(configFile: string, workspace: Workspace, seen: Set<string>): ConfigRules {
  const empty: ConfigRules = { paths: new Map() };
  if (seen.has(configFile)) return empty;
  seen.add(configFile);

  const data = readConfig(configFile, workspace);
  if (!data) return empty;
  const directory = directoryOf(configFile);

  const paths = new Map<string, string[]>();
  const extendsField = data.extends;
  const parents = typeof extendsField === "string"
    ? [extendsField]
    : Array.isArray(extendsField) ? extendsField.filter((entry): entry is string => typeof entry === "string") : [];
  for (const parent of parents) {
    // A scoped package config (`@tsconfig/svelte`) lives in node_modules, which
    // is not part of the tree a check is allowed to read.
    if (!parent || parent.startsWith("@")) continue;
    const target = /\.[^/]+$/.test(parent) ? join(directory, parent) : `${join(directory, parent)}.json`;
    for (const [pattern, targets] of rulesFrom(target, workspace, seen).paths) {
      paths.set(pattern, targets);
    }
  }

  const options = (data.compilerOptions ?? {}) as Record<string, unknown>;
  const declaredBase = typeof options.baseUrl === "string" && options.baseUrl ? options.baseUrl : undefined;
  const pathsBase = join(directory, declaredBase ?? ".");
  const declaredPaths = (options.paths ?? {}) as Record<string, unknown>;
  for (const [pattern, targets] of Object.entries(declaredPaths)) {
    if (!Array.isArray(targets)) continue;
    const usable = targets
      .filter((target): target is string => typeof target === "string" && target !== "")
      // Joined without normalising: the `*` has to survive until the captured
      // segment is substituted into it.
      .map((target) => (pathsBase ? `${pathsBase}/${target}` : target));
    if (usable.length > 0) paths.set(pattern, usable);
  }

  return { paths, ...(declaredBase ? { baseUrl: join(directory, declaredBase) } : {}) };
}

/** The rules that apply to one file, read once per directory per run. */
function rulesFor(fromFile: string, workspace: Workspace, cache: ConfigCache): ConfigRules | undefined {
  const directory = directoryOf(fromFile);
  if (!cache.has(directory)) {
    const configFile = findConfig(directory, workspace);
    cache.set(directory, configFile ? rulesFrom(configFile, workspace, new Set()) : undefined);
  }
  const cached = cache.get(directory);
  return cached?.kind === "imports" ? undefined : cached;
}

/**
 * Every string reachable under one `imports` value, in declared order.
 *
 * A target is a path, or a list of them, or a map of conditions whose branches
 * are more paths. Only conditions that are always available to a reader of the
 * source are followed: vite's `"#module-sync-enabled"` offers `"module-sync"`
 * before `"default"`, and taking the first branch on offer picked `misc/true.js`
 * where every compiler and every plain Node process takes `misc/false.js`. An
 * unrecognised condition is one whose truth is not in the text, so it is not a
 * candidate at all. `null` is Node's way of blocking a subpath and contributes
 * nothing either way.
 */
const CONDITIONS = new Set(["types", "import", "node", "require", "default"]);

function targetsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) targetsIn(item, into);
  else if (value && typeof value === "object") {
    for (const [condition, item] of Object.entries(value)) {
      if (CONDITIONS.has(condition)) targetsIn(item, into);
    }
  }
  return into;
}

/** The nearest enclosing package.json's `imports`, cached beside the tsconfig rules. */
function importsFor(fromFile: string, workspace: Workspace, cache: ConfigCache): ImportRules | undefined {
  const directory = directoryOf(fromFile);
  const key = `imports:${directory}`;
  if (!cache.has(key)) {
    cache.set(key, readImports(directory, workspace));
  }
  const cached = cache.get(key);
  return cached?.kind === "imports" ? cached : undefined;
}

function readImports(startDirectory: string, workspace: Workspace): ImportRules | undefined {
  let directory: string | undefined = startDirectory;
  while (directory !== undefined) {
    const candidate = join(directory, "package.json");
    const absolute = workspace.resolve(candidate);
    if (absolute && workspace.stat(absolute) === "file") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(workspace.read(absolute));
      } catch {
        return undefined;
      }
      const manifest = parsed as {
        imports?: unknown; exports?: unknown; name?: unknown; main?: unknown; module?: unknown;
      } | null;
      const here = directory;
      const mapOf = (field: unknown): Map<string, string[]> => {
        const out = new Map<string, string[]>();
        if (!field || typeof field !== "object") return out;
        for (const [pattern, value] of Object.entries(field as Record<string, unknown>)) {
          const targets = targetsIn(value).map((target) => join(here, target));
          if (targets.length > 0) out.set(pattern, targets);
        }
        return out;
      };
      const entry = typeof manifest?.main === "string" ? manifest.main
        : typeof manifest?.module === "string" ? manifest.module
        : undefined;
      return {
        kind: "imports",
        root: directory,
        imports: mapOf(manifest?.imports),
        exports: mapOf(manifest?.exports),
        name: typeof manifest?.name === "string" ? manifest.name : undefined,
        main: entry,
      };
    }
    if (directory === "") break;
    directory = directoryOf(directory);
  }
  return undefined;
}

/**
 * How well a nickname pattern fits, lower being better.
 *
 * TypeScript's own order: an exact match beats a wildcard, and among wildcards
 * the longest literal prefix wins. The third case treats a nickname with no
 * wildcard as a directory prefix, which is Graphify's addition and is tried
 * last so it can never shadow a real wildcard.
 */
function matchAlias(
  specifier: string,
  pattern: string,
): { rank: [number, number]; captured: string; wildcard: boolean } | undefined {
  if (pattern.includes("*")) {
    if (pattern.split("*").length !== 2) return undefined;
    const [prefix, suffix] = pattern.split("*");
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
    const end = suffix ? specifier.length - suffix.length : specifier.length;
    if (end < prefix.length) return undefined;
    return { rank: [1, -prefix.length], captured: specifier.slice(prefix.length, end), wildcard: true };
  }
  if (specifier === pattern) return { rank: [0, -pattern.length], captured: "", wildcard: false };
  const prefix = pattern.replace(/\/+$/, "");
  if (prefix && specifier.startsWith(`${prefix}/`)) {
    return { rank: [2, -prefix.length], captured: specifier.slice(prefix.length).replace(/^\/+/, ""), wildcard: false };
  }
  return undefined;
}

/**
 * A candidate path as an actual file, trying the extensions a JS project omits.
 *
 * `.js` meaning `.ts` is the TypeScript ESM convention and not a guess: the
 * import is written the way the compiled output will read.
 */
/**
 * The entry a directory's own package.json names, if it names one.
 *
 * `require("./")` where the folder says `"main": "lib/main.js"` is an ordinary
 * dependency on `lib/main.js`, and treating every directory as `index.js` missed
 * it. Tried before the index files for the same reason Node tries it first.
 */
function mainOf(directory: string, workspace: Workspace): string | undefined {
  const manifest = workspace.resolve(normalizeRelative(join(directory, "package.json")));
  if (!manifest || workspace.stat(manifest) !== "file") return undefined;
  try {
    const main = (JSON.parse(workspace.read(manifest)) as { main?: unknown }).main;
    return typeof main === "string" && main ? main : undefined;
  } catch {
    return undefined;
  }
}

function fileAt(candidate: string, workspace: Workspace): { abs: string; rel: string } | undefined {
  const at = (relative: string) => {
    const normalized = normalizeRelative(relative);
    const absolute = workspace.resolve(normalized);
    return absolute && workspace.stat(absolute) === "file" ? { abs: absolute, rel: normalized } : undefined;
  };

  const exact = at(candidate);
  if (exact) return exact;

  if (candidate.endsWith(".js")) {
    const stem = candidate.slice(0, -3);
    const swapped = at(`${stem}.ts`) ?? at(`${stem}.tsx`) ?? at(`${stem}.d.ts`);
    if (swapped) return swapped;
  } else if (candidate.endsWith(".jsx")) {
    const swapped = at(`${candidate.slice(0, -4)}.tsx`);
    if (swapped) return swapped;
  } else if (candidate.endsWith(".mjs")) {
    const stem = candidate.slice(0, -4);
    const swapped = at(`${stem}.mts`) ?? at(`${stem}.ts`) ?? at(`${stem}.tsx`) ?? at(`${stem}.d.mts`);
    if (swapped) return swapped;
  } else if (candidate.endsWith(".cjs")) {
    const stem = candidate.slice(0, -4);
    const swapped = at(`${stem}.cts`) ?? at(`${stem}.ts`) ?? at(`${stem}.tsx`) ?? at(`${stem}.d.cts`);
    if (swapped) return swapped;
  }

  for (const extension of EXTENSIONS) {
    const found = at(`${candidate}${extension}`);
    if (found) return found;
  }

  // Only after every file candidate has lost, so `foo.ts` beats `foo/index.ts`.
  const directory = workspace.resolve(normalizeRelative(candidate));
  if (directory && workspace.stat(directory) === "directory") {
    const main = mainOf(candidate, workspace);
    if (main) {
      const found = at(`${candidate}/${main}`);
      if (found) return found;
    }
    for (const index of INDEX_FILES) {
      const found = at(`${candidate}/${index}`);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * The file a specifier names, or undefined for anything outside this repo.
 *
 * Relative first, then nicknames, then `baseUrl` as a last resort. A bare
 * specifier that matches none of those is a third-party package, and returning
 * nothing for it is correct rather than a miss.
 *
 * `cache` is optional so a one-off call still works; a run that resolves many
 * specifiers should pass one, or it re-reads the same tsconfig every time.
 */
export function resolveDependency(
  specifier: string,
  fromFile: string,
  workspace: Workspace,
  cache: ConfigCache = new Map(),
): { abs: string; rel: string } | undefined {
  if (!specifier) return undefined;

  if (specifier.startsWith(".")) {
    return fileAt(join(directoryOf(fromFile), specifier), workspace);
  }

  /*
   * `#` is Node's prefix, but reserving it outright was wrong: vite's own
   * resolver fixtures declare `"#/*": ["./src/*"]` in tsconfig `paths`, and
   * answering only from package.json lost an edge that was plainly there. So
   * package.json goes first, because that is whose prefix it is, and a miss
   * falls through to the nicknames below like any other specifier.
   */
  if (specifier.startsWith("#")) {
    const packageRules = importsFor(fromFile, workspace, cache);
    const found = packageRules && bestMatch(specifier, packageRules.imports, workspace);
    if (found) return found;
  }

  const rules = rulesFor(fromFile, workspace, cache);

  const matched = rules && bestMatch(specifier, rules.paths, workspace);
  if (matched) return matched;

  const own = selfReference(specifier, fromFile, workspace, cache);
  if (own) return own;

  if (!rules || hasPattern(specifier, rules.paths)) return undefined;

  // Last resort, and only when it lands on a real file -- otherwise every
  // `import React from "react"` would invent a dependency on <baseUrl>/react.
  return rules.baseUrl ? fileAt(join(rules.baseUrl, specifier), workspace) : undefined;
}

/**
 * A package reaching for itself by its published name.
 *
 * `@vitejs/self-referencing/test` from inside that very package is a dependency
 * on a file a few directories up, and it reads as a third-party import unless
 * you notice the name in the nearest package.json is the same one. Workspaces
 * make this ordinary: a monorepo package importing its own public entry point
 * rather than reaching across `../src` is the tidier style, and it happens in
 * both of the monorepos measured here.
 *
 * Only the *nearest* package answers. Resolving any repo's package by name would
 * mean an index of every manifest in the tree, and every specifier that missed
 * would have to consult it -- a much larger claim than this needs to make.
 */
function selfReference(
  specifier: string,
  fromFile: string,
  workspace: Workspace,
  cache: ConfigCache,
): { abs: string; rel: string } | undefined {
  const own = importsFor(fromFile, workspace, cache);
  if (!own?.name) return undefined;
  if (specifier !== own.name && !specifier.startsWith(`${own.name}/`)) return undefined;

  /*
   * No `exports`, no self-reference. That is Node's rule rather than a shortcut,
   * and following it costs an edge that looks obviously real: vite's
   * `test-package-c/side.js` imports `@vitejs/test-package-c`, the package it is
   * sitting in, and the name does match -- but with no `exports` field Node
   * refuses it, so what that file really has is a broken import. Resolving it
   * anyway would have been the reader asserting an edge no runtime agrees with.
   */
  if (own.exports.size === 0) return undefined;

  const rest = specifier.slice(own.name.length).replace(/^\//, "");
  return bestMatch(rest ? `./${rest}` : ".", own.exports, workspace);
}

/** True when some nickname claimed the specifier, whether or not a file was there. */
function hasPattern(specifier: string, patterns: Map<string, string[]>): boolean {
  for (const pattern of patterns.keys()) if (matchAlias(specifier, pattern)) return true;
  return false;
}

/**
 * The best-fitting nickname's targets, tried in declared order.
 *
 * Shared by the two nickname systems because the rule is the same in both: the
 * most specific pattern wins outright, and then its targets are candidates in
 * the order they were written, first real file taking it.
 */
function bestMatch(
  specifier: string,
  patterns: Map<string, string[]>,
  workspace: Workspace,
): { abs: string; rel: string } | undefined {
  let best: { rank: [number, number]; captured: string; wildcard: boolean; targets: string[] } | undefined;
  for (const [pattern, targets] of patterns) {
    const match = matchAlias(specifier, pattern);
    if (!match) continue;
    if (!best || match.rank[0] < best.rank[0] || (match.rank[0] === best.rank[0] && match.rank[1] < best.rank[1])) {
      best = { ...match, targets };
    }
  }
  if (!best) return undefined;

  for (const target of best.targets) {
    const candidate = best.wildcard
      ? (best.captured ? target.replace("*", best.captured) : target.replace("*", ""))
      : (best.captured ? `${target}/${best.captured}` : target);
    const found = fileAt(candidate, workspace);
    if (found) return found;
  }
  return undefined;
}
