/**
 * Correcting a box's anchor must not quietly unsay everything else on it (#162).
 *
 * `create_diagram`'s description tells agents that regenerating is how you
 * update a board, and they believe it: four refs changed arrive as a full
 * rewrite of forty-six boxes. Pointing that advice at `edit_diagram` instead is
 * only honest if `edit_diagram` can carry a ref change without losing anything,
 * and measured on a box carrying a state, a second anchor and a closed
 * boundary, it could not: the patch replaced `customData` wholesale, so the box
 * came back `built` with one anchor and no boundary, still drawn dashed.
 *
 * That is worse than the expensive redraw it was meant to replace. A dashed box
 * reading `built` is a picture disagreeing with its own record, which is the
 * exact rot this tool exists to catch, arriving through its own edit path.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard } from "../src/engine/board-file";
import { applyEdits, createDiagram } from "../src/engine/diagram";
import { readGraph } from "../src/engine/graph";
import { installExcalifontMeasurer, uninstallExcalifontMeasurer } from "./helpers/excalifont";

beforeAll(() => installExcalifontMeasurer());
afterAll(() => uninstallExcalifontMeasurer());

async function board() {
  const result = await createDiagram(emptyBoard(), {
    title: "anchors",
    nodes: [
      {
        id: "core",
        label: "core",
        ref: "src/engine/",
        refs: ["src/engine/layout.ts"],
        state: "planned",
        closed: { through: ["src/engine/diagram.ts"] },
      },
      { id: "ui", label: "ui", ref: "src/viewer/" },
    ],
    edges: [{ from: "core", to: "ui" }],
  });
  return result.board;
}

const nodeOf = (board: Parameters<typeof readGraph>[0], id: string) =>
  readGraph(board).nodes.find((node) => node.id === id)!;

const elementOf = (board: Parameters<typeof readGraph>[0], id: string) =>
  board.elements.find((element) => (element.customData as { node?: string } | undefined)?.node === id)!;

describe("changing an anchor with an edit", () => {
  it("re-anchors a box without unsaying anything else on it", async () => {
    const before = await board();
    const after = applyEdits(before, [{ id: "core", ref: "src/engine/layout.ts" }]).board;

    const node = nodeOf(after, "core");
    expect(node.ref).toBe("src/engine/layout.ts");
    expect(node.refs).toEqual(["src/engine/layout.ts"]);
    expect(node.state).toBe("planned");
    expect(node.claim).toEqual({ closed: true, through: ["src/engine/diagram.ts"] });
  }, 60_000);

  it("keeps the element inside the diagram that drew it", async () => {
    const before = await board();
    const after = applyEdits(before, [{ id: "core", ref: "src/engine/layout.ts" }]).board;

    const custom = elementOf(after, "core").customData as Record<string, unknown>;
    expect(custom.origin).toBe("diagram");
    expect(custom.diagram).toBe("anchors");
  }, 60_000);

  it("redraws the stroke when a state changes, so the picture cannot disagree", async () => {
    const before = await board();
    expect(elementOf(before, "core").strokeStyle).toBe("dashed");

    const built = applyEdits(before, [{ id: "core", state: "built" }]).board;
    expect(nodeOf(built, "core").state).toBe("built");
    // Exactly what a redraw writes for a built box, so the two paths cannot
    // produce boards that differ only in which tool touched them last.
    expect(elementOf(built, "core").strokeStyle).toBe("solid");

    const external = applyEdits(built, [{ id: "core", state: "external" }]).board;
    expect(elementOf(external, "core").strokeStyle).toBe("dotted");
  }, 60_000);

  it("clears an anchor when told to, rather than only ever adding one", async () => {
    const before = await board();
    const after = applyEdits(before, [{ id: "core", ref: "", refs: [], closed: null }]).board;

    const node = nodeOf(after, "core");
    expect(node.ref).toBeUndefined();
    expect(node.refs).toBeUndefined();
    expect(node.claim).toBeUndefined();
  }, 60_000);

  it("merges a raw customData patch instead of replacing the record", async () => {
    const before = await board();
    // The shape the old guidance taught, and the one that lost three fields.
    const after = applyEdits(before, [
      { id: "core", customData: { ref: "src/engine/layout.ts" } },
    ]).board;

    const node = nodeOf(after, "core");
    expect(node.ref).toBe("src/engine/layout.ts");
    expect(node.state).toBe("planned");
    expect(node.refs).toEqual(["src/engine/layout.ts"]);
  }, 60_000);

  it("still patches geometry and colour without touching the record", async () => {
    const before = await board();
    const after = applyEdits(before, [{ id: "core", backgroundColor: "#ffec99" }]).board;

    expect(elementOf(after, "core").backgroundColor).toBe("#ffec99");
    expect(nodeOf(after, "core")).toEqual(nodeOf(before, "core"));
  }, 60_000);

  it("changes an arrow's state and its stroke together", async () => {
    const before = await board();
    const arrow = readGraph(before).edges[0]!;
    const after = applyEdits(before, [{ id: arrow.elementId, state: "planned" }]).board;

    expect(readGraph(after).edges[0]!.state).toBe("planned");
    expect(after.elements.find((element) => element.id === arrow.elementId)!.strokeStyle).toBe("dashed");
  }, 60_000);
});
