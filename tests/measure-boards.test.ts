/**
 * The board corpus the measurements count, and the sweep that keeps them honest.
 *
 * `measure-dataflow.mts` printed a sentence claiming the corpus carried no
 * `@feeds` arrows and naming a board total. It read no boards; the line was a
 * `console.log` somebody wrote when it happened to be true, sitting in a report
 * where every other figure is live. It went stale in silence and was quoted
 * into #203 as a measured finding. (#214)
 *
 * Two things stop that recurring, and both are tested here: the corpus is one
 * module rather than a copy per script, so two commands cannot disagree about
 * how many claims exist; and no measurement prints a multi-digit figure it did
 * not compute.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { boardCorpus, boardsUnder, NOT_A_BOARD } from "../scripts/lib/boards";

const SCRIPTS = path.resolve(__dirname, "..", "scripts");

describe("the board corpus every measurement counts", () => {
  it("is read from one module, so two commands cannot disagree about it", () => {
    const measures = readdirSync(SCRIPTS).filter((one) => /^measure-.*\.mts$/.test(one));
    // A script that reads boards, rather than one that happens to write a
    // scratch board of its own -- `measure-survey.mts` does the latter.
    const reading = measures.filter((one) =>
      readFileSync(path.join(SCRIPTS, one), "utf8").includes("readBoard"));
    expect(reading.length).toBeGreaterThan(0);
    for (const one of reading) {
      const source = readFileSync(path.join(SCRIPTS, one), "utf8");
      // A script that looks for boards must ask `lib/boards` for them rather
      // than running its own `find`, which is how the two totals drifted apart.
      expect(source, `${one} builds its own board corpus`).toContain('from "./lib/boards"');
    }
  });

  it("leaves out the copies and the fixtures, which are the same boards again", () => {
    // The deliberate-red demos are the ones that matter: counting them puts a
    // permanent failure in a number meant to sit at zero.
    expect(NOT_A_BOARD).toContain("/demo-");
    expect(NOT_A_BOARD).toContain("/fixtures/");
    const found = boardCorpus();
    for (const file of found) expect(file.endsWith(".excalidraw")).toBe(true);
    for (const file of found) {
      for (const fragment of NOT_A_BOARD) {
        expect(file.includes(fragment), `${file} matched ${fragment}`).toBe(false);
      }
    }
  });

  it("says a root is missing rather than counting it as empty", () => {
    const skipped: string[] = [];
    boardCorpus((root) => skipped.push(root));
    expect(boardsUnder("/nowhere/at/all")).toEqual([]);
    // Whatever was skipped was named. A silent skip is the difference between
    // "the corpus carries one @feeds arrow" and "the corpus I could see does".
    for (const root of skipped) expect(boardsUnder(root)).toEqual([]);
  });
});

describe("a number a measurement prints", () => {
  it("is computed by the run, never written into the sentence", () => {
    /*
     * The shape #214 was: a literal figure in a printed line, indistinguishable
     * from the live ones beside it. Truncation caps (`... and N more`), column
     * widths and issue numbers are not figures, so they are stripped before
     * looking. A quoted result from another measurement is allowed only where
     * the line says whose it is and that this run did not measure it.
     */
    const offenders: string[] = [];
    for (const one of readdirSync(SCRIPTS).filter((f) => /^measure-.*\.mts$/.test(f))) {
      const lines = readFileSync(path.join(SCRIPTS, one), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("console.log")) return;
        if (/not measured by this run|quoted from/.test(line)) return;
        const bare = line
          .replace(/\$\{[^}]*\}/g, "")          // anything interpolated is computed
          .replace(/#\d+/g, "")                  // an issue number
          .replace(/\.(slice|repeat|padStart|padEnd|toFixed)\([^)]*\)/g, "")
          .replace(/[<>]\s*\d+|\d+\s*\)/g, "");  // truncation caps and widths
        const figure = /(?<![\w.])\d[\d,]*\d(?![\w])/.exec(bare);
        if (figure) offenders.push(`${one}:${index + 1} prints ${figure[0]}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
