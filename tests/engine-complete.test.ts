/**
 * `complete`: the claim that says *and that is all of them*.
 *
 * Every other word in this vocabulary is local. `needs` is about one arrow,
 * `closed` about one directory's boundary, and each is refuted by reading the
 * one thing it names. None of them can catch an omission, so a board could be
 * missing half a subsystem and still report clean -- delete an arrow and
 * nothing notices, grow the code past the picture and the report says nothing
 * (#135).
 *
 * The computation that would catch it has existed all along as `unrepresented`,
 * and it was a suggestion rather than a verdict because nobody asked it.
 * Whether a module deserves a box is a judgement, and an engine that volunteers
 * one every turn gets switched off. So the tests here are mostly not about the
 * walk, which is unchanged. They are about who is speaking:
 *
 * - **A claim turns a suggestion into a refutation.** The author asserted it,
 *   so a module nobody drew is their assertion coming back wrong.
 * - **A claim that could never fail is refused, not answered.** A box covering
 *   the whole scope makes the verdict green before anything is read, which is
 *   the guaranteed-green rot `claim.ts` exists to keep out.
 * - **Not disproved is not the same as held.** A scope holding nothing the
 *   reader is measured for is unproven, and must never read as a clean bill.
 */
import { describe, expect, it, beforeAll } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { parseBoardClaim } from "../src/engine/claim";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { readGraph } from "../src/engine/graph";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => {
  await initEngine();
}, 60_000);

/**
 * A flat-file workspace rooted at an absolute path, like the real one.
 *
 * `engine-closed` roots its fake at `"."`, which is fine for a check that
 * compares repo-relative strings. It is not fine here. The coverage walk builds
 * its children by joining onto whatever `resolve(".")` returns, so a root of
 * `"."` yields `./src/app/main.ts` while a box's ref resolves to
 * `src/app/main.ts`, and a file plainly on the board reads as uncovered. A real
 * workspace resolves both through `path.resolve` and gets one spelling; this
 * one has to do the same or it tests a mismatch that cannot happen.
 */
const ROOT = "/repo";

function fakeWorkspace(files: Record<string, string>): Workspace {
  const rel = (target: string) => {
    const trimmed = target.startsWith(ROOT) ? target.slice(ROOT.length) : target;
    const stripped = trimmed.replace(/^\//, "").replace(/^\.\//, "");
    return stripped === "" || stripped === "." ? "." : stripped;
  };
  const absolute = (target: string) => {
    const at = rel(target);
    return at === "." ? ROOT : `${ROOT}/${at}`;
  };
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : absolute(relative)),
    stat: (target) => {
      const at = rel(target);
      if (at === ".") return "directory";
      if (files[at] !== undefined) return "file";
      return Object.keys(files).some((file) => file.startsWith(`${at}/`)) ? "directory" : "missing";
    },
    read: (target) => files[rel(target)] ?? "",
    list: (target) => {
      const at = rel(target);
      const prefix = at === "." ? "" : `${at}/`;
      const names = new Set<string>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        names.add(file.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
  };
}

/**
 * One entry point that reaches two modules, plus a third nothing imports.
 *
 * `util.ts` is the control: it is under the scope and undrawn, and it must
 * never be reported, because nothing on the board reaches it. The relevance bar
 * is inherited from the diagram rather than invented, and a claim that started
 * nominating every file in a directory would be the nag this exists to replace.
 */
const APP = {
  "src/app/main.ts": 'import { parse } from "./parse";\nimport { emit } from "./emit";\n'
    + "export const run = () => emit(parse());\n",
  "src/app/parse.ts": "export const parse = () => 1;\n",
  "src/app/emit.ts": "export const emit = (n: number) => n;\n",
  "src/app/util.ts": "export const util = 2;\n",
};

/** A board of file-anchored boxes. A directory anchor would cover the scope whole. */
async function boardOf(
  refs: Array<[string, string]>,
  complete?: string,
  extra?: { describes?: "concept" },
): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    title: "App",
    ...(complete ? { complete } : {}),
    ...(extra?.describes ? { describes: extra.describes } : {}),
    nodes: refs.map(([id, ref]) => ({ id, label: id, ref })),
    edges: [],
  });
  return board;
}

const MAIN_ONLY: Array<[string, string]> = [["main", "src/app/main.ts"]];
const ALL_THREE: Array<[string, string]> = [
  ["main", "src/app/main.ts"],
  ["parse", "src/app/parse.ts"],
  ["emit", "src/app/emit.ts"],
];

describe("parsing the claim", () => {
  it("takes the directory as the whole claim", () => {
    expect(parseBoardClaim("src/engine")).toEqual({
      claim: { complete: true, about: "src/engine" },
    });
  });

  it("tolerates a leading @ and a trailing slash, which people type", () => {
    expect(parseBoardClaim("@src/engine/")).toEqual({
      claim: { complete: true, about: "src/engine" },
    });
  });

  it("says nothing about a board that claims nothing", () => {
    expect(parseBoardClaim(undefined)).toBeUndefined();
    expect(parseBoardClaim(null)).toBeUndefined();
  });

  it("refuses a shape nothing could read rather than ignoring it", () => {
    // A board that looks like it claims completeness and is read by nothing is
    // worse than one that claims nothing at all.
    expect(parseBoardClaim(true)).toEqual({ garbled: "boolean" });
    expect(parseBoardClaim("   ")).toEqual({ garbled: '""' });
  });
});

describe("on a board", () => {
  it("writes the claim through create_diagram and reads it back", async () => {
    const board = await boardOf(MAIN_ONLY, "src/app");
    expect(readGraph(board).complete).toEqual({ complete: true, about: "src/app" });
  });

  it("records nothing on a board that does not claim it", async () => {
    const graph = readGraph(await boardOf(MAIN_ONLY));
    expect(graph.complete).toBeUndefined();
    expect(graph.completeGarbled).toBeUndefined();
  });

  it("reports one finding naming the worst offender, with the full list beside it", async () => {
    const report = await checkDrift(
      await boardOf(MAIN_ONLY, "src/app"), fakeWorkspace(APP), { edges: false },
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ kind: "incomplete-board", node: "board" });
    expect(report.findings[0]!.detail).toContain("src/app/main.ts imports it");
    expect(report.findings[0]!.detail).toContain("1 more module is missing too");
    expect(report.clean).toBe(false);
    // Two modules, one row. The whole list is carried separately.
    expect(report.undrawn.map((entry) => entry.file).sort())
      .toEqual(["src/app/emit.ts", "src/app/parse.ts"]);
  });

  it("holds, silently, once every module it reaches has a box", async () => {
    const report = await checkDrift(
      await boardOf(ALL_THREE, "src/app"), fakeWorkspace(APP), { edges: false },
    );
    expect(report.findings).toEqual([]);
    expect(report.undrawn).toEqual([]);
    expect(report.claims).toMatchObject({ complete: 1, completeHeld: 1 });
    expect(report.clean).toBe(true);
  });

  it("never nominates a module nothing on the board reaches", async () => {
    // src/app/util.ts is undrawn and under the scope. It is not a finding,
    // because no box imports it: relevance stays inherited from the diagram.
    const report = await checkDrift(
      await boardOf(ALL_THREE, "src/app"), fakeWorkspace(APP), { edges: false },
    );
    expect(report.undrawn).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it("counts only what is under the scope it was given", async () => {
    const files = {
      ...APP,
      "src/app/main.ts": 'import { parse } from "./parse";\nimport { emit } from "./emit";\n'
        + 'import { log } from "../other/log";\nexport const run = () => log(emit(parse()));\n',
      "src/other/log.ts": "export const log = (n: number) => n;\n",
    };
    const report = await checkDrift(
      await boardOf(ALL_THREE, "src/app"), fakeWorkspace(files), { edges: false },
    );
    // src/other/log.ts is undrawn and reached, but it is outside the claim.
    expect(report.findings).toEqual([]);
    expect(report.clean).toBe(true);
  });
});

describe("what it refuses to answer", () => {
  it("refuses a scope that is not a directory", async () => {
    const report = await checkDrift(
      await boardOf(MAIN_ONLY, "src/app/main.ts"), fakeWorkspace(APP), { edges: false },
    );
    expect(report.findings[0]).toMatchObject({ kind: "incomplete-board" });
    expect(report.findings[0]!.detail).toContain("is not a directory");
  });

  it("refuses a scope a single box already covers whole", async () => {
    // A directory ref covers everything beneath it, so nothing inside could
    // ever come back missing. The claim could only go green, which is the
    // guaranteed-green the admission rule keeps out.
    const report = await checkDrift(
      await boardOf([["app", "src/app"]], "src/app"), fakeWorkspace(APP), { edges: false },
    );
    expect(report.findings[0]).toMatchObject({ kind: "incomplete-board" });
    expect(report.findings[0]!.detail).toContain("nothing could ever come back missing");
    expect(report.claims.completeHeld).toBe(0);
  });

  it("refuses a scope covered by a box above it, not just one on it", async () => {
    const report = await checkDrift(
      await boardOf([["src", "src"]], "src/app"), fakeWorkspace(APP), { edges: false },
    );
    expect(report.findings[0]!.detail).toContain("nothing could ever come back missing");
  });

  it("refuses a scope with no files in it", async () => {
    const files = { ...APP, "src/empty/.keep": "" };
    const report = await checkDrift(
      await boardOf(MAIN_ONLY, "src/empty"), fakeWorkspace(files), { edges: false },
    );
    expect(report.findings[0]!.detail).toContain("no files under it");
  });

  it("reports a scope it cannot read as unproven, never as held", async () => {
    // Files exist, no reader is measured for them. "Found nothing missing" and
    // "could not look" are different sentences and must not print the same.
    const files = {
      ...APP,
      "src/vendored/lib.go": "package lib\n",
      "src/vendored/more.go": "package lib\n",
    };
    const report = await checkDrift(
      await boardOf(MAIN_ONLY, "src/vendored"), fakeWorkspace(files), { edges: false },
    );
    expect(report.findings).toEqual([]);
    expect(report.completeUnproven).toHaveLength(1);
    expect(report.completeUnproven[0]!.detail).toContain("2 files under src/vendored");
    expect(report.claims).toMatchObject({ complete: 1, completeHeld: 0 });
    // The board is not wrong, it is unchecked. Those must not read the same.
    expect(report.clean).toBe(true);
  });

  it("is loud about a claim whose shape nothing can read", async () => {
    const board = await boardOf(MAIN_ONLY);
    const title = board.elements.find((element) => (element.customData as { role?: string })?.role === "title")!;
    (title.customData as Record<string, unknown>).complete = 42;
    const report = await checkDrift(board, fakeWorkspace(APP), { edges: false });
    expect(report.garbledClaims).toHaveLength(1);
    expect(report.garbledClaims[0]).toMatchObject({ on: "board", written: "number" });
    // A line on the board that no check can ever read counts against clean.
    expect(report.clean).toBe(false);
  });

  it("says nothing at all on a concept board", async () => {
    // The board is not about this repository, so there is nothing to be
    // complete about. Same exemption every other claim already takes.
    const report = await checkDrift(
      await boardOf(MAIN_ONLY, "src/app", { describes: "concept" }),
      fakeWorkspace(APP),
      { edges: false },
    );
    expect(report.findings).toEqual([]);
    expect(report.claims.complete).toBe(0);
    expect(report.clean).toBe(true);
  });
});

describe("what it leaves alone", () => {
  it("does not turn on suggestions about the rest of the tree", async () => {
    // Claiming one directory is not asking the engine which other modules
    // deserve a box. `unrepresented` stays behind `coverage`, as it always was.
    const report = await checkDrift(
      await boardOf(MAIN_ONLY, "src/app"), fakeWorkspace(APP), { edges: false },
    );
    expect(report.unrepresented).toEqual([]);
    expect(report.undrawn.length).toBeGreaterThan(0);
  });

  it("still suggests when coverage is asked for, claim or no claim", async () => {
    const report = await checkDrift(
      await boardOf(MAIN_ONLY), fakeWorkspace(APP), { edges: false, coverage: true },
    );
    expect(report.unrepresented.map((entry) => entry.file).sort())
      .toEqual(["src/app/emit.ts", "src/app/parse.ts"]);
    // No claim, so no verdict: the suggestion never counts against clean.
    expect(report.findings).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it("leaves a board with no claim exactly as it was", async () => {
    const report = await checkDrift(
      await boardOf(MAIN_ONLY), fakeWorkspace(APP), { edges: false },
    );
    expect(report.claims).toMatchObject({ complete: 0, completeHeld: 0 });
    expect(report.undrawn).toEqual([]);
    expect(report.completeUnproven).toEqual([]);
    expect(report.clean).toBe(true);
  });
});
