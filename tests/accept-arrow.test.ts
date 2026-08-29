/**
 * Answering the one finding that means "wrong", and everything it refuses.
 *
 * `engine-needs.test.ts` covers reaching the verdict -- and almost all of that
 * file is about declining to give one, because a false accusation is the failure
 * that costs trust. This is the other end: the verdict was right, the code was
 * right too, and somebody says so.
 *
 * That act is the only thing in this engine that changes what a diagram
 * *claims*, so the restraint is the feature, exactly as it is in
 * `repair-refs.test.ts`. A board that rewrote itself whenever the code
 * disagreed would be right every time and worth nothing. So every guard is
 * pinned here: an arrow the current report does not accuse, an arrow somebody
 * drew by hand, an arrow naming a route that only exists one way round, and the
 * hook path, which has nobody watching it.
 *
 * The picture is checked as well as the record. A flip that swapped the stored
 * direction and left the arrowhead where it was would pass every assertion
 * about the graph and put a lie on the canvas -- the file saying one thing and
 * the drawing showing another, which is worse than the finding it answered.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { acceptBackwards } from "../src/engine/accept";
import { emptyBoard, writeBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type DriftReport, type Workspace } from "../src/engine/drift";
import { readGraph } from "../src/engine/graph";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => {
  await initEngine();
}, 60_000);

/** `b.ts` imports `a.ts`, so an arrow drawn `a -> b` claiming `needs` is backwards. */
const FILES: Record<string, string> = {
  "a.ts": "export const a = 1;\n",
  "b.ts": 'import { a } from "./a";\nexport const b = a;\n',
};

function fakeWorkspace(files: Record<string, string>): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => (files[target] !== undefined ? "file" : "missing"),
    read: (target) => files[target] ?? "",
    list: () => [],
  };
}

async function boardOf(edge: { via?: string[] } = {}): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "one", label: "One", ref: "a.ts" },
      { id: "two", label: "Two", ref: "b.ts" },
    ],
    edges: [{ from: "one", to: "two", claim: "needs", ...edge }],
  });
  return board;
}

function check(board: BoardFile): DriftReport {
  return checkDrift(board, fakeWorkspace(FILES), { edges: true });
}

const arrowOf = (board: BoardFile) => board.elements.find((element) => element.type === "arrow")!;

/** Every arrow a report says is drawn backwards, by the id the accept takes. */
const backwardsArrows = (report: DriftReport) =>
  report.edges.filter((finding) => finding.kind === "backwards-edge").map((finding) => finding.node);

/**
 * Which box each end of the drawn line touches, in the order the line is walked.
 *
 * Read off the element rather than off the graph on purpose: the graph reports
 * what the arrow *records*, and the whole risk in a flip is those two drifting
 * apart.
 */
function drawnEnds(board: BoardFile): { head: string; tail: string } {
  const arrow = arrowOf(board);
  return {
    tail: (arrow.startBinding as { elementId: string }).elementId,
    head: (arrow.endBinding as { elementId: string }).elementId,
  };
}

describe("accepting a backwards arrow", () => {
  it("turns it round, and says what it was", async () => {
    const board = await boardOf();
    const result = acceptBackwards(board, check(board), "one -> two");
    expect(result.held).toBeUndefined();
    expect(result.applied).toEqual({
      node: "one -> two",
      was: { from: "one", to: "two" },
      now: { from: "two", to: "one" },
      fromLabel: "One",
      toLabel: "Two",
    });
  });

  it("leaves the board with nothing to report", async () => {
    const board = await boardOf();
    const { board: flipped } = acceptBackwards(board, check(board), "one -> two");
    const after = check(flipped);
    expect(after.edges).toEqual([]);
    expect(after.clean).toBe(true);
    // Confirmed, not merely unaccused: the arrow now says the thing the code says.
    expect(after.claims.needsChecked).toBe(1);
  });

  it("turns the drawing round too, not just the record", async () => {
    const board = await boardOf();
    const before = drawnEnds(board);
    const { board: flipped } = acceptBackwards(board, check(board), "one -> two");
    const after = drawnEnds(flipped);
    // The arrowhead is the end Excalidraw binds last, and it has moved to the
    // other box. Without this the file would claim one direction and the canvas
    // would show the other.
    expect(after.head).toBe(before.tail);
    expect(after.tail).toBe(before.head);
    expect(readGraph(flipped).edges[0]).toMatchObject({ from: "two", to: "one" });
  });

  it("keeps the line where it was, walked the other way", async () => {
    const board = await boardOf();
    const arrow = arrowOf(board);
    const absolute = (element: typeof arrow) =>
      (element.points as Array<[number, number]>).map(([x, y]) => [
        Math.round(((element.x as number) + x) * 100) / 100,
        Math.round(((element.y as number) + y) * 100) / 100,
      ]);
    const { board: flipped } = acceptBackwards(board, check(board), "one -> two");
    // Same route, reversed. Layout is the engine's job and nothing here laid
    // anything out: the same line still touches the same two boxes in the same
    // two places. An arrow that now points up a top-down board is the news, not
    // a defect to correct.
    expect(absolute(arrowOf(flipped))).toEqual([...absolute(arrow)].reverse());
  });

  it("changes one arrow and nothing else on the board", async () => {
    const board = await boardOf();
    const { board: flipped } = acceptBackwards(board, check(board), "one -> two");
    const arrow = arrowOf(board);
    for (const [index, element] of board.elements.entries()) {
      if (element.id === arrow.id) continue;
      expect(flipped.elements[index]).toBe(element);
    }
    // The version moves, because something did change and a viewer has to notice.
    expect(Number(arrowOf(flipped).version)).toBeGreaterThan(Number(arrow.version));
  });

  it("lists the arrows there is anything to accept", async () => {
    const board = await boardOf();
    expect(backwardsArrows(check(board))).toEqual(["one -> two"]);
    const { board: flipped } = acceptBackwards(board, check(board), "one -> two");
    expect(backwardsArrows(check(flipped))).toEqual([]);
  });
});

describe("what it refuses", () => {
  it("refuses an arrow this report does not say is backwards", async () => {
    const board = await boardOf();
    const { board: flipped } = acceptBackwards(board, check(board), "one -> two");
    // The report is now answered. Handing it back in must not flip the arrow a
    // second time -- that is a stale terminal undoing a decision.
    const again = acceptBackwards(flipped, check(flipped), "two -> one");
    expect(again.applied).toBeUndefined();
    expect(again.held?.why).toBe("no-such-finding");
    expect(again.board).toBe(flipped);
  });

  it("refuses an id no arrow on the board is drawn", async () => {
    const board = await boardOf();
    const result = acceptBackwards(board, check(board), "one -> nowhere");
    expect(result.held?.why).toBe("no-such-finding");
    expect(result.board).toBe(board);
  });

  it("refuses an arrow somebody drew by hand", async () => {
    const board = await boardOf();
    /*
     * A hand-drawn arrow, made the only way one can be: the recorded direction
     * taken off, leaving the bindings and the label. `readGraph` then reads the
     * direction off the drawing and reports it `inferred`, and the claim still
     * comes through the bound label -- which is exactly the shape somebody
     * produces by drawing an arrow on the live board and typing `@needs` on it.
     */
    const drawn = {
      ...board,
      elements: board.elements.map((element) => {
        if (element.type !== "arrow") return element;
        const { edge: _dropped, ...rest } = element.customData as Record<string, unknown>;
        return { ...element, customData: rest };
      }),
    };
    const graph = readGraph(drawn);
    expect(graph.edges[0]).toMatchObject({ provenance: "inferred", claim: "needs" });
    // The check still accuses it -- being hand-drawn is no defence against the
    // code disagreeing -- so the refusal below is the guard doing work rather
    // than a case that cannot arise.
    const report = check(drawn);
    expect(backwardsArrows(report)).toEqual(["one -> two"]);

    const result = acceptBackwards(drawn, report, "one -> two");
    expect(result.applied).toBeUndefined();
    expect(result.held?.why).toBe("hand-drawn");
    expect(result.board).toBe(drawn);
  });

  it("refuses an arrow that names the route it takes", async () => {
    const board = await boardOf({ via: ["b", "a"] });
    const report = check(board);
    expect(backwardsArrows(report)).toEqual(["one -> two"]);
    const result = acceptBackwards(board, report, "one -> two");
    expect(result.applied).toBeUndefined();
    // Reversed, the named hops describe a path that does not exist, and the
    // check would then be wrong in a new way rather than quiet.
    expect(result.held?.why).toBe("named-route");
    expect(result.held?.detail).toContain("b → a");
    expect(result.board).toBe(board);
  });
});

describe("--accept on the command line", () => {
  const REPO = path.resolve(__dirname, "..");
  const SCRIPT = path.join(REPO, "scripts/check-drift.mjs");
  const TSX = path.join(REPO, "node_modules/.bin/tsx");
  const BOARD = "docs/diagrams/arch.excalidraw";

  let repo: string;

  function run(...args: string[]) {
    const result = spawnSync(TSX, [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });
    return { out: `${result.stdout ?? ""}${result.stderr ?? ""}`, status: result.status };
  }

  /** The direction the board on disk records, which is the thing that must not move on its own. */
  function drawnAs(board = BOARD): string {
    const file = JSON.parse(readFileSync(path.join(repo, board), "utf8")) as {
      elements: Array<{ type: string; customData?: { edge?: { from: string; to: string } } }>;
    };
    const edge = file.elements.find((element) => element.type === "arrow")!.customData!.edge!;
    return `${edge.from} -> ${edge.to}`;
  }

  async function drawBoard(at = BOARD, name = "arch") {
    const { board } = await createDiagram(emptyBoard(), {
      name,
      nodes: [
        { id: "one", label: "One", ref: "src/a.ts" },
        { id: "two", label: "Two", ref: "src/b.ts" },
        { id: "three", label: "Three", ref: "src/c.ts" },
      ],
      edges: [
        // Backwards, and first, so `drawnAs` reads the arrow under test.
        { from: "one", to: "two", claim: "needs" },
        // True, and therefore never accused: the arrow that proves a refusal is
        // about what the report says rather than about the id being unknown.
        { from: "three", to: "one", claim: "needs" },
      ],
    });
    await writeBoard(path.join(repo, at), board);
  }

  function land(message: string): void {
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", message],
      { cwd: repo, stdio: "ignore" },
    );
  }

  beforeAll(async () => {
    repo = mkdtempSync(path.join(os.tmpdir(), "accept-"));
    mkdirSync(path.join(repo, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(repo, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    writeFileSync(path.join(repo, "src/a.ts"), FILES["a.ts"]!);
    writeFileSync(path.join(repo, "src/b.ts"), FILES["b.ts"]!);
    writeFileSync(path.join(repo, "src/c.ts"), 'import { a } from "./a";\nexport const c = a;\n');
  }, 120_000);

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("names the arrow, and the way out, on the finding itself", async () => {
    await drawBoard();
    const { out, status } = run();
    expect(out).toContain("drawn backwards");
    // The complaint in #141 was that the loudest finding here was the only one
    // with no way to act on it. The row has to carry its own answer, because
    // the foot offers /update-diagram and that command says outright it is not
    // for this.
    expect(out).toContain('/accept-arrow "one -> two"');
    expect(status).toBe(1);
  }, 120_000);

  it("writes nothing without being asked", async () => {
    await drawBoard();
    run();
    run("--details");
    expect(drawnAs()).toBe("one -> two");
  }, 120_000);

  it("turns the arrow round and leaves the check clean", async () => {
    await drawBoard();
    const { out } = run("--accept", "one -> two");
    expect(out).toContain("arrow turned round");
    expect(out).toContain("one -> two  becomes  two -> one");
    expect(drawnAs()).toBe("two -> one");
    // Re-checked after the write, so what is printed is what the next run says.
    expect(run().status).toBe(0);
  }, 120_000);

  it("says so in its exit code when it would not turn one round", async () => {
    await drawBoard();
    // 2, like every other way of naming the wrong arrow. Falling through to the
    // report's own code meant a refusal on an otherwise clean board exited 0,
    // and a script could not tell "turned it round" from "would not".
    const refused = run("--accept", "three -> one");
    expect(refused.status).toBe(2);
    // "runs against the code" rather than "is drawn backwards": the same command
    // answers a planned arrow the code went the other way on (#124), and that one
    // is not drawn backwards -- it may be the code that is.
    expect(refused.out).toContain("does not say three -> one runs against the code");
    // Said once. The report printing underneath already names every backwards
    // arrow and carries the id to paste, and a refusal repeating that list read
    // as the tool having printed itself twice.
    expect((refused.out.match(/one -> two/g) ?? []).length).toBe(1);
    expect(drawnAs()).toBe("one -> two");
  }, 120_000);

  it("refuses on the hook path, where nobody is watching", async () => {
    await drawBoard();
    const { out, status } = run("--hook", "--accept", "one -> two");
    expect(status).toBe(2);
    expect(out).toContain("not available on the hook path");
    expect(drawnAs()).toBe("one -> two");
  }, 120_000);

  it("refuses --accept with nothing to accept, rather than guessing", async () => {
    await drawBoard();
    const { out, status } = run("--accept");
    expect(status).toBe(2);
    expect(out).toContain("needs the arrow to turn round");
    expect(drawnAs()).toBe("one -> two");
  }, 120_000);

  it("refuses an arrow drawn on more than one board, and names them", async () => {
    await drawBoard();
    await drawBoard("docs/diagrams/other.excalidraw", "other");
    const { out, status } = run("--accept", "one -> two");
    expect(status).toBe(2);
    // One claim at a time is the rule the whole feature rests on, so the
    // ambiguity is settled before a single board is written -- not after the
    // first one has already been flipped.
    expect(out).toContain("is drawn on 2 boards");
    expect(out).toContain("arch.excalidraw");
    expect(out).toContain("other.excalidraw");
    expect(drawnAs()).toBe("one -> two");
    expect(drawnAs("docs/diagrams/other.excalidraw")).toBe("one -> two");
    rmSync(path.join(repo, "docs/diagrams/other.excalidraw"));
  }, 120_000);

  it("does not then report the arrow as deleted, run after run", async () => {
    /*
     * The deleted-arrow check compares the committed board's edges against the
     * working one's, keyed by direction -- so turning an arrow round made its
     * old key go missing and every run after the flip called it a deletion.
     * Forever, until somebody committed: the board could never go quiet again,
     * which is the one confirmation an accept has.
     *
     * The arrow is still there, between the same two boxes, now agreeing with
     * the code. `--accept` is the quickest way to produce this, but dragging an
     * end across on the live board does it too.
     */
    await drawBoard();
    land("the board, drawn backwards");
    expect(run("--accept", "one -> two").out).toContain("arrow turned round");

    const after = run();
    expect(after.out).not.toContain("deleted");
    expect(after.status).toBe(0);
    // And again, because the complaint was that it repeated on every run.
    expect(run().out).not.toContain("deleted");
  }, 120_000);

  it("turns one round on the board it is named on", async () => {
    await drawBoard();
    await drawBoard("docs/diagrams/other.excalidraw", "other");
    const { out } = run("docs/diagrams/other.excalidraw", "--accept", "one -> two");
    expect(out).toContain("arrow turned round");
    expect(drawnAs("docs/diagrams/other.excalidraw")).toBe("two -> one");
    // The other board is untouched: this turns one arrow round, not every arrow
    // that happens to share an id.
    expect(drawnAs()).toBe("one -> two");
    rmSync(path.join(repo, "docs/diagrams/other.excalidraw"));
  }, 120_000);
});
