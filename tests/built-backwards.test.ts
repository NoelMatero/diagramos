/**
 * The plan the code contradicted, and everything that still promotes anyway.
 *
 * A `planned` arrow with `@needs` on it is a specification: when this is built,
 * the dependency will run this way. Nothing read that direction until #124,
 * because the wrong verdict is gated on `built` -- and the gate was right about
 * what it was protecting and reached one step too far.
 *
 * What it protects is the accusation. Sketching a dependency that currently runs
 * the other way is a thing people do on purpose, and a red finding about it
 * would be a lie about a plan. That is untouched, and `engine-needs.test.ts`
 * pins it.
 *
 * What it was also doing was leaving the *promotion* unguarded. Promotion asks
 * whether the two ends are connected, and connected has no direction, so a
 * dependency built the opposite way to the plan corroborated the arrow exactly
 * as well as the planned one -- and the board said the work was done. Green,
 * exit 0, board rewritten. The direction was read on the run after, once the
 * arrow was `built`, and said "drawn backwards": two runs, opposite answers,
 * nothing changed in between, and the first of the two is the one people act on.
 *
 * So this file is mostly about what still promotes. The new answer fires on one
 * verdict and one only, and every other reason `checkNeeds` has for staying
 * quiet has to leave the old behaviour exactly where it was -- because each of
 * those is a case where the tool cannot tell, and "cannot tell" must never
 * become "did not land".
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { acceptBackwards } from "../src/engine/accept";
import { emptyBoard, writeBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { applyPromotions } from "../src/engine/promote";
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

/** Two boxes and one planned arrow drawn `from -> to`. */
async function planned(
  from: string,
  to: string,
  claim?: "needs" | "feeds",
): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "one", label: "One", ref: from },
      { id: "two", label: "Two", ref: to },
    ],
    edges: [{ from: "one", to: "two", state: "planned", ...(claim ? { claim } : {}) }],
  });
  return board;
}

/*
 * `b.ts` depends on `a.ts`. Every board below plans the arrow `one -> two` --
 * One needs Two -- so anchoring One at `b.ts` draws the plan the way the code
 * runs, and anchoring it at `a.ts` draws it the other way round.
 */
const FILES = {
  "a.ts": "export const a = 1;\n",
  "b.ts": 'import { a } from "./a";\nexport const b = a;\n',
};

describe("a plan the code went the other way on", () => {
  it("is not reported as built", async () => {
    const report = checkDrift(await planned("a.ts", "b.ts", "needs"), fakeWorkspace(FILES), {
      edges: true,
    });
    expect(report.promotions).toEqual([]);
    expect(report.workItems).toHaveLength(1);
    expect(report.workItems[0]!.kind).toBe("built-backwards");
  });

  it("says what the code does, and where to read it", async () => {
    const report = checkDrift(await planned("a.ts", "b.ts", "needs"), fakeWorkspace(FILES), {
      edges: true,
    });
    const [item] = report.workItems;
    expect(item!.detail).toContain("the plan says One needs Two");
    expect(item!.detail).toContain("runs the other way");
    // The file and the line, so the reader can go and look rather than take the
    // tool's word for which of the two directions is the wrong one.
    expect(item!.detail).toContain('b.ts line 1 declares "./a"');
  });

  it("is not an accusation, and cannot fail a build", async () => {
    const report = checkDrift(await planned("a.ts", "b.ts", "needs"), fakeWorkspace(FILES), {
      edges: true,
    });
    /*
     * The whole reason this is a work item rather than a finding. From here, a
     * plan somebody drew to invert a dependency that exists today and a plan an
     * agent implemented backwards are the same two files pointing the same way,
     * and no amount of git history separates them reliably. What is certain is
     * what the code does, which is all this says.
     */
    expect(report.edges).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it("does not leave the arrow looking unchecked", async () => {
    const report = checkDrift(await planned("a.ts", "b.ts", "needs"), fakeWorkspace(FILES), {
      edges: true,
    });
    // This exit does not reach the corroboration channels, so it counts itself.
    // A report naming an arrow while claiming to have checked none of them
    // invites the reader to distrust the thing it just said.
    expect(report.edgesChecked).toBe(1);
    expect(report.edgesSkipped).toBe(0);
  });

  it("stays put until somebody acts, rather than going quiet", async () => {
    const board = await planned("a.ts", "b.ts", "needs");
    const first = checkDrift(board, fakeWorkspace(FILES), { edges: true });
    // A promotion is one edit from going away and is applied by the hook. This
    // is not a promotion, so nothing is written and the second run says the same
    // thing -- which is what it should do while the disagreement is still there.
    const after = applyPromotions(board, first);
    const second = checkDrift(after.board, fakeWorkspace(FILES), { edges: true });
    expect(second.workItems).toHaveLength(1);
    expect(second.workItems[0]!.kind).toBe("built-backwards");
    expect(second.promotions).toEqual([]);
  });
});

describe("what still promotes", () => {
  it("the same plan, drawn the way the code runs", async () => {
    const report = checkDrift(await planned("b.ts", "a.ts", "needs"), fakeWorkspace(FILES), {
      edges: true,
    });
    expect(report.promotions).toHaveLength(1);
    expect(report.workItems).toEqual([]);
  });

  it("an arrow that carries no claim at all", async () => {
    // An unclaimed arrow means "related somehow", which has no direction and so
    // has no opposite. Reading one as a dependency claim is how a drawing
    // convention turns into an accusation.
    const report = checkDrift(await planned("a.ts", "b.ts"), fakeWorkspace(FILES), { edges: true });
    expect(report.promotions).toHaveLength(1);
    expect(report.workItems).toEqual([]);
  });

  it("a @feeds arrow, whichever way the dependency runs", async () => {
    // `feeds` is a claim about where data flows, and a flow can perfectly well
    // run against the import that carries it. It has no wrong verdict anywhere
    // in this engine and does not acquire one here.
    const report = checkDrift(await planned("a.ts", "b.ts", "feeds"), fakeWorkspace(FILES), {
      edges: true,
    });
    expect(report.promotions).toHaveLength(1);
    expect(report.workItems).toEqual([]);
  });

  it("a pair of files that depend on each other", async () => {
    /*
     * Both directions exist, so neither drawing is more correct than the other,
     * and this is the gate that matters most: Rust crates are full of cycles by
     * construction, and a tool that read one as "built backwards" would be
     * wrong on entire codebases rather than on one arrow.
     */
    const cycle = {
      "x.ts": 'import type { Y } from "./y";\nexport type X = Y;\n',
      "y.ts": 'import type { X } from "./x";\nexport type Y = X | null;\n',
    };
    const report = checkDrift(await planned("x.ts", "y.ts", "needs"), fakeWorkspace(cycle), {
      edges: true,
    });
    expect(report.promotions).toHaveLength(1);
    expect(report.workItems).toEqual([]);
  });

  it("an end that reaches out at runtime", async () => {
    // The text is not the whole story, so "declares nothing on it" is not a fact
    // about the file. Withheld here exactly as it is on a built arrow.
    const dynamic = {
      "host.ts": 'const later = await import("./plugin");\nexport const host = later;\n',
      "plugin.ts": "export const plugin = 1;\n",
    };
    const report = checkDrift(await planned("plugin.ts", "host.ts", "needs"), fakeWorkspace(dynamic), {
      edges: true,
    });
    expect(report.promotions).toHaveLength(1);
    expect(report.workItems).toEqual([]);
  });

  it("a language nobody measured a reader for", async () => {
    // The licence is 12,824 measured dependency edges across five repositories.
    // A language outside it has not earned the right to hold back a promotion
    // any more than it has earned the right to make an accusation.
    const unlicensed = {
      "a.rb": "class A\nend\n",
      "b.rb": "require './a'\nclass B\nend\n",
    };
    const report = checkDrift(await planned("a.rb", "b.rb", "needs"), fakeWorkspace(unlicensed), {
      edges: true,
    });
    expect(report.workItems.some((item) => item.kind === "built-backwards")).toBe(false);
  });
});

describe("turning the plan round", () => {
  it("accepts it the same way a built arrow is accepted", async () => {
    const board = await planned("a.ts", "b.ts", "needs");
    const report = checkDrift(board, fakeWorkspace(FILES), { edges: true });
    const result = acceptBackwards(board, report, "one -> two");
    expect(result.held).toBeUndefined();
    expect(result.applied).toMatchObject({
      was: { from: "one", to: "two" },
      now: { from: "two", to: "one" },
      fromLabel: "One",
      toLabel: "Two",
    });
  });

  it("leaves an arrow the next check promotes in the ordinary way", async () => {
    /*
     * No promotion here and no special case for one. The arrow now runs the way
     * the code does, so the next check corroborates it like any other planned
     * arrow and promotes it like any other planned arrow -- which is one
     * behaviour rather than two that have to agree.
     */
    const board = await planned("a.ts", "b.ts", "needs");
    const report = checkDrift(board, fakeWorkspace(FILES), { edges: true });
    const turned = acceptBackwards(board, report, "one -> two").board;
    const after = checkDrift(turned, fakeWorkspace(FILES), { edges: true });
    expect(after.workItems).toEqual([]);
    expect(after.promotions).toHaveLength(1);
    expect(after.promotions[0]!.node).toBe("two -> one");
  });

  it("refuses an id this run says nothing about", async () => {
    const board = await planned("b.ts", "a.ts", "needs");
    const report = checkDrift(board, fakeWorkspace(FILES), { edges: true });
    const result = acceptBackwards(board, report, "one -> two");
    expect(result.applied).toBeUndefined();
    expect(result.held?.why).toBe("no-such-finding");
    expect(result.board).toBe(board);
  });
});

describe("on the command line", () => {
  const REPO = path.resolve(__dirname, "..");
  const SCRIPT = path.join(REPO, "scripts/check-drift.mjs");
  const TSX = path.join(REPO, "node_modules/.bin/tsx");
  const BOARD = "docs/diagrams/plan.excalidraw";

  let repo: string;

  function run(...args: string[]) {
    const result = spawnSync(TSX, [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });
    return { out: `${result.stdout ?? ""}${result.stderr ?? ""}`, status: result.status };
  }

  /**
   * The state the board on disk records for its one arrow. Promotion is the
   * deletion of this key, so `undefined` is what "built" looks like on paper.
   */
  function arrowState(): string | undefined {
    const file = JSON.parse(readFileSync(path.join(repo, BOARD), "utf8")) as {
      elements: Array<{ type: string; customData?: { state?: string } }>;
    };
    return file.elements.find((element) => element.type === "arrow")?.customData?.state;
  }

  async function drawBoard(from: string, to: string) {
    const { board } = await createDiagram(emptyBoard(), {
      name: "plan",
      nodes: [
        { id: "one", label: "One", ref: from },
        { id: "two", label: "Two", ref: to },
      ],
      edges: [{ from: "one", to: "two", state: "planned", claim: "needs" }],
    });
    await writeBoard(path.join(repo, BOARD), board);
  }

  beforeAll(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), "planned-backwards-"));
    mkdirSync(path.join(repo, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(repo, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    writeFileSync(path.join(repo, "src/a.ts"), FILES["a.ts"]);
    writeFileSync(path.join(repo, "src/b.ts"), FILES["b.ts"]);
  }, 120_000);

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("says so without being asked for the long form", async () => {
    /*
     * The row this replaces was green and appeared by default, so this one has
     * to appear by default too. Every other work item waits for --all, on the
     * grounds that a sketch the code has not reached would sit there unchanged
     * for a whole design session; this is the opposite -- something landed
     * between one turn and the next, and it runs against the plan.
     */
    await drawBoard("src/a.ts", "src/b.ts");
    const { out, status } = run();
    expect(out).toContain("built the other way round");
    expect(out).not.toContain("is built now");
    // Still exit 0. A plan does not fail a build, whatever the code around it did.
    expect(status).toBe(0);
  }, 120_000);

  it("offers the way out, on the row", async () => {
    await drawBoard("src/a.ts", "src/b.ts");
    const { out } = run();
    expect(out).toContain('/accept-arrow "one -> two"');
  }, 120_000);

  it("reaches the per-turn hook, and leaves the board alone", async () => {
    await drawBoard("src/a.ts", "src/b.ts");
    const { out } = run("--hook");
    const said = JSON.parse(out.slice(out.indexOf("{"))) as { systemMessage?: string };
    expect(said.systemMessage).toContain("built the other way round");
    // The hook writes promotions. This is not one, so the arrow is still a plan
    // and the file it was drawn in is untouched.
    expect(arrowState()).toBe("planned");
  }, 120_000);

  it("turns the arrow round when asked, and the run after marks it built", async () => {
    await drawBoard("src/a.ts", "src/b.ts");
    const accepted = run("--accept", "one -> two");
    expect(accepted.status).toBe(0);
    expect(accepted.out).toContain("turned round");
    // The plan now runs the way the code does, so the ordinary promotion path
    // picks it up on the next hook run with nothing special about it.
    const promoted = run("--hook");
    expect(promoted.out).toContain("built now");
    expect(arrowState()).toBeUndefined();
  }, 120_000);

  it("says nothing when the plan was drawn the way the code runs", async () => {
    await drawBoard("src/b.ts", "src/a.ts");
    const { out, status } = run();
    expect(out).not.toContain("built the other way round");
    expect(status).toBe(0);
  }, 120_000);
});
