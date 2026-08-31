import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { convertSkeletons } from "../src/engine/convert";
import { emptyBoard } from "../src/engine/board-file";
import { renderBoardToPng } from "../src/engine/render";
import { planDiagramLayout } from "../src/engine/layout";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

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

function pngSize(buffer: Buffer): { width: number; height: number } {
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") throw new Error("Not a PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** A long chain, so the laid-out board is wide enough to hit the cap. */
async function wideBoardFromGraph(count: number) {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: `n${i}`, label: `Node ${i}` }));
  const edges = nodes.slice(1).map((node, i) => ({ from: `n${i}`, to: node.id }));
  const plan = await planDiagramLayout({ nodes, edges }, { x: 0, y: 0 }, "render-wide");
  const elements = await convertSkeletons(plan.skeletons as Record<string, unknown>[]);
  return { ...emptyBoard(), elements };
}

async function boardFromGraph() {
  const plan = await planDiagramLayout(
    {
      nodes: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
      edges: [{ from: "a", to: "b", label: "next" }],
    },
    { x: 0, y: 0 },
    "render-test",
  );
  const elements = await convertSkeletons(plan.skeletons as Record<string, unknown>[]);
  return { ...emptyBoard(), elements };
}

describe.skipIf(!hasChromium)("board rendering", () => {
  it("rasterises a laid-out graph to a real PNG", async () => {
    const { width, height } = await renderBoardToPng(await boardFromGraph(), { scale: 1 });
    expect(width).toBeGreaterThan(100);
    expect(height).toBeGreaterThan(40);
  }, 120_000);

  /**
   * Regression guard. Excalidraw's getDimensions callback sets both the canvas
   * size and the draw scale; returning the unscaled size with scale > 1 draws
   * oversized content into a small canvas and silently crops everything
   * outside the top-left quadrant. Structural assertions cannot see that, but
   * the output dimensions can.
   */
  it("scales the canvas with the scale factor instead of cropping", async () => {
    const board = await boardFromGraph();
    const single = await renderBoardToPng(board, { scale: 1 });
    const double = await renderBoardToPng(board, { scale: 2 });
    expect(double.width).toBe(single.width * 2);
    expect(double.height).toBe(single.height * 2);
  }, 180_000);

  /**
   * The cap. A board too large to draw at the scale asked for is drawn at the
   * largest scale that fits, because the image is returned to a caller that
   * refuses anything over 2000px a side -- so rendering above it produces work,
   * a bill, and no picture.
   */
  it("fits a large board under the display limit instead of rendering something unshowable", async () => {
    const board = await wideBoardFromGraph(40);
    const render = await renderBoardToPng(board, { scale: 3 });

    expect(Math.max(render.width, render.height)).toBeLessThanOrEqual(2000);
    // The point of the test is that this board cannot honour scale 3. If a
    // future layout makes it small enough to fit, the assertion below stops
    // testing anything and the node count needs raising.
    expect(render.requested).toBe(3);
    expect(render.scale).toBeLessThan(3);
  }, 180_000);

  /**
   * The reported size is read from the PNG header rather than computed from the
   * scale, so it cannot drift from the image actually produced. A caller told
   * one size and handed another has been lied to about the single fact this
   * tool exists to give it.
   */
  it("reports the dimensions the image actually has", async () => {
    const render = await renderBoardToPng(await boardFromGraph(), { scale: 1 });
    expect(pngSize(render.png)).toEqual({ width: render.width, height: render.height });
  }, 120_000);

  it("refuses to render an empty board rather than emitting a blank image", async () => {
    await expect(renderBoardToPng(emptyBoard())).rejects.toThrow(/empty board/i);
  });
});
