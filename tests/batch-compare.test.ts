/**
 * Reading two measurement runs side by side (`scripts/lib/batch-compare.ts`),
 * which `measure:batch` prints its comparison from.
 *
 * The bad outcomes these guard: a timing line read as a changed answer, so
 * every batch reports differences nobody made; a changed answer hidden
 * because only counts were compared; and a score-only set's arrow leaking
 * into the comparison's output.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  changedClaims, loadDump, readCompilerTrue, reportProblems, safetyCompare, scoreOfDump, scoreOfReport, textDifference,
} from "../scripts/lib/batch-compare";

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(path.join(os.tmpdir(), "batch-compare-")); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

const row = (cid: string, truth: string, outcome: string, more: object = {}) => ({
  set: "main", project: "p", topic: "t", cid, word: "calls", from: "a", to: "b", truth, source: "drawn",
  language: "rust", outcome, reason: outcome === "red" ? "calls-refuted" : "confirmed", detail: "x", gate: "-", ms: 5, ...more,
});

function dump(rows: object[]): string {
  const file = path.join(scratch, `${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, rows.map((one) => `${JSON.stringify(one)}\n`).join(""));
  return file;
}

const report = (secs: number, ms: number, falseReds: string[]) => [
  `    red       false  reverse    rust   [calls-refuted] @calls a -> b | calls-refuted: no | ${ms}ms | gate: -`,
  "",
  "#296 · PLANTED MISTAKES, AND WHAT THE CHECKER SAID",
  "  machine: no other measurement ran during this one",
  `  pauses: ${secs > 100 ? "1 pause of 79s" : "none seen"}; power log: no sleep during the run`,
  `  45 boards, 1323 claims scored, 338 left out as undecidable, in ${secs}s`,
  "",
  "  FALSE CLAIMS -- planted mistakes and the ones Haiku drew",
  "                  claims     red  not sure   green  silent   caught",
  "    calls            100      60        38       2       0      60%",
  "    ALL              100      60        38       2       0      60%",
  "",
  "  TRUE CLAIMS -- what the checker says about a correct board",
  "                  claims     red  not sure   green  silent   caught",
  "    ALL               50       1         9      40       0      80%",
  "",
  ...(falseReds.length > 0 ? [`  FALSE REDS -- ${falseReds.length} true claims the checker called wrong`, ...falseReds] : ["  FALSE REDS -- none."]),
  "",
].join("\n");

describe("comparing two runs", () => {
  it("counts caught, false reds and greens from a dump, keeping the last row of a claim appended twice", () => {
    const rows = loadDump(dump([row("1", "false", "not sure"), row("1", "false", "red"), row("2", "true", "green"), row("3", "false", "green")]));
    expect(scoreOfDump(rows)).toEqual({ caught: 1, falseReds: 0, wrongGreens: 1, trueGreens: 1, planted: 2, correct: 1 });
  });

  it("names a claim whose answer changed, and not one whose only change is its time", () => {
    const base = loadDump(dump([row("1", "false", "red"), row("2", "true", "green", { ms: 10 })]));
    const branch = loadDump(dump([row("1", "false", "not sure"), row("2", "true", "green", { ms: 9000 })]));
    expect(changedClaims(base, branch).map((one) => one.key)).toEqual(["p|t|1"]);
    // The checker's sentence counts too: same outcome, different words, is a change.
    expect(changedClaims(base, loadDump(dump([row("1", "false", "red", { detail: "y" }), row("2", "true", "green")])))).toHaveLength(1);
  });

  it("reads a report's score tables, and takes no timing line for a difference", () => {
    const one = report(800, 12, []);
    expect(scoreOfReport(one)).toEqual({ caught: 60, wrongGreens: 2, planted: 100, falseReds: 1, trueGreens: 40, correct: 50 });
    expect(textDifference(`\n> diagramos@x gate\n\n${one}`, report(400, 9000, []))).toBe(0);
    expect(textDifference(one, report(800, 12, ["  p/t · @calls a -> b"]))).toBeGreaterThan(0);
    // How many answers came from the compiler memory is how they were got, not what they were.
    const remembered = one.replace("  machine:", "  compiler memory: 900 of 1000 answers remembered (90%), 100 asked (/m)\n  machine:");
    expect(textDifference(one, remembered)).toBe(0);
  });

  it("compares a score-only set's safety lines in counts, and its result holds no line of them", () => {
    const secret = "  rwf2-Rocket/forms · @needs core/form.rs#Form -> core/parser.rs#Parser";
    const same = safetyCompare(report(1, 1, [secret]), report(2, 2, [secret]));
    expect(same[0]).toMatchObject({ title: "FALSE REDS", identical: true, onlyBase: 0, onlyBranch: 0 });
    const moved = safetyCompare(report(1, 1, [secret]), report(2, 2, []));
    expect(moved[0]).toMatchObject({ identical: false, onlyBase: 2, onlyBranch: 1 });
    expect(JSON.stringify([same, moved])).not.toContain("Rocket");
  });

  it("says why a run cannot be compared: a pause, a shared machine, NOT VALID", () => {
    expect(reportProblems(report(1, 1, []))).toEqual([]);
    expect(reportProblems(report(800, 1, []))).toEqual(["pauses: 1 pause of 79s; power log: no sleep during the run"]);
    expect(reportProblems("  machine: SHARED -- 1 other run\n  NOT VALID -- x")).toEqual(["NOT VALID (see its header)", "machine: SHARED"]);
  });

  it("reads compiler-true's word table and its reds", () => {
    const text = [
      "  word       pairs   compiler-only   red live   red off   green live",
      "  holds        244               0          0         0          244",
      "  conforms       0",
      "  calls       4282              65          1         0         4090",
      "",
      "  RED, with the compiler running (1):",
      "    ripgrep: calls a -> b (written) calls-refuted | no",
      "",
    ].join("\n");
    const read = readCompilerTrue(text);
    expect([...read.words.keys()]).toEqual(["holds", "conforms", "calls"]);
    expect(read.words.get("calls")).toEqual([4282, 65, 1, 0, 4090]);
    expect(read.reds).toEqual(["ripgrep: calls a -> b (written) calls-refuted | no"]);
  });
});
