/**
 * The status panel's reading of a drift report: the same selection the CLI
 * notice makes, plus the one thing only a canvas can offer -- a node id per
 * row, so clicking a finding reveals the box it is about.
 */
import { describe, expect, it } from "vitest";

import { rowsOf, summaryOf, tallyOf, worstToneOf, type DriftView } from "../src/viewer/drift";

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
      edges: [{ from: "src/a.ts", to: "src/b.ts", fromLabel: "A", toLabel: "B", node: "a -> b" }],
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
        edges: [{ from: "src/a.ts", to: "src/b.ts", fromLabel: "A", toLabel: "B", node: "a -> b" }],
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
