/**
 * The board rewriting its own addresses, and everything it refuses to rewrite.
 *
 * `follow-refs.test.ts` covers working out where the code went. This covers the
 * edit, and almost all of it is about restraint. The measurement that allowed
 * this at all (`docs/rebind-measurement.md`) found one failure mode and it is
 * the silent one: a board that quietly re-aims itself at the wrong function
 * looks exactly like a board that was right all along. So the guards are the
 * feature, and every one of them is pinned here -- a box that is not the one the
 * report was answering about, a box nobody recorded, an answer with more than
 * one candidate, and the whole rest of the element.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, readBoard, writeBoard } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { createGitTrail } from "../src/engine/follow";
import { initEngine } from "../src/engine/parse";
import { applyFollowed } from "../src/engine/repair";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts/check-drift.mjs");
const TSX = path.join(REPO, "node_modules/.bin/tsx");
const BOARD = "docs/diagrams/arch.excalidraw";

let repo: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function land(message: string): void {
  git("add", "-A");
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", message],
    { cwd: repo, stdio: "ignore" },
  );
}

async function drawBoard() {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "moved", label: "Moved", ref: "src/before.ts" },
      { id: "steady", label: "Steady", ref: "src/steady.ts" },
    ],
    edges: [],
  });
  await writeBoard(path.join(repo, BOARD), board);
}

function check(board: Parameters<typeof checkDrift>[0]): DriftReport {
  return checkDrift(board, createWorkspace(repo), { trail: createGitTrail(repo) });
}

beforeAll(async () => {
  await initEngine();
  repo = mkdtempSync(path.join(os.tmpdir(), "repair-"));
  mkdirSync(path.join(repo, "docs/diagrams"), { recursive: true });
  mkdirSync(path.join(repo, "src"), { recursive: true });
  git("init", "-q");
  writeFileSync(path.join(repo, "src/before.ts"), "export function moved(): number {\n  return 1;\n}\n");
  writeFileSync(path.join(repo, "src/steady.ts"), "export const steady = true;\n");
  await drawBoard();
  land("start");
  mkdirSync(path.join(repo, "src/engine"), { recursive: true });
  git("mv", "src/before.ts", "src/engine/after.ts");
  land("move it");
}, 120_000);

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("writing a followed ref back to the board", () => {
  it("rewrites the ref, and says what it was", async () => {
    const board = await readBoard(path.join(repo, BOARD));
    const result = applyFollowed(board, check(board));
    expect(result.applied).toEqual([
      {
        node: "moved",
        label: "Moved",
        was: "src/before.ts",
        now: "src/engine/after.ts",
        via: "rename",
      },
    ]);
    expect(result.held).toEqual([]);
  }, 120_000);

  it("leaves the repaired board with nothing to report", async () => {
    const board = await readBoard(path.join(repo, BOARD));
    const repaired = applyFollowed(board, check(board)).board;
    expect(check(repaired).clean).toBe(true);
  }, 120_000);

  it("changes the address and nothing else about the box", async () => {
    const board = await readBoard(path.join(repo, BOARD));
    const repaired = applyFollowed(board, check(board)).board;
    const before = board.elements.find(
      (element) => (element.customData as { node?: string } | undefined)?.node === "moved",
    );
    const after = repaired.elements.find(
      (element) => (element.customData as { node?: string } | undefined)?.node === "moved",
    );
    expect(after).toBeDefined();
    // Everything that decides where the box is and what it says, untouched. A
    // repair that also re-laid-out the board would be doing what regeneration
    // does, which is the thing people arrange by hand and lose.
    for (const key of ["x", "y", "width", "height", "type", "strokeStyle", "boundElements"] as const) {
      expect((after as Record<string, unknown>)[key]).toEqual((before as Record<string, unknown>)[key]);
    }
    // The version moves, because something did change and a viewer has to notice.
    expect(Number(after!.version)).toBeGreaterThan(Number(before!.version));
  }, 120_000);

  it("does not touch a box whose code never moved", async () => {
    const board = await readBoard(path.join(repo, BOARD));
    const repaired = applyFollowed(board, check(board)).board;
    const steady = repaired.elements.find(
      (element) => (element.customData as { node?: string } | undefined)?.node === "steady",
    );
    expect((steady!.customData as { ref?: string }).ref).toBe("src/steady.ts");
  }, 120_000);

  it("holds an answer whose box no longer carries the ref it was about", async () => {
    const board = await readBoard(path.join(repo, BOARD));
    const report = check(board);
    // Somebody edited the box between the check and the write. The answer is
    // about a ref that is not there any more, so writing it would be a guess at
    // what they meant.
    const moved = board.elements.map((element) => {
      const custom = element.customData as { node?: string; ref?: string } | undefined;
      if (custom?.node !== "moved") return element;
      return { ...element, customData: { ...custom, ref: "src/somewhere-else.ts" } };
    });
    const result = applyFollowed({ ...board, elements: moved }, report);
    expect(result.applied).toEqual([]);
    expect(result.held).toHaveLength(1);
    expect(result.held[0].ref).toBe("src/before.ts");
  }, 120_000);

  it("writes nothing when the follower declined to pick", async () => {
    const board = await readBoard(path.join(repo, BOARD));
    const report = check(board);
    // The shape the follower returns when a name lives in more than one place:
    // candidates and no `becomes`. Nothing may act on it.
    const undecided: DriftReport = {
      ...report,
      followed: report.followed.map((entry) => ({
        node: entry.node,
        label: entry.label,
        ref: entry.ref,
        candidates: ["src/one.ts", "src/two.ts"],
        detail: entry.detail,
      })),
    };
    const result = applyFollowed(board, undecided);
    expect(result.applied).toEqual([]);
    expect(result.board).toBe(board);
  }, 120_000);
});

describe("--repair on the command line", () => {
  /**
   * Both streams, because the report goes to stderr and the exit code is 1
   * whenever anything is still stale -- reading only stdout on success made
   * these assertions pass against an empty string.
   */
  function run(...args: string[]): string {
    const result = spawnSync(TSX, [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  }

  function refOf(node: string): string | undefined {
    const board = JSON.parse(readFileSync(path.join(repo, BOARD), "utf8")) as {
      elements: Array<{ customData?: { node?: string; ref?: string } }>;
    };
    return board.elements.find((element) => element.customData?.node === node)?.customData?.ref;
  }

  it("does not write anything without being asked", async () => {
    await drawBoard();
    run();
    expect(refOf("moved")).toBe("src/before.ts");
  }, 120_000);

  it("rewrites the ref and prints the change, old address and new", async () => {
    await drawBoard();
    const said = run("--repair");
    expect(refOf("moved")).toBe("src/engine/after.ts");
    expect(said).toContain("src/before.ts → src/engine/after.ts");
    expect(said).toContain("repaired");
  }, 120_000);

  it("reports the board as clean on the same run that repaired it", async () => {
    await drawBoard();
    const said = run("--repair");
    // Re-checked after the write, so the finding the repair answered is gone
    // rather than being printed next to the repair that fixed it.
    expect(said).not.toContain("Moved → src/before.ts");
  }, 120_000);

  it("never repairs on the per-turn path", async () => {
    await drawBoard();
    // --hook is the unattended caller. A silent rebind is the one thing this
    // whole design refuses, so the flag must not reach it even if both are passed.
    run("--hook", "--repair");
    expect(refOf("moved")).toBe("src/before.ts");
  }, 120_000);
});
