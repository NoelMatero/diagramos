/**
 * `@handles` end to end: a box on a board, judged against a file on disk.
 *
 * Separate from `tests/engine-handles.test.ts`, which is about the reader. This
 * is about the claim -- that it survives being written to a board and read back,
 * that it produces a finding a person could act on, and that everything it
 * declines to judge is *said* rather than passed over. The last part is the one
 * #113 caught the project owner out on: a claim nothing read and a claim that
 * passed look identical in a clean report.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { parseBoxClaim } from "../src/engine/claim";
import { applyEdits, createDiagram } from "../src/engine/diagram";
import { DRIFT_KINDS, checkDrift, type Workspace } from "../src/engine/drift";
import { readGraph } from "../src/engine/graph";
import { relayoutDiagram } from "../src/engine/relayout";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

await initEngine();

function fakeWorkspace(files: Record<string, string>): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => (files[target] === undefined ? "missing" : "file"),
    read: (target) => files[target] ?? "",
    list: () => [],
  };
}

/** Rust, which reads fine and is **not** licensed to accuse. See the last block. */
const ROUTER = `
enum Method { Get, Post, Delete }

pub fn status(m: Method) -> u16 {
    match m {
        Method::Get => 200,
        Method::Post => 201,
        Method::Delete => 204,
    }
}
`;

/**
 * TypeScript, which is the one square `measure:handles` licensed -- 0 invented
 * and 7 missed of 1,099 case labels. Laid out so the `switch` lands on line 5,
 * the same line the Rust one does, because a finding quotes that line.
 */
const TS_ROUTER = `
type Method = "GET" | "POST" | "DELETE";

export function status(m: Method): number {
  switch (m) {
    case "GET": return 200;
    case "POST": return 201;
    case "DELETE": return 204;
  }
}
`;

/** A one-box board whose box claims a case set, anchored at a Rust routine. */
async function boardClaiming(cases: string[]): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    title: "router",
    nodes: [{ id: "status", label: "status", ref: "src/route.rs#status", handles: cases }],
    edges: [],
  });
  return board;
}

/** The same, anchored at the TypeScript one, for anything that must go red. */
async function tsBoardClaiming(cases: string[]): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    title: "router",
    nodes: [{ id: "status", label: "status", ref: "src/route.ts#status", handles: cases }],
    edges: [],
  });
  return board;
}

const tsFiles = () => fakeWorkspace({ "src/route.ts": TS_ROUTER });

describe("the claim survives the round trip", () => {
  it("writes the case set onto the box and reads it back", async () => {
    const graph = readGraph(await boardClaiming(["Get", "Post", "Delete"]));
    expect(graph.nodes[0].claim).toEqual({ handles: true, cases: ["Get", "Post", "Delete"] });
  });

  it("refuses a bare @handles, because the set is the claim", () => {
    // `closed` written as a word is a complete claim. `handles` with no cases
    // states nothing, so it is garbled and loud rather than quietly ignored.
    expect(parseBoxClaim("handles")).toEqual({ garbled: "handles" });
    expect(parseBoxClaim({ handles: true, cases: [] })).toEqual({ garbled: "handles with no cases" });
  });

  it("refuses two claims on one box", () => {
    expect(parseBoxClaim({ closed: true, handles: true })).toEqual({ garbled: "closed+handles" });
  });
});

describe("a board whose picture and dispatch disagree", () => {
  it("says nothing when the box lists exactly what the routine dispatches on", async () => {
    const report = checkDrift(
      await boardClaiming(["Get", "Post", "Delete"]),
      fakeWorkspace({ "src/route.rs": ROUTER }),
    );
    expect(report.findings).toEqual([]);
    expect(report.claims.handles).toBe(1);
    expect(report.claims.handlesHeld).toBe(1);
    expect(report.clean).toBe(true);
  });

  it("goes red, with a file and a line, when the code grew a case", async () => {
    /*
     * The bug the word exists for. Somebody adds `DELETE` to the routine and
     * the picture still shows two cases. TypeScript, because that is the square
     * the measurement licensed -- the Rust equivalent is in the last block and
     * is deliberately quiet.
     */
    const report = checkDrift(await tsBoardClaiming(["GET", "POST"]), tsFiles());
    const [finding, ...rest] = report.findings;
    expect(rest).toEqual([]);
    expect(finding.kind).toBe("mishandled-box");
    expect(finding.detail).toContain("`DELETE`");
    expect(finding.detail).toContain("src/route.ts:5");
    expect(report.clean).toBe(false);
  });

  it("goes red when the box lists a case the routine has no arm for", async () => {
    const report = checkDrift(
      await tsBoardClaiming(["GET", "POST", "DELETE", "PUT"]),
      tsFiles(),
    );
    expect(report.findings[0].kind).toBe("mishandled-box");
    expect(report.findings[0].detail).toContain("`PUT`");
    expect(report.findings[0].detail).toContain("no case for");
    // The file, the line and the case set are said once, at the end, however
    // many ways the box and the routine disagree.
    expect(report.findings[0].detail.match(/src\/route\.ts:5/g)).toHaveLength(1);
  });

  it("names the routine in words a reader thinks in, not in node types", async () => {
    const report = checkDrift(await tsBoardClaiming(["GET", "POST"]), tsFiles());
    expect(report.findings[0].detail).not.toMatch(/match_arm|switch_case|node|dispatch\b.*type/);
    expect(report.findings[0].detail).toContain("status");
  });
});

describe("everything it declines to judge, it says", () => {
  /*
   * Counted rather than left silent, and this is the half that makes the word
   * honest: writing `handles` is somebody asking a question out loud, and a
   * report that says nothing back reads as "checked, and fine".
   */
  const withheld = async (cases: string[], files: Record<string, string>) => {
    const report = checkDrift(await boardClaiming(cases), fakeWorkspace(files));
    expect(report.findings).toEqual([]);
    expect(report.claims.handles).toBe(1);
    expect(report.claims.handlesHeld).toBe(0);
    return report.claims.handlesWithheld;
  };

  it("says so when a fallback is handling the case the box listed", async () => {
    const gaps = await withheld(["Get", "Post", "Missing"], {
      "src/route.rs": `pub fn status(m: Method) -> u16 { match m { Method::Get => 200, Method::Post => 201, _ => 405 } }`,
    });
    expect(gaps).toEqual([{ label: "status", why: "catch-all", detail: "Missing" }]);
  });

  it("says so when the routine does not dispatch on anything", async () => {
    const gaps = await withheld(["Get"], { "src/route.rs": `pub fn status(m: Method) -> u16 { 200 }` });
    expect(gaps[0].why).toBe("no-dispatch");
  });

  it("says so when the language has no reader", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      title: "router",
      nodes: [{ id: "status", label: "status", ref: "src/route.rb#status", handles: ["Get"] }],
      edges: [],
    });
    const report = checkDrift(board, fakeWorkspace({ "src/route.rb": "def status; end" }));
    expect(report.claims.handlesWithheld[0].why).toBe("no-grammar");
  });

  it("says so when the box points at a file rather than a routine", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      title: "router",
      nodes: [{ id: "status", label: "the router", ref: "src/route.rs", handles: ["Get"] }],
      edges: [],
    });
    const report = checkDrift(board, fakeWorkspace({ "src/route.rs": ROUTER }));
    expect(report.claims.handlesWithheld[0].why).toBe("no-body");
  });

  it("never lets a withheld claim affect the exit code", async () => {
    const report = checkDrift(
      await boardClaiming(["Get", "Post", "Missing"]),
      fakeWorkspace({
        "src/route.rs": `pub fn status(m: Method) -> u16 { match m { Method::Get => 200, Method::Post => 201, _ => 405 } }`,
      }),
    );
    expect(report.clean).toBe(true);
  });
});

describe("a claim on work nobody has started", () => {
  it("is not graded until the box promotes", async () => {
    /*
     * The same gate `closed` has, for the same reason (#123): a build must not
     * fail because somebody sketched next week's router. On a planned box the
     * claim is a specification rather than a transcription.
     */
    const { board } = await createDiagram(emptyBoard(), {
      title: "router",
      nodes: [{
        id: "status",
        label: "status",
        ref: "src/route.rs#status",
        handles: ["Get", "Post", "Put", "Patch"],
        state: "planned",
      }],
      edges: [],
    });
    const report = checkDrift(board, fakeWorkspace({ "src/route.rs": ROUTER }));
    expect(report.findings.filter((f) => f.kind === "mishandled-box")).toEqual([]);
    expect(report.claims.handles).toBe(0);
  });
});

describe("the licence, at the last gate and nowhere earlier", () => {
  /*
   * Measured at 0 invented and 7 missed of 1,099 in TypeScript. Rust joined
   * it at 7 invented and 182 missed of 3,000 (#267) -- every one of the 182,
   * and all but 5 of the 7, sit inside a dispatch `checkHandles` already
   * withholds on for an unrelated reason, which is why the number the
   * measurement prints and the number this gate accuses on are different
   * questions. TSX, JavaScript and Python stay outside the band.
   *
   * The gate is at the accusation and not before it, which is the rule
   * `licence.ts`'s header states: an unlicensed language still gets the whole
   * reading, and loses only the red.
   */
  const boardFor = async (ref: string, cases: string[]) => {
    const { board } = await createDiagram(emptyBoard(), {
      title: "router",
      nodes: [{ id: "status", label: "status", ref, handles: cases }],
      edges: [],
    });
    return board;
  };

  const TS_ROUTER = `
export function status(m: string): number {
  switch (m) {
    case "GET": return 200;
    case "POST": return 201;
  }
  return 405;
}
`;

  it("goes red in TypeScript, which is the square that was measured", async () => {
    const report = checkDrift(
      await boardFor("src/route.ts#status", ["GET"]),
      fakeWorkspace({ "src/route.ts": TS_ROUTER }),
    );
    expect(report.findings[0]?.kind).toBe("mishandled-box");
    expect(report.clean).toBe(false);
  });

  it("goes red in Rust too, with a file and a line, now that #267 licensed it", async () => {
    /*
     * The DoD item #206 could not tick: a Rust board where the code grows a
     * case the picture does not show reads red, by file and line, the same
     * as TypeScript already did above. `ROUTER` dispatches on `Get`, `Post`
     * and `Delete`; the box below only knows about the first two, same as
     * the TypeScript version of this test three blocks up.
     */
    const report = checkDrift(
      await boardFor("src/route.rs#status", ["Get", "Post"]),
      fakeWorkspace({ "src/route.rs": ROUTER }),
    );
    const [finding, ...rest] = report.findings;
    expect(rest).toEqual([]);
    expect(finding.kind).toBe("mishandled-box");
    expect(finding.detail).toContain("`Delete`");
    expect(finding.detail).toContain("src/route.rs:5");
    expect(report.clean).toBe(false);
  });

  it("still confirms a Rust box that agrees with its code", async () => {
    const report = checkDrift(
      await boardFor("src/route.rs#status", ["Get", "Post", "Delete"]),
      fakeWorkspace({ "src/route.rs": ROUTER }),
    );
    expect(report.claims.handlesHeld).toBe(1);
    expect(report.claims.handlesWithheld).toEqual([]);
    expect(report.findings).toEqual([]);
  });

  it("withholds a Rust dispatch #267 found unreadable, rather than guessing", async () => {
    /*
     * The exact safety property the #267 measurement rests on: a tuple
     * pattern is read and not judged, the same way an if/elif chain is
     * below. A box anchored here never goes red on the strength of a case
     * list the reader could not fully read.
     */
    const TUPLE_ROUTER = `
pub fn combine(a: Option<bool>, b: Option<bool>) -> i32 {
    match (a, b) {
        (Some(true), Some(true)) => 1,
        (Some(false), Some(false)) => 2,
        _ => 0,
    }
}
`;
    const report = checkDrift(
      await boardFor("src/combine.rs#combine", ["true"]),
      fakeWorkspace({ "src/combine.rs": TUPLE_ROUTER }),
    );
    expect(report.findings.filter((f) => f.kind === "mishandled-box")).toEqual([]);
    expect(report.claims.handlesWithheld).toEqual([
      { label: "status", why: "unreadable-case", detail: "tuple_pattern" },
    ]);
  });

  it("does not accuse in TSX either, on 40 measured labels", async () => {
    const report = checkDrift(
      await boardFor("src/Route.tsx#status", ["GET"]),
      fakeWorkspace({ "src/Route.tsx": TS_ROUTER }),
    );
    expect(report.findings.filter((f) => f.kind === "mishandled-box")).toEqual([]);
    expect(report.claims.handlesWithheld[0].why).toBe("unlicensed");
  });
});

describe("an if/elif ladder is read and not judged", () => {
  it("withholds, because no referee can tell a chain link from an if", async () => {
    /*
     * The reader finds this chain and `tests/engine-handles.test.ts` pins what
     * it reads. What it may not do is accuse on it: a text scan looking for an
     * equality against a literal counts every `if (x === undefined)` in a
     * codebase, and the first run of `measure:handles` reported 1,409
     * disagreeing files for exactly that reason.
     */
    const { board } = await createDiagram(emptyBoard(), {
      title: "router",
      nodes: [{ id: "status", label: "status", ref: "src/route.ts#status", handles: ["GET"] }],
      edges: [],
    });
    const report = checkDrift(board, fakeWorkspace({
      "src/route.ts": `
export function status(m: string): number {
  if (m === "GET") { return 200; }
  else if (m === "POST") { return 201; }
  return 405;
}`,
    }));
    expect(report.findings.filter((f) => f.kind === "mishandled-box")).toEqual([]);
    expect(report.claims.handlesWithheld[0].why).toBe("chain-unmeasured");
  });
});

describe("the report surfaces know about the new verdict", () => {
  /**
   * A list that must exist gets a test that it is complete, per
   * `docs/reading-a-grammar.md`. This one guards every box verdict rather than
   * just `mishandled-box`, and it lives here because this word is what showed
   * the guard was missing.
   *
   * The engine's `DRIFT_KINDS` is copied by hand into the board page and into
   * the CLI, and `drift.ts`'s own header records what that costs: the copies
   * went stale silently once already, and `accesses-absent` shipped at #213
   * into the board page and into neither the CLI nor the probe. Nothing was
   * checking that, so a new verdict could reach a person through one surface
   * and be rendered as "gone" by another.
   *
   * Read out of the source text rather than by importing, because the browser
   * bundle's lists are module-private and exporting them for a test would be
   * the tail wagging the dog.
   */
  it("names every drift verdict in the board page and in the CLI", () => {
    const viewer = readFileSync(
      path.resolve(__dirname, "..", "src", "viewer", "drift.ts"), "utf8",
    );
    const cli = readFileSync(
      path.resolve(__dirname, "..", "scripts", "check-drift.mjs"), "utf8",
    );
    for (const kind of DRIFT_KINDS) {
      expect(viewer, `the board page does not mention "${kind}"`).toContain(`"${kind}"`);
      expect(cli, `the CLI does not mention "${kind}"`).toContain(kind);
    }
  });
});

describe("a routine with two dispatches, where the box says which (#310)", () => {
  /**
   * TypeScript, which is the licensed square, so a wrong claim here can go red
   * and the test sees the accusation rather than a withhold standing in for it.
   * Two `switch`es, on `kind` and on `verb`.
   */
  const TWO = `
export function handle(kind: string, verb: string): number {
  switch (kind) {
    case "a": return 1;
    case "b": return 2;
  }
  switch (verb) {
    case "GET": return 3;
    case "PUT": return 4;
  }
  return 0;
}
`;
  const files = () => fakeWorkspace({ "src/two.ts": TWO });
  const boardNaming = async (handles: string[] | { of: string; cases: string[] }) => {
    const { board } = await createDiagram(emptyBoard(), {
      title: "router",
      nodes: [{ id: "handle", label: "handle", ref: "src/two.ts#handle", handles }],
      edges: [],
    });
    return board;
  };

  it("confirms the dispatch the box names", async () => {
    const report = checkDrift(await boardNaming({ of: "kind", cases: ["a", "b"] }), files());
    expect(report.findings).toEqual([]);
    expect(report.claims.handlesHeld).toBe(1);
    expect(report.claims.handlesWithheld).toEqual([]);
  });

  it("confirms the other one on the same routine, told to", async () => {
    const report = checkDrift(await boardNaming({ of: "verb", cases: ["GET", "PUT"] }), files());
    expect(report.claims.handlesHeld).toBe(1);
  });

  it("goes red against the named dispatch, and quotes its line", async () => {
    const report = checkDrift(await boardNaming({ of: "verb", cases: ["GET"] }), files());
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe("mishandled-box");
    // The other switch's arms are not held against this claim.
    expect(report.findings[0].detail).toContain("PUT");
    expect(report.findings[0].detail).not.toContain('"a"');
    // The second switch's line, not the first: the evidence quoted is the
    // dispatch the box named.
    expect(report.findings[0].detail).toContain("src/two.ts:7");
  });

  it("keeps today's refusal when the box says nothing about which", async () => {
    const report = checkDrift(await boardNaming(["a", "b"]), files());
    expect(report.findings).toEqual([]);
    expect(report.claims.handlesWithheld[0]).toMatchObject({ why: "several-dispatches" });
  });

  it("refuses, and never accuses, when `of` names no dispatch in the routine", async () => {
    /*
     * The box points at something that is not there. That is a claim nothing
     * can grade, not a claim that is false -- and the withhold names the
     * subjects that *are* there so the box can be corrected on the spot.
     */
    const report = checkDrift(await boardNaming({ of: "state", cases: ["a", "b"] }), files());
    expect(report.findings).toEqual([]);
    expect(report.claims.handlesWithheld[0]).toMatchObject({ why: "no-such-dispatch" });
    expect(report.claims.handlesWithheld[0].detail).toContain("kind");
    expect(report.clean).toBe(true);
  });

  it("writes `of` onto the box and reads it back", async () => {
    const graph = readGraph(await boardNaming({ of: "kind", cases: ["a", "b"] }));
    expect(graph.nodes[0].claim).toEqual({ handles: true, cases: ["a", "b"], of: "kind" });
  });

  it("keeps `of` through a relayout, which must not narrow a claim quietly", async () => {
    const board = await boardNaming({ of: "kind", cases: ["a", "b"] });
    const { board: again } = await relayoutDiagram(board, { direction: "RIGHT" });
    expect(readGraph(again).nodes[0].claim).toEqual({ handles: true, cases: ["a", "b"], of: "kind" });
  });

  it("is what edit_diagram writes, and what it drops", async () => {
    // The edit path, not a redraw: #310's whole point is that naming the
    // dispatch on a board that exists costs one field, not a new board.
    const board = await boardNaming(["a", "b"]);
    const edited = applyEdits(board, [
      { id: "handle", handles: { of: "verb", cases: ["GET", "PUT"] } },
    ]);
    expect(edited.updated).toHaveLength(1);
    expect(readGraph(edited.board).nodes[0].claim)
      .toEqual({ handles: true, cases: ["GET", "PUT"], of: "verb" });

    // And an empty set still drops the claim, the object form included.
    const dropped = applyEdits(edited.board, [{ id: "handle", handles: [] }]);
    expect(readGraph(dropped.board).nodes[0].claim).toBeUndefined();
  });
});
