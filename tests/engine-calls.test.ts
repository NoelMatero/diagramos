/**
 * The call reader (#189).
 *
 * The relationship is the most common thing one piece of code does to another:
 * 162,051 call relationships in the #187 census, 53.2% of everything the syntax
 * shows and four times the next relation. Until this reader existed an arrow
 * could not say it, and the model kept trying anyway -- `will call` and `calls`
 * are the two most-written pieces of prose on any arrow in the board corpus.
 *
 * ## Why this one is harder than every other reader here
 *
 * A field list, a signature and a file's imports are all readable inside one
 * file. **A call is not.** `foo()` is a name, and which `foo` it means is a
 * question about bindings that live somewhere else -- so the reader is two
 * layers, and the second one, `bindingsIn`, is where it goes wrong.
 *
 * ## The footing, which is the thing to keep true
 *
 * `absent` is **not a finding**. A routine that never writes `b()` can still
 * reach `b` through a callback, a trait object, a dispatch table or a decorator,
 * so not finding a call is never evidence there is none. The only accusation the
 * word is entitled to is the one that rests on something found: the call running
 * the other way, and only the other way.
 *
 * ## Every doubt is about a name, not about a body
 *
 * The first version raised a doubt on every call it could not resolve and
 * refused 97% of the corpus, because an ordinary body is full of `console.log`
 * and `.map()`. A doubt only counts when it is about **the name being asked
 * after**, and the tests below are grouped around that rule.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { bindingsIn, callsBetween, type CallSide, type CallsVerdict } from "../src/engine/calls";
import { initEngine, type Language } from "../src/engine/parse";

beforeAll(async () => { await initEngine(); }, 120_000);

/** The verdict as one word, so a test reads as the sentence it is checking. */
function verdictOf(verdict: CallsVerdict): string {
  return verdict.verdict === "withheld" ? `withheld/${verdict.why}` : verdict.verdict;
}

/**
 * Two files and a question about them.
 *
 * The imports each side declares are given as specifier-to-file pairs, which is
 * the shape `deps.ts` hands over -- the reader never resolves a specifier
 * itself, and a test that pretended otherwise would be testing a different
 * thing than the one that runs.
 */
function ask(
  files: Record<string, { source: string; language: Language; imports?: Array<[string, string?]> }>,
  from: { file: string; routine: string },
  to: { file: string; names: string[] },
): CallsVerdict {
  const sideOf = (file: string): CallSide => {
    const one = files[file]!;
    return {
      file,
      source: one.source,
      language: one.language,
      imports: (one.imports ?? []).map(([specifier, target]) => ({
        specifier,
        ...(target ? { file: target } : {}),
      })),
      open: (wanted) => {
        const other = files[wanted];
        if (!other) return undefined;
        return {
          source: other.source,
          language: other.language,
          imports: (other.imports ?? []).map(([specifier, target]) => ({
            specifier,
            ...(target ? { file: target } : {}),
          })),
        };
      },
    };
  };
  return callsBetween({ ...sideOf(from.file), routine: from.routine }, { ...sideOf(to.file), names: to.names });
}

describe("a routine that calls another, in each of the four grammars", () => {
  it("confirms a TypeScript call across an import", () => {
    const verdict = ask({
      "src/a.ts": {
        source: 'import { render } from "./b";\nexport function run() { return render(1); }\n',
        language: "ts",
        imports: [["./b", "src/b.ts"]],
      },
      "src/b.ts": { source: "export function render(n: number) { return n; }\n", language: "ts" },
    }, { file: "src/a.ts", routine: "run" }, { file: "src/b.ts", names: ["render"] });

    expect(verdict.verdict).toBe("confirmed");
    if (verdict.verdict !== "confirmed") return;
    expect(verdict.evidence.name).toBe("render");
    expect(verdict.evidence.inside).toBe("run");
    expect(verdict.evidence.line).toBe(2);
    // Quotable, because a verdict that can refute has to show what it read.
    expect(verdict.evidence.wrote).toContain("render(1)");
  });

  it("confirms a Python call, following the name through `from x import y`", () => {
    // Python is 80% of the call population in the corpus and the language where
    // a call is hardest to place. Its `from` form binds the routine and spells
    // the specifier `module.name`, which is what `deps-python.ts` records.
    const verdict = ask({
      "app/a.py": {
        source: "from app.b import render\n\ndef run():\n    return render(1)\n",
        language: "python",
        imports: [["app.b", "app/b.py"], ["app.b.render", "app/b.py"]],
      },
      "app/b.py": { source: "def render(n):\n    return n\n", language: "python" },
    }, { file: "app/a.py", routine: "run" }, { file: "app/b.py", names: ["render"] });

    expect(verdictOf(verdict)).toBe("confirmed");
  });

  it("confirms a Rust call through a `use` path", () => {
    const verdict = ask({
      "src/a.rs": {
        source: "use crate::b::render;\n\nfn run() -> u32 { render(1) }\n",
        language: "rust",
        imports: [["crate::b::render", "src/b.rs"]],
      },
      "src/b.rs": { source: "pub fn render(n: u32) -> u32 { n }\n", language: "rust" },
    }, { file: "src/a.rs", routine: "run" }, { file: "src/b.rs", names: ["render"] });

    expect(verdictOf(verdict)).toBe("confirmed");
  });

  it("confirms a call inside the same file, with no import to read", () => {
    const source = "function helper() { return 1; }\nfunction run() { return helper(); }\n";
    const verdict = ask(
      { "src/a.ts": { source, language: "ts" } },
      { file: "src/a.ts", routine: "run" },
      { file: "src/a.ts", names: ["helper"] },
    );
    expect(verdictOf(verdict)).toBe("confirmed");
  });
});

describe("the arrow drawn the wrong way round", () => {
  it("reports backwards, quoting the call it found at the far end", () => {
    /*
     * The one accusation this word is entitled to, and it rests on something
     * found: the arrow says `run` calls `render`, `run` calls nothing, and
     * `render` calls the thing at the tail.
     */
    const verdict = ask({
      "src/a.ts": { source: "export function run() { return 1; }\n", language: "ts" },
      "src/b.ts": {
        source: 'import { run } from "./a";\nexport function render() { return run(); }\n',
        language: "ts",
        imports: [["./a", "src/a.ts"]],
      },
    }, { file: "src/a.ts", routine: "run" }, { file: "src/b.ts", names: ["render"] });

    expect(verdict.verdict).toBe("backwards");
    if (verdict.verdict !== "backwards") return;
    expect(verdict.evidence.wrote).toContain("run()");
    expect(verdict.evidence.line).toBe(2);
  });

  it("stays quiet when neither end calls the other", () => {
    // Both readable, neither calling. `absent`, which is silence -- a callback
    // could be wiring them together in a third file nobody read.
    const verdict = ask({
      "src/a.ts": { source: "export function run() { return 1; }\n", language: "ts" },
      "src/b.ts": { source: "export function render() { return 2; }\n", language: "ts" },
    }, { file: "src/a.ts", routine: "run" }, { file: "src/b.ts", names: ["render"] });

    expect(verdictOf(verdict)).toBe("absent");
  });
});

describe("a doubt is about the name being asked after, and never about the body", () => {
  it("ignores an unresolvable call to some other name", () => {
    // `console.log` and `.map()` fill every real body and resolve to nothing.
    // A reader that doubted on each of them refused 97% of the corpus.
    const verdict = ask({
      "src/a.ts": {
        source: 'import { render } from "./b";\n'
          + "export function run() { console.log(1); [].map(x => x); return render(2); }\n",
        language: "ts",
        imports: [["./b", "src/b.ts"]],
      },
      "src/b.ts": { source: "export function render(n: number) { return n; }\n", language: "ts" },
    }, { file: "src/a.ts", routine: "run" }, { file: "src/b.ts", names: ["render"] });

    expect(verdictOf(verdict)).toBe("confirmed");
  });

  it("withholds when the name is called on a receiver whose type is not in the text", () => {
    // Dynamic dispatch, which is the first hazard #189 lists. `thing.render()`
    // might be the far end's `render` and the text does not say.
    const verdict = ask({
      "src/a.ts": {
        source: "export function run(thing: unknown) { return (thing as any).render(); }\n",
        language: "ts",
      },
      "src/b.ts": { source: "export function render() { return 1; }\n", language: "ts" },
    }, { file: "src/a.ts", routine: "run" }, { file: "src/b.ts", names: ["render"] });

    expect(verdictOf(verdict)).toBe("withheld/receiver");
  });

  it("withholds on a callee the text does not name at all", () => {
    // `table[kind]()` could be calling anything, so the doubt stands whatever
    // name was asked after -- the same `computed-call` doubt `deps.ts` names.
    const verdict = ask({
      "src/a.ts": {
        source: "const table: any = {};\nexport function run(kind: string) { return table[kind](); }\n",
        language: "ts",
      },
      "src/b.ts": { source: "export function render() { return 1; }\n", language: "ts" },
    }, { file: "src/a.ts", routine: "run" }, { file: "src/b.ts", names: ["render"] });

    expect(verdictOf(verdict)).toBe("withheld/computed");
  });

  it("withholds when the body can reach a name nowhere in it", () => {
    // Python's whole hazard, and `getattr(handler, name)()` is how a dispatcher
    // is spelled there.
    const verdict = ask({
      "app/a.py": {
        source: "def run(handler, name):\n    return getattr(handler, name)()\n",
        language: "python",
      },
      "app/b.py": { source: "def render():\n    return 1\n", language: "python" },
    }, { file: "app/a.py", routine: "run" }, { file: "app/b.py", names: ["render"] });

    expect(verdictOf(verdict)).toBe("withheld/dynamic");
  });

  it("withholds when a wildcard import could have brought the name in", () => {
    // `from x import *` binds names nothing can enumerate, so a bare call to
    // one of them is placed by nothing in the text.
    const verdict = ask({
      "app/a.py": {
        source: "from app.c import *\n\ndef run():\n    return render(1)\n",
        language: "python",
        imports: [["app.c", "app/c.py"]],
      },
      "app/b.py": { source: "def render(n):\n    return n\n", language: "python" },
    }, { file: "app/a.py", routine: "run" }, { file: "app/b.py", names: ["render"] });

    expect(verdictOf(verdict)).toBe("withheld/unbound");
  });

  it("withholds when the name is bound twice over", () => {
    // Declared here *and* imported. Which one the call means is not in the text,
    // and picking either would be a guess dressed as a verdict.
    const verdict = ask({
      "src/a.ts": {
        source: 'import { render } from "./b";\n'
          + "function render() { return 0; }\nexport function run() { return render(); }\n",
        language: "ts",
        imports: [["./b", "src/b.ts"]],
      },
      "src/b.ts": { source: "export function render() { return 1; }\n", language: "ts" },
    }, { file: "src/a.ts", routine: "run" }, { file: "src/b.ts", names: ["render"] });

    expect(verdictOf(verdict)).toBe("withheld/ambiguous");
  });

  it("withholds when a macro's tokens mention the name", () => {
    // A macro's arguments are loose tokens rather than a tree, so a call written
    // inside one is invisible. Only a doubt when the name is in those tokens --
    // otherwise every `println!` in Rust would silence every question.
    const verdict = ask({
      "src/a.rs": {
        source: "fn run() { my_macro!(render(1)); }\n",
        language: "rust",
      },
      "src/b.rs": { source: "pub fn render(n: u32) -> u32 { n }\n", language: "rust" },
    }, { file: "src/a.rs", routine: "run" }, { file: "src/b.rs", names: ["render"] });

    expect(verdictOf(verdict)).toBe("withheld/macro");
  });

  it("is not silenced by a macro that mentions nothing relevant", () => {
    const verdict = ask({
      "src/a.rs": {
        source: 'use crate::b::render;\n\nfn run() { println!("x"); render(1); }\n',
        language: "rust",
        imports: [["crate::b::render", "src/b.rs"]],
      },
      "src/b.rs": { source: "pub fn render(n: u32) -> u32 { n }\n", language: "rust" },
    }, { file: "src/a.rs", routine: "run" }, { file: "src/b.rs", names: ["render"] });

    expect(verdictOf(verdict)).toBe("confirmed");
  });
});

describe("a name imported from a file that only passes it on", () => {
  it("follows a TypeScript barrel to the file that declares it", () => {
    /*
     * The single largest source of misses before this existed: 250 calls in one
     * repository written in plain sight, answered `absent`. Every one of those
     * is half of a false `backwards`.
     */
    const verdict = ask({
      "src/a.ts": {
        source: 'import { render } from "./index";\nexport function run() { return render(1); }\n',
        language: "ts",
        imports: [["./index", "src/index.ts"]],
      },
      "src/index.ts": {
        source: 'export { render } from "./b";\n',
        language: "ts",
        imports: [["./b", "src/b.ts"]],
      },
      "src/b.ts": { source: "export function render(n: number) { return n; }\n", language: "ts" },
    }, { file: "src/a.ts", routine: "run" }, { file: "src/b.ts", names: ["render"] });

    expect(verdictOf(verdict)).toBe("confirmed");
  });

  it("follows a Python re-export", () => {
    const verdict = ask({
      "app/a.py": {
        source: "from app.api import render\n\ndef run():\n    return render(1)\n",
        language: "python",
        imports: [["app.api", "app/api.py"], ["app.api.render", "app/api.py"]],
      },
      "app/api.py": {
        source: "from app.b import render\n",
        language: "python",
        imports: [["app.b", "app/b.py"], ["app.b.render", "app/b.py"]],
      },
      "app/b.py": { source: "def render(n):\n    return n\n", language: "python" },
    }, { file: "app/a.py", routine: "run" }, { file: "app/b.py", names: ["render"] });

    expect(verdictOf(verdict)).toBe("confirmed");
  });

  it("says nothing at all when the forwarding runs out of road", () => {
    // The barrel is not readable from here, so where the name ends up is
    // unknown. A doubt, never an absence.
    const verdict = ask({
      "src/a.ts": {
        source: 'import { render } from "./index";\nexport function run() { return render(1); }\n',
        language: "ts",
        imports: [["./index", "src/index.ts"]],
      },
      "src/b.ts": { source: "export function render(n: number) { return n; }\n", language: "ts" },
    }, { file: "src/a.ts", routine: "run" }, { file: "src/b.ts", names: ["render"] });

    expect(verdictOf(verdict)).toBe("withheld/elsewhere");
  });

  it("answers no when the file it landed on declares that name itself", () => {
    /*
     * The one place a forwarding search gets to say no, and it is what keeps a
     * genuine name collision quiet instead of raising a doubt: `src/c.ts`
     * declares its own `render`, so the call is definitely not the far end's.
     */
    const verdict = ask({
      "src/a.ts": {
        source: 'import { render } from "./c";\nexport function run() { return render(1); }\n',
        language: "ts",
        imports: [["./c", "src/c.ts"]],
      },
      "src/c.ts": { source: "export function render(n: number) { return n + 1; }\n", language: "ts" },
      "src/b.ts": { source: "export function render(n: number) { return n; }\n", language: "ts" },
    }, { file: "src/a.ts", routine: "run" }, { file: "src/b.ts", names: ["render"] });

    expect(verdictOf(verdict)).toBe("absent");
  });
});

describe("a name imported from outside the repository", () => {
  it("withholds rather than answering no", () => {
    /*
     * `from unittest.mock import patch` resolves to nothing here, and so does a
     * monorepo's `@mundane/ui` -- which *is* inside the repository. Nothing in
     * this reader separates a package from a workspace alias, so reading either
     * as "definitely not the far end" is how an alias becomes a false
     * accusation.
     */
    const verdict = ask({
      "src/a.ts": {
        source: 'import { render } from "@scope/ui";\nexport function run() { return render(1); }\n',
        language: "ts",
        imports: [["@scope/ui"]],
      },
      "src/b.ts": { source: "export function render(n: number) { return n; }\n", language: "ts" },
    }, { file: "src/a.ts", routine: "run" }, { file: "src/b.ts", names: ["render"] });

    expect(verdictOf(verdict)).toBe("withheld/unplaced");
  });
});

describe("the box points at something with no body to read", () => {
  it("tells a name that is not there apart from one with no body", () => {
    const files = {
      "src/a.ts": { source: "export const total = 3;\n", language: "ts" as Language },
      "src/b.ts": { source: "export function render() { return 1; }\n", language: "ts" as Language },
    };
    expect(verdictOf(ask(files, { file: "src/a.ts", routine: "total" }, { file: "src/b.ts", names: ["render"] })))
      .toBe("withheld/no-body");
    expect(verdictOf(ask(files, { file: "src/a.ts", routine: "missing" }, { file: "src/b.ts", names: ["render"] })))
      .toBe("withheld/not-declared");
  });
});

describe("what a name in a file is bound to", () => {
  /*
   * Driven directly, because the binding half is where a call reader goes wrong
   * and a number about the whole verdict would not say which layer produced it.
   */
  it("does not count an import as a local declaration", () => {
    /*
     * The bug this exists to keep fixed. An import *looks* exactly like a
     * declaration to the rule `parse.ts` states -- `import { foo }` is a node
     * with a `name` field -- so counting it made every import in every
     * TypeScript file ambiguous with itself: 217 refusals in `ts`, 156 in `tsx`,
     * and **zero** cross-file calls confirmed in either.
     */
    const bindings = bindingsIn('import { render } from "./b";\nfunction run() { return 1; }\n', "ts")!;
    expect(bindings.local.has("render")).toBe(false);
    expect(bindings.local.has("run")).toBe(true);
    expect(bindings.ambiguous.has("render")).toBe(false);
    expect(bindings.imported.get("render")?.specifier).toBe("./b");
  });

  it("does not count a type's own field as something a bare call could reach", () => {
    /*
     * `interface Props { registerRef: ... }` declares a name nothing in the file
     * can call -- it is the shape of somebody else's argument. Counting it made
     * a call to an imported `registerRef` read as "this file's own", which is a
     * definite no, and the reader answered `absent` on a call three lines below
     * the interface.
     */
    const source = 'import { registerRef } from "./b";\n'
      + "interface Props { registerRef: () => void }\n"
      + "function run() { return registerRef(); }\n";
    const bindings = bindingsIn(source, "ts")!;
    expect(bindings.local.has("registerRef")).toBe(false);
    expect(bindings.ambiguous.has("registerRef")).toBe(false);
  });

  it("binds the module rather than the leaf for Python's `import a.b`", () => {
    // Python's one exception: `import a.b` puts `a` in scope, and only `a`.
    const bindings = bindingsIn("import a.b\nimport a.c as d\n", "python")!;
    expect(bindings.imported.get("a")?.namespace).toBe(true);
    expect(bindings.imported.has("b")).toBe(false);
    expect(bindings.imported.get("d")?.specifier).toBe("a.c");
  });

  it("binds every leaf of a nested Rust `use` list", () => {
    const bindings = bindingsIn("use crate::a::{b, c as d};\n", "rust")!;
    expect(bindings.imported.get("b")?.specifier).toBe("crate::a::b");
    expect(bindings.imported.get("d")?.specifier).toBe("crate::a::c");
  });

  it("records a re-export as forwarded rather than as bound", () => {
    // `export { x } from "./y"` binds nothing here -- no code in this file can
    // call `x` -- and it is the only thing that makes a barrel followable.
    const bindings = bindingsIn('export { render } from "./b";\n', "ts")!;
    expect(bindings.imported.has("render")).toBe(false);
    expect(bindings.forwarded.get("render")?.specifier).toBe("./b");
  });

  it("flags a wildcard in each of the three languages that has one", () => {
    expect(bindingsIn("from x import *\n", "python")!.wildcard).toBe(true);
    expect(bindingsIn("use crate::a::*;\n", "rust")!.wildcard).toBe(true);
    expect(bindingsIn('export * from "./b";\n', "ts")!.wildcard).toBe(true);
  });

  /*
   * The answers above are remembered between questions, because `measure:calls`
   * asked for them 19,320 times about 775 files and each ask walked the file's
   * whole tree. What a cache can get wrong is which answer it hands back, so
   * these are about the key rather than about bindings.
   */
  it("does not hand one file's bindings to another", () => {
    const first = bindingsIn('import { render } from "./b";\n', "ts")!;
    const second = bindingsIn('import { render } from "./c";\n', "ts")!;
    expect(first.imported.get("render")?.specifier).toBe("./b");
    expect(second.imported.get("render")?.specifier).toBe("./c");
    // And asking again does not return whatever was asked last.
    expect(bindingsIn('import { render } from "./b";\n', "ts")!.imported.get("render")?.specifier)
      .toBe("./b");
  });

  it("keeps the same text in two languages apart", () => {
    // `import a.b` is Python binding the module `a`; the same line read as
    // TypeScript is not that at all. One key for both would answer the second
    // question with the first answer.
    expect(bindingsIn("import a.b\n", "python")!.imported.get("a")?.namespace).toBe(true);
    expect(bindingsIn("import a.b\n", "ts")!.imported.has("a")).toBe(false);
  });
});
