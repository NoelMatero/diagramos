/**
 * Whether a board that has just been laid out can actually be looked at.
 *
 * ## Why this exists
 *
 * Every number here was already computed and then thrown away. `create_diagram`
 * runs the layout, so it knows how big the result is; `render_diagram` divides
 * that into the largest image a model client will accept, so it knows the scale.
 * Neither said either, which left one way to find out whether a board was
 * viewable: draw it, render it, and squint (#183). Two boards of a 1,647-line
 * project cost $1.94 that way -- two full graph payloads, one relayout and three
 * renders, every call spent discovering something the first one could have said.
 *
 * ## Why not the aspect ratio
 *
 * The obvious signal is the shape: a 19:1 ribbon is clearly wrong. Measured
 * across this repo's 21 boards, the shape is not the thing. `demo-124` is 9.3:1
 * and renders perfectly -- it is 1,188 px wide, so nothing is shrunk and its
 * labels come out full size. `claim-path` is a tidy 1:1 and is unreadable, at
 * 4,262 px square that renders at 0.47 with 9 px text. Ratio predicts neither.
 *
 * What predicts it is one number: **how big the labels end up**. A board is
 * shrunk by however much it overflows `MAX_RENDER_SIDE`, and every label shrinks
 * with it, so 20 px type at scale 0.21 arrives as 4 px. That is the measure this
 * module reports, and the thing it says out loud.
 */
import type { BoardFile } from "./board-file";
import type { ExcalidrawElement } from "./normalize";
import {
  NODE_FONT_SIZE,
  planBounds,
  planDiagramLayout,
  translatePlan,
  type DiagramPlan,
  type LayoutParams,
} from "./layout";
import type { LayoutDirection } from "./graph";

/**
 * The largest side a rendered board may have.
 *
 * Not a rendering limit -- Excalidraw will happily draw larger -- but the point
 * past which the image cannot be shown to the caller that asked for it: a model
 * client refuses an image over 2000 px on a side. Lives here rather than in
 * `render.ts` because the draw-time verdict and the render both have to divide
 * by the same number, or the warning describes an image nobody will get.
 */
export const MAX_RENDER_SIDE = 2000;

/** The export padding `render_diagram` adds, counted so the sizes agree. */
export const RENDER_PADDING = 24;

/**
 * Label sizes, in rendered pixels, that separate the three verdicts.
 *
 * Excalifont is a handwriting face, so it goes illegible earlier than a screen
 * font would. Checked against every board in this repository: at 15 px
 * (`drift-check`) the labels read cleanly, at 10 px (`architecture`) they are
 * work, and at 4 px (`auth`, `ims`) they are grey smears. The boundaries sit
 * where the reading changes.
 */
const LEGIBLE_LABEL_PX = 11;
const CRAMPED_LABEL_PX = 7;

export type ViewVerdict = "legible" | "cramped" | "unviewable";

/** Worse to better, so two flows can be compared without repeating the words. */
const VERDICT_ORDER: Record<ViewVerdict, number> = { unviewable: 0, cramped: 1, legible: 2 };

export interface Extent {
  width: number;
  height: number;
}

export interface Viewability extends Extent {
  /** Long side over short side, reported because people ask for it. */
  ratio: number;
  /** The scale `render_diagram` will be forced down to at its default of 1. */
  scale: number;
  /** What a 20 px node label comes out as at that scale. */
  labelPx: number;
  verdict: ViewVerdict;
}

export interface ViewabilityReport extends Viewability {
  /**
   * The same graph in the other flow, and only when this one came out badly.
   *
   * A guess would be worse than nothing here. "Consider DOWN" costs a relayout
   * and a render to evaluate, which is the loop this is meant to end; laying the
   * graph out both ways costs 42 ms of local CPU on a 46-node graph and answers
   * it. So the alternative is measured, never suggested.
   */
  alternative?: { direction: LayoutDirection } & Viewability;
  /**
   * The flow this board was NOT laid out in, when the engine chose for itself.
   *
   * Only ever set on a first draw with no flow asked for -- see `chooseFlow`.
   * Reported because a tool that quietly rearranged the picture is one the
   * caller cannot tell from a tool that ignored them.
   */
  instead?: { direction: LayoutDirection } & Viewability;
  /** The verdict in words a caller can act on. Absent when nothing is wrong. */
  note?: string;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boxOfElements(elements: ExcalidrawElement[]): Box | undefined {
  const box: Box = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  const include = (x: number, y: number) => {
    box.minX = Math.min(box.minX, x);
    box.minY = Math.min(box.minY, y);
    box.maxX = Math.max(box.maxX, x);
    box.maxY = Math.max(box.maxY, y);
  };
  for (const element of elements) {
    const x = Number(element.x) || 0;
    const y = Number(element.y) || 0;
    /*
     * An arrow is measured through its points, never as x + width.
     *
     * On a shape those agree; on an arrow they do not, and the gap is not small.
     * Excalidraw puts `x, y` at the route's FIRST point and lists the rest
     * relative to it, so a connector that doubles back has negative offsets and
     * `x + width` lands somewhere past its own right edge. Measured on a 46-node
     * board: 11,416px the wrong way against 7,160px the right way -- enough to
     * call a legible board unviewable and send the caller off to fix a layout
     * that was fine.
     */
    const points = Array.isArray(element.points) ? (element.points as Array<[number, number]>) : undefined;
    if (points?.length) {
      for (const point of points) {
        include(x + (Number(point?.[0]) || 0), y + (Number(point?.[1]) || 0));
      }
      continue;
    }
    include(x, y);
    include(x + (Number(element.width) || 0), y + (Number(element.height) || 0));
  }
  return Number.isFinite(box.minX) ? box : undefined;
}

function unionBox(left: Box | undefined, right: Box): Box {
  if (!left) return right;
  return {
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY),
  };
}

/** A bounding box as the renderer will frame it: rounded, and padded. */
function extentOf(box: Box | undefined): Extent {
  if (!box) return { width: RENDER_PADDING * 2, height: RENDER_PADDING * 2 };
  return {
    width: Math.round(box.maxX - box.minX) + RENDER_PADDING * 2,
    height: Math.round(box.maxY - box.minY) + RENDER_PADDING * 2,
  };
}

/**
 * How big the image of this board will be, padding included.
 *
 * Measured on the whole board rather than on the diagram just drawn, because
 * that is what the renderer frames: a board carrying a hand-drawn sketch beside
 * a tidy graph is shrunk by the sketch too, and a verdict that ignored it would
 * promise a legibility the render cannot deliver.
 */
export function boardExtent(board: BoardFile): Extent {
  return extentOf(boxOfElements(board.elements.filter((element) => element.isDeleted !== true)));
}

export function viewability(extent: Extent): Viewability {
  const width = Math.max(1, Math.round(extent.width));
  const height = Math.max(1, Math.round(extent.height));
  const longest = Math.max(width, height);
  const shortest = Math.max(1, Math.min(width, height));
  // render_diagram defaults to scale 1, so 1 is the ceiling and the cap is the
  // only thing that can lower it.
  const scale = Math.min(1, MAX_RENDER_SIDE / longest);
  const labelPx = NODE_FONT_SIZE * scale;
  return {
    width,
    height,
    ratio: Math.round((longest / shortest) * 10) / 10,
    scale: Math.round(scale * 100) / 100,
    labelPx: Math.round(labelPx * 10) / 10,
    verdict: labelPx >= LEGIBLE_LABEL_PX ? "legible" : labelPx >= CRAMPED_LABEL_PX ? "cramped" : "unviewable",
  };
}

/** The longest side a board can have and still render with readable labels. */
export const LEGIBLE_SIDE = Math.round(MAX_RENDER_SIDE / (LEGIBLE_LABEL_PX / NODE_FONT_SIZE));

function otherDirection(direction: LayoutDirection): LayoutDirection {
  return direction === "RIGHT" ? "DOWN" : "RIGHT";
}

/**
 * Lays the same graph out the other way, to find out rather than to suggest.
 *
 * Run only when the drawn flow came out badly, which is the cheap guard that
 * keeps a healthy board paying nothing for this.
 */
/**
 * Lays this graph out in one flow and says how the result would render.
 *
 * A plan comes back with the numbers so a caller that decides to keep this flow
 * does not lay it out a third time.
 */
async function measureFlow(
  params: LayoutParams,
  direction: LayoutDirection,
  survivors: ExcalidrawElement[],
  stackBelow: number,
  prefix: string,
): Promise<{ direction: LayoutDirection; plan: DiagramPlan } & Viewability> {
  const plan = await planDiagramLayout(
    { ...params, layout: { ...params.layout, direction } },
    { x: 0, y: 0 },
    prefix,
  );
  const bounds = planBounds(plan);
  // Mirrors what createDiagram does with a board that already had elements on
  // it, so two flows are measured on the same arrangement rather than one of
  // them being measured alone and looking smaller for it.
  if (survivors.length > 0) translatePlan(plan, -bounds.minX, stackBelow - bounds.minY);
  const extent = extentOf(unionBox(boxOfElements(survivors), planBounds(plan)));
  return { direction, plan, ...viewability(extent) };
}

/**
 * How many boards this graph would have to be cut into to be readable.
 *
 * Derived, not invented: a board reads when its long side is under
 * `LEGIBLE_SIDE`, so a board three times that long is three boards. Reported as
 * "about", because where the cuts go is a question about the code and not about
 * geometry.
 */
function splitInto(extent: Extent): number {
  return Math.max(2, Math.ceil(Math.max(extent.width, extent.height) / LEGIBLE_SIDE));
}

function sizeWords(view: Viewability): string {
  return `${view.width}x${view.height}, scale ${view.scale}, labels ${view.labelPx}px`;
}

/**
 * The verdict in a sentence, and the next move.
 *
 * Written as an outcome rather than a measurement, because the number on its own
 * reads as trivia: `scale 0.21` is what the last session saw three times and
 * acted on none of them. What it needs to hear is that the picture it is about
 * to ask for cannot be read, and which single call fixes that.
 */
function noteFor(view: Viewability, nodes: number, alternative?: { direction: LayoutDirection } & Viewability): string | undefined {
  if (view.verdict === "legible") return undefined;
  const problem = view.verdict === "unviewable"
    ? `This board cannot be read once rendered: at ${view.width}x${view.height} it is shrunk to `
      + `scale ${view.scale}, so its ${NODE_FONT_SIZE}px labels arrive ${view.labelPx}px tall.`
    : `This board renders small: at ${view.width}x${view.height} it is shrunk to scale ${view.scale}, `
      + `so its ${NODE_FONT_SIZE}px labels arrive ${view.labelPx}px tall -- readable only just.`;
  if (alternative && alternative.verdict === "legible") {
    return `${problem} Laid out ${alternative.direction} the same graph comes to `
      + `${sizeWords(alternative)}, which does read. Call relayout_diagram with `
      + `direction ${alternative.direction}; it costs one word and no graph.`;
  }
  if (alternative && alternative.labelPx > view.labelPx + 1) {
    return `${problem} Laid out ${alternative.direction} it comes to ${sizeWords(alternative)} -- better, `
      + `still cramped. Try relayout_diagram ${alternative.direction}, or split the graph across `
      + `about ${splitInto(alternative)} boards.`;
  }
  const flows = alternative
    ? `Neither flow helps: ${alternative.direction} comes to ${sizeWords(alternative)}.`
    : "";
  return `${problem} ${flows} A board reads when its long side is under ${LEGIBLE_SIDE}px, and this `
    + `one is ${Math.max(view.width, view.height)}px, so `
    + (view.verdict === "unviewable" ? "no scale and no flow will save it" : "neither flow gets it there")
    + `. Split the graph across about ${splitInto(view)} boards -- roughly `
    + `${Math.ceil(nodes / splitInto(view))} of these ${nodes} boxes each -- rather than rendering it `
    + "to look.";
}

export interface ReportInput {
  /** The board as it will be written, which is what the renderer will frame. */
  board: BoardFile;
  /** The graph, so the other flow can be measured rather than guessed at. */
  params: LayoutParams;
  direction: LayoutDirection;
  /** Elements that were already on the board and survived the redraw. */
  survivors: ExcalidrawElement[];
  /** The y the new diagram's top was dropped at, gap included. Only used when
   * there are survivors, and only so the other flow is measured stacked the
   * same way this one was. */
  stackBelow: number;
  nodeCount: number;
  /** The flow `chooseFlow` put aside, when it chose one. */
  instead?: { direction: LayoutDirection } & Viewability;
}

/**
 * The whole verdict for a board that has just been laid out.
 *
 * The second layout pass is the only cost here and it is conditional: a board
 * whose labels come out readable never runs it.
 */
export async function reportViewability(input: ReportInput): Promise<ViewabilityReport> {
  const view = viewability(boardExtent(input.board));
  /*
   * When the engine chose the flow, it says so and shows its work.
   *
   * A picture that came out in a shape nobody asked for is exactly the kind of
   * thing that looks like a bug, and the caller cannot see the layout that was
   * rejected. Both flows were measured a moment ago, so naming the loser and its
   * numbers costs a sentence and no work.
   */
  if (view.verdict === "legible") {
    if (!input.instead) return view;
    return {
      ...view,
      instead: input.instead,
      note: `Laid out ${input.direction} rather than the default ${input.instead.direction}, which `
        + `would have come to ${sizeWords(input.instead)} -- ${input.instead.verdict}. This flow is `
        + `${sizeWords(view)}. Pass direction to create_diagram, or call relayout_diagram, if you `
        + "want the other one anyway.",
    };
  }

  /*
   * The chosen flow can still be the better of two bad ones, and then the caller
   * needs both facts: which flow this is, and that no flow fixes it. The
   * rejected layout doubles as the alternative, so nothing is measured twice.
   */
  let alternative = input.instead;
  if (!alternative) {
    try {
      const { plan, ...measured } = await measureFlow(
        input.params,
        otherDirection(input.direction),
        input.survivors,
        input.stackBelow,
        "viewable-probe",
      );
      void plan;
      alternative = measured;
    } catch {
      // A probe is a convenience. A board that laid out one way but not the
      // other still deserves its own verdict, so this never becomes the thing
      // that made create_diagram fail.
      alternative = undefined;
    }
  }
  const chose = input.instead
    ? `Laid out ${input.direction}, not the default ${input.instead.direction}, because `
      + `${input.instead.direction} came out worse. `
    : "";
  const note = `${chose}${noteFor(view, input.nodeCount, alternative) ?? ""}`.trim();
  return {
    ...view,
    ...(alternative ? { alternative } : {}),
    ...(input.instead ? { instead: input.instead } : {}),
    ...(note ? { note } : {}),
  };
}

export interface FlowChoice {
  direction: LayoutDirection;
  plan: DiagramPlan;
  /** The flow tried first and put aside, with the numbers that decided it. */
  instead?: { direction: LayoutDirection } & Viewability;
}

/**
 * Which flow to draw this graph in, when nobody has said.
 *
 * The reporting above ends the guessing, and this ends the round trip. A caller
 * told "RIGHT gives 4px labels, DOWN reads" still has to call
 * `relayout_diagram` and wait -- so on a board where nothing has been chosen and
 * nothing can be overridden, the engine just draws the one that reads.
 *
 * Three guards, and all three matter:
 *
 * - `mayChoose` is false the moment a flow was asked for or is recorded on the
 *   board. An explicit RIGHT stays RIGHT even if it renders badly, because a
 *   tool that overrides what it was told is worse than a wide board.
 * - The chosen flow is laid out first and kept unless it is genuinely not
 *   legible, so the ordinary board pays one layout pass and nothing changes.
 * - The other flow has to actually be better by a verdict, not by a pixel. A
 *   coin toss between two unreadable boards is not a choice worth making, and
 *   silently flipping on one would make the picture unpredictable for nothing.
 *
 * Deterministic, which the file format depends on: ELK gives the same geometry
 * for the same graph, so this makes the same choice every time. And it is
 * recorded on the board, so the next redraw inherits it instead of re-deciding.
 */
export async function chooseFlow(input: {
  params: LayoutParams;
  direction: LayoutDirection;
  prefix: string;
  survivors: ExcalidrawElement[];
  stackBelow: number;
  mayChoose: boolean;
}): Promise<FlowChoice> {
  const asked = await measureFlow(
    input.params,
    input.direction,
    input.survivors,
    input.stackBelow,
    input.prefix,
  );
  if (!input.mayChoose || asked.verdict === "legible") {
    return { direction: asked.direction, plan: asked.plan };
  }
  let other: Awaited<ReturnType<typeof measureFlow>>;
  try {
    other = await measureFlow(
      input.params,
      otherDirection(input.direction),
      input.survivors,
      input.stackBelow,
      input.prefix,
    );
  } catch {
    // Choosing is a courtesy; drawing is the job.
    return { direction: asked.direction, plan: asked.plan };
  }
  if (VERDICT_ORDER[other.verdict] <= VERDICT_ORDER[asked.verdict]) {
    return { direction: asked.direction, plan: asked.plan };
  }
  const { plan, direction, ...numbers } = asked;
  void plan;
  return {
    direction: other.direction,
    plan: other.plan,
    instead: { direction, ...numbers },
  };
}
