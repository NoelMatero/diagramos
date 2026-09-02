/**
 * What one Python file depends on.
 *
 * Returned in the same shape as `deps.ts` and `deps-rust.ts`, because a caller
 * wants the same three answers whatever the language: what is declared, whether
 * the file was read end to end, and whether it reaches out at runtime. Almost
 * nothing else is shared, and the reason is the same one that put Rust in its
 * own file: a TypeScript dependency is a string literal that resolves against
 * the filesystem, and a Python one is a position in a module tree that no
 * single file contains.
 *
 * ## What counts as an edge, and why the answer is not "the module named"
 *
 * `import a.b.c` binds the name `a`, which means Python executes `a`, `a.b` and
 * `a.b.c` -- three files, from one line. `import a.b.c as abc` binds only
 * `abc`, and the parents are loaded but never named, so pyright reports the
 * leaf alone. `from a.b import sub` names the package and, when `sub` is itself
 * a module, that too.
 *
 * That is not a quirk of the referee; it is the language's binding rule, and
 * both sides have to mean the same thing by an edge or the measurement is
 * theatre. So the table below is implemented deliberately rather than fallen
 * into, and it is the one place the reader and pyright are reconciled:
 *
 * | written | edges |
 * |---|---|
 * | `import a.b.c` | `a`, `a.b`, `a.b.c` |
 * | `import a.b.c as x` | `a.b.c` |
 * | `from a.b import name` | `a.b`, and `a.b.name` if that is a module |
 * | `from a.b import *` | `a.b` |
 * | `from . import name` | the containing package, and `.name` if a module |
 *
 * ## Where a module name is looked up
 *
 * A relative import is lexical: `from .x import y` is the sibling of this file,
 * and no search path is involved. That half is as solid as a Rust `self::`.
 *
 * An absolute import is not. `a.b` means whatever `a` is on `sys.path` at run
 * time, and `sys.path` is a runtime value that a static reader is guessing at.
 * The guess made here is the repository root and `<root>/src`, which is what
 * pyright assumes when a project says nothing -- and the reason a Python
 * accusation is a licence question rather than a coding question.
 */
import { each, parseSource, type Node } from "./parse";
import type { DynamicReason, FileDependencies, FileDependency } from "./deps";
import type { Workspace } from "./workspace";

/**
 * The standard library's top-level names, which no repository may take.
 *
 * `import typing as t` inside a package that also holds a `typing.py` is the
 * standard library's `typing`, not the neighbour -- Python 3 has no implicit
 * relative imports, and pyright resolves typeshed before it resolves anything
 * local at all. Measured rather than assumed: a repository with `json.py` at
 * its own root still gets the standard library's `json`, so this is checked
 * ahead of every root including the first.
 *
 * Sixteen of flask's inventions were this one line, repeated across sixteen
 * modules that sit beside `src/flask/typing.py`.
 *
 * `sys.stdlib_module_names` for the interpreter this was generated from, with
 * the private `_`-prefixed names left out because nothing draws them. The list
 * moves between Python versions -- a repository vendoring a module some later
 * version deleted would be read as the standard library's -- and that is
 * recorded in the licence rather than guessed around.
 */
const STANDARD_LIBRARY = new Set([
  "__future__", "_abc", "_aix_support", "_android_support", "_apple_support",
  "_ast", "_ast_unparse", "_asyncio", "_bisect", "_blake2", "_bz2",
  "_codecs", "_codecs_cn", "_codecs_hk", "_codecs_iso2022", "_codecs_jp",
  "_codecs_kr", "_codecs_tw", "_collections", "_collections_abc",
  "_colorize", "_compat_pickle", "_contextvars", "_csv", "_ctypes",
  "_curses", "_curses_panel", "_datetime", "_dbm", "_decimal",
  "_elementtree", "_frozen_importlib", "_frozen_importlib_external",
  "_functools", "_gdbm", "_hashlib", "_heapq", "_hmac", "_imp",
  "_interpchannels", "_interpqueues", "_interpreters", "_io", "_ios_support",
  "_json", "_locale", "_lsprof", "_lzma", "_markupbase", "_md5",
  "_multibytecodec", "_multiprocessing", "_opcode", "_opcode_metadata",
  "_operator", "_osx_support", "_overlapped", "_pickle", "_posixshmem",
  "_posixsubprocess", "_py_abc", "_py_warnings", "_pydatetime", "_pydecimal",
  "_pyio", "_pylong", "_pyrepl", "_queue", "_random", "_remote_debugging",
  "_scproxy", "_sha1", "_sha2", "_sha3", "_signal", "_sitebuiltins",
  "_socket", "_sqlite3", "_sre", "_ssl", "_stat", "_statistics", "_string",
  "_strptime", "_struct", "_suggestions", "_symtable", "_sysconfig",
  "_thread", "_threading_local", "_tkinter", "_tokenize", "_tracemalloc",
  "_types", "_typing", "_uuid", "_warnings", "_weakref", "_weakrefset",
  "_winapi", "_wmi", "_zoneinfo", "_zstd", "abc", "annotationlib",
  "antigravity", "argparse", "array", "ast", "asyncio", "atexit", "base64",
  "bdb", "binascii", "bisect", "builtins", "bz2", "cProfile", "calendar",
  "cmath", "cmd", "code", "codecs", "codeop", "collections", "colorsys",
  "compileall", "compression", "concurrent", "configparser", "contextlib",
  "contextvars", "copy", "copyreg", "csv", "ctypes", "curses", "dataclasses",
  "datetime", "dbm", "decimal", "difflib", "dis", "doctest", "email",
  "encodings", "ensurepip", "enum", "errno", "faulthandler", "fcntl",
  "filecmp", "fileinput", "fnmatch", "fractions", "ftplib", "functools",
  "gc", "genericpath", "getopt", "getpass", "gettext", "glob", "graphlib",
  "grp", "gzip", "hashlib", "heapq", "hmac", "html", "http", "idlelib",
  "imaplib", "importlib", "inspect", "io", "ipaddress", "itertools", "json",
  "keyword", "linecache", "locale", "logging", "lzma", "mailbox", "marshal",
  "math", "mimetypes", "mmap", "modulefinder", "msvcrt", "multiprocessing",
  "netrc", "nt", "ntpath", "nturl2path", "numbers", "opcode", "operator",
  "optparse", "os", "pathlib", "pdb", "pickle", "pickletools", "pkgutil",
  "platform", "plistlib", "poplib", "posix", "posixpath", "pprint",
  "profile", "pstats", "pty", "pwd", "py_compile", "pyclbr", "pydoc",
  "pydoc_data", "pyexpat", "queue", "quopri", "random", "re", "readline",
  "reprlib", "resource", "rlcompleter", "runpy", "sched", "secrets",
  "select", "selectors", "shelve", "shlex", "shutil", "signal", "site",
  "smtplib", "socket", "socketserver", "sqlite3", "sre_compile",
  "sre_constants", "sre_parse", "ssl", "stat", "statistics", "string",
  "stringprep", "struct", "subprocess", "symtable", "sys", "sysconfig",
  "syslog", "tabnanny", "tarfile", "tempfile", "termios", "textwrap", "this",
  "threading", "time", "timeit", "tkinter", "token", "tokenize", "tomllib",
  "trace", "traceback", "tracemalloc", "tty", "turtle", "turtledemo",
  "types", "typing", "unicodedata", "unittest", "urllib", "uuid", "venv",
  "warnings", "wave", "weakref", "webbrowser", "winreg", "winsound",
  "wsgiref", "xml", "xmlrpc", "zipapp", "zipfile", "zipimport", "zlib",
  "zoneinfo",
  /*
   * Not in `sys.stdlib_module_names`, because it is not a module on disk -- it
   * is whatever is running. Typeshed ships a `__main__.pyi` all the same, so
   * the referee calls it the standard library's, and django's
   * `django/utils/autoreload.py` says `import __main__` next to a real
   * `django/__main__.py`. That was the single invented edge in 10,276.
   */
  "__main__",
]);

/**
 * Where an absolute import is looked up from, in order.
 *
 * `sys.path` is a runtime value, and this is the static guess at it. Three
 * kinds of entry, and the order is the whole of the correctness:
 *
 * 1. **The repository root**, which is what pyright calls the execution root.
 * 2. **`<root>/src`**, because pyright adds it when it exists -- which is how
 *    `src/mypkg/a.py` may say `from mypkg.b import B` and be right.
 * 3. **The importing file's own directory, then each ancestor of it**, which is
 *    pyright's local-import fallback and the half that was missing.
 *
 * The third was not guessed at: flask holds a tutorial, a javascript example
 * and four test applications, each a small project rooted somewhere below the
 * repository root, and `from flaskr.db import get_db` in one of their test
 * files means the `flaskr` beside it. Eleven of flask's twelve missed edges
 * were exactly this, and none of them is exotic -- a repository with examples
 * in it is an ordinary repository.
 *
 * The order matters as much as the list. The root is tried first, so a name
 * that exists both at the root and beside the file resolves to the root's, the
 * way pyright resolves it. Reversing that would not lose an arrow; it would
 * point a real one at the wrong file, which is worse.
 */
function rootsFor(fromFile: string, workspace: Workspace): string[] {
  const roots = [""];
  const src = workspace.resolve("src");
  if (src && workspace.stat(src) === "directory") roots.push("src");

  const parts = directoryOf(fromFile).split("/").filter(Boolean);
  for (let depth = parts.length; depth > 0; depth -= 1) {
    const candidate = parts.slice(0, depth).join("/");
    if (!roots.includes(candidate)) roots.push(candidate);
  }
  return roots;
}

function join(directory: string, rest: string): string {
  return directory ? `${directory}/${rest}` : rest;
}

function directoryOf(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash < 0 ? "" : file.slice(0, slash);
}

/**
 * The file a module path names, if this repository holds it.
 *
 * Two candidates and no more: `a/b.py` for a module, `a/b/__init__.py` for a
 * package. A directory with neither is a namespace package (PEP 420) -- real,
 * importable, and not a file, so it contributes no edge rather than a guessed
 * one.
 */
function fileForModule(parts: string[], root: string, workspace: Workspace): string | undefined {
  const stem = join(root, parts.join("/"));
  for (const candidate of [`${stem}.py`, `${stem}/__init__.py`]) {
    const absolute = workspace.resolve(candidate);
    if (absolute && workspace.stat(absolute) === "file") return candidate;
  }
  return undefined;
}

/** The same lookup, tried at each root in turn. First hit wins, as `sys.path` does. */
function resolveAbsolute(parts: string[], roots: string[], workspace: Workspace): string | undefined {
  if (STANDARD_LIBRARY.has(parts[0]!)) return undefined;
  for (const root of roots) {
    const found = fileForModule(parts, root, workspace);
    if (found) return found;
  }
  return undefined;
}

/**
 * The package a relative import counts its dots from.
 *
 * One dot is the directory holding this file; each further dot is one level up.
 * A file that *is* a package -- `pkg/__init__.py` -- counts from `pkg` itself
 * rather than from `pkg`'s parent, because inside an `__init__.py` the single
 * dot means the package the file defines. Getting that backwards moves every
 * relative import in every package initialiser up one directory, silently.
 */
function relativeBase(fromFile: string, dots: number): string[] | undefined {
  const isPackageInit = fromFile.endsWith("/__init__.py") || fromFile === "__init__.py";
  const here = isPackageInit ? directoryOf(directoryOf(fromFile)) : directoryOf(fromFile);
  const parts = here === "" ? [] : here.split("/");
  const packageParts = isPackageInit
    ? [...parts, directoryOf(fromFile).split("/").pop()!]
    : parts;
  // Each dot beyond the first walks one level up. Walking past the root is an
  // import this repository cannot answer, not an import of the root.
  const up = dots - 1;
  if (up > packageParts.length) return undefined;
  return packageParts.slice(0, packageParts.length - up);
}

/** 1-based line a node starts on, from its own offset rather than by searching. */
function lineOf(source: string, node: Node): number {
  return source.slice(0, node.startIndex).split("\n").length;
}

/** The dotted text of a `dotted_name`, or of the name inside an `aliased_import`. */
function dottedText(node: Node): string {
  return node.text.trim();
}

/**
 * Names bound by a module-level assignment, which is Python's `let`.
 *
 * `def` and `class` are excluded for the same reason `const` is in TypeScript:
 * the binding is written once at the top level and calling it is an ordinary
 * call. A plain `handler = make_handler()` followed by `handler()` is setter
 * injection wearing no syntax at all, and it is the shape no static reader can
 * follow.
 */
function moduleLevelMutables(root: Node): Set<string> {
  const names = new Set<string>();
  for (let index = 0; index < root.childCount; index += 1) {
    const statement = root.child(index);
    if (statement?.type !== "expression_statement") continue;
    for (let inner = 0; inner < statement.childCount; inner += 1) {
      const assignment = statement.child(inner);
      if (assignment?.type !== "assignment") continue;
      const left = assignment.childForFieldName("left");
      if (left?.type === "identifier") names.add(left.text);
    }
  }
  return names;
}

/**
 * The ids of the statements written at the top level of the file.
 *
 * Collected up front rather than asked of each node, because a `Node` here has
 * no parent -- `parse.ts` exposes the narrow surface every reader shares, and
 * widening it for one language is how a grammar detail leaks into four others.
 */
function moduleLevelStatements(root: Node): Set<number> {
  const ids = new Set<number>();
  for (let index = 0; index < root.childCount; index += 1) {
    const child = root.child(index);
    if (child) ids.add(child.id);
  }
  return ids;
}

/**
 * Everything one Python file says about what it needs and how readable it is.
 *
 * `undefined` only when there is no parse at all, which keeps the house rule:
 * a file we could not read is silence, never an absence of dependencies.
 */
export function readPythonDependencies(
  filePath: string,
  source: string,
  workspace: Workspace,
): FileDependencies | undefined {
  const tree = parseSource(source, "python");
  if (!tree) return undefined;

  const root = tree.rootNode;
  const roots = rootsFor(filePath, workspace);
  const mutables = moduleLevelMutables(root);
  const topLevel = moduleLevelStatements(root);
  const dependencies: FileDependency[] = [];
  const dynamic = new Set<DynamicReason>();
  const seen = new Set<string>();

  /**
   * One edge, recorded once.
   *
   * Deduplicated on the specifier *and* the file: `import a.b` twice in one
   * file is one dependency, and the prefix walk below would otherwise report
   * `a` once per line that mentions it.
   */
  const declare = (node: Node, specifier: string, file: string | undefined, deferred: boolean) => {
    const key = `${specifier}\0${file ?? ""}\0${deferred}`;
    if (seen.has(key)) return;
    seen.add(key);
    dependencies.push({
      specifier,
      ...(file ? { file } : {}),
      line: lineOf(source, node),
      deferred,
    });
  };

  /** An absolute or already-anchored module path, plus the prefixes a binding loads. */
  const declareModule = (
    node: Node,
    parts: string[],
    specifier: string,
    deferred: boolean,
    withPrefixes: boolean,
  ) => {
    if (parts.length === 0) return;
    const from = withPrefixes ? 1 : parts.length;
    for (let length = from; length <= parts.length; length += 1) {
      const prefix = parts.slice(0, length);
      const file = resolveAbsolute(prefix, roots, workspace);
      // Only the leaf is reported when it resolves to nothing: a prefix that is
      // a namespace package or a third-party name is not this repository's, and
      // naming it would be an edge to nowhere on every line.
      if (file || length === parts.length) {
        declare(node, length === parts.length ? specifier : prefix.join("."), file, deferred);
      }
    }
  };

  /** The dots and the module path of a `from X import` clause, absolute or relative. */
  const moduleParts = (moduleNode: Node): { parts: string[] | undefined; specifier: string } => {
    const specifier = dottedText(moduleNode);
    if (moduleNode.type !== "relative_import") return { parts: specifier.split("."), specifier };
    const prefix = moduleNode.child(0);
    const dots = prefix?.type === "import_prefix" ? prefix.text.length : 0;
    const base = relativeBase(filePath, dots);
    if (!base) return { parts: undefined, specifier };
    const tail = moduleNode.childForFieldName("name") ?? moduleNode.child(1);
    const rest = tail && tail.type === "dotted_name" ? dottedText(tail).split(".") : [];
    return { parts: [...base, ...rest], specifier };
  };

  each(root, (node) => {
    switch (node.type) {
      case "import_statement": {
        const deferred = !topLevel.has(node.id);
        for (let index = 0; index < node.childCount; index += 1) {
          const child = node.child(index);
          if (child?.type === "dotted_name") {
            // Unaliased: the first segment is bound, so every prefix is loaded
            // and named.
            const specifier = dottedText(child);
            declareModule(child, specifier.split("."), specifier, deferred, true);
          } else if (child?.type === "aliased_import") {
            // Aliased: only the alias is bound, so only the leaf is named --
            // which is what pyright reports, and what the language does.
            const name = child.childForFieldName("name");
            if (!name) continue;
            const specifier = dottedText(name);
            declareModule(name, specifier.split("."), specifier, deferred, false);
          }
        }
        return;
      }
      case "import_from_statement": {
        const deferred = !topLevel.has(node.id);
        const moduleNode = node.childForFieldName("module_name");
        if (!moduleNode) return;
        const { parts, specifier } = moduleParts(moduleNode);
        if (!parts) return;
        // The module itself, without prefixes: `from a.b import x` binds `x`
        // alone, so `a` is loaded and never named.
        declareModule(moduleNode, parts, specifier, deferred, false);
        /*
         * Each imported name may itself be a submodule, which is a second file.
         *
         * The names are the children after the `import` keyword. Read by
         * position rather than by field name, because the `name` field cannot
         * be asked for here: `childForFieldName` returns the first match and
         * there are as many names as the line imports.
         */
        let afterImport = false;
        for (let index = 0; index < node.childCount; index += 1) {
          const imported = node.child(index);
          if (!imported) continue;
          if (imported.type === "import") {
            afterImport = true;
            continue;
          }
          if (!afterImport) continue;
          const leaf = imported.type === "aliased_import"
            ? imported.childForFieldName("name")
            : imported;
          if (leaf?.type !== "dotted_name") continue;
          const submodule = [...parts, dottedText(leaf)];
          const file = resolveAbsolute(submodule, roots, workspace);
          if (file) declare(leaf, `${specifier}.${dottedText(leaf)}`, file, deferred);
        }
        return;
      }
      case "call": {
        const callee = node.childForFieldName("function");
        if (!callee) return;
        const text = callee.text;
        // `__import__` and `importlib.import_module` build a module name at run
        // time. The specifier is sometimes a literal, and reading it anyway
        // would be the reader deciding which runtime values it trusts.
        if (text === "__import__" || text.endsWith("importlib.import_module") || text === "import_module") {
          dynamic.add("dynamic-import");
          return;
        }
        if (text === "eval" || text === "exec") {
          dynamic.add("eval");
          return;
        }
        if (callee.type === "subscript") {
          dynamic.add("computed-call");
          return;
        }
        if (callee.type === "identifier" && mutables.has(text)) dynamic.add("mutable-function");
        return;
      }
      default:
    }
  });

  return {
    dependencies,
    complete: !root.hasError,
    dynamic: [...dynamic],
  };
}
