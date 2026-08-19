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
  text: string;
}

/**
 * One row per entry, newest first, in words rather than numbers alone:
 * "+3 −1" is a delta, "edited" is a change that moved or restyled without
 * adding, and the oldest row says the count it started from, because a
 * timeline that opens mid-story should say so.
 */
export function rowsOfHistory(entries: HistoryEntryView[], now: Date = new Date()): HistoryRow[] {
  return entries.map((entry) => {
    const delta =
      entry.added || entry.removed
        ? [entry.added ? `+${entry.added}` : "", entry.removed ? `−${entry.removed}` : ""]
            .filter(Boolean)
            .join(" ")
        : entry.source === "opened"
          ? `${entry.elements} ${entry.elements === 1 ? "element" : "elements"}`
          : "edited";
    const who =
      entry.source === "page"
        ? "drawn on the page"
        : entry.source === "file"
          ? "written to the file"
          : "first seen here";
    return { text: `${timeAgo(entry.at, now)} · ${delta} · ${who}` };
  });
}
