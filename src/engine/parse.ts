/**
 * Reading source code, by parsing it rather than by pattern-matching it.
 *
 * This replaces a hand-written lexer and a table of declaration regexes, and
 * the reason is a measurement. `scripts/audit-arrows.mts` asks the TypeScript
 * compiler what is actually true about this repo's own `src/` and compares.
 * Against that ground truth the regexes reported 0.6% of real call edges as
 * absent and failed to find a body for 3.2% of functions; tree-sitter reports
 * neither. Every bug fixed on the way to that 0.6% -- a generic return type
 * read as a body, a method pattern eating its own brace, a comma swallowing an
 * object literal -- was a bug about approximating a grammar, and a grammar
 * does not have them.
 *
 * The surprise was how little of this is per-language. `GRAMMARS` below is the
 * whole table. Everything else here is generic, because three facts hold in
 * every grammar tried:
 *
 *   a declaration  is a node with a `name` field
 *   a function     is one that also has a `body` field
 *   a call         is a node with a `function` field
 *
 * So adding a language is one row and one fixture, not a new lexer. Python
 * needed no code at all, which the old design could not have managed at any
 * price: it is indentation-scoped, and brace counting has nothing to count.
 *
 * The safety property is unchanged and is the reason any of this is allowed to
 * be approximate: a file whose language has no grammar returns `undefined`,
 * the caller counts it as skipped, and nothing is ever reported as absent on
 * the strength of not having looked.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { existsSync } from "node:fs";

/** The whole language table. */
const GRAMMARS = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  rust: "rust",
  python: "python",
} as const;

export type Language = keyof typeof GRAMMARS;

const BY_EXTENSION: Array<[RegExp, Language]> = [
  [/\.tsx$/, "tsx"],
  [/\.jsx$/, "tsx"],
  // `.mts` and `.cts` are TypeScript with a module system named in the
  // extension, and were missing here while `drift.ts` already counted them as
  // TypeScript for its import check -- so the engine disagreed with itself, and
  // five of this repo's own script files parsed as nothing at all.
  [/\.(ts|mts|cts)$/, "ts"],
  [/\.(js|mjs|cjs)$/, "js"],
  [/\.rs$/, "rust"],
  [/\.py$/, "python"],
];

/** The languages with a grammar. Everything else: silence. */
export function languageOf(filePath: string): Language | undefined {
  return BY_EXTENSION.find(([pattern]) => pattern.test(filePath))?.[1];
}

/*
 * Locating the .wasm files.
 *
 * The grammars are a normal runtime dependency, and the bundled CLI keeps its
 * dependencies external, so one resolve works from source and from an npm
 * install alike. Failing to find them disables the engine rather than
 * throwing: no grammar is the same silence as a language we do not support.
 */
const require_ = createRequire(import.meta.url);

function wasmDirectory(): string | undefined {
  try {
    const dir = path.dirname(require_.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter.js"));
    return existsSync(path.join(dir, "tree-sitter.wasm")) ? dir : undefined;
  } catch {
    return undefined;
  }
}

interface Parser {
  parse(source: string): Tree;
  setLanguage(language: unknown): void;
}

export interface Node {
  type: string;
  text: string;
  id: number;
  childCount: number;
  /** True when the parse hit an error anywhere under this node. Recovery is local. */
  hasError: boolean;
  /** Byte offset of the node's first character, for naming the line evidence sits on. */
  startIndex: number;
  child(index: number): Node | null;
  childForFieldName(field: string): Node | null;
}

export interface Tree {
  rootNode: Node;
  delete(): void;
}

const parsers = new Map<Language, Parser>();
let starting: Promise<void> | undefined;

/**
 * Load the runtime and every grammar. Call once, at a point where awaiting is
 * possible; everything below this line is synchronous, which is what keeps the
 * engine callable from the middle of a check.
 *
 * Measured at ~10 ms for the runtime plus 1-3 ms a grammar, once per process.
 * Repeat calls return the same promise.
 */
export function initEngine(): Promise<void> {
  starting ??= load();
  return starting;
}

async function load(): Promise<void> {
  const dir = wasmDirectory();
  if (!dir) return;
  let runtime: { Parser: { init(o: unknown): Promise<void>; new (): Parser };
                 Language: { load(p: string): Promise<unknown> } };
  try {
    runtime = require_(path.join(dir, "tree-sitter.js"));
    await runtime.Parser.init({ locateFile: () => path.join(dir, "tree-sitter.wasm") });
  } catch {
    return; // No runtime is no support, which is silence.
  }
  for (const [language, grammar] of Object.entries(GRAMMARS) as Array<[Language, string]>) {
    const file = path.join(dir, `tree-sitter-${grammar}.wasm`);
    if (!existsSync(file)) continue;
    try {
      const loaded = await runtime.Language.load(file);
      const parser = new runtime.Parser();
      parser.setLanguage(loaded);
      parsers.set(language, parser);
    } catch {
      // One missing grammar is one skipped language, not a broken run.
    }
  }
}

/*
 * Parsed trees, reused across the anchors of one run.
 *
 * A box that names a static and the function using it reads the same file
 * twice, and parsing is the expensive half. Bounded because the MCP server is
 * long-lived and every tree holds WebAssembly memory that only `delete()`
 * returns; the oldest is freed when the cache is full. Never persisted between
 * runs: a stored observation is a fact with a shelf life, which is the rot
 * this tool exists to catch.
 */
const CACHE_LIMIT = 48;
const trees = new Map<string, Tree>();

/** `undefined` when there is no grammar for this language. */
export function parseSource(source: string, language: Language): Tree | undefined {
  const parser = parsers.get(language);
  if (!parser) return undefined;

  const key = `${language}:${source}`;
  const cached = trees.get(key);
  if (cached) {
    // Refresh recency: Map preserves insertion order, so re-inserting moves it last.
    trees.delete(key);
    trees.set(key, cached);
    return cached;
  }

  const tree = parser.parse(source);
  trees.set(key, tree);
  if (trees.size > CACHE_LIMIT) {
    const oldest = trees.keys().next();
    if (!oldest.done) {
      trees.get(oldest.value)?.delete();
      trees.delete(oldest.value);
    }
  }
  return tree;
}

/** Free every cached tree. For tests and for the end of a long-lived run. */
export function resetEngineCache(): void {
  for (const tree of trees.values()) tree.delete();
  trees.clear();
}

/** Depth-first over every node, including the root. */
export function each(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child) each(child, visit);
  }
}
