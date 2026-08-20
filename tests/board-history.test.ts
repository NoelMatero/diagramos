/**
 * The board's recent timeline (#68): every state the service saw, deduplicated
 * by revision so echoes of our own writes do not count twice, with deltas a
 * person can read.
 */
import { describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { BoardHistory } from "../src/server/history";
import { rowsOfHistory, timeAgo } from "../src/viewer/history";

function boardWith(...ids: string[]): BoardFile {
  return {
    ...emptyBoard(),
    elements: ids.map((id) => ({
      id,
      type: "rectangle",
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      isDeleted: id.startsWith("dead-"),
    })) as never,
  };
}

describe("the revision recorder", () => {
  it("records a baseline, then deltas against it", () => {
    const history = new BoardHistory();
    history.record("/b", boardWith("a", "b"), "r1", "opened");
    history.record("/b", boardWith("a", "b", "c"), "r2", "page");
    history.record("/b", boardWith("a", "c"), "r3", "file");

    const entries = history.entriesFor("/b");
    expect(entries.map((entry) => entry.revision)).toEqual(["r3", "r2", "r1"]);
    expect(entries[2]).toMatchObject({ elements: 2, added: 0, removed: 0, source: "opened" });
    expect(entries[1]).toMatchObject({ elements: 3, added: 1, removed: 0, source: "page" });
    expect(entries[0]).toMatchObject({ elements: 2, added: 0, removed: 1, source: "file" });
  });

  it("ignores an echo of the revision it just recorded", () => {
    const history = new BoardHistory();
    history.record("/b", boardWith("a"), "r1", "page");
    // Our own write comes back as a file event with the same revision.
    history.record("/b", boardWith("a"), "r1", "file");
    expect(history.entriesFor("/b")).toHaveLength(1);
    expect(history.entriesFor("/b")[0].source).toBe("page");
  });

  it("counts only live elements, since tombstones are not on the board", () => {
    const history = new BoardHistory();
    history.record("/b", boardWith("a", "dead-x"), "r1", "opened");
    expect(history.entriesFor("/b")[0].elements).toBe(1);
    // An element going from live to tombstoned is a removal.
    history.record("/b", boardWith("dead-a"), "r2", "page");
    expect(history.entriesFor("/b")[0]).toMatchObject({ elements: 0, removed: 1 });
  });

  it("keeps each board's timeline separate", () => {
    const history = new BoardHistory();
    history.record("/one", boardWith("a"), "r1", "opened");
    history.record("/two", boardWith("x", "y"), "r2", "opened");
    expect(history.entriesFor("/one")).toHaveLength(1);
    expect(history.entriesFor("/two")[0].elements).toBe(2);
    expect(history.entriesFor("/absent")).toEqual([]);
  });

  it("is bounded, dropping the oldest entries first", () => {
    const history = new BoardHistory();
    for (let index = 0; index < 250; index++) {
      history.record("/b", boardWith(`e${index}`), `r${index}`, "page");
    }
    const entries = history.entriesFor("/b");
    expect(entries).toHaveLength(200);
    expect(entries[0].revision).toBe("r249");
    expect(entries.at(-1)?.revision).toBe("r50");
  });
});

describe("the timeline as the page words it", () => {
  const now = new Date("2026-08-20T12:00:00Z");

  it("speaks in coarse ages", () => {
    expect(timeAgo("2026-08-20T11:59:50Z", now)).toBe("just now");
    expect(timeAgo("2026-08-20T11:55:00Z", now)).toBe("5m ago");
    expect(timeAgo("2026-08-20T09:00:00Z", now)).toBe("3h ago");
    expect(timeAgo("2026-08-18T12:00:00Z", now)).toBe("2d ago");
  });

  it("words each entry by what it did and who did it, toned so rows scan apart", () => {
    const rows = rowsOfHistory(
      [
        { at: "2026-08-20T11:59:55Z", elements: 14, added: 3, removed: 1, source: "page" },
        { at: "2026-08-20T11:58:00Z", elements: 12, added: 1, removed: 0, source: "page" },
        { at: "2026-08-20T11:55:00Z", elements: 11, added: 0, removed: 0, source: "file" },
        { at: "2026-08-20T11:00:00Z", elements: 11, added: 0, removed: 0, source: "opened" },
      ],
      now,
    );
    expect(rows).toEqual([
      // Anything removed is worth a glance, even alongside additions.
      { when: "just now", delta: "+3 elements −1", who: "drawn by hand", tone: "warn" },
      { when: "2m ago", delta: "+1 element", who: "drawn by hand", tone: "good" },
      { when: "5m ago", delta: "restyled or moved", who: "a tool, an editor, or git", tone: "dim" },
      { when: "1h ago", delta: "11 elements", who: "first seen by this service", tone: "dim" },
    ]);
  });
});
