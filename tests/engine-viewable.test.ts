/**
 * A board says whether it can be looked at, before anybody pays for the picture
 * (#183).
 *
 * The session that provoked the issue drew two boards of a 1,647-line project
 * for $1.94: two full graph payloads, one re-layout and three renders, each call
 * trying to find out whether the last one produced something readable. So the
 * bar here is not that a number is computed -- it is that the number arrives at
 * draw time, that it is the *right* number, and that what it says next is a
 * single call rather than "consider splitting".
 */
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { relayoutDiagram } from "../src/engine/relayout";
import {
  boardExtent,
  LEGIBLE_SIDE,
  MAX_RENDER_SIDE,
  RENDER_PADDING,
  viewability,
} from "../src/engine/viewable";
import { renderBoardToPng } from "../src/engine/render";
import { installExcalifontMeasurer, uninstallExcalifontMeasurer } from "./helpers/excalifont";

/** Chromium is a local dev dependency, not something CI necessarily has. */
async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const hasChromium = await chromiumAvailable();

beforeAll(() => installExcalifontMeasurer());
afterAll(() => uninstallExcalifontMeasurer());

/**
 * A chain, which ELK lays out as one long line in whichever flow it is given.
 *
 * Labels this long on purpose: a box is much wider than it is tall, so the same
 * chain of them is a ribbon laid out RIGHT and a readable column laid out DOWN.
 * That is the shape the issue was about, and it is what makes the flow the
 * answer rather than a coin toss.
 */
function chain(count: number, label = "authentication middleware layer") {
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `n${index}`,
    label: `${label} ${index}`,
  }));
  const edges = nodes.slice(1).map((node, index) => ({ from: `n${index}`, to: node.id }));
  return { nodes, edges };
}

describe("what makes a board unviewable", () => {
  it("reports the scale a render will be forced to, and what the labels become", () => {
    const view = viewability({ width: MAX_RENDER_SIDE * 5, height: 1000 });
    expect(view.scale).toBe(0.2);
    // 20px type at a fifth of its size.
    expect(view.labelPx).toBe(4);
    expect(view.verdict).toBe("unviewable");
  });

  it("leaves a board that fits at full size alone", () => {
    const view = viewability({ width: 1200, height: 800 });
    expect(view.scale).toBe(1);
    expect(view.labelPx).toBe(20);
    expect(view.verdict).toBe("legible");
  });

  /*
   * The measurement that decided the shape of this module, kept as a test so it
   * cannot be quietly replaced by the obvious-but-wrong signal.
   *
   * Both boards are real ones in this repository. `demo-124` is a 9.3:1 ribbon
   * and perfectly readable, because it is 1,188px wide and nothing is shrunk.
   * `claim-path` is a tidy 1:1 square and unreadable, because it is 4,262px on
   * a side. Aspect ratio predicts neither; label size predicts both.
   */
  it("judges by label size rather than by aspect ratio", () => {
    const ribbon = viewability({ width: 1188, height: 128 });
    const square = viewability({ width: 4262, height: 4223 });
    expect(ribbon.ratio).toBeGreaterThan(square.ratio);
    expect(ribbon.verdict).toBe("legible");
    expect(square.verdict).toBe("cramped");
  });

  /*
   * The bug this module shipped with for an hour, kept as a test.
   *
   * Excalidraw puts an arrow's `x, y` at its first point and lists the rest
   * relative to it, so a route that doubles back has negative offsets and
   * `x + width` reports an edge past its own. On a 46-node board that read
   * 11,416px instead of 7,160px -- and a board wrong by 60% in the direction of
   * "too big" tells the caller to go and fix a layout that was fine. A false red
   * costs more than the render it saves.
   */
  it("measures an arrow through its points, not through x plus width", () => {
    const doublesBack = {
      id: "arrow",
      type: "arrow",
      x: 500,
      y: 0,
      width: 400,
      height: 0,
      // Right 100, then back past where it started.
      points: [[0, 0], [100, 0], [-400, 0]],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extent = boardExtent({ elements: [doublesBack] } as any);
    // 100 to 600 on the x axis: 500 wide, not 900.
    expect(extent.width).toBe(500 + RENDER_PADDING * 2);
  });

  it("counts the padding the renderer adds, so the size matches the image", () => {
    const board = { ...emptyBoard(), elements: [{ id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 50 }] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extent = boardExtent(board as any);
    expect(extent.width).toBeGreaterThan(100);
    expect(extent.height).toBeGreaterThan(50);
  });
});

describe("what create_diagram says about the board it just drew", () => {
  it("says nothing extra about a board that reads, and does not lay it out twice", async () => {
    const result = await createDiagram(emptyBoard(), { title: "Small", ...chain(3, "Step") });
    expect(result.viewable.verdict).toBe("legible");
    expect(result.viewable.note).toBeUndefined();
    // The second layout pass is the only cost in here, and a healthy board
    // must not pay it.
    expect(result.viewable.alternative).toBeUndefined();
  });

  it("names the flow that works, measured rather than suggested", async () => {
    const result = await createDiagram(emptyBoard(), {
      title: "Long chain",
      ...chain(12),
      layout: { direction: "RIGHT" },
    });
    expect(result.viewable.verdict).not.toBe("legible");
    expect(result.viewable.alternative?.direction).toBe("DOWN");
    expect(result.viewable.alternative?.verdict).toBe("legible");
    expect(result.viewable.note).toContain("relayout_diagram");
    expect(result.viewable.note).toContain("DOWN");
  });

  it("tells the truth about the size instead of the ratio", async () => {
    const result = await createDiagram(emptyBoard(), {
      title: "Long chain",
      ...chain(14),
      layout: { direction: "RIGHT" },
    });
    expect(result.viewable.verdict).toBe("unviewable");
    expect(result.viewable.width).toBeGreaterThan(LEGIBLE_SIDE);
    expect(result.viewable.labelPx).toBeLessThan(8);
    expect(result.viewable.note).toContain(`${result.viewable.width}x${result.viewable.height}`);
  });

  /*
   * The advice a caller can act on when there is no flow left to try. "Split it"
   * on its own is what the last session had to work out for itself across three
   * renders; the count comes from the same arithmetic the verdict does.
   */
  it("asks for a split, with a count, when neither flow fits", async () => {
    const result = await createDiagram(emptyBoard(), {
      title: "Very long chain",
      ...chain(60),
      layout: { direction: "RIGHT" },
    });
    expect(result.viewable.verdict).toBe("unviewable");
    expect(result.viewable.alternative?.verdict).not.toBe("legible");
    expect(result.viewable.note).toMatch(/split/i);
    expect(result.viewable.note).toMatch(/about \d+ boards/);
  });
});

/*
 * The half of #183 the reporting cannot fix.
 *
 * Being told "RIGHT gives 4px labels, DOWN reads" still costs a relayout and a
 * render to act on. On a board where nobody has expressed a preference there is
 * nothing to override, so the flow that reads is simply the one that gets drawn.
 */
describe("choosing the flow when nobody has", () => {
  it("draws the readable flow on a first draw instead of the wide one", async () => {
    const result = await createDiagram(emptyBoard(), { title: "Chain", ...chain(14) });
    expect(result.direction).toBe("DOWN");
    expect(result.viewable.verdict).toBe("legible");
    // And it shows its work: the rejected flow, with the numbers that rejected
    // it, because a picture in a shape nobody asked for otherwise looks like a
    // bug.
    expect(result.viewable.instead?.direction).toBe("RIGHT");
    expect(result.viewable.instead?.verdict).toBe("unviewable");
    expect(result.viewable.note).toContain("RIGHT");
  });

  it("records the flow it chose, so a redraw does not decide again", async () => {
    const first = await createDiagram(emptyBoard(), { title: "Chain", ...chain(14) });
    const again = await createDiagram(first.board, { title: "Chain", ...chain(14) });
    expect(again.direction).toBe("DOWN");
    // Nothing was chosen the second time: it was inherited.
    expect(again.viewable.instead).toBeUndefined();
  });

  it("obeys a flow it was given, even one that renders badly", async () => {
    const result = await createDiagram(emptyBoard(), {
      title: "Chain",
      ...chain(14),
      layout: { direction: "RIGHT" },
    });
    expect(result.direction).toBe("RIGHT");
    expect(result.viewable.verdict).toBe("unviewable");
    // Told, not overridden.
    expect(result.viewable.instead).toBeUndefined();
    expect(result.viewable.note).toContain("relayout_diagram");
  });

  /*
   * A board with a diagram already on it belongs to whoever drew it. RIGHT is
   * never written down -- it is the default -- so the only safe reading of a
   * board that records no flow but holds a diagram is that its flow is somebody
   * else's decision.
   */
  it("does not rearrange a board that already holds a diagram", async () => {
    const first = await createDiagram(emptyBoard(), {
      title: "Chain",
      ...chain(14),
      layout: { direction: "RIGHT" },
    });
    const again = await createDiagram(first.board, { title: "Chain", ...chain(14) });
    expect(again.direction).toBe("RIGHT");
    expect(again.viewable.instead).toBeUndefined();
  });

  it("leaves a board that already reads exactly as it was", async () => {
    const result = await createDiagram(emptyBoard(), { title: "Small", ...chain(3, "Step") });
    expect(result.direction).toBe("RIGHT");
    expect(result.viewable.instead).toBeUndefined();
    expect(result.viewable.note).toBeUndefined();
  });
});

describe("what relayout_diagram says", () => {
  it("answers whether the flow it just tried helped", async () => {
    const drawn = await createDiagram(emptyBoard(), {
      title: "Long chain",
      ...chain(12),
      layout: { direction: "RIGHT" },
    });
    expect(drawn.viewable.verdict).not.toBe("legible");

    const turned = await relayoutDiagram(drawn.board, { direction: "DOWN" });
    expect(turned.viewable.verdict).toBe("legible");
    expect(turned.viewable.note).toBeUndefined();
  });
});

/*
 * The one assertion that keeps this module honest.
 *
 * Everything above predicts what a render will do, and a prediction nobody
 * checks against the renderer is a number that drifts until it is telling
 * callers to fix boards that were fine. So this draws two boards -- one that
 * fits and one that does not -- and asks Chromium what scale it actually used.
 */
describe.skipIf(!hasChromium)("the prediction against the renderer", () => {
  it("predicts the scale the renderer really picks", async () => {
    for (const size of [3, 14]) {
      const drawn = await createDiagram(emptyBoard(), {
        title: "Chain",
        ...chain(size),
        layout: { direction: "RIGHT" },
      });
      const predicted = viewability(boardExtent(drawn.board));
      const rendered = await renderBoardToPng(drawn.board, { scale: 1 });
      expect(rendered.scale).toBeCloseTo(predicted.scale, 2);
      // And the pixels. The slack is the rounding on the reported scale, which
      // is given to two places; the underlying figures agree exactly.
      expect(Math.abs(rendered.width - predicted.width * predicted.scale)).toBeLessThan(12);
      expect(Math.abs(rendered.height - predicted.height * predicted.scale)).toBeLessThan(12);
      expect(Math.max(rendered.width, rendered.height)).toBeLessThanOrEqual(MAX_RENDER_SIDE);
    }
  }, 180_000);
});
