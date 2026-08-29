/**
 * The status panel's reading of a drift report: the same selection the CLI
 * notice makes, plus the one thing only a canvas can offer -- a node id per
 * row, so clicking a finding reveals the box it is about.
 */
import { describe, expect, it } from "vitest";

import {
  livePromotedCount,
  livePromotionNote,
  rowsOf,
  summaryOf,
  tallyOf,
  worstToneOf,
  LIVE_PROMOTION_KEY,
  type DriftView,
} from "../src/viewer/drift";

function reportWith(overrides: Partial<DriftView>): DriftView {
  return {
    clean: true,
    findings: [],
    edges: [],
    deleted: [],
    workItems: [],
    promotions: [],
    checked: 0,
    skipped: 0,
    edgesChecked: 0,
    concept: false,
    ...overrides,
  };
}

describe("the status chip's tally", () => {
  it("uses the CLI notice's words, so both surfaces tell one story", () => {
    const report = reportWith({
      clean: false,
      findings: [
        { node: "a", label: "Old Cache", ref: "src/cache.ts", kind: "missing-file" },
        { node: "b", label: "Hollow", ref: "src/empty.ts", kind: "empty-ref" },
      ],
      edges: [{ from: "src/a.ts", to: "src/b.ts", fromLabel: "A", toLabel: "B", node: "a -> b", kind: "unsupported-edge" }],
      workItems: [{ node: "c", label: "Next" }],
      promotions: [{ node: "d", label: "Landed" }],
    });
    expect(tallyOf(report)).toEqual([
      { text: "1 gone", tone: "bad" },
      { text: "1 empty", tone: "bad" },
      { text: "1 arrow", tone: "warn" },
      { text: "1 built", tone: "good" },
      { text: "1 planned", tone: "dim" },
    ]);
  });

  it("counts unconfirmed arrows dim, apart from the amber ones", () => {
    /*
     * Two numbers that used to be one. Amber means "have a look at this";
     * unconfirmed means "I could not tell", which is not a defect and must not
     * borrow a defect's colour -- on the board this came from, fifteen of the
     * seventeen ambers were arrows that claimed nothing at all (#133).
     */
    const report = reportWith({
      edges: [{ from: "src/a.ts", to: "src/b.ts", fromLabel: "A", toLabel: "B", node: "a -> b", kind: "backwards-edge" }],
      unconfirmedEdges: [
        { fromLabel: "C", toLabel: "D", reason: "an-end-is-data" },
        { fromLabel: "E", toLabel: "F", reason: "no-call-either-way" },
      ],
    });
    expect(tallyOf(report)).toEqual([
      { text: "1 arrow backwards", tone: "bad" },
      { text: "2 unconfirmed", tone: "dim" },
    ]);
  });

  it("gives an unconfirmed arrow no row, so nothing on the canvas is marked", () => {
    // A row is a thing to click and go and look at. There is nothing to see:
    // the check looked already and found nothing either way.
    const report = reportWith({
      unconfirmedEdges: [{ fromLabel: "C", toLabel: "D", reason: "an-end-is-data" }],
    });
    expect(rowsOf(report)).toEqual([]);
    expect(worstToneOf(rowsOf(report))).toBe("good");
  });

  it("includes stray arrows when present", () => {
    const report = reportWith({
      strayArrows: 2,
    });
    expect(tallyOf(report)).toEqual([
      { text: "2 stray arrows", tone: "dim" },
    ]);
  });

  it("is empty when there is nothing to say", () => {
    expect(tallyOf(reportWith({ checked: 5 }))).toEqual([]);
  });
});

describe("the panel's rows", () => {
  it("carries a node id on every row whose element still exists", () => {
    const rows = rowsOf(
      reportWith({
        clean: false,
        deleted: [{ node: "gone", label: "Removed box", ref: "src/still.ts" }],
        findings: [{ node: "a", label: "Old Cache", ref: "src/cache.ts", kind: "missing-file" }],
        edges: [{ from: "src/a.ts", to: "src/b.ts", fromLabel: "A", toLabel: "B", node: "a -> b", kind: "unsupported-edge" }],
        promotions: [{ node: "d", label: "Landed" }],
        workItems: [{ node: "c", label: "Next" }],
      }),
    );
    // A deleted box has nothing on the canvas to reveal; everything else does.
    expect(rows.map((row) => row.node)).toEqual([undefined, "a", "a -> b", "d", "c"]);
    expect(rows[0].text).toContain("still there");
    expect(rows[1].text).toBe("Old Cache → src/cache.ts");
    expect(rows[2].text).toBe("A → B");
    expect(rows[3].text).toBe("Landed is built now");
    expect(rows[4].text).toBe("Next not built yet");
  });

  it("separates a plan the code went the other way on from one nobody started", () => {
    /*
     * Both are work items and the report keeps them together, because both mean
     * the same thing about the board: this is still a sketch. They say opposite
     * things to somebody looking at the page, though -- one means carry on, the
     * other means a decision is waiting -- and dim, in a list of things not
     * started yet, the second reads as one more thing not started yet (#124).
     *
     * Amber and not red, for the reason the engine files it as a work item at
     * all: nothing here is anybody's fault. Something landed and it runs against
     * the plan, which is a fact about the code, not a verdict about the drawing.
     */
    const rows = rowsOf(
      reportWith({
        workItems: [
          { node: "c", label: "Next" },
          { node: "a -> b", label: "A -> B", kind: "built-backwards" },
        ],
      }),
    );
    expect(rows.map((row) => row.text)).toEqual([
      "A -> B · built the other way round",
      "Next not built yet",
    ]);
    expect(rows[0].tone).toBe("warn");
    expect(rows[1].tone).toBe("dim");
  });

  it("shows a backwards arrow as red and says which way round", () => {
    /*
     * The live board is where somebody is actually looking when this fires, and
     * amber there means "have a look". A backwards arrow is not a maybe -- there
     * is a line of code that proves it -- so it gets the colour that means act,
     * and it is counted apart in the chip so one certain thing is not averaged
     * into the uncertain ones.
     */
    const report = reportWith({
      clean: false,
      edges: [
        { from: "a.ts", to: "b.ts", fromLabel: "A", toLabel: "B", node: "a -> b", kind: "backwards-edge" },
        { from: "b.ts", to: "c.ts", fromLabel: "B", toLabel: "C", node: "b -> c", kind: "unsupported-edge" },
      ],
    });
    const rows = rowsOf(report);
    expect(rows[0].tone).toBe("bad");
    expect(rows[0].text).toContain("drawn backwards");
    expect(rows[1].tone).toBe("warn");
    expect(rows[1].text).not.toContain("backwards");
    expect(tallyOf(report)).toEqual([
      { text: "1 arrow backwards", tone: "bad" },
      { text: "1 arrow", tone: "warn" },
    ]);
  });

  it("includes deleted edges when present", () => {
    const rows = rowsOf(
      reportWith({
        deletedEdges: [
          { fromLabel: "Module A", toLabel: "Module B" },
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("arrow Module A → Module B deleted — the code still connects them");
    expect(rows[0].tone).toBe("dim");
  });

  it("omits deleted edges when absent", () => {
    const rows = rowsOf(reportWith({}));
    expect(rows.every((r) => !r.text.includes("deleted"))).toBe(true);
  });

  it("colours the dot by the worst news present", () => {
    expect(worstToneOf([{ text: "", tone: "dim" }])).toBe("good");
    expect(worstToneOf([{ text: "", tone: "good" }, { text: "", tone: "warn" }])).toBe("warn");
    expect(worstToneOf([{ text: "", tone: "warn" }, { text: "", tone: "bad" }])).toBe("bad");
  });
});

describe("the clean summary", () => {
  it("says what was read in plain words, so in-sync and unread cannot look alike", () => {
    expect(summaryOf(reportWith({ checked: 4, edgesChecked: 2 }))).toBe(
      "checked 4 boxes and 2 arrows against the code — all still true",
    );
    expect(summaryOf(reportWith({ checked: 4, edgesChecked: 0, skipped: 3 }))).toBe(
      "checked 4 boxes and 0 arrows against the code — all still true — 3 more boxes have no ref, so they went unchecked",
    );
    expect(summaryOf(reportWith({ checked: 1, edgesChecked: 1, skipped: 1 }))).toBe(
      "checked 1 box and 1 arrow against the code — all still true — 1 more box has no ref, so it went unchecked",
    );
  });

  it("says how many arrows went unconfirmed, so all-still-true is not heard as all-verified", () => {
    /*
     * The board that started this had 30 arrows read and 17 of them confirmed by
     * nothing (#133). "checked 32 boxes and 30 arrows — all still true" is
     * every word of it true and the wrong thing to hear, and the count is what
     * makes the difference sayable in one breath.
     */
    expect(summaryOf(reportWith({
      checked: 4,
      edgesChecked: 2,
      unconfirmedEdges: [
        { fromLabel: "A", toLabel: "B", reason: "an-end-is-data" },
        { fromLabel: "C", toLabel: "D", reason: "no-call-either-way" },
      ],
    }))).toBe(
      "checked 4 boxes and 2 arrows against the code — all still true — 2 arrows were read and not confirmed",
    );
    expect(summaryOf(reportWith({
      checked: 1,
      edgesChecked: 1,
      unconfirmedEdges: [{ fromLabel: "A", toLabel: "B", reason: "no-call-either-way" }],
    }))).toBe(
      "checked 1 box and 1 arrow against the code — all still true — 1 arrow was read and not confirmed",
    );
  });

  it("admits when nothing was checkable instead of reading as verified", () => {
    expect(summaryOf(reportWith({}))).toBe(
      "nothing on this board points at code yet, so nothing was checked",
    );
  });

  it("names a concept board instead of pretending it was checked", () => {
    expect(summaryOf(reportWith({ concept: true }))).toBe(
      "a concept board — it describes something outside this repo, so nothing here is checked",
    );
  });
});

/**
 * A report the page is too old to read (#116).
 *
 * `out/viewer` is a prebuilt bundle and nothing rebuilds it, so the page can be
 * a release behind the engine answering it and look completely normal being so.
 * The measured case: `backwards-edge` shipped, the API returned it, and the
 * previous bundle folded it into the generic amber arrow count -- shown as one
 * arrow to look into, when it was one arrow definitely drawn the wrong way.
 *
 * Two defences, and they are not the same one. Below, a kind with no branch
 * gets its own dim row and its own count, so no future verdict can be dressed
 * as this release's. Above that, the report's own vocabulary is compared
 * against the words this file knows, so the page can say *why*.
 */
describe("a finding kind this page has never heard of", () => {
  const future = {
    from: "src/a.ts", to: "src/b.ts", fromLabel: "A", toLabel: "B",
    node: "a -> b", kind: "sideways-edge", detail: "b.ts reaches sideways into a.ts",
  };

  it("keeps it out of the amber arrow count instead of guessing", () => {
    const report = reportWith({
      clean: false,
      edges: [
        { from: "src/c.ts", to: "src/d.ts", fromLabel: "C", toLabel: "D", node: "c -> d", kind: "unsupported-edge" },
        future,
      ],
    });
    expect(tallyOf(report)).toEqual([
      { text: "1 arrow", tone: "warn" },
      { text: "1 finding this page cannot read", tone: "dim" },
    ]);
  });

  it("quotes the engine's own words rather than inventing a sentence", () => {
    const rows = rowsOf(reportWith({ clean: false, edges: [future] }));
    expect(rows).toEqual([
      {
        text: "A → B · sideways-edge: b.ts reaches sideways into a.ts",
        tone: "dim",
        node: "a -> b",
      },
    ]);
  });

  it("stops an unknown box kind from being counted as a file that is gone", () => {
    const report = reportWith({
      clean: false,
      findings: [
        { node: "a", label: "Cache", ref: "src/cache.ts", kind: "missing-file" },
        { node: "b", label: "Guard", ref: "src/guard.ts", kind: "unfenced-box", detail: "nothing fences it" },
      ],
    });
    // One gone, not two: the second is a word this bundle predates.
    expect(tallyOf(report)).toEqual([
      { text: "1 gone", tone: "bad" },
      { text: "1 finding this page cannot read", tone: "dim" },
    ]);
  });

  it("says the page is out of date when the server knows a word it does not", () => {
    const report = reportWith({
      vocabulary: ["missing-file", "backwards-edge", "sideways-edge"],
    });
    expect(tallyOf(report)).toEqual([{ text: "page out of date", tone: "bad" }]);
    expect(rowsOf(report)[0]).toEqual({
      text: "this page is out of date — it does not know: sideways-edge"
        + " · restart the board to rebuild it",
      tone: "bad",
    });
    // Loud, because every count beside it was graded by the wrong rules.
    expect(worstToneOf(rowsOf(report))).toBe("bad");
  });

  it("stays quiet when the server's vocabulary is one it knows in full", () => {
    const report = reportWith({
      checked: 3,
      vocabulary: ["missing-file", "empty-ref", "unsupported-edge", "backwards-edge"],
    });
    expect(tallyOf(report)).toEqual([]);
    expect(rowsOf(report)).toEqual([]);
  });

  it("treats a report with no vocabulary as nothing to compare, not a mismatch", () => {
    expect(tallyOf(reportWith({ checked: 3 }))).toEqual([]);
  });
});

/**
 * A `@needs` nobody could answer (#113).
 *
 * The chip's quiet state says "all still true". Over an unevaluated claim that
 * is the one sentence a status panel must never print: writing `@needs` was the
 * question, and silence in reply reads as the answer.
 */
describe("an unanswered claim on the board", () => {
  const unsnapped = reportWith({
    checked: 9,
    edgesChecked: 11,
    claims: { needs: 1, needsChecked: 0, needsWithheld: { "ends-not-bound": 1 } },
  });

  it("keeps the chip off its all-clear wording", () => {
    expect(tallyOf(unsnapped)).toEqual([{ text: "1 unchecked claim", tone: "warn" }]);
    // Non-empty rows are what stop App.tsx reaching for summaryOf's "all still true".
    expect(rowsOf(unsnapped)).not.toEqual([]);
    expect(worstToneOf(rowsOf(unsnapped))).toBe("warn");
  });

  it("names the reason, and the drag that fixes this one", () => {
    expect(rowsOf(unsnapped)[0]).toEqual({
      text: "1 needs arrow not checked: 1 with an end not snapped to its box"
        + " — drag it on until the box highlights",
      tone: "warn",
    });
  });

  it("says nothing about a board whose claims all got a verdict", () => {
    const answered = reportWith({
      checked: 9,
      edgesChecked: 11,
      claims: { needs: 2, needsChecked: 2, needsWithheld: {} },
    });
    expect(tallyOf(answered)).toEqual([]);
    expect(rowsOf(answered)).toEqual([]);
  });
});

/**
 * The preview counter (#130).
 *
 * Read off the scene rather than the report, and that is the only place it could
 * come from: a live promotion writes a stroke and leaves the record saying
 * `planned`, so a report describes these boxes as planned and is right to.
 */
describe("boxes shown as built before the turn recorded them", () => {
  const box = (id: string, custom: Record<string, unknown> = {}) => ({
    id,
    customData: custom,
  });

  it("counts the marked boxes and nothing else", () => {
    expect(
      livePromotedCount([
        box("a", { node: "a", [LIVE_PROMOTION_KEY]: true }),
        box("b", { node: "b" }),
        box("c", { node: "c", [LIVE_PROMOTION_KEY]: true }),
        box("d"),
      ]),
    ).toBe(2);
  });

  it("does not count a deleted element still sitting in the scene", () => {
    // Excalidraw keeps removed elements around with isDeleted set, so a count
    // that ignored the flag would keep reporting a preview of a box nobody can
    // see.
    expect(
      livePromotedCount([
        { ...box("a", { [LIVE_PROMOTION_KEY]: true }), isDeleted: true },
        box("b", { [LIVE_PROMOTION_KEY]: true }),
      ]),
    ).toBe(1);
  });

  it("says nothing at all when nothing was shown early", () => {
    expect(livePromotedCount([box("a", { node: "a" })])).toBe(0);
    expect(livePromotionNote(0)).toBeUndefined();
  });

  /**
   * Requirement two of the issue: whatever streams has to look unsettled, so a
   * mid-turn screenshot is not filed as a bug. Hence "shown early" rather than
   * "promoted" -- it names a picture running ahead of a record, which is exactly
   * what has happened.
   */
  it("words it as a picture running ahead of the record", () => {
    expect(livePromotionNote(1)).toBe("1 shown early — not recorded until the turn ends");
    expect(livePromotionNote(3)).toBe("3 shown early — not recorded until the turn ends");
  });
});
