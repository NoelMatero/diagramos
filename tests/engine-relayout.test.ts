/**
 * Re-laying a board out costs a direction, not a graph (#161).
 *
 * The measurement behind that issue is the reason these tests are about
 * *fidelity* rather than about geometry. Trying a layout is one word of new
 * information; it used to cost a full re-send of every node and edge, which is
 * only tolerable if the re-send is lossless. So the bar here is that a board
 * survives a round trip through this operation exactly -- labels with their
 * `@` tokens still in them, claims, colours, states, hand-drawn work -- and
 * that a re-layout with the same direction changes nothing at all.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { connectNodes, createDiagram } from "../src/engine/diagram";
import { readGraph } from "../src/engine/graph";
import { recoverDiagram, relayoutDiagram } from "../src/engine/relayout";
import { installExcalifontMeasurer, uninstallExcalifontMeasurer } from "./helpers/excalifont";

beforeAll(() => installExcalifontMeasurer());
afterAll(() => uninstallExcalifontMeasurer());

/**
 * One board carrying every kind of thing a re-layout could quietly drop: a
 * number in a label, a claim on an arrow, a second anchor, a closed boundary, a
 * planned box, a shape that is not a rectangle, and colour.
 */
async function richBoard(): Promise<BoardFile> {
  const result = await createDiagram(emptyBoard(), {
    title: "request lifecycle",
    complete: "src/engine/",
    nodes: [
      {
        id: "pool",
        label: "thread pool @workers=255",
        ref: "src/engine/",
        refs: ["src/engine/layout.ts"],
        backgroundColor: "#d1f7c4",
        rounded: true,
        closed: { through: ["src/engine/diagram.ts"] },
      },
      { id: "router", label: "router", shape: "diamond", ref: "src/engine/graph.ts", strokeColor: "#1971c2" },
      { id: "store", label: "store", shape: "ellipse", state: "planned", ref: "src/engine/store.ts" },
      { id: "browser", label: "browser", state: "external" },
    ],
    edges: [
      { from: "pool", to: "router", label: "dispatch", claim: "needs", strokeColor: "#1971c2" },
      { from: "router", to: "store", label: "writes", state: "planned", via: ["handle", "emit"] },
      { from: "router", to: "browser" },
    ],
  });
  return result.board;
}

describe("re-laying a board out", () => {
  it("changes nothing when the direction is the one it already had", async () => {
    const before = (await relayoutDiagram(await richBoard(), { direction: "DOWN" })).board;
    const after = await relayoutDiagram(before);

    expect(after.direction).toBe("DOWN");
    expect(after.wasDirection).toBe("DOWN");
    // Byte-identical, which is the property every writer in this codebase is
    // held to: a no-op must not show up in git.
    expect(JSON.stringify(after.board)).toEqual(JSON.stringify(before));
  }, 60_000);

  it("keeps every claim, colour and label when the flow changes", async () => {
    const before = await richBoard();
    const after = await relayoutDiagram(before, { direction: "DOWN" });

    const was = readGraph(before);
    const now = readGraph(after.board);

    // Labels are compared through readGraph, so the `@workers=255` in the box
    // label has to have survived as a *claim* rather than as leftover prose.
    expect(now.nodes).toEqual(was.nodes.map((node) => ({
      ...node,
      x: expect.any(Number),
      y: expect.any(Number),
    })));
    expect(now.edges).toEqual(was.edges);
    expect(now.title).toBe("request lifecycle");
    expect(now.complete).toEqual(was.complete);
    expect(now.direction).toBe("DOWN");
    expect(after.remembered).toBe(true);
  }, 60_000);

  it("actually moves the boxes", async () => {
    const before = await richBoard();
    const after = await relayoutDiagram(before, { direction: "DOWN" });

    const positions = (board: BoardFile) =>
      readGraph(board).nodes.map((node) => `${node.id}:${node.x},${node.y}`).join(" ");
    expect(positions(after.board)).not.toEqual(positions(before));
  }, 60_000);

  it("keeps the element ids a caller already holds", async () => {
    const before = await richBoard();
    const after = await relayoutDiagram(before, { direction: "DOWN" });

    const ids = (board: BoardFile) => readGraph(board).nodes.map((node) => node.elementId);
    expect(ids(after.board)).toEqual(ids(before));
  }, 60_000);

  it("does not fold an arrow's claim into its label a second time", async () => {
    let board = await richBoard();
    for (let pass = 0; pass < 3; pass++) {
      board = (await relayoutDiagram(board, { direction: pass % 2 ? "RIGHT" : "DOWN" })).board;
    }
    const label = board.elements.find(
      (element) => element.type === "text" && String(element.text ?? "").includes("dispatch"),
    );
    expect(String(label?.text)).toBe("dispatch @needs");
  }, 60_000);

  it("never touches hand-drawn work", async () => {
    const drawn = { id: "sketch", type: "rectangle", x: 5000, y: 5000, width: 100, height: 60 };
    const board = await richBoard();
    const withSketch: BoardFile = { ...board, elements: [...board.elements, drawn] };

    const after = await relayoutDiagram(withSketch, { direction: "DOWN" });
    expect(after.board.elements.find((element) => element.id === "sketch")).toEqual(drawn);
    expect(after.keptHandDrawn).toBe(1);
  }, 60_000);

  it("remembers the flow, so the next plain redraw does not revert it", async () => {
    const turned = (await relayoutDiagram(await richBoard(), { direction: "DOWN" })).board;
    const recovered = recoverDiagram(turned, "request-lifecycle");

    // A redraw that says nothing about direction: the case an agent hits every
    // time it regenerates a board it did not lay out itself.
    const redrawn = await createDiagram(turned, { ...recovered.params });
    expect(redrawn.direction).toBe("DOWN");
    expect(readGraph(redrawn.board).direction).toBe("DOWN");
  }, 60_000);

  /**
   * Removing a diagram sweeps the connectors bound to it, which is right for a
   * delete and would be silent theft here: a line somebody drew with
   * connect_nodes vanished, with its label, on a call whose whole promise is
   * that it only moves things.
   */
  it("keeps an arrow drawn with connect_nodes, and re-routes it", async () => {
    const made = await createDiagram(emptyBoard(), {
      title: "joined",
      nodes: [{ id: "a", label: "a" }, { id: "b", label: "b" }, { id: "c", label: "c" }],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
    });
    const joined = await connectNodes(made.board, [
      { from: "a", to: "c", label: "by hand", claim: "needs" },
    ]);

    const after = await relayoutDiagram(joined.board, { direction: "DOWN" });
    expect(after.connectors).toBe(1);

    const edge = readGraph(after.board).edges.find((candidate) => candidate.to === "c" && candidate.from === "a")!;
    expect(edge.label).toBe("by hand");
    expect(edge.claim).toBe("needs");

    // Re-routed rather than left pointing at where the boxes used to be.
    const arrowOf = (board: BoardFile) => {
      const arrow = board.elements.find((element) => element.id === "connect-a-c")!;
      return JSON.stringify([arrow.x, arrow.y, arrow.points]);
    };
    expect(arrowOf(after.board)).not.toEqual(arrowOf(joined.board));
  }, 60_000);

  /**
   * This repository's own `architecture` board is laid out DOWN and records
   * nothing, because it was drawn before the flow was written down. Reading
   * that silence as the default would report "was RIGHT" about a board anybody
   * can see is not, and then rearrange it on a call that only asked to re-run.
   */
  it("refuses to guess a flow a board never recorded", async () => {
    await expect(relayoutDiagram(await richBoard())).rejects.toThrow(/name a direction/);
  }, 60_000);

  it("names the choice instead of guessing when a board holds two diagrams", async () => {
    const first = await createDiagram(emptyBoard(), {
      title: "boot", nodes: [{ id: "a", label: "a" }], edges: [],
    });
    const second = await createDiagram(first.board, {
      title: "serve", nodes: [{ id: "b", label: "b" }], edges: [], append: true,
    });

    await expect(relayoutDiagram(second.board)).rejects.toThrow(/holds 2 diagrams/);
    const picked = await relayoutDiagram(second.board, { name: "serve", direction: "DOWN" });
    expect(picked.name).toBe("serve");
  }, 60_000);

  it("says so rather than pretending when there is nothing it drew", async () => {
    const board: BoardFile = {
      ...emptyBoard(),
      elements: [{ id: "sketch", type: "rectangle", x: 0, y: 0, width: 10, height: 10 }],
    };
    await expect(relayoutDiagram(board)).rejects.toThrow(/hand/i);
  });
});
