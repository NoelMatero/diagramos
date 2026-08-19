/**
 * What happened to a board while this service was up.
 *
 * Git is the durable history; this is the recent, fine-grained one: every
 * change the service saw -- drawn on the page, or written to the file by a
 * tool, an editor, or git -- with what it did to the element count. Held in
 * memory on purpose: the board itself is the artifact, and a restart costing
 * the recent timeline is cheaper than a second file beside every board
 * claiming to be its past.
 *
 * Served at GET /api/history, which is how the page's history panel reads it.
 */
import type { BoardFile } from "../engine/board-file";

export const HISTORY_ROUTE = "/api/history";

/**
 * How a change reached the board: "page" is a save from the live page,
 * "file" is the file changing on disk under the service (a tool write, an
 * editor save, a git checkout), and "opened" is the baseline entry recorded
 * when the service first sees a board -- not a change at all, which is why it
 * is named rather than dressed up as one.
 */
export type HistorySource = "page" | "file" | "opened";

export interface HistoryEntry {
  revision: string;
  /** When the service saw it, ISO 8601. */
  at: string;
  /** Live elements after this change. */
  elements: number;
  /** Elements that appeared, against the previous entry. */
  added: number;
  /** Elements that disappeared, against the previous entry. */
  removed: number;
  source: HistorySource;
}

/** Entries kept per board: enough for a working day of saves; git holds the rest. */
const LIMIT = 200;

const liveIds = (board: BoardFile): Set<string> =>
  new Set(
    (board.elements as Array<{ id?: unknown; isDeleted?: unknown }>)
      .filter((element) => element.isDeleted !== true)
      .map((element) => String(element.id)),
  );

export class BoardHistory {
  #entries = new Map<string, HistoryEntry[]>();
  #lastIds = new Map<string, Set<string>>();

  /**
   * Note one state of one board. Recording the same revision twice is a no-op,
   * which is what makes this safe to call from every place a board passes
   * through the server -- our own writes echo back as file events, and only
   * the first sighting counts.
   */
  record(file: string, board: BoardFile, revision: string, source: HistorySource): void {
    const list = this.#entries.get(file) ?? [];
    if (list.at(-1)?.revision === revision) return;

    const ids = liveIds(board);
    const previous = this.#lastIds.get(file);
    let added = 0;
    let removed = 0;
    if (previous) {
      for (const id of ids) if (!previous.has(id)) added += 1;
      for (const id of previous) if (!ids.has(id)) removed += 1;
    }

    list.push({
      revision,
      at: new Date().toISOString(),
      elements: ids.size,
      added,
      removed,
      source,
    });
    if (list.length > LIMIT) list.splice(0, list.length - LIMIT);
    this.#entries.set(file, list);
    this.#lastIds.set(file, ids);
  }

  /** Newest first, since the page reads from the top. */
  entriesFor(file: string): HistoryEntry[] {
    return [...(this.#entries.get(file) ?? [])].reverse();
  }
}
