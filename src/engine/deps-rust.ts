/**
 * What one Rust file declares a dependency on.
 *
 * Split from `deps.ts` because almost nothing is shared. In TypeScript a
 * dependency is a string literal in one of four statements; in Rust it is a
 * *path*, paths appear in every position the language has, and the same one can
 * name two files at once -- `crate::ptr::Own` names the crate root and `ptr`.
 * Folding that into the TypeScript walk would have produced a switch statement
 * that was really two readers sharing a brace.
 *
 * Every position is read, not just `use`:
 *
 * - `mod x;`, which is the declaration that *creates* the module tree, and the
 *   only kind whose target is a file by definition rather than by resolution.
 * - `use` in all its shapes -- braces, globs, `as`, and nested lists -- including
 *   the ones written inside a function body, where `anyhow` puts real imports.
 * - `extern crate x;`, which is how edition 2015 names a dependency at all.
 * - Any path written out in place: `crate::ErrorImpl::error(..)` in an expression,
 *   `impl crate::traits::Show for X` in a type. A reader that only followed `use`
 *   would call those files unrelated, and "unrelated" is what turns into a
 *   backwards verdict against somebody's diagram.
 *
 * The one thing it cannot see is a macro. `cfg_if! { use crate::unix::Fd; }`
 * parses as a token tree -- the `use` inside it is not a `use`, it is three
 * loose tokens -- so a macro at item position could be hiding anything, and the
 * file says so with a flag instead of pretending to have read it.
 */
import { each, parseSource, type Node } from "./parse";
import type { DynamicReason, FileDependencies, FileDependency } from "./deps";
import {
  PUNCTUATION,
  childModule,
  children,
  crateOf,
  aliasedUses,
  expandUse,
  moduleDirectory,
  resolveRustPath,
  segmentsOf,
  walkPath,
  type RustLayout,
  type RustPosition,
  type RustTarget,
} from "./rust";
import type { Workspace } from "./workspace";

/**
 * Macros whose body is a template for someone else's code.
 *
 * Their token trees are quoted, not evaluated, so a path inside one says nothing
 * about what this file depends on.
 */
const QUOTING = new Set(["quote", "quote_spanned", "parse_quote", "parse_quote_spanned", "stringify"]);

/** Token types a path can begin with, when it is being read out of a macro. */
const PATH_START = new Set(["identifier", "crate", "self", "super", "type_identifier", "metavariable"]);
const PATH_SEGMENT = new Set(["identifier", "type_identifier", "crate", "self", "super"]);

/** `a/b/../c` -> `a/c`, so a `#[path]` reaching upwards names a real place. */
function normalizePath(value: string): string {
  const out: string[] = [];
  for (const part of value.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** 1-based line a node starts on. */
function lineOf(source: string, node: Node): number {
  return source.slice(0, node.startIndex).split("\n").length;
}

/** The string inside `include!("...")`, if there is exactly one. */
function macroString(invocation: Node): string | undefined {
  let found: string | undefined;
  each(invocation, (node) => {
    if (node.type === "string_content" && found === undefined) found = node.text;
  });
  return found;
}

/**
 * Everything a Rust file declares, resolved against the crate layout.
 *
 * The layout is passed in rather than built here because it is a fact about the
 * whole repository -- a path can name a sibling package in the same workspace --
 * and rebuilding it per file would walk the tree once for every file in it.
 */
export function readRustDependencies(
  filePath: string,
  source: string,
  workspace: Workspace,
  layout: RustLayout,
): FileDependencies | undefined {
  const tree = parseSource(source, "rust");
  if (!tree) return undefined;

  const dependencies: FileDependency[] = [];
  const dynamic = new Set<DynamicReason>();
  const own = moduleDirectory(filePath, layout);
  const scope = boundModules(filePath, tree.rootNode, layout, workspace, own);
  const fileDirectory = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";

  const record = (node: Node, specifier: string, file?: string): void => {
    dependencies.push({
      specifier,
      ...(file ? { file } : {}),
      line: lineOf(source, node),
      deferred: false,
    });
  };

  /**
   * The module named inside a `pub(..)`, if there is one.
   *
   * `pub(crate)` and `pub(in crate::a)` are annotations rather than reaches, and
   * it would be tidier if they named nothing. They do name something:
   * rust-analyzer resolves the `crate` in `pub(crate)` to the crate root like
   * any other path, so a reader that skipped them would disagree with the
   * referee on every file whose only mention of the root is a visibility marker.
   * Matching the language beats matching taste.
   *
   * Called on the `mod` and `use` items too, whose own handling consumes them
   * before the walk could reach the modifier on its own.
   */
  const takeModifier = (part: Node, position: RustPosition): void => {
    for (const entry of children(part)) {
      if (PUNCTUATION.has(entry.type) || entry.type === "pub" || entry.type === "in") continue;
      // `pub(self)` names the module the item is already in, so it reaches
      // nothing. `pub(crate)`, `pub(super)` and `pub(in crate::a)` all name a
      // definite module somewhere else.
      if (entry.type === "self") continue;
      const segments = segmentsOf(entry);
      if (segments) takePath(part, segments, false, position);
    }
  };

  const takeVisibility = (item: Node, position: RustPosition): void => {
    for (const part of children(item)) {
      if (part.type === "visibility_modifier") takeModifier(part, position);
    }
  };

  const takePath = (node: Node, segments: string[], declaration: boolean, position?: RustPosition): void => {
    const targets = resolveRustPath(segments, filePath, layout, workspace, declaration, position);
    const written = segments.join("::");
    if (targets.length === 0) {
      record(node, written);
      return;
    }
    for (const target of targets) record(node, written, target.file);
  };

  /**
   * Paths inside a macro, rebuilt from loose tokens.
   *
   * `write!(f, "..", crate::util::escape::DebugByte(byte))` is an ordinary
   * dependency written in an ordinary place, but a macro argument is a token
   * tree -- there is no path node in there, only `crate`, `::`, `util`, `::`
   * and so on, side by side. So the run is reassembled by hand. Only runs with
   * a `::` in them count: a lone identifier in a macro is an argument, not a
   * path.
   *
   * This is best effort and stays that way. A macro can still *generate* a
   * dependency that appears nowhere in the tokens, which is why an item-level
   * macro also raises `macro-expansion` and stops a verdict outright.
   */
  const takeTokens = (tokens: Node, position: RustPosition): void => {
    const parts = children(tokens);
    let index = 0;
    while (index < parts.length) {
      const part = parts[index]!;
      if (part.type === "token_tree") {
        takeTokens(part, position);
        index += 1;
        continue;
      }
      if (!PATH_START.has(part.type)) {
        index += 1;
        continue;
      }
      const segments = [part.text];
      let ahead = index + 1;
      while (ahead + 1 < parts.length && parts[ahead]!.type === "::" && PATH_SEGMENT.has(parts[ahead + 1]!.type)) {
        segments.push(parts[ahead + 1]!.text);
        ahead += 2;
      }
      // Same rule as a real call: a run followed by `(` is a callee, so its
      // last segment is a function rather than a module.
      const called = parts[ahead]?.type === "token_tree" && parts[ahead]!.text.startsWith("(");
      const named = called ? segments.slice(0, -1) : segments;
      if (named.length > 1) takePath(part, named, false, position);
      index = Math.max(ahead, index + 1);
    }
  };

  /**
   * `moduleDirectory` is where a `mod x;` seen right here would put its file. It
   * changes on the way into an inline `mod y { .. }` and nowhere else, which is
   * why the walk is written out rather than handed to `each`.
   */
  const walk = (node: Node, position: RustPosition, itemLevel: boolean): void => {
    let pathAttribute: string | undefined;

    for (const child of children(node)) {
      switch (child.type) {
        case "attribute_item": {
          // `#[path = "x.rs"]` moves the next `mod`'s file. It is a sibling of
          // the `mod`, not a child, so it is remembered until one arrives.
          const text = child.text;
          const match = /\bpath\s*=\s*"([^"]*)"/.exec(text);
          if (match) pathAttribute = match[1];
          continue;
        }
        case "mod_item": {
          takeVisibility(child, position);
          const named = child.childForFieldName("name");
          // `mod r#match;` is the module `match`; the escape is spelling, not name.
          const name = named ? { text: named.text.replace(/^r#/, "") } : undefined;
          const body = child.childForFieldName("body");
          if (body) {
            // An inline module owns a directory but no file of its own, so
            // nothing is declared here -- only the place its children sit moves.
            walk(
              body,
              {
                directory: name ? `${position.directory}/${name.text}` : position.directory,
                inline: position.inline + 1,
                scope: position.scope,
              },
              true,
            );
          } else if (name) {
            const written = pathAttribute ? `mod ${name.text} @ ${pathAttribute}` : `mod ${name.text}`;
            const target = pathAttribute
              ? normalizePath(`${position.directory}/${pathAttribute}`)
              : childModule(position.directory, name.text, workspace)?.file;
            const absolute = target ? workspace.resolve(target) : undefined;
            record(child, written, absolute && workspace.stat(absolute) === "file" ? target : undefined);
          }
          pathAttribute = undefined;
          continue;
        }
        case "use_declaration": {
          takeVisibility(child, position);
          for (const inner of children(child)) {
            if (PUNCTUATION.has(inner.type) || inner.type === "visibility_modifier") continue;
            for (const segments of expandUse(inner, [])) takePath(child, segments, true, position);
          }
          pathAttribute = undefined;
          continue;
        }
        case "extern_crate_declaration": {
          takeVisibility(child, position);
          // The `name` field, not the last identifier: `extern crate grep_printer
          // as printer` ends with the alias, and resolving that names nothing.
          const name = child.childForFieldName("name");
          if (name) takePath(child, [name.text], true, position);
          pathAttribute = undefined;
          continue;
        }
        case "macro_invocation": {
          const name = children(child)[0];
          if (name && QUOTING.has(name.text)) {
            /*
             * `quote! { clap::Error::raw(..) }` is code being *written*, not code
             * being run: the paths in it belong to whatever crate compiles the
             * output, and reading them made every proc-macro crate look like it
             * depended on the library it generates calls into. Seven of clap's
             * false edges were this.
             */
            pathAttribute = undefined;
            continue;
          }
          if (name?.text === "include") {
            const relative = macroString(child);
            if (relative) {
              const target = `${fileDirectory}/${relative}`.replace(/^\//, "");
              const absolute = workspace.resolve(target);
              record(child, `include!("${relative}")`,
                absolute && workspace.stat(absolute) === "file" ? target : undefined);
              pathAttribute = undefined;
              continue;
            }
          }
          /*
           * Everything inside a macro is a token tree, so a `use` in there is
           * not a `use`. At item level that can hide a whole dependency, which
           * is the one thing a refutation may not be built on top of.
           */
          if (itemLevel) dynamic.add("macro-expansion");
          for (const part of children(child)) {
            if (part.type === "token_tree") takeTokens(part, position);
          }
          pathAttribute = undefined;
          continue;
        }
        case "visibility_modifier": {
          takeModifier(child, position);
          pathAttribute = undefined;
          continue;
        }
        case "call_expression": {
          /*
           * `crate::util::str_to_bool(value)` calls a function that happens to
           * share its name with a file. Modules and functions live in separate
           * namespaces in Rust, and the thing being called is never the module,
           * so the last segment of a callee is dropped before resolving. Without
           * it a path lands on `util/str_to_bool.rs` -- a real file, and the
           * wrong answer.
           */
          const callee = child.childForFieldName("function");
          if (callee && (callee.type === "scoped_identifier" || callee.type === "scoped_type_identifier")) {
            const segments = segmentsOf(callee);
            if (segments && segments.length > 1) takePath(callee, segments.slice(0, -1), false, position);
            for (const part of children(child)) if (part !== callee) walk(part, position, false);
            pathAttribute = undefined;
            continue;
          }
          walk(child, position, false);
          pathAttribute = undefined;
          continue;
        }
        case "scoped_identifier":
        case "scoped_type_identifier": {
          const segments = segmentsOf(child);
          // The children of a path are its own prefixes, and every module along
          // it is already reported, so there is nothing below worth descending
          // into.
          if (segments) takePath(child, segments, false, position);
          pathAttribute = undefined;
          continue;
        }
        case "macro_definition": {
          // `macro_rules!` bodies are token trees too, and `$crate::x` in one is
          // a path into this very crate.
          for (const part of children(child)) takeTokens(part, position);
          pathAttribute = undefined;
          continue;
        }
        default: {
          if (!PUNCTUATION.has(child.type)) pathAttribute = undefined;
          const inside = child.type === "block" || child.type === "field_declaration_list";
          walk(child, position, itemLevel && !inside);
        }
      }
    }
  };

  walk(tree.rootNode, { directory: own, inline: 0, scope }, true);

  return {
    dependencies,
    complete: !tree.rootNode.hasError,
    dynamic: [...dynamic],
  };
}

/**
 * The short names this file has given to modules, from its own `use` lines.
 *
 * Read in a pass of its own because Rust does not care about item order: a `use`
 * at the bottom of a file binds a name used at the top, so nothing can be
 * resolved until they have all been seen.
 *
 * Only bindings that name a *module* are kept. `use crate::util::Table` binds a
 * struct, and a later `Table::new()` says nothing about which file anything
 * lives in -- recording it would turn every associated function call into a
 * dependency on the file the type came from.
 */
function boundModules(
  filePath: string,
  root: Node,
  layout: RustLayout,
  workspace: Workspace,
  directory: string,
): Map<string, RustTarget> {
  const scope = new Map<string, RustTarget>();
  const position: RustPosition = { directory, inline: 0 };
  each(root, (node) => {
    if (node.type !== "use_declaration") return;
    for (const inner of children(node)) {
      if (PUNCTUATION.has(inner.type) || inner.type === "visibility_modifier") continue;
      for (const use of aliasedUses(inner, [])) {
        if (use.glob || scope.has(use.alias)) continue;
        const walked = walkPath(use.segments, filePath, layout, workspace, true, 4, position);
        const last = walked.targets[walked.targets.length - 1];
        if (walked.complete && last) scope.set(use.alias, last);
      }
    }
  });
  return scope;
}

/** Kept beside the reader so a caller can tell whether a file has a crate at all. */
export function hasCrate(filePath: string, layout: RustLayout): boolean {
  return crateOf(filePath, layout) !== undefined;
}
