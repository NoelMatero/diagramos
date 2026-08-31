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

/**
 * Filler that survives a move, so git scores the move a rename rather than a
 * delete and an add.
 *
 * Tagged per file, and that is load-bearing rather than tidy. Git pairs a
 * deletion with an addition by how alike they are and knows nothing about which
 * `git mv` produced which; give two unrelated files the same filler and they
 * become 96% matches for each other, so git cheerfully reports this file moving
 * to that one's destination. Only the case that is *meant* to be a duplication
 * shares a tag.
 */
function bulk(tag: string): string {
  return Array.from(
    { length: 30 },
    (_unused, index) => `export function ${tag}Filler${index}(): number {\n  return ${index};\n}\n`,
  ).join("");
}

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
  write("src/splitter.ts", `${bulk("splitter")}export function stayer(): number {\n  return 5;\n}\n`);
  // 6. A file that moves carrying a name half the tree also declares. The
  //    common-method case (#168): `serve` here is `new` or `parse` in the wild.
  write("src/common.ts", `${bulk("common")}export function serve(): number {\n  return 6;\n}\n`);
  write("src/alpha.ts", "export function serve(): number {\n  return 61;\n}\n");
  write("src/beta.ts", "export function serve(): number {\n  return 62;\n}\n");
  write("src/gamma.ts", "export function serve(): number {\n  return 63;\n}\n");
  // 7. The trap the guard exists for: a move *and* a rename in one step, where
  //    the old name survives at the destination only as calls to somebody else's.
  write("src/trap.ts", `${bulk("trap")}export function capture(text: string): string {\n  return text;\n}\n`);
  // 8. A file about to be duplicated rather than moved. No symbol on the box,
  //    so only git's own record can answer for it -- and git's record will be a
  //    pick between two near-copies.
  write("src/dup.ts", `${bulk("dup")}export function harvest(): number {\n  return 8;\n}\n`);
  /*
   * 9. A file whose recorded move lands in build output (#174).
   *
   * `Cargo.toml` beside it is what makes `target/` build output rather than
   * somebody's module, and it is the same corroboration `generatedRef` wants.
   * The move is a real `git mv`, so git records an R100 and the rename channel
   * -- the one channel whose answer `repair.ts` writes to a board unread -- had
   * every reason to offer it.
   */
  write("Cargo.toml", "[package]\nname = \"planted\"\n");
  write("src/artifact.ts", `${bulk("artifact")}export function cached(): number {\n  return 9;\n}\n`);
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
  write("src/engine/splitter.ts", bulk("splitter"));
  // 6. Recorded move, and `serve` is at the destination -- along with three
  //    other declarations of the same name that have nothing to do with it.
  git("mv", "src/common.ts", "src/relocated.ts");
  // 7. Recorded move, and `capture` was renamed to `grab` on the way. It is
  //    still written three times at the destination, every one of them a call
  //    into a package this tree does not contain. Mentions, never a declaration.
  git("mv", "src/trap.ts", "src/trapped.ts");
  write(
    "src/trapped.ts",
    `${bulk("trap")}import { outside } from "outside-lib";\n\n`
      + "export function grab(text: string): string {\n  return outside.capture(text);\n}\n\n"
      + "export function grabAll(texts: string[]): string[] {\n  return texts.map((text) => outside.capture(text));\n}\n\n"
      + "export function grabFirst(texts: string[]): string {\n  return outside.capture(texts[0] ?? \"\");\n}\n",
  );
  // 8. Deleted and landed twice. `--find-renames` on its own calls this an
  //    R100 to whichever copy scores best, indistinguishable from a `git mv`.
  rmSync(path.join(repo, "src/dup.ts"));
  // Same tag as `src/dup.ts`: these two are meant to be its near-copies.
  write("src/dupA.ts", `${bulk("dup")}export function harvest(): number {\n  return 8;\n}\n`);
  write("src/dupB.ts", `${bulk("dup")}export function harvest(): number {\n  return 80;\n}\n`);
  // 9. Into `target/`, which is what a repository that commits its build output
  //    looks like to git: an ordinary recorded rename to an address no box may
  //    point at.
  mkdirSync(path.join(repo, "target/debug"), { recursive: true });
  git("mv", "src/artifact.ts", "target/debug/artifact.ts");
  commit("the refactor");

  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "mover", label: "Mover", ref: "src/mover.ts" },
      { id: "lodger", label: "Lodger", ref: "src/host.ts#lodger" },
      { id: "twin", label: "Twin", ref: "src/twinned.ts#twin" },
      { id: "doomed", label: "Doomed", ref: "src/doomed.ts#doomed" },
      { id: "split", label: "Split", ref: "src/splitter.ts#stayer" },
      { id: "common", label: "Common", ref: "src/common.ts#serve" },
      { id: "trap", label: "Trap", ref: "src/trap.ts#capture" },
      { id: "dup", label: "Dup", ref: "src/dup.ts" },
      { id: "artifact", label: "Artifact", ref: "src/artifact.ts" },
      { id: "artifactSymbol", label: "Artifact symbol", ref: "src/artifact.ts#cached" },
    ],
    edges: [],
  });
  report = checkDrift(board, createWorkspace(repo), { trail: createGitTrail(repo) });
  // Same budget the MCP block below asks for. Seven planted refactors, each one
  // a real git history and a real parse; the default 30s is a machine-load
  // gamble rather than a statement about this suite.
}, 120_000);

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

  /*
   * #168. A `git mv` used to follow the symbols with rare names and abandon the
   * ones with common names, out of the same commit and the same file, because a
   * repo-wide count of the name outranked git's record that this file moved.
   * They are answers to two different questions and the specific one wins.
   */
  it("follows a recorded move even when the name is declared all over the tree", () => {
    const common = forNode("common");
    expect(common?.becomes).toBe("src/relocated.ts#serve");
    expect(common?.via).toBe("rename");
    expect(common?.detail).toContain("git recorded the rename");
    // The thing that used to sink it: the name is genuinely ambiguous tree-wide.
    expect(report.followed.some((entry) => entry.node === "common" && entry.candidates))
      .toBe(false);
  });

  /*
   * The other half of #168, and the reason the rule asks the destination about a
   * *declaration* rather than about the word. A move and a rename in one step
   * leaves the old name at the destination as calls into somebody else's
   * function, and following that would silently re-aim the box at a call site.
   */
  it("still refuses a recorded move that renamed the symbol on the way", () => {
    const trap = forNode("trap");
    expect(trap?.becomes).toBeUndefined();
    expect(trap?.via).toBeUndefined();
    expect(trap?.detail).toContain("needs a person");
  });

  /*
   * What #168 cost, and where it was paid back.
   *
   * Git's rename record is a similarity verdict, not a receipt. A file deleted
   * and landed twice reports `R100` to whichever copy scored best, and that used
   * to be caught downstream by the very ambiguity count #168 overrides -- so
   * inverting the precedence without moving this guard would have swapped one
   * silent mis-aim for another. It is asked of git directly now: a source with
   * more than one continuation is a choice git made, not a move it recorded.
   */
  it("refuses a move git had to choose between two copies", () => {
    expect(forNode("dup")).toBeUndefined();
  });

  it("leaves the finding standing either way", () => {
    // Every node above is still wrong, and a suggestion is not a repair. A
    // followed ref that quietly stopped counting would turn a stale board green.
    expect(report.clean).toBe(false);
    // One per box on the board, and every box is planted stale. Counted rather
    // than sampled because the number going *down* is the regression that
    // matters: a refusal to suggest must never become a refusal to report, which
    // is exactly what the build-output guard below could have broken (#174).
    expect(report.findings.length).toBe(10);
    expect(report.findings.map((finding) => finding.node).sort()).toEqual([
      "artifact", "artifactSymbol", "common", "doomed", "dup",
      "lodger", "mover", "split", "trap", "twin",
    ]);
  });
});

/**
 * The precedence rule of #168, stated against injected trails so each half is
 * one fact rather than a repository.
 *
 * The repo-built cases above prove the rule end to end; these pin *why* it is
 * asked the way it is. `declaring` giving up is not the same as `declaring`
 * finding nothing, and the destination is the only one of the two that can tell
 * the difference.
 */
describe("git's record of a move against a count of the name", () => {
  const anchor = {
    node: "n",
    label: "Route",
    ref: "src/route.rs#parse",
    path: "src/route.rs",
    symbol: "parse",
    name: "parse",
    kind: "missing-file" as const,
  };

  it("takes the destination over a tree full of the same name", () => {
    const [followed] = followAnchors([anchor], {
      renamedTo: () => "src/router.rs",
      declaring: () => ["src/query.rs", "src/router.rs", "src/store.rs"],
      declaresAt: (file, symbol) => file === "src/router.rs" && symbol === "parse",
    });
    expect(followed.becomes).toBe("src/router.rs#parse");
    expect(followed.via).toBe("rename");
  });

  /*
   * A name mentioned in more files than the search will parse comes back empty,
   * which is indistinguishable from a name that is genuinely nowhere. That empty
   * list used to be read as "the symbol stayed behind" and printed as a split
   * -- a confident sentence about a refactor that never happened.
   */
  it("does not read a search that gave up as a symbol left behind", () => {
    const [followed] = followAnchors([anchor], {
      renamedTo: () => "src/router.rs",
      declaring: () => [],
      declaresAt: () => true,
    });
    expect(followed.becomes).toBe("src/router.rs#parse");
    expect(followed.detail).not.toContain("was split");
  });

  it("still calls it a split when the destination really does not declare it", () => {
    const [followed] = followAnchors([anchor], {
      renamedTo: () => "src/router.rs",
      declaring: () => [],
      declaresAt: () => false,
    });
    expect(followed.becomes).toBeUndefined();
    expect(followed.detail).toContain("needs a person");
  });

  /*
   * The search costs a `git grep` and a parse of everything it matched, and
   * since #168 the common answer does not need it. A big move used to pay that
   * once per name on its way to an answer git had already given.
   */
  it("does not search the tree for a name the move already placed", () => {
    let searched = 0;
    followAnchors([anchor], {
      renamedTo: () => "src/router.rs",
      declaring: () => {
        searched += 1;
        return [];
      },
      declaresAt: () => true,
    });
    expect(searched).toBe(0);
  });

  /*
   * A move is evidence about the file that moved, and nothing else. Without a
   * recorded rename the destination is never asked about, so this stays the
   * two-channel follower the measurement allowed.
   */
  it("asks the destination nothing when git recorded no move", () => {
    let asked = 0;
    const [followed] = followAnchors([anchor], {
      renamedTo: () => undefined,
      declaring: () => ["src/query.rs", "src/store.rs"],
      declaresAt: () => {
        asked += 1;
        return true;
      },
    });
    expect(asked).toBe(0);
    expect(followed.becomes).toBeUndefined();
    expect(followed.candidates).toEqual(["src/query.rs#parse", "src/store.rs#parse"]);
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
      declaresAt: () => false,
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

  /*
   * The hole #174 was about: the one channel that writes a ref nobody read.
   *
   * `repair.ts` applies an unambiguous `becomes` on sight, so a destination this
   * module offers is a string that lands in a board file with no human between.
   * The two search channels were filtered from the start; the rename channel was
   * not, and a repository that commits its build output turns cargo's own copy
   * of a source file into an R100 git reports as a move.
   *
   * Both shapes of anchor, because all three branches read the same destination
   * and the prose-only one must not name it either -- an address a box may not
   * point at is not an address to print at somebody.
   */
  it("will not follow a recorded move into build output", () => {
    expect(forNode("artifact")).toBeUndefined();
    expect(forNode("artifactSymbol")).toBeUndefined();
  });

  it("still reports the move itself, so the trail is not the thing lying", () => {
    // The judgement belongs to the follower, not to the trail: git really did
    // record this, and a `Trail` that edited git's answer would be the wrong
    // layer to fix it in.
    expect(createGitTrail(repo).renamedTo("src/artifact.ts")).toBe("target/debug/artifact.ts");
  });

  it("follows a move whose destination merely looks generated", () => {
    /*
     * The other half, and the reason this is `inNeverWalk` and not a substring
     * test. `vendor` is on the never-walk list and `src/engine/vendor/` is a real
     * directory of real source in this repository -- but a *segment* called
     * `target` deep inside `src/` is somebody's module, and refusing to follow
     * into it would be a suggestion silently withheld forever.
     */
    const intoSource: Trail = {
      renamedTo: () => "src/compiler/targets/wasm.ts",
      declaring: () => [],
      declaresAt: () => true,
    };
    const followed = followAnchors(
      [{
        node: "n",
        label: "Targets",
        ref: "src/targets/wasm.ts",
        path: "src/targets/wasm.ts",
        kind: "missing-file",
      }],
      intoSource,
    );
    expect(followed[0]?.becomes).toBe("src/compiler/targets/wasm.ts");
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
