/**
 * Calls the text already settles, read as what they are (#460, map pattern 3).
 *
 * A wrong `@calls` arrow goes red only when every call in the tail was
 * placed and none is the head. One call left unplaced keeps the whole body
 * "not sure" -- right as a rule, wrong where the language itself says what
 * the call is. Each block here is one such language fact, with the shapes
 * that must stay a doubt beside it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { callsBetween, type CallSide, type CallsVerdict } from "../src/engine/calls";
import { readDependencies } from "../src/engine/deps";
import { createWorkspace } from "../src/engine/drift";
import { initEngine, type Language } from "../src/engine/parse";

beforeAll(async () => { await initEngine(); }, 120_000);

type Files = Record<string, { source: string; language: Language; imports?: Array<[string, string?]> }>;

function ask(files: Files, from: { file: string; routine: string }, to: { file: string; names: string[] }): string {
  const sideOf = (file: string): CallSide => {
    const one = files[file]!;
    const imports = (one.imports ?? []).map(([specifier, target]) => ({ specifier, ...(target ? { file: target } : {}) }));
    return {
      file, source: one.source, language: one.language, imports,
      open: (wanted) => {
        const other = files[wanted];
        return other ? { source: other.source, language: other.language, imports: (other.imports ?? [])
          .map(([specifier, target]) => ({ specifier, ...(target ? { file: target } : {}) })) } : undefined;
      },
    };
  };
  const verdict: CallsVerdict = callsBetween({ ...sideOf(from.file), routine: from.routine }, { ...sideOf(to.file), names: to.names });
  return verdict.verdict === "withheld" ? `withheld/${verdict.why}` : verdict.verdict;
}

/*
 * A function written and called on the spot -- `((t) => ...)(x)`,
 * `(function* (d) { ... })(x)`, `(lambda y: ...)(x)`, `(|y| ...)(x)` -- runs
 * the body written right there, whose calls are already the routine's own
 * (drizzle's `buildSelectQuery`, zx's `retry`). Read as a call of a value it
 * stopped the body as though it could run anything.
 */
describe("a function written and called on the spot runs what is written there", () => {
  const ts = (body: string) => ask({
    "src/a.ts": { source: `function helper(n: number) { return n; }\nexport function run(x: number) {\n${body}\n}\n`, language: "ts" },
    "src/b.ts": { source: "export function other() { return 1; }\n", language: "ts" },
  }, { file: "src/a.ts", routine: "run" }, { file: "src/b.ts", names: ["other"] });

  it("refutes past an arrow function called on the spot (TypeScript)", () => {
    expect(ts("  return ((t: number) => helper(t))(x);")).toBe("refuted");
    expect(ts("  return (async () => helper(x))();")).toBe("refuted");
  });

  it("refutes past a generator written and called on the spot (TypeScript)", () => {
    expect(ts("  return (function* (d: number) { while (true) yield helper(d); })(x);")).toBe("refuted");
  });

  it("refutes past a lambda called on the spot (Python)", () => {
    expect(ask({
      "app/a.py": { source: "def helper(n):\n    return n\n\ndef run(x):\n    return (lambda y: helper(y))(x) + (lambda: 1)()\n", language: "python" },
      "app/b.py": { source: "def other():\n    return 1\n", language: "python" },
    }, { file: "app/a.py", routine: "run" }, { file: "app/b.py", names: ["other"] })).toBe("refuted");
  });

  it("refutes past a closure called on the spot (Rust)", () => {
    expect(ask({
      "src/a.rs": { source: "fn helper(n: u32) -> u32 { n }\n\nfn run(x: u32) -> u32 {\n    (|y: u32| helper(y))(x)\n}\n", language: "rust" },
      "src/b.rs": { source: "pub fn other() -> u32 { 1 }\n", language: "rust" },
    }, { file: "src/a.rs", routine: "run" }, { file: "src/b.rs", names: ["other"] })).toBe("refuted");
  });

  it("confirms when the function written on the spot calls the head", () => {
    expect(ask({
      "src/a.ts": { source: 'import { other } from "./b";\nexport function run(x: number) {\n  return ((t: number) => other(t))(x);\n}\n', language: "ts", imports: [["./b", "src/b.ts"]] },
      "src/b.ts": { source: "export function other(n: number) { return n; }\n", language: "ts" },
    }, { file: "src/a.ts", routine: "run" }, { file: "src/b.ts", names: ["other"] })).toBe("confirmed");
  });

  it("stays quiet when the value called is not written on the spot", () => {
    expect(ts("  return (pick(x))(x);")).not.toBe("refuted");
    expect(ts("  const f = (globalThis as any).f;\n  return (f)(x);")).not.toBe("refuted");
  });
});

/*
 * Python's `from m import *` brings exactly the names m's `__all__` lists,
 * when m writes one (the language reference, "The import statement"). trio's
 * `_run.py` star-imports five generated modules, each with a literal
 * `__all__`, and every `len`, `id` and `RuntimeError` in the file was read as
 * possibly theirs.
 */
describe("a star import over a module with a literal __all__ brings only those names", () => {
  const run = (generated: string) => ask({
    "pkg/_run.py": {
      source: "from ._gen import *\n\ndef setup(xs):\n    if len(xs) > 1:\n        raise RuntimeError(id(xs))\n    return current_time()\n",
      language: "python",
      imports: [["._gen", "pkg/_gen.py"]],
    },
    "pkg/_gen.py": { source: generated, language: "python" },
    "pkg/_other.py": { source: "def unrelated():\n    return 1\n", language: "python" },
  }, { file: "pkg/_run.py", routine: "setup" }, { file: "pkg/_other.py", names: ["unrelated"] });

  it("refutes when the built-ins the body calls are not in the list", () => {
    expect(run("__all__ = [\"current_time\"]\n\ndef current_time():\n    return 0\n")).toBe("refuted");
  });

  it("stays quiet when the module lists a name the language provides too", () => {
    expect(run("__all__ = [\"current_time\", \"len\"]\n\ndef current_time():\n    return 0\n\ndef len(x):\n    return 0\n")).not.toBe("refuted");
  });

  it("stays quiet when __all__ is built up rather than written once", () => {
    expect(run("__all__ = [\"current_time\"]\n__all__ += [\"len\"]\n\ndef current_time():\n    return 0\n\ndef len(x):\n    return 0\n")).not.toBe("refuted");
  });

  it("stays quiet when the module has no __all__ and declares the name", () => {
    expect(run("def current_time():\n    return 0\n\ndef len(x):\n    return 0\n")).not.toBe("refuted");
  });
});

/*
 * `append = output.append`, then `append(text)`: in Python and JavaScript
 * reading a method off a value hands back that method, so calling the local
 * runs what `output.append(text)` would (rich's `_render_buffer`, fastapi's
 * `BodyFieldInfo = params.File`). Read as a value nobody can see into, it
 * kept the body open.
 */
describe("a local holding a method read off a value runs that method", () => {
  it("refutes past a local holding the routine's own method (Python)", () => {
    expect(ask({
      "app/a.py": { source: "class K:\n    def helper(self):\n        return 1\n\n    def run(self):\n        h = self.helper\n        return h()\n", language: "python" },
      "app/b.py": { source: "def other():\n    return 1\n", language: "python" },
    }, { file: "app/a.py", routine: "run" }, { file: "app/b.py", names: ["other"] })).toBe("refuted");
  });

  it("refutes past a local holding the routine's own method, on either branch (TypeScript)", () => {
    expect(ask({
      "src/a.ts": { source: "export class K {\n  helper() { return 1; }\n  plain() { return 2; }\n  run(fast: boolean) {\n    const h = fast ? this.helper : this.plain;\n    return h();\n  }\n}\n", language: "ts" },
      "src/b.ts": { source: "export function other() { return 1; }\n", language: "ts" },
    }, { file: "src/a.ts", routine: "run" }, { file: "src/b.ts", names: ["other"] })).toBe("refuted");
  });

  it("stays quiet when the local holds the head's own method", () => {
    expect(ask({
      "app/a.py": { source: "class K:\n    def helper(self):\n        return 1\n\n    def run(self):\n        h = self.helper\n        return h()\n", language: "python" },
    }, { file: "app/a.py", routine: "run" }, { file: "app/a.py", names: ["helper"] })).not.toBe("refuted");
  });

  it("stays quiet when the value the method is read off has no type in the text", () => {
    expect(ask({
      "app/a.py": { source: "def run(obj):\n    h = obj.render\n    return h()\n", language: "python" },
      "app/b.py": { source: "def other():\n    return 1\n", language: "python" },
    }, { file: "app/a.py", routine: "run" }, { file: "app/b.py", names: ["other"] })).not.toBe("refuted");
  });

  it("stays quiet in Rust, where `self.f` is a field holding whatever was stored", () => {
    expect(ask({
      "src/a.rs": { source: "pub struct K { f: fn() -> u32 }\n\nimpl K {\n    fn helper(&self) -> u32 { 1 }\n    fn run(&self) -> u32 {\n        let h = self.f;\n        h()\n    }\n}\n", language: "rust" },
      "src/b.rs": { source: "pub fn other() -> u32 { 1 }\n", language: "rust" },
    }, { file: "src/a.rs", routine: "run" }, { file: "src/b.rs", names: ["other"] })).not.toBe("refuted");
  });

  it("stays quiet when the local is also given something else", () => {
    expect(ask({
      "app/a.py": { source: "class K:\n    def helper(self):\n        return 1\n\n    def run(self, cb):\n        h = self.helper\n        if cb:\n            h = cb\n        return h()\n", language: "python" },
      "app/b.py": { source: "def other():\n    return 1\n", language: "python" },
    }, { file: "app/a.py", routine: "run" }, { file: "app/b.py", names: ["other"] })).not.toBe("refuted");
  });
});

/** A scratch repository outside the worktree, for the import reader, which reads the tree. */
describe("what an import names, read from the tree", () => {
  let repo: string;
  beforeEach(() => { repo = mkdtempSync(path.join(tmpdir(), "reading-gaps-")); });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });
  const write = (files: Record<string, string>) => {
    for (const [relative, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
      writeFileSync(path.join(repo, relative), contents);
    }
  };
  const dependency = (file: string, specifier: string) => {
    const read = readDependencies(file, String(files_[file]), createWorkspace(repo))!;
    return read.dependencies.filter((one) => one.specifier === specifier).map((one) => ({ file: one.file, library: one.library === true }));
  };
  let files_: Record<string, string> = {};

  /*
   * Python 3 has no implicit relative imports (PEP 328): `from abc import
   * abstractmethod` inside `trio/_abc.py` is the standard library's `abc`,
   * whatever `trio/abc.py` beside it holds. Only a module at a root the
   * program is run from could stand in its place.
   */
  describe("a standard-library module is not shadowed by a module beside the importing file", () => {
    it("reads `abc` as the standard library's beside a package's own `abc.py`", () => {
      files_ = {
        "src/trio/__init__.py": "",
        "src/trio/abc.py": "from ._abc import Clock\n",
        "src/trio/_abc.py": "from abc import ABC, abstractmethod\n\nclass Clock(ABC):\n    @abstractmethod\n    def now(self):\n        ...\n",
      };
      write(files_);
      expect(dependency("src/trio/_abc.py", "abc")).toEqual([{ file: undefined, library: true }]);
    });

    it("reads `typing` as the standard library's beside a package's own `typing.py`", () => {
      files_ = {
        "pydantic/__init__.py": "",
        "pydantic/typing.py": "x = 1\n",
        "pydantic/_internal/__init__.py": "",
        "pydantic/_internal/_dataclasses.py": "from typing import cast\n\ndef f(x):\n    return cast(int, x)\n",
      };
      write(files_);
      expect(dependency("pydantic/_internal/_dataclasses.py", "typing")).toEqual([{ file: undefined, library: true }]);
    });

    it("still reads a module at the repository root as standing in for the standard library's", () => {
      files_ = { "abc.py": "def thing():\n    return 1\n", "app.py": "from abc import thing\n\ndef f():\n    return thing()\n" };
      write(files_);
      expect(dependency("app.py", "abc")).toEqual([{ file: undefined, library: false }]);
    });
  });

  /*
   * TOML writes a string in single quotes too (a literal string). bat's
   * manifest says `edition = '2021'`, read as no edition at all -- 2015,
   * where a bare `use bytesize::ByteSize` is a path from the crate root, so
   * the crate `bytesize` was placed at bat's own `lib.rs`.
   */
  describe("a single-quoted TOML string is a string", () => {
    it("reads `edition = '2021'`, so a bare `use` path names a crate", () => {
      files_ = {
        "Cargo.toml": "[package]\nname = 'bat'\nedition = '2021'\n\n[dependencies]\nbytesize = { version = \"2.3.1\" }\n",
        "src/lib.rs": "pub mod printer;\n",
        "src/printer.rs": "use bytesize::ByteSize;\n\npub fn size(s: u64) -> String { format!(\"{}\", ByteSize(s)) }\n",
      };
      write(files_);
      expect(dependency("src/printer.rs", "bytesize::ByteSize")).toEqual([{ file: undefined, library: true }]);
    });

    it("still reads an edition-2015 manifest's bare path from the crate root", () => {
      files_ = {
        "Cargo.toml": "[package]\nname = 'old'\n",
        "src/lib.rs": "pub mod printer;\npub mod sizes;\n",
        "src/sizes.rs": "pub struct ByteSize(pub u64);\n",
        "src/printer.rs": "use sizes::ByteSize;\n\npub fn size(s: u64) -> ByteSize { ByteSize(s) }\n",
      };
      write(files_);
      expect(dependency("src/printer.rs", "sizes::ByteSize").map((one) => one.file)).toContain("src/sizes.rs");
    });
  });
});
