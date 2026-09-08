/**
 * `@calls` as it reaches a report (#189).
 *
 * `engine-calls.test.ts` covers the reader. What is covered here is the half
 * that decides what anybody is told: which answer becomes a finding, which
 * becomes silence, and whether a claim nobody could check is distinguishable in
 * the report from a claim that passed.
 *
 * The one thing to keep true is the thing the reader is written around:
 * **`absent` is not a finding.** A callback is invisible to this reader, so "no
 * call found" is never "no call happens", and the only accusation the word is
 * entitled to is the one that rests on finding the call running the other way.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

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
 * Two routine boxes, with the arrow drawn caller -> callee.
 *
 * The direction is the one every diagram already draws and the one the arrow
 * already carries: the thing doing the work comes first. `@calls` needs no
 * second word the way `@takes` needed `@returns`, because "is called by" is the
 * same fact read backwards.
 */
async function boardOf(
  callerRef: string,
  calleeRef: string,
  edge: { claim?: "calls"; state?: "planned" } = {},
): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "caller", label: "run", ref: callerRef },
      { id: "callee", label: "render", ref: calleeRef },
    ],
    edges: [{ from: "caller", to: "callee", ...edge }],
  });
  return board;
}

const CALLEE = "export function render(n: number) { return n; }\n";

describe("@calls on an arrow the code confirms", () => {
  it("confirms it, and counts the claim as held", async () => {
    const caller = 'import { render } from "./b";\nexport function run() { return render(1); }\n';
    const board = await boardOf("src/a.ts#run", "src/b.ts#render", { claim: "calls" });
    const report = checkDrift(board, fakeWorkspace({
      "src/a.ts": caller, "src/b.ts": CALLEE,
    }), { edges: true });

    expect(report.claims.calls).toBe(1);
    expect(report.claims.callsConfirmed).toBe(1);
    expect(report.clean).toBe(true);
  });
});

describe("absent is not a finding, and this is the test that keeps it true", () => {
  it("says nothing when a callback could be wiring them together out of sight", async () => {
    /*
     * `run` reaches a name nothing in this file binds -- a third file could be
     * handing `render` in as a callback, so the body cannot be enumerated
     * completely and #233's closed-body check must not fire on it either. A
     * reader that called this wrong would be accusing on the strength of not
     * having followed a value.
     *
     * (A `run` with no calls at all -- the shape this test used to be -- is a
     * closed body now, and correctly a finding: see "an arrow into a routine
     * whose whole call set is checked" below.)
     */
    const caller = "export function run() { return callback(); }\n";
    const board = await boardOf("src/a.ts#run", "src/b.ts#render", { claim: "calls" });
    const report = checkDrift(board, fakeWorkspace({
      "src/a.ts": caller, "src/b.ts": CALLEE,
    }), { edges: true });

    expect(report.claims.calls).toBe(1);
    expect(report.claims.callsConfirmed).toBe(0);
    expect(report.edges.filter((finding) => finding.kind === "calls-backwards")).toEqual([]);
    expect(report.edges.filter((finding) => finding.kind === "calls-refuted")).toEqual([]);
    expect(report.clean).toBe(true);
  });
});

describe("an arrow into a routine whose whole call set is checked (#233)", () => {
  it("is refuted when the routine provably calls nothing at the far end", async () => {
    // No receiver dead ends here, so this closes even with no live compiler
    // wired in -- the tier-1 shape docs/claim-vocabulary.md items 12-13
    // already measured, not something this test needs #232's compiler for.
    const caller = "export function run() { return 1; }\n";
    const board = await boardOf("src/a.ts#run", "src/b.ts#render", { claim: "calls" });
    const report = checkDrift(board, fakeWorkspace({
      "src/a.ts": caller, "src/b.ts": CALLEE,
    }), { edges: true });

    expect(report.claims.calls).toBe(1);
    const refuted = report.edges.filter((finding) => finding.kind === "calls-refuted");
    expect(refuted).toHaveLength(1);
    expect(refuted[0]!.detail).toContain("run");
    expect(report.clean).toBe(false);
  });

  it("keeps a planned arrow silent rather than refuting a sketch", async () => {
    // Same shape, drawn as a plan: the code has not caught up to it yet, and
    // a red about a plan is a lie about a plan -- same rule `backwards` is
    // held to for a `planned` edge.
    const caller = "export function run() { return 1; }\n";
    const board = await boardOf("src/a.ts#run", "src/b.ts#render", { claim: "calls", state: "planned" });
    const report = checkDrift(board, fakeWorkspace({
      "src/a.ts": caller, "src/b.ts": CALLEE,
    }), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "calls-refuted")).toEqual([]);
  });
});

describe("@calls on an arrow drawn the wrong way round", () => {
  it("reports it, quoting the call it found", async () => {
    /*
     * The one accusation this word is entitled to, and it rests on something
     * found: the arrow says `run` calls `render`, `run` calls nothing, and
     * `render` calls the thing at the tail.
     */
    const caller = "export function run() { return 1; }\n";
    const callee = 'import { run } from "./a";\nexport function render() { return run(); }\n';
    const board = await boardOf("src/a.ts#run", "src/b.ts#render", { claim: "calls" });
    const report = checkDrift(board, fakeWorkspace({
      "src/a.ts": caller, "src/b.ts": callee,
    }), { edges: true });

    const finding = report.edges.find((edge) => edge.kind === "calls-backwards");
    expect(finding).toBeDefined();
    expect(finding?.detail).toContain("run()");
    expect(report.clean).toBe(false);
  });

  it("says nothing when the tail cannot be read at all", async () => {
    /*
     * "Runs the other way *and not this way*" needs both halves. A tail whose
     * body could be hiding the call gets silence rather than a verdict, and it is
     * the distinction that keeps the accusation honest.
     */
    const caller = "export function run(t: any) { return t.render(); }\n";
    const callee = 'import { run } from "./a";\nexport function render() { return run(0); }\n';
    const board = await boardOf("src/a.ts#run", "src/b.ts#render", { claim: "calls" });
    const report = checkDrift(board, fakeWorkspace({
      "src/a.ts": caller, "src/b.ts": callee,
    }), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "calls-backwards")).toEqual([]);
    expect(report.claims.callsWithheld.receiver).toBe(1);
    expect(report.clean).toBe(true);
  });
});

describe("a claim nobody could check is not a claim that passed", () => {
  it("counts a name nothing placed as withheld rather than confirmed", async () => {
    // A wildcard import brought something in, so a bare call to that name is
    // placed by nothing in the text.
    const board = await boardOf("app/a.py#run", "app/b.py#render", { claim: "calls" });
    const report = checkDrift(board, fakeWorkspace({
      "app/a.py": "from app.c import *\n\ndef run():\n    return render(1)\n",
      "app/b.py": "def render(n):\n    return n\n",
      "app/c.py": "def other():\n    return 0\n",
    }), { edges: true });

    expect(report.claims.callsConfirmed).toBe(0);
    expect(report.claims.callsWithheld.unbound).toBe(1);
    expect(report.clean).toBe(true);
  });

  it("counts an end with no ref as withheld", async () => {
    // One end names a file rather than a routine, so there is no body to read
    // and no name to look for.
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "caller", label: "a", ref: "src/a.ts" },
        { id: "callee", label: "render", ref: "src/b.ts#render" },
      ],
      edges: [{ from: "caller", to: "callee", claim: "calls" }],
    });
    const report = checkDrift(board, fakeWorkspace({
      "src/a.ts": "export function run() { return 1; }\n", "src/b.ts": CALLEE,
    }), { edges: true });

    expect(report.claims.callsWithheld["endpoint-has-no-ref"]).toBe(1);
    expect(report.clean).toBe(true);
  });
});

describe("a planned arrow is a specification, not an accusation", () => {
  it("refuses the finding on code that does not exist yet", async () => {
    const caller = "export function run() { return 1; }\n";
    const callee = 'import { run } from "./a";\nexport function render() { return run(); }\n';
    const board = await boardOf("src/a.ts#run", "src/b.ts#render", { state: "planned", claim: "calls" });
    const report = checkDrift(board, fakeWorkspace({
      "src/a.ts": caller, "src/b.ts": callee,
    }), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "calls-backwards")).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it("still confirms a planned arrow the code already satisfies", async () => {
    const caller = 'import { render } from "./b";\nexport function run() { return render(1); }\n';
    const board = await boardOf("src/a.ts#run", "src/b.ts#render", { state: "planned", claim: "calls" });
    const report = checkDrift(board, fakeWorkspace({
      "src/a.ts": caller, "src/b.ts": CALLEE,
    }), { edges: true });

    expect(report.clean).toBe(true);
  });
});

describe("a word arrives with the thing that reads it", () => {
  it("is on the arrow vocabulary, so nothing reports it garbled", async () => {
    const board = await boardOf("src/a.ts#run", "src/b.ts#render", { claim: "calls" });
    const report = checkDrift(board, fakeWorkspace({
      "src/a.ts": 'import { render } from "./b";\nexport function run() { return render(1); }\n',
      "src/b.ts": CALLEE,
    }), { edges: true });

    expect(report.garbledClaims).toEqual([]);
  });
});

/**
 * The same two questions, against a **real** workspace on disk.
 *
 * This exists because of a bug that every test above passed. The reader was
 * handed the absolute path where it needed the repo-relative one, and
 * `createWorkspace` refuses an absolute path by design -- so every board in
 * every repository answered `unreadable` while the fake workspace above, whose
 * `resolve` hands a relative path back unchanged, confirmed everything.
 *
 * A fake that is more permissive than the real thing cannot catch a mistake
 * about which of two path shapes a caller passed. So one pair of tests goes
 * through the real one, on files that are really on disk, and they are the two
 * that matter: the confirmation and the accusation.
 */
describe("on a real workspace, where the path shapes are the real ones", () => {
  const root = mkdtempSync(path.join(tmpdir(), "calls-claims-"));
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  const write = (relative: string, text: string) => {
    mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
  };

  it("confirms a call that is really there", async () => {
    write("src/a.ts", 'import { render } from "./b";\nexport function run() { return render(1); }\n');
    write("src/b.ts", CALLEE);
    const board = await boardOf("src/a.ts#run", "src/b.ts#render", { claim: "calls" });
    const report = checkDrift(board, createWorkspace(root), { edges: true });

    expect(report.claims.callsWithheld).toEqual({});
    expect(report.claims.callsConfirmed).toBe(1);
    expect(report.clean).toBe(true);
  });

  it("accuses an arrow drawn against a call that is really there", async () => {
    write("src/c.ts", "export function run() { return 1; }\n");
    write("src/d.ts", 'import { run } from "./c";\nexport function render() { return run(); }\n');
    const board = await boardOf("src/c.ts#run", "src/d.ts#render", { claim: "calls" });
    const report = checkDrift(board, createWorkspace(root), { edges: true });

    const finding = report.edges.find((edge) => edge.kind === "calls-backwards");
    expect(finding).toBeDefined();
    // The line the call is really on, so somebody can go and look at it.
    expect(finding?.detail).toContain("src/d.ts line 2");
    expect(report.clean).toBe(false);
  });
});
