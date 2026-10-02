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

/**
 * std's macros that expand to an expression or to nothing, never to an item
 * (#366). At item level only `compile_error!` and the `assert!` family appear;
 * the rest are here because a `macro_rules!` body that calls them is judged by
 * what it calls.
 */
const EXPANDS_TO_NO_ITEM = new Set([
  "compile_error", "assert", "assert_eq", "assert_ne", "debug_assert", "debug_assert_eq",
  "debug_assert_ne", "panic", "unreachable", "todo", "unimplemented", "format", "format_args",
  "print", "println", "eprint", "eprintln", "write", "writeln", "vec", "matches", "concat",
  "stringify", "cfg", "env", "option_env", "line", "column", "file", "module_path", "dbg",
]);

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
  /**
   * Set when `source` is not `filePath`'s own text but a file it pastes in
   * with `include!` (#389): the files already being pasted, so a pair that
   * includes each other stops, and the names the including file's own `use`
   * lines bound, which the pasted text sees as its own.
   */
  pasted?: { into: Set<string>; scope: Map<string, RustTarget> },
): FileDependencies | undefined {
  const tree = parseSource(source, "rust");
  if (!tree) return undefined;

  const dependencies: FileDependency[] = [];
  const dynamic = new Set<DynamicReason>();
  let complete = !tree.rootNode.hasError;
  const own = moduleDirectory(filePath, layout);
  const scope = new Map([...(pasted?.scope ?? []), ...boundModules(filePath, tree.rootNode, layout, workspace, own)]);
  const fileDirectory = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";

  /*
   * Whether an item-level macro could expand to an import nobody read (#366).
   *
   * A `macro_rules!` defined in this file is read where it is defined -- its
   * `crate::x` and `$crate::x` paths are dependencies already -- so expanding
   * it names nothing new, unless its body writes an item that brings a module
   * in by an argument's name (`use $p;`, `mod $m;`, `extern crate`), glues a
   * path together out of an argument (`$m::run()`), or calls a macro that
   * might. Anything defined elsewhere, or qualified, could expand to anything.
   */
  const defined = new Map<string, string>();
  each(tree.rootNode, (node) => {
    if (node.type !== "macro_definition") return;
    const name = node.childForFieldName("name")?.text;
    if (name && !defined.has(name)) defined.set(name, node.text.replace(/^macro_rules!\s*\w+/, ""));
  });
  const judged = new Map<string, boolean>();
  const expandsToNoImport = (name: string): boolean => {
    if (EXPANDS_TO_NO_ITEM.has(name)) return true;
    const body = defined.get(name);
    if (body === undefined) return false;
    const known = judged.get(name);
    if (known !== undefined) return known;
    judged.set(name, true); // a macro calling itself is judged by the rest of its body
    const writesAnItem = /\b(use|mod|extern|include)\b/.test(body);
    const gluesAPath = /\$(?!crate\b)\w+\s*::|::\s*\$\w+/.test(body);
    const calls = [...body.matchAll(/([\w$]+(?:\s*::\s*[\w$]+)*)\s*!/g)].map((match) => match[1]!);
    const verdict = !writesAnItem && !gluesAPath
      && calls.every((called) => /^\w+$/.test(called) && expandsToNoImport(called));
    judged.set(name, verdict);
    return verdict;
  };

  const record = (node: Node, specifier: string, file?: string, star = false, visibility = false): void => {
    /*
     * A Rust path carries the name at its end -- `crate::parser::ArgMatcher` --
     * so the names a `use` binds are read off the specifier rather than from a
     * clause. `mod x` and a path ending in a module segment name nothing an
     * item chain could follow, which the capital-letter-or-underscore shape
     * below is a rough and safe reading of: a miss here reports a route
     * instead of confirming, never the other way round (#323).
     */
    const tail = specifier.split("::").pop() ?? "";
    const names = !star && /^[A-Za-z_]\w*$/.test(tail) && !specifier.startsWith("mod ") ? [tail] : [];
    dependencies.push({
      specifier,
      ...(file ? { file } : {}),
      line: lineOf(source, node),
      deferred: false,
      ...(star ? { star: true } : {}),
      ...(names.length > 0 ? { names } : {}),
      ...(visibility ? { visibility: true } : {}),
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
   * So they are recorded, and marked (#319): a visibility marker says who may
   * see an item, not what the file uses, and an arrow's verdict does not rest
   * on one. `fnv.rs`, whose only mention of the root is `pub(crate) type`, came
   * back as using `lib.rs`, and a backwards arrow into the root went green.
   *
   * Called on the `mod` and `use` items too, whose own handling consumes them
   * before the walk could reach the modifier on its own.
   */
  /** A path whose landing the text does not give, and where it is written (#393). */
  const unplaced = (node: Node, specifier: string, bang: number): void => {
    dependencies.push({
      specifier,
      line: lineOf(source, node),
      deferred: false,
      unplaced: { start: node.startIndex, end: node.startIndex + node.text.length + bang },
    });
  };

  const takeModifier = (part: Node, position: RustPosition): void => {
    for (const entry of children(part)) {
      if (PUNCTUATION.has(entry.type) || entry.type === "pub" || entry.type === "in") continue;
      // `pub(self)` names the module the item is already in, so it reaches
      // nothing. `pub(crate)`, `pub(super)` and `pub(in crate::a)` all name a
      // definite module somewhere else.
      if (entry.type === "self") continue;
      const segments = segmentsOf(entry);
      if (segments) takePath(part, segments, false, position, false, true);
    }
  };

  const takeVisibility = (item: Node, position: RustPosition): void => {
    for (const part of children(item)) {
      if (part.type === "visibility_modifier") takeModifier(part, position);
    }
  };

  const takePath = (
    node: Node,
    segments: string[],
    declaration: boolean,
    position?: RustPosition,
    star = false,
    visibility = false,
  ): void => {
    const targets = resolveRustPath(segments, filePath, layout, workspace, declaration, position);
    const written = segments.join("::");
    if (targets.length === 0) {
      record(node, written, undefined, star, visibility);
      return;
    }
    for (const target of targets) record(node, written, target.file, star, visibility);
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
   * `include!("gen_body.rs")` pastes that file's text in here, and rustc
   * compiles it as part of this module (#389): its `use` lines and paths are
   * this file's own, resolved from here, and quoted at the `include!` line.
   * A path in it that only the compiler could place is asked about a range
   * in the other file, which no question here can carry, so it blinds the
   * list instead of being dropped from it.
   */
  const paste = (at: Node, target: string, absolute: string): void => {
    const into = pasted?.into ?? new Set([filePath]);
    if (into.has(target)) return;
    const read = readRustDependencies(
      filePath, workspace.read(absolute), workspace, layout, { into: new Set([...into, target]), scope },
    );
    if (!read) { complete = false; return; }
    if (!read.complete) complete = false;
    for (const reason of read.dynamic) dynamic.add(reason);
    for (const dependency of read.dependencies) {
      if (dependency.unplaced) { dynamic.add("macro-expansion"); continue; }
      dependencies.push({ ...dependency, line: lineOf(source, at) });
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
            /*
             * Which of these paths is a glob. `expandUse` flattens
             * `use crate::io::*` to the path and drops the star, which is the
             * right answer for "what does this file depend on" and the wrong
             * one for following a name through a module that re-exports
             * everything (#323). `aliasedUses` reads the same subtree and
             * keeps the flag, so the two are matched by their written path.
             */
            const globs = new Set(
              aliasedUses(inner, []).filter((use) => use.glob).map((use) => use.segments.join("::")),
            );
            for (const segments of expandUse(inner, [])) {
              takePath(child, segments, true, position, globs.has(segments.join("::")));
            }
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
              const found = absolute !== undefined && workspace.stat(absolute) === "file";
              record(child, `include!("${relative}")`, found ? target : undefined);
              if (found) paste(child, target, absolute);
              pathAttribute = undefined;
              continue;
            }
          }
          /*
           * Everything inside a macro is a token tree, so a `use` in there is
           * not a `use`. At item level that can hide a whole dependency, which
           * is the one thing a refutation may not be built on top of -- unless
           * the macro is one whose expansion is already read (#366).
           */
          const called = name?.type === "identifier" ? name.text : undefined;
          if (itemLevel && !(called && expandsToNoImport(called))) dynamic.add("macro-expansion");
          /*
           * `crate::cents!(1)`, `core_lib::cents!(3)`: a macro reached by a path
           * (#383). The macro lives wherever its `macro_rules!` is -- a
           * `#[macro_export]` one at the crate root's path, in whatever file
           * declares it -- and the path does not say which file that is. When
           * the path starts in this workspace the landing is marked, for the
           * compiler to be asked; a macro from outside is a library's.
           */
          const path = name && (name.type === "scoped_identifier") ? segmentsOf(name) : undefined;
          if (name && path && path.length > 1) {
            const inTree = ["crate", "self", "super", "$crate"].includes(path[0]!)
              || resolveRustPath(path.slice(0, -1), filePath, layout, workspace, false, position).length > 0;
            if (inTree) unplaced(name, `${path.join("::")}!`, 1);
          }
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
          /*
           * Which file a `$crate::util::double` in a body lands on is decided
           * where the macro is expanded, not here: the text of the body is a
           * template (#383). Marked, never placed.
           */
          each(child, (token) => {
            if (token.type === "metavariable" && token.text === "$crate") unplaced(token, token.text, 0);
          });
          pathAttribute = undefined;
          continue;
        }
        default: {
          if (!PUNCTUATION.has(child.type)) pathAttribute = undefined;
          /*
           * An `impl` or `trait` body holds associated items, and none of those
           * is a `use`, a `mod` or an `extern crate`: a macro there is on the
           * footing of one in a function body, which never blinded (#366).
           */
          const inside = child.type === "block" || child.type === "field_declaration_list"
            || child.type === "impl_item" || child.type === "trait_item";
          walk(child, position, itemLevel && !inside);
        }
      }
    }
  };

  walk(tree.rootNode, { directory: own, inline: 0, scope }, true);

  /*
   * `use core_lib::cents;` and then `cents!(3)` (#383). The `use` resolves to
   * the crate root, and a `#[macro_export]` macro is only *named* there: it
   * lives in whatever file declares it. A `use` of a name this file calls as
   * a macro is marked, for the compiler to say where it goes.
   */
  const macros = new Set<string>();
  each(tree.rootNode, (node) => {
    if (node.type !== "macro_invocation") return;
    const called = children(node)[0];
    if (called?.type === "identifier") macros.add(called.text);
  });
  if (macros.size > 0) {
    each(tree.rootNode, (node) => {
      if (node.type !== "use_declaration") return;
      each(node, (part) => {
        const tail = part.type === "scoped_identifier" ? part.childForFieldName("name") : part.type === "identifier" ? part : null;
        if (!tail || !macros.has(tail.text)) return;
        if (part.type === "identifier" && part.text !== tail.text) return;
        unplaced(part, part.text, 0);
      });
    });
  }

  return {
    dependencies,
    complete,
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
