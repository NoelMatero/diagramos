/**
 * The first verdict that can say "wrong", and the six ways it declines to.
 *
 * A backwards arrow is the only thing on a board this tool can *disprove*. Every
 * other check confirms: "related somehow" has no opposite, so failing to find a
 * connection is never evidence there is none, and the answer stays amber forever.
 * `needs` has a direction, so it has an opposite, so it can be wrong.
 *
 * Which makes this the one check here that can cost trust. A false accusation
 * about somebody's diagram is not recoverable by being right the next time, so
 * almost every test below is about a case where the tool has an answer available
 * and refuses to give it.
 *
 * Since #308 they refuse two different questions, and which one they refuse is
 * most of what is tested here. **Confirming needs the import; accusing needs the
 * file.** So these two refuse everything:
 *
 * - an **unlicensed** language -- nobody measured that reader, so it has not
 *   earned the right;
 * - an **unvouched** end -- no source index says that text is source at all.
 *
 * And these refuse the accusation and leave the confirmation standing, because
 * neither of them can unwrite an import somebody can point at:
 *
 * - a **dynamic** end -- the file reaches out at runtime, so "it declares
 *   nothing on that" is not a fact about it;
 * - an **incompletely parsed** end -- "there is no dependency in here" is a claim
 *   about a whole file, and a recovered parse read less than one;
 * - a **cycle** -- both directions exist, so neither *accusation* is available.
 *   The arrow that was drawn is still an import, and confirms.
 *
 * Two more refuse everything for reasons that are not about reading at all:
 *
 * - a **planned** arrow -- sketching a dependency that currently runs the other
 *   way is a thing people do on purpose;
 * - **no claim at all** -- an unclaimed arrow still only means "related somehow".
 *
 * The licence those gates lean on is `src/engine/licence.ts`: 12,824 dependency
 * edges across five repositories, two missed, one invented. Without that number
 * none of this should ship, which is why it was measured first.
 */
import { describe, expect, it, beforeAll } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { checkNeeds } from "../src/engine/needs";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

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

/** A two-box board with one arrow, drawn `from -> to`. */
async function boardOf(
  from: string,
  to: string,
  edge: { claim?: "needs"; state?: "planned" } = {},
): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "one", label: "One", ref: from },
      { id: "two", label: "Two", ref: to },
    ],
    edges: [{ from: "one", to: "two", ...edge }],
  });
  return board;
}

/** The arrow verdicts a board produces against a tree. */
async function verdicts(board: BoardFile, files: Record<string, string>) {
  const report = await checkDrift(board, fakeWorkspace(files), { edges: true });
  return report;
}

describe("which way the dependency runs", () => {
  const files = {
    "a.ts": 'import { b } from "./b";\nexport const a = b;\n',
    "b.ts": "export const b = 1;\n",
    "loose.ts": "export const loose = 3;\n",
  };
  const workspace = fakeWorkspace(files);

  it("confirms an arrow drawn the way the code goes", () => {
    expect(checkNeeds("a.ts", "b.ts", workspace)).toEqual({
      verdict: "confirmed",
      evidence: { file: "a.ts", on: "b.ts", specifier: "./b", line: 1 },
    });
  });

  it("calls an arrow backwards when the dependency runs the other way", () => {
    const result = checkNeeds("b.ts", "a.ts", workspace);
    expect(result.verdict).toBe("backwards");
    // The accusation carries the line somebody has to open to check it.
    expect(result).toMatchObject({ evidence: { file: "a.ts", on: "b.ts", line: 1 } });
  });

  it("says absent when neither file mentions the other", () => {
    expect(checkNeeds("a.ts", "loose.ts", workspace)).toEqual({ verdict: "absent" });
  });

  it("names the line of the first mention, not of the last", () => {
    const twice = {
      "one.ts": 'export const x = 1;\n',
      "two.ts": 'const a = require("./one");\nconst b = require("./one");\n',
    };
    const result = checkNeeds("two.ts", "one.ts", fakeWorkspace(twice));
    expect(result).toMatchObject({ verdict: "confirmed", evidence: { line: 1 } });
  });

  it("refuses an arrow pointing at its own file", () => {
    expect(checkNeeds("a.ts", "a.ts", workspace)).toEqual({ verdict: "withheld", why: "same-file" });
  });
});

describe("the reasons not to answer", () => {
  it("says nothing about which way round a cycle is, and confirms both arrows", () => {
    // Legal in TypeScript, and no *accusation* is available: neither arrow is
    // more wrong than the other. Both are true, though, and before #308 a mutual
    // import refused to confirm either -- 3.6% of true imports in #302's corpus.
    const cycle = {
      "x.ts": 'import type { Y } from "./y";\nexport type X = Y;\n',
      "y.ts": 'import type { X } from "./x";\nexport type Y = X | null;\n',
    };
    expect(checkNeeds("x.ts", "y.ts", fakeWorkspace(cycle)))
      .toMatchObject({ verdict: "confirmed", evidence: { file: "x.ts", on: "y.ts", line: 1 } });
    expect(checkNeeds("y.ts", "x.ts", fakeWorkspace(cycle)))
      .toMatchObject({ verdict: "confirmed", evidence: { file: "y.ts", on: "x.ts", line: 1 } });
  });

  it("says nothing about an absence when an end reaches out at runtime", () => {
    // font.ts/layout.ts in this repository is exactly this shape, and both ends
    // have to trip on their own or a board drawn the wrong way round gets called
    // right by one of them.
    const dynamic = {
      "host.ts": 'const later = await import("./plugin");\nexport const host = later;\n',
      "plugin.ts": "export const plugin = 1;\n",
    };
    expect(checkNeeds("plugin.ts", "host.ts", fakeWorkspace(dynamic)))
      .toEqual({ verdict: "withheld", why: "dynamic" });
  });

  it("says nothing about an absence when an end could not be parsed to the end", () => {
    const broken = {
      "ok.ts": "export const ok = 1;\n",
      // Unbalanced braces: tree-sitter recovers, and a recovered parse read less
      // than the whole file, so nothing can be proved absent in it.
      "torn.ts": "export function f() { if (true { return 1;\n",
    };
    expect(checkNeeds("ok.ts", "torn.ts", fakeWorkspace(broken)))
      .toEqual({ verdict: "withheld", why: "incomplete" });
  });

  it("says nothing about a language nobody measured", () => {
    /*
     * Go, because Rust stopped being an example of this the day it got a
     * licence -- which is the mechanism working. The point of the test is the
     * gate, not the language: whatever has not been measured is silent.
     */
    const go = {
      "main.go": 'package main\n\nimport "example/helper"\n\nfunc main() { helper.Go() }\n',
      "helper/helper.go": "package helper\n\nfunc Go() {}\n",
    };
    expect(checkNeeds("helper/helper.go", "main.go", fakeWorkspace(go)))
      .toEqual({ verdict: "withheld", why: "unlicensed" });
  });

  it("says nothing about a file that is not there", () => {
    expect(checkNeeds("a.ts", "gone.ts", fakeWorkspace({ "a.ts": "" })))
      .toEqual({ verdict: "withheld", why: "unreadable" });
  });
});

/**
 * #308: finding the import is enough to confirm.
 *
 * `@needs` confirmed 75.7% of true imports on #302's corpus, and the single
 * biggest thing it was throwing away was this: `flask/__init__.py` imports
 * `app.py` in plain sight, and the answer was withheld because `app.py` writes
 * one `table[name]()` somewhere else in the file. 19.8% of every true import,
 * refused for something that happened in a different part of the file.
 *
 * One shape per way a file can be less than fully readable, and one per end,
 * because a gate that only trips on the tail lets half of them through.
 */
describe("an import written in plain sight", () => {
  it("confirms although the tail also does something at runtime", () => {
    // The tail is the flask shape: a plain import at the top, a computed call
    // further down. The import did not stop being written.
    const files = {
      "app.ts": 'import { route } from "./routes";\nconst table: Record<string, () => void> = {};\n'
        + 'export const go = (name: string) => table[name]();\nexport const r = route;\n',
      "routes.ts": "export const route = 1;\n",
    };
    expect(checkNeeds("app.ts", "routes.ts", fakeWorkspace(files)))
      .toMatchObject({ verdict: "confirmed", evidence: { file: "app.ts", on: "routes.ts", line: 1 } });
  });

  it("confirms although the head does something at runtime", () => {
    // The literal case from the issue, with the dynamic half at the far end:
    // what `app.py` does cannot unwrite what `__init__.py` declares about it.
    const files = {
      "init.ts": 'import { app } from "./app";\nexport const boot = app;\n',
      "app.ts": 'const table: Record<string, () => void> = {};\n'
        + 'export const app = (name: string) => table[name]();\n',
    };
    expect(checkNeeds("init.ts", "app.ts", fakeWorkspace(files)))
      .toMatchObject({ verdict: "confirmed", evidence: { file: "init.ts", on: "app.ts", line: 1 } });
  });

  it("confirms although the tail could not be parsed to the end", () => {
    // Recovery is local. The `import` the grammar did read is still in the text;
    // what the torn file cannot support is "and there is no other one in here".
    const files = {
      "torn.ts": 'import { ok } from "./ok";\nexport function f() { if (true { return ok;\n',
      "ok.ts": "export const ok = 1;\n",
    };
    expect(checkNeeds("torn.ts", "ok.ts", fakeWorkspace(files)))
      .toMatchObject({ verdict: "confirmed", evidence: { file: "torn.ts", on: "ok.ts", line: 1 } });
  });

  it("confirms a deferred import, which is written down like any other", () => {
    const files = {
      "host.ts": 'const later = await import("./plugin");\nexport const host = later;\n',
      "plugin.ts": "export const plugin = 1;\n",
    };
    expect(checkNeeds("host.ts", "plugin.ts", fakeWorkspace(files)))
      .toMatchObject({ verdict: "confirmed", evidence: { file: "host.ts", on: "plugin.ts", line: 1 } });
  });

  it("confirms nothing when the dynamic import is genuinely unreadable", () => {
    /*
     * The other half of the same shape, and the one that keeps the change
     * honest: the specifier is built at runtime, so no reader knows what file
     * this is. Nothing is found, and the answer is the refusal it always was.
     */
    const files = {
      "host.ts": "const name = String(1);\nconst later = await import(`./${name}`);\nexport const host = later;\n",
      "plugin.ts": "export const plugin = 1;\n",
    };
    expect(checkNeeds("host.ts", "plugin.ts", fakeWorkspace(files)))
      .toEqual({ verdict: "withheld", why: "dynamic" });
  });

  it("still refuses to call an arrow backwards on a file it could not read", () => {
    /*
     * The gate that must not move. The dependency runs head-to-tail only, which
     * is the accusation -- and it rests on "the tail declares nothing on the
     * head", which a file reaching out at runtime cannot support. Withheld
     * before #308 and withheld after it, for both ways a file can be unreadable.
     */
    const dynamicTail = {
      "reader.ts": 'const table: Record<string, () => void> = {};\nexport const go = (n: string) => table[n]();\n',
      "writer.ts": 'import { go } from "./reader";\nexport const w = go;\n',
    };
    expect(checkNeeds("reader.ts", "writer.ts", fakeWorkspace(dynamicTail)))
      .toEqual({ verdict: "withheld", why: "dynamic" });

    const tornTail = {
      "reader.ts": "export function f() { if (true { return 1;\n",
      "writer.ts": 'import { f } from "./reader";\nexport const w = f;\n',
    };
    expect(checkNeeds("reader.ts", "writer.ts", fakeWorkspace(tornTail)))
      .toEqual({ verdict: "withheld", why: "incomplete" });
  });

  it("still refuses everything about a file no source index vouches for", () => {
    // Unchanged by #308, and deliberately so: this gate is not about whether the
    // text can be read but about whether it is source of this repository at all.
    const files = {
      "src/app.ts": 'import { bundled } from "../vendor/bundle.mjs";\nexport const app = bundled;\n',
      "vendor/bundle.mjs": "export const bundled = 1;\n",
    };
    const ledger = { files: new Set(["src/app.ts"]) };
    expect(checkNeeds("src/app.ts", "vendor/bundle.mjs", fakeWorkspace(files), new Map(), ledger))
      .toEqual({ verdict: "withheld", why: "unvouched" });
  });
});

describe("what the board does with it", () => {
  const files = {
    "a.ts": "export const a = 1;\n",
    "b.ts": 'import { a } from "./a";\nexport const b = a;\n',
  };

  it("reports a built needs arrow drawn backwards, naming file and line", async () => {
    const report = await verdicts(await boardOf("a.ts", "b.ts", { claim: "needs" }), files);
    expect(report.edges).toHaveLength(1);
    const [finding] = report.edges;
    expect(finding!.kind).toBe("backwards-edge");
    expect(finding!.detail).toContain("b.ts line 1");
    expect(finding!.detail).toContain("Turn the arrow round");
    // Red, not amber: this is the first arrow verdict that can fail a build.
    expect(report.clean).toBe(false);
  });

  it("stays quiet about the same arrow drawn the right way", async () => {
    const report = await verdicts(await boardOf("b.ts", "a.ts", { claim: "needs" }), files);
    expect(report.edges).toEqual([]);
    expect(report.claims.needsChecked).toBe(1);
    expect(report.clean).toBe(true);
  });

  it("never accuses a planned arrow, whichever way it is drawn", async () => {
    // Drawn the way the code runs.
    const along = await verdicts(
      await boardOf("a.ts", "b.ts", { claim: "needs", state: "planned" }),
      files,
    );
    // Drawn against it -- the case that would be `backwards-edge` on a built
    // arrow. A sketch of a dependency that currently runs the other way is a
    // plan, not a lie, and #124 did not change that: what it changed is whether
    // the plan gets reported as built. See `engine-drift.test.ts`.
    const against = await verdicts(
      await boardOf("b.ts", "a.ts", { claim: "needs", state: "planned" }),
      files,
    );
    for (const report of [along, against]) {
      expect(report.edges).toEqual([]);
      expect(report.findings).toEqual([]);
      expect(report.claims.needsChecked).toBe(0);
      expect(report.clean).toBe(true);
    }
  });

  it("counts a withheld claim under its reason rather than dropping it", async () => {
    const dynamic = {
      "host.ts": 'const later = await import("./plugin");\nexport const host = later;\n',
      "plugin.ts": "export const plugin = 1;\n",
    };
    const report = await verdicts(await boardOf("plugin.ts", "host.ts", { claim: "needs" }), dynamic);
    expect(report.claims.needs).toBe(1);
    expect(report.claims.needsChecked).toBe(0);
    expect(report.claims.needsWithheld).toEqual({ dynamic: 1 });
  });

  it("counts an arrow in a cycle as checked, and says nothing about it", async () => {
    const cycle = {
      "x.ts": 'import type { Y } from "./y";\nexport type X = Y;\n',
      "y.ts": 'import type { X } from "./x";\nexport type Y = X | null;\n',
    };
    const report = await verdicts(await boardOf("x.ts", "y.ts", { claim: "needs" }), cycle);
    expect(report.claims.needsChecked).toBe(1);
    expect(report.claims.needsWithheld).toEqual({});
    expect(report.edges).toEqual([]);
  });
});

describe("a claim written this turn", () => {
  const files = {
    "a.ts": "export const a = 1;\n",
    "b.ts": 'import { a } from "./a";\nexport const b = a;\n',
  };

  /** A baseline over a board held in memory, so no git is involved. */
  function baselineOf(board: BoardFile | undefined) {
    return { committed: () => board };
  }

  it("says so, rather than accusing the author of the tool's own mistake", async () => {
    // The committed board carried the arrow without the claim; this turn added
    // it, and it is already wrong. Reading that as a plain accusation would have
    // the tool telling somebody off for something it wrote itself a moment ago.
    const before = await boardOf("a.ts", "b.ts");
    const now = await boardOf("a.ts", "b.ts", { claim: "needs" });
    const report = await checkDrift(now, fakeWorkspace(files), {
      edges: true,
      baseline: baselineOf(before),
    });
    expect(report.edges[0]!.detail).toContain("a claim written this turn is already wrong");
  });

  it("drops the preface once the claim has been committed", async () => {
    const before = await boardOf("a.ts", "b.ts", { claim: "needs" });
    const now = await boardOf("a.ts", "b.ts", { claim: "needs" });
    const report = await checkDrift(now, fakeWorkspace(files), {
      edges: true,
      baseline: baselineOf(before),
    });
    expect(report.edges[0]!.kind).toBe("backwards-edge");
    expect(report.edges[0]!.detail).not.toContain("written this turn");
  });

  it("says nothing extra when there is no baseline to compare against", async () => {
    // No baseline means the board is unmodified, so nothing was written this
    // turn. Guessing either way here would be worse than not saying.
    const report = await checkDrift(await boardOf("a.ts", "b.ts", { claim: "needs" }), fakeWorkspace(files), {
      edges: true,
      baseline: baselineOf(undefined),
    });
    expect(report.edges[0]!.detail).not.toContain("written this turn");
  });
});
