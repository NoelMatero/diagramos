/**
 * Writes a followed ref back to the board: the board repairing its own address.
 *
 * `follow.ts` works out where the code behind a stale box went and stops there,
 * on purpose -- the measurement that allowed it (`docs/rebind-measurement.md`)
 * also found the one way it goes wrong, and a wrong rebind is silent. So the
 * suggestion is shown and nothing moves.
 *
 * This is the other end of that, and it is opt-in for exactly that reason. It
 * runs when somebody asks (`drift --repair`), never on the per-turn path, and it
 * says every ref it changed and what it changed it from. A repair nobody can see
 * is the failure mode; a repair somebody asked for and can read is not.
 *
 * ## What it will not touch
 *
 * - **Anything without one unambiguous answer.** Only `becomes` is applied. A
 *   followed ref carrying `candidates` is the follower declining, and this
 *   declines with it.
 * - **Hand-drawn elements**, by construction, the same way `promote.ts` manages
 *   it: every repair is matched back to an element through the *recorded* graph,
 *   and an `inferred` node never reaches this module at all -- `drift.ts` drops
 *   those before following, because their ref was read off a label rather than
 *   written by anyone.
 * - **A ref that has since changed.** The old string has to still be on the box.
 *   If it is not, the board moved under the report and the answer is stale, so
 *   the entry is held rather than applied.
 * - **The rest of the box.** Its label, its state, its position and its other
 *   anchors are left exactly as they were. This edits an address and nothing
 *   else, which is the whole claim being made about it.
 */
import type { BoardFile } from "./board-file";
import type { DriftReport } from "./drift";
import type { FollowChannel, FollowedRef } from "./follow";
import { readGraph } from "./graph";

export interface AppliedRepair {
  node: string;
  label: string;
  /** The ref that was on the box. Kept so a report can show the change, and so it can be undone by reading it. */
  was: string;
  now: string;
  via: FollowChannel;
}

export interface RepairResult {
  board: BoardFile;
  applied: AppliedRepair[];
  /**
   * Answers that had somewhere to go and did not get there: a box this board
   * did not record, or a ref that is no longer the one the report saw.
   *
   * Reported rather than dropped. "Nothing to repair" and "one repair could not
   * be landed" are different sentences, and a caller that cannot tell them apart
   * will read the second as the first.
   */
  held: FollowedRef[];
}

/** The one place a ref lives on an element, and the shape `refs` takes when a box carries several. */
function rewriteRef(
  custom: Record<string, unknown>,
  was: string,
  now: string,
): Record<string, unknown> | undefined {
  if (custom.ref === was) return { ...custom, ref: now };
  if (Array.isArray(custom.refs)) {
    const at = custom.refs.indexOf(was);
    if (at >= 0) {
      const refs = [...custom.refs];
      refs[at] = now;
      return { ...custom, refs };
    }
  }
  return undefined;
}

/**
 * Every unambiguous answer in a report, written onto the board.
 *
 * Returns a new board rather than mutating one, so a caller can decide whether
 * to write it -- and so "what would this do" costs nothing to ask.
 */
export function applyFollowed(board: BoardFile, report: DriftReport): RepairResult {
  const answers = report.followed.filter(
    (entry): entry is FollowedRef & { becomes: string; via: FollowChannel } =>
      typeof entry.becomes === "string" && entry.via !== undefined,
  );
  if (answers.length === 0) return { board, applied: [], held: [] };

  // Recorded nodes only. A hand-drawn box has no element in here, so it cannot
  // be reached by anything below -- the guard is the lookup, not a check.
  const elementByNode = new Map<string, string>();
  for (const node of readGraph(board).nodes) {
    if (node.provenance === "recorded") elementByNode.set(node.id, node.elementId);
  }

  /** Element id to the answers landing on it. A box with two stale anchors is repaired in one pass. */
  const byElement = new Map<string, Array<typeof answers[number]>>();
  const held: FollowedRef[] = [];
  for (const answer of answers) {
    const elementId = elementByNode.get(answer.node);
    if (!elementId) {
      held.push(answer);
      continue;
    }
    const landing = byElement.get(elementId);
    if (landing) landing.push(answer);
    else byElement.set(elementId, [answer]);
  }

  const applied: AppliedRepair[] = [];
  const elements = board.elements.map((element) => {
    const landing = byElement.get(String(element.id));
    if (!landing) return element;

    let custom = (element.customData ?? {}) as Record<string, unknown>;
    let changed = false;
    for (const answer of landing) {
      const rewritten = rewriteRef(custom, answer.ref, answer.becomes);
      if (!rewritten) {
        // The board says something else now. Whatever the report was answering
        // about is not what is on this box, and overwriting it would be a guess.
        held.push(answer);
        continue;
      }
      custom = rewritten;
      changed = true;
      applied.push({
        node: answer.node,
        label: answer.label,
        was: answer.ref,
        now: answer.becomes,
        via: answer.via,
      });
    }
    if (!changed) return element;
    return { ...element, customData: custom, version: (Number(element.version) || 1) + 1 };
  });

  return { board: { ...board, elements }, applied, held };
}
