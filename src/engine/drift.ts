/**
 * Drift detection: does a diagram still agree with the repository?
 *
 * A committed diagram is documentation, and documentation rots. A node can
 * record what it stands for -- `ref: "src/engine/layout.ts"`, or
 * `path#symbol` -- and this compares those claims against the working tree.
 *
 * Deliberately shallow: no model, no import graph, just existence. Being cheap
 * and quiet matters more here than being thorough, because a check that is slow
 * or cries wolf gets switched off, and then it catches nothing at all.
 *
 * Two rules keep false positives near zero:
 *
 * - A node with no ref is skipped, never guessed at from its label ("Auth"
 *   could be anything). The one exception is a label that is unambiguously a
 *   path, which is reported as `inferred` so a caller can weigh it accordingly.
 * - Hand-drawn nodes are ignored entirely. A box someone sketched is an
 *   intention, not a claim about code that exists today.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { parseSymbol, symbolEvidence, type Assertion, type StripCache } from "./assert";
import { chainBreak, reaches, unsupportedMembers } from "./body";
import type { BoardFile } from "./board-file";
import { readGraph, type Provenance } from "./graph";
import { languageOf, type Language } from "./strip";

export type DriftKind =
  | "missing-file"
  | "missing-symbol"
  | "unresolvable-ref"
  | "empty-ref"
  /** `@declared` claimed, and no declaration of that name is in the file. */
  | "missing-declaration"
  /** `@used` claimed, and every occurrence is the declaration itself. */
  | "unused-symbol"
  /** A symbol a box lists as part of a concept, whose body shows no trace of it. */
  | "unsupported-member";

export interface DriftFinding {
  /** Node id, as edges and edit_diagram refer to it. */
  node: string;
  label: string;
  /** The ref as written, so a caller can find and fix it. */
  ref: string;
  kind: DriftKind;
  /** `recorded` refs were declared outright; `inferred` were read off a label. */
  provenance: Provenance;
  detail: string;
}

export interface EdgeDriftFinding {
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  fromRef: string;
  toRef: string;
  /** `broken-chain` is a `via` arrow whose named route stopped holding. */
  kind: "unsupported-edge" | "broken-chain";
  detail: string;
}

/**
 * A `planned` claim the code has not caught up with yet. Detected identically to
 * a regression -- the anchor does not resolve -- and reported as the opposite
 * thing, because the board said it was describing the future.
 *
 * Kept out of `findings` on purpose: `clean` and the CLI's exit code drive CI,
 * and a build must not fail because somebody sketched next week's work.
 */
export interface WorkItem {
  /** Node id, or `from -> to` when the claim is a connection rather than a box. */
  node: string;
  label: string;
  /** Absent for an edge, where the claim is the connection and not one anchor. */
  ref?: string;
  /** Why it is not there yet -- the same distinctions the checks already draw. */
  kind: DriftKind | "unsupported-edge" | "broken-chain";
  detail: string;
}

/**
 * A `planned` claim that now resolves: the work landed and the board has not
 * been told. The only signal here that is good news, and the reason it is worth
 * recording state at all -- nothing else notices progress.
 */
export interface Promotion {
  node: string;
  label: string;
  /** Absent for an edge promotion, where the claim is the connection itself. */
  ref?: string;
  detail: string;
}

/**
 * A box that was on the committed board, is not on it now, and whose code is
 * still there. Deleting a box is how you silence every other check about it, so
 * this is the one finding that comes from what the diagram *stopped* saying.
 *
 * Uncommitted only. Committing the board is the "yes, I meant it" act, which is
 * why this needs no mute of its own -- and why CI can never trip it: a fresh
 * checkout has nothing uncommitted to find.
 */
export interface DeletedClaimFinding {
  node: string;
  label: string;
  ref: string;
  kind: "deleted-claim";
  detail: string;
}

/**
 * The same board as last committed, injected so the check is testable without
 * shelling out. `undefined` means there is nothing to compare against -- no git,
 * the board is untracked, or it has not been touched since the last commit --
 * and every one of those is silence rather than an error.
 */
export interface BoardBaseline {
  committed(): BoardFile | undefined;
}

/**
 * A code file the diagram's own boxes import, that no box covers.
 *
 * The other direction of drift: not "the board claims something false" but "the
 * board leaves something out". Only ever a suggestion -- whether a module
 * deserves a box is a judgement about what is worth showing, and a diagram that
 * drew everything would be a file listing.
 */
export interface UnrepresentedFinding {
  /** Repo-relative path of the file no box covers. */
  file: string;
  /** The board's own ref'd files that import it, which is why it is a candidate. */
  importedBy: string[];
}

/**
 * Why a node was not checked. Kept apart from `excused`, which is a declaration
 * that there was nothing to check, and from `handDrawn`, which is a sketch.
 */
export type NodeSkipReason = "no-ref" | "ref-outside-repo";

/**
 * Why an arrow was not checked. Nine reasons, all of which used to arrive as a
 * single number -- so a reader could see that five arrows went unchecked without
 * any way to learn that two of them simply had not been snapped to their boxes.
 */
export type EdgeSkipReason =
  | "ends-not-bound"
  | "endpoint-missing"
  | "endpoint-external"
  | "endpoint-has-no-ref"
  | "endpoint-outside-repo"
  | "endpoint-file-missing"
  | "directory-ref"
  | "not-ts-or-js"
  /** Both ends named a symbol, and neither one has a body that could be read. */
  | "no-function-body";

/** Counts by reason, with zeroes omitted so a caller can print what is there. */
export type SkipBreakdown<Reason extends string> = Partial<Record<Reason, number>>;

/**
 * What became of the `@declared` / `@used` claims on this board.
 *
 * Both weakenings are silent by design -- the anchor still gets the plain
 * mention check -- so without a count there would be no way to tell a claim
 * that held from one that was never evaluated.
 */
export interface AssertionTally {
  /** Assertions actually evaluated against stripped source. */
  checked: number;
  /** The lexer bailed, so this was judged on raw text: today's mention semantics. */
  downgraded: number;
  /** No lexer or declaration table for that file type. */
  unsupportedLanguage: number;
}

export interface DriftReport {
  clean: boolean;
  findings: DriftFinding[];
  /**
   * Files the board's neighbourhood imports but does not show. Empty unless
   * `coverage` was asked for: it is the one check here that suggests additions,
   * so it never runs on the per-turn path.
   */
  unrepresented: UnrepresentedFinding[];
  /** Boxes removed from the board while their code is still in the tree. */
  deleted: DeletedClaimFinding[];
  /** `planned` claims the code has not reached yet. Never affects `clean`. */
  workItems: WorkItem[];
  /** `planned` claims that now hold, so the board can be advanced. Never affects `clean`. */
  promotions: Promotion[];
  /** Nodes that had something checkable. */
  checked: number;
  /** Generated nodes with no ref to check against. */
  skipped: number;
  /** The same number, split by reason, so silence can be told from coverage. */
  skippedWhy: SkipBreakdown<NodeSkipReason>;
  /** What became of any `@declared` / `@used` claims. All zeroes on a board with none. */
  assertions: AssertionTally;
  /** Nodes not about this repo: an `external` node, or any node on a concept board. */
  excused: number;
  /** Hand-drawn nodes, ignored by design. */
  handDrawn: number;
  /** True when the board says it describes something other than this repository. */
  concept: boolean;
  edges: EdgeDriftFinding[];
  /** Edges checked for corroboration. */
  edgesChecked: number;
  /** Edges skipped (directory refs, non-TS/JS, missing files, hand-drawn, refless). */
  edgesSkipped: number;
  /** The same number, split by reason. This is the one people ask about. */
  edgesSkippedWhy: SkipBreakdown<EdgeSkipReason>;
}

/**
 * The filesystem, narrowed to what detection needs and injected so the checks
 * are testable without a real tree.
 */
export interface Workspace {
  /** Absolute path for a repo-relative ref; undefined when it escapes the root. */
  resolve(relativePath: string): string | undefined;
  stat(absolutePath: string): "file" | "directory" | "missing";
  /** Only called when stat said "file". */
  read(absolutePath: string): string;
  /**
   * Entry names directly inside a directory, unsorted, never recursive.
   *
   * One level is the whole security design for globs: a ref can name a single
   * directory's listing and never a search. Only called when stat said
   * "directory"; an unreadable directory is an empty list, not a throw.
   */
  list(absolutePath: string): string[];
}

/**
 * A label worth reading as a path: at least one slash and a file extension.
 * Deliberately strict -- `POST /api/file` and `Auth` both fail, which is the
 * point. It exists so diagrams drawn before `ref` are not invisible to drift.
 */
const PATH_LIKE = /^[\w@.-]+(?:\/[\w@.-]+)+\.\w{1,10}$/;

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** Files whose imports this can parse. Everything else is silent, never wrong. */
const TS_JS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Splits `path#symbol`. Either half may be empty; the caller decides. */
export function parseRef(ref: string): { path: string; symbol?: string } {
  const hash = ref.indexOf("#");
  if (hash < 0) return { path: ref.trim() };
  return { path: ref.slice(0, hash).trim(), symbol: ref.slice(hash + 1).trim() || undefined };
}

export function refFromLabel(label: string): string | undefined {
  const candidate = label.trim();
  return PATH_LIKE.test(candidate) ? candidate : undefined;
}

/**
 * Word-boundary match, not a parse. A rename shows up; a mention in a comment
 * counts as still present. That asymmetry is deliberate: a missed rename is
 * invisible, while a wrong "this is gone" costs trust in the whole check.
 */
function mentions(source: string, symbol: string): boolean {
  return new RegExp(`\\b${symbol.replace(REGEX_SPECIAL, "\\$&")}\\b`).test(source);
}

type Inspection = DriftFinding | "ok" | "skip";

/**
 * How many entries a directory or glob anchor will look at.
 *
 * Past this the anchor is skipped and counted rather than guessed at: a box
 * standing for a thousand-file directory is not making a checkable claim, and
 * reading them on every turn is not a per-turn budget.
 */
const ANCHOR_ENTRY_CAP = 50;

/**
 * A `*` in the last segment, and only there.
 *
 * The restriction is the security design rather than a simplification: the
 * directory prefix stays literal, so expansion is one listing of one directory.
 * Allowing `**`, or a star mid-path, turns a model-authored string back into a
 * tree walk.
 */
function globOf(target: string): { directory: string; pattern: RegExp } | undefined {
  if (!target.includes("*")) return undefined;
  const cut = target.lastIndexOf("/");
  const directory = cut < 0 ? "." : target.slice(0, cut);
  const last = target.slice(cut + 1);
  if (directory.includes("*") || last.includes("**")) return undefined;
  const body = last.split("*").map((part) => part.replace(REGEX_SPECIAL, "\\$&")).join("[^/]*");
  return { directory, pattern: new RegExp(`^${body}$`) };
}

/** Names directly inside a directory that are files. `undefined` past the cap. */
function filesIn(
  directoryAbsolute: string,
  workspace: Workspace,
  match?: RegExp,
): string[] | undefined {
  const entries = workspace.list(directoryAbsolute);
  if (entries.length > ANCHOR_ENTRY_CAP) return undefined;
  return entries.filter(
    (entry) =>
      (!match || match.test(entry))
      && workspace.stat(`${directoryAbsolute}/${entry}`) === "file",
  );
}

/** Whether any of these files mentions the symbol. Stops at the first hit. */
function mentionedIn(files: string[], symbol: string, workspace: Workspace): boolean {
  return files.some((file) => mentions(workspace.read(file), symbol));
}

/**
 * Judge one file against `@declared` / `@used`.
 *
 * `"unsupported"` is the language with no table, and `"ok"` covers both a
 * satisfied claim and a downgrade -- a bailed lexer falls back to the caller's
 * mention check, which has already run. Every uncertainty here resolves quiet.
 */
function judgeAssertion(
  filePath: string,
  source: string,
  symbol: string,
  assertion: Assertion,
  tally: AssertionTally,
  cache: StripCache,
): "ok" | "unsupported" | { kind: "missing-declaration" | "unused-symbol" } {
  const evidence = symbolEvidence(filePath, source, symbol, cache);
  if (!evidence) {
    tally.unsupportedLanguage += 1;
    return "unsupported";
  }
  if (evidence.downgraded) {
    tally.downgraded += 1;
    return "ok";
  }
  tally.checked += 1;
  if (assertion.declared && !evidence.declared) return { kind: "missing-declaration" };
  if (assertion.used && evidence.used < 1) return { kind: "unused-symbol" };
  return "ok";
}

/**
 * Whether any of these files satisfies the assertion. The set form of the
 * above: a directory or glob anchor claims the symbol lives somewhere inside,
 * so one file holding up the claim is enough.
 */
function assertedIn(
  files: string[],
  symbol: string,
  assertion: Assertion,
  workspace: Workspace,
  tally: AssertionTally,
  cache: StripCache,
): "ok" | "unsupported" | { kind: "missing-declaration" | "unused-symbol" } {
  let worst: "unsupported" | { kind: "missing-declaration" | "unused-symbol" } = "unsupported";
  for (const file of files) {
    const verdict = judgeAssertion(file, workspace.read(file), symbol, assertion, tally, cache);
    if (verdict === "ok") return "ok";
    if (verdict !== "unsupported") worst = verdict;
  }
  return worst;
}

function inspect(
  node: { id: string; label: string },
  ref: string,
  provenance: Provenance,
  workspace: Workspace,
  tally: AssertionTally,
  cache: StripCache,
): Inspection {
  const { path: rawTarget, symbol: rawSymbol } = parseRef(ref);
  const base = { node: node.id, label: node.label, ref, provenance };
  if (!rawTarget) {
    return { ...base, kind: "unresolvable-ref", detail: `"${ref}" names a symbol but no file.` };
  }

  // A garbled assertion is loud immediately rather than becoming a claim that
  // silently checks nothing. It fails the turn it is written, while the author
  // is still there.
  const parsed = rawSymbol === undefined ? undefined : parseSymbol(rawSymbol);
  if (parsed && "garbled" in parsed) {
    return {
      ...base,
      kind: "unresolvable-ref",
      detail: `"@${parsed.garbled}" is not something a ref can claim. Use @declared, @used, or @declared+used.`,
    };
  }
  const symbol = parsed?.symbol;
  const assertion = parsed?.assertion;
  /** The finding an assertion verdict turns into, worded for where it looked. */
  const failed = (
    verdict: { kind: "missing-declaration" | "unused-symbol" },
    where: string,
  ): DriftFinding => ({
    ...base,
    kind: verdict.kind,
    detail:
      verdict.kind === "missing-declaration"
        ? `${where} no longer declares ${symbol}.`
        : `${where} mentions ${symbol} but never uses it beyond its declaration.`,
  });

  // A trailing slash says "directory" outright. That is the point of allowing
  // it: what `src/engine` means should not depend on what happens to be on disk
  // the day it is read.
  const explicitDirectory = rawTarget.endsWith("/");
  const target = explicitDirectory ? rawTarget.replace(/\/+$/, "") : rawTarget;

  const glob = globOf(target);
  if (target.includes("*") && !glob) {
    return {
      ...base,
      kind: "unresolvable-ref",
      detail: `${target} puts * outside the last path segment. One directory can be listed, never searched.`,
    };
  }

  const lookup = glob ? glob.directory : target;
  const absolute = workspace.resolve(lookup);
  if (!absolute) {
    // An inferred ref is a reading of someone's label, not a claim they made.
    // A label pointing outside the repo just is not a code reference.
    if (provenance === "inferred") return "skip";
    return { ...base, kind: "unresolvable-ref", detail: `${lookup} is outside the repository.` };
  }

  const found = workspace.stat(absolute);
  if (found === "missing") {
    return { ...base, kind: "missing-file", detail: `${lookup} no longer exists.` };
  }

  if (glob) {
    if (found !== "directory") {
      return { ...base, kind: "unresolvable-ref", detail: `${glob.directory} is not a directory.` };
    }
    const matched = filesIn(absolute, workspace, glob.pattern);
    if (matched === undefined) return "skip";
    if (matched.length === 0) {
      return { ...base, kind: "empty-ref", detail: `${target} matches no files.` };
    }
    if (!symbol) return "ok";
    const code = matched.filter((name) => TS_JS.test(name)).map((name) => `${absolute}/${name}`);
    if (!mentionedIn(code, symbol, workspace)) {
      return { ...base, kind: "missing-symbol", detail: `no file matching ${target} mentions ${symbol}.` };
    }
    if (!assertion) return "ok";
    const verdict = assertedIn(code, symbol, assertion, workspace, tally, cache);
    return typeof verdict === "object" ? failed(verdict, `no file matching ${target}`) : "ok";
  }

  if (found === "directory") {
    const inside = filesIn(absolute, workspace);
    if (inside === undefined) return "skip";
    if (workspace.list(absolute).length === 0) {
      return { ...base, kind: "empty-ref", detail: `${target} is empty.` };
    }
    if (!symbol) return "ok";
    // A symbol asked for inside a directory used to be unresolvable. It is a
    // reasonable thing to mean -- "this lives somewhere in here" -- and one
    // listing plus that directory's own files answers it.
    const code = inside.filter((name) => TS_JS.test(name)).map((name) => `${absolute}/${name}`);
    if (code.length === 0) {
      return {
        ...base,
        kind: "unresolvable-ref",
        detail: `${target} holds no TypeScript or JavaScript, so ${symbol} cannot be looked for there.`,
      };
    }
    if (!mentionedIn(code, symbol, workspace)) {
      return { ...base, kind: "missing-symbol", detail: `nothing directly in ${target} mentions ${symbol}.` };
    }
    if (!assertion) return "ok";
    const verdict = assertedIn(code, symbol, assertion, workspace, tally, cache);
    return typeof verdict === "object" ? failed(verdict, `nothing directly in ${target}`) : "ok";
  }

  if (explicitDirectory) {
    return { ...base, kind: "unresolvable-ref", detail: `${target}/ is a file, not a directory.` };
  }
  if (!symbol) return "ok";
  const source = workspace.read(absolute);
  if (!mentions(source, symbol)) {
    return { ...base, kind: "missing-symbol", detail: `${target} no longer mentions ${symbol}.` };
  }
  if (!assertion) return "ok";
  const verdict = judgeAssertion(target, source, symbol, assertion, tally, cache);
  return typeof verdict === "object" ? failed(verdict, target) : "ok";
}

/**
 * Resolve a relative import specifier to a file path within the workspace.
 * Tries the spec as written, each extension variant, and index.<ext> in the directory.
 * fromFile should be a repo-relative path (not absolute).
 * Returns { abs: absolute path, rel: repo-relative path } or undefined if not found.
 */
function resolveImport(
  spec: string,
  fromFile: string,
  workspace: Workspace,
): { abs: string; rel: string } | undefined {
  // Relative imports only. Absolute specifiers or node_modules are skipped.
  if (!spec.startsWith(".")) {
    return undefined;
  }

  // Compute the directory of fromFile (repo-relative)
  const lastSlash = fromFile.lastIndexOf("/");
  const fromDir = lastSlash < 0 ? "" : fromFile.substring(0, lastSlash);

  // Resolve the import spec relative to fromDir
  let base = spec;
  // Remove leading ./ for joining
  if (base.startsWith("./")) {
    base = base.substring(2);
  }

  // Join with directory (keep ../ as-is for workspace.resolve to normalize)
  let resolved = base;
  if (fromDir) {
    resolved = fromDir + "/" + base;
  }

  // Generate candidates with extension variants
  const candidates: string[] = [resolved];

  if (resolved.endsWith(".js")) {
    candidates.push(resolved.slice(0, -3) + ".ts", resolved.slice(0, -3) + ".tsx");
  } else if (resolved.endsWith(".mjs")) {
    candidates.push(resolved.slice(0, -4) + ".ts", resolved.slice(0, -4) + ".tsx");
  } else if (!resolved.match(/\.(ts|tsx|js|jsx|mjs|cjs|mts)$/)) {
    // No extension: try common TS/JS extensions
    candidates.push(resolved + ".ts", resolved + ".tsx", resolved + ".js", resolved + ".mjs");
    // Try index variants
    candidates.push(resolved + "/index.ts", resolved + "/index.tsx", resolved + "/index.js", resolved + "/index.mjs");
  }

  // Check each candidate (workspace.resolve will normalize and validate)
  for (const candidate of candidates) {
    const abs = workspace.resolve(candidate);
    if (abs && workspace.stat(abs) === "file") {
      return { abs, rel: candidate };
    }
  }

  return undefined;
}

/**
 * Extract all relative imports from a file, caching results per file within a single check.
 * fileAbsolute is the absolute path; fileRelative is the repo-relative path.
 * Returns array of { abs, rel } objects for each resolved import.
 */
function getImports(fileAbsolute: string, fileRelative: string, workspace: Workspace, cache: Map<string, Array<{ abs: string; rel: string }>>): Array<{ abs: string; rel: string }> {
  if (cache.has(fileAbsolute)) {
    return cache.get(fileAbsolute)!;
  }

  const imports: Array<{ abs: string; rel: string }> = [];
  const found = workspace.stat(fileAbsolute);
  if (found !== "file") {
    cache.set(fileAbsolute, imports);
    return imports;
  }

  const source = workspace.read(fileAbsolute);
  // Match relative imports: import x from "path", require("path"), import("path"), export ... from "path"
  // Patterns:
  //   - import ... from "path" / export ... from "path"
  //   - require("path")
  //   - import("path")
  //   - import "path" (rarely used but valid)
  const importRegex = /(?:import|export|require|from)\s+[^"'`]*?["'`](\.[^"'`]+)["'`]|require\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\)|import\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g;
  let match;
  while ((match = importRegex.exec(source)) !== null) {
    const spec = match[1] || match[2] || match[3];
    if (spec) {
      const resolved = resolveImport(spec, fileRelative, workspace);
      if (resolved) {
        imports.push(resolved);
      }
    }
  }

  cache.set(fileAbsolute, imports);
  return imports;
}

/**
 * Extract route literals (strings starting with "/") from a file.
 */
function getRouteLiterals(file: string, workspace: Workspace): Set<string> {
  const routes = new Set<string>();
  const found = workspace.stat(file);
  if (found !== "file") {
    return routes;
  }

  const source = workspace.read(file);
  // Match: /(\/[A-Za-z0-9_\-./:]+)/
  const routeRegex = /(['"`])(\/[A-Za-z0-9_\-./:]+)\1/g;
  let match;
  while ((match = routeRegex.exec(source)) !== null) {
    const route = match[2];
    if (route && route.length > 1) {
      routes.add(route);
    }
  }

  return routes;
}

/**
 * Every symbol a box names, for a language whose bodies can be read.
 *
 * A box standing for a feature lists several -- a static and the macro using
 * it -- and any one of them being reached satisfies the arrow. That is also
 * the whole of concept membership: a box's `refs` are the symbols whose
 * invocation counts as using it, and one caller naming any member is enough.
 */
function symbolsOf(node: { ref?: string; refs?: string[] }, file: string): string[] {
  if (!languageOf(file)) return [];
  const anchors = [node.ref, ...(node.refs ?? [])];
  const symbols = new Set<string>();
  for (const anchor of anchors) {
    const raw = anchor?.trim();
    if (!raw) continue;
    const { symbol } = parseRef(raw);
    if (!symbol) continue;
    const parsed = parseSymbol(symbol);
    // A garbled assertion is already reported by the node check; here it is
    // simply not a symbol worth searching for.
    if ("garbled" in parsed || parsed.symbol.startsWith("/")) continue;
    symbols.add(parsed.symbol);
  }
  return [...symbols];
}

/**
 * The symbols a box lists, grouped by the file they live in.
 *
 * Grouped because the self-support rule is a question about one file's text:
 * a box spanning `logging.rs` and `server.rs` is making two local claims, not
 * one that spans them.
 */
function membersByFile(
  node: { ref?: string; refs?: string[] },
  workspace: Workspace,
): Array<[{ path: string; absolute: string; language: Language }, string[]]> {
  const byFile = new Map<string, { file: { path: string; absolute: string; language: Language }; symbols: string[] }>();
  for (const anchor of [node.ref, ...(node.refs ?? [])]) {
    const raw = anchor?.trim();
    if (!raw) continue;
    const { path: target, symbol } = parseRef(raw);
    if (!symbol) continue;
    const parsed = parseSymbol(symbol);
    if ("garbled" in parsed || parsed.symbol.startsWith("/")) continue;
    const absolute = workspace.resolve(target);
    if (!absolute || workspace.stat(absolute) !== "file") continue;
    const language = languageOf(absolute);
    if (!language) continue;
    const entry = byFile.get(absolute)
      ?? { file: { path: target, absolute, language }, symbols: [] };
    if (!entry.symbols.includes(parsed.symbol)) entry.symbols.push(parsed.symbol);
    byFile.set(absolute, entry);
  }
  return [...byFile.values()].map((entry) => [entry.file, entry.symbols]);
}

type SymbolEdgeVerdict = "reached" | "unreached" | "unreadable";

/**
 * Does either end's function body reach the other, directly or in one hop?
 *
 * Both directions are tried and any evidence is enough: an arrow means these
 * two are connected, and the diagram's sense of direction is a reading of the
 * design rather than a claim about who calls whom.
 */
function checkSymbolEdge(
  from: { file: string; path: string; symbols: string[] },
  to: { file: string; path: string; symbols: string[] },
  workspace: Workspace,
): SymbolEdgeVerdict {
  let asked = false;
  for (const [start, target] of [[from, to], [to, from]] as const) {
    const language = languageOf(start.file);
    if (!language) continue;
    const source = workspace.read(start.file);
    for (const symbol of start.symbols) {
      const verdict = reaches(source, symbol, target.symbols, language);
      if (verdict === undefined) continue;
      asked = true;
      if (verdict) return "reached";
    }
  }
  return asked ? "unreached" : "unreadable";
}

/**
 * Check if edge A → B is backed by one of the four corroboration channels.
 * Assumes both files are valid TS/JS files; returns a finding if not backed, undefined if backed.
 */
function checkEdgeCorroboration(
  fromRef: string,
  toRef: string,
  fromLabel: string,
  toLabel: string,
  workspace: Workspace,
  importCache: Map<string, Array<{ abs: string; rel: string }>>,
  sharedImporterCandidates: Map<string, string>,
): EdgeDriftFinding | undefined {
  // Parse refs: keep only path, ignore symbol
  const { path: fromPath } = parseRef(fromRef);
  const { path: toPath } = parseRef(toRef);

  // Resolve both files (already validated above)
  const fromFileAbs = workspace.resolve(fromPath)!;
  const toFileAbs = workspace.resolve(toPath)!;

  // Channel 1: A imports B
  const importsFrom = getImports(fromFileAbs, fromPath, workspace, importCache);
  if (importsFrom.some((imp) => imp.abs === toFileAbs)) {
    return undefined;
  }

  // Channel 2: B imports A
  const importsTo = getImports(toFileAbs, toPath, workspace, importCache);
  if (importsTo.some((imp) => imp.abs === fromFileAbs)) {
    return undefined;
  }

  // Channel 3: Shared importer — any file C that imports both A and B
  // C = sharedImporterCandidates (hoisted from checkDrift)
  for (const [file, fileRel] of sharedImporterCandidates) {
    const fileImports = getImports(file, fileRel, workspace, importCache);
    if (
      fileImports.some((imp) => imp.abs === fromFileAbs)
      && fileImports.some((imp) => imp.abs === toFileAbs)
    ) {
      return undefined;
    }
  }

  // Channel 4: Shared route literal, one hop out
  const fromRoutes = new Set([
    ...getRouteLiterals(fromFileAbs, workspace),
  ]);
  for (const imp of importsFrom) {
    for (const route of getRouteLiterals(imp.abs, workspace)) {
      fromRoutes.add(route);
    }
  }

  const toRoutes = new Set([
    ...getRouteLiterals(toFileAbs, workspace),
  ]);
  for (const imp of importsTo) {
    for (const route of getRouteLiterals(imp.abs, workspace)) {
      toRoutes.add(route);
    }
  }

  if ([...fromRoutes].some((route) => toRoutes.has(route))) {
    return undefined;
  }

  // No channel fires: flag it as worth a look, not necessarily wrong
  return {
    from: fromPath,
    to: toPath,
    fromLabel,
    toLabel,
    fromRef,
    toRef,
    kind: "unsupported-edge",
    detail: `nothing in ${fromPath} imports, is imported by, shares an importer with, or shares a route string with ${toPath} — worth a look, not necessarily wrong.`,
  };
}

export function checkDrift(
  board: BoardFile,
  workspace: Workspace,
  options?: { edges?: boolean; baseline?: BoardBaseline; coverage?: boolean },
): DriftReport {
  const findings: DriftFinding[] = [];
  const workItems: WorkItem[] = [];
  const promotions: Promotion[] = [];
  let checked = 0;
  let skipped = 0;
  let edgesChecked = 0;
  let edgesSkipped = 0;
  let excused = 0;
  let handDrawn = 0;
  const skippedWhy: SkipBreakdown<NodeSkipReason> = {};
  const edgesSkippedWhy: SkipBreakdown<EdgeSkipReason> = {};
  const assertions: AssertionTally = { checked: 0, downgraded: 0, unsupportedLanguage: 0 };
  const strips: StripCache = new Map();
  const skipNode = (reason: NodeSkipReason) => {
    skipped += 1;
    skippedWhy[reason] = (skippedWhy[reason] ?? 0) + 1;
  };
  const skipEdge = (reason: EdgeSkipReason) => {
    edgesSkipped += 1;
    edgesSkippedWhy[reason] = (edgesSkippedWhy[reason] ?? 0) + 1;
  };

  /**
   * File one verdict about one arrow.
   *
   * A `planned` arrow is the connection you want, not one you are claiming
   * exists. Absent corroboration is then the work, and corroboration is the
   * news that the work landed.
   */
  const recordEdge = (
    edge: { from: string; to: string; state: string },
    fromNode: { label: string },
    toNode: { label: string },
    finding: EdgeDriftFinding | undefined,
  ) => {
    if (edge.state !== "planned") {
      if (finding) edges.push(finding);
      return;
    }
    const claim = `${fromNode.label || edge.from} -> ${toNode.label || edge.to}`;
    if (finding) {
      workItems.push({
        node: `${edge.from} -> ${edge.to}`,
        label: claim,
        kind: finding.kind,
        detail: finding.detail,
      });
    } else {
      promotions.push({
        node: `${edge.from} -> ${edge.to}`,
        label: claim,
        detail: "the code now connects these, so this is no longer planned.",
      });
    }
  };

  const graph = readGraph(board);
  // A board describing a protocol or another project makes no claims about this
  // tree, so every box on it is excused rather than reported as unannotated.
  const concept = graph.describes === "concept";

  for (const node of graph.nodes) {
    if (node.provenance !== "recorded") {
      handDrawn += 1;
      continue;
    }
    if (concept || node.state === "external") {
      excused += 1;
      continue;
    }
    const declared = node.ref?.trim();
    // Every anchor the box claims, in order, with the primary first. A box that
    // stands for a feature spread across files is clean only when all of them
    // hold, and each reports on its own so the reader learns which one broke.
    const anchors = [declared || refFromLabel(node.label), ...(node.refs ?? [])]
      .map((entry) => entry?.trim())
      .filter((entry): entry is string => Boolean(entry));
    if (anchors.length === 0) {
      skipNode("no-ref");
      continue;
    }

    // Counted once per box, not once per anchor: the numbers are about how much
    // of the diagram was read, and a box is one thing on the diagram.
    let anyChecked = false;
    for (const anchor of anchors) {
      const isDeclared = anchor === declared || (node.refs ?? []).includes(anchor);
      const result = inspect(
        node,
        anchor,
        isDeclared ? "recorded" : "inferred",
        workspace,
        assertions,
        strips,
      );
      if (result === "skip") continue;
      anyChecked = true;

      if (node.state === "planned") {
        if (result === "ok") {
          promotions.push({
            node: node.id,
            label: node.label,
            ref: anchor,
            detail: `${anchor} exists now, so this is no longer planned.`,
          });
        } else if (result.kind === "unresolvable-ref") {
          // Not a thing waiting to be built: the ref is malformed or escapes the
          // root, and writing the code would not make it resolve.
          findings.push(result);
        } else {
          workItems.push({
            node: node.id,
            label: node.label,
            ref: anchor,
            kind: result.kind,
            detail: result.detail,
          });
        }
        continue;
      }

      if (result !== "ok") findings.push(result);
    }
    // Every anchor was unreadable -- the only way `inspect` returns "skip" is a
    // label-derived ref pointing outside the tree, or a directory too large to
    // read. One box, one count, whichever way it went.
    if (anyChecked) checked += 1;
    else skipNode("ref-outside-repo");

    /*
     * A concept box has to hold together.
     *
     * Listing several symbols is how a box says "these are the ways to use
     * this thing", and it is what lets one arrow into the box be satisfied by
     * any one member. That generosity has a hole: cut the deepest call and
     * every caller still calls a listed member, so the arrows stay green while
     * the concept has been hollowed out.
     *
     * So a member that runs has to name another member. The claim is not
     * trusted, it is checked -- every turn, like everything else.
     */
    for (const [file, members] of membersByFile(node, workspace)) {
      for (const orphan of unsupportedMembers(workspace.read(file.absolute), members, file.language)) {
        findings.push({
          node: node.id,
          label: node.label,
          ref: `${file.path}#${orphan}`,
          kind: "unsupported-member",
          provenance: "recorded",
          detail:
            `${orphan} is listed as part of this box, and its body names none of `
            + `${members.filter((other) => other !== orphan).join(", ")}.`,
        });
      }
    }
  }

  /*
   * What the board stopped saying.
   *
   * Every other check reads the board as it is, so removing a box removes the
   * findings about it: measured on this repo, deleting one box dropped the refs
   * checked from 12 to 11 and the edges from 13 to 11, and reported nothing. The
   * quietest possible diagram is an empty one.
   *
   * Matching is on the semantic node id, not the element id: regeneration writes
   * new elements and keeps node ids, so anything keyed on elements would call
   * every redraw a deletion. A node still present with a different ref is not a
   * deletion either -- the ordinary checks own that.
   */
  const deleted: DeletedClaimFinding[] = [];
  const baseline = options?.baseline?.committed();
  if (baseline) {
    const live = new Set(graph.nodes.map((node) => node.id));
    for (const was of readGraph(baseline).nodes) {
      if (was.provenance !== "recorded" || was.state === "external") continue;
      const ref = was.ref?.trim();
      if (!ref || live.has(was.id)) continue;
      const { path: target } = parseRef(ref);
      const absolute = workspace.resolve(target);
      // The code went with it, so the board is telling the truth. Say nothing --
      // this silence is as load-bearing as the finding.
      if (!absolute || workspace.stat(absolute) === "missing") continue;
      deleted.push({
        node: was.id,
        label: was.label,
        ref,
        kind: "deleted-claim",
        detail: `${was.label || was.id} (${target}) was removed from the diagram, but `
          + "that file still exists. Committing the diagram makes the removal final.",
      });
    }
  }

  // Edge checking: check each generated edge for corroboration
  const edges: EdgeDriftFinding[] = [];

  const importCache = new Map<string, Array<{ abs: string; rel: string }>>();

  if (options?.edges !== false && !concept) {
    const nodeById = new Map<string, typeof graph.nodes[0]>();
    for (const node of graph.nodes) {
      nodeById.set(node.id, node);
    }

    // Build shared importer candidates once per board:
    // every recorded-ref code file + their direct imports (one hop out)
    const sharedImporterCandidates = new Map<string, string>();  // absolute path -> repo-relative path
    for (const node of graph.nodes) {
      const nodeRef = node.ref?.trim();
      if (!nodeRef) continue;
      const { path: nodePath } = parseRef(nodeRef);
      const resolved = workspace.resolve(nodePath);
      if (resolved && workspace.stat(resolved) === "file") {
        sharedImporterCandidates.set(resolved, nodePath);
      }
    }

    // Expand with direct imports (one hop) — for imported files, use their repo-relative path
    for (const [file, fileRel] of sharedImporterCandidates) {
      const fileImports = getImports(file, fileRel, workspace, importCache);
      for (const imp of fileImports) {
        if (!sharedImporterCandidates.has(imp.abs)) {
          sharedImporterCandidates.set(imp.abs, imp.rel);
        }
      }
    }

    for (const edge of graph.edges) {
      /*
       * Skip on how the endpoints were resolved, not on who drew the arrow.
       *
       * An arrow bound at both ends points at two shapes and keeps pointing at
       * them when either one moves, whoever drew it -- so a hand-drawn bound
       * arrow between two generated nodes is exactly as precise a claim as a
       * generated edge, and that is the diagram-driven-development case: you
       * sketch the connection you want between components that already exist.
       * Keying on authorship skipped it silently.
       *
       * `nearest` stays skipped. Those endpoints were matched to whichever shape
       * they landed close to, which is an observation about geometry rather than
       * a claim about the design.
       */
      if (edge.endpoints === "nearest") {
        skipEdge("ends-not-bound");
        continue;
      }

      const fromNode = nodeById.get(edge.from);
      const toNode = nodeById.get(edge.to);

      // Both endpoints must exist, be recorded, have refs
      if (!fromNode || !toNode) {
        skipEdge("endpoint-missing");
        continue;
      }

      // An arrow into something deliberately outside the repo has nothing to
      // corroborate against, and saying so would be noise, not a finding.
      if (fromNode.state === "external" || toNode.state === "external") {
        skipEdge("endpoint-external");
        continue;
      }

      const fromRef = fromNode.ref?.trim();
      const toRef = toNode.ref?.trim();
      if (!fromRef || !toRef) {
        skipEdge("endpoint-has-no-ref");
        continue;
      }

      // Parse refs and check if both point to TS/JS files (not directories or missing)
      const { path: fromPath } = parseRef(fromRef);
      const { path: toPath } = parseRef(toRef);
      const fromFile = workspace.resolve(fromPath);
      const toFile = workspace.resolve(toPath);

      // Skip if either file is missing or is not a file
      if (!fromFile || !toFile) {
        skipEdge("endpoint-outside-repo");
        continue;
      }
      const fromStat = workspace.stat(fromFile);
      const toStat = workspace.stat(toFile);
      if (fromStat !== "file" || toStat !== "file") {
        // Both land here, and they are not the same thing to a reader: one end
        // standing for a subsystem is a choice, one pointing at a file that is
        // gone is already reported as drift by the node check.
        skipEdge(
          fromStat === "missing" || toStat === "missing" ? "endpoint-file-missing" : "directory-ref",
        );
        continue;
      }

      /*
       * When both ends name symbols, ask the sharper question.
       *
       * The anchors already say what a box is: a bare path is a file, a
       * `path#symbol` is a function, a `refs` list is a feature. So the check
       * takes its granularity from the claim that was written rather than from
       * a field somebody has to keep in sync -- both ends symbol-anchored in a
       * language with a table gets function granularity, anything less falls
       * through to the file-level channels below.
       *
       * This runs before the TypeScript gate on purpose: the case it was built
       * for is Rust.
       */
      const fromEnd = { file: fromFile, path: fromPath, symbols: symbolsOf(fromNode, fromFile) };
      const toEnd = { file: toFile, path: toPath, symbols: symbolsOf(toNode, toFile) };
      const bothNamed = fromEnd.symbols.length > 0 && toEnd.symbols.length > 0;

      /*
       * A named route is checked as written, and never falls back.
       *
       * `via` says the connection goes this way, through these names. Each
       * consecutive pair is one plain direct check, so depth costs nothing and
       * the report can point at the hop that stopped holding -- which is the
       * one thing no other shape here can say. Falling back to a looser channel
       * on failure would throw away exactly that.
       */
      const via = edge.via;
      if (bothNamed && via && via.length > 0) {
        const language = languageOf(fromFile)!;
        const source = workspace.read(fromFile);
        const broken = chainBreak(source, fromEnd.symbols[0]!, via, toEnd.symbols, language);
        if (broken?.unreadable) {
          skipEdge("no-function-body");
          continue;
        }
        edgesChecked += 1;
        /*
         * A broken route and an absent connection are different news.
         *
         * "these are not connected" and "these are connected, but not the way
         * you wrote it down" want different fixes -- redraw the arrow, versus
         * correct the route -- and rendering them the same way invites someone
         * to delete an arrow that was right.
         *
         * Telling them apart needs no deeper search, because the asymmetry is
         * in our favour: finding a path proves a connection, while failing to
         * find one proves nothing. So this only ever *confirms*, at exactly the
         * evidence standard used everywhere else. Searching deeper for the
         * confirmation would bless every broken route as "connected anyway",
         * which is the same whitewash measured at file level, pointed the other
         * way.
         */
        const stillConnected = broken
          && checkSymbolEdge(fromEnd, toEnd, workspace) === "reached";
        recordEdge(
          edge,
          fromNode,
          toNode,
          broken
            ? {
                from: fromPath,
                to: toPath,
                fromLabel: fromNode.label,
                toLabel: toNode.label,
                fromRef,
                toRef,
                kind: "broken-chain",
                detail: stillConnected
                  ? `these are still connected, but not by this route: nothing in `
                    + `${broken.at} names ${broken.next}. Correct the route or drop it.`
                  : `the route breaks at ${broken.at}: nothing in it names ${broken.next} `
                    + `— worth a look, not necessarily wrong.`,
              }
            : undefined,
        );
        continue;
      }

      const verdict = bothNamed ? checkSymbolEdge(fromEnd, toEnd, workspace) : "unreadable";

      let finding: EdgeDriftFinding | undefined;
      if (verdict !== "unreadable") {
        edgesChecked += 1;
        if (verdict === "unreached") {
          finding = {
            from: fromPath,
            to: toPath,
            fromLabel: fromNode.label,
            toLabel: toNode.label,
            fromRef,
            toRef,
            kind: "unsupported-edge",
            detail:
              `nothing in ${fromEnd.symbols.join(" or ")} names ${toEnd.symbols.join(" or ")}, `
              + `directly or through a call in the same file, and nothing the other way either `
              + `— worth a look, not necessarily wrong.`,
          };
        }
      } else {
        // Either the ends are not both symbol-anchored, or no body could be
        // read. Fall back to the file-level channels, which need TypeScript.
        if (!TS_JS.test(fromFile) || !TS_JS.test(toFile)) {
          skipEdge(bothNamed ? "no-function-body" : "not-ts-or-js");
          continue;
        }
        edgesChecked += 1;
        finding = checkEdgeCorroboration(
          fromRef,
          toRef,
          fromNode.label,
          toNode.label,
          workspace,
          importCache,
          sharedImporterCandidates,
        );
      }
      recordEdge(edge, fromNode, toNode, finding);
    }
  }

  /*
   * The other direction: what the code has that the board does not show.
   *
   * This was the open `unrepresented` idea for most of the project's life, and it
   * was stuck on one thing -- without a relevance bar, every file in the repo is
   * drift. The bar here is inherited rather than invented: a candidate has to be
   * imported by a file the board already points at, so relevance was decided by
   * whoever drew the diagram. Cost scales with the diagram, not the repository,
   * and it never searches the tree.
   *
   * A directory ref covers everything beneath it, so one box for `src/engine/`
   * excuses the whole subsystem instead of nominating all of it.
   *
   * Suggestion only, and off unless asked for. Whether a module deserves a box is
   * a judgement about what is worth showing, and a check that nagged about it
   * every turn is one that gets switched off -- taking the quiet, correct
   * missing-file check with it.
   */
  const unrepresented: UnrepresentedFinding[] = [];
  if (options?.coverage && !concept) {
    const onBoard = new Map<string, string>();  // absolute -> repo-relative
    const directories: string[] = [];
    for (const node of graph.nodes) {
      if (node.state === "external") continue;
      for (const ref of [node.ref, ...(node.refs ?? [])]) {
        const anchor = ref?.trim();
        if (!anchor) continue;
        const { path: target } = parseRef(anchor);
        // A glob names a directory's worth of files; treat its directory as
        // covering them, which is what the box is claiming.
        const glob = globOf(target);
        const resolved = workspace.resolve(glob ? glob.directory : target);
        if (!resolved) continue;
        const kind = workspace.stat(resolved);
        if (glob || kind === "directory") directories.push(resolved);
        else if (kind === "file") onBoard.set(resolved, target);
      }
    }

    const covered = (absolute: string) =>
      onBoard.has(absolute)
      || directories.some((directory) => absolute.startsWith(directory.replace(/[\\/]?$/, path.sep)));

    const importers = new Map<string, { file: string; by: Set<string> }>();
    for (const [absolute, relative] of onBoard) {
      if (!TS_JS.test(absolute)) continue;
      for (const imported of getImports(absolute, relative, workspace, importCache)) {
        if (covered(imported.abs)) continue;
        // Import resolution keeps the specifier as joined, so a sibling directory
        // arrives as `src/mcp/../engine/config.ts`. Deduping is by absolute path
        // and so already correct; this is about what a reader is shown.
        const shown = path.normalize(imported.rel).split(path.sep).join("/");
        const entry = importers.get(imported.abs) ?? { file: shown, by: new Set<string>() };
        entry.by.add(relative);
        importers.set(imported.abs, entry);
      }
    }

    // Most-imported first: the module several boxes depend on is the one most
    // likely to be worth drawing, and the reader should not have to sort.
    unrepresented.push(
      ...[...importers.values()]
        .map((entry) => ({ file: entry.file, importedBy: [...entry.by].sort() }))
        .sort((a, b) => b.importedBy.length - a.importedBy.length || a.file.localeCompare(b.file)),
    );
  }

  return {
    // `clean` means "nothing has regressed". Work items and promotions are both
    // deliberately excluded: they drive the CLI's exit code, and neither an
    // unbuilt sketch nor good news should fail a build.
    clean: findings.length === 0 && edges.length === 0 && deleted.length === 0,
    findings,
    // A suggestion, never part of `clean`: a diagram that omits a module is a
    // choice about what is worth showing, not a broken claim.
    unrepresented,
    deleted,
    workItems,
    promotions,
    checked,
    skipped,
    skippedWhy,
    assertions,
    excused,
    handDrawn,
    concept,
    edges,
    edgesChecked,
    edgesSkipped,
    edgesSkippedWhy,
  };
}

/**
 * Every board in a directory, sorted so output does not depend on readdir
 * order. A project holds any number of diagrams and none of them is "current",
 * so checking means checking all of them.
 *
 * `dir` has no default on purpose. Every caller has to say where it looked, and
 * the only honest answer comes from the project's config -- a default here is
 * how the engine and the model came to disagree about where diagrams live.
 */
export async function findBoards(root: string, dir: string): Promise<string[]> {
  try {
    const entries = await readdir(path.resolve(root, dir));
    return entries
      .filter((entry) => entry.endsWith(".excalidraw"))
      .sort()
      .map((entry) => path.resolve(root, dir, entry));
  } catch {
    return [];
  }
}

/** Never searched: build output, dependencies, and local state, none of which hold diagrams. */
const NOT_SEARCHED = new Set([
  "node_modules",
  ".git",
  "out",
  "dist",
  "build",
  "vendor",
  "coverage",
  ".diagramos",
  ".next",
  ".venv",
  "target",
]);

/**
 * Boards sitting outside the project's diagram directory.
 *
 * Answers the question a silent check cannot: "you have diagrams, just not where
 * I looked." Only worth asking when the diagram directory turned up nothing,
 * because it reads the whole repository — every directory that is not obviously
 * machinery — and that is far too much work to repeat at the end of every turn.
 *
 * Capped rather than complete. The point is to name enough of them to act on,
 * and a project with two hundred strays has a different problem than a list.
 */
export async function findStrayBoards(
  root: string,
  dir: string,
  limit = 10,
): Promise<{ boards: string[]; more: number }> {
  const skip = path.resolve(root, dir);
  const found: string[] = [];
  let more = 0;

  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // Unreadable directory: nothing to report and not worth failing over.
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (NOT_SEARCHED.has(entry.name) || absolute === skip) continue;
        await walk(absolute);
      } else if (entry.name.endsWith(".excalidraw")) {
        if (found.length < limit) found.push(path.relative(root, absolute));
        else more += 1;
      }
    }
  };

  await walk(path.resolve(root));
  return { boards: found, more };
}

function realOrResolved(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Filesystem-backed workspace rooted at a repository.
 *
 * Refs are strings a model wrote that become filesystem reads, so they are
 * confined the same way board paths are: resolved, then checked again after
 * realpath so a symlink out of the tree cannot be used to probe for files
 * elsewhere. This does not reuse the MCP resolver because the engine stays
 * independent of that layer -- the CLI check has no MCP server at all.
 */
export function createWorkspace(root: string): Workspace {
  const realRoot = realOrResolved(root);
  return {
    resolve(relativePath) {
      if (!relativePath || path.isAbsolute(relativePath)) return undefined;
      const resolved = path.resolve(realRoot, relativePath);
      if (!inside(realRoot, resolved) || !inside(realRoot, realOrResolved(resolved))) {
        return undefined;
      }
      return resolved;
    },
    stat(absolutePath) {
      try {
        return statSync(absolutePath).isDirectory() ? "directory" : "file";
      } catch {
        return "missing";
      }
    },
    read(absolutePath) {
      return readFileSync(absolutePath, "utf8");
    },
    list(absolutePath) {
      try {
        return readdirSync(absolutePath);
      } catch {
        // A directory that cannot be read is empty as far as a check is
        // concerned. Throwing here would fail a whole run over a permission bit.
        return [];
      }
    },
  };
}

/**
 * The committed version of one board, read through git.
 *
 * Git is what makes this check need no mute of its own: committing the diagram is
 * the act that says the deletion was deliberate, and it is a thing people already
 * do. Tombstones were the cheaper option and were rejected -- Excalidraw leaves
 * `isDeleted: true` elements behind, but they live forever, so an old deliberate
 * deletion and a fresh accidental one look identical, and exporting from another
 * editor prunes them.
 *
 * Every failure is silence. No git, an untracked board, a board not in HEAD, a
 * baseline that will not parse: all `undefined`. A check that errors on a
 * repository without git would be worse than one that says nothing.
 *
 * The `status` call comes first because it is the common case and the cheap one:
 * an unmodified board cannot contain an uncommitted deletion, so nothing else
 * runs.
 */
export function createGitBaseline(root: string, boardPath: string): BoardBaseline {
  return {
    committed() {
      const relative = path.relative(root, boardPath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
      // git wants forward slashes in a `HEAD:<path>` spec on every platform.
      const spec = relative.split(path.sep).join("/");
      const git = (args: string[]) =>
        execFileSync("git", args, {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 32 * 1024 * 1024,
        });
      try {
        if (!git(["status", "--porcelain", "--", spec]).trim()) return undefined;
        const parsed = JSON.parse(git(["show", `HEAD:${spec}`])) as Partial<BoardFile>;
        if (!Array.isArray(parsed.elements)) return undefined;
        return parsed as BoardFile;
      } catch {
        return undefined;
      }
    },
  };
}
