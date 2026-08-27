/**
 * Drawing a promotion before recording it (#130).
 *
 * A `planned` box turns real while an agent works, and the board only found out
 * when the turn ended. The service can now flip it the moment the code lands --
 * but a promotion deletes the `state` key, and mid-turn the tree is a
 * construction site, so walking through that door early would erase something
 * the author typed on the evidence of a half-written file.
 *
 * The split that makes it safe: the preview writes a stroke, never the record.
 * The test that matters most in this file is the one asserting that -- that a
 * board with previews on it produces the same report as the same board without
 * them. Everything else here is the bookkeeping around it.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace } from "../src/engine/drift";
import { readGraph } from "../src/engine/graph";
import {
  applyPromotions,
  clearLivePromotions,
  reconcileLivePromotions,
  LIVE_PROMOTION_KEY,
} from "../src/engine/promote";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "live-promote-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
});

afterAll(() => {
  // beforeEach makes one per test; the last is the only one left to name.
  if (root) rmSync(root, { recursive: true, force: true });
});

const workspace = () => createWorkspace(root);

/** A board with one `planned` box pointing at `src/thing.ts`. */
async function plannedBoard(): Promise<BoardFile> {
  const result = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "caller", label: "Caller", ref: "src/caller.ts" },
      { id: "thing", label: "Thing", ref: "src/thing.ts", state: "planned" },
    ],
    edges: [],
  });
  return result.board;
}

const report = (board: BoardFile) => checkDrift(board, workspace());

const elementFor = (board: BoardFile, node: string) =>
  board.elements.find((element) => (element.customData as { node?: string })?.node === node)!;

const writeThing = () =>
  writeFileSync(path.join(root, "src/thing.ts"), "export const thing = 1;\n");

describe("reconcileLivePromotions", () => {
  it("does nothing while the code is not there", async () => {
    const board = await plannedBoard();
    const live = reconcileLivePromotions(board, report(board));
    expect(live.changed).toBe(false);
    expect(live.promoted).toEqual([]);
    // The very same object: nothing to write means nothing was rebuilt.
    expect(live.board).toBe(board);
  });

  it("flips the box to look built the moment the file appears", async () => {
    const board = await plannedBoard();
    writeThing();
    const live = reconcileLivePromotions(board, report(board));

    expect(live.promoted.map((promotion) => promotion.node)).toEqual(["thing"]);
    const flipped = elementFor(live.board, "thing");
    expect(flipped.strokeStyle).toBe("solid");
    expect(flipped.customData).toMatchObject({ [LIVE_PROMOTION_KEY]: true });
  });

  it("leaves the record saying planned, which is the whole point", async () => {
    const board = await plannedBoard();
    writeThing();
    const live = reconcileLivePromotions(board, report(board));

    // The box looks built. Nothing has been promoted.
    expect(elementFor(live.board, "thing").customData).toMatchObject({ state: "planned" });
    expect(readGraph(live.board).nodes.find((node) => node.id === "thing")!.state).toBe("planned");
  });

  /**
   * The safety property the whole design rests on.
   *
   * Nothing in the engine reads `strokeStyle` -- the renderer and the promoter
   * write it, and no check consults it. So a board carrying previews has to
   * answer every question exactly as the same board without them does. If this
   * ever fails, the preview has started lying to the checker and the feature is
   * unsafe at any speed.
   */
  it("does not change a single thing the checker says", async () => {
    const board = await plannedBoard();
    writeThing();
    const before = report(board);
    const live = reconcileLivePromotions(board, before);
    expect(live.changed).toBe(true);

    const after = report(live.board);
    expect(after.promotions).toEqual(before.promotions);
    expect(after.workItems).toEqual(before.workItems);
    expect(after.findings).toEqual(before.findings);
    expect(after.clean).toBe(before.clean);
    expect(after.checked).toBe(before.checked);
    expect(after.skippedWhy).toEqual(before.skippedWhy);
  });

  /**
   * Without this the service writes the board on every check, its own watcher
   * sees the write, and the two drive each other in a loop for as long as the
   * page is open.
   */
  it("is idempotent, so a settled preview is never rewritten", async () => {
    const board = await plannedBoard();
    writeThing();
    const once = reconcileLivePromotions(board, report(board));
    const twice = reconcileLivePromotions(once.board, report(once.board));

    expect(twice.changed).toBe(false);
    expect(twice.promoted).toEqual([]);
    expect(twice.board).toBe(once.board);
    // And no version churn: a rewritten element would bump this.
    expect(elementFor(twice.board, "thing").version).toBe(
      elementFor(once.board, "thing").version,
    );
  });

  it("takes the flip back when the code goes away again", async () => {
    const board = await plannedBoard();
    writeThing();
    const flipped = reconcileLivePromotions(board, report(board)).board;
    expect(elementFor(flipped, "thing").strokeStyle).toBe("solid");

    // The agent deletes the file two seconds later.
    unlinkSync(path.join(root, "src/thing.ts"));
    const undone = reconcileLivePromotions(flipped, report(flipped));

    expect(undone.reverted).toEqual(["thing"]);
    const back = elementFor(undone.board, "thing");
    // Dashed is what `planned` draws as, and the record never stopped saying so.
    expect(back.strokeStyle).toBe("dashed");
    expect(back.customData).not.toHaveProperty(LIVE_PROMOTION_KEY);
    expect(back.customData).toMatchObject({ state: "planned" });
  });

  it("previews an arrow the same way it previews a box", async () => {
    const result = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "a", label: "A", ref: "src/a.ts" },
        { id: "b", label: "B", ref: "src/b.ts" },
      ],
      edges: [{ from: "a", to: "b", state: "planned" }],
    });
    const board = result.board;
    writeFileSync(path.join(root, "src/b.ts"), "export const b = 1;\n");
    writeFileSync(path.join(root, "src/a.ts"), "import { b } from './b';\nexport const a = b;\n");

    const live = reconcileLivePromotions(board, checkDrift(board, workspace(), { edges: true }));
    expect(live.promoted.map((promotion) => promotion.node)).toEqual(["a -> b"]);
    const arrow = live.board.elements.find(
      (element) => (element.customData as { edge?: unknown })?.edge !== undefined
        && (element.customData as Record<string, unknown>)[LIVE_PROMOTION_KEY] === true,
    );
    expect(arrow).toBeDefined();
  });
});

describe("clearLivePromotions", () => {
  it("takes every preview off, whatever the evidence currently says", async () => {
    const board = await plannedBoard();
    writeThing();
    const flipped = reconcileLivePromotions(board, report(board)).board;

    // The code is still there -- the preview is currently *correct*. Clearing is
    // not a judgement about it; it is the settling path insisting on asking the
    // question again itself.
    const cleared = clearLivePromotions(flipped);
    expect(cleared.cleared).toBe(1);
    expect(elementFor(cleared.board, "thing").strokeStyle).toBe("dashed");
    expect(elementFor(cleared.board, "thing").customData).not.toHaveProperty(LIVE_PROMOTION_KEY);
  });

  it("is a no-op on a board that was never previewed", async () => {
    const board = await plannedBoard();
    const cleared = clearLivePromotions(board);
    expect(cleared.cleared).toBe(0);
    expect(cleared.board).toBe(board);
  });
});

describe("applyPromotions, on a board carrying previews", () => {
  it("settles the box and takes the marker with the state key", async () => {
    const board = await plannedBoard();
    writeThing();
    const flipped = reconcileLivePromotions(board, report(board)).board;

    const settled = applyPromotions(flipped, report(flipped));
    expect(settled.applied.map((promotion) => promotion.node)).toEqual(["thing"]);
    const element = elementFor(settled.board, "thing");
    expect(element.strokeStyle).toBe("solid");
    // A marker left behind would say the box is still only being previewed by a
    // service that has stopped previewing it.
    expect(element.customData).not.toHaveProperty(LIVE_PROMOTION_KEY);
    expect(element.customData).not.toHaveProperty("state");
  });

  it("leaves a settled box byte-identical to a regenerated one", async () => {
    // The preview must not leave a trace once the promotion is real, or a board
    // that was watched would differ from one that was not.
    const board = await plannedBoard();
    writeThing();
    const viaPreview = applyPromotions(
      reconcileLivePromotions(board, report(board)).board,
      report(board),
    ).board;
    const direct = applyPromotions(board, report(board)).board;

    const previewed = elementFor(viaPreview, "thing");
    const straight = elementFor(direct, "thing");
    expect(previewed.customData).toEqual(straight.customData);
    expect(previewed.strokeStyle).toBe(straight.strokeStyle);
  });
});
