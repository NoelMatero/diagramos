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
 * and refuses to give it. In order of how much they cost to give up:
 *
 * - a **cycle** -- both directions exist, and neither arrow is more correct;
 * - a **dynamic** end -- the file reaches out at runtime and the text is not the
 *   whole story;
 * - an **incompletely parsed** end -- "there is no dependency in here" is a claim
 *   about a whole file, and a recovered parse read less than one;
 * - an **unlicensed** language -- nobody measured that reader, so it has not
 *   earned the right;
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
  it("says nothing when both directions exist", () => {
    // Legal in TypeScript, and unanswerable: neither arrow is more correct. The
    // rule is *if both directions exist, say nothing*, never *ties do not happen*.
    const cycle = {
      "x.ts": 'import type { Y } from "./y";\nexport type X = Y;\n',
      "y.ts": 'import type { X } from "./x";\nexport type Y = X | null;\n',
    };
    expect(checkNeeds("x.ts", "y.ts", fakeWorkspace(cycle))).toEqual({ verdict: "cycle" });
    expect(checkNeeds("y.ts", "x.ts", fakeWorkspace(cycle))).toEqual({ verdict: "cycle" });
  });

  it("says nothing when an end reaches out at runtime", () => {
    // font.ts/layout.ts in this repository is exactly this shape, and both ends
    // have to trip on their own or a board drawn the wrong way round gets called
    // right by one of them.
    const dynamic = {
      "host.ts": 'const later = await import("./plugin");\nexport const host = later;\n',
      "plugin.ts": "export const plugin = 1;\n",
    };
    expect(checkNeeds("plugin.ts", "host.ts", fakeWorkspace(dynamic)))
      .toEqual({ verdict: "withheld", why: "dynamic" });
    expect(checkNeeds("host.ts", "plugin.ts", fakeWorkspace(dynamic)))
      .toEqual({ verdict: "withheld", why: "dynamic" });
  });

  it("says nothing when an end could not be parsed to the end", () => {
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

  it("leaves a planned arrow alone, however it is drawn", async () => {
    const report = await verdicts(
      await boardOf("a.ts", "b.ts", { claim: "needs", state: "planned" }),
      files,
    );
    // Not in findings and not in edges: a sketch of a dependency that currently
    // runs the other way is a plan, not a lie.
    expect(report.edges).toEqual([]);
    expect(report.claims.needsChecked).toBe(0);
    expect(report.clean).toBe(true);
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

  it("counts a cycle as withheld, not as checked", async () => {
    const cycle = {
      "x.ts": 'import type { Y } from "./y";\nexport type X = Y;\n',
      "y.ts": 'import type { X } from "./x";\nexport type Y = X | null;\n',
    };
    const report = await verdicts(await boardOf("x.ts", "y.ts", { claim: "needs" }), cycle);
    expect(report.claims.needsWithheld).toEqual({ cycle: 1 });
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
