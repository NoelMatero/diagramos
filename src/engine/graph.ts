/**
 * Recovers the semantic graph from a board file.
 *
 * Two kinds of content live on a board and they are read very differently:
 *
 * - Anything this engine drew carries `customData`, so its node and edge
 *   identity is read back exactly, and survives you dragging boxes around.
 * - Anything you drew by hand carries nothing, so it is inferred from
 *   geometry: text inside a shape is that shape's label, an arrow endpoint
 *   near a shape connects to it.
 *
 * Inference is always reported as such. A caller deciding whether to trust a
 * label needs to know whether it was recorded or guessed.
 */
import {
  parseArrowClaim, parseBoxClaim, readLabelClaim,
  type ArrowClaim, type BoxClaim, type ParsedClaim,
} from "./claim";
import type { ExcalidrawElement } from "./normalize";
import type { BoardFile } from "./board-file";

export type NodeShape = "rectangle" | "ellipse" | "diamond";
export const NODE_SHAPES: readonly string[] = ["rectangle", "ellipse", "diamond"];

/** How confident we are in a recovered fact. */
export type Provenance = "recorded" | "inferred";

/**
 * What a node claims about *time*, which is a different axis from provenance
 * (who drew it) and from whether its ref resolves (what the disk says).
 *
 * - `built`: this exists in the code now. The default, so every diagram drawn
 *   before this field means exactly what it meant before.
 * - `planned`: this is meant to exist. A ref that does not resolve is then a
 *   work item, not a regression.
 * - `external`: deliberately not code in this repository -- a browser, a
 *   third-party service, another project. Never checked, and distinct from a
 *   node whose ref someone simply forgot.
 *
 * Nothing here records what the filesystem can answer for itself. "Missing" is
 * observed every run and is deliberately not a state: committing it would put a
 * fact with a shelf life into a file, which is the rot this check exists to
 * catch.
 */
export type NodeState = "planned" | "built" | "external";

export const NODE_STATES: readonly NodeState[] = ["planned", "built", "external"];

/**
 * How a declared state is drawn.
 *
 * Both treatments are stroke styles, not colours: unlike a colour they survive
 * greyscale and colour-blindness, and colour is already spoken for -- a board's
 * author uses `backgroundColor` and `strokeColor` to mark subsystems, and a rule
 * that overrode either would fight the picture they are drawing.
 *
 * - `planned` is **dashed**, the established convention for "not real yet".
 * - `external` is **dotted**. It means "real, but not ours", which is a
 *   different question from `planned` and gets a neighbouring answer: related
 *   enough to read as "something is different about this box", distinct enough
 *   to tell apart. It used to be drawn exactly like `built`, so the one state
 *   that is *never checked* looked identical to the one that always is -- the
 *   box saying "do not look here" was indistinguishable from the box saying
 *   "this is verified", which is the wrong way round for a tool whose whole
 *   claim is that the picture and the code agree.
 *
 * The key is omitted for `built` rather than set to `"solid"`, so a board that
 * declares no state stays byte-identical to one written before this existed.
 * Nothing here reads anything but the node's own state, which is what keeps
 * regeneration deterministic.
 *
 * Here rather than in `layout.ts` because three places now need to agree on it,
 * and two of them must not import the layout module -- it instantiates ELK at
 * load time, which is a heavy thing to pull into the Stop hook or the board
 * service. The renderer writes this stroke; `promote.ts` writes the `built`
 * stroke early when a live promotion lands, and puts *this* one back when the
 * evidence for it goes away (#130). A mapping duplicated across those three
 * would drift, and the drift would look like a rendering bug.
 */
export function strokeStyleForState(
  state: NodeState | undefined,
): { strokeStyle?: "dashed" | "dotted" } {
  if (state === "planned") return { strokeStyle: "dashed" };
  if (state === "external") return { strokeStyle: "dotted" };
  return {};
}

/** Unrecognised values fall back to the default rather than throwing: a board is user data. */
function stateOf(value: unknown): NodeState {
  return typeof value === "string" && (NODE_STATES as readonly string[]).includes(value)
    ? (value as NodeState)
    : "built";
}

/**
 * What a whole board is about, recorded on its title element.
 *
 * Measured on this corpus: the forgot-a-ref / deliberately-not-code question
 * mostly lives at board granularity -- the telecom boards are wholly conceptual
 * and describe a protocol, not this repository. One field excuses them honestly
 * instead of reporting dozens of boxes nobody ever intended to annotate.
 *
 * It rides on the title element because `customData` on an element is the only
 * store that survives a round trip through the live viewer: `appState` is pushed
 * back as `{}` on every browser edit (see `src/viewer/App.tsx`), so anything kept
 * there is destroyed the first time someone touches the canvas.
 */
export type BoardDescribes = "repo" | "concept";

export interface RecoveredNode {
  id: string;
  label: string;
  shape: string;
  elementId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  provenance: Provenance;
  /**
   * What this node claims to stand for in the repository: a repo-relative path,
   * or `path#symbol`. Only ever present on recorded nodes, and only when the
   * caller supplied one; drift detection compares it against the working tree.
   */
  ref?: string;
  /**
   * Further anchors, for a box that stands for more than one thing -- a feature
   * spread across files, or a static and the macro that uses it. Each is checked
   * and reported on its own; the box is clean when all of them are.
   *
   * `ref` stays the primary: it is what the arrow check uses for an endpoint,
   * because an arrow connects two points and not two sets.
   */
  refs?: string[];
  /** Whether the node claims to exist yet. Defaults to `built`. */
  state: NodeState;
  /**
   * What this box asserts about the directory it stands for, when it asserts
   * anything. Absent on every box drawn before claims existed, and absence is
   * not a claim: a box that says nothing is checked exactly as it always was.
   */
  claim?: BoxClaim;
  /**
   * A claim written on this box that is not on the vocabulary.
   *
   * Carried rather than dropped so it can be said out loud. A claim nothing
   * judges is indistinguishable from a claim that passed, and silence here
   * would be the engine agreeing with something it never read.
   */
  claimGarbled?: string;
}

/**
 * How an arrow's two ends were resolved to nodes — a different axis from who
 * drew it.
 *
 * - `declared`: from the arrow's own customData. Exact.
 * - `bound`: from Excalidraw's startBinding/endBinding on both ends. Also exact:
 *   the app maintains a binding when either shape moves, so it is a pointer to
 *   a shape rather than an observation about where the line happens to sit.
 * - `nearest`: at least one end was matched to whichever shape it landed close
 *   to. Geometry guesswork, and the only one of the three that can be wrong
 *   about what the author meant.
 *
 * `provenance` cannot express this. It says whether a tool drew the arrow, and a
 * hand-drawn arrow bound at both ends is as precise a claim as a generated one
 * while an unbound one is a guess — so anything deciding how much to trust an
 * edge wants this, not authorship.
 */
export type EdgeEndpoints = "declared" | "bound" | "nearest";

export interface RecoveredEdge {
  from: string;
  to: string;
  label?: string;
  elementId: string;
  provenance: Provenance;
  endpoints: EdgeEndpoints;
  /**
   * Whether the connection claims to exist yet. Defaults to `built`. A `planned`
   * arrow between two built boxes is "wire these up" -- a work item rather than
   * either a drift finding or a silent skip.
   */
  state: NodeState;
  /**
   * The route this connection takes, named hop by hop.
   *
   * An arrow through three layers of indirection is invisible to a check that
   * follows one call. Naming the path turns it into a list of one-hop checks,
   * which is the thing that already works -- and when it breaks, the report can
   * say *which* hop rather than shrugging at the whole arrow.
   */
  via?: string[];
  /**
   * What kind of relationship this arrow asserts, when it says.
   *
   * `customData` is authoritative and the label is the human's way in, in that
   * order. Absent on every arrow drawn before claims existed, and absence is
   * not a claim: an arrow that says nothing is checked exactly as it always was.
   */
  claim?: ArrowClaim;
  /** A claim word that is not on the whitelist, kept so the caller can be loud about it. */
  claimGarbled?: string;
}

export interface RecoveredGraph {
  title?: string;
  /** What the board is about, from its title element. Absent means `repo`. */
  describes?: BoardDescribes;
  nodes: RecoveredNode[];
  edges: RecoveredEdge[];
  /** Elements that are neither node nor edge: annotations, images, strays. */
  unattributed: Array<{ elementId: string; type: string; text?: string; x: number; y: number }>;
  /**
   * Count of arrow elements that failed to resolve at one or both ends.
   * These never make it into edges[] and are the truly dangling arrows.
   */
  strayArrows: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How close an unbound arrow endpoint must sit to count as touching a shape. */
const ENDPOINT_TOLERANCE = 24;

function isLive(element: ExcalidrawElement): boolean {
  return element.isDeleted !== true;
}

function box(element: ExcalidrawElement): Box {
  return {
    x: Number(element.x) || 0,
    y: Number(element.y) || 0,
    width: Number(element.width) || 0,
    height: Number(element.height) || 0,
  };
}

function centerOf(element: ExcalidrawElement): { x: number; y: number } {
  const bounds = box(element);
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function contains(outer: Box, point: { x: number; y: number }): boolean {
  return (
    point.x >= outer.x
    && point.x <= outer.x + outer.width
    && point.y >= outer.y
    && point.y <= outer.y + outer.height
  );
}

function distanceToBox(bounds: Box, point: { x: number; y: number }): number {
  const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width));
  const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height));
  return Math.hypot(dx, dy);
}

/** Absolute coordinates of an arrow's two ends, from its relative points. */
function arrowEndpoints(arrow: ExcalidrawElement): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined {
  const points = arrow.points as Array<[number, number]> | undefined;
  if (!Array.isArray(points) || points.length < 2) return undefined;
  const originX = Number(arrow.x) || 0;
  const originY = Number(arrow.y) || 0;
  const first = points[0];
  const last = points[points.length - 1];
  return {
    start: { x: originX + (first[0] ?? 0), y: originY + (first[1] ?? 0) },
    end: { x: originX + (last[0] ?? 0), y: originY + (last[1] ?? 0) },
  };
}

function customOf(element: ExcalidrawElement): Record<string, unknown> {
  const custom = element.customData;
  return custom && typeof custom === "object" ? (custom as Record<string, unknown>) : {};
}

/**
 * A claim as it was written, whatever shape it was written in.
 *
 * A word (`"needs"`) and a set of flags (`{ closed: true }`) are both plausible
 * things to find in a hand-edited board, and both should be reported by the name
 * their author used rather than by the JSON around it.
 */
function claimWritten(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const set = Object.keys(record).filter((key) => record[key]);
    if (set.length > 0) return set.join("+");
  }
  return undefined;
}

export function readGraph(board: BoardFile): RecoveredGraph {
  const elements = board.elements.filter(isLive);
  const byId = new Map(elements.map((element) => [element.id, element]));

  // Bound labels belong to their container and are never standalone content.
  const labelByContainer = new Map<string, string>();
  for (const element of elements) {
    if (element.type === "text" && typeof element.containerId === "string") {
      labelByContainer.set(element.containerId, String(element.text ?? "").trim());
    }
  }
  const boundLabelIds = new Set(
    elements.filter((element) => typeof element.containerId === "string").map((element) => element.id),
  );

  const shapes = elements.filter((element) => NODE_SHAPES.includes(String(element.type)));
  const consumed = new Set<string>(boundLabelIds);

  // Free-floating text that sits inside a shape is that shape's label. This is
  // how a hand-drawn box with a word typed on top of it becomes a named node.
  const inferredLabelByShape = new Map<string, string>();
  for (const element of elements) {
    if (element.type !== "text" || consumed.has(element.id)) continue;
    const point = centerOf(element);
    const host = shapes.find((shape) => contains(box(shape), point));
    if (!host) continue;
    const text = String(element.text ?? "").trim();
    if (!text) continue;
    inferredLabelByShape.set(host.id, [inferredLabelByShape.get(host.id), text].filter(Boolean).join(" "));
    consumed.add(element.id);
  }

  const nodes: RecoveredNode[] = [];
  const nodeIdByElement = new Map<string, string>();
  for (const shape of shapes) {
    const custom = customOf(shape);
    const recordedId = typeof custom.node === "string" ? custom.node : undefined;
    const id = recordedId ?? shape.id;
    const ref = typeof custom.ref === "string" && custom.ref.trim() ? custom.ref.trim() : undefined;
    const refs = Array.isArray(custom.refs)
      ? custom.refs.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
        .map((entry) => entry.trim())
      : undefined;
    const bounds = box(shape);
    const boxClaim = parseBoxClaim(custom.claim);
    const claimGarbled = boxClaim && "garbled" in boxClaim ? boxClaim.garbled : undefined;
    nodes.push({
      id,
      label: labelByContainer.get(shape.id) ?? inferredLabelByShape.get(shape.id) ?? "",
      shape: String(shape.type),
      elementId: shape.id,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      provenance: recordedId ? "recorded" : "inferred",
      ...(ref ? { ref } : {}),
      ...(refs?.length ? { refs } : {}),
      state: stateOf(custom.state),
      ...(boxClaim && "claim" in boxClaim ? { claim: boxClaim.claim } : {}),
      ...(claimGarbled !== undefined ? { claimGarbled } : {}),
    });
    nodeIdByElement.set(shape.id, id);
    consumed.add(shape.id);
  }

  // Edge labels: on boards written before labels were bound to their arrows, a
  // free text element names its edge through `edgeLabelFor`; otherwise a free
  // text element is matched to the nearest arrow it plausibly annotates.
  const arrows = elements.filter((element) => element.type === "arrow");
  const recordedEdgeLabel = new Map<string, string>();
  const looseLabels: ExcalidrawElement[] = [];
  for (const element of elements) {
    if (element.type !== "text" || consumed.has(element.id)) continue;
    const custom = customOf(element);
    const target = custom.edgeLabelFor;
    if (typeof target === "string") {
      recordedEdgeLabel.set(target, String(element.text ?? "").trim());
      consumed.add(element.id);
    } else {
      looseLabels.push(element);
    }
  }

  const edges: RecoveredEdge[] = [];
  let strayArrows = 0;
  for (const arrow of arrows) {
    const custom = customOf(arrow);
    const recorded = custom.edge as { from?: string; to?: string; claim?: unknown } | undefined;
    const via = Array.isArray(custom.via)
      ? custom.via.filter((hop): hop is string => typeof hop === "string" && hop.trim() !== "")
        .map((hop) => hop.trim())
      : undefined;
    let from: string | undefined;
    let to: string | undefined;
    let provenance: Provenance = "recorded";
    let endpoints: EdgeEndpoints = "declared";

    if (recorded && typeof recorded.from === "string" && typeof recorded.to === "string") {
      from = recorded.from;
      to = recorded.to;
    } else {
      // Explicit bindings are still authoritative even without customData:
      // Excalidraw maintains them when either shape moves.
      const startId = (arrow.startBinding as { elementId?: string } | null)?.elementId;
      const endId = (arrow.endBinding as { elementId?: string } | null)?.elementId;
      from = startId ? nodeIdByElement.get(startId) : undefined;
      to = endId ? nodeIdByElement.get(endId) : undefined;
      provenance = "inferred";
      // Both ends resolved through a binding: exact. Anything the proximity
      // fallback below has to supply drops this to a guess, including the case
      // where one end was bound and the other was not.
      endpoints = from && to ? "bound" : "nearest";

      // Nothing bound: fall back to whichever shapes the ends land on.
      const ends = arrowEndpoints(arrow);
      if ((!from || !to) && ends) {
        const nearest = (point: { x: number; y: number }) => {
          let best: { id: string; distance: number } | undefined;
          for (const shape of shapes) {
            const distance = distanceToBox(box(shape), point);
            if (distance <= ENDPOINT_TOLERANCE && (!best || distance < best.distance)) {
              best = { id: nodeIdByElement.get(shape.id) ?? shape.id, distance };
            }
          }
          return best?.id;
        };
        from ??= nearest(ends.start);
        to ??= nearest(ends.end);
      }
    }

    consumed.add(arrow.id);
    if (!from || !to) {
      strayArrows += 1;
      continue;
    }

    // An exact label is one somebody put on *this* arrow: generated with the
    // diagram, or typed onto the arrow in the app. Only those are read for a
    // claim, and only those are shouted at for a bad one -- the fallback below
    // guesses which arrow a loose piece of text belongs to, and being loud
    // about a guess is how a legend two boxes away becomes an error.
    // The bound label wins. On a board written before edge labels were bound
    // there can be both, and the bound one is then the newer of the two: the
    // generated text came with the diagram, and the only way a bound label got
    // onto that arrow is that somebody typed it. Reading the generated one
    // first made a hand-typed claim unreadable -- and, worse, made a hand-typed
    // word that is *not* a claim unrefusable, so the vocabulary could rot
    // quietly. Whoever touched the arrow last is who the arrow speaks for.
    const exactLabel = labelByContainer.get(arrow.id) ?? recordedEdgeLabel.get(arrow.id);
    let label = exactLabel;
    let labelClaim: ParsedClaim | undefined;
    if (exactLabel) {
      const read = readLabelClaim(exactLabel);
      label = read.text;
      labelClaim = read.parsed;
    }
    if (!exactLabel) {
      const ends = arrowEndpoints(arrow);
      if (ends) {
        const midpoint = { x: (ends.start.x + ends.end.x) / 2, y: (ends.start.y + ends.end.y) / 2 };
        let best: { element: ExcalidrawElement; distance: number } | undefined;
        for (const candidate of looseLabels) {
          if (consumed.has(candidate.id)) continue;
          const distance = Math.hypot(
            centerOf(candidate).x - midpoint.x,
            centerOf(candidate).y - midpoint.y,
          );
          if (distance < 80 && (!best || distance < best.distance)) best = { element: candidate, distance };
        }
        if (best) {
          label = String(best.element.text ?? "").trim();
          consumed.add(best.element.id);
        }
      }
    }

    // `customData` wins the value, and a garbled label is still reported: the
    // two are different questions. One asks what this arrow claims, the other
    // asks whether somebody typed a word that means nothing.
    const written = recorded?.claim === undefined ? undefined : claimWritten(recorded.claim);
    const declared = written === undefined ? undefined : parseArrowClaim(written);
    const claim = declared && "claim" in declared
      ? declared.claim
      : labelClaim && "claim" in labelClaim ? labelClaim.claim : undefined;
    const claimGarbled = declared && "garbled" in declared
      ? declared.garbled
      : labelClaim && "garbled" in labelClaim ? labelClaim.garbled : undefined;

    edges.push({
      from,
      to,
      ...(label ? { label } : {}),
      elementId: arrow.id,
      provenance,
      endpoints,
      state: stateOf(custom.state),
      ...(via?.length ? { via } : {}),
      ...(claim ? { claim } : {}),
      // `!== undefined` rather than truthy: a lone "@" is a word somebody meant
      // to finish, and it says nothing, so it is reported and not swallowed.
      ...(claimGarbled !== undefined ? { claimGarbled } : {}),
    });
  }

  const titleElement = elements.find((element) => customOf(element).role === "title");
  const describesRaw = titleElement ? customOf(titleElement).describes : undefined;
  const describes: BoardDescribes | undefined =
    describesRaw === "concept" || describesRaw === "repo" ? describesRaw : undefined;
  const unattributed = elements
    .filter((element) => !consumed.has(element.id) && element.id !== titleElement?.id)
    .map((element) => ({
      elementId: element.id,
      type: String(element.type),
      ...(typeof element.text === "string" && element.text.trim() ? { text: element.text.trim() } : {}),
      x: Number(element.x) || 0,
      y: Number(element.y) || 0,
    }));

  return {
    ...(titleElement ? { title: String(titleElement.text ?? "").trim() } : {}),
    ...(describes ? { describes } : {}),
    nodes,
    edges,
    unattributed,
    strayArrows,
  };
}
