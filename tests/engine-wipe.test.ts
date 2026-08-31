/**
 * The rule that a save may not empty the board it lands on (#164).
 *
 * The shapes here are the ones measured off a live board while reproducing it:
 * an undo that inverted the whole diagram tombstoned every element *and*
 * stripped every container's `boundElements`, while a hand-made
 * select-all-and-delete tombstoned every element and left the bindings alone.
 * Both must be refused; only the first is corruption, and the tests say which
 * is which so a later change cannot quietly stop telling them apart.
 */
import { describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { wipeRefusal } from "../src/engine/wipe";

type Element = Record<string, unknown>;

const box = (id: string, label?: string): Element => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 120,
  height: 60,
  version: 1,
  isDeleted: false,
  ...(label ? { boundElements: [{ type: "text", id: label }] } : {}),
});

const label = (id: string, container: string): Element => ({
  id,
  type: "text",
  x: 10,
  y: 10,
  width: 80,
  height: 20,
  version: 1,
  isDeleted: false,
  containerId: container,
  text: id,
});

function boardOf(...elements: Element[]): BoardFile {
  return { ...emptyBoard(), elements: elements as never };
}

/** Two labelled boxes: the smallest board with bindings in both directions. */
const drawn = boardOf(
  box("a", "a-label"),
  label("a-label", "a"),
  box("b", "b-label"),
  label("b-label", "b"),
);

const tombstoned = (board: BoardFile): BoardFile => ({
  ...board,
  elements: board.elements.map((element) => ({ ...element, isDeleted: true })) as never,
});

describe("wipeRefusal", () => {
  it("says nothing about an ordinary edit", () => {
    const moved = boardOf(
      { ...box("a", "a-label"), x: 40 },
      label("a-label", "a"),
      box("b", "b-label"),
      label("b-label", "b"),
    );
    expect(wipeRefusal(drawn, moved)).toBeUndefined();
  });

  it("says nothing about deleting some of the board", () => {
    const half = boardOf(
      box("a", "a-label"),
      label("a-label", "a"),
      { ...box("b", "b-label"), isDeleted: true },
      { ...label("b-label", "b"), isDeleted: true },
    );
    expect(wipeRefusal(drawn, half)).toBeUndefined();
  });

  it("refuses the undo that tombstoned every element and stripped every binding", () => {
    // The measured shape of #164: containers keep their ids and lose their
    // `boundElements`, while the labels still name them.
    const wiped: BoardFile = {
      ...drawn,
      elements: drawn.elements.map((element) => {
        const { boundElements: _dropped, ...rest } = element as Element;
        return { ...rest, isDeleted: true };
      }) as never,
    };
    expect(wipeRefusal(drawn, wiped)).toMatch(/emptied a board with 4 elements on it/);
  });

  it("refuses a save that empties the board even with its bindings intact", () => {
    // A hand-made select-all-and-delete looks like this. It is the one thing
    // refused that somebody could have meant, so the sentence names the way to
    // do it on purpose.
    const refusal = wipeRefusal(drawn, tombstoned(drawn));
    expect(refusal).toMatch(/would have emptied a board/);
    expect(refusal).toMatch(/delete_diagram/);
  });

  it("says nothing when the board was already empty", () => {
    expect(wipeRefusal(tombstoned(drawn), tombstoned(drawn))).toBeUndefined();
    expect(wipeRefusal(emptyBoard(), emptyBoard())).toBeUndefined();
  });

  it("refuses a save that orphans a live label from its box", () => {
    const orphaned = boardOf(
      { ...box("a", "a-label"), boundElements: [] },
      label("a-label", "a"),
      box("b", "b-label"),
      label("b-label", "b"),
    );
    const refusal = wipeRefusal(drawn, orphaned);
    expect(refusal).toMatch(/1 label attached to a box that no longer lists them/);
  });

  it("counts every label a save orphans, not just the first", () => {
    const orphaned = boardOf(
      { ...box("a", "a-label"), boundElements: [] },
      label("a-label", "a"),
      { ...box("b", "b-label"), boundElements: [] },
      label("b-label", "b"),
    );
    expect(wipeRefusal(drawn, orphaned)).toMatch(/2 labels/);
  });

  it("does not hold a board hostage over damage it arrived with", () => {
    // A file that is already broken must stay editable, or the one way out of a
    // corrupted board would be to hand-edit the JSON.
    const broken = boardOf(
      { ...box("a", "a-label"), boundElements: [] },
      label("a-label", "a"),
      box("b", "b-label"),
      label("b-label", "b"),
    );
    const movedAnyway = boardOf(
      { ...box("a", "a-label"), boundElements: [], x: 40 },
      label("a-label", "a"),
      box("b", "b-label"),
      label("b-label", "b"),
    );
    expect(wipeRefusal(broken, movedAnyway)).toBeUndefined();
  });

  it("reads a deleted label dropped from its box as a deletion, not damage", () => {
    // Removing a label is an ordinary thing to do, and it leaves exactly the
    // asymmetry this rule is about -- on a tombstoned element, which is what
    // tells the two apart.
    const removed = boardOf(
      { ...box("a", "a-label"), boundElements: [] },
      { ...label("a-label", "a"), isDeleted: true },
      box("b", "b-label"),
      label("b-label", "b"),
    );
    expect(wipeRefusal(drawn, removed)).toBeUndefined();
  });
});
