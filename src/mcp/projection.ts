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
}

export function projectGraph(
  graph: RecoveredGraph,
  { geometry = false, detailed = false }: ProjectionOptions = {},
): Record<string, unknown> {
  const { nodes, edges, unattributed, ...rest } = graph;
  const placed = geometry
    ? nodes
    : nodes.map(({ x: _x, y: _y, width: _w, height: _h, ...node }) => node);
  return {
    ...rest,
    nodes: placed.map((node) => shrink(node, NODE_DEFAULTS, detailed)),
    edges: edges.map((edge) => shrink(edge, EDGE_DEFAULTS, detailed)),
    // An empty array on every response is bytes saying nothing. A board with
    // strays on it still reports them.
    ...(unattributed.length ? { unattributed } : {}),
  };
}
