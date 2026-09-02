/**
 * The Python dependency reader.
 *
 * Python is the language with the most to say here and the least right to say
 * it: no reader, no referee, no licence, and `surveyScope` refuses a Python
 * scope outright. This is the evidence layer that #198 measures.
 *
 * A Python import is not a path. `import pkg.core` names a position in a module
 * tree that no single file contains, the way a Rust `use` does -- so what is
 * tested here is the resolution as much as the parse, and the shapes come from
 * reading real Python rather than from reading the implementation.
 */
import { describe, expect, it, beforeAll } from "vitest";

import { readDependencies, dependencyFiles } from "../src/engine/deps";
import { type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";

beforeAll(async () => {
  await initEngine();
}, 60_000);

/** A tree of files, with directory listing, which Python resolution needs. */
function fakeWorkspace(files: Record<string, string>): Workspace {
  const paths = Object.keys(files);
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => {
      if (files[target] !== undefined) return "file";
      return paths.some((file) => file.startsWith(`${target}/`)) ? "directory" : "missing";
    },
    read: (target) => files[target] ?? "",
    list: (target) => {
      const prefix = target === "" ? "" : `${target}/`;
      const names = new Set<string>();
      for (const file of paths) {
        if (!file.startsWith(prefix)) continue;
        names.add(file.slice(prefix.length).split("/")[0]);
      }
      return [...names];
    },
  };
}

function read(file: string, rest: Record<string, string>) {
  const workspace = fakeWorkspace(rest);
  return readDependencies(file, rest[file], workspace)!;
}

/** A package tree the shapes below are read against. */
const TREE = {
  "pkg/__init__.py": "VERSION = 1\n",
  "pkg/core.py": "class Thing: pass\n",
  "pkg/util.py": "def spin(): pass\n",
  "pkg/deep/__init__.py": "",
  "pkg/deep/leaf.py": "LEAF = 1\n",
};

describe("what a Python file declares", () => {
  /*
   * The five shapes below are the binding rule, not five variations on one
   * theme: `import a.b` loads and names `a`, `import a.b as x` loads `a` and
   * names nothing but the leaf, and `from a import b` names the package plus
   * `b` only when `b` is itself a module. Pyright reports exactly this, and a
   * measurement against it is worth nothing unless both sides mean the same
   * thing by an edge.
   */
  it("names every prefix of a plain dotted import, because the first one is bound", () => {
    const found = read("main.py", { ...TREE, "main.py": "import pkg.deep.leaf\n" });
    expect(dependencyFiles(found)).toEqual([
      "pkg/__init__.py",
      "pkg/deep/__init__.py",
      "pkg/deep/leaf.py",
    ]);
  });

  it("names only the leaf when the import is aliased, because only the alias is bound", () => {
    const found = read("main.py", { ...TREE, "main.py": "import pkg.deep.leaf as leaf\n" });
    expect(dependencyFiles(found)).toEqual(["pkg/deep/leaf.py"]);
  });

  it("names the package, and an imported name only when it is a module of its own", () => {
    const found = read("main.py", {
      ...TREE,
      "main.py": "from pkg import core, VERSION\n",
    });
    expect(dependencyFiles(found)).toEqual(["pkg/__init__.py", "pkg/core.py"]);
  });

  it("reads a relative import against the directory holding the file", () => {
    const found = read("pkg/core.py", {
      ...TREE,
      "pkg/core.py": "from . import util\nfrom .deep.leaf import LEAF\n",
    });
    expect(dependencyFiles(found)).toEqual([
      "pkg/__init__.py",
      "pkg/util.py",
      "pkg/deep/leaf.py",
    ]);
  });

  it("counts a package initialiser's own dot as the package it defines", () => {
    // The trap: inside `pkg/__init__.py`, `.` means `pkg`, not `pkg`'s parent.
    // Getting it backwards moves every relative import in every package
    // initialiser up one directory, and nothing says so out loud.
    const found = read("pkg/__init__.py", {
      ...TREE,
      "pkg/__init__.py": "from .core import Thing\n",
    });
    expect(dependencyFiles(found)).toEqual(["pkg/core.py"]);
  });

  it("resolves an absolute import against src, the way a src-layout project runs", () => {
    const found = read("src/mypkg/a.py", {
      "src/mypkg/__init__.py": "",
      "src/mypkg/a.py": "from mypkg.b import B\n",
      "src/mypkg/b.py": "class B: pass\n",
    });
    // No `__init__.py` edge: `from mypkg.b import B` binds `B` alone, so the
    // package is loaded and never named. Pyright reports the same one file.
    expect(dependencyFiles(found)).toEqual(["src/mypkg/b.py"]);
  });

  /*
   * The two shapes below are the ones the flask measurement found, and neither
   * was guessed at from inside this repository: a `sys.path` in real Python is
   * not one directory. Eleven of flask's misses were a nested example project
   * or a test app importing its own package by name, and every one of them is
   * an arrow a board would want to draw.
   */
  it("resolves an absolute import against the directory the file sits in", () => {
    const found = read("examples/app/main.py", {
      "examples/app/main.py": "from helpers import h\n",
      "examples/app/helpers.py": "def h(): pass\n",
    });
    expect(dependencyFiles(found)).toEqual(["examples/app/helpers.py"]);
  });

  it("walks up from the file when the nearest directory does not have it", () => {
    const found = read("examples/app/tests/test_main.py", {
      "examples/app/tests/test_main.py": "from flaskr.db import get_db\n",
      "examples/app/flaskr/__init__.py": "",
      "examples/app/flaskr/db.py": "def get_db(): pass\n",
    });
    expect(dependencyFiles(found)).toEqual(["examples/app/flaskr/db.py"]);
  });

  it("prefers the repository root over a directory nearer the file", () => {
    // Pyright tries the execution root before it tries anything local, so a
    // name that exists in both places is the root's. Getting the precedence
    // backwards points a real arrow at the wrong file, which is worse than not
    // drawing it.
    const found = read("sub/a.py", {
      "sub/a.py": "from b import X\n",
      "sub/b.py": "X = 2\n",
      "b.py": "X = 1\n",
    });
    expect(dependencyFiles(found)).toEqual(["b.py"]);
  });

  it("gives the standard library the name, even against a file of the same name", () => {
    /*
     * `import typing as t` beside a `typing.py` of your own is the standard
     * library's, and a reader that walks up from the file finds the wrong one
     * unless it checks. Sixteen of flask's inventions were this single line:
     * `src/flask/typing.py` exists, and every module beside it says `import
     * typing as t` meaning the one that ships with Python.
     */
    const found = read("src/flask/logging.py", {
      "src/flask/logging.py": "import typing as t\nimport json\n",
      "src/flask/typing.py": "ResponseReturnValue = str\n",
      "src/flask/json/__init__.py": "",
    });
    expect(dependencyFiles(found)).toEqual([]);
  });

  it("gives `__main__` to Python, next to a package that has one of its own", () => {
    // Not in `sys.stdlib_module_names` and still not yours: `import __main__`
    // means the program that is running. Django has a real `django/__main__.py`
    // and `django/utils/autoreload.py` says this line, which was the one
    // invented edge in ten thousand.
    const found = read("django/utils/autoreload.py", {
      "django/utils/autoreload.py": "import __main__\n",
      "django/__main__.py": "pass\n",
    });
    expect(dependencyFiles(found)).toEqual([]);
  });

  it("says nothing about a third-party import rather than inventing a file", () => {
    const found = read("main.py", { ...TREE, "main.py": "import os\nimport requests\n" });
    expect(dependencyFiles(found)).toEqual([]);
    expect(found.dependencies.map((entry) => entry.specifier)).toEqual(["os", "requests"]);
  });
});

describe("how far a Python file can be trusted", () => {
  it("marks an import that does not run at import time", () => {
    const found = read("main.py", {
      ...TREE,
      "main.py": [
        "from pkg import core",
        "if TYPE_CHECKING:",
        "    from pkg import util",
        "",
      ].join("\n"),
    });
    const deferred = found.dependencies.filter((entry) => entry.deferred).map((entry) => entry.file);
    expect(deferred).toEqual(["pkg/__init__.py", "pkg/util.py"]);
  });

  it("flags the ways a Python file reaches out at runtime", () => {
    const found = read("main.py", {
      ...TREE,
      "main.py": [
        "import importlib",
        "handler = make()",
        "m = importlib.import_module(name)",
        "n = __import__(other)",
        "eval(code)",
        "table[key]()",
        "handler()",
        "",
      ].join("\n"),
    });
    expect([...found.dynamic].sort()).toEqual([
      "computed-call",
      "dynamic-import",
      "eval",
      "mutable-function",
    ]);
  });

  it("reports a file it could not parse end to end as incomplete", () => {
    const found = read("main.py", { ...TREE, "main.py": "from pkg import core\ndef (\n" });
    expect(found.complete).toBe(false);
  });
});
