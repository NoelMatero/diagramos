/**
 * The board command's argument surface (#83).
 *
 * `diagramos board stop` is an easy slip for `diagramos stop`, and the
 * implied-extension rule used to answer it by silently creating an empty
 * stop.excalidraw at the repo root and serving it. What is pinned here is the
 * refusal: the correct spelling in a sentence, exit 2, and above all no new
 * file -- a command that answers a typo by manufacturing a board is the bug.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts/board.mjs");
const TSX = path.join(REPO, "node_modules/.bin/tsx");

let project: string;

async function board(...args: string[]): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await run(TSX, [SCRIPT, ...args], {
      cwd: project,
      // Hermetic even if the guard under test is broken: a run that got past it
      // would talk to its own registry and never open a browser, instead of
      // joining the machine's real board service.
      env: {
        ...process.env,
        DIAGRAMOS_STATE_DIR: path.join(project, ".state"),
        DIAGRAMOS_NO_OPEN: "1",
      },
    });
    return { code: 0, stderr };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? -1, stderr: failure.stderr ?? "" };
  }
}

beforeAll(() => {
  project = mkdtempSync(path.join(tmpdir(), "board-args-"));
  mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
});

afterAll(() => {
  if (project) rmSync(project, { recursive: true, force: true });
});

describe("diagramos board and the sibling verbs", () => {
  it.each(["stop", "drift", "serve"])(
    "refuses %s with the correct spelling instead of creating %s.excalidraw",
    async (verb) => {
      const result = await board(verb);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`diagramos ${verb}`);
      // The escape hatch is named, for the person whose board really is called that.
      expect(result.stderr).toContain(`${verb}.excalidraw`);
      // The original failure: the file the typo used to manufacture.
      expect(existsSync(path.join(project, `${verb}.excalidraw`))).toBe(false);
    },
  );

  it("points help at --help", async () => {
    const result = await board("help");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--help");
    expect(existsSync(path.join(project, "help.excalidraw"))).toBe(false);
  });

  it("refuses the verb even alongside real boards, and creates none of them", async () => {
    // The refusal must come before any board is materialised: half a command
    // succeeding is how a typo still leaves a file behind.
    const result = await board("docs/diagrams/real", "stop");
    expect(result.code).toBe(2);
    expect(existsSync(path.join(project, "docs/diagrams/real.excalidraw"))).toBe(false);
    expect(readdirSync(project)).not.toContain("stop.excalidraw");
  });
});
