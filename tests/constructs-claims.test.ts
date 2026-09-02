/**
 * `@builds` as it reaches a report (#199).
 *
 * `engine-constructs.test.ts` covers the reader. What is covered here is the
 * half that decides what anybody is told: which answer becomes a finding, which
 * becomes silence, and whether a claim nobody could check is distinguishable in
 * the report from a claim that passed.
 *
 * The one thing to keep true here is the thing the reader is written around:
 * **`absent` is not a finding.** A factory is invisible to this reader, so
 * "no construction found" is never "no construction happens", and the only
 * accusation the word is entitled to is the one that rests on finding the
 * construction running the other way.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

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

/**
 * A routine box and a type box, with the arrow drawn maker -> made.
 *
 * The same direction as `returns` and the opposite of `holds`: the thing doing
 * the work comes first, because what the arrow says is "this runs and a Widget
 * comes out".
 */
async function boardOf(
  makerRef: string,
  madeRef: string,
  edge: { claim?: "builds"; state?: "planned" } = {},
): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "maker", label: "build", ref: makerRef },
      { id: "made", label: "Widget", ref: madeRef },
    ],
    edges: [{ from: "maker", to: "made", ...edge }],
  });
  return board;
}

const WIDGET = "export class Widget { id = 1; }\n";

const files = (factory: string) => ({
  "src/factory.ts": factory,
  "src/widget.ts": WIDGET,
});

describe("@builds on an arrow the code confirms", () => {
  it("confirms it, and counts the claim as held", async () => {
    const factory = "export function build() { return new Widget(); }\n";
    const board = await boardOf("src/factory.ts#build", "src/widget.ts#Widget", { claim: "builds" });
    const report = checkDrift(board, fakeWorkspace(files(factory)), { edges: true });

    expect(report.claims.builds).toBe(1);
    expect(report.claims.buildsConfirmed).toBe(1);
    expect(report.clean).toBe(true);
  });
});

describe("absent is not a finding, and this is the test that keeps it true", () => {
  it("says nothing when a factory could be making it out of sight", async () => {
    // `build` hands back a Widget and never writes `new Widget`: the
    // construction is one call away and invisible from here. A reader that
    // called this wrong would be accusing on the strength of not having
    // followed a call.
    const factory = "export function build() { return makeWidget(); }\n";
    const board = await boardOf("src/factory.ts#build", "src/widget.ts#Widget", { claim: "builds" });
    const report = checkDrift(board, fakeWorkspace(files(factory)), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "builds-backwards")).toEqual([]);
    expect(report.clean).toBe(true);
  });
});

describe("@builds on an arrow drawn the wrong way round", () => {
  it("reports it, quoting the construction it found", async () => {
    /*
     * The one accusation this word is entitled to, and it rests on something
     * found: the arrow says `build` makes a `Widget`, `build` makes nothing,
     * and `Widget`'s own method makes the thing at the tail.
     */
    // `Builder` has to be readable and make nothing: the accusation is "runs the
    // other way *and not this way*", so a tail nothing could read gets silence
    // rather than a verdict. An empty class is the second case, not the first.
    const factory = "export class Builder { reset() { return 1; } }\n";
    const widget = "export class Widget { make() { return new Builder(); } }\n";
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "maker", label: "Builder", ref: "src/factory.ts#Builder" },
        { id: "made", label: "Widget", ref: "src/widget.ts#Widget" },
      ],
      edges: [{ from: "maker", to: "made", claim: "builds" }],
    });
    const report = checkDrift(board, fakeWorkspace({
      "src/factory.ts": factory, "src/widget.ts": widget,
    }), { edges: true });

    const finding = report.edges.find((edge) => edge.kind === "builds-backwards");
    expect(finding).toBeDefined();
    expect(finding?.detail).toContain("new Builder");
    expect(report.clean).toBe(false);
  });

  it("says nothing when the tail cannot be read at all", async () => {
    // An empty class makes nothing and proves nothing. "Runs the other way and
    // not this way" needs both halves, so this is silence -- and it is the
    // distinction that keeps the accusation honest.
    const factory = "export class Builder {}\n";
    const widget = "export class Widget { make() { return new Builder(); } }\n";
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "maker", label: "Builder", ref: "src/factory.ts#Builder" },
        { id: "made", label: "Widget", ref: "src/widget.ts#Widget" },
      ],
      edges: [{ from: "maker", to: "made", claim: "builds" }],
    });
    const report = checkDrift(board, fakeWorkspace({
      "src/factory.ts": factory, "src/widget.ts": widget,
    }), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "builds-backwards")).toEqual([]);
    expect(report.claims.buildsWithheld["no-body"]).toBe(1);
    expect(report.clean).toBe(true);
  });
});

describe("a claim nobody could check is not a claim that passed", () => {
  it("counts a Python claim as withheld rather than confirmed", async () => {
    // Construction is spelled as a call in Python, so there is nothing to read
    // in either direction and the word says so.
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "maker", label: "build", ref: "src/factory.py#build" },
        { id: "made", label: "Widget", ref: "src/widget.py#Widget" },
      ],
      edges: [{ from: "maker", to: "made", claim: "builds" }],
    });
    const report = checkDrift(board, fakeWorkspace({
      "src/factory.py": "def build():\n    return Widget()\n",
      "src/widget.py": "class Widget:\n    pass\n",
    }), { edges: true });

    expect(report.claims.buildsConfirmed).toBe(0);
    expect(report.claims.buildsWithheld["call-shaped"]).toBe(1);
    expect(report.clean).toBe(true);
  });
});

describe("a planned arrow is a specification, not an accusation", () => {
  it("refuses the finding on code that does not exist yet", async () => {
    const factory = "export function build() { return 1; }\nexport class Builder {}\n";
    const widget = "export class Widget { make() { return new Builder(); } }\n";
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "maker", label: "Builder", ref: "src/factory.ts#Builder" },
        { id: "made", label: "Widget", ref: "src/widget.ts#Widget" },
      ],
      edges: [{ from: "maker", to: "made", claim: "builds", state: "planned" }],
    });
    const report = checkDrift(board, fakeWorkspace({
      "src/factory.ts": factory, "src/widget.ts": widget,
    }), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "builds-backwards")).toEqual([]);
    expect(report.clean).toBe(true);
  });
});
