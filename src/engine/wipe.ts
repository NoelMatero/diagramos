/**
 * What a save from the live page is never allowed to do to a board.
 *
 * A diagram lives in the repo and is committed there, so the worst thing this
 * tool can do is not a wrong finding -- it is emptying a file somebody trusted
 * it with. That happened (#164): Excalidraw's undo is a delta against a snapshot
 * the viewer forgot to keep in step, so one Ctrl+Z on a freshly loaded board
 * inverted "these 157 elements arrived" into "these 157 elements go". Every
 * element came back tombstoned, every container lost its `boundElements`, and
 * the page saved that over the file. Nothing in any channel said a word: the
 * file kept its size, the drift check passed, and the board rendered blank.
 *
 * The cause is fixed where it was, in the viewer. This is the second line: the
 * one place every hand-made change to a board passes through on its way to disk,
 * asking whether the thing being written is a drawing or a wreck.
 *
 * ## Why these two questions and not a general "did too much change"
 *
 * Both are answered by comparing the save against the file it claims to replace,
 * and both describe a board that is internally inconsistent rather than merely
 * different. A size threshold would have to guess at how much deletion is too
 * much; these do not guess. They also stay quiet about damage that is already on
 * disk -- only bindings that were whole before and are broken now count -- so a
 * board that somehow got corrupted cannot become one that can never be saved
 * again.
 *
 * ## What is deliberately not refused
 *
 * Deleting elements, in any number, as long as something is left. Measured on a
 * real board: a hand-made select-all-and-delete tombstones every element and
 * leaves `boundElements` intact, so it reads differently from the wipe and is
 * caught by the first rule alone -- which is the one case where this refuses
 * something a person could have meant. Emptying a board on purpose is what
 * `delete_diagram` is for, and the refusal says so.
 */
import type { BoardFile } from "./board-file";
import type { ExcalidrawElement } from "./normalize";

const live = (elements: readonly ExcalidrawElement[]): ExcalidrawElement[] =>
  elements.filter((element) => element.isDeleted !== true);

/**
 * Labels whose box has stopped listing them.
 *
 * Excalidraw ties a label to its container from both ends: the text carries
 * `containerId`, the container carries the text in `boundElements`. One
 * direction without the other is not a style choice, it is a half-erased
 * binding -- the label is on the board, the box it belongs to does not know, and
 * nothing renders it in place.
 *
 * Live elements only, both ends. A tombstoned label dropped from its container's
 * list is an ordinary deletion, which is the shape a person makes when they
 * remove a label on purpose.
 */
function orphanedLabels(board: BoardFile): Set<string> {
  const containers = new Map(live(board.elements).map((element) => [String(element.id), element]));
  const orphaned = new Set<string>();
  for (const element of live(board.elements)) {
    if (typeof element.containerId !== "string") continue;
    const container = containers.get(element.containerId);
    if (!container) continue;
    const bound = Array.isArray(container.boundElements)
      ? (container.boundElements as Array<{ id?: unknown }>)
      : [];
    if (!bound.some((entry) => String(entry?.id) === String(element.id))) {
      orphaned.add(String(element.id));
    }
  }
  return orphaned;
}

/**
 * The sentence to refuse a save with, or nothing when it is an ordinary edit.
 *
 * Written as something a person can act on rather than as a code: it reaches the
 * status pill on the board and is the only account anybody gets of why their
 * change did not land.
 */
export function wipeRefusal(previous: BoardFile, next: BoardFile): string | undefined {
  const before = live(previous.elements).length;
  const after = live(next.elements).length;
  if (before > 0 && after === 0) {
    return `That save would have emptied a board with ${before} ${before === 1 ? "element" : "elements"} on it, `
      + "so nothing was written. The board on screen is the board in the file again. "
      + "To clear a diagram on purpose, use delete_diagram.";
  }

  const was = orphanedLabels(previous);
  const now = [...orphanedLabels(next)].filter((id) => !was.has(id));
  if (now.length > 0) {
    return `That save would have left ${now.length} ${now.length === 1 ? "label" : "labels"} attached to a box `
      + "that no longer lists them — a broken board rather than an edit — so nothing was written. "
      + "The board on screen is the board in the file again.";
  }

  return undefined;
}
