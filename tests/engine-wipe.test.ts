/**
 * The rule that a save may not tear a label off its box (#164).
 *
 * Every shape here was measured in a browser against a live board, because the
 * whole question is which of them a person can produce on purpose. An undo on a
 * freshly opened board tombstoned every element *and* stripped every container's
 * `boundElements`; every ordinary deletion left the bindings exactly where they
 * were. That difference is the rule, and these tests are what stop a later
 * change from quietly widening it back into "the board got smaller".
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

const tombstone = (element: Element): Element => ({ ...element, isDeleted: true });

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

  /*
   * The gestures below are the measured output of real interactions. They are
   * the point of this rule: all of them must go through.
   */

  it("lets you delete one labelled box", () => {
    // Measured: box and label tombstoned, the binding left listed.
    const deleted = boardOf(
      tombstone(box("a", "a-label")),
      tombstone(label("a-label", "a")),
      box("b", "b-label"),
      label("b-label", "b"),
    );
    expect(wipeRefusal(drawn, deleted)).toBeUndefined();
  });

  it("lets you select everything and delete it", () => {
    // Measured: every element tombstoned, every binding still listed. This is
    // an obvious thing to do on a board and refusing it was the wrong trade.
    const cleared: BoardFile = {
      ...drawn,
      elements: drawn.elements.map((element) => tombstone(element as Element)) as never,
    };
    expect(wipeRefusal(drawn, cleared)).toBeUndefined();
  });

  it("lets you clear a label off a box that stays", () => {
    // Measured: the label is tombstoned, the box is still live, and the box
    // drops it from `boundElements`. The only legitimate way a binding goes.
    const unlabelled = boardOf(
      { ...box("a"), boundElements: [] },
      tombstone(label("a-label", "a")),
      box("b", "b-label"),
      label("b-label", "b"),
    );
    expect(wipeRefusal(drawn, unlabelled)).toBeUndefined();
  });

  /* And the one shape nothing legitimate produces. */

  it("refuses the undo that tombstoned everything and stripped every binding", () => {
    // Measured: the #164 wreck. Boxes keep their ids, lose their
    // `boundElements`, and go down with the labels that still name them.
    const wrecked: BoardFile = {
      ...drawn,
      elements: drawn.elements.map((element) => {
        const { boundElements: _stripped, ...rest } = element as Element;
        return { ...rest, isDeleted: true };
      }) as never,
    };
    const refusal = wipeRefusal(drawn, wrecked);
    expect(refusal).toMatch(/torn 2 labels off the boxes that hold them/);
  });

  it("refuses a save that orphans a live label from a live box", () => {
    const orphaned = boardOf(
      { ...box("a", "a-label"), boundElements: [] },
      label("a-label", "a"),
      box("b", "b-label"),
      label("b-label", "b"),
    );
    expect(wipeRefusal(drawn, orphaned)).toMatch(/torn 1 label off the box that holds it/);
  });

  it("does not hold a board hostage over damage it arrived with", () => {
    // A file that is already broken must stay editable, or the only way out of
    // a corrupted board is to hand-edit the JSON.
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

  it("says nothing about an empty board, or one that stays empty", () => {
    expect(wipeRefusal(emptyBoard(), emptyBoard())).toBeUndefined();
  });
});
