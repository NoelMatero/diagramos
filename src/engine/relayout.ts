/**
 * Re-runs a board's own layout without being told the graph again.
 *
 * Layout is the one thing this engine does entirely by itself, and until now
 * the only way to change it was `create_diagram` with every node and every edge
 * re-sent -- ~1,900 tokens on a 34-node board to communicate one word (#161).
 * Nothing about that graph is unknown: it was written into the board's own
 * `customData` the day it was drawn, and `readGraph` already recovers it. So
 * this reads the graph back off the disk, hands it to the same layout pass, and
 * writes the result. No model in the loop, and no graph on the wire.
 *
 * ## Why this does not go through `readGraph`
 *
 * `readGraph` answers "what does this board claim", and it is right to strip
 * things on the way: an edge label comes back without its `@needs`, a box label
 * comes back without its `@rows=2048`, because a caller asking what a board
 * claims wants the claim in a field rather than buried in prose.
 *
 * Feeding that back into a redraw would delete both from the picture. So this
 * reads the elements directly and keeps every label exactly as it was typed,
 * which is what makes a same-direction re-layout byte-identical to the board it
 * started from -- the property the whole file format rests on.
 */
import { readLabelClaim, type ArrowClaim } from "./claim";
import type { BoardFile } from "./board-file";
import {
  connectNodes,
  createDiagram,
  deleteDiagram,
  diagramNameOf,
  listDiagrams,
  type Connection,
  type CreateDiagramParams,
} from "./diagram";
import type { BoardDescribes, LayoutDirection, NodeState } from "./graph";
import { DEFAULT_DIRECTION, NODE_SHAPES, NODE_STATES, directionOf } from "./graph";
import type { ExcalidrawElement } from "./normalize";
import type { GraphEdge, GraphNode, GraphShape } from "./layout";
import type { ViewabilityReport } from "./viewable";

function customOf(element: ExcalidrawElement): Record<string, unknown> {
  const custom = element.customData;
  return custom && typeof custom === "object" ? (custom as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => entry.trim());
  return entries.length ? entries : undefined;
}

/**
 * The index a generated element was written at, from its id.
 *
 * Node and edge order decides the element ids a redraw mints, so recovering it
 * wrong renames every box on the board -- an edit addressed to `api` would land
 * on whatever ended up third instead. The id is the only record of that order
 * that survives a person dragging elements around in the app, which reorders
 * the array in the file.
 */
function indexOf(element: ExcalidrawElement, kind: "node" | "edge"): number {
  const match = new RegExp(`-${kind}-(\\d+)$`).exec(String(element.id));
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function stateOf(value: unknown): NodeState | undefined {
  return typeof value === "string" && (NODE_STATES as readonly string[]).includes(value)
    ? (value as NodeState)
    : undefined;
}

/** The claim recorded on an arrow, only when it is one the vocabulary knows. */
function arrowClaimOf(value: unknown): ArrowClaim | undefined {
  const claim = (value as { claim?: unknown } | undefined)?.claim;
  return claim === "needs" || claim === "feeds" ? claim : undefined;
}

export interface RecoveredDiagram {
  /** The element id prefix, which is also the name delete_diagram takes. */
  name: string;
  params: Omit<CreateDiagramParams, "layout" | "append">;
  /** What this diagram was last laid out with. Absent means it never said. */
  direction?: LayoutDirection;
}

/**
 * Reads one generated diagram back as the arguments that would redraw it.
 *
 * Everything `create_diagram` can be told is recovered: labels verbatim,
 * colours, shapes, refs, states, claims, routes, and the board-level facts on
 * the title. Anything it cannot be told -- a box somebody dragged, a font size
 * changed by hand -- is not recovered, because a redraw could not have honoured
 * it either. That is the honest boundary of this operation and the reason it is
 * safe: it can only lose what `create_diagram` already loses.
 */
export function recoverDiagram(board: BoardFile, name: string): RecoveredDiagram {
  const mine = board.elements.filter(
    (element) => element.isDeleted !== true && diagramNameOf(element) === name,
  );
  if (mine.length === 0) {
    throw new Error(`No diagram named "${name}" on this board.`);
  }

  // A bound label belongs to its container, and it holds the text a person
  // reads. It is taken verbatim: the `@` tokens in it are part of the picture.
  const labelByContainer = new Map<string, string>();
  for (const element of mine) {
    if (element.type === "text" && typeof element.containerId === "string") {
      labelByContainer.set(element.containerId, String(element.text ?? ""));
    }
    // Boards drawn before edge labels were bound park them beside the arrow.
    const parked = stringOf(customOf(element).edgeLabelFor);
    if (parked) labelByContainer.set(parked, String(element.text ?? ""));
  }

  const titleElement = mine.find((element) => customOf(element).role === "title");
  const titleCustom = titleElement ? customOf(titleElement) : {};
  const describes = titleCustom.describes === "concept" ? ("concept" as BoardDescribes) : undefined;

  const nodes: GraphNode[] = mine
    .filter((element) => NODE_SHAPES.includes(String(element.type)) && stringOf(customOf(element).node))
    .sort((left, right) => indexOf(left, "node") - indexOf(right, "node"))
    .map((element) => {
      const custom = customOf(element);
      const claim = custom.claim as { closed?: unknown; through?: unknown } | undefined;
      const background = stringOf(element.backgroundColor);
      const stroke = stringOf(element.strokeColor);
      return {
        id: stringOf(custom.node)!,
        label: labelByContainer.get(String(element.id)) ?? "",
        shape: String(element.type) as GraphShape,
        // `transparent` and `#1e1e1e` are what the layout writes when it is told
        // nothing, so passing them back would be identical -- but leaving them
        // off keeps the recovered graph readable as what the author actually said.
        ...(background && background !== "transparent" ? { backgroundColor: background } : {}),
        ...(stroke && stroke !== "#1e1e1e" ? { strokeColor: stroke } : {}),
        ...(element.type === "rectangle" && element.roundness ? { rounded: true } : {}),
        ...(stringOf(custom.ref) ? { ref: stringOf(custom.ref)! } : {}),
        ...(stringsOf(custom.refs) ? { refs: stringsOf(custom.refs)! } : {}),
        ...(stateOf(custom.state) ? { state: stateOf(custom.state)! } : {}),
        ...(claim?.closed ? { closed: { through: stringsOf(claim.through) ?? [] } } : {}),
      };
    });

  const edges: GraphEdge[] = mine
    .filter((element) => element.type === "arrow" && customOf(element).edge)
    .sort((left, right) => indexOf(left, "edge") - indexOf(right, "edge"))
    .map((element) => {
      const custom = customOf(element);
      const recorded = custom.edge as { from?: unknown; to?: unknown };
      const claim = arrowClaimOf(custom.edge);
      const written = labelByContainer.get(String(element.id));
      // The claim was folded into the label when this was drawn, and folding it
      // in again is how the redraw reproduces it. Taking the label as-is here
      // would write `needs @needs` on the second pass and `needs @needs @needs`
      // on the third.
      const label = written ? readLabelClaim(written).text : undefined;
      const stroke = stringOf(element.strokeColor);
      return {
        from: String(recorded?.from ?? ""),
        to: String(recorded?.to ?? ""),
        ...(label ? { label } : {}),
        ...(stroke && stroke !== "#1e1e1e" ? { strokeColor: stroke } : {}),
        ...(stateOf(custom.state) ? { state: stateOf(custom.state)! } : {}),
        ...(stringsOf(custom.via) ? { via: stringsOf(custom.via)! } : {}),
        ...(claim ? { claim } : {}),
      };
    });

  if (nodes.length === 0) {
    throw new Error(
      `Diagram "${name}" has no boxes this engine drew, so there is no layout to re-run. `
        + "Anything on it was drawn by hand, and hand-drawn work is never moved.",
    );
  }

  const title = titleElement ? String(titleElement.text ?? "").trim() : undefined;
  return {
    name,
    params: {
      ...(title ? { title } : {}),
      ...(describes ? { describes } : {}),
      ...(stringOf(titleCustom.complete) ? { complete: stringOf(titleCustom.complete)! } : {}),
      nodes,
      edges,
      name,
    },
    ...(directionOf(board, name) ? { direction: directionOf(board, name)! } : {}),
  };
}

/**
 * Arrows `connect_nodes` drew between boxes this is about to move.
 *
 * Measured, not guessed at: removing a diagram sweeps any connector bound to
 * one of its shapes, along with that connector's label, because a connector
 * with one end gone is a dangling line. That is right for a delete and wrong
 * here -- this is not removing the boxes, it is moving them, and an operation
 * advertised as keeping everything must not quietly take a line somebody drew
 * on purpose.
 *
 * They are re-drawn afterwards rather than re-routed, for the same reason the
 * whole diagram is: the geometry of an arrow between two boxes is derived from
 * where those boxes are, and both ends have just moved.
 */
function carriedConnectors(board: BoardFile, doomed: Set<string>): Connection[] {
  const labelByContainer = new Map<string, string>();
  for (const element of board.elements) {
    if (element.isDeleted !== true && element.type === "text" && typeof element.containerId === "string") {
      labelByContainer.set(element.containerId, String(element.text ?? ""));
    }
  }
  return board.elements
    .filter((element) => {
      if (element.isDeleted === true || element.type !== "arrow") return false;
      if (customOf(element).origin !== "connector") return false;
      const start = (element.startBinding as { elementId?: string } | null)?.elementId;
      const end = (element.endBinding as { elementId?: string } | null)?.elementId;
      return Boolean((start && doomed.has(start)) || (end && doomed.has(end)));
    })
    .map((element) => {
      const recorded = customOf(element).edge as { from?: unknown; to?: unknown } | undefined;
      const claim = arrowClaimOf(customOf(element).edge);
      const written = labelByContainer.get(String(element.id));
      // Stripped for the same reason an edge's is: the claim is folded back in
      // when the arrow is redrawn, and passing the folded form would double it.
      const label = written ? readLabelClaim(written).text : undefined;
      return {
        from: String(recorded?.from ?? ""),
        to: String(recorded?.to ?? ""),
        ...(label ? { label } : {}),
        ...(claim ? { claim } : {}),
        ...(element.startArrowhead === "arrow" ? { bidirectional: true } : {}),
      };
    });
}

export interface RelayoutParams {
  /** Which diagram. Omit when the board holds exactly one. */
  name?: string;
  /**
   * The flow to lay out with. Omit only on a board that recorded one; a board
   * that never did is refused rather than laid out in the default.
   */
  direction?: LayoutDirection;
}

export interface RelayoutResult {
  board: BoardFile;
  /** The diagram that moved. */
  name: string;
  direction: LayoutDirection;
  /**
   * What it was laid out with before, so a caller can see a no-op as one.
   *
   * Absent on a board drawn before the flow was recorded, and that absence is
   * not the same as `RIGHT`. Measured on this repo's own `architecture` board:
   * it is laid out DOWN, it records nothing, and reading the silence as the
   * default would have reported "was RIGHT" about a board anybody can see is
   * not -- and then rearranged it on a call that only asked to re-run.
   */
  wasDirection?: LayoutDirection;
  nodeCount: number;
  edgeCount: number;
  elementCount: number;
  keptHandDrawn: number;
  /** Arrows drawn with connect_nodes that were carried across and re-routed. */
  connectors: number;
  /**
   * Whether the direction was written onto the board.
   *
   * A board with no title element has nowhere to keep it, so the flow applies
   * to this drawing and is forgotten by the next one. Reported rather than
   * swallowed: a setting that silently does not persist is worse than one that
   * says it did not.
   */
  remembered: boolean;
  /**
   * Whether the board now reads once rendered.
   *
   * The reason to answer it here as well as in `create_diagram`: trying a flow
   * is the cheapest move this engine offers, and until now the only way to see
   * whether it helped was to render. Taken from the layout pass rather than
   * re-measured after the connectors are re-drawn, because a `connect_nodes`
   * arrow runs between two boxes that are already inside the frame.
   */
  viewable: ViewabilityReport;
}

/**
 * The single generated diagram on a board, or an error naming the choice.
 *
 * Guessing would be the wrong kind of helpful. On a board holding two diagrams
 * either answer moves a picture the caller did not mention.
 */
function soleDiagram(board: BoardFile): string {
  const present = listDiagrams(board);
  if (present.length === 1) return present[0]!.name;
  if (present.length === 0) {
    throw new Error(
      "This board holds no diagram this engine drew. Hand-drawn work is never moved, so there is "
        + "nothing here to re-lay out.",
    );
  }
  throw new Error(
    `This board holds ${present.length} diagrams, so name the one to re-lay out: `
      + `${present.map((summary) => summary.name).join(", ")}.`,
  );
}

/**
 * Lays a diagram out again from the graph already on the board.
 *
 * Implemented as remove-then-redraw rather than as a nudge to each element's
 * coordinates, and that is deliberate. Moving boxes leaves the arrows between
 * them routed for the old positions, and re-routing them is the layout pass --
 * so the choice is between re-running it and reimplementing it. The recovered
 * graph goes back through exactly the path `create_diagram` uses, which is what
 * makes the result identical to the board a redraw would have produced, and
 * what keeps hand-drawn elements as untouched here as they are there.
 */
export async function relayoutDiagram(
  board: BoardFile,
  params: RelayoutParams = {},
): Promise<RelayoutResult> {
  const name = params.name ?? soleDiagram(board);
  const recovered = recoverDiagram(board, name);
  const wasDirection = recovered.direction;
  /*
   * No flow asked for and none recorded is refused, not defaulted.
   *
   * Every board drawn before the flow was recorded says nothing about it, and
   * plenty of them are DOWN -- this repository's own `architecture` board is.
   * Reading that silence as RIGHT would turn "re-run the layout this board has"
   * into "rearrange this board", which is the one thing a caller passing no
   * direction is certainly not asking for. Inferring it from where the boxes
   * sit is available and is worse: a geometric guess reported as a recorded
   * fact is the exact thing `readGraph` refuses to do.
   */
  const direction = params.direction ?? wasDirection;
  if (!direction) {
    throw new Error(
      `Diagram "${name}" has not recorded a layout flow, so there is nothing to re-run: name a `
        + "direction, RIGHT or DOWN. Boards drawn before the flow was recorded say nothing about "
        + "it, and this tool will not guess one from where the boxes happen to sit.",
    );
  }

  const doomed = new Set(
    board.elements
      .filter((element) => element.isDeleted !== true && diagramNameOf(element) === name)
      .map((element) => String(element.id)),
  );
  const connectors = carriedConnectors(board, doomed);

  const cleared = deleteDiagram(board, name);
  const result = await createDiagram(cleared.board, {
    ...recovered.params,
    append: true,
    layout: { direction },
  });
  const rejoined = connectors.length
    ? await connectNodes(result.board, connectors)
    : { board: result.board };

  /*
   * `createDiagram` writes the flow onto the title element, so there is nothing
   * to record here -- only something to check. A board with no title has
   * nowhere to keep it, and a setting that silently does not persist is worse
   * than one that says it did not.
   */
  const remembered = direction === DEFAULT_DIRECTION || directionOf(result.board, name) === direction;
  return {
    board: rejoined.board,
    name,
    direction,
    ...(wasDirection ? { wasDirection } : {}),
    nodeCount: result.nodeCount,
    edgeCount: result.edgeCount,
    elementCount: result.elementCount,
    keptHandDrawn: result.keptHandDrawn,
    connectors: connectors.length,
    remembered,
    viewable: result.viewable,
  };
}
