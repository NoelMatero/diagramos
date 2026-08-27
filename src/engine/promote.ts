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
import { readGraph, strokeStyleForState, type NodeState } from "./graph";
import type { ExcalidrawElement } from "./normalize";

export interface PromotionResult {
  board: BoardFile;
  /** One entry per box or arrow whose state was flipped to built. */
  applied: Promotion[];
  /** Promotions left alone because the same box still has unresolved anchors. */
  held: Promotion[];
}

/**
 * The key marking a box drawn as built before the turn that built it has ended.
 *
 * Its presence is the whole difference between a preview and a promotion, so it
 * is written on the way in and removed by every path that settles or undoes one.
 * A board carrying this key is saying: this looks built, and the record still
 * says `planned`.
 */
export const LIVE_PROMOTION_KEY = "livePromotion";

/**
 * Which elements a report says are promotable, and which promotion each is for.
 *
 * The two promotion paths -- settle it, or preview it -- have to agree on this
 * exactly, or the preview would draw a box the hook then refuses to promote and
 * the board would flick back at the end of every turn.
 *
 * `held` is a promotion with nowhere to land: its box still has an anchor that
 * has not resolved, or the node is not one this board recorded. Reported rather
 * than dropped, so partial progress is still visible as progress.
 */
function promotableElements(
  board: BoardFile,
  report: DriftReport,
): { flips: Map<string, Promotion>; held: Promotion[] } {
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

  const flips = new Map<string, Promotion>();
  const held: Promotion[] = [];
  for (const [nodeId, promotion] of byNode) {
    const elementId = blocked.has(nodeId) ? undefined : elementByNode.get(nodeId);
    if (elementId) flips.set(elementId, promotion);
    else held.push(promotion);
  }
  return { flips, held };
}

function customOf(element: ExcalidrawElement): Record<string, unknown> {
  return (element.customData ?? {}) as Record<string, unknown>;
}

function isLivePromoted(element: ExcalidrawElement): boolean {
  return customOf(element)[LIVE_PROMOTION_KEY] === true;
}

/** The element as it looks with the live flip on: built stroke, record untouched. */
function withLiveFlip(element: ExcalidrawElement, custom: Record<string, unknown>): ExcalidrawElement {
  return {
    ...element,
    strokeStyle: "solid",
    customData: { ...custom, [LIVE_PROMOTION_KEY]: true },
    version: (Number(element.version) || 1) + 1,
  };
}

/** The element as it looks with the live flip off: back to whatever its state draws as. */
function withoutLiveFlip(element: ExcalidrawElement, custom: Record<string, unknown>): ExcalidrawElement {
  const { [LIVE_PROMOTION_KEY]: _marker, ...rest } = custom;
  const stroke = strokeStyleForState(rest.state as NodeState | undefined);
  const next: ExcalidrawElement = {
    ...element,
    customData: rest,
    version: (Number(element.version) || 1) + 1,
  };
  if (stroke.strokeStyle) next.strokeStyle = stroke.strokeStyle;
  // `built` draws with no key at all, so restoring it means removing one.
  else delete next.strokeStyle;
  return next;
}

export interface LivePromotionResult {
  board: BoardFile;
  /** Flipped to look built this pass. Already-flipped boxes are not repeated. */
  promoted: Promotion[];
  /** Node ids whose flip was taken back, because the evidence for it went away. */
  reverted: string[];
  /** Whether anything moved. False means there is nothing to write. */
  changed: boolean;
}

/**
 * Draws promotions early, without recording them (#130).
 *
 * The board only reacts to the board file, so a box you planned turns real and
 * you find out when the turn ends. This is the fast half of that loop: while
 * somebody is watching a board, the service re-checks on every code change and
 * flips the promotable boxes to a solid stroke straight away.
 *
 * ## What makes this safe to do mid-turn
 *
 * `applyPromotions` deletes the `state` key -- that is what makes a promotion a
 * promotion, and it is a one-way door. Mid-turn the tree is a construction site:
 * a file is created empty and filled two seconds later, a rename lands as three
 * edits. Walking through that door on a half-written file would erase something
 * the author typed, permanently, and nothing here could put it back.
 *
 * So this pass never touches `state`. It writes `strokeStyle` and a marker, and
 * nothing in the engine reads `strokeStyle` -- the renderer and the promoter
 * write it, and no check consults it. State is read only from `customData.state`
 * (`readGraph`). The consequence is the useful one: the picture can run ahead of
 * the record, every check still gives exactly the answer it would have given,
 * and if the code goes away again the flip is simply undone.
 *
 * Idempotent on purpose. A box already flipped and still promotable is left
 * completely alone -- not rewritten, not re-announced, not version-bumped. Were
 * it otherwise the service would write the board on every check, its own watcher
 * would see the write, and the two would drive each other in a loop.
 */
export function reconcileLivePromotions(board: BoardFile, report: DriftReport): LivePromotionResult {
  const { flips: wanted } = promotableElements(board, report);
  const promoted: Promotion[] = [];
  const reverted: string[] = [];

  const elements = board.elements.map((element) => {
    const custom = customOf(element);
    const want = wanted.get(String(element.id));
    const marked = isLivePromoted(element);
    if (want && !marked) {
      promoted.push(want);
      return withLiveFlip(element, custom);
    }
    if (!want && marked) {
      reverted.push(typeof custom.node === "string" ? custom.node : String(element.id));
      return withoutLiveFlip(element, custom);
    }
    return element;
  });

  const changed = promoted.length > 0 || reverted.length > 0;
  return { board: changed ? { ...board, elements } : board, promoted, reverted, changed };
}

/**
 * Takes every live flip back off, whatever the evidence currently says.
 *
 * The settling path calls this first, and the order is the point. A preview is
 * only ever as good as the moment it was drawn, and the end of a turn is when
 * the question gets asked properly: so every marker comes off, and then
 * `applyPromotions` puts the `built` stroke back on exactly the boxes that have
 * really earned it. A box the service flipped on a file that has since been
 * deleted goes back to dashed here, and never became `built`.
 *
 * It also matters when nothing is watching. If the service is killed mid-turn it
 * leaves markers on disk, and without this they would sit there describing a
 * preview nothing is maintaining -- a box that looks built with a record that
 * says planned, forever. The next check cleans them up.
 */
export function clearLivePromotions(board: BoardFile): { board: BoardFile; cleared: number } {
  let cleared = 0;
  const elements = board.elements.map((element) => {
    if (!isLivePromoted(element)) return element;
    cleared += 1;
    return withoutLiveFlip(element, customOf(element));
  });
  return { board: cleared > 0 ? { ...board, elements } : board, cleared };
}

export function applyPromotions(board: BoardFile, report: DriftReport): PromotionResult {
  if (report.promotions.length === 0) return { board, applied: [], held: [] };

  const { flips, held } = promotableElements(board, report);
  if (flips.size === 0) return { board, applied: [], held };

  const applied: Promotion[] = [];
  const elements = board.elements.map((element) => {
    const promotion = flips.get(String(element.id));
    if (!promotion) return element;
    applied.push(promotion);
    // Exactly what regenerating the diagram with this node declared `built`
    // writes -- solid stroke, no state key -- so a later regeneration produces
    // the same element instead of churning it.
    //
    // The live marker goes with the state key. This is the moment the preview
    // becomes the record, and a marker left behind would claim the box is still
    // only being previewed by a service that has stopped previewing it.
    const {
      state: _state,
      [LIVE_PROMOTION_KEY]: _marker,
      ...custom
    } = (element.customData ?? {}) as Record<string, unknown>;
    return {
      ...element,
      strokeStyle: "solid",
      customData: custom,
      version: (Number(element.version) || 1) + 1,
    };
  });

  return { board: { ...board, elements }, applied, held };
}
