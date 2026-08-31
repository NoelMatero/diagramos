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
 * one place every hand-made change to a board passes through on its way to disk.
 *
 * ## Why the question is about bindings and not about how much was deleted
 *
 * Deleting is a thing people do, in any number, up to and including all of it --
 * select everything, press Delete, start again. A rule phrased as "this save
 * empties the board" cannot tell that apart from the wreck, and refusing it
 * would break an obvious gesture to defend against a bug that is already fixed.
 *
 * So the rule is about the one thing the wreck did that no deletion does.
 * Excalidraw ties a label to its box from both ends -- the text carries
 * `containerId`, the box carries the text in `boundElements` -- and measured on
 * a live board, every ordinary deletion leaves both ends alone:
 *
 *   - select all and Delete: everything tombstoned, every binding still listed
 *   - delete one labelled box: box and label tombstoned, binding still listed
 *   - clear a label's text:   label tombstoned, box still live, binding dropped
 *   - the #164 wreck:         everything tombstoned, every binding stripped
 *
 * Only the last one has a box dropping a label it is not outliving, and that is
 * exactly what this refuses. The third is the one legitimate case where a
 * binding really does go, and it is told apart by the box still being alive:
 * removing a label from a box that stays is removing a label. Removing it from a
 * box that is going with it is rewriting an element on its way to the grave,
 * which nothing has a reason to do.
 *
 * Only bindings that were whole in the file and are broken in the save count, so
 * a board that somehow got damaged cannot become one that can never be saved.
 */
import type { BoardFile } from "./board-file";

/**
 * Labels whose box has stopped listing them, where that is not the box
 * outliving the label.
 *
 * Keyed by the pair rather than by the label alone, so a label re-bound to a
 * different box is not mistaken for the same fault.
 */
function brokenBindings(board: BoardFile): Set<string> {
  const byId = new Map(board.elements.map((element) => [String(element.id), element]));
  const broken = new Set<string>();
  for (const element of board.elements) {
    if (typeof element.containerId !== "string") continue;
    const container = byId.get(element.containerId);
    if (!container) continue;
    // A label removed from a box that stays: an ordinary edit, and the one
    // shape a person can make that looks like this.
    if (element.isDeleted === true && container.isDeleted !== true) continue;
    const bound = Array.isArray(container.boundElements)
      ? (container.boundElements as Array<{ id?: unknown }>)
      : [];
    if (!bound.some((entry) => String(entry?.id) === String(element.id))) {
      broken.add(`${String(element.id)} -> ${String(container.id)}`);
    }
  }
  return broken;
}

/**
 * The sentence to refuse a save with, or nothing when it is an ordinary edit.
 *
 * Written as something a person can act on rather than as a code: it reaches the
 * board itself and is the only account anybody gets of why their change did not
 * land.
 */
export function wipeRefusal(previous: BoardFile, next: BoardFile): string | undefined {
  const was = brokenBindings(previous);
  const now = [...brokenBindings(next)].filter((pair) => !was.has(pair));
  if (now.length === 0) return undefined;

  const count = `${now.length} ${now.length === 1 ? "label" : "labels"}`;
  return `That save would have torn ${count} off the ${now.length === 1 ? "box that holds it" : "boxes that hold them"} `
    + "— a broken board rather than an edit — so nothing was written. "
    + "The board on screen is the board in the file again.";
}
