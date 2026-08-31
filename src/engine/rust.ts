/**
 * Where a Rust path points, and which file that is.
 *
 * A TypeScript specifier is a path with the answer half written in it:
 * `"./layout"` names a neighbour, and resolving it is mostly a matter of trying
 * extensions. A Rust path names a position in a *module tree* -- `crate::ptr::Own`
 * -- and the tree is not written down anywhere. It is built out of the `mod`
 * declarations scattered across the crate, and only then does a path have
 * somewhere to land.
 *
 * That is the whole reason this file exists next to `resolve.ts` rather than
 * inside it. The two languages disagree about what a dependency *is*, not just
 * about how to spell one, and pretending otherwise is how a reader starts
 * inventing edges.
 *
 * The tree happens to be recoverable from the filesystem without reading every
 * `mod` in the crate, because Rust fixes where a module's file may sit: the
 * child `x` of the module living in `<dir>` is `<dir>/x.rs` or `<dir>/x/mod.rs`,
 * and nothing else. So a path is walked segment by segment against directories,
 * and it stops at the first segment that is not a directory entry -- which is
 * exactly where the modules end and the items begin. `crate::ptr::Own` stops at
 * `ptr` because there is no `src/ptr/Own.rs`, and that is the right answer for
 * the right reason rather than by luck.
 *
 * Two things this deliberately does not do:
 *
 * - **Follow re-exports.** `use crate::a::B` where `a` says `pub use crate::c::B`
 *   names `a`, and that is what is reported. Chasing `B` to `c` would be a second
 *   name resolver, and a wrong one is a false accusation.
 * - **Guess at `#[cfg]`.** A module behind a feature flag is still a module, and
 *   a file is a file whichever way the flag falls.
 */
import { each, parseSource, type Node } from "./parse";
import type { Workspace } from "./workspace";

/** One compilation unit: a crate root, and where its children live. */
export interface RustCrate {
  /**
   * The name a path can spell, for library targets only.
   *
   * Cargo turns `-` into `_` for the crate name, so `serde-json` is reached as
   * `serde_json`; a reader that skipped that step would miss every dependency
   * between two workspace members with a hyphen in the name. Binaries and test
   * targets have no name here because no path can name them.
   */
  name?: string;
  /** Repo-relative crate root file. */
  root: string;
  /** Where the root module's children live: the root's own directory. */
  directory: string;
  /**
   * 2015 or 2018+. It changes what a bare first segment means -- in 2015 `use
   * foo::Bar` is relative to the crate root, from 2018 it is another crate --
   * so it is read from the manifest rather than assumed.
   */
  edition: number;
}

export interface RustLayout {
  kind: "rust-layout";
  /** Library crates by the name a path spells, including workspace members. */
  byName: Map<string, RustCrate>;
  /** Every crate root in the repository. */
  roots: RustCrate[];
  /**
   * Directories a crate pulled in from outside its own, via `#[path]`.
   *
   * serde_json's `tests/lexical.rs` says `#[path = "../src/lexical/mod.rs"] mod
   * lexical;`, so every file under `src/lexical` is compiled into the library
   * *and* into that test -- and `crate::` inside them means a different file in
   * each. Neither answer is the right one, so both are given.
   */
  adopted: Array<{ directory: string; crate: RustCrate }>;
  /**
   * Children a file declared with `#[path]`, which override where a name lives.
   *
   * Consulted before the directory, because the whole point of the attribute is
   * that the directory is wrong. serde_json's test crate has a `mod lexical`
   * pointing at `../src/lexical/mod.rs` while a file called `lexical.rs` sits
   * right beside it -- read by directory, every path in that crate lands on the
   * wrong one of the two.
   */
  redirects: Map<string, Map<string, RustTarget>>;
  /**
   * Re-export tables, read on demand and kept for the rest of the run.
   *
   * Filled lazily because most paths never need one: a table is only read when a
   * segment has no file of its own, which is the point where a module either
   * came from a `pub use` or does not exist.
   */
  reexports: Map<string, Reexports>;
}

/** What one module makes reachable that it did not declare itself. */
export interface Reexports {
  /** `pub use grep_printer as printer;` -- the name, and the module it stands for. */
  names: Map<string, RustTarget>;
  /** `pub use foo::*;` -- modules whose own names this one also answers to. */
  globs: RustTarget[];
}

/** Where a path segment landed, and where its own children would live. */
export interface RustTarget {
  /** Repo-relative file, always inside the repository. */
  file: string;
  /** The directory this module's children sit in. */
  directory: string;
}

const SKIP_DIRECTORIES = new Set([
  "target", "node_modules", ".git", ".corpus", "vendor", "dist", "build",
]);

/** `a/b/c.rs` -> `a/b`. Empty for a path with no directory in it. */
function parentOf(filePath: string): string {
  const cut = filePath.lastIndexOf("/");
  return cut < 0 ? "" : filePath.slice(0, cut);
}

function join(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function exists(relative: string, workspace: Workspace): boolean {
  const absolute = workspace.resolve(relative);
  return absolute !== undefined && workspace.stat(absolute) === "file";
}

/**
 * A file that exists *and is spelled the way the path asked for it*.
 *
 * `stat` is case-insensitive on macOS and on Windows, and a module name here is
 * built out of a segment of somebody's `use` line. So `use crate::Request;`
 * where the type `Request` lives in `src/request.rs` finds a file: the module
 * walk accepts `src/Request.rs`, reports an edge to a module that does not
 * exist, and prints a path that no case-sensitive machine will ever have (#166).
 *
 * Wrong in both directions at once, which is why it is worth a listing. The
 * edge is invented -- modules and types are separate namespaces, and `Request`
 * is a type -- and the invention is invisible to the person who wrote the line,
 * because their file really is there under a different capital.
 *
 * An unreadable directory lists as empty, and there the `stat` answer stands.
 * Refusing on a listing that could not be read would trade an invented edge for
 * a missed one, and `licence.ts` is clear that both end in a false accusation.
 */
function existsExactly(relative: string, workspace: Workspace): boolean {
  if (!exists(relative, workspace)) return false;
  const slash = relative.lastIndexOf("/");
  const directory = slash < 0 ? "." : relative.slice(0, slash);
  const absolute = workspace.resolve(directory);
  if (!absolute) return false;
  const entries = workspace.list(absolute);
  return entries.length === 0 || entries.includes(relative.slice(slash + 1));
}

/**
 * The `[package]` fields a path needs, out of Cargo's manifest.
 *
 * Read by hand rather than with a TOML parser, and narrowly: three keys, from
 * one table each. Bringing in a parser to answer "what is this package called"
 * buys correctness on syntax nothing here is allowed to depend on -- if a
 * manifest is exotic enough to defeat this, the crate simply has no name, and a
 * crate with no name is silence rather than a wrong answer.
 */
function readManifest(text: string): {
  name?: string;
  edition?: number;
  inheritsEdition: boolean;
  workspaceEdition?: number;
  libName?: string;
  libPath?: string;
  /**
   * Roots named by `[[bin]]`, `[[test]]`, `[[example]]` and `[[bench]]`.
   *
   * Not a detail: ripgrep puts its binary at `crates/core/main.rs`, nowhere near
   * a `src/`, so without these every `crate::` path in the whole binary resolves
   * to nothing. Ninety-five of the first hundred disagreements on that repository
   * were this one line of manifest.
   */
  targetPaths: string[];
  /**
   * `autotests = false` and friends, which turn auto-discovery off.
   *
   * With them on, every `tests/*.rs` is its own crate; with them off, only the
   * declared `[[test]]` is, and the rest are ordinary modules of it. ripgrep
   * does the second, so reading them as crates put `crate::` in six files into
   * a tree that does not exist.
   */
  auto: Map<string, boolean>;
} {
  let table = "";
  const out: ReturnType<typeof readManifest> = { inheritsEdition: false, targetPaths: [], auto: new Map() };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      // `[[bin]]` and `[bin]` both reduce to `bin`; the doubled bracket only
      // says the table may repeat, which the caller handles by collecting.
      table = line.replace(/^\[+|\]+.*$/g, "");
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    const text_ = /^"([^"]*)"/.exec(value!)?.[1];
    if (table === "package") {
      if (key === "name" && text_) out.name = text_;
      if (key === "edition" && text_) out.edition = Number(text_);
      // `edition.workspace = true` inherits from the workspace root, which is
      // one manifest up and read separately.
      if (key === "edition.workspace") out.inheritsEdition = true;
      if (/^auto(bins|tests|examples|benches)$/.test(key!)) {
        out.auto.set(key!.slice(4), value!.trim().startsWith("true"));
      }
    } else if (table === "workspace.package") {
      if (key === "edition" && text_) out.workspaceEdition = Number(text_);
    } else if (table === "lib") {
      if (key === "name" && text_) out.libName = text_;
      if (key === "path" && text_) out.libPath = text_;
    } else if (["bin", "test", "example", "bench"].includes(table)) {
      if (key === "path" && text_) out.targetPaths.push(text_);
    }
  }
  return out;
}

/** Cargo's own spelling rule: the crate name is the package name with `_` for `-`. */
function crateName(packageName: string): string {
  return packageName.replace(/-/g, "_");
}

/**
 * Every crate root in the repository, found by walking to the manifests.
 *
 * Expensive once and cached by the caller, because it is a fact about the whole
 * tree rather than about one file: a path in `src/a.rs` can name a sibling
 * package in the same workspace, so nothing local is enough to resolve it.
 */
export function readRustLayout(workspace: Workspace): RustLayout {
  const manifests: Array<{ directory: string; parsed: ReturnType<typeof readManifest> }> = [];

  const walk = (directory: string): void => {
    const absolute = workspace.resolve(directory || ".");
    if (!absolute || workspace.stat(absolute) !== "directory") return;
    for (const entry of workspace.list(absolute)) {
      if (SKIP_DIRECTORIES.has(entry)) continue;
      if (entry.startsWith(".") && entry !== ".") continue;
      const child = join(directory, entry);
      const childAbsolute = workspace.resolve(child);
      if (!childAbsolute) continue;
      const kind = workspace.stat(childAbsolute);
      if (kind === "directory") walk(child);
      else if (entry === "Cargo.toml") {
        try {
          manifests.push({ directory, parsed: readManifest(workspace.read(childAbsolute)) });
        } catch {
          // An unreadable manifest is a package we cannot name, not a failed run.
        }
      }
    }
  };
  walk("");

  /** A workspace root's `[workspace.package] edition`, for members that inherit. */
  const inheritedFor = (directory: string): number | undefined => {
    let best: number | undefined;
    let bestLength = -1;
    for (const manifest of manifests) {
      if (manifest.parsed.workspaceEdition === undefined) continue;
      const root = manifest.directory;
      const covers = root === "" || directory === root || directory.startsWith(`${root}/`);
      if (covers && root.length > bestLength) {
        best = manifest.parsed.workspaceEdition;
        bestLength = root.length;
      }
    }
    return best;
  };

  const roots: RustCrate[] = [];
  const byName = new Map<string, RustCrate>();

  for (const { directory, parsed } of manifests) {
    /*
     * 2015 is Cargo's default when the manifest says nothing, and it is the
     * edition where a bare first segment means something different. Guessing
     * 2021 here would be the flattering guess: it silently drops the paths a
     * 2015 crate resolves against its own root.
     */
    const edition = parsed.edition
      ?? (parsed.inheritsEdition ? inheritedFor(directory) : undefined)
      ?? 2015;

    const add = (file: string, name?: string): void => {
      if (!exists(file, workspace)) return;
      /*
       * A target can be both declared and auto-discovered -- regex-automata
       * names `tests/lib.rs` in `[[test]]` and Cargo would have found it anyway.
       * Listed twice it looks like two crates sharing a directory, which reads
       * as ambiguous, and every `crate::` in that whole test tree resolves to
       * nothing.
       */
      if (roots.some((crate) => crate.root === file)) return;
      const crate: RustCrate = { ...(name ? { name } : {}), root: file, directory: parentOf(file), edition };
      roots.push(crate);
      if (name && !byName.has(name)) byName.set(name, crate);
    };

    const library = parsed.libPath
      ? join(directory, parsed.libPath)
      : join(directory, "src/lib.rs");
    const name = parsed.libName ?? (parsed.name ? crateName(parsed.name) : undefined);
    add(library, name ? crateName(name) : undefined);

    const auto = (kind: string): boolean => parsed.auto.get(kind) !== false;
    if (auto("bins")) add(join(directory, "src/main.rs"));
    add(join(directory, "build.rs"));
    for (const target of parsed.targetPaths) add(join(directory, target));

    /*
     * Integration tests, examples, benches and extra binaries are each their own
     * crate, and each top-level file in those directories is a root. They matter
     * because `crate::` inside one of them means that file, not the library --
     * reading them as ordinary modules of the library would resolve every such
     * path into the wrong tree.
     */
    for (const [kind, folder_] of [["bins", "src/bin"], ["tests", "tests"], ["examples", "examples"], ["benches", "benches"]]) {
      if (!auto(kind!)) continue;
      const folder = join(directory, folder_!);
      const absolute = workspace.resolve(folder);
      if (!absolute || workspace.stat(absolute) !== "directory") continue;
      for (const entry of workspace.list(absolute)) {
        if (entry.endsWith(".rs")) add(join(folder, entry));
        else add(join(join(folder, entry), "main.rs"));
      }
    }
  }

  const adopted: RustLayout["adopted"] = [];
  const redirects = new Map<string, Map<string, RustTarget>>();
  const layout: RustLayout = { kind: "rust-layout", byName, roots, adopted, redirects, reexports: new Map() };
  for (const crate of roots) {
    const found = pathRedirections(crate, workspace);
    if (found.length === 0) continue;
    const table = new Map<string, RustTarget>();
    redirects.set(crate.root, table);
    for (const { name, file } of found) {
      table.set(name, { file, directory: file.endsWith("/mod.rs") ? parentOf(file) : file.replace(/\.rs$/, "") });
      adopted.push({ directory: file, crate });
      adopted.push({ directory: file.endsWith("/mod.rs") ? parentOf(file) : file.replace(/\.rs$/, ""), crate });
    }
  }
  return layout;
}

/**
 * Directories a crate root reaches into with `#[path]`.
 *
 * Only the roots are read, not every file: a redirection written deeper is rare,
 * and reading the whole tree to find one would mean parsing every file in the
 * repository before answering a single question. What this does not catch shows
 * up in the licence as a disagreement, which is the point of having one.
 */
function pathRedirections(crate: RustCrate, workspace: Workspace): Array<{ name: string; file: string }> {
  const absolute = workspace.resolve(crate.root);
  if (!absolute || workspace.stat(absolute) !== "file") return [];
  let source: string;
  try {
    source = workspace.read(absolute);
  } catch {
    return [];
  }
  if (!source.includes("#[path")) return [];
  const tree = parseSource(source, "rust");
  if (!tree) return [];

  const found: Array<{ name: string; file: string }> = [];
  let attribute: string | undefined;
  for (const child of children(tree.rootNode)) {
    if (child.type === "attribute_item") {
      attribute = /\bpath\s*=\s*"([^"]*)"/.exec(child.text)?.[1];
      continue;
    }
    const name = child.childForFieldName("name");
    if (child.type === "mod_item" && attribute && name && !child.childForFieldName("body")) {
      found.push({ name: plainName(name.text), file: normalize(join(crate.directory, attribute)) });
    }
    attribute = undefined;
  }
  return found;
}

/** `a/b/../c` -> `a/c`, so a `#[path]` reaching upwards names a real place. */
function normalize(value: string): string {
  const out: string[] = [];
  for (const part of value.split("/")) {
    if (part === "." || part === "") continue;
    if (part === ".." ) out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** True when this file is a crate root rather than a module inside one. */
function isRoot(file: string, layout: RustLayout): boolean {
  return layout.roots.some((crate) => crate.root === file);
}

/**
 * Where a file's own child modules live.
 *
 * `mod.rs` and a crate root own the directory they sit in; every other file owns
 * the directory named after it. Getting this backwards puts a whole subtree one
 * level out, which resolves to nothing rather than to the wrong file -- silent,
 * and the reason it is stated here rather than inlined.
 */
export function moduleDirectory(file: string, layout: RustLayout): string {
  if (isRoot(file, layout) || file.endsWith("/mod.rs") || file === "mod.rs") return parentOf(file);
  return file.replace(/\.rs$/, "");
}

/** The child module named `segment` under `directory`, if it has a file. */
export function childModule(directory: string, segment: string, workspace: Workspace): RustTarget | undefined {
  const flat = join(directory, `${segment}.rs`);
  if (existsExactly(flat, workspace)) return { file: flat, directory: join(directory, segment) };
  const folded = join(join(directory, segment), "mod.rs");
  if (existsExactly(folded, workspace)) return { file: folded, directory: join(directory, segment) };
  return undefined;
}

/**
 * The crate a file belongs to, or nothing when more than one could claim it.
 *
 * `tests/helpers/mod.rs` is compiled into whichever integration tests declare
 * `mod helpers;`, which can be several crates at once, so `crate::` inside it
 * has no single answer. Returning nothing there costs the `crate::` paths in a
 * handful of shared test helpers and buys never resolving one into a crate it
 * was not part of.
 */
/**
 * Every crate a file is compiled into, which is usually one and sometimes two.
 *
 * `crate::` has an answer per crate, and when there are two of them both are
 * true -- in different builds. Giving one and calling it the answer would make
 * the other build's dependencies look like they were not there.
 */
export function cratesOf(file: string, layout: RustLayout): RustCrate[] {
  const found: RustCrate[] = [];
  const own = crateOf(file, layout);
  if (own) found.push(own);
  for (const { directory, crate } of layout.adopted) {
    if (file !== directory && !file.startsWith(`${directory}/`)) continue;
    if (!found.includes(crate)) found.push(crate);
  }
  return found;
}

export function crateOf(file: string, layout: RustLayout): RustCrate | undefined {
  const itself = layout.roots.find((crate) => crate.root === file);
  if (itself) return itself;

  const containing = layout.roots.filter((crate) =>
    crate.directory === "" ? true : file.startsWith(`${crate.directory}/`),
  );
  if (containing.length === 0) return undefined;

  const deepest = Math.max(...containing.map((crate) => crate.directory.length));
  const closest = containing.filter((crate) => crate.directory.length === deepest);
  if (closest.length === 1) return closest[0];
  // A package with both a library and a binary puts two roots over `src/`. The
  // library is the one other code can name, and the one a module belongs to.
  const named = closest.filter((crate) => crate.name);
  return named.length === 1 ? named[0] : undefined;
}

/** The module one level up, which `super` names. */
function parentModule(file: string, layout: RustLayout, workspace: Workspace): RustTarget | undefined {
  const own = moduleDirectory(file, layout);
  if (!own) return undefined;
  const up = parentOf(own);
  const root = layout.roots.find((crate) => crate.directory === up && crate.root !== file);
  if (root) return { file: root.root, directory: up };
  for (const candidate of [`${up}/mod.rs`, `${up}.rs`]) {
    if (candidate !== file && exists(candidate, workspace)) return { file: candidate, directory: up };
  }
  return undefined;
}

/** The named children of a node, skipping punctuation. */
export function children(node: Node): Node[] {
  const out: Node[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child) out.push(child);
  }
  return out;
}

export const PUNCTUATION = new Set(["::", "{", "}", ",", ";", "*", "use", "as", "extern", "#", "[", "]", "!"]);

/**
 * `r#match` -> `match`. The escape is spelling, not name: the module is called
 * `match` and its file is `match.rs`, and the `r#` is only there because the
 * plain word is a keyword.
 */
function plainName(text: string): string {
  return text.replace(/^r#/, "");
}

/**
 * A path node, flattened into the segments it spells.
 *
 * An absent `path` field on a `scoped_identifier` is how tree-sitter writes a
 * leading `::`, so it becomes an empty first segment rather than being lost --
 * `::serde::x` and `serde::x` mean the same thing here and have to arrive at
 * the resolver looking the same.
 */
export function segmentsOf(node: Node): string[] | undefined {
  switch (node.type) {
    case "scoped_identifier":
    case "scoped_type_identifier": {
      const name = node.childForFieldName("name");
      if (!name) return undefined;
      const path = node.childForFieldName("path");
      const head = path ? segmentsOf(path) : [""];
      return head ? [...head, plainName(name.text)] : undefined;
    }
    case "generic_type": {
      const inner = node.childForFieldName("type");
      return inner ? segmentsOf(inner) : undefined;
    }
    case "identifier":
    case "type_identifier":
    case "crate":
    case "self":
    case "super":
      return [plainName(node.text)];
    default:
      return undefined;
  }
}

/** The paths one `use` declaration names, with brace lists written out in full. */
export function expandUse(node: Node, prefix: string[]): string[][] {
  switch (node.type) {
    case "scoped_use_list":
    case "use_list": {
      let base = prefix;
      const items: Node[] = [];
      for (const child of children(node)) {
        if (PUNCTUATION.has(child.type)) continue;
        if (child.type === "use_list") {
          items.push(...children(child).filter((entry) => !PUNCTUATION.has(entry.type)));
        } else if (node.type === "use_list") {
          items.push(child);
        } else {
          // The one non-list child of a `scoped_use_list` is its prefix.
          const segments = segmentsOf(child);
          if (segments) base = [...prefix, ...segments];
        }
      }
      return items.flatMap((item) => expandUse(item, base));
    }
    case "use_as_clause": {
      const path = node.childForFieldName("path") ?? children(node)[0];
      return path ? expandUse(path, prefix) : [];
    }
    case "use_wildcard": {
      const path = children(node).find((child) => !PUNCTUATION.has(child.type));
      return path ? expandUse(path, prefix) : [];
    }
    default: {
      const segments = segmentsOf(node);
      return segments ? [[...prefix, ...segments]] : [];
    }
  }
}


/**
 * Every module file a path names, in the order the path names them.
 *
 * All of them, not just the last: `use crate::ptr::Own` names the crate root and
 * `ptr`, and both are files this one now depends on. Reporting only the deepest
 * would lose `use crate::Error`, where the crate root is the whole answer.
 *
 * `declaration` is true for a `use` or `extern crate`, where a bare first
 * segment is another crate by the language's own rule. Anywhere else a bare
 * first segment is a name already in scope -- almost always brought in by a
 * `use` that has been read separately -- so it is left alone rather than
 * guessed at.
 */
export function resolveRustPath(
  segments: string[],
  fromFile: string,
  layout: RustLayout,
  workspace: Workspace,
  declaration: boolean,
  position?: RustPosition,
): RustTarget[] {
  const anchors = segments[0] === "crate" ? cratesOf(fromFile, layout) : [undefined];
  const out: RustTarget[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors) {
    for (const target of walkPath(segments, fromFile, layout, workspace, declaration, REEXPORT_HOPS, position, anchor).targets) {
      if (seen.has(target.file)) continue;
      seen.add(target.file);
      out.push(target);
    }
  }
  return out;
}

/**
 * Which module a path is written in, which is not the same as which file.
 *
 * `#[cfg(test)] mod tests { use super::escape; }` sits two modules deep in one
 * file, and its `super` is that same file rather than the one above it. Read
 * from the file alone, every test module in every crate declares a dependency
 * on its parent that does not exist -- eleven of ripgrep's thirteen false edges
 * were this, and the shape is in almost every Rust file ever written.
 */
export interface RustPosition {
  /** Where a `mod x;` written here would put its file. */
  directory: string;
  /** How many inline `mod { .. }` blocks enclose it. */
  inline: number;
  /**
   * Modules this file has already given a short name to.
   *
   * `use crate::args;` and then `args::syntax::Config` a hundred lines later is
   * the ordinary way to write Rust, and the second line names a file as surely
   * as the first does. Without the binding a bare first segment is unresolvable
   * -- it is not a crate and not a keyword -- and a hundred and ten of regex's
   * dependency edges were exactly that shape.
   */
  scope?: Map<string, RustTarget>;
}

/**
 * How far a name may be chased through `pub use` before the answer stops being
 * worth having.
 *
 * Re-export hubs are usually one deep -- `grep` standing in front of
 * `grep_printer` -- and occasionally two. A limit exists because the chain can
 * be circular, and because a wrong answer found six hops from the text is a
 * false accusation nobody could check by reading.
 */
const REEXPORT_HOPS = 4;

interface Walked {
  targets: RustTarget[];
  /** True when every segment named a module, so the path is a module path throughout. */
  complete: boolean;
}

export function walkPath(
  segments: string[],
  fromFile: string,
  layout: RustLayout,
  workspace: Workspace,
  declaration: boolean,
  hops: number,
  position?: RustPosition,
  anchor?: RustCrate,
): Walked {
  if (segments.length === 0) return { targets: [], complete: false };
  const found: RustTarget[] = [];

  let rest = segments;
  let here: RustTarget | undefined;

  /*
   * A path that opens with `::` is absolute -- another crate from 2018, the
   * crate root in 2015 -- and tree-sitter spells that as an empty first
   * segment. Dropping it turns the path into the bare-name case below, which
   * is the same rule.
   */
  if (rest[0] === "") rest = rest.slice(1);
  if (rest.length === 0) return { targets: [], complete: false };

  const crate = anchor ?? crateOf(fromFile, layout);
  const head = rest[0]!;

  if (head === "crate") {
    if (!crate) return { targets: [], complete: false };
    here = { file: crate.root, directory: crate.directory };
    rest = rest.slice(1);
  } else if (head === "self") {
    here = { file: fromFile, directory: position?.directory ?? moduleDirectory(fromFile, layout) };
    rest = rest.slice(1);
  } else if (head === "super") {
    let at = fromFile;
    let directory = position?.directory ?? moduleDirectory(fromFile, layout);
    let inline = position?.inline ?? 0;
    while (rest[0] === "super") {
      if (inline > 0) {
        // Still inside the same file: an inline module's parent is whatever
        // encloses it, and that has no file of its own to name.
        inline -= 1;
        directory = parentOf(directory);
        here = { file: at, directory };
      } else {
        const up = parentModule(at, layout, workspace);
        if (!up) return { targets: found, complete: false };
        here = up;
        at = up.file;
        directory = up.directory;
      }
      rest = rest.slice(1);
    }
  } else {
    /*
     * A `use` path starts at a crate, by the language's rule, and a path
     * anywhere else starts with a name in scope. Reading a `use` against the
     * file's own bindings inverts that: `use regex::bytes` in a test of the
     * `regex` crate resolved against the `regex` *module* the file had just
     * bound, and landed two directories away from the crate it names.
     */
    const bound = declaration ? undefined : position?.scope?.get(head);
    const named = bound ?? layout.byName.get(head);
    const local = position?.directory ?? moduleDirectory(fromFile, layout);
    if (named) {
      here = "root" in named
        ? { file: named.root, directory: named.directory }
        : { file: named.file, directory: named.directory };
      rest = rest.slice(1);
    } else if (declaration && childModule(local, head, workspace)) {
      /*
       * Uniform paths: from edition 2018 a `use` may also start at an item of
       * the module it is written in, so `pub use generator::*;` beside `mod
       * generator;` is ordinary modern Rust rather than a leftover. Tried after
       * the crate names, which is the order the language resolves them in.
       */
      here = { file: fromFile, directory: local };
    } else if (declaration && crate && crate.edition < 2018) {
      // Edition 2015: a bare first segment in a `use` is relative to the crate
      // root, so the root is where the walk starts and the segment is a child.
      here = { file: crate.root, directory: crate.directory };
    } else {
      return { targets: [], complete: false };
    }
  }

  if (!here) return { targets: found, complete: false };
  found.push(here);
  let at: RustTarget = here;

  for (const segment of rest) {
    const child: RustTarget | undefined = layout.redirects.get(at.file)?.get(segment)
      ?? childModule(at.directory, segment, workspace)
      ?? reexported(at.file, segment, layout, workspace, hops);
    // The first segment with no file of its own is where the modules stop and
    // the items begin. Everything after it lives inside a file already found.
    if (!child) return { targets: found, complete: false };
    found.push(child);
    at = child;
  }

  return { targets: found, complete: true };
}

/**
 * The module a name stands for when the module did not declare it.
 *
 * `crates/grep/src/lib.rs` says `pub use grep_printer as printer;`, so
 * `grep::printer::Standard` names a file two packages away and no directory
 * under `crates/grep` has anything to do with it. Thirty of ripgrep's own
 * dependency edges are exactly that shape, and a reader that stopped at the
 * directory would call those files unrelated -- which is what turns into a
 * backwards verdict against a diagram that was right.
 *
 * Only `pub` re-exports count, because a private one is not reachable from
 * another file, and only ones that resolve to a module all the way down: a
 * re-exported *item* lives inside a file already accounted for.
 */
function reexported(
  file: string,
  segment: string,
  layout: RustLayout,
  workspace: Workspace,
  hops: number,
): RustTarget | undefined {
  if (hops <= 0) return undefined;
  const table = reexportsOf(file, layout, workspace, hops);
  const direct = table.names.get(segment);
  if (direct) return direct;
  for (const glob of table.globs) {
    const child = childModule(glob.directory, segment, workspace)
      ?? reexported(glob.file, segment, layout, workspace, hops - 1);
    if (child) return child;
  }
  return undefined;
}

function reexportsOf(
  file: string,
  layout: RustLayout,
  workspace: Workspace,
  hops: number,
): Reexports {
  const cached = layout.reexports.get(file);
  if (cached) return cached;
  const table: Reexports = { names: new Map(), globs: [] };
  // Recorded before it is filled: a pair of modules re-exporting each other is
  // legal, and without this the walk would follow them until the stack gave out.
  layout.reexports.set(file, table);

  const absolute = workspace.resolve(file);
  if (!absolute || workspace.stat(absolute) !== "file") return table;
  let source: string;
  try {
    source = workspace.read(absolute);
  } catch {
    return table;
  }
  const tree = parseSource(source, "rust");
  if (!tree) return table;

  each(tree.rootNode, (node) => {
    if (node.type === "mod_item" && node.childForFieldName("body")) {
      /*
       * An inline `pub mod sinks { .. }` is a child module with no file of its
       * own, so a path reaching it lands on the file it is written in.
       * `grep_searcher::sinks::UTF8` is exactly that, two re-exports away, and
       * without this it resolved to nothing at all.
       */
      const name = node.childForFieldName("name");
      const visible = children(node).some((part) => part.type === "visibility_modifier");
      if (name && visible && !table.names.has(name.text)) {
        table.names.set(name.text, { file, directory: `${moduleDirectory(file, layout)}/${name.text}` });
      }
      return;
    }
    if (node.type === "extern_crate_declaration") {
      /*
       * `pub extern crate grep_printer as printer;` is a re-export that never
       * says `use`. ripgrep's facade crate is built entirely out of this form,
       * and reading only `use` left thirty of its edges looking like nothing at
       * all.
       */
      const parts = children(node);
      if (!parts.some((part) => part.type === "visibility_modifier")) return;
      const name = node.childForFieldName("name");
      const alias = node.childForFieldName("alias");
      const crate = name ? layout.byName.get(name.text) : undefined;
      if (crate && alias && !table.names.has(alias.text)) {
        table.names.set(alias.text, { file: crate.root, directory: crate.directory });
      }
      return;
    }
    if (node.type !== "use_declaration") return;
    const parts = children(node);
    if (!parts.some((part) => part.type === "visibility_modifier")) return;
    for (const inner of parts) {
      if (PUNCTUATION.has(inner.type) || inner.type === "visibility_modifier") continue;
      for (const use of aliasedUses(inner, [])) {
        const walked = walkPath(use.segments, file, layout, workspace, true, hops - 1);
        const last = walked.targets[walked.targets.length - 1];
        if (!last) continue;
        if (use.glob) {
          table.globs.push(last);
        } else if (walked.complete && !table.names.has(use.alias)) {
          table.names.set(use.alias, last);
        }
      }
    }
  });
  return table;
}

/** `use` paths with the name each one binds, which `expandUse` discards. */
export function aliasedUses(node: Node, prefix: string[]): Array<{ segments: string[]; alias: string; glob: boolean }> {
  switch (node.type) {
    case "scoped_use_list":
    case "use_list": {
      let base = prefix;
      const items: Node[] = [];
      for (const child of children(node)) {
        if (PUNCTUATION.has(child.type)) continue;
        if (child.type === "use_list") {
          items.push(...children(child).filter((entry) => !PUNCTUATION.has(entry.type)));
        } else if (node.type === "use_list") {
          items.push(child);
        } else {
          const segments = segmentsOf(child);
          if (segments) base = [...prefix, ...segments];
        }
      }
      return items.flatMap((item) => aliasedUses(item, base));
    }
    case "use_as_clause": {
      const path = node.childForFieldName("path") ?? children(node)[0];
      const alias = node.childForFieldName("alias")
        ?? children(node).findLast((child) => child.type === "identifier" || child.type === "type_identifier");
      const segments = path ? segmentsOf(path) : undefined;
      if (!segments || !alias) return [];
      return [{ segments: [...prefix, ...segments], alias: alias.text, glob: false }];
    }
    case "use_wildcard": {
      const path = children(node).find((child) => !PUNCTUATION.has(child.type));
      const segments = path ? segmentsOf(path) : undefined;
      return segments ? [{ segments: [...prefix, ...segments], alias: "*", glob: true }] : [];
    }
    default: {
      const segments = segmentsOf(node);
      if (!segments) return [];
      /*
       * `use crate::args::{self, Usage}` binds `args` to the prefix, not to a
       * child called `self`. Written this way in every second Rust file, and
       * without it the short name that the rest of the file then uses is bound
       * to nothing.
       */
      if (segments.length === 1 && segments[0] === "self" && prefix.length > 0) {
        return [{ segments: prefix, alias: prefix[prefix.length - 1]!, glob: false }];
      }
      const alias = segments[segments.length - 1]!;
      return [{ segments: [...prefix, ...segments], alias, glob: false }];
    }
  }
}

/** The directory a `#[path = "..."]` on a `mod` is measured from. */
export function pathAttributeBase(file: string, layout: RustLayout, inlineDepth: string[]): string {
  const own = moduleDirectory(file, layout);
  return inlineDepth.length === 0 ? own : join(own, inlineDepth.join("/"));
}
