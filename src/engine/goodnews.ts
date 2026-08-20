/**
 * The good-news half of the baseline comparison (#67).
 *
 * Bad news always reaches the CLI: a broken ref, a deleted claim. Good news
 * only reached it when the hook itself applied a promotion — a board that
 * improved because Claude redrew it, or because a box was added, said nothing.
 * This is the missing comparison: what does the live board claim that the last
 * committed board did not?
 *
 * Deliberately deaf to everything else. Moves, restyles, relabels, and
 * hand-drawn (inferred) additions are not news — announcing the user's own
 * doodles back at them every turn is how a notice gets switched off. Additions
 * and planned→built flips only.
 *
 * Takes two plain board files rather than the drift checker's `BoardBaseline`
 * injection, so it depends on nothing but the graph reader: whoever prints the
 * notice already holds both boards.
 */
import type { BoardFile } from "./board-file";
import { readGraph } from "./graph";

export interface GoodNewsBox {
  /** Semantic node id, stable across redraws. */
  node: string;
  label: string;
}

export interface GoodNewsEdge {
  from: string;
  to: string;
  label?: string;
}

export interface GoodNews {
  /** Recorded, non-external boxes the committed board did not have. */
  addedBoxes: GoodNewsBox[];
  /** Boxes that were `planned` at the last commit and claim `built` now — whoever flipped them. */
  builtBoxes: GoodNewsBox[];
  /** Arrows that were `planned` at the last commit and claim `built` now. */
  builtEdges: GoodNewsEdge[];
}

/** True when there is anything worth a green line. */
export function hasGoodNews(news: GoodNews): boolean {
  return news.addedBoxes.length > 0 || news.builtBoxes.length > 0 || news.builtEdges.length > 0;
}

/**
 * What improved on `board` since `committed`.
 *
 * `undefined` when there is no committed board to compare against — untracked
 * board, no git — and that is silence rather than an error, exactly as the
 * deleted-claim check treats the same absence.
 *
 * Matching is on the semantic node id on both sides, and recorded elements
 * only. Regeneration writes new element ids but keeps node ids, so anything
 * keyed on elements would call every redraw a pile of additions; and an
 * inferred node's id is guessed from geometry, too unstable to diff against.
 * A node that changed id reads as added, which overstates slightly and is
 * accepted: the id is the identity this engine promises to keep.
 *
 * `external` boxes are scenery — a browser, a third-party service — and are
 * never announced, matching the checker, which never checks them either.
 */
export function goodNewsSince(board: BoardFile, committed: BoardFile | undefined): GoodNews | undefined {
  if (!committed) return undefined;

  const live = readGraph(board);
  const was = readGraph(committed);

  const wasState = new Map<string, string>();
  for (const node of was.nodes) {
    if (node.provenance !== "recorded") continue;
    wasState.set(node.id, node.state);
  }

  const addedBoxes: GoodNewsBox[] = [];
  const builtBoxes: GoodNewsBox[] = [];
  for (const node of live.nodes) {
    if (node.provenance !== "recorded" || node.state === "external") continue;
    const before = wasState.get(node.id);
    if (before === undefined) {
      addedBoxes.push({ node: node.id, label: node.label });
    } else if (before === "planned" && node.state === "built") {
      builtBoxes.push({ node: node.id, label: node.label });
    }
  }

  // Edges have no id of their own; their endpoints are the identity. Two
  // recorded arrows between the same pair collapse to one here, which
  // undercounts a case the drawing tools never produce.
  const wasEdgeState = new Map<string, string>();
  for (const edge of was.edges) {
    if (edge.provenance !== "recorded") continue;
    wasEdgeState.set(`${edge.from}→${edge.to}`, edge.state);
  }

  const builtEdges: GoodNewsEdge[] = [];
  for (const edge of live.edges) {
    if (edge.provenance !== "recorded" || edge.state !== "built") continue;
    if (wasEdgeState.get(`${edge.from}→${edge.to}`) === "planned") {
      builtEdges.push({ from: edge.from, to: edge.to, ...(edge.label ? { label: edge.label } : {}) });
    }
  }

  return { addedBoxes, builtBoxes, builtEdges };
}

/**
 * The green line itself, or `undefined` when there is nothing to say.
 *
 * One line, tallies only: `board improved: +2 boxes · 1 built · 1 arrow wired`.
 * Names would be nicer and longer; the notice runs after every turn, and the
 * quiet-check rule outranks nice.
 */
export function goodNewsLine(news: GoodNews | undefined): string | undefined {
  if (!news || !hasGoodNews(news)) return undefined;
  const parts: string[] = [];
  if (news.addedBoxes.length) {
    parts.push(`+${news.addedBoxes.length} ${news.addedBoxes.length === 1 ? "box" : "boxes"}`);
  }
  if (news.builtBoxes.length) parts.push(`${news.builtBoxes.length} built`);
  if (news.builtEdges.length) {
    parts.push(`${news.builtEdges.length} ${news.builtEdges.length === 1 ? "arrow" : "arrows"} wired`);
  }
  return `board improved: ${parts.join(" · ")}`;
}
