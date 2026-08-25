/**
 * The one "what was checked" sentence, now that the CLI and the live board
 * share it.
 *
 * The tests that matter here are the ones about what the sentence refuses to
 * say. A tally is easy to get right and was never the problem; the drift was
 * that one surface had learned to admit "nothing here was checkable" and the
 * other still printed a zero, which reads as a pass. So the special cases and
 * the verdict split are pinned harder than the arithmetic.
 */
import { describe, expect, it } from "vitest";

import { countedWords, coverageLabel, coverageWords, summaryOf } from "../src/engine/summary";

describe("countedWords", () => {
  it("names an anchored shape a box, which is what the rest of the tool calls it", () => {
    expect(countedWords({ checked: 4, edgesChecked: 3 })).toBe("4 boxes and 3 arrows");
  });

  it("counts one of each in the singular", () => {
    // The CLI printed "1 arrows" for years, because its tally was a template
    // string and the page's was a function. This is that bug's regression test.
    expect(countedWords({ checked: 1, edgesChecked: 1 })).toBe("1 box and 1 arrow");
  });

  it("still says zero out loud, for a caller that wants the tally regardless", () => {
    expect(countedWords({ checked: 0, edgesChecked: 0 })).toBe("0 boxes and 0 arrows");
  });
});

describe("coverageWords", () => {
  it("says what was read, and claims nothing about whether it agreed", () => {
    expect(coverageWords({ checked: 4, edgesChecked: 2 })).toBe(
      "checked 4 boxes and 2 arrows against the code",
    );
  });

  it("carries no verdict, so the coverage audit can print it over a broken board", () => {
    expect(coverageWords({ checked: 4, edgesChecked: 2 })).not.toContain("still true");
  });

  it("leaves the unread count to the rows underneath it", () => {
    // The audit names every skipped box with its reason a line below. The same
    // fact in the header, in vaguer words, is the duplication this consolidation
    // exists to remove.
    expect(coverageWords({ checked: 4, edgesChecked: 2, skipped: 9 })).toBe(
      "checked 4 boxes and 2 arrows against the code",
    );
  });

  it("explains an unchecked board instead of printing a zero that reads as a pass", () => {
    expect(coverageWords({ checked: 0, edgesChecked: 0 })).toBe(
      "nothing on this board points at code yet, so nothing was checked",
    );
  });

  it("says a concept board was never going to be checked", () => {
    expect(coverageWords({ checked: 0, edgesChecked: 0, concept: true })).toBe(
      "a concept board — it describes something outside this repo, so nothing here is checked",
    );
  });

  it("treats a concept board as one even if something on it got counted", () => {
    // Whatever the counts say, the board is not about this repo, and the
    // explanation is the honest answer rather than the tally.
    expect(coverageWords({ checked: 3, edgesChecked: 1, concept: true })).toContain("concept board");
  });
});

describe("coverageLabel", () => {
  it("counts in the same nouns as the sentence, minus the trailing phrase", () => {
    // Not a second phrasing -- a prefix of the first one, off the same counter.
    // The nouns and the plurals are what must never diverge again.
    const facts = { checked: 4, edgesChecked: 2 };
    expect(coverageLabel(facts)).toBe("checked 4 boxes and 2 arrows");
    expect(coverageWords(facts).startsWith(coverageLabel(facts))).toBe(true);
  });

  it("shortens a concept board rather than letting a terminal cut it in half", () => {
    // At 76 columns the sentence lost "so nothing here is checked", which is the
    // half a reader needed. Short and whole beats long and truncated.
    expect(coverageLabel({ checked: 0, edgesChecked: 0, concept: true })).toBe(
      "concept board · not about this repo",
    );
  });

  it("shortens the unchecked board the same way, and still refuses to imply a pass", () => {
    const label = coverageLabel({ checked: 0, edgesChecked: 0 });
    expect(label).toBe("nothing here points at code yet");
    expect(label).not.toContain("0 boxes");
  });

  it("fits a box header beside the longest board name in this repo", () => {
    // The audit frames at 76 cells and spends the first of them on the filename.
    // The full sentence did not fit there, which is the whole reason this exists.
    const header = "board-internals.excalidraw  ";
    for (const facts of [
      { checked: 128, edgesChecked: 128 },
      { checked: 0, edgesChecked: 0 },
      { checked: 0, edgesChecked: 0, concept: true },
    ]) {
      expect(header.length + coverageLabel(facts).length).toBeLessThanOrEqual(76);
    }
  });
});

describe("summaryOf", () => {
  it("adds the verdict the clean chip is entitled to", () => {
    expect(summaryOf({ checked: 4, edgesChecked: 2 })).toBe(
      "checked 4 boxes and 2 arrows against the code — all still true",
    );
  });

  it("says in the same breath how much went unread", () => {
    expect(summaryOf({ checked: 4, edgesChecked: 0, skipped: 3 })).toBe(
      "checked 4 boxes and 0 arrows against the code — all still true"
        + " — 3 more boxes have no ref, so they went unchecked",
    );
  });

  it("puts one unread box in the singular", () => {
    expect(summaryOf({ checked: 1, edgesChecked: 1, skipped: 1 })).toBe(
      "checked 1 box and 1 arrow against the code — all still true"
        + " — 1 more box has no ref, so it went unchecked",
    );
  });

  it("never claims a verdict over a board where nothing was checkable", () => {
    expect(summaryOf({ checked: 0, edgesChecked: 0 })).toBe(
      "nothing on this board points at code yet, so nothing was checked",
    );
    expect(summaryOf({ checked: 0, edgesChecked: 0 })).not.toContain("still true");
  });

  it("never claims a verdict over a concept board", () => {
    expect(summaryOf({ checked: 0, edgesChecked: 0, concept: true })).toBe(
      "a concept board — it describes something outside this repo, so nothing here is checked",
    );
    expect(summaryOf({ checked: 0, edgesChecked: 0, concept: true })).not.toContain("still true");
  });

  it("treats a missing skipped count as none, for a report that never sent one", () => {
    expect(summaryOf({ checked: 2, edgesChecked: 2 })).not.toContain("unchecked");
  });
});
