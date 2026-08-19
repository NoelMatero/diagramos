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
  it("says what was read, so in-sync and unread cannot look alike", () => {
    expect(summaryOf(reportWith({ checked: 4, edgesChecked: 2 }))).toBe("4 refs · 2 arrows checked");
    expect(summaryOf(reportWith({ checked: 4, edgesChecked: 0, skipped: 3 }))).toBe(
      "4 refs · 0 arrows checked · 3 unread",
    );
  });

  it("names a concept board instead of pretending it was checked", () => {
    expect(summaryOf(reportWith({ concept: true }))).toBe("concept board · not about this repo");
  });
});
