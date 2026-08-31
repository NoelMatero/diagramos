/**
 * What a graph looks like on the way to a model.
 *
 * `readGraph` stays rich because the engine and its tests want the whole
 * picture. This is the narrower thing that crosses the wire, and it lives in
 * its own module for one reason: `scripts/audit-context.mts` prices a board
 * against the prose in `docs/`, and a copy of these rules in the audit would
 * quietly start measuring a payload nobody is actually sent.
 */
import type { RecoveredGraph } from "../engine/graph";

/**
 * The value a field carries on almost every box and arrow.
 *
 * Measured across the six anchored boards in this repo, `rectangle`,
 * `recorded`, `built` and `declared` are what these fields say on ~90% of the
 * items that carry them. Sending them anyway repeats the same four words on
 * every node of every response -- with `elementId`, 58% of a read_diagram
 * payload was packaging rather than content.
 *
 * Omission only pays if it means something exact, so each default is stated in
 * the read_diagram description: charged once per session instead of once per
 * node per call.
 */
export const NODE_DEFAULTS: Record<string, string> = {
  shape: "rectangle",
  provenance: "recorded",
  state: "built",
};

export const EDGE_DEFAULTS: Record<string, string> = {
  provenance: "recorded",
  endpoints: "declared",
  state: "built",
};

/**
 * Drops default-valued fields, and `elementId` unless the caller asked for the
 * detail an edit needs.
 *
 * `elementId` is safe to withhold because `applyEdits` resolves semantic node
 * ids on its own -- the id already in hand addresses the element. Anything that
 * genuinely needs the raw handle asks for `geometry` or `includeElements`.
 */
function shrink<T extends object>(
  item: T,
  defaults: Record<string, string>,
  keepElementId: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (key === "elementId" && !keepElementId) continue;
    if (defaults[key] === value) continue;
    out[key] = value;
  }
  return out;
}

export interface ProjectionOptions {
  /** Keep positions and sizes on nodes. Doubles the response. */
  geometry?: boolean;
  /** Keep `elementId`. Implied by anything that addresses elements directly. */
  detailed?: boolean;
  /**
   * The honest-gaps sentence, computed by the caller (it needs the filesystem
   * and sibling boards, which a pure projection of one graph must not touch).
   * Carried through here rather than spread on afterwards so the audit prices
   * the payload the model is actually sent -- the reason this module exists.
   */
  notShown?: string;
}

/**
 * The legend for what was left out, sent once per response.
 *
 * Stating the defaults in the tool description was not enough on its own. A
 * board where every box agrees with every default mentions `provenance`,
 * `state` and `endpoints` nowhere at all, so a reader of the payload cannot
 * learn from it that those fields exist -- and an agent that does not know a
 * concept exists cannot think to ask about it. Whether that matters is
 * ungraded, which is exactly why it is not worth betting on: this costs ~30
 * tokens once, against the ~1,590 the fields cost spread across 61 nodes and
 * 63 edges on this repo's boards.
 *
 * It also makes a response self-describing rather than dependent on the tool
 * description having been read and retained.
 */
const DEFAULTS_LEGEND = {
  shape: "rectangle",
  provenance: "recorded",
  state: "built",
  endpoints: "declared",
  // Board-level rather than per-item, and it costs nothing to say once. Without
  // it a caller wondering how a board is laid out has no way to learn from the
  // response that the question has an answer, let alone that relayout_diagram
  // can change it for one word instead of a whole graph.
  direction: "RIGHT",
} as const;

export function projectGraph(
  graph: RecoveredGraph,
  { geometry = false, detailed = false, notShown }: ProjectionOptions = {},
): Record<string, unknown> {
  const { nodes, edges, unattributed, ...rest } = graph;
  const placed = geometry
    ? nodes
    : nodes.map(({ x: _x, y: _y, width: _w, height: _h, ...node }) => node);
  return {
    ...rest,
    omittedWhenDefault: DEFAULTS_LEGEND,
    nodes: placed.map((node) => shrink(node, NODE_DEFAULTS, detailed)),
    edges: edges.map((edge) => shrink(edge, EDGE_DEFAULTS, detailed)),
    // An empty array on every response is bytes saying nothing. A board with
    // strays on it still reports them.
    ...(unattributed.length ? { unattributed } : {}),
    // Absent when there is genuinely nothing to say; the sentence itself says
    // when the answer could not be determined, so silence stays meaningful.
    ...(notShown ? { notShown } : {}),
  };
}
