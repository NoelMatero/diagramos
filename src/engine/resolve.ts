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

/** Extensions tried when a specifier names no file that exists as written. */
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".svelte", ".js", ".jsx", ".mjs", ".cjs"];

/** Tried only after every file candidate has lost, the way Node resolves a directory. */
const INDEX_FILES = ["index.ts", "index.tsx", "index.svelte", "index.js", "index.jsx", "index.mjs"];

/** What one config contributes, with every path already repo-relative. */
interface ConfigRules {
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
export type ConfigCache = Map<string, ConfigRules | undefined>;

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
  return cache.get(directory);
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
function fileAt(candidate: string, workspace: Workspace): { abs: string; rel: string } | undefined {
  const at = (relative: string) => {
    const normalized = normalizeRelative(relative);
    const absolute = workspace.resolve(normalized);
    return absolute && workspace.stat(absolute) === "file" ? { abs: absolute, rel: normalized } : undefined;
  };

  const exact = at(candidate);
  if (exact) return exact;

  if (candidate.endsWith(".js")) {
    const swapped = at(`${candidate.slice(0, -3)}.ts`) ?? at(`${candidate.slice(0, -3)}.tsx`);
    if (swapped) return swapped;
  } else if (candidate.endsWith(".jsx")) {
    const swapped = at(`${candidate.slice(0, -4)}.tsx`);
    if (swapped) return swapped;
  } else if (candidate.endsWith(".mjs")) {
    const swapped = at(`${candidate.slice(0, -4)}.mts`) ?? at(`${candidate.slice(0, -4)}.ts`) ?? at(`${candidate.slice(0, -4)}.tsx`);
    if (swapped) return swapped;
  }

  for (const extension of EXTENSIONS) {
    const found = at(`${candidate}${extension}`);
    if (found) return found;
  }

  // Only after every file candidate has lost, so `foo.ts` beats `foo/index.ts`.
  const directory = workspace.resolve(normalizeRelative(candidate));
  if (directory && workspace.stat(directory) === "directory") {
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

  const rules = rulesFor(fromFile, workspace, cache);
  if (!rules) return undefined;

  let best: { rank: [number, number]; captured: string; wildcard: boolean; targets: string[] } | undefined;
  for (const [pattern, targets] of rules.paths) {
    const match = matchAlias(specifier, pattern);
    if (!match) continue;
    if (!best || match.rank[0] < best.rank[0] || (match.rank[0] === best.rank[0] && match.rank[1] < best.rank[1])) {
      best = { ...match, targets };
    }
  }

  if (!best) {
    // Last resort, and only when it lands on a real file -- otherwise every
    // `import React from "react"` would invent a dependency on <baseUrl>/react.
    return rules.baseUrl ? fileAt(join(rules.baseUrl, specifier), workspace) : undefined;
  }

  for (const target of best.targets) {
    const candidate = best.wildcard
      ? (best.captured ? target.replace("*", best.captured) : target.replace("*", ""))
      : (best.captured ? `${target}/${best.captured}` : target);
    const found = fileAt(candidate, workspace);
    if (found) return found;
  }
  return undefined;
}
