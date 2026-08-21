/**
 * The dependency reader: what a file needs, and how far it can be trusted.
 *
 * Nothing here produces a verdict, and that is deliberate -- this is the
 * evidence layer for a "wrong" verdict two steps away. What these tests hold is
 * the three things a refutation needs before it can be honest:
 *
 * - the dependency is really declared in the source text, not pattern-matched
 *   out of prose;
 * - the file was read end to end, so "there is no such dependency in here" is a
 *   statement anyone is entitled to make;
 * - the file does not reach out at runtime, where no reader can follow.
 *
 * The last test is the one that matters. It runs both channels over this whole
 * repository and pins the difference, which is how the reader earns the right
 * to be believed.
 */
import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";

import { readDependencies, dependencyFiles } from "../src/engine/deps";
import { createWorkspace, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { resolveDependency, stripJsonc } from "../src/engine/resolve";
import { measureDependencies } from "../scripts/lib/deps-measure";

beforeAll(async () => {
  await initEngine();
}, 60_000);

function fakeWorkspace(files: Record<string, string>): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => {
      if (files[target] !== undefined) return "file";
      return Object.keys(files).some((file) => file.startsWith(`${target}/`)) ? "directory" : "missing";
    },
    read: (target) => files[target] ?? "",
    list: () => [],
  };
}

/** The reader over one file, with everything else it might reach for present. */
function read(file: string, source: string, rest: Record<string, string> = {}) {
  const workspace = fakeWorkspace({ [file]: source, ...rest });
  return readDependencies(file, source, workspace)!;
}

describe("what a file declares", () => {
  it("reads every form a dependency is written in", () => {
    const found = read(
      "src/a.ts",
      [
        'import { one } from "./one";',
        'import type { Two } from "./two";',
        'export { three } from "./three";',
        'export * from "./four";',
        'import "./five";',
        'const six = require("./six");',
        'const seven = await import("./seven");',
      ].join("\n"),
      Object.fromEntries(
        ["one", "two", "three", "four", "five", "six", "seven"].map((name) => [`src/${name}.ts`, ""]),
      ),
    );
    expect(dependencyFiles(found)).toEqual([
      "src/one.ts",
      "src/two.ts",
      "src/three.ts",
      "src/four.ts",
      "src/five.ts",
      "src/six.ts",
      "src/seven.ts",
    ]);
    // The deferred one is marked, because when it runs is not ours to say.
    expect(found.dependencies.filter((entry) => entry.deferred).map((entry) => entry.specifier))
      .toEqual(["./seven"]);
  });

  it("names the line each one sits on, even when the same file is needed twice", () => {
    const found = read(
      "src/a.ts",
      ['import { one } from "./b";', "", 'const later = await import("./b");'].join("\n"),
      { "src/b.ts": "" },
    );
    expect(found.dependencies.map((entry) => entry.line)).toEqual([1, 3]);
  });

  it("does not count an export that exports nothing from anywhere", () => {
    const found = read("src/a.ts", "export const value = 1;\nexport function go() {}\n");
    expect(found.dependencies).toEqual([]);
  });

  it("records a third-party specifier without inventing a file for it", () => {
    const found = read("src/a.ts", 'import path from "node:path";\nimport { z } from "zod";\n');
    expect(found.dependencies.map((entry) => entry.specifier)).toEqual(["node:path", "zod"]);
    expect(dependencyFiles(found)).toEqual([]);
  });

  /**
   * The difference between reading a grammar and matching a pattern, in one
   * case taken from this repo: `drift.ts`'s regex reports this line as an
   * import of a diagram, because `import` is followed by a string starting with
   * a dot.
   */
  it("is not fooled by source text that merely looks like an import", () => {
    const found = read(
      "tests/one.test.ts",
      [
        'const board = path.join(import.meta.dirname, "../docs/diagrams/board.excalidraw");',
        `const fixture = "import { b } from './b'";`,
        "// import { c } from './c';",
      ].join("\n"),
      { "docs/diagrams/board.excalidraw": "{}", "tests/b.ts": "", "tests/c.ts": "" },
    );
    expect(found.dependencies).toEqual([]);
  });

  it("says nothing at all about a language it was not measured on", () => {
    const workspace = fakeWorkspace({ "src/a.py": "import os\n" });
    // Silence, not an empty answer: an absence of dependencies is a claim, and
    // this reader is not entitled to make it about Python.
    expect(readDependencies("src/a.py", "import os\n", workspace)).toBeUndefined();
  });
});

describe("whether the file was read completely", () => {
  it("vouches for a file it parsed end to end", () => {
    expect(read("src/a.ts", "export const value = 1;\n").complete).toBe(true);
  });

  it("refuses to vouch for one it had to recover from", () => {
    expect(read("src/a.ts", "export const value = = ;\nfunction (((\n").complete).toBe(false);
  });

  /**
   * This repo's own case. `font.ts` builds a cache key as `${size}\0${text}`
   * with a real NUL byte in the template, which tree-sitter cannot read -- and
   * which also makes grep treat the file as binary. Recovery is local, so the
   * import 60 lines below it is still found; the file just cannot be vouched
   * for, which is exactly the distinction that matters.
   */
  it("still finds the dependencies in a file it cannot vouch for", () => {
    const found = read(
      "src/a.ts",
      ['const key = `${size}\u0000${text}`;', 'import { thing } from "./b";'].join("\n"),
      { "src/b.ts": "" },
    );
    expect(found.complete).toBe(false);
    expect(dependencyFiles(found)).toEqual(["src/b.ts"]);
  });
});

describe("whether the file escapes statically", () => {
  const flags = (source: string) => read("src/a.ts", source).dynamic;

  it("flags a dynamic import", () => {
    expect(flags('const m = await import("./b");')).toEqual(["dynamic-import"]);
  });

  it("flags eval and its equivalents", () => {
    expect(flags('const x = eval("1+1");')).toEqual(["eval"]);
    expect(flags('const f = new Function("return 1");')).toEqual(["eval"]);
  });

  it("flags a call through a computed member", () => {
    expect(flags("const table = {};\nfunction go(name) { return table[name](); }\n"))
      .toEqual(["computed-call"]);
  });

  /**
   * Setter injection, and the reason this file exists rather than a graphify
   * query. Graphify's `indirect_call` looks like it would catch this and does
   * not: all 11 of its edges on this repo are inferred argument passing, and
   * none of them touch `layout.ts`, which is this exact shape.
   */
  it("flags a module-level mutable that gets called", () => {
    expect(flags([
      "let measurer = null;",
      "export function set(next) { measurer = next; }",
      "export function measure(text) { return measurer?.(text); }",
    ].join("\n"))).toEqual(["mutable-function"]);
  });

  it("leaves a const alone, because nothing can swap it later", () => {
    expect(flags("const measure = (text) => text.length;\nexport const size = measure('hi');\n"))
      .toEqual([]);
  });

  it("leaves a local let alone, because it says nothing about the module", () => {
    expect(flags([
      "export function go(handlers) {",
      "  let chosen = handlers.first;",
      "  return chosen();",
      "}",
    ].join("\n"))).toEqual([]);
  });

  it("says nothing about an ordinary file", () => {
    expect(flags('import { b } from "./b";\nexport const value = b + 1;\n')).toEqual([]);
  });
});

describe("nicknames from tsconfig", () => {
  const project = (config: string, extra: Record<string, string> = {}) => fakeWorkspace({
    "tsconfig.json": config,
    "src/engine/one.ts": "",
    "src/engine/index.ts": "",
    "packages/ui/button.tsx": "",
    ...extra,
  });

  it("resolves a wildcard nickname", () => {
    const workspace = project('{"compilerOptions":{"paths":{"@/*":["src/*"]}}}');
    expect(resolveDependency("@/engine/one", "src/app.ts", workspace)?.rel).toBe("src/engine/one.ts");
  });

  it("reads a tsconfig with comments and trailing commas", () => {
    // Which is what SvelteKit, NestJS, Vite, T3 and Astro all ship by default.
    const workspace = project(`{
      // the app's own source
      "compilerOptions": {
        "paths": { "@/*": ["src/*"], }, /* trailing comma above */
      },
    }`);
    expect(resolveDependency("@/engine/one", "src/app.ts", workspace)?.rel).toBe("src/engine/one.ts");
  });

  it("follows an extends chain, with the child winning", () => {
    const workspace = fakeWorkspace({
      "tsconfig.base.json": '{"compilerOptions":{"paths":{"@/*":["wrong/*"],"~/*":["packages/*"]}}}',
      "tsconfig.json": '{"extends":"./tsconfig.base.json","compilerOptions":{"paths":{"@/*":["src/*"]}}}',
      "src/engine/one.ts": "",
      "packages/ui/button.tsx": "",
    });
    expect(resolveDependency("@/engine/one", "src/app.ts", workspace)?.rel).toBe("src/engine/one.ts");
    expect(resolveDependency("~/ui/button", "src/app.ts", workspace)?.rel).toBe("packages/ui/button.tsx");
  });

  it("resolves paths against baseUrl, the way a monorepo lays them out", () => {
    const workspace = fakeWorkspace({
      "tsconfig.json": '{"compilerOptions":{"baseUrl":"./src","paths":{"@engine/*":["engine/*"]}}}',
      "src/engine/one.ts": "",
    });
    expect(resolveDependency("@engine/one", "src/app.ts", workspace)?.rel).toBe("src/engine/one.ts");
  });

  it("uses baseUrl on its own, when a config declares one and no paths", () => {
    const workspace = fakeWorkspace({
      "tsconfig.json": '{"compilerOptions":{"baseUrl":"./src"}}',
      "src/engine/one.ts": "",
    });
    expect(resolveDependency("engine/one", "src/app.ts", workspace)?.rel).toBe("src/engine/one.ts");
    // And still invents nothing for a real third-party package.
    expect(resolveDependency("zod", "src/app.ts", workspace)).toBeUndefined();
  });

  it("tries every target in the order they were declared", () => {
    const workspace = fakeWorkspace({
      "tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["nowhere/*","src/*"]}}}',
      "src/engine/one.ts": "",
    });
    // Keeping only the first target drops every import whose file lives at a fallback.
    expect(resolveDependency("@/engine/one", "src/app.ts", workspace)?.rel).toBe("src/engine/one.ts");
  });

  it("prefers the most specific nickname when several match", () => {
    const workspace = fakeWorkspace({
      "tsconfig.json": '{"compilerOptions":{"paths":{"*":["wrong/*"],"@/engine/*":["src/engine/*"],"@/*":["also-wrong/*"]}}}',
      "src/engine/one.ts": "",
    });
    expect(resolveDependency("@/engine/one", "src/app.ts", workspace)?.rel).toBe("src/engine/one.ts");
  });

  it("is unmoved by a malformed config", () => {
    const workspace = project("{ this is not json at all");
    // Somebody else's broken file does not get to fail the run.
    expect(resolveDependency("@/engine/one", "src/app.ts", workspace)).toBeUndefined();
    expect(resolveDependency("./engine/one", "src/app.ts", workspace)?.rel).toBe("src/engine/one.ts");
  });

  it("keeps a // inside a string when stripping comments", () => {
    expect(JSON.parse(stripJsonc('{"url":"https://x.test/a"} // trailing')).url).toBe("https://x.test/a");
  });

  it("prefers a file to a directory index of the same name", () => {
    const workspace = fakeWorkspace({ "src/engine.ts": "", "src/engine/index.ts": "" });
    expect(resolveDependency("./engine", "src/app.ts", workspace)?.rel).toBe("src/engine.ts");
  });

  it("reads .js as .ts, the way TypeScript ESM is written", () => {
    const workspace = fakeWorkspace({ "src/engine/one.ts": "" });
    expect(resolveDependency("./engine/one.js", "src/app.ts", workspace)?.rel).toBe("src/engine/one.ts");
  });
});

/**
 * The measurement, as a test.
 *
 * This is the "done when" of the work: over this whole repository, the reader
 * finds what the existing channel finds. Where they differ, the difference is
 * named here rather than averaged away, because an unexplained difference is
 * the thing that would make a later verdict unsafe.
 */
describe("both channels over this repository", () => {
  let measured: Awaited<ReturnType<typeof measureDependencies>>;

  beforeAll(async () => {
    measured = await measureDependencies(path.resolve(__dirname, ".."));
  }, 180_000);

  it("has a grammar for every source file in the tree", () => {
    expect(measured.noGrammar).toEqual([]);
    expect(measured.files.length).toBeGreaterThan(80);
  });

  it("never finds a dependency the regex channel missed", () => {
    // The reader is TypeScript only and the regex matches TypeScript only, so
    // an edge here would mean one of them is reading something that is not
    // there. Zero, in the direction where a surprise would be alarming.
    expect(measured.onlyReader).toEqual([]);
  });

  it("finds everything the regex channel finds, but one thing it invented", () => {
    // The single difference, named. `path.join(import.meta.dirname,
    // "../docs/diagrams/board-internals.excalidraw")` reads to a regex as an
    // import of a diagram; a grammar knows it is an argument to a function.
    expect(measured.onlyRegex).toEqual([
      "tests/engine-drift.test.ts -> docs/diagrams/board-internals.excalidraw",
    ]);
    expect(measured.fromReader.size).toBe(measured.fromRegex.size - 1);
    expect(measured.fromReader.size).toBeGreaterThan(200);
  });

  /**
   * The case the whole dynamic flag was designed around. `font.ts` reaches
   * `layout.ts` through `await import("./layout")` and calls
   * `setDiagramTextMeasurer`; `layout.ts` invokes it back through
   * `measurerOverride?.()`. The code graph holds only `font -> layout`, so a
   * board honestly drawn `layout -> font` must never be called wrong -- and
   * both ends have to trip independently for that to be safe against either one
   * being edited away.
   */
  it("flags both ends of the case the design was built around", () => {
    const flagged = new Map(measured.dynamic.map((entry) => [entry.file, entry.reasons]));
    expect(flagged.get("src/engine/font.ts")).toContain("dynamic-import");
    expect(flagged.get("src/engine/layout.ts")).toContain("mutable-function");
  });

  it("withholds trust from few enough files to be worth having", () => {
    // 9 of 97 when this was written. The number is not pinned -- what is pinned
    // is that it stays a minority, because a reader that cannot vouch for most
    // of a repo cannot support any verdict in it.
    expect(measured.dynamic.length).toBeLessThan(measured.files.length / 4);
  });

  it("names the one file it cannot read to the end", () => {
    // The NUL byte in font.ts's cache key. Committed, deliberate, and it costs
    // that file the right to be part of any "there is no such dependency" claim.
    expect(measured.incomplete).toEqual(["src/engine/font.ts"]);
  });
});
