/**
 * Whether a board file can tell that it contradicts itself (#165).
 *
 * The board that prompted this rendered completely blank and every text channel
 * called it healthy: `read_diagram` returned 34 nodes and 44 edges with every
 * label correct, `check_drift` passed clean. One direction of each binding had
 * been stripped and the other had survived, and the read walks the one that
 * survived while the renderer walks the one that died.
 *
 * So the first test here is the one that matters: the graph still reads back
 * whole, and the file is reported damaged anyway. A version of this check that
 * only fired when the read went wrong would be no check at all.
 */
import { describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { bindingDamage, damageSentence } from "../src/engine/damage";
import { readGraph } from "../src/engine/graph";

type Element = Record<string, unknown>;

const box = (id: string, bound: Element[] = []): Element => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 120,
  height: 60,
  version: 1,
  isDeleted: false,
  ...(bound.length ? { boundElements: bound } : {}),
});

const label = (id: string, container: string, text = id): Element => ({
  id,
  type: "text",
  x: 10,
  y: 10,
  width: 80,
  height: 20,
  version: 1,
  isDeleted: false,
  containerId: container,
  text,
});

const arrow = (id: string, from?: string, to?: string): Element => ({
  id,
  type: "arrow",
  x: 0,
  y: 0,
  width: 100,
  height: 0,
  version: 1,
  isDeleted: false,
  points: [[0, 0], [100, 0]],
  startBinding: from ? { elementId: from, focus: 0, gap: 1 } : null,
  endBinding: to ? { elementId: to, focus: 0, gap: 1 } : null,
});

function boardOf(...elements: Element[]): BoardFile {
  return { ...emptyBoard(), elements: elements as never };
}

/** Two labelled boxes and an arrow between them, bound correctly at every end. */
function wholeBoard(): BoardFile {
  return boardOf(
    box("a", [{ type: "text", id: "a-label" }, { type: "arrow", id: "a-b" }]),
    label("a-label", "a", "reader"),
    box("b", [{ type: "text", id: "b-label" }, { type: "arrow", id: "a-b" }]),
    label("b-label", "b", "writer"),
    arrow("a-b", "a", "b"),
  );
}

describe("bindingDamage", () => {
  it("says nothing about a board whose two directions agree", () => {
    expect(bindingDamage(wholeBoard())).toEqual([]);
    expect(damageSentence([])).toBeUndefined();
  });

  it("catches the board that reads perfectly and draws nothing", () => {
    const whole = wholeBoard();
    // The corruption exactly: the direction the renderer needs is gone, the
    // direction the read walks is untouched.
    const wrecked = boardOf(
      ...whole.elements.map((element) => ({ ...element, boundElements: null })),
    );

    const graph = readGraph(wrecked);
    // The half that made this invisible. Both boards read back identically.
    expect(graph.nodes.map((node) => node.label)).toEqual(["reader", "writer"]);
    expect(graph.edges).toHaveLength(1);
    expect(readGraph(whole).nodes.map((node) => node.label)).toEqual(graph.nodes.map((node) => node.label));

    // The half that is new.
    expect(graph.damage.length).toBeGreaterThan(0);
    expect(damageSentence(graph.damage)).toMatch(/This board is damaged/);
  });

  it("names a label its box has stopped listing", () => {
    const faults = bindingDamage(boardOf(box("a"), label("a-label", "a", "reader")));
    expect(faults).toHaveLength(1);
    expect(faults[0].kind).toBe("label-not-listed");
    expect(faults[0].elementId).toBe("a-label");
    expect(faults[0].otherId).toBe("a");
    expect(faults[0].detail).toContain('"reader"');
  });

  it("names a label whose box is not in the file at all", () => {
    const faults = bindingDamage(boardOf(label("orphan", "gone", "reader")));
    expect(faults).toHaveLength(1);
    expect(faults[0].kind).toBe("label-not-listed");
    expect(faults[0].detail).toMatch(/not in this file/);
  });

  it("names a box listing something that is not in the file", () => {
    const faults = bindingDamage(boardOf(box("a", [{ type: "text", id: "never-existed" }])));
    expect(faults).toHaveLength(1);
    expect(faults[0].kind).toBe("bound-element-missing");
    expect(faults[0].otherId).toBe("never-existed");
  });

  it("names an arrow the shape at its end has no record of", () => {
    const faults = bindingDamage(boardOf(
      box("a", [{ type: "arrow", id: "a-b" }]),
      box("b"),
      arrow("a-b", "a", "b"),
    ));
    expect(faults).toHaveLength(1);
    expect(faults[0].kind).toBe("arrow-not-listed");
    expect(faults[0].elementId).toBe("a-b");
    expect(faults[0].otherId).toBe("b");
  });

  /*
   * The whole risk in this check. Inference exists to read boards drawn by hand
   * in excalidraw.com, where a box and the word on top of it are two unrelated
   * elements and an arrow ends near a shape rather than bound to it. None of
   * that is damage, and a check that called it damage would report most
   * hand-drawn boards as corrupt.
   */
  it("says nothing about a hand-drawn board with no bindings on it", () => {
    const faults = bindingDamage(boardOf(
      box("a"),
      { id: "loose", type: "text", x: 20, y: 20, width: 40, height: 20, text: "reader", isDeleted: false },
      box("b"),
      arrow("a-b"),
    ));
    expect(faults).toEqual([]);
  });

  it("says nothing about a board that has been deleted down to nothing", () => {
    // Every ordinary deletion leaves the bindings listed, which is what
    // src/engine/wipe.ts measured on a live board. An empty board is empty, not
    // damaged, and every channel can already say so.
    const gone = boardOf(
      ...wholeBoard().elements.map((element) => ({ ...element, isDeleted: true })),
    );
    expect(bindingDamage(gone)).toEqual([]);
  });

  it("reports in element order, so an unchanged board reports the same thing twice", () => {
    const whole = wholeBoard();
    const wrecked = boardOf(...whole.elements.map((element) => ({ ...element, boundElements: null })));
    expect(bindingDamage(wrecked)).toEqual(bindingDamage(wrecked));
  });

  it("counts each kind separately in the sentence it hands a person", () => {
    const faults = bindingDamage(boardOf(
      box("a"),
      label("a-label", "a", "reader"),
      box("b"),
      arrow("a-b", "a", "b"),
    ));
    const sentence = damageSentence(faults);
    expect(sentence).toMatch(/1 label is not attached to the box that holds it/);
    expect(sentence).toMatch(/2 arrows are not attached to the shapes they point at/);
    // Not a claim about the code, and it says so: this is the distinction the
    // issue asked for and the reason it is not a drift finding.
    expect(sentence).toMatch(/Nothing here is a claim about your code/);
  });
});
