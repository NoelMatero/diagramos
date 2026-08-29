/**
 * A plan's claims, when nothing could read them.
 *
 * Two rules met here and had never been joined. #113: a claim the checker could
 * not evaluate has to be visible, because a quiet report reads as "checked, and
 * fine". #123: a claim on a `planned` arrow is a real claim -- a specification
 * of what the dependency will be once the code lands.
 *
 * The tally excluded `planned` arrows outright, so a plan's claims were skipped
 * without a word. Same board, same missing file, and only the arrow state
 * differing: a `built` arrow reported "3 needs arrows not checked", a `planned`
 * one reported nothing at all. That is what made a feature built under the wrong
 * name invisible -- every ref pointing at a file that was never written, every
 * arrow skipped in silence, dashed boxes reading "not built yet" over work that
 * was finished, and exit 0.
 *
 * So it is counted now, in its own place and in its own words. The verdict rule
 * is untouched and this file pins that too: a `planned` arrow is never accused
 * of anything, never a finding, and never changes the exit code. What changed is
 * that the board stops implying it checked something it could not read.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => {
  await initEngine();
}, 60_000);

function fakeWorkspace(files: Record<string, string>): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => {
      if (files[target] !== undefined) return "file";
      return Object.keys(files).some((file) => file.startsWith(`${target}/`)) ? "directory" : "missing";
    },
    read: (target) => files[target] ?? "",
    list: () => [],
  };
}

/**
 * Two boxes and one arrow between them, drawn `from -> to`.
 *
 * `planned` marks the head box and the arrow, which is the shape a design
 * session actually draws: something that exists, pointing at something that
 * does not yet. Marking both boxes would make the tail promote itself the
 * moment the check ran, which is a different test.
 */
async function board(options: {
  from: string;
  to: string;
  claim?: "needs" | "feeds";
  state?: "planned";
}): Promise<BoardFile> {
  const { board: drawn } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "one", label: "One", ref: options.from },
      { id: "two", label: "Two", ref: options.to, ...(options.state ? { state: options.state } : {}) },
    ],
    edges: [{
      from: "one",
      to: "two",
      ...(options.claim ? { claim: options.claim } : {}),
      ...(options.state ? { state: options.state } : {}),
    }],
  });
  return drawn;
}

const check = (drawn: BoardFile, files: Record<string, string>) =>
  checkDrift(drawn, fakeWorkspace(files), { edges: true });

/*
 * `app.ts` is written; `summary.ts` is the file the plan says will exist. This
 * is the shape of every plan in the middle of being built, and the shape of the
 * one that was built somewhere else under another name.
 */
const HALF_BUILT = { "app.ts": "export const app = 1;\n" };

describe("a claim on a plan whose file is not there yet", () => {
  it("is counted, where before it was skipped in silence", async () => {
    const report = check(
      await board({ from: "app.ts", to: "summary.ts", claim: "needs", state: "planned" }),
      HALF_BUILT,
    );
    expect(report.claims.plannedWithheld).toEqual({ "endpoint-file-missing": 1 });
  });

  it("says why, rather than only how many", async () => {
    /*
     * The reason is the whole value of the line. "1 claim could not be checked"
     * is a number; "with an end whose file is missing" is the sentence that
     * sends somebody to look at the ref, which is where the wrong path is.
     */
    const report = check(
      await board({ from: "app.ts", to: "summary.ts", claim: "needs", state: "planned" }),
      HALF_BUILT,
    );
    expect(Object.keys(report.claims.plannedWithheld)).toEqual(["endpoint-file-missing"]);
  });

  it("is the same fact a built arrow reports, filed apart from it", async () => {
    /*
     * The proof, both halves of it. Same two boxes, same missing file, and only
     * the state differing -- so the arrow that was silent is now as loud as the
     * one that was not, without being counted among the live claims that a
     * notice fires on every turn.
     */
    const built = check(
      await board({ from: "app.ts", to: "summary.ts", claim: "needs" }),
      HALF_BUILT,
    );
    expect(built.claims.needsWithheld).toEqual({ "endpoint-file-missing": 1 });
    expect(built.claims.plannedWithheld).toEqual({});

    const plan = check(
      await board({ from: "app.ts", to: "summary.ts", claim: "needs", state: "planned" }),
      HALF_BUILT,
    );
    expect(plan.claims.plannedWithheld).toEqual({ "endpoint-file-missing": 1 });
    expect(plan.claims.needsWithheld).toEqual({});
  });

  it("counts a @feeds plan the same way", async () => {
    // Both words are specifications when the arrow is planned, and neither one
    // was being answered. Splitting them here would give a reader two coverage
    // lines about one plan.
    const report = check(
      await board({ from: "app.ts", to: "summary.ts", claim: "feeds", state: "planned" }),
      HALF_BUILT,
    );
    expect(report.claims.plannedWithheld).toEqual({ "endpoint-file-missing": 1 });
    expect(report.claims.feedsWithheld).toEqual({});
  });

  it("stays silent about an arrow that claims nothing", async () => {
    /*
     * The gate is the claim, not the state. An arrow with no word on it means
     * "related somehow" -- nobody asked a question, so nothing went unanswered,
     * and counting it would turn every sketch into a list of things unchecked.
     */
    const report = check(
      await board({ from: "app.ts", to: "summary.ts", state: "planned" }),
      HALF_BUILT,
    );
    expect(report.claims.plannedWithheld).toEqual({});
  });

  it("counts a plan in a language no reader was measured over", async () => {
    // Both files exist and a checker was reached; it could not read them. Same
    // silence, one gate further in, and the one place a live claim never lands
    // -- `checkNeeds` answers a built arrow before it can get this far.
    const ruby = { "a.rb": "class A\nend\n", "b.rb": "require './a'\nclass B\nend\n" };
    const report = check(
      await board({ from: "b.rb", to: "a.rb", claim: "needs", state: "planned" }),
      ruby,
    );
    expect(report.claims.plannedWithheld).toEqual({ "unlicensed-language": 1 });
  });
});

describe("what it is not", () => {
  it("never accuses the plan of anything", async () => {
    /*
     * The rule #129 explicitly does not change. A planned arrow describes work
     * that has not happened; its ends pointing at files that do not exist is the
     * plan working, and a red row about it would be a lie about a sketch. This
     * is a coverage statement, so nothing here may reach `clean` or the findings.
     */
    const report = check(
      await board({ from: "app.ts", to: "summary.ts", claim: "needs", state: "planned" }),
      HALF_BUILT,
    );
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.edges).toEqual([]);
  });

  it("leaves the work item saying what it always said", async () => {
    // The plan is still a plan. Nothing about the new tally promotes it, demotes
    // it, or changes the row somebody reads on the board.
    const report = check(
      await board({ from: "app.ts", to: "summary.ts", claim: "needs", state: "planned" }),
      HALF_BUILT,
    );
    expect(report.promotions).toEqual([]);
    expect(report.workItems.map((item) => item.node)).toEqual(["two"]);
  });

  it("says nothing about a plan whose ends were read", async () => {
    /*
     * The other half of the definition, and the one that keeps this from
     * becoming noise on every board with a plan on it. `b.ts` and `a.ts` both
     * exist and both were read, so the question was asked and answered -- what
     * to do about the answer is the promotion, not a number in a summary.
     */
    const files = {
      "a.ts": "export const a = 1;\n",
      "b.ts": 'import { a } from "./a";\nexport const b = a;\n',
    };
    const report = check(
      await board({ from: "b.ts", to: "a.ts", claim: "needs", state: "planned" }),
      files,
    );
    expect(report.claims.plannedWithheld).toEqual({});
    expect(report.promotions.map((promotion) => promotion.node)).toContain("two");
    expect(report.workItems).toEqual([]);
  });

  it("is empty on a board with no plans at all", async () => {
    const files = {
      "a.ts": "export const a = 1;\n",
      "b.ts": 'import { a } from "./a";\nexport const b = a;\n',
    };
    const report = check(await board({ from: "b.ts", to: "a.ts", claim: "needs" }), files);
    expect(report.claims.plannedWithheld).toEqual({});
  });
});
