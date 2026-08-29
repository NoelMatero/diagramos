/**
 * Turning a backwards arrow round, because a person said the code was right.
 *
 * `needs` is the only claim on a board that can be *disproved* -- it has a
 * direction, so it has an opposite -- and `drift.ts` reports the opposite as
 * `backwards-edge`, the one finding here that means **wrong**. Until this
 * module there was no way to answer it. You could change the code to match the
 * picture, or hand-edit the `.excalidraw` file. Nothing else. The loudest thing
 * the tool says was the only thing nobody could act on (#141).
 *
 * ## Why it was not already here, and what survives
 *
 * A board that rewrote itself whenever the code disagreed would be a mirror
 * rather than a spec: right every time, and therefore never informative. That
 * is the failure this whole project exists to prevent, and the argument is
 * sound -- but it rules out *silent* rewriting, not rewriting on request.
 * Conflating the two is what left the gap.
 *
 * Three situations produce one finding, and only a person can tell them apart:
 * the claim was transcribed wrong, the architecture deliberately changed, or
 * the code drifted and is wrong. The last is the default and the common case.
 * So accepting is an act somebody performs, never one the tool performs for
 * them, and the rules that keeps are:
 *
 * - **Never silently.** No check run reaches this. It is called from
 *   `drift --accept`, and from nowhere on the per-turn hook path.
 * - **One arrow, named.** The caller passes the arrow's id. There is no
 *   "accept everything" -- that is silent rewriting wearing a command's
 *   clothes.
 * - **Only what the current report accuses.** The finding has to be in the
 *   report being handed in. Flipping an arrow on a stale belief is the same
 *   mistake `repair.ts` refuses to make with a stale ref.
 * - **As a visible diff.** One arrow changes and nothing else, so the commit
 *   reads as the decision it is: somebody decided the dependency runs the
 *   other way. A relayout would bury that in a thousand changed coordinates.
 *
 * Nothing is written onto the board to mark that a correction happened. The git
 * diff is the record; a board carrying a history of its own corrections is the
 * rot this project exists to prevent.
 *
 * ## What it will not touch
 *
 * - **A hand-drawn arrow.** Its direction was never recorded -- it is read off
 *   bindings or off where the line happens to sit -- so turning it round means
 *   redrawing somebody's sketch. A sketch is a specification.
 * - **An arrow carrying a named route.** `via` names the functions the
 *   connection passes through in order. Reversed, that order describes a path
 *   that does not exist, and the check would then be wrong in a new way.
 * - **The rest of the board.** No other element is read, moved, or rewritten.
 */
import type { BoardFile } from "./board-file";
import type { DriftReport } from "./drift";
import { readGraph } from "./graph";
import type { ExcalidrawElement } from "./normalize";

/** The arrow as it was and as it now is, in node ids, for a caller to print. */
export interface AcceptedFlip {
  /** `from -> to` as the arrow was drawn: the id the finding used. */
  node: string;
  was: { from: string; to: string };
  now: { from: string; to: string };
  fromLabel: string;
  toLabel: string;
}

/**
 * Why an accept did not land. Each one is a guard above, and each is reported
 * rather than swallowed: "there was nothing to accept" and "I refused to accept
 * this" are different sentences, and a caller that cannot tell them apart will
 * read the second as the first.
 */
export type HeldReason =
  | "no-such-finding"
  | "hand-drawn"
  | "not-recorded"
  | "named-route";

export interface HeldFlip {
  node: string;
  why: HeldReason;
  detail: string;
}

export interface AcceptResult {
  board: BoardFile;
  applied?: AcceptedFlip;
  held?: HeldFlip;
}

/**
 * The arrow, drawn the other way.
 *
 * Three things carry the direction and all three have to move together, or the
 * picture and the record disagree -- which is worse than the finding, because
 * the file would then say one thing and the canvas show another.
 *
 * The route itself is reused rather than recomputed. Layout is the engine's job
 * and this is not laying anything out: the same line still touches the same two
 * boxes at the same two places, walked in the other order. That the arrow now
 * points up a board that was laid out top-down is not a defect to correct, it
 * is the news -- the dependency really does run that way.
 */
function flipArrow(element: ExcalidrawElement, edge: { from: string; to: string }): ExcalidrawElement {
  const custom = (element.customData ?? {}) as Record<string, unknown>;
  const recorded = (custom.edge ?? {}) as Record<string, unknown>;

  const flipped: ExcalidrawElement = {
    ...element,
    customData: { ...custom, edge: { ...recorded, from: edge.to, to: edge.from } },
    version: (Number(element.version) || 1) + 1,
  };

  // Which box each end is tied to, swapped. `focus` and `gap` travel with their
  // own binding: they say where on *that* box the line attaches, and the line
  // still attaches in the same two places. `focus` is signed along the arrow's
  // direction, so it flips with the arrow.
  const start = element.startBinding as Record<string, unknown> | null | undefined;
  const end = element.endBinding as Record<string, unknown> | null | undefined;
  const turned = (binding: Record<string, unknown> | null | undefined) =>
    binding ? { ...binding, focus: -(Number(binding.focus) || 0) } : binding ?? null;
  flipped.startBinding = turned(end);
  flipped.endBinding = turned(start);

  // The route, walked backwards. Points are relative to the element's origin,
  // so the origin becomes the old last point and every point is re-based on it.
  const points = Array.isArray(element.points) ? (element.points as Array<[number, number]>) : undefined;
  const last = points?.[points.length - 1];
  if (points && last) {
    flipped.x = (Number(element.x) || 0) + last[0];
    flipped.y = (Number(element.y) || 0) + last[1];
    flipped.points = [...points].reverse().map(([x, y]) => [x - last[0], y - last[1]]);
  }

  return flipped;
}

/**
 * Accepts one backwards finding: the arrow named by `edgeId`, turned round.
 *
 * `edgeId` is the `node` field of the finding -- `"from -> to"` in node ids,
 * the same handle a promotion or a work item uses for an arrow.
 *
 * Returns a new board rather than mutating one, so a caller can decide whether
 * to write it, and so "what would this do" costs nothing to ask.
 */
export function acceptBackwards(board: BoardFile, report: DriftReport, edgeId: string): AcceptResult {
  const wanted = edgeId.trim();
  const finding = report.edges.find(
    (candidate) => candidate.kind === "backwards-edge" && candidate.node === wanted,
  );
  if (!finding) {
    return {
      board,
      held: {
        node: wanted,
        why: "no-such-finding",
        detail:
          `this check does not say ${wanted} is drawn backwards. Only a finding `
          + `the current report is making can be accepted — otherwise the board `
          + `would be changed on the strength of something that is no longer true.`,
      },
    };
  }

  const edge = readGraph(board).edges.find((candidate) => `${candidate.from} -> ${candidate.to}` === wanted);
  if (!edge) {
    return {
      board,
      held: {
        node: wanted,
        why: "not-recorded",
        detail: `no arrow on this board is drawn ${wanted}.`,
      },
    };
  }
  if (edge.provenance !== "recorded") {
    return {
      board,
      held: {
        node: wanted,
        why: "hand-drawn",
        detail:
          `${wanted} was drawn by hand, so its direction was read off the drawing `
          + `rather than written down. Turning it round means redrawing somebody's `
          + `sketch, which this will not do. Drag the arrow the other way on the board.`,
      },
    };
  }
  if (edge.via && edge.via.length > 0) {
    return {
      board,
      held: {
        node: wanted,
        why: "named-route",
        detail:
          `${wanted} names the route it takes (${edge.via.join(" → ")}), and that `
          + `order describes a path that would not exist backwards. Rewrite the `
          + `route with the arrow, or drop it.`,
      },
    };
  }

  const elements = board.elements.map((element) =>
    String(element.id) === edge.elementId ? flipArrow(element, edge) : element,
  );

  return {
    board: { ...board, elements },
    applied: {
      node: wanted,
      was: { from: edge.from, to: edge.to },
      now: { from: edge.to, to: edge.from },
      fromLabel: finding.fromLabel,
      toLabel: finding.toLabel,
    },
  };
}
