/**
 * The claim slot: a word an arrow can carry, and the one verdict it unlocks.
 *
 * The word `needs` exists, it is written into customData, it is shown on the
 * board, and a word that is not on the whitelist is loud the turn it is written.
 *
 * The last block is what this file is really about, and it has been rewritten
 * once. It used to promise that a claim changed *nothing* -- a board with claims
 * and the same board without checked byte for byte, backwards arrow and all. Now
 * it promises something narrower: a claim changes one verdict, the backwards one,
 * and every arrow that carries no claim is checked exactly as it always was.
 * `tests/engine-needs.test.ts` holds the gates that verdict has to clear.
 */
import { describe, expect, it } from "vitest";

import { bindLooseEdgeLabels, emptyBoard, type BoardFile } from "../src/engine/board-file";
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

describe("typing a claim onto an arrow the engine drew", () => {
  /**
   * The route the issue found closed. A generated edge label used to be a free
   * text element parked at the arrow's midpoint, which looks like a label and is
   * not one: Excalidraw never knew it belonged to the arrow, so double-clicking
   * to type a claim edited the arrow's points instead and unbound it. Bound, the
   * label is the same object a person would have made by hand.
   */
  const labelled = async () => {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b", label: "geometry" }],
    });
    const arrow = board.elements.find((element) => element.type === "arrow")!;
    const label = board.elements.find((element) => element.containerId === arrow.id)!;
    return { board, arrow, label };
  };

  it("binds a generated edge label to its arrow, both ways", async () => {
    const { arrow, label } = await labelled();
    expect(label.text).toBe("geometry");
    expect(label.containerId).toBe(arrow.id);
    expect(arrow.boundElements).toContainEqual({ type: "text", id: label.id });
  });

  it("leaves no free-floating text pretending to be that label", async () => {
    const { board, label } = await labelled();
    const loose = board.elements.filter(
      (element) => element.type === "text" && typeof element.containerId !== "string",
    );
    expect(loose.map((element) => element.text)).not.toContain("geometry");
    expect(loose.some((element) => (element.customData as { edgeLabelFor?: unknown })?.edgeLabelFor))
      .toBe(false);
    expect(label.containerId).toBeTruthy();
  });

  /** Typing into that label is the whole point, so it has to reach the checker. */
  it("reads a claim typed into a generated label", async () => {
    const { board, label } = await labelled();
    const edited = { ...board, elements: board.elements.map(
      (element) => (element.id === label.id ? { ...element, text: "geometry @needs" } : element),
    ) };
    expect(readGraph(edited).edges[0]).toMatchObject({ label: "geometry", claim: "needs" });
  });

  it("refuses a word that is not a claim typed into a generated label", async () => {
    const { board, label } = await labelled();
    const edited = { ...board, elements: board.elements.map(
      (element) => (element.id === label.id ? { ...element, text: "geometry @calls" } : element),
    ) };
    expect(readGraph(edited).edges[0].claimGarbled).toBe("calls");
  });

  /**
   * Boards written before edge labels were bound still carry the free text, and
   * the arrow they name is exactly the arrow somebody is most likely to type on.
   * Whoever touched it last is who it speaks for, so the typed label wins.
   */
  it("prefers a hand-typed label over the generated text on an older board", () => {
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
          customData: { edge: { from: "a", to: "b" } },
        }),
        drawn({
          id: "old",
          type: "text",
          x: 170,
          y: 20,
          width: 60,
          height: 20,
          text: "geometry",
          customData: { edgeLabelFor: "arrow" },
        }),
        drawn({ id: "typed", type: "text", containerId: "arrow", text: "geometry @needs" }),
      ]),
    );
    expect(graph.edges[0]).toMatchObject({ label: "geometry", claim: "needs" });
  });

  /**
   * Reading an older board ties its edge labels on, so the trapdoor closes
   * without anybody having to redraw the diagram first.
   */
  it("binds an older board's loose edge label to its arrow on the way in", () => {
    const bound = bindLooseEdgeLabels([
      drawn({ id: "arrow", type: "arrow", x: 0, y: 0, points: [[0, 0], [190, 0]] }),
      drawn({ id: "old", type: "text", x: 80, y: -10, text: "reads", customData: { edgeLabelFor: "arrow" } }),
    ]);
    expect(bound.find((element) => element.id === "old")).toMatchObject({
      containerId: "arrow",
      textAlign: "center",
      verticalAlign: "middle",
    });
    expect(bound.find((element) => element.id === "arrow")!.boundElements)
      .toEqual([{ type: "text", id: "old" }]);
  });

  it("leaves a board with nothing loose to bind exactly as it was", () => {
    const elements = [
      drawn({ id: "arrow", type: "arrow", points: [[0, 0], [190, 0]] }),
      drawn({ id: "typed", type: "text", containerId: "arrow", text: "reads" }),
      drawn({ id: "note", type: "text", x: 400, text: "a legend" }),
    ];
    expect(bindLooseEdgeLabels(elements)).toBe(elements);
  });

  it("will not bind a second label onto an arrow that already has one", () => {
    const bound = bindLooseEdgeLabels([
      drawn({ id: "arrow", type: "arrow", points: [[0, 0], [190, 0]] }),
      drawn({ id: "typed", type: "text", containerId: "arrow", text: "reads @needs" }),
      drawn({ id: "old", type: "text", x: 80, text: "reads", customData: { edgeLabelFor: "arrow" } }),
    ]);
    expect(bound.find((element) => element.id === "old")!.containerId).toBeUndefined();
  });

  it("will not bind a label onto something that is not an arrow, or is not there", () => {
    const elements = [
      drawn({ id: "box", type: "rectangle", width: 100, height: 60 }),
      drawn({ id: "onBox", type: "text", text: "x", customData: { edgeLabelFor: "box" } }),
      drawn({ id: "orphan", type: "text", text: "y", customData: { edgeLabelFor: "gone" } }),
    ];
    expect(bindLooseEdgeLabels(elements)).toBe(elements);
  });

  it("is just as loud about a bad word on an older board's labelled arrow", () => {
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
          customData: { edge: { from: "a", to: "b" } },
        }),
        drawn({
          id: "old",
          type: "text",
          x: 170,
          y: 20,
          width: 60,
          height: 20,
          text: "reads",
          customData: { edgeLabelFor: "arrow" },
        }),
        drawn({ id: "typed", type: "text", containerId: "arrow", text: "reads @calls" }),
      ]),
    );
    expect(graph.edges[0].claimGarbled).toBe("calls");
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

  it("reads @closed on a box, now that something judges it", () => {
    // This test used to assert the opposite. `closed` was refused out loud for
    // two issues on the rule that a word enters the vocabulary on the day its
    // checker does -- and this is that day, so the refusal is what had to go.
    const board = boardOf([
      drawn({
        id: "r1",
        type: "rectangle",
        width: 200,
        height: 100,
        customData: { node: "engine", ref: "src/engine", claim: { closed: true } },
      }),
    ]);
    const report = checkDrift(board, workspace());
    expect(report.garbledClaims).toEqual([]);
    expect(readGraph(board).nodes[0]!.claim).toEqual({ closed: true, through: [] });
  });

  it("is still loud on a box claiming a word that is not closed", () => {
    const board = boardOf([
      drawn({
        id: "r1",
        type: "rectangle",
        width: 200,
        height: 100,
        customData: { node: "engine", ref: "src/engine", claim: { sealed: true } },
      }),
    ]);
    const report = checkDrift(board, workspace());
    expect(report.garbledClaims).toHaveLength(1);
    expect(report.garbledClaims[0]).toMatchObject({ on: "box", written: "sealed" });
    expect(report.garbledClaims[0].detail).toContain("@closed");
    expect(report.clean).toBe(false);
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

describe("a claim changes exactly one verdict", () => {
  /**
   * What this test held for two issues, and what it holds now.
   *
   * It was written to promise the opposite: a claim changed *nothing*, and the
   * backwards arrow below went unnoticed on purpose because noticing was a later
   * issue's job. That issue has landed. The promise it replaces is narrower and
   * more useful -- a claim changes one verdict and only one, and every other
   * arrow on the board is checked exactly as it was before claims existed.
   *
   * Two boards, identical but for the claims, checked against the same tree.
   * `a -> b` claims `needs` and is drawn backwards: b.ts imports a.ts. That one
   * is now called wrong. `b -> c` claims `needs` too and has no connection in
   * either direction, so it stays amber -- which is the more important half,
   * because an absence is not evidence and never becomes one.
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

  it("calls the backwards arrow wrong, and only counts the other one", async () => {
    const claimed = await reportFor(true);

    expect(claimed.claims.needs).toBe(2);
    expect(claimed.garbledClaims).toEqual([]);

    /*
     * One finding, not two. The second arrow's claim could not be answered
     * either way, and an unanswerable claim is counted rather than accused
     * (#133) -- so the only verdict here is the one with a line of code behind
     * it, which is exactly the arrow a reader should be looking at.
     */
    const byKind = new Map(claimed.edges.map((finding) => [finding.kind, finding]));
    expect([...byKind.keys()]).toEqual(["backwards-edge"]);
    expect(claimed.unconfirmedEdges).toHaveLength(1);

    // The accusation names its evidence, or it is not worth making.
    const wrong = byKind.get("backwards-edge")!;
    expect(wrong.from).toBe("a.ts");
    expect(wrong.to).toBe("b.ts");
    expect(wrong.detail).toContain("b.ts");
    expect(wrong.detail).toContain("line 1");
    expect(claimed.clean).toBe(false);
  });

  it("says nothing at all about an arrow that claims nothing", async () => {
    const bare = await reportFor(false);

    expect(bare.claims.needs).toBe(0);
    /*
     * No finding, and that is the point of both issues at once. `a -> b` is
     * silent because without a claim the check asks "are these connected at
     * all", finds that b imports a, and is satisfied -- the ceiling #113 exists
     * to lift. `b -> c` is silent because the check looked, found nothing, and
     * has nothing to accuse anybody of: an arrow that asserts nothing cannot be
     * contradicted, so it is counted instead (#133).
     */
    expect(bare.edges).toEqual([]);
    expect(bare.clean).toBe(true);
    expect(bare.unconfirmedEdges.map((arrow) => arrow.from)).toEqual(["b"]);
  });
});

/**
 * A claim nobody could answer (#113).
 *
 * Skipping an arrow is ordinarily right and ordinarily quiet: an arrow the
 * checker cannot read is not news. `@needs` is the exception, because writing it
 * is somebody asking a question out loud, and a report that says nothing back
 * reads as "checked, and fine". It was neither.
 *
 * The gate exercised here is the one that found the bug -- ends never snapped to
 * their boxes, which is invisible on screen because the arrow still touches both
 * boxes. Every other gate ahead of `checkNeeds` goes through the same counter.
 */
describe("a needs claim the check never reached", () => {
  const files = {
    "a.ts": "export const a = 1;\n",
    "b.ts": "import { a } from './a';\nexport const b = a;\n",
  };

  /**
   * Two boxes and one hand-drawn arrow between them, bound or not.
   *
   * Unbound is the reported case: `startBinding` and `endBinding` are null, so
   * both ends resolve by proximity, which is an observation about geometry
   * rather than a claim about the design -- and is skipped for exactly that
   * reason. The label is attached the way the app attaches one, through
   * `containerId`, so the claim itself is read either way.
   */
  const boardWith = (bound: boolean, claimed = true) =>
    boardOf([
      drawn({
        id: "box-a", type: "rectangle", x: 0, y: 0, width: 100, height: 60,
        customData: { node: "a", ref: "a.ts" },
      }),
      drawn({
        id: "box-b", type: "rectangle", x: 300, y: 0, width: 100, height: 60,
        customData: { node: "b", ref: "b.ts" },
      }),
      drawn({
        id: "arrow", type: "arrow", x: 100, y: 30, width: 200, height: 0,
        points: [[0, 0], [200, 0]],
        ...(bound ? { startBinding: { elementId: "box-a" }, endBinding: { elementId: "box-b" } } : {}),
      }),
      ...(claimed ? [drawn({ id: "arrow-label", type: "text", containerId: "arrow", text: "@needs" })] : []),
    ]);

  it("counts the claim, and says which gate dropped it", () => {
    const graph = readGraph(boardWith(false));
    // The claim is read: this is a correctly written `@needs`, not a typo.
    expect(graph.edges[0]).toMatchObject({ from: "a", to: "b", claim: "needs", endpoints: "nearest" });

    const report = checkDrift(boardWith(false), fakeWorkspace(files), { edges: true });
    expect(report.claims.needs).toBe(1);
    // Not checked, and the reason names the thing to go and fix.
    expect(report.claims.needsChecked).toBe(0);
    expect(report.claims.needsWithheld).toEqual({ "ends-not-bound": 1 });
  });

  it("still says nothing about the same arrow when it carries no claim", () => {
    const report = checkDrift(boardWith(false, false), fakeWorkspace(files), { edges: true });
    // The same arrow, the same skip, and nothing to report: nobody asked.
    expect(report.claims.needs).toBe(0);
    expect(report.claims.needsWithheld).toEqual({});
    expect(report.edgesSkippedWhy).toEqual({ "ends-not-bound": 1 });
  });

  it("answers the claim once the ends are snapped, and does not count it twice", () => {
    const report = checkDrift(boardWith(true), fakeWorkspace(files), { edges: true });
    expect(report.claims.needs).toBe(1);
    // b.ts imports a.ts, and the arrow says a needs b: backwards, and checked.
    expect(report.claims.needsChecked).toBe(1);
    expect(report.claims.needsWithheld).toEqual({});
    expect(report.edges.map((finding) => finding.kind)).toEqual(["backwards-edge"]);
  });

  /*
   * A claim on an end that stands for many files gets no verdict.
   *
   * `checkNeeds` reads two files and answers about a direction. A directory or
   * a glob is a set, so "this end declares a dependency on that end" has no
   * single pair to ask about -- any-of and all-of are different questions and
   * neither was asked. Withheld is the honest outcome and the report already
   * knows how to explain it, which is what issue #126 asked to be settled.
   *
   * Both shapes here, in one test, because the point is that they agree.
   */
  it("withholds the verdict when an end stands for a set of files", () => {
    const setEnds: Record<string, "directory" | "file"> = {
      "src/sub": "directory",
      "src/b.ts": "file",
    };
    const workspace: Workspace = {
      resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
      stat: (target) => setEnds[target] ?? "missing",
      read: () => "",
      list: () => [],
    };

    for (const [ref, why] of [["src/sub", "directory-ref"], ["src/sub/*.ts", "glob-ref"]] as const) {
      const board = boardOf([
        drawn({
          id: "box-a", type: "rectangle", x: 0, y: 0, width: 100, height: 60,
          customData: { node: "a", ref },
        }),
        drawn({
          id: "box-b", type: "rectangle", x: 300, y: 0, width: 100, height: 60,
          customData: { node: "b", ref: "src/b.ts" },
        }),
        drawn({
          id: "arrow", type: "arrow", x: 100, y: 30, width: 200, height: 0,
          points: [[0, 0], [200, 0]],
          startBinding: { elementId: "box-a" },
          endBinding: { elementId: "box-b" },
        }),
        drawn({ id: "arrow-label", type: "text", containerId: "arrow", text: "@needs" }),
      ]);
      const report = checkDrift(board, workspace, { edges: true });
      // The question was asked, and the report says nobody answered it.
      expect(report.claims.needs, ref).toBe(1);
      expect(report.claims.needsChecked, ref).toBe(0);
      expect(report.claims.needsWithheld, ref).toEqual({ [why]: 1 });
    }
  });
});
