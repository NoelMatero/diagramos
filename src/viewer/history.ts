/**
 * The board's recent timeline, shaped for the page.
 *
 * Pure functions, kept out of App.tsx so they are testable without a browser
 * -- the same split the status panel uses. The page fetches HISTORY_PATH; the
 * literal appears here and in the server route on purpose, because the shared
 * string is the connection the architecture board draws between the two files.
 */

export const HISTORY_PATH = "/api/history";

/** The subset of the server's HistoryEntry the panel reads. */
export interface HistoryEntryView {
  at: string;
  elements: number;
  added: number;
  removed: number;
  source: string;
}

/**
 * Coarse on purpose: the panel answers "when was this", not "how many seconds
 * ago", and a row that re-renders from 4m to 5m is quieter than one counting.
 */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const seconds = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export interface HistoryRow {
  when: string;
  /** What the change did, in words a stranger can read. */
  delta: string;
  /** Who made it: a hand on the board, or something writing the file. */
  who: string;
  /** Additions read as good news, removals as worth a glance, the rest as quiet. */
  tone: "good" | "warn" | "dim";
}

/**
 * One row per entry, newest first, split into parts so the page can colour
 * them apart -- a single grey string made every row look like every other,
 * which defeats a timeline. The oldest row says the count it started from,
 * because a timeline that opens mid-story should say so.
 */
export function rowsOfHistory(entries: HistoryEntryView[], now: Date = new Date()): HistoryRow[] {
  return entries.map((entry) => {
    const opened = entry.source === "opened";
    const delta =
      entry.added || entry.removed
        ? [
            entry.added ? `+${entry.added} ${entry.added === 1 ? "element" : "elements"}` : "",
            entry.removed ? `−${entry.removed}` : "",
          ]
            .filter(Boolean)
            .join(" ")
        : opened
          ? `${entry.elements} ${entry.elements === 1 ? "element" : "elements"}`
          : "restyled or moved";
    const who =
      entry.source === "page"
        ? "drawn by hand"
        : entry.source === "file"
          ? "a tool, an editor, or git"
          : "first seen by this service";
    const tone = opened || (!entry.added && !entry.removed) ? "dim" : entry.removed ? "warn" : "good";
    return { when: timeAgo(entry.at, now), delta, who, tone };
  });
}
