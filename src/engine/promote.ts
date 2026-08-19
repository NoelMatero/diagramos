/**
 * Applies promotions to the board file: the one drift signal that is good news,
 * made actionable.
 *
 * `checkDrift` notices a `planned` box whose anchor now resolves and reports it
 * as a `Promotion` -- and then nothing advances the board, so the same good news
 * arrives every turn until a human edits the file. This closes that loop: flip
 * the element to what regenerating it as `built` would write, so the next check
 * has nothing to say about it.
 *
 * The guard is that a box is promoted only when *everything* it claims has
 * landed. A multi-anchor box reports one promotion per anchor that resolves and
 * one work item (or finding) per anchor that does not; flipping it while any
 * anchor is outstanding would erase the remaining work from the picture. Those
 * are returned as `held` so a caller can still report the partial progress.
 *
 * Hand-drawn elements are never touched, by construction: a promotion only ever
 * comes from a `recorded` node, and the flip is matched back to elements through
 * the recorded graph.
 */
import type { BoardFile } from "./board-file";
import type { DriftReport, Promotion } from "./drift";
import { readGraph } from "./graph";

export interface PromotionResult {
  board: BoardFile;
  /** One entry per box or arrow whose state was flipped to built. */
  applied: Promotion[];
  /** Promotions left alone because the same box still has unresolved anchors. */
  held: Promotion[];
}

export function applyPromotions(board: BoardFile, report: DriftReport): PromotionResult {
  if (report.promotions.length === 0) return { board, applied: [], held: [] };

  const blocked = new Set([
    ...report.workItems.map((item) => item.node),
    ...report.findings.map((finding) => finding.node),
  ]);

  // One flip per element, however many of its anchors resolved.
  const byNode = new Map<string, Promotion>();
  for (const promotion of report.promotions) {
    if (!byNode.has(promotion.node)) byNode.set(promotion.node, promotion);
  }

  const graph = readGraph(board);
  const elementByNode = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.provenance === "recorded") elementByNode.set(node.id, node.elementId);
  }
  for (const edge of graph.edges) {
    // The id shape `checkDrift` gives an edge promotion.
    if (edge.provenance === "recorded") elementByNode.set(`${edge.from} -> ${edge.to}`, edge.elementId);
  }

  const applied: Promotion[] = [];
  const held: Promotion[] = [];
  const flips = new Map<string, Promotion>();
  for (const [nodeId, promotion] of byNode) {
    const elementId = blocked.has(nodeId) ? undefined : elementByNode.get(nodeId);
    if (elementId) flips.set(elementId, promotion);
    else held.push(promotion);
  }
  if (flips.size === 0) return { board, applied: [], held };

  const elements = board.elements.map((element) => {
    const promotion = flips.get(String(element.id));
    if (!promotion) return element;
    applied.push(promotion);
    // Exactly what regenerating the diagram with this node declared `built`
    // writes -- solid stroke, no state key -- so a later regeneration produces
    // the same element instead of churning it.
    const { state: _state, ...custom } = (element.customData ?? {}) as Record<string, unknown>;
    return {
      ...element,
      strokeStyle: "solid",
      customData: custom,
      version: (Number(element.version) || 1) + 1,
    };
  });

  return { board: { ...board, elements }, applied, held };
}
