/**
 * The harness behind the rebind measurement, over a history built on purpose.
 *
 * The number in `src/engine/rebind.ts` is only worth as much as the thing that
 * counted it, and the thing that counted it cannot be checked against this
 * repository's own history: that history is the input, so agreeing with it
 * proves nothing. So a small repository is built here with one of each case in
 * it -- a file that moved, a symbol that moved on its own, a name that now
 * lives in two places, and a thing that is simply gone -- and the harness has to
 * sort them into the right buckets.
 *
 * The ambiguous case is the one that matters most. It is the bucket the feature
 * is gated on, and a harness that quietly scored it followable would read as
 * good news.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { measureHypothetical, measureRebind, tally, type StaleRef } from "../scripts/lib/rebind";
import { emptyBoard } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

let repo: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function write(file: string, contents: string): void {
  const target = path.join(repo, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function commit(message: string): void {
  git("add", "-A");
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", message],
    { cwd: repo, stdio: "ignore" },
  );
}

const BOARD = "docs/diagrams/arch.excalidraw";

beforeAll(async () => {
  await initEngine();
  repo = mkdtempSync(path.join(os.tmpdir(), "rebind-"));
  git("init", "-q");

  // One commit with a board on it, so both samples have something to walk.
  write("src/alpha.ts", "export function alpha(): number {\n  return 1;\n}\n");
  write("src/beta.ts", "export function beta(): number {\n  return 2;\n}\n");
  write("src/twin.ts", "export function twin(): number {\n  return 3;\n}\n");
  write("src/gone.ts", "export function vanished(): number {\n  return 4;\n}\n");
  write("src/keepA.ts", "export function twin(): string {\n  return \"a\";\n}\n");
  write("src/keepB.ts", "export function twin(): string {\n  return \"b\";\n}\n");
  write("src/host.ts", "export function host(): number {\n  return 0;\n}\n");
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [{ id: "a", label: "Alpha", ref: "src/alpha.ts#alpha" }],
    edges: [],
  });
  write(BOARD, JSON.stringify(board, null, 2));
  commit("the starting tree");

  // A file that moved, unchanged. Git records this one itself.
  mkdirSync(path.join(repo, "src/moved"), { recursive: true });
  git("mv", "src/alpha.ts", "src/moved/alpha.ts");
  commit("move alpha");

  // A symbol that moved on its own: the file it was in is gone, and the name is
  // now declared in a file that already existed, so no rename can be recorded.
  rmSync(path.join(repo, "src/beta.ts"));
  write("src/host.ts", "export function host(): number {\n  return 0;\n}\n\nexport function beta(): number {\n  return 2;\n}\n");
  commit("fold beta into host");

  // A name that now lives in two places. This is the bucket the feature is
  // gated on, and it has to stay a finding.
  rmSync(path.join(repo, "src/twin.ts"));
  commit("drop twin");

  // Nothing to follow.
  rmSync(path.join(repo, "src/gone.ts"));
  commit("delete gone");
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

function rowFor(rows: StaleRef[], ref: string): StaleRef | undefined {
  return rows.find((row) => row.ref === ref);
}

describe("following a stale ref", () => {
  it("sorts each kind of move into its own bucket", async () => {
    const measured = await measureHypothetical({ repo });

    expect(rowFor(measured.rows, "src/alpha.ts")).toMatchObject({
      bucket: "followable",
      channel: "rename",
      candidate: "src/moved/alpha.ts",
    });
    expect(rowFor(measured.rows, "src/alpha.ts#alpha")).toMatchObject({
      bucket: "followable",
      channel: "rename",
      candidate: "src/moved/alpha.ts#alpha",
    });

    // No rename to lean on: the symbol is found because it is declared in
    // exactly one place now.
    expect(rowFor(measured.rows, "src/beta.ts#beta")).toMatchObject({
      bucket: "followable",
      channel: "symbol",
      candidate: "src/host.ts#beta",
    });

    // Two declarations, so no candidate is entitled to win.
    const twin = rowFor(measured.rows, "src/twin.ts#twin");
    expect(twin?.bucket).toBe("ambiguous");
    expect(twin?.candidate).toBeUndefined();
    expect(twin?.candidates.sort()).toEqual(["src/keepA.ts#twin", "src/keepB.ts#twin"]);

    expect(rowFor(measured.rows, "src/gone.ts#vanished")).toMatchObject({ bucket: "gone" });

    // The file anchors for the three deletions have nothing to follow either:
    // no rename, and no other file by that name.
    for (const ref of ["src/beta.ts", "src/twin.ts", "src/gone.ts"]) {
      expect(rowFor(measured.rows, ref)).toMatchObject({ bucket: "gone" });
    }

    expect(tally(measured.rows)).toEqual({ followable: 3, ambiguous: 1, gone: 4 });
  });

  it("finds the same move through a ref that was really on a board", async () => {
    const measured = await measureRebind({ repo });

    expect(measured.rows).toHaveLength(1);
    expect(measured.rows[0]).toMatchObject({
      board: BOARD,
      ref: "src/alpha.ts#alpha",
      bucket: "followable",
      channel: "rename",
      candidate: "src/moved/alpha.ts#alpha",
      // Nobody has corrected this board, so there is nothing to check against.
      verdict: "unfixed",
    });
  });
});

describe("what the human wrote afterwards", () => {
  it("scores the candidate against the hand edit that eventually landed", async () => {
    const file = path.join(repo, BOARD);
    writeFileSync(file, readFileSync(file, "utf8").replace("src/alpha.ts#alpha", "src/moved/alpha.ts#alpha"));
    commit("point the box at where alpha went");

    const measured = await measureRebind({ repo });
    expect(measured.rows[0]).toMatchObject({
      verdict: "agreed",
      humanWrote: "src/moved/alpha.ts#alpha",
    });
  });
});
