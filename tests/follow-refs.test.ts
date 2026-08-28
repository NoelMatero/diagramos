/**
 * Following a stale anchor to where the code actually went.
 *
 * A repository is built here rather than this one being read, for the same
 * reason `rebind-measure.test.ts` builds one: the cases that matter are the ones
 * that go wrong, and a real history hands you whichever of them it happens to
 * contain. Every case the follower distinguishes is planted deliberately --
 * a file that moved, a name that moved on its own, a name that now lives in two
 * places, a file that split, and something genuinely deleted.
 *
 * The two negative cases are the point of the exercise. A suggestion is read as
 * an instruction, so a follower that answers when it should not is worse than
 * one that never answers at all, and the ambiguous case and the split case are
 * where a filename-matching follower would have spoken confidently and been
 * wrong.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { emptyBoard } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { createGitTrail, followAnchors, type Trail } from "../src/engine/follow";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

let repo: string;
let report: DriftReport;

/** Filler that survives a move, so git scores the move a rename rather than a delete and an add. */
const BULK = Array.from(
  { length: 30 },
  (_unused, index) => `export function filler${index}(): number {\n  return ${index};\n}\n`,
).join("");

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

/** The suggestion for one box, by node id. Absent where nothing could be followed. */
function forNode(node: string) {
  return report.followed.find((entry) => entry.node === node);
}

beforeAll(async () => {
  await initEngine();
  repo = mkdtempSync(path.join(os.tmpdir(), "follow-"));
  git("init", "-q");

  write("src/mover.ts", "export function mover(): number {\n  return 1;\n}\n");
  write("src/host.ts", "export function lodger(): number {\n  return 2;\n}\n");
  write("src/twinned.ts", "export function twin(): number {\n  return 3;\n}\n");
  write("src/doomed.ts", "export function doomed(): number {\n  return 4;\n}\n");
  // Bulky on purpose: git calls a move a rename by how much of the file
  // survived it, so a split has to be a small hole in a large file.
  write("src/splitter.ts", `${BULK}export function stayer(): number {\n  return 5;\n}\n`);
  commit("the starting tree");

  // 1. A whole file moved, unchanged. Git records this one itself.
  mkdirSync(path.join(repo, "src/engine"), { recursive: true });
  git("mv", "src/mover.ts", "src/engine/mover.ts");
  // 2. A name moved out of a file that is still there.
  write("src/host.ts", "export function stillHere(): number {\n  return 2;\n}\n");
  write("src/lodgings.ts", "export function lodger(): number {\n  return 2;\n}\n");
  // 3. A name that now lives in two places. Nothing may pick one.
  rmSync(path.join(repo, "src/twinned.ts"));
  write("src/twinA.ts", "export function twin(): number {\n  return 3;\n}\n");
  write("src/twinB.ts", "export function twin(): number {\n  return 30;\n}\n");
  // 4. Genuinely deleted. Correctly a finding and nothing else.
  rmSync(path.join(repo, "src/doomed.ts"));
  // 5. A file whose move git records, with the one name the board cared about
  //    dropped on the way. The rest of the file survives, so it is still a
  //    rename; the box's claim did not make the trip.
  git("mv", "src/splitter.ts", "src/engine/splitter.ts");
  write("src/engine/splitter.ts", BULK);
  commit("the refactor");

  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "mover", label: "Mover", ref: "src/mover.ts" },
      { id: "lodger", label: "Lodger", ref: "src/host.ts#lodger" },
      { id: "twin", label: "Twin", ref: "src/twinned.ts#twin" },
      { id: "doomed", label: "Doomed", ref: "src/doomed.ts#doomed" },
      { id: "split", label: "Split", ref: "src/splitter.ts#stayer" },
    ],
    edges: [],
  });
  report = checkDrift(board, createWorkspace(repo), { trail: createGitTrail(repo) });
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("following a stale ref to where the code went", () => {
  it("reads a whole-file move straight off git", () => {
    const moved = forNode("mover");
    expect(moved?.becomes).toBe("src/engine/mover.ts");
    expect(moved?.via).toBe("rename");
    expect(moved?.detail).toContain("git recorded the rename");
  });

  it("finds a name that left its file, when it is declared in exactly one other", () => {
    const lodger = forNode("lodger");
    expect(lodger?.becomes).toBe("src/lodgings.ts#lodger");
    expect(lodger?.via).toBe("symbol");
    expect(lodger?.detail).toContain("nowhere else");
  });

  it("refuses to pick when the name is declared in more than one place", () => {
    const twin = forNode("twin");
    expect(twin?.becomes).toBeUndefined();
    expect(twin?.candidates).toEqual(["src/twinA.ts#twin", "src/twinB.ts#twin"]);
    expect(twin?.detail).toContain("nothing here can pick one");
  });

  it("says nothing at all about code that is simply gone", () => {
    expect(forNode("doomed")).toBeUndefined();
  });

  it("will not follow a rename that left the symbol behind", () => {
    const split = forNode("split");
    expect(split?.becomes).toBeUndefined();
    expect(split?.detail).toContain("needs a person");
  });

  it("leaves the finding standing either way", () => {
    // Every node above is still wrong, and a suggestion is not a repair. A
    // followed ref that quietly stopped counting would turn a stale board green.
    expect(report.clean).toBe(false);
    expect(report.findings.length).toBe(5);
  });
});

describe("what the follower will not do", () => {
  it("says nothing when no trail is supplied", () => {
    const quiet = checkDrift(
      { ...emptyBoard(), elements: [] },
      createWorkspace(repo),
    );
    expect(quiet.followed).toEqual([]);
  });

  /*
   * The channel the measurement threw out (#140). Every wrong answer in both
   * histories replayed came from matching a basename, and all three were a file
   * called `index.ts` or `__init__.py`. A name every directory has identifies
   * nothing, so a follower that is asked about one has to come back empty even
   * though there is exactly one file it could mean.
   */
  it("does not follow a filename, however lonely the match", () => {
    const lookalike: Trail = {
      renamedTo: () => undefined,
      declaring: () => [],
    };
    const followed = followAnchors(
      [{
        node: "n",
        label: "Server",
        ref: "src/server/index.ts",
        path: "src/server/index.ts",
        kind: "missing-file",
      }],
      lookalike,
    );
    expect(followed).toEqual([]);
  });

  it("survives a directory that is not a git repository", () => {
    const bare = mkdtempSync(path.join(os.tmpdir(), "nogit-"));
    try {
      const trail = createGitTrail(bare);
      expect(trail.renamedTo("src/anything.ts")).toBeUndefined();
      expect(trail.declaring("anything")).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

/**
 * The same answer over the wire, because the MCP server is where a model meets
 * it and a field the engine fills but the tool drops helps nobody.
 *
 * A repository of its own rather than the one `mcp-server.test.ts` uses: that
 * workspace is deliberately not a git repository, and initialising it would
 * change what the deleted-box check sees for every test in that file.
 */
describe("over the MCP tool surface", () => {
  const BOARD = "docs/diagrams/arch.excalidraw";
  let space: string;
  let client: Client;

  function run(...args: string[]): void {
    execFileSync("git", args, { cwd: space, stdio: "ignore" });
  }

  function land(message: string): void {
    run("add", "-A");
    execFileSync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", message],
      { cwd: space, stdio: "ignore" },
    );
  }

  async function callTool(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
    return JSON.parse(
      content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"),
    ) as Record<string, unknown>;
  }

  beforeAll(async () => {
    space = realpathSync(mkdtempSync(path.join(os.tmpdir(), "follow-mcp-")));
    mkdirSync(path.join(space, "src"), { recursive: true });
    writeFileSync(path.join(space, "src/before.ts"), "export function shape(): number {\n  return 1;\n}\n");
    run("init", "-q");
    land("start");
    mkdirSync(path.join(space, "src/engine"), { recursive: true });
    run("mv", "src/before.ts", "src/engine/after.ts");
    land("move it");

    client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: "npx",
        args: ["tsx", path.join(path.resolve(__dirname, ".."), "src/mcp/server.ts")],
        cwd: path.resolve(__dirname, ".."),
        env: { ...process.env, DIAGRAMOS_MCP_ROOT: space },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    if (space) rmSync(space, { recursive: true, force: true });
  });

  it("tells the author at draw time, while the ref is still theirs to fix", async () => {
    const drawn = await callTool("create_diagram", {
      path: BOARD,
      title: "Arch",
      nodes: [{ id: "s", label: "Shape", ref: "src/before.ts" }],
      edges: [],
    });
    expect(drawn.pointsAtNothing).toEqual(["Shape → src/before.ts"]);
    expect(String((drawn.movedTo as string[])[0])).toContain("src/engine/after.ts");
  }, 120_000);

  it("carries the address on check_drift, beside the finding and not instead of it", async () => {
    const report = await callTool("check_drift", {});
    expect(report.clean).toBe(false);
    const followed = report.followed as Array<Record<string, unknown>>;
    expect(followed).toHaveLength(1);
    expect(followed[0].becomes).toBe("src/engine/after.ts");
    expect(followed[0].via).toBe("rename");
    expect(followed[0].board).toBe(BOARD);
    // The finding is untouched. A suggestion that quietly resolved one would be
    // the silent wrong rebind this whole design refuses to make.
    expect((report.findings as unknown[]).length).toBe(1);
  }, 120_000);
});
