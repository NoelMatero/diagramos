/**
 * What a selected box or arrow means, and how a person changes it.
 *
 * A box on the canvas shows a label, a colour and a position. Everything that
 * makes it a *claim about the code* -- which file it stands for, whether that
 * file exists yet, what it asserts about its neighbours -- lives in
 * `customData`, and Excalidraw's own UI has no field for `customData`. So the
 * meaning was readable only by opening the `.excalidraw` JSON (#114) and
 * writable only by asking an agent (#111). This module is the reading and the
 * writing, as plain data, so the panel around it stays a rendering of it.
 *
 * Pure functions on purpose, like `drift.ts` and `reveal.ts` beside it: a scene
 * goes in and a scene comes out, which is testable without a browser and is the
 * only reason the rules below are pinned rather than eyeballed.
 *
 * **It does not import the engine.** Nothing in `src/viewer` does. This bundle
 * is built separately and served from disk, so it can be older than the engine
 * answering it, and a shared import would hide that rather than fix it. The
 * vocabulary is therefore restated here -- three states, one box claim, one
 * arrow claim -- exactly as `drift.ts` restates the verdict words it knows.
 *
 * Two couplings are enforced here rather than left to whoever clicks:
 *
 * - **`planned` is drawn dashed.** The engine draws it that way when *it*
 *   writes a board, so a person marking a box planned by hand and getting a
 *   solid box would produce a file whose picture disagrees with its meaning.
 *   Un-marking restores solid only where this module did the dashing, so it
 *   never stomps a stroke somebody chose.
 * - **A sketch gains an identity the moment it gains meaning.** A hand-drawn
 *   box carries no `node`, so the engine reads it as inferred and never lets it
 *   make a claim. Giving it a file has to make it a real, checked box, and the
 *   person doing it should not have to know that is what happened.
 */

/** The three answers to "does this exist yet". `built` is the default and is never written. */
export type NodeState = "built" | "planned" | "external";

export const STATE_WORDS: Record<NodeState, string> = {
  built: "Built",
  planned: "Planned",
  external: "Not our code",
};

/**
 * What an arrow can claim, and the words for it.
 *
 * Mirrored from `claim.ts` rather than imported, the same way `NodeState` above
 * is: this module has no imports on purpose, so the panel is a pure function of
 * a scene and nothing drags the engine into the browser bundle. The cost is that
 * a word added there has to be added here, and the cost of getting it wrong is
 * small and visible -- a tick the checker ignores, or a claim with no tick.
 *
 * The sentences are the panel's own, because the panel is where a person reads
 * them: a claim nobody understands is a claim nobody should be ticking.
 */
export type ArrowClaim = "needs" | "feeds";

const CLAIM_WORDS: readonly ArrowClaim[] = ["needs", "feeds"];

/** The shapes that count as a box, matching what the engine reads as a node. */
const NODE_SHAPES = ["rectangle", "diamond", "ellipse"];

export interface SceneElement {
  id: string;
  type: string;
  text?: string;
  containerId?: string | null;
  isDeleted?: boolean;
  strokeStyle?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  version?: number;
  customData?: Record<string, unknown>;
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
  [key: string]: unknown;
}

export interface BoxMeaning {
  kind: "box";
  elementId: string;
  /** The words on the box, for the panel's heading. */
  title: string;
  /** The engine's id for it. Absent means hand-drawn: it has no identity yet. */
  node?: string;
  /** Every file this box stands for, primary first. Empty is an honest answer. */
  refs: string[];
  state: NodeState;
  /** The `closed` claim: nothing outside reaches in, except through these. */
  closed?: { through: string[] };
}

export interface ArrowMeaning {
  kind: "arrow";
  elementId: string;
  /** The two ends in words, for the panel's heading. Falls back to ids. */
  fromLabel: string;
  toLabel: string;
  node?: string;
  state: NodeState;
  /** What this arrow claims, when it claims anything. */
  claim?: ArrowClaim;
  /**
   * Whether the arrow carries a visible label. A claim is meant to be readable
   * on the board, and with no label there is nowhere to read it -- so the panel
   * says so instead of recording the claim where only a file reader finds it.
   */
  labelled: boolean;
}

export type Meaning = BoxMeaning | ArrowMeaning;

function live(elements: readonly SceneElement[]): SceneElement[] {
  return elements.filter((element) => !element.isDeleted);
}

function customOf(element: SceneElement): Record<string, unknown> {
  const custom = element.customData;
  return custom && typeof custom === "object" ? custom : {};
}

function stateOf(value: unknown): NodeState {
  return value === "planned" || value === "external" ? value : "built";
}

/** The words bound inside a container, which is where a drawn label lives. */
function boundLabels(elements: readonly SceneElement[]): Map<string, SceneElement> {
  const found = new Map<string, SceneElement>();
  for (const element of elements) {
    if (element.type === "text" && typeof element.containerId === "string") {
      found.set(element.containerId, element);
    }
  }
  return found;
}

function centre(element: SceneElement): { x: number; y: number } {
  return {
    x: (Number(element.x) || 0) + (Number(element.width) || 0) / 2,
    y: (Number(element.y) || 0) + (Number(element.height) || 0) / 2,
  };
}

/**
 * A shape's words: the label bound to it, or -- the way a hand-drawn box gets
 * named -- a free-floating text element sitting on top of it.
 */
function titleOf(shape: SceneElement, elements: readonly SceneElement[], labels: Map<string, SceneElement>): string {
  const bound = labels.get(shape.id);
  if (bound) return String(bound.text ?? "").trim();
  const left = Number(shape.x) || 0;
  const top = Number(shape.y) || 0;
  const right = left + (Number(shape.width) || 0);
  const bottom = top + (Number(shape.height) || 0);
  const inside = elements.filter((element) => {
    if (element.type !== "text" || typeof element.containerId === "string") return false;
    const point = centre(element);
    return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
  });
  return inside.map((element) => String(element.text ?? "").trim()).filter(Boolean).join(" ");
}

/** Every box's words, by the id the engine knows it as, so an arrow can name its ends. */
function labelByNode(elements: readonly SceneElement[]): Map<string, string> {
  const labels = boundLabels(elements);
  const found = new Map<string, string>();
  for (const shape of elements) {
    if (!NODE_SHAPES.includes(shape.type)) continue;
    const custom = customOf(shape);
    const node = typeof custom.node === "string" ? custom.node : shape.id;
    const title = titleOf(shape, elements, labels);
    if (title) found.set(node, title);
  }
  return found;
}

/** The node id at one end of an arrow, read from its binding when nothing was recorded. */
function boundNode(binding: { elementId?: string } | null | undefined, elements: readonly SceneElement[]): string | undefined {
  const target = binding?.elementId;
  if (!target) return undefined;
  const element = elements.find((candidate) => candidate.id === target);
  if (!element) return undefined;
  const custom = customOf(element);
  return typeof custom.node === "string" ? custom.node : element.id;
}

/**
 * Whether an arrow's label claims `needs`, in the `@word` form the engine reads
 * back off the canvas. `customData` wins the value where both are present, but
 * the tick in the panel has to reflect either, because either is a real way the
 * claim got there.
 */
function labelClaim(text: string): ArrowClaim | undefined {
  const marked = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.startsWith("@"))
    .map((word) => word.slice(1).toLowerCase());
  const known = marked.filter((word): word is ArrowClaim => CLAIM_WORDS.includes(word as ArrowClaim));
  // Two claims is not two facts, and the engine refuses them outright. Here it
  // means there is nothing single to tick, which is the honest state to show.
  return known.length === 1 ? known[0] : undefined;
}

function claimOf(custom: Record<string, unknown>, label: string): ArrowClaim | undefined {
  const edge = custom.edge;
  const written = edge && typeof edge === "object" ? (edge as Record<string, unknown>).claim : undefined;
  if (typeof written === "string") {
    const word = written.trim().toLowerCase() as ArrowClaim;
    return CLAIM_WORDS.includes(word) ? word : undefined;
  }
  return labelClaim(label);
}

/** The `closed` claim as the panel needs it, from either shape the engine accepts. */
function closedOf(value: unknown): { through: string[] } | undefined {
  if (typeof value === "string") {
    return value.trim().toLowerCase().replace(/^@/, "") === "closed" ? { through: [] } : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.closed !== true) return undefined;
  const through = Array.isArray(record.through) ? record.through.map((entry) => String(entry)) : [];
  return { through };
}

/**
 * What the selected element means, or nothing when the selection is not one
 * thing the board makes claims about.
 *
 * One element only. A multi-selection has no single meaning, and inventing one
 * -- "these three boxes" -- would be the panel guessing on a canvas whose whole
 * stance is that guesses do not get to make claims.
 */
export function meaningOf(elements: readonly SceneElement[], selectedId: string | undefined): Meaning | undefined {
  if (!selectedId) return undefined;
  const all = live(elements);
  const element = all.find((candidate) => candidate.id === selectedId);
  if (!element) return undefined;

  const custom = customOf(element);

  if (NODE_SHAPES.includes(element.type)) {
    const primary = typeof custom.ref === "string" && custom.ref.trim() ? custom.ref.trim() : undefined;
    const extra = Array.isArray(custom.refs)
      ? custom.refs.map((entry) => String(entry).trim()).filter(Boolean)
      : [];
    return {
      kind: "box",
      elementId: element.id,
      title: titleOf(element, all, boundLabels(all)),
      ...(typeof custom.node === "string" ? { node: custom.node } : {}),
      refs: [...(primary ? [primary] : []), ...extra],
      state: stateOf(custom.state),
      ...(closedOf(custom.claim) ? { closed: closedOf(custom.claim)! } : {}),
    };
  }

  if (element.type === "arrow") {
    const edge = custom.edge && typeof custom.edge === "object" ? (custom.edge as Record<string, unknown>) : undefined;
    const names = labelByNode(all);
    const from = typeof edge?.from === "string" ? edge.from : boundNode(element.startBinding, all);
    const to = typeof edge?.to === "string" ? edge.to : boundNode(element.endBinding, all);
    const label = boundLabels(all).get(element.id);
    const text = String(label?.text ?? "").trim();
    return {
      kind: "arrow",
      elementId: element.id,
      fromLabel: (from ? names.get(from) : undefined) ?? from ?? "something",
      toLabel: (to ? names.get(to) : undefined) ?? to ?? "something",
      ...(from && to ? { node: `${from} -> ${to}` } : {}),
      state: stateOf(custom.state),
      ...(claimOf(custom, text) ? { claim: claimOf(custom, text) } : {}),
      labelled: Boolean(label),
    };
  }

  return undefined;
}

/**
 * Whether a ref names something the repository actually has.
 *
 * Answered on the page, against the file list the picker is already holding, so
 * a mistyped anchor is contradicted while the cursor is still in the field
 * rather than in a report on the next turn. It is deliberately the cheap half
 * of the question: the engine decides whether a *symbol* is declared and whether
 * anything uses it, and this only ever says the file or directory is there. A
 * tick here is "somewhere to look", never "checked".
 */
export function refExists(paths: ReadonlySet<string>, ref: string): boolean {
  const wanted = ref.trim().split("#")[0]!.replace(/\/+$/, "");
  if (!wanted) return false;
  if (paths.has(wanted)) return true;
  const inside = `${wanted}/`;
  for (const candidate of paths) if (candidate.startsWith(inside)) return true;
  return false;
}

export type Edit =
  /** Every file this box stands for, primary first. An empty list clears them. */
  | { set: "refs"; refs: string[] }
  | { set: "state"; state: NodeState }
  | { set: "closed"; closed: boolean; through?: string[] }
  /** `undefined` takes the claim away, which is the panel's only way to say "no claim". */
  | { set: "claim"; claim?: ArrowClaim };

function bump(element: SceneElement, changes: Partial<SceneElement>): SceneElement {
  return { ...element, ...changes, version: (Number(element.version) || 1) + 1 };
}

/** `built` is the default and is never written, so clearing it means removing the key. */
function withCustom(element: SceneElement, changes: Record<string, unknown>): Record<string, unknown> {
  const next = { ...customOf(element), ...changes };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) delete next[key];
  }
  return next;
}

/**
 * The label text for an arrow, with the claim added or taken away.
 *
 * Every known word comes off first, whichever one was there: an arrow asserts
 * one thing, so switching from `@needs` to `@feeds` must not leave a label
 * claiming both -- which the engine reads as garbled and refuses, loudly.
 */
export function labelWithClaim(text: string, claim?: ArrowClaim): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const plain = words.filter(
    (word) => !(word.startsWith("@") && CLAIM_WORDS.includes(word.slice(1).toLowerCase() as ArrowClaim)),
  );
  if (!claim) return plain.join(" ");
  return [...plain, `@${claim}`].join(" ").trim();
}

/**
 * Apply one change to the scene and hand back a new scene.
 *
 * Whole scene in, whole scene out, because an edit is not always one element:
 * claiming `needs` writes the arrow's own record *and* the words on its label,
 * since a claim nobody can see on the board is a claim nobody can refuse.
 */
export function editScene(
  elements: readonly SceneElement[],
  elementId: string,
  edit: Edit,
): SceneElement[] {
  const all = live(elements);
  const target = all.find((candidate) => candidate.id === elementId);
  if (!target) return [...elements];

  const isBox = NODE_SHAPES.includes(target.type);
  const custom = customOf(target);
  let changes: Record<string, unknown> = {};
  let element: Partial<SceneElement> = {};

  if (edit.set === "refs" && isBox) {
    const refs = edit.refs.map((entry) => entry.trim()).filter(Boolean);
    changes = {
      ref: refs[0],
      refs: refs.length > 1 ? refs.slice(1) : undefined,
    };
  }

  if (edit.set === "state") {
    changes = { state: edit.state === "built" ? undefined : edit.state };
    /*
     * The picture has to agree with the meaning, and nobody should have to
     * remember to make it agree.
     *
     * The strokes are the engine's, restated: `layout.ts` draws `planned`
     * dashed and `external` dotted when *it* writes a board, so a box set by
     * hand has to land on the same stroke or the two routes disagree about a
     * board neither of them owns.
     *
     * Going back to `built` restores solid only when there was a treatment to
     * undo. That is the rule `promote.ts` follows when a planned box's code
     * lands -- it writes exactly what regenerating as `built` would write --
     * and it is what keeps this from stomping a stroke somebody chose on a box
     * that was never anything but built.
     */
    const STROKE: Record<NodeState, "solid" | "dashed" | "dotted"> = {
      built: "solid",
      planned: "dashed",
      external: "dotted",
    };
    if (edit.state !== "built") element = { strokeStyle: STROKE[edit.state] };
    else if (stateOf(custom.state) !== "built") element = { strokeStyle: "solid" };
  }

  if (edit.set === "closed" && isBox) {
    changes = {
      claim: edit.closed
        // Always with `through`, even empty: an empty list is the claim of total
        // isolation, and it must not read like a claim whose doors went missing.
        ? { closed: true, through: (edit.through ?? []).map((entry) => entry.trim()).filter(Boolean) }
        : undefined,
    };
  }

  if (edit.set === "claim" && target.type === "arrow") {
    const edge = custom.edge && typeof custom.edge === "object" ? (custom.edge as Record<string, unknown>) : {};
    const from = typeof edge.from === "string" ? edge.from : boundNode(target.startBinding, all);
    const to = typeof edge.to === "string" ? edge.to : boundNode(target.endBinding, all);
    changes = {
      edge: {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(edit.claim ? { claim: edit.claim } : {}),
      },
    };
  }

  // A sketch becomes a real, checked box the moment it is given something to
  // check. Without an id of its own the engine reads it as inferred and refuses
  // to let it claim anything, which would make this whole panel a no-op on
  // exactly the boxes a person drew themselves.
  const gainsMeaning = Object.values(changes).some((value) => value !== undefined);
  if (isBox && gainsMeaning && typeof custom.node !== "string") changes.node = target.id;

  const nextCustom = withCustom(target, changes);
  const patched = bump(target, {
    ...element,
    customData: Object.keys(nextCustom).length > 0 ? nextCustom : undefined,
  });

  const label = boundLabels(all).get(elementId);
  const relabel =
    edit.set === "claim" && label
      ? bump(label, {
          text: labelWithClaim(String(label.text ?? ""), edit.claim),
          originalText: labelWithClaim(String(label.originalText ?? label.text ?? ""), edit.claim),
        })
      : undefined;

  return elements.map((candidate) => {
    if (candidate.id === patched.id) return patched;
    if (relabel && candidate.id === relabel.id) return relabel;
    return candidate;
  });
}
