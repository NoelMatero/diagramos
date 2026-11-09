/**
 * An arrow drawn FROM a class or struct (#459): "Controller calls
 * print_input".
 *
 * The bad outcome, before this: the checker only read functions as callers,
 * so every such arrow, right or wrong, came back "not sure". bat's
 * `Controller` calls `print_input` from its own `run_with_error_handler` and
 * the arrow never went green; fd's `CommandSet` never calls `job` and the
 * arrow never went red. On the benchmark that was 10 / 23 / 37 wrong arrows
 * (main / holdout / holdout-b) nothing could catch.
 *
 * The rule, and the answer key's since #346: a class calls B when one of its
 * own routines does -- its methods and constructor, in Rust the methods of
 * every `impl` of it in the crate -- or code in its body outside a routine
 * does (a field initializer). Red only when all of that was read whole and
 * none of it reaches B.
 *
 * A false red costs trust, so most of this file is the refusal side: code the
 * class inherits and the checker does not read, a decorator or macro that
 * writes code into it, an `impl` in another file, a name it hands on without
 * calling. Each stays "not sure", in each language it can occur in.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { callsBetween, type CallSide, type CallsVerdict } from "../src/engine/calls";
import type { CompiledCrate } from "../src/engine/compiled-calls";
import { initEngine, type Language } from "../src/engine/parse";

beforeAll(async () => { await initEngine(); }, 120_000);

type Import = [specifier: string, file?: string, library?: "library"];
interface FileSpec { source: string; language: Language; imports?: Import[] }

/** A crate rustc built, as far as its file list goes: what a Rust red needs to know every `impl` was seen. */
function crateOf(files: string[]): () => CompiledCrate {
  return () => ({ files: new Set(files), root: files[0]!, byImpl: new Map(), byName: new Map() });
}

function ask(
  files: Record<string, FileSpec>,
  from: { file: string; routine: string },
  to: { file: string; names: string[] },
  options: { crate?: string[] } = {},
): CallsVerdict {
  const importsOf = (spec: FileSpec): CallSide["imports"] => (spec.imports ?? []).map(([specifier, file, library]) => ({
    specifier,
    ...(file ? { file } : {}),
    ...(library ? { library: true as const } : {}),
  }));
  const sideOf = (file: string): CallSide => {
    const one = files[file]!;
    return {
      file,
      source: one.source,
      language: one.language,
      imports: importsOf(one),
      open: (wanted) => {
        const other = files[wanted];
        return other ? { source: other.source, language: other.language, imports: importsOf(other) } : undefined;
      },
      ...(options.crate ? { compiled: crateOf(options.crate) } : {}),
    };
  };
  return callsBetween({ ...sideOf(from.file), routine: from.routine }, { ...sideOf(to.file), names: to.names });
}

/** Red is any verdict a person is shown as "wrong". */
const RED = new Set(["refuted", "wrong-routine", "backwards"]);
const said = (verdict: CallsVerdict): "red" | "green" | "not sure" =>
  verdict.verdict === "confirmed" ? "green" : RED.has(verdict.verdict) ? "red" : "not sure";
const why = (verdict: CallsVerdict): string | undefined =>
  verdict.verdict === "withheld" ? verdict.why : verdict.verdict === "absent" ? verdict.notClosed : undefined;

const RENDER_TS = { source: "export function render(n: number) { return n; }\nexport function paint() { return 0; }\n", language: "ts" as const };
const RENDER_PY = { source: "def render(n):\n    return n\n\ndef paint():\n    return 0\n", language: "python" as const };

describe("a class whose own code calls the far end goes green", () => {
  it("TypeScript: a method calls it", () => {
    const verdict = ask({
      "src/a.ts": {
        source: 'import { render } from "./b";\nexport class Dep {\n  track() { return render(1); }\n}\n',
        language: "ts",
        imports: [["./b", "src/b.ts"]],
      },
      "src/b.ts": RENDER_TS,
    }, { file: "src/a.ts", routine: "Dep" }, { file: "src/b.ts", names: ["render"] });
    expect(said(verdict)).toBe("green");
  });

  it("TypeScript: a field initializer calls it, and the class has no method at all", () => {
    const verdict = ask({
      "src/a.ts": {
        source: 'import { render } from "./b";\nexport class Dep {\n  size = render(1);\n}\n',
        language: "ts",
        imports: [["./b", "src/b.ts"]],
      },
      "src/b.ts": RENDER_TS,
    }, { file: "src/a.ts", routine: "Dep" }, { file: "src/b.ts", names: ["render"] });
    expect(said(verdict)).toBe("green");
  });

  it("Python: a class attribute calls it, and the class has no method at all", () => {
    const verdict = ask({
      "app/a.py": {
        source: "from app.b import render\n\nclass Dep:\n    size = render(1)\n",
        language: "python",
        imports: [["app.b", "app/b.py"]],
      },
      "app/b.py": RENDER_PY,
    }, { file: "app/a.py", routine: "Dep" }, { file: "app/b.py", names: ["render"] });
    expect(said(verdict)).toBe("green");
  });

  it("Rust: a method in a generic `impl` of the struct calls it", () => {
    // `impl<'a> Reader<'a>` was never read forwards: the reader looked for
    // an `impl` spelt exactly `Reader`. bat's `InputReader` is this shape.
    const verdict = ask({
      "src/a.rs": {
        source: "use crate::b::render;\n\npub struct Reader<'a> {\n    buf: &'a [u8],\n}\n\nimpl<'a> Reader<'a> {\n    pub fn go(&self) -> u32 {\n        render(1)\n    }\n}\n",
        language: "rust",
        imports: [["crate::b", "src/b.rs"]],
      },
      "src/b.rs": { source: "pub fn render(n: u32) -> u32 {\n    n\n}\n", language: "rust" },
    }, { file: "src/a.rs", routine: "Reader" }, { file: "src/b.rs", names: ["render"] }, { crate: ["src/lib.rs", "src/a.rs", "src/b.rs"] });
    expect(said(verdict)).toBe("green");
  });
});

describe("a class whose every routine was read, none calling the far end, goes red", () => {
  it("TypeScript", () => {
    const verdict = ask({
      "src/a.ts": {
        source: 'import { paint } from "./b";\nexport class Dep {\n  size = new Map<string, number>();\n  constructor() { paint(); }\n  track() { return 1; }\n}\n',
        language: "ts",
        imports: [["./b", "src/b.ts"]],
      },
      "src/b.ts": RENDER_TS,
    }, { file: "src/a.ts", routine: "Dep" }, { file: "src/b.ts", names: ["render"] });
    expect(said(verdict)).toBe("red");
  });

  it("Python", () => {
    const verdict = ask({
      "app/a.py": {
        source: "from app.b import paint\n\nclass Dep:\n    def __init__(self):\n        paint()\n\n    def track(self):\n        return 1\n",
        language: "python",
        imports: [["app.b", "app/b.py"]],
      },
      "app/b.py": RENDER_PY,
    }, { file: "app/a.py", routine: "Dep" }, { file: "app/b.py", names: ["render"] });
    expect(said(verdict)).toBe("red");
  });

  it("Rust, every `impl` in the struct's own file and rustc's file list showing no other", () => {
    const verdict = ask({
      "src/a.rs": {
        source: "use crate::b::paint;\n\n#[derive(Debug, Clone)]\npub struct Reader {\n    n: u32,\n}\n\nimpl Reader {\n    pub fn go(&self) -> u32 {\n        paint()\n    }\n}\n\nimpl Default for Reader {\n    fn default() -> Self {\n        Reader { n: 0 }\n    }\n}\n",
        language: "rust",
        imports: [["crate::b", "src/b.rs"]],
      },
      "src/b.rs": { source: "pub fn render(n: u32) -> u32 {\n    n\n}\n\npub fn paint() -> u32 {\n    0\n}\n", language: "rust" },
      "src/lib.rs": { source: "mod a;\nmod b;\n", language: "rust" },
    }, { file: "src/a.rs", routine: "Reader" }, { file: "src/b.rs", names: ["render"] }, { crate: ["src/lib.rs", "src/a.rs", "src/b.rs"] });
    expect(said(verdict)).toBe("red");
  });

  it("reads the routines by where they are written, not by name", () => {
    // fd's `walk.rs` has both `WorkerState::scan` and a free function
    // `scan`. The October prototype read the class by its routines' names
    // and took the free function's call for the class's own.
    const verdict = ask({
      "app/a.py": {
        source: "from app.b import render, paint\n\ndef scan():\n    return render(1)\n\nclass Walker:\n    def scan(self):\n        return paint()\n",
        language: "python",
        imports: [["app.b", "app/b.py"]],
      },
      "app/b.py": RENDER_PY,
    }, { file: "app/a.py", routine: "Walker" }, { file: "app/b.py", names: ["render"] });
    expect(said(verdict)).toBe("red");
  });

  it("reads a base declared in the same file as part of the class", () => {
    // requests' `Request(RequestHooksMixin)`: the mixin is written a few
    // lines above, so what the class inherits is read, not guessed.
    const files = (base: string): Record<string, FileSpec> => ({
      "app/a.py": {
        source: `from app.b import render, paint\n\nclass Hooks:\n    def hook(self):\n        return ${base}()\n\nclass Request(Hooks):\n    def send(self):\n        return 1\n`,
        language: "python",
        imports: [["app.b", "app/b.py"]],
      },
      "app/b.py": RENDER_PY,
    });
    const to = { file: "app/b.py", names: ["render"] };
    expect(said(ask(files("paint"), { file: "app/a.py", routine: "Request" }, to))).toBe("red");
    expect(said(ask(files("render"), { file: "app/a.py", routine: "Request" }, to))).not.toBe("red");
  });
});

describe("a class the checker cannot read whole stays not sure", () => {
  it("TypeScript: a base imported from another file", () => {
    const verdict = ask({
      "src/a.ts": {
        source: 'import { Base } from "./base";\nexport class Dep extends Base {\n  track() { return 1; }\n}\n',
        language: "ts",
        imports: [["./base", "src/base.ts"]],
      },
      "src/base.ts": { source: 'import { render } from "./b";\nexport class Base {\n  go() { return render(1); }\n}\n', language: "ts" },
      "src/b.ts": RENDER_TS,
    }, { file: "src/a.ts", routine: "Dep" }, { file: "src/b.ts", names: ["render"] });
    expect(said(verdict)).toBe("not sure");
    expect(why(verdict)).toBe("tail-inherits");
  });

  it("TypeScript: a base from outside the repository", () => {
    const verdict = ask({
      "src/a.ts": {
        source: 'import { Component } from "react";\nexport class Dep extends Component {\n  track() { return 1; }\n}\n',
        language: "ts",
        imports: [["react", undefined, "library"]],
      },
      "src/b.ts": RENDER_TS,
    }, { file: "src/a.ts", routine: "Dep" }, { file: "src/b.ts", names: ["render"] });
    expect(said(verdict)).toBe("not sure");
    expect(why(verdict)).toBe("tail-inherits");
  });

  it("TypeScript: a mixin", () => {
    const verdict = ask({
      "src/a.ts": {
        source: 'import { Hooks } from "./hooks";\nclass Plain {}\nexport class Dep extends Hooks(Plain) {\n  track() { return 1; }\n}\n',
        language: "ts",
        imports: [["./hooks", "src/hooks.ts"]],
      },
      "src/b.ts": RENDER_TS,
    }, { file: "src/a.ts", routine: "Dep" }, { file: "src/b.ts", names: ["render"] });
    expect(said(verdict)).toBe("not sure");
    expect(why(verdict)).toBe("tail-inherits");
  });

  it("TypeScript: a decorated class", () => {
    const verdict = ask({
      "src/a.ts": {
        source: 'import { Injectable } from "./di";\n@Injectable()\nexport class Dep {\n  track() { return 1; }\n}\n',
        language: "ts",
        imports: [["./di", "src/di.ts"]],
      },
      "src/b.ts": RENDER_TS,
    }, { file: "src/a.ts", routine: "Dep" }, { file: "src/b.ts", names: ["render"] });
    expect(said(verdict)).toBe("not sure");
    expect(why(verdict)).toBe("tail-decorated");
  });

  it("Python: a base from outside the repository", () => {
    const verdict = ask({
      "app/a.py": {
        source: "from django.views import View\n\nclass Dep(View):\n    def track(self):\n        return 1\n",
        language: "python",
        imports: [["django.views", undefined, "library"]],
      },
      "app/b.py": RENDER_PY,
    }, { file: "app/a.py", routine: "Dep" }, { file: "app/b.py", names: ["render"] });
    expect(said(verdict)).toBe("not sure");
    expect(why(verdict)).toBe("tail-inherits");
  });

  it("Python: a mixin from another file", () => {
    const verdict = ask({
      "app/a.py": {
        source: "from app.mixins import Hooks\n\nclass Base:\n    pass\n\nclass Dep(Hooks, Base):\n    def track(self):\n        return 1\n",
        language: "python",
        imports: [["app.mixins", "app/mixins.py"]],
      },
      "app/mixins.py": { source: "from app.b import render\n\nclass Hooks:\n    def go(self):\n        return render(1)\n", language: "python" },
      "app/b.py": RENDER_PY,
    }, { file: "app/a.py", routine: "Dep" }, { file: "app/b.py", names: ["render"] });
    expect(said(verdict)).toBe("not sure");
    expect(why(verdict)).toBe("tail-inherits");
  });

  it("Python: a metaclass", () => {
    const verdict = ask({
      "app/a.py": {
        source: "from app.meta import Registry\n\nclass Dep(metaclass=Registry):\n    def track(self):\n        return 1\n",
        language: "python",
        imports: [["app.meta", "app/meta.py"]],
      },
      "app/b.py": RENDER_PY,
    }, { file: "app/a.py", routine: "Dep" }, { file: "app/b.py", names: ["render"] });
    expect(said(verdict)).toBe("not sure");
    expect(why(verdict)).toBe("tail-inherits");
  });

  it("Python: a class a decorator makes", () => {
    const verdict = ask({
      "app/a.py": {
        source: "from app.registry import service\n\n@service\nclass Dep:\n    def track(self):\n        return 1\n",
        language: "python",
        imports: [["app.registry", "app/registry.py"]],
      },
      "app/b.py": RENDER_PY,
    }, { file: "app/a.py", routine: "Dep" }, { file: "app/b.py", names: ["render"] });
    expect(said(verdict)).toBe("not sure");
    expect(why(verdict)).toBe("tail-decorated");
  });

  it("Python: a method set on the class from outside it", () => {
    const verdict = ask({
      "app/a.py": {
        source: "from app.b import render\n\nclass Dep:\n    def track(self):\n        return 1\n\ndef _go(self):\n    return render(1)\n\nDep.go = _go\n",
        language: "python",
        imports: [["app.b", "app/b.py"]],
      },
      "app/b.py": RENDER_PY,
    }, { file: "app/a.py", routine: "Dep" }, { file: "app/b.py", names: ["render"] });
    expect(said(verdict)).toBe("not sure");
    expect(why(verdict)).toBe("tail-elsewhere");
  });

  it("Python: the class holds the far end under another name", () => {
    // `go = render` makes `Dep().go()` run render, and no call is written.
    const verdict = ask({
      "app/a.py": {
        source: "from app.b import render\n\nclass Dep:\n    go = render\n\n    def track(self):\n        return 1\n",
        language: "python",
        imports: [["app.b", "app/b.py"]],
      },
      "app/b.py": RENDER_PY,
    }, { file: "app/a.py", routine: "Dep" }, { file: "app/b.py", names: ["render"] });
    expect(said(verdict)).toBe("not sure");
    expect(why(verdict)).toBe("named");
  });

  it("Rust: an `impl` of the struct in another file of the crate", () => {
    const verdict = ask({
      "src/a.rs": {
        source: "pub struct Reader {\n    n: u32,\n}\n\nimpl Reader {\n    pub fn go(&self) -> u32 {\n        self.n\n    }\n}\n",
        language: "rust",
      },
      "src/c.rs": {
        source: "use crate::a::Reader;\nuse crate::b::render;\n\nimpl Reader {\n    pub fn more(&self) -> u32 {\n        render(1)\n    }\n}\n",
        language: "rust",
        imports: [["crate::a", "src/a.rs"], ["crate::b", "src/b.rs"]],
      },
      "src/b.rs": { source: "pub fn render(n: u32) -> u32 {\n    n\n}\n", language: "rust" },
    }, { file: "src/a.rs", routine: "Reader" }, { file: "src/b.rs", names: ["render"] }, { crate: ["src/a.rs", "src/b.rs", "src/c.rs"] });
    expect(said(verdict)).toBe("not sure");
    expect(why(verdict)).toBe("tail-elsewhere");
  });

  it("Rust: no list of the crate's files, so an `impl` elsewhere cannot be ruled out", () => {
    const verdict = ask({
      "src/a.rs": {
        source: "pub struct Reader {\n    n: u32,\n}\n\nimpl Reader {\n    pub fn go(&self) -> u32 {\n        self.n\n    }\n}\n",
        language: "rust",
      },
      "src/b.rs": { source: "pub fn render(n: u32) -> u32 {\n    n\n}\n", language: "rust" },
    }, { file: "src/a.rs", routine: "Reader" }, { file: "src/b.rs", names: ["render"] });
    expect(said(verdict)).toBe("not sure");
    expect(why(verdict)).toBe("tail-elsewhere");
  });

  it("Rust: a trait of this repository's with a default method", () => {
    // `Walk::walk` is written in the trait, not in any `impl` of Reader,
    // and it runs on a Reader all the same.
    const verdict = ask({
      "src/a.rs": {
        source: "use crate::b::render;\n\npub trait Walk {\n    fn step(&self) -> u32;\n    fn walk(&self) -> u32 {\n        render(self.step())\n    }\n}\n\npub struct Reader {\n    n: u32,\n}\n\nimpl Walk for Reader {\n    fn step(&self) -> u32 {\n        self.n\n    }\n}\n",
        language: "rust",
        imports: [["crate::b", "src/b.rs"]],
      },
      "src/b.rs": { source: "pub fn render(n: u32) -> u32 {\n    n\n}\n", language: "rust" },
    }, { file: "src/a.rs", routine: "Reader" }, { file: "src/b.rs", names: ["render"] }, { crate: ["src/a.rs", "src/b.rs"] });
    expect(said(verdict)).toBe("not sure");
    expect(why(verdict)).toBe("tail-inherits");
  });

  it("Rust: a derive from outside std", () => {
    // clap's `#[derive(Parser)]` writes code that calls the functions its
    // attributes name; nothing of it is in the text.
    const verdict = ask({
      "src/a.rs": {
        source: "use clap::Parser;\n\n#[derive(Parser)]\npub struct Reader {\n    n: u32,\n}\n\nimpl Reader {\n    pub fn go(&self) -> u32 {\n        self.n\n    }\n}\n",
        language: "rust",
        imports: [["clap", undefined, "library"]],
      },
      "src/b.rs": { source: "pub fn render(n: u32) -> u32 {\n    n\n}\n", language: "rust" },
    }, { file: "src/a.rs", routine: "Reader" }, { file: "src/b.rs", names: ["render"] }, { crate: ["src/a.rs", "src/b.rs"] });
    expect(said(verdict)).toBe("not sure");
    expect(why(verdict)).toBe("tail-decorated");
  });
});
