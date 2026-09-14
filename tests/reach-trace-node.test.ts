/**
 * The TypeScript run-time referee: one test per shape it has to get right (#273).
 *
 * `tests/door-reach-walk.test.ts` holds the shapes the *walk* has to see. This
 * file is the other side -- the evidence the walk is scored against. Everything
 * here failed once, on real source, before it was fixed:
 *
 * - a bare `super()` in a project written without semicolons (45 of vite's 67
 *   suites, reported as a clean run)
 * - a suite that owns `Error.prepareStackTrace` (9 more of vite's)
 * - the runtime instrumented by its own plugin (all 183 of vue's files)
 * - a file whose last line is a `//` comment and which ends without a newline
 *
 * The last of those was found by reading this list back and asking what else
 * text appended to a file could land inside.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import esbuild from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

import { instrument, insertionsFor, repoSourceFile } from "../scripts/lib/reach-trace-plugin.mjs";

const FIXTURE = path.resolve("tests/fixtures/reach-node");

/** What a bundler makes of the instrumented text. The parser is the assertion. */
const parses = (source: string, file = "a.ts") => {
  const out = instrument(source, file, "a.ts");
  expect(out, "nothing was instrumented, so the shape was never tested").toBeDefined();
  esbuild.transformSync(out!, { loader: file.endsWith(".tsx") ? "tsx" : "ts" });
  return out!;
};

describe("the instrumenter leaves valid code", () => {
  it("puts the hook after a bare super() with no semicolon after it", () => {
    /*
     * vite is written without semicolons, so `super()` ends at a newline. The
     * hook went in at the end of that statement and produced
     * `super()globalThis.__reach`, which no parser accepts -- and the run
     * reported zero failures while 45 suites died of it.
     */
    const out = parses(`class Big extends Small {
  private size: number
  constructor(size: number) {
    super()
    this.size = size
  }
}
`);
    expect(out).toContain("super();globalThis.__reach");
  });

  it("keeps a super() call the first statement of a derived constructor", () => {
    // TypeScript refuses a statement in front of `super()` whenever the class
    // has a parameter property, which is most of nest's classes.
    const out = parses(`class Big extends Small {
  constructor(private readonly size: number) {
    super();
  }
}
`);
    expect(out.indexOf("super()")).toBeLessThan(out.indexOf("globalThis.__reach&&"));
  });

  it("closes a file whose last line is a comment with no newline after it", () => {
    /*
     * Appended on the same line the marker lands inside the comment, which
     * parses and does nothing: the file then counts as still initialising for
     * the rest of the run, and every edge through an unnamed frame in it is
     * dropped. So the assertion is that the marker is on a line of its own.
     */
    const out = parses(`export function one(): number { return 1 }\n// the end`);
    expect(out.split("\n").at(-1)).toBe(";globalThis.__reachDone&&globalThis.__reachDone(\"a.ts\");");
  });

  it("keeps the value of a concise arrow body", () => {
    const out = parses(`export const twice = (n: number) => n * 2\n`);
    expect(out).toContain("=> (globalThis.__reach&&globalThis.__reach(__reachF,0),n * 2)");
  });

  it("keeps the value of a concise arrow body that is an object", () => {
    parses(`export const make = (n: number) => ({ n })\n`);
  });

  it("instruments a method, an accessor, a static and a class-field arrow", () => {
    const out = parses(`export class Widget {
  onClick = (): void => { this.tick() }
  static make(): Widget { return new Widget() }
  get size(): number { return 1 }
  set size(n: number) { this.tick() }
  private tick(): void {}
}
`);
    expect(out.match(/globalThis\.__reach&&/g)?.length).toBe(5);
  });

  it("instruments generics, async generators and decorated methods", () => {
    parses(`export class Service<T> {
  @log()
  async *stream<U extends T>(seed: U): AsyncGenerator<U> { yield seed }
}
declare function log(): MethodDecorator;
`);
  });

  it("leaves a file with a shebang alone, because line 1 has to stay line 1", () => {
    expect(instrument(`#!/usr/bin/env node\nexport function one(): number { return 1 }\n`, "a.ts", "a.ts"))
      .toBeUndefined();
  });

  it("leaves a file with no functions alone", () => {
    expect(instrument(`export interface Shape { size: number }\n`, "a.ts", "a.ts")).toBeUndefined();
  });
});

describe("the instrumenter does not move any line", () => {
  it("keeps every original line at its original number", () => {
    const source = readFileSync(path.join(FIXTURE, "src/lib.ts"), "utf8");
    const out = instrument(source, path.join(FIXTURE, "src/lib.ts"), "src/lib.ts")!;
    const before = source.split("\n");
    const after = out.split("\n");
    // One line is added at the end, and nothing before it moves.
    expect(after.length).toBe(before.length + 1);
    for (const [at, line] of before.entries()) {
      if (at === 0) continue; // line 1 carries the file's registration
      const stripped = after[at]!
        .replaceAll(/\(globalThis\.__reach&&globalThis\.__reach\(__reachF,\d+\),/g, "")
        .replaceAll(/globalThis\.__reach&&globalThis\.__reach\(__reachF,\d+\);?/g, "");
      expect(stripped.replaceAll(/[();]/g, ""), `line ${at + 1}`).toContain(line.replaceAll(/[();]/g, "").trimEnd());
    }
  });

  it("reports each function's own declaration line, not its body's", () => {
    const { functions } = insertionsFor(`export function wide(\n  a: number,\n  b: number,\n): number {\n  return a + b\n}\n`, "a.ts");
    expect(functions).toEqual([{ line: 1 }]);
  });
});

describe("what counts as a repository's own source", () => {
  it("takes source under the root and nothing else", () => {
    expect(repoSourceFile("/r/packages/core/app.ts", "/r")).toBe("packages/core/app.ts");
    expect(repoSourceFile("/r/packages/core/app.ts?v=1", "/r")).toBe("packages/core/app.ts");
    expect(repoSourceFile("/elsewhere/app.ts", "/r")).toBeUndefined();
    expect(repoSourceFile("/r/node_modules/x/app.js", "/r")).toBeUndefined();
  });

  it("leaves out the places a test lives, because nobody draws an arrow from a test", () => {
    expect(repoSourceFile("/r/src/app.spec.ts", "/r")).toBeUndefined();
    expect(repoSourceFile("/r/src/__tests__/app.ts", "/r")).toBeUndefined();
    expect(repoSourceFile("/r/test/app.ts", "/r")).toBeUndefined();
    expect(repoSourceFile("/r/src/app.d.ts", "/r")).toBeUndefined();
  });
});

/* -- the record, from a suite that really ran ----------------------------- */

describe("the edges a real vitest run records", () => {
  let edges: Array<[string, string, number, string, string, number, boolean, number]>;
  let dropped = 0;

  beforeAll(() => {
    const out = mkdtempSync(path.join(tmpdir(), "reach-fixture-"));
    try {
      execFileSync(path.resolve("node_modules/.bin/vitest"), ["run", "--config", "vitest.config.mts"], {
        cwd: FIXTURE,
        env: { ...process.env, REACH_ROOT: FIXTURE, REACH_OUT_DIR: out },
        stdio: "pipe",
      });
      const parts = readdirSync(out).filter((one) => one.startsWith("part-"));
      expect(parts.length, "no worker wrote a record").toBeGreaterThan(0);
      edges = [];
      for (const one of parts) {
        const part = JSON.parse(readFileSync(path.join(out, one), "utf8"));
        edges.push(...part.edges);
        dropped += part.dropped;
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  const edge = (from: string, to: string) => edges.find((one) => one[1] === from && one[4] === to);

  it("records a plain call between two routines of one file", () => {
    expect(edge("namedTop", "helper")).toBeDefined();
    expect(edge("namedTop", "helper")![6]).toBe(false);
  });

  it("records a call from a method and from an accessor, under its declared name", () => {
    expect(edge("record", "helper")).toBeDefined();
    // V8 calls the frame `get doubled`; the declaration says `doubled`.
    expect(edge("doubled", "helper")).toBeDefined();
  });

  it("records a constructor as `constructor`, the way the source spells it", () => {
    expect(edge("constructor", "record")).toBeDefined();
  });

  it("records what an async function does after it resumes", () => {
    expect(edge("later", "helper")).toBeDefined();
  });

  it("records a callback a library invoked, marked as passing through it", () => {
    const through = edge("viaCallback", "helper");
    expect(through).toBeDefined();
    expect(through![6], "the anonymous arrow and Array.map in between").toBe(true);
    expect(edge("viaLibrary", "helper")![6]).toBe(true);
  });

  it("records a routine handed to a variable and called through it", () => {
    // `const chosen = helper` then `chosen(x)` inside a reduce: no call to
    // `helper` is written anywhere in `held`.
    expect(edge("held", "helper")).toBeDefined();
    expect(edge("held", "helper")![6]).toBe(true);
  });

  it("drops a call made while the module was still initialising", () => {
    // `const AT_IMPORT = helper(7)` runs at import time. Nothing called it, so
    // there is no routine to draw an arrow from -- `reach_trace.py` drops these
    // too, and counting them would invent an edge out of module scope.
    expect(edges.filter((one) => one[4] === "helper" && one[1] === "")).toEqual([]);
    expect(dropped, "the dropped count is how the run says so").toBeGreaterThan(0);
  });

  it("draws no edge out of a test file", () => {
    expect(edges.filter((one) => one[0].includes(".spec."))).toEqual([]);
  });

  it("names only the fixture's own source as the far end", () => {
    for (const one of edges) expect(one[3]).toBe("src/lib.ts");
  });
});

describe("the fixture is there", () => {
  it("has the file every shape lives in", () => {
    expect(existsSync(path.join(FIXTURE, "src/lib.ts"))).toBe(true);
    expect(existsSync(path.join(FIXTURE, "vitest.config.mts"))).toBe(true);
  });
});
