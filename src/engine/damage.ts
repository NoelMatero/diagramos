/**
 * Whether a board file still agrees with itself.
 *
 * Excalidraw ties two elements together from both ends. A label carries
 * `containerId` naming its box, and the box carries the label's id in
 * `boundElements`; an arrow carries `startBinding`/`endBinding` naming two
 * shapes, and each shape carries the arrow in `boundElements`. Written
 * correctly, the two directions always say the same thing.
 *
 * A board arrived that did not (#165). One direction had been stripped and the
 * other survived, and the two readers of a board picked different ones:
 *
 *   - `readGraph` resolves a label through `containerId` -- the one that lived.
 *   - Excalidraw draws it through `boundElements` -- the one that died.
 *
 * So `read_diagram` reported 34 nodes and 44 edges with every label correct,
 * `check_drift` passed clean, and the picture on screen was blank. Nothing in
 * any text channel could say otherwise; a person looking at it found out.
 *
 * That is this tool's own argument -- a picture and the thing it describes must
 * not be allowed to disagree quietly -- failing at the picture and its own model
 * of the picture. So the two directions are compared here, and any disagreement
 * is reported as a fact about the *file* rather than about the diagram's claims.
 * Nothing about the code has changed and no claim has failed: the board cannot
 * be trusted to say anything at all.
 *
 * ## Why hand-drawn boards cannot trip this
 *
 * Every question below starts from a binding that already exists and asks
 * whether the far end agrees. A loose board with no bindings on it -- boxes and
 * text sitting on top of each other, arrows pointing at nothing, which is what
 * inference exists to read -- has nothing to disagree about and reports nothing.
 * Absent structure is not damage. Contradictory structure is.
 *
 * ## Why only ids missing from the file count as a broken list
 *
 * A container listing an element that is merely tombstoned is ordinary: deleting
 * a labelled box tombstones both and leaves the binding listed, which is what
 * `wipe.ts` measured on a live board. The damage is a name pointing at nothing,
 * so that is the only thing asked about here.
 */
import type { ExcalidrawElement } from "./normalize";
import type { BoardFile } from "./board-file";

/**
 * The three ways the two directions can contradict each other.
 *
 * Named by what is wrong with the file rather than by what it does to the
 * picture, because what it does to the picture depends on which reader you ask
 * -- and that disagreement is the whole defect.
 */
export type BindingFaultKind =
  /** A label names a box, and the box does not list the label. */
  | "label-not-listed"
  /** An element lists something bound to it that is not in the file. */
  | "bound-element-missing"
  /** An arrow is bound to a shape, and the shape does not list the arrow. */
  | "arrow-not-listed";

export interface BindingFault {
  kind: BindingFaultKind;
  /** The element whose own record is intact. */
  elementId: string;
  /** The element at the other end, whose record disagrees or is absent. */
  otherId: string;
  /** What is wrong, in a sentence, for a reader with no Excalidraw in their head. */
  detail: string;
}

function isLive(element: ExcalidrawElement): boolean {
  return element.isDeleted !== true;
}

function labelOf(element: ExcalidrawElement | undefined): string {
  const text = String(element?.text ?? "").trim();
  return text ? `"${text}"` : String(element?.type ?? "element");
}

/**
 * Every place the file contradicts itself, in element order so two runs over an
 * unchanged board report the same thing in the same order.
 *
 * Live elements only. A board whose elements are all tombstoned is empty rather
 * than damaged, and reads back as empty, which is a thing every channel can
 * already say.
 */
export function bindingDamage(board: BoardFile): BindingFault[] {
  const elements = board.elements;
  const byId = new Map(elements.map((element) => [String(element.id), element]));
  const live = elements.filter(isLive);
  const faults: BindingFault[] = [];

  const listsBack = (holder: ExcalidrawElement | undefined, id: string): boolean => {
    const bound = Array.isArray(holder?.boundElements)
      ? (holder.boundElements as Array<{ id?: unknown }>)
      : [];
    return bound.some((entry) => String(entry?.id) === id);
  };

  for (const element of live) {
    const id = String(element.id);

    // A label naming a box that does not name it back. This is the one that
    // blanked a board: the label is in the file, the read finds it, and nothing
    // draws it.
    if (typeof element.containerId === "string" && element.containerId) {
      const container = byId.get(element.containerId);
      if (!container) {
        faults.push({
          kind: "label-not-listed",
          elementId: id,
          otherId: element.containerId,
          detail: `the label ${labelOf(element)} belongs to a box that is not in this file`,
        });
      } else if (!listsBack(container, id)) {
        faults.push({
          kind: "label-not-listed",
          elementId: id,
          otherId: String(container.id),
          detail: `the label ${labelOf(element)} belongs to a ${String(container.type)}`
            + " that has no record of it, so nothing will draw it",
        });
      }
    }

    // A list naming something that was never here or is long gone.
    if (Array.isArray(element.boundElements)) {
      for (const entry of element.boundElements as Array<{ id?: unknown }>) {
        const other = String(entry?.id ?? "");
        if (!other || byId.has(other)) continue;
        faults.push({
          kind: "bound-element-missing",
          elementId: id,
          otherId: other,
          detail: `the ${String(element.type)} ${labelOf(element)} lists something attached to it`
            + " that is not in this file",
        });
      }
    }

    // An arrow held by a shape that is not holding it. The arrow still points
    // where it always did, and the shape will not move it or redraw it.
    if (element.type === "arrow") {
      for (const end of ["startBinding", "endBinding"] as const) {
        const shapeId = (element[end] as { elementId?: unknown } | null | undefined)?.elementId;
        if (typeof shapeId !== "string" || !shapeId) continue;
        const shape = byId.get(shapeId);
        const side = end === "startBinding" ? "starts at" : "ends at";
        if (!shape) {
          faults.push({
            kind: "arrow-not-listed",
            elementId: id,
            otherId: shapeId,
            detail: `an arrow ${side} a shape that is not in this file`,
          });
        } else if (!listsBack(shape, id)) {
          faults.push({
            kind: "arrow-not-listed",
            elementId: id,
            otherId: shapeId,
            detail: `an arrow ${side} ${labelOf(shape)}, which has no record of it`,
          });
        }
      }
    }
  }

  return faults;
}

/**
 * What to tell somebody whose board is damaged, or nothing when it is whole.
 *
 * Deliberately not phrased as a finding. A finding says a claim on the board
 * disagrees with the code and names the claim; this says the board itself cannot
 * be read, so every other answer about it -- including a clean drift check -- is
 * worth nothing. It leads with what they will see, because that is what sent
 * them looking.
 */
export function damageSentence(faults: BindingFault[]): string | undefined {
  if (faults.length === 0) return undefined;
  const count = `${faults.length} ${faults.length === 1 ? "connection" : "connections"}`;
  const labels = faults.filter((fault) => fault.kind === "label-not-listed").length;
  const missing = faults.filter((fault) => fault.kind === "bound-element-missing").length;
  const arrows = faults.filter((fault) => fault.kind === "arrow-not-listed").length;
  const parts = [
    labels ? `${labels} ${labels === 1 ? "label is" : "labels are"} not attached to the box that holds ${labels === 1 ? "it" : "them"}` : undefined,
    arrows ? `${arrows} ${arrows === 1 ? "arrow is not attached to the shape it points at" : "arrows are not attached to the shapes they point at"}` : undefined,
    missing ? `${missing} ${missing === 1 ? "element points" : "elements point"} at something that is not in the file` : undefined,
  ].filter(Boolean);
  return `This board is damaged: ${count} inside it disagree about themselves — `
    + `${parts.join(", ")}. It will not draw the way it reads. `
    + "Nothing here is a claim about your code; treat every other answer about this board as unreliable "
    + "until the file is repaired.";
}
