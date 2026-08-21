/**
 * The claim slot: a word an arrow can carry, and what it must not do yet.
 *
 * Step one of the plan in docs/handoff/sharper-claims-implementation.md. The
 * word `needs` exists, it is written into customData, it is shown on the board,
 * and a word that is not on the whitelist is loud the turn it is written.
 *
 * The test this file is really about is the last one: a board whose arrows claim
 * `needs` produces the same report, to the byte, as the same board with the
 * claims stripped out. Nothing here judges anything. The verdict comes later,
 * and it comes with the reader that can prove it.
 */
import { describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { labelWithClaim, readLabelClaim } from "../src/engine/claim";
import { connectNodes, createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { readGraph } from "../src/engine/graph";
import type { ExcalidrawElement } from "../src/engine/normalize";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

function fakeWorkspace(files: Record<string, string>): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => (files[target] === undefined ? "missing" : "file"),
    read: (target) => files[target] ?? "",
    list: () => [],
  };
}

/** A bare element of the kind Excalidraw writes when a human draws it. */
function drawn(element: Partial<ExcalidrawElement> & { id: string; type: string }): ExcalidrawElement {
  return { x: 0, y: 0, width: 0, height: 0, isDeleted: false, version: 1, ...element } as ExcalidrawElement;
}

function boardOf(elements: ExcalidrawElement[]): BoardFile {
  return { ...emptyBoard(), elements };
}

describe("the claim vocabulary", () => {
  it("reads the one word there is, in any case", () => {
    expect(readLabelClaim("@needs")).toEqual({ parsed: { claim: "needs" } });
    expect(readLabelClaim("@Needs")).toEqual({ parsed: { claim: "needs" } });
    expect(readLabelClaim("writes @needs")).toEqual({ text: "writes", parsed: { claim: "needs" } });
  });

  it("leaves a label with no claim exactly as it was", () => {
    expect(readLabelClaim("writes to")).toEqual({ text: "writes to" });
    expect(readLabelClaim("")).toEqual({});
  });

  it("refuses a word that is not on the whitelist", () => {
    expect(readLabelClaim("@need")).toEqual({ parsed: { garbled: "need" } });
    expect(readLabelClaim("@depends")).toEqual({ parsed: { garbled: "depends" } });
    // One arrow, one claim. Two is a question, not two facts.
    expect(readLabelClaim("@needs @needs")).toEqual({ parsed: { garbled: "needs needs" } });
  });

  it("writes the claim in the same form it reads", () => {
    expect(labelWithClaim(undefined, "needs")).toBe("@needs");
    expect(labelWithClaim("writes", "needs")).toBe("writes @needs");
    expect(labelWithClaim("writes", undefined)).toBe("writes");
    expect(readLabelClaim(labelWithClaim("writes", "needs")!)).toEqual({
      text: "writes",
      parsed: { claim: "needs" },
    });
  });
});

describe("carrying a claim on a board", () => {
  it("records the claim on the arrow and shows it in the label", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [{ id: "a", label: "A", ref: "a.ts" }, { id: "b", label: "B", ref: "b.ts" }],
      edges: [{ from: "a", to: "b", claim: "needs" }],
    });
    const arrow = board.elements.find(
      (element) => (element.customData as { edge?: unknown } | undefined)?.edge,
    );
    expect((arrow!.customData as { edge: { claim?: string } }).edge.claim).toBe("needs");

    const graph = readGraph(board);
    expect(graph.edges[0]).toMatchObject({ from: "a", to: "b", claim: "needs" });
    // Visible, or it cannot be refused.
    const labels = board.elements.filter((element) => element.type === "text").map((element) => element.text);
    expect(labels).toContain("@needs");
  });

  it("keeps the author's own word and adds the claim after it", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b", label: "writes", claim: "needs" }],
    });
    const graph = readGraph(board);
    // The label reads back as prose plus a claim, not as one string with an @ in it.
    expect(graph.edges[0]).toMatchObject({ label: "writes", claim: "needs" });
  });

  it("carries a claim through connect_nodes too", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [],
    });
    const connected = await connectNodes(board, [{ from: "a", to: "b", claim: "needs" }]);
    expect(readGraph(connected.board).edges[0]).toMatchObject({ claim: "needs" });
  });

  it("reads a claim a human typed onto an arrow", () => {
    const graph = readGraph(
      boardOf([
        drawn({ id: "a", type: "rectangle", width: 100, height: 60, customData: { node: "a" } }),
        drawn({ id: "b", type: "rectangle", x: 300, width: 100, height: 60, customData: { node: "b" } }),
        drawn({
          id: "arrow",
          type: "arrow",
          x: 105,
          y: 30,
          points: [[0, 0], [190, 0]],
          startBinding: { elementId: "a" },
          endBinding: { elementId: "b" },
        }),
        drawn({ id: "t", type: "text", containerId: "arrow", text: "@needs" }),
      ]),
    );
    expect(graph.edges[0]).toMatchObject({ from: "a", to: "b", claim: "needs" });
  });

  it("does not read a claim off a loose label it only guessed belongs to the arrow", () => {
    const graph = readGraph(
      boardOf([
        drawn({ id: "a", type: "rectangle", width: 100, height: 60 }),
        drawn({ id: "b", type: "rectangle", x: 300, width: 100, height: 60 }),
        drawn({ id: "arrow", type: "arrow", x: 105, y: 30, points: [[0, 0], [190, 0]] }),
        // A legend, a note, an address -- the engine matched it to this arrow by
        // distance alone, and a guess must not become a claim or an accusation.
        drawn({ id: "t", type: "text", x: 180, y: 20, width: 60, height: 20, text: "ask @noel" }),
      ]),
    );
    expect(graph.edges[0].claim).toBeUndefined();
    expect(graph.edges[0].claimGarbled).toBeUndefined();
    expect(graph.edges[0].label).toBe("ask @noel");
  });
});

describe("a word that is not a claim", () => {
  const workspace = () => fakeWorkspace({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n" });

  it("fails loudly the turn it is written on an arrow", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [{ id: "a", label: "A", ref: "a.ts" }, { id: "b", label: "B", ref: "b.ts" }],
      edges: [{ from: "a", to: "b", label: "@need" }],
    });
    const report = checkDrift(board, workspace());
    expect(report.garbledClaims).toHaveLength(1);
    expect(report.garbledClaims[0]).toMatchObject({ on: "arrow", written: "need", label: "A → B" });
    expect(report.garbledClaims[0].detail).toContain("@needs");
    // Loud means it counts: a claim nothing can read is a defect, not a note.
    expect(report.clean).toBe(false);
  });

  it("fails loudly on a box, because no box claim is checked yet", () => {
    const board = boardOf([
      drawn({
        id: "r1",
        type: "rectangle",
        width: 200,
        height: 100,
        customData: { node: "engine", ref: "a.ts", claim: { closed: true } },
      }),
    ]);
    const report = checkDrift(board, workspace());
    expect(report.garbledClaims).toHaveLength(1);
    expect(report.garbledClaims[0]).toMatchObject({ on: "box", written: "closed" });
    expect(report.garbledClaims[0].detail).toContain("arrive with the check that judges them");
  });

  it("is still loud on a concept board, where nothing else is checked", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      title: "SIP registration",
      describes: "concept",
      nodes: [{ id: "a", label: "UE" }, { id: "b", label: "P-CSCF" }],
      edges: [{ from: "a", to: "b", label: "@sends" }],
    });
    const report = checkDrift(board, workspace());
    expect(report.garbledClaims).toHaveLength(1);
    expect(report.clean).toBe(false);
  });
});

describe("a claim changes no verdict", () => {
  /**
   * The promise of this step, and the only test that can hold anyone to it.
   *
   * Two boards, identical but for the claims, checked against the same tree.
   * `needs` is even *wrong* here -- b.ts imports a.ts, and the arrow claims the
   * other direction -- and the report does not notice, because noticing is the
   * next issue's job and this one must not anticipate it.
   */
  const files = {
    "a.ts": "export const a = 1;\n",
    "b.ts": "import { a } from './a';\nexport const b = a;\n",
    "c.ts": "export const c = 3;\n",
  };

  async function reportFor(claimed: boolean) {
    const claim = claimed ? ("needs" as const) : undefined;
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "a", label: "A", ref: "a.ts" },
        { id: "b", label: "B", ref: "b.ts" },
        { id: "c", label: "C", ref: "c.ts" },
      ],
      edges: [
        // Backwards on purpose: b imports a, and this says a needs b.
        { from: "a", to: "b", ...(claim ? { claim } : {}) },
        // Nothing connects these two at all: amber with or without a claim.
        { from: "b", to: "c", ...(claim ? { claim } : {}) },
      ],
    });
    return checkDrift(board, fakeWorkspace(files), { edges: true });
  }

  it("checks byte-identically with the claims and without them", async () => {
    const claimed = await reportFor(true);
    const bare = await reportFor(false);

    expect(claimed.claims).toEqual({ needs: 2 });
    expect(bare.claims).toEqual({ needs: 0 });
    expect(claimed.garbledClaims).toEqual([]);

    // Everything a reader is ever shown, compared as one string. The claim tally
    // is the only field allowed to differ, and it is stripped from both sides.
    const verdicts = (report: Awaited<ReturnType<typeof reportFor>>) =>
      JSON.stringify({ ...report, claims: undefined });
    expect(verdicts(claimed)).toBe(verdicts(bare));
    // And the backwards arrow is still not called wrong by anyone.
    expect(claimed.edges.map((finding) => finding.kind)).toEqual(["unsupported-edge"]);
  });
});
