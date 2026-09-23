/**
 * What one file depends on, whether we read all of it, and whether it escapes.
 *
 * This is the evidence layer for a verdict that does not exist yet. Today an
 * arrow can only ever be *confirmed* -- the check looks for any connection in
 * the code, and failing to find one is never proof there is none. To say an
 * arrow is **backwards** you need the opposite kind of evidence: one dependency
 * declaration, read out of the source text of a file you know you parsed
 * completely, in a language somebody measured.
 *
 * Which is why this does not come from graphify. Graphify keeps confirming, and
 * it is good at breadth. But its JS/TS pass reaches `import('x')` only through a
 * regex rescue it documents as having false positives in comments and strings,
 * because its own walker never visits calls at module scope. That trade is fine
 * for breadth and fatal for refutation: a false positive there is a false
 * accusation about somebody's diagram. This walks the whole tree instead, so a
 * dynamic import at module scope is just a node, and there is nothing to rescue.
 *
 * Three answers per file, and the last two exist to stop the first being
 * over-trusted:
 *
 * - **dependencies** -- what it declares, resolved to files in this repo.
 * - **complete** -- false when the parse recovered from an error somewhere. A
 *   file we could not fully read cannot support "there is no such dependency
 *   anywhere in here", which is the whole shape of a refutation.
 * - **dynamic** -- the ways this file reaches out at runtime, which no static
 *   reader can follow. One flag on either endpoint has to be enough to withhold
 *   a verdict, so they are collected per file and never per repo.
 *
 * Rust is read by `deps-rust.ts` and Python by `deps-python.ts`, both returned
 * in the same shape, because what a caller wants is the same three answers
 * whatever the language. Almost nothing else is shared: a TypeScript dependency
 * is a string literal in one of four statements, a Rust one is a path into a
 * module tree no single file contains, and a Python one is a position in a
 * module tree that depends on a `sys.path` no file states.
 */
import { licenceFor } from "./licence";
import { each, languageOf, parseSource, type Node } from "./parse";
import { resolveDependency, type ConfigCache } from "./resolve";
import { crateOf, readRustLayout, type RustLayout } from "./rust";
import { readRustDependencies } from "./deps-rust";
import { readPythonDependencies } from "./deps-python";
import type { Workspace } from "./workspace";

/**
 * Where the Rust module tree is kept between files.
 *
 * A `\0` cannot appear in a path, so this key can never be mistaken for the
 * directory lookups sharing the map.
 */
const RUST_LAYOUT_KEY = "\0rust-layout";

/**
 * The module tree, built once per cache.
 *
 * Rust resolves against a module tree rather than against the filesystem, and
 * the tree is a fact about the whole repository -- a path can name a sibling
 * package in the same workspace. So it is built once and kept in the same cache
 * the tsconfig lookups use, under a key no path can collide with.
 */
function rustLayoutFor(workspace: Workspace, configs: ConfigCache): RustLayout {
  const cached = configs.get(RUST_LAYOUT_KEY);
  const layout = cached?.kind === "rust-layout" ? cached : readRustLayout(workspace);
  configs.set(RUST_LAYOUT_KEY, layout);
  return layout;
}

/**
 * Whether a reader here can place this file well enough to be believed.
 *
 * `licenceFor` answers about the extension, and for Rust that is only half the
 * question. The corpus was measured over files a crate declares, and the
 * licence says why the rest were left out rather than netted off: a file no
 * crate declares is one rustc never compiles, so the referee has no opinion
 * about it and neither may we. Rust leaves out 15% of the corpus that way.
 *
 * The failure is not abstract. `pub mod route;` in a crateless file resolves to
 * nothing -- not because the module is absent, but because there is no crate
 * root to resolve it against -- and a confirming channel handed that answer
 * calls a true arrow unsupported. That is the reader mistaking its own
 * blindness for an absence, which is the first paragraph of `licence.ts`.
 *
 * TypeScript has no equivalent condition: a specifier resolves against the
 * filesystem, so there, having the extension is having the reader.
 */
export function readerCanPlace(
  filePath: string,
  workspace: Workspace,
  configs: ConfigCache = new Map(),
): boolean {
  if (!licenceFor(filePath)) return false;
  if (languageOf(filePath) !== "rust") return true;
  return crateOf(filePath, rustLayoutFor(workspace, configs)) !== undefined;
}

/**
 * Why a file cannot be read statically.
 *
 * Named rather than counted because they are not equally bad and a later
 * report has to be able to say which one cost a verdict.
 */
export type DynamicReason =
  /** `import("./x")` -- the specifier may be built at runtime, and the timing is not ours. */
  | "dynamic-import"
  /** `eval`, or `new Function`. Anything at all can be in there. */
  | "eval"
  /** `table[name]()` -- the callee is a value, so the call graph is not in the text. */
  | "computed-call"
  /**
   * A module-level `let` that gets called: setter injection.
   *
   * This is the one graphify's `indirect_call` misses. All 11 of its edges on
   * this repo are inferred argument passing, and none touch `layout.ts`, where
   * `measurerOverride?.()` is exactly this shape.
   */
  | "mutable-function"
  /**
   * A macro at item position, which parses as a token tree and nothing else.
   *
   * Rust only. `cfg_if! { use crate::unix::Fd; }` puts a real import somewhere
   * no grammar can see it -- the `use` inside is three loose tokens -- so the
   * file could be declaring anything and the reader would not know.
   */
  | "macro-expansion";

/**
 * The escapes that can hide an import, which is not all of them.
 *
 * The question is: **could there be an import in this file that we did not
 * see?** `needs` asks it before saying a file does not import another, and
 * `closed` asks it before saying nothing outside a box reaches in.
 *
 * - `dynamic-import` and `eval` can bring a module in at runtime, so yes.
 * - `macro-expansion` is a macro at item position, whose expansion is exactly
 *   where a `use` can be written and not read. The reader does better than the
 *   flag suggests -- it reassembles `::`-joined runs out of token trees, and it
 *   reads `macro_rules!` bodies where they are defined -- but a macro from
 *   another crate can still expand to a path no file here spells. The flag's own
 *   words are that the file "could be declaring anything and the reader would
 *   not know", and a claim that everything was read cannot be built on a file
 *   that says that about itself.
 * - `computed-call` and `mutable-function` are about *calling* something, and no
 *   call creates a module dependency that is not already declared somewhere in
 *   the text -- you cannot import through `table[key]()`. A file whose only
 *   escape is one of those is completely readable for this question.
 *
 * So the split is by what an escape can hide, not by how alarming it sounds.
 * Until #344 `needs` kept its own answer -- every escape blinds -- and a wrong
 * arrow went unaccused whenever either file held one `table[name]()`. One
 * table, and a record rather than a set, so a new reason cannot be added
 * without answering this for it.
 */
const HIDES_AN_IMPORT: Record<DynamicReason, boolean> = {
  "dynamic-import": true,
  eval: true,
  "macro-expansion": true,
  "computed-call": false,
  "mutable-function": false,
};

/** Whether a file's escapes leave room for an import no reader saw. */
export function mayHideAnImport(dynamic: readonly DynamicReason[]): boolean {
  return dynamic.some((reason) => HIDES_AN_IMPORT[reason]);
}

export interface FileDependency {
  /** The specifier as written, so a report can quote the line. */
  specifier: string;
  /** Repo-relative file it resolves to. Absent for anything outside this repo. */
  file?: string;
  /** 1-based, for naming the evidence a verdict rests on. */
  line: number;
  /** True when the declaration is `import(...)` rather than a static form. */
  deferred: boolean;
  /**
   * True when the declaration brings in *whatever that file exports* rather
   * than named things: `from x import *`, `export * from "./x"`, `use x::*`.
   *
   * Recorded because a star is how a name reaches a file the tail never names
   * (#323). `django/contrib/gis/db/models/__init__.py` star-imports
   * `django/db/models`, which star-imports `aggregates.py`, and the compiler
   * says the first file imports the third. A reader that cannot see the star
   * cannot follow that, and since #323 an absence is an accusation.
   */
  star?: boolean;
  /**
   * The names this declaration brings in, where the language writes them:
   * `import { a, b } from`, `export { a } from`, `from x import a, b`, and a
   * Rust path's last segment. Empty when the form names nothing (`import "./x"`).
   *
   * Read when a name is followed through a file that re-exports it (#323).
   * `lib/index.ts` writing `export { db } from "./database"` is `database.ts`'s
   * `db` arriving in whatever imports `db` from `lib`, and without the names
   * there is no way to tell that from a file re-exporting five others.
   */
  names?: readonly string[];
}

export interface FileDependencies {
  /** Everything this file declares a dependency on, in source order. */
  dependencies: FileDependency[];
  /** False when tree-sitter recovered from an error anywhere in the file. */
  complete: boolean;
  /** Empty when the file can be read statically end to end. */
  dynamic: DynamicReason[];
}

/** A node's children, for the shapes tree-sitter gives no field name to. */
function children(node: Node): Node[] {
  const found: Node[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child) found.push(child);
  }
  return found;
}

/** Strips the quotes tree-sitter includes in a string node's text. */
function unquote(text: string): string {
  return text.length >= 2 ? text.slice(1, -1) : text;
}

/**
 * The first string literal passed to a call: the specifier of `require`/`import`.
 *
 * Backticks count, but only with nothing interpolated into them. ``import(`./x`)``
 * is a string that happens to be quoted oddly and every compiler reads it as one;
 * ``import(`./${name}`)`` is a value, and guessing at it is how a reader starts
 * inventing dependencies. The `dynamic-import` flag already records that the file
 * reaches out at runtime, so nothing is lost by declining the second.
 */
function firstStringArgument(call: Node): Node | undefined {
  const args = call.childForFieldName("arguments");
  if (!args) return undefined;
  for (let index = 0; index < args.childCount; index += 1) {
    const child = args.child(index);
    if (child?.type === "string") return child;
    if (child?.type === "template_string" && !interpolated(child)) return child;
  }
  return undefined;
}

/** True when a template has any `${...}` in it, which makes its value runtime-only. */
function interpolated(template: Node): boolean {
  for (let index = 0; index < template.childCount; index += 1) {
    if (template.child(index)?.type === "template_substitution") return true;
  }
  return false;
}

/**
 * 1-based line a node starts on.
 *
 * From the node's own offset, not by searching for its text: a file that
 * imports `"./layout"` twice would otherwise report both on the first line, and
 * a verdict that names the wrong line is worse than one that names none.
 */
function lineOf(source: string, node: Node): number {
  return source.slice(0, node.startIndex).split("\n").length;
}

/**
 * Names bound by a module-level `let` or `var`.
 *
 * Module level means a direct child of the file, `export` unwrapped. A `let`
 * inside a function is an ordinary local and says nothing about whether the
 * module can be read statically. `const` is excluded: it cannot be swapped
 * later, so calling it is an ordinary call.
 */
function moduleLevelMutables(root: Node): Set<string> {
  const names = new Set<string>();
  for (let index = 0; index < root.childCount; index += 1) {
    const child = root.child(index);
    if (!child) continue;
    const declaration = child.type === "export_statement"
      ? child.childForFieldName("declaration")
      : child;
    if (!declaration) continue;
    if (declaration.type === "lexical_declaration") {
      // `lexical_declaration` covers both `let` and `const`; the keyword is the
      // first token and is the only thing that tells them apart.
      if (declaration.child(0)?.text !== "let") continue;
    } else if (declaration.type !== "variable_declaration") {
      continue;
    }
    for (let inner = 0; inner < declaration.childCount; inner += 1) {
      const declarator = declaration.child(inner);
      if (declarator?.type !== "variable_declarator") continue;
      const name = declarator.childForFieldName("name");
      if (name?.type === "identifier") names.add(name.text);
    }
  }
  return names;
}

/**
 * Everything one file says about what it needs and how readable it is.
 *
 * `undefined` when there is no grammar for this file -- the house default, and
 * the reason any of this is allowed to be exact: a language we cannot parse is
 * silence, never an absence of dependencies.
 */
export function readDependencies(
  filePath: string,
  source: string,
  workspace: Workspace,
  configs: ConfigCache = new Map(),
): FileDependencies | undefined {
  let memo = readings.get(configs);
  if (!memo) {
    memo = { workspace, byFile: new Map() };
    readings.set(configs, memo);
  }
  // A cache carried to a second workspace is somebody else's mistake to find;
  // here it only means nothing is remembered.
  if (memo.workspace !== workspace) return readUncached(filePath, source, workspace, configs);
  const hit = memo.byFile.get(filePath);
  if (hit && hit.source === source) return hit.reading;
  const read = readUncached(filePath, source, workspace, configs);
  const reading = read && frozen(read);
  memo.byFile.set(filePath, { source, reading });
  return reading;
}

/**
 * Readings already made against one config cache, so a file is parsed once
 * per cache rather than once per question (#311).
 *
 * The same lifetime as the cache it hangs off, which is the caller's: one
 * check for the server, one run for a measurement script. Keyed weakly so a
 * dropped cache takes its readings with it. The source is kept and compared
 * because a caller may hand in text that is not what is on disk, and a
 * reading of other text is not this file's.
 *
 * Handed out frozen: every caller shares one object, and a caller that sorted
 * it in place would change the next caller's answer rather than its own.
 */
const readings = new WeakMap<ConfigCache, {
  workspace: Workspace;
  byFile: Map<string, { source: string; reading: FileDependencies | undefined }>;
}>();

function frozen(reading: FileDependencies): FileDependencies {
  for (const dependency of reading.dependencies) Object.freeze(dependency);
  Object.freeze(reading.dependencies);
  Object.freeze(reading.dynamic);
  return Object.freeze(reading);
}

function readUncached(
  filePath: string,
  source: string,
  workspace: Workspace,
  configs: ConfigCache,
): FileDependencies | undefined {
  const language = languageOf(filePath);
  if (language === "rust") {
    return readRustDependencies(filePath, source, workspace, rustLayoutFor(workspace, configs));
  }
  if (language === "python") {
    return readPythonDependencies(filePath, source, workspace);
  }
  if (!language || (language !== "ts" && language !== "tsx" && language !== "js")) {
    // Deliberately TypeScript and JavaScript only, plus Rust and Python above.
    // Every other grammar this engine loads declares dependencies differently,
    // and a reader that guesses at a language it was not measured on is the
    // thing the licence step exists to prevent.
    return undefined;
  }
  const tree = parseSource(source, language);
  if (!tree) return undefined;

  const mutables = moduleLevelMutables(tree.rootNode);
  const dependencies: FileDependency[] = [];
  const dynamic = new Set<DynamicReason>();

  const declare = (
    node: Node,
    specifier: string,
    deferred: boolean,
    star = false,
    names: string[] = [],
  ) => {
    const resolved = resolveDependency(specifier, filePath, workspace, configs);
    dependencies.push({
      specifier,
      ...(resolved ? { file: resolved.rel } : {}),
      line: lineOf(source, node),
      deferred,
      ...(star ? { star: true } : {}),
      ...(names.length > 0 ? { names } : {}),
    });
  };

  /**
   * The names an import or a re-export clause binds, and whether it took the
   * lot. `import * as ns from "./x"` counts as the lot: the names are reached
   * through `ns` and nothing in the text says which.
   */
  const clauseOf = (statement: Node): { names: string[]; star: boolean } => {
    const names: string[] = [];
    let star = false;
    each(statement, (node) => {
      if (node.type === "namespace_import" || node.type === "namespace_export") star = true;
      if (node.type !== "import_specifier" && node.type !== "export_specifier") return;
      // The name as written at the far end, not the local alias: the question
      // is what that file exports.
      const name = node.childForFieldName("name");
      if (name) names.push(name.text);
    });
    return { names, star };
  };

  each(tree.rootNode, (node) => {
    switch (node.type) {
      case "import_statement":
      case "export_statement": {
        // An `export` carries a source only when it re-exports; a plain
        // `export const x = 1` has nothing to depend on.
        const source_ = node.childForFieldName("source");
        // `export * from "./x"` and `export * as ns from "./x"`: a re-export of
        // whatever that file exports, which is how a name reaches a file this
        // one never names.
        if (!source_) return;
        const clause = clauseOf(node);
        const star = clause.star
          || (node.type === "export_statement" && children(node).some((child) => child.type === "*"));
        declare(source_, unquote(source_.text), false, star, clause.names);
        return;
      }
      case "new_expression": {
        if (node.childForFieldName("constructor")?.text === "Function") dynamic.add("eval");
        return;
      }
      case "call_expression": {
        const callee = node.childForFieldName("function");
        if (!callee) return;
        if (callee.type === "import") {
          dynamic.add("dynamic-import");
          const specifier = firstStringArgument(node);
          // A specifier that is not a literal is unreadable by anyone, and the
          // dynamic flag above already says so.
          if (specifier) declare(specifier, unquote(specifier.text), true);
          return;
        }
        if (callee.type === "subscript_expression") {
          dynamic.add("computed-call");
          return;
        }
        if (callee.type !== "identifier") return;
        if (callee.text === "require") {
          const specifier = firstStringArgument(node);
          if (specifier) declare(specifier, unquote(specifier.text), false);
          return;
        }
        if (callee.text === "eval") dynamic.add("eval");
        else if (mutables.has(callee.text)) dynamic.add("mutable-function");
        return;
      }
      default:
    }
  });

  return {
    dependencies,
    // Recovery is local, so the rest of the file was still read -- but a claim
    // judged against a file we could not fully read should be visible as such,
    // the same call `symbolEvidence` makes with `downgraded`.
    complete: !tree.rootNode.hasError,
    dynamic: [...dynamic],
  };
}

/** Just the repo-relative files, which is what a dependency question usually wants. */
export function dependencyFiles(read: FileDependencies): string[] {
  const files: string[] = [];
  for (const dependency of read.dependencies) {
    if (dependency.file && !files.includes(dependency.file)) files.push(dependency.file);
  }
  return files;
}
