/**
 * The second opinion for the languages whose compiler answers over a pipe
 * (#337 part A, #334).
 *
 * `refereedCheck` gets a TypeScript board the compiler's answer in the same
 * breath, because `tsc` is a library. pyright and rust-analyzer are separate
 * processes: a question at a time, over a pipe, a second or two to wake up.
 * So a Python or Rust board checked anywhere but the standalone CLI got the
 * text reading, and said nothing about it -- which is the whole of #334.
 *
 * What is pinned here is that a Python board can now get the real check, that
 * it changes an answer, that a right arrow does not turn red on the way, and
 * that whichever check the board got, the board can say which one it was.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { refereedCheckLive, refereeSentence } from "../src/engine/referee-live";
import { installExcalifontMeasurer } from "./helpers/excalifont";
import { assertFreshCliBundle } from "./helpers/fresh-bundle";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

/** The same check every other rust-analyzer test here makes: the live half needs the real binary. */
const hasRustAnalyzer = (() => {
  try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

let repo: string;

function write(relative: string, contents: string): void {
  const full = path.join(repo, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

async function boardOf(fromRef: string, toRef: string): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "caller", label: "run", ref: fromRef },
      { id: "callee", label: "render", ref: toRef },
    ],
    edges: [{ from: "caller", to: "callee", claim: "calls" }],
  });
  return board;
}

beforeEach(() => {
  // Outside the worktree on purpose: a scratch source file inside one is read
  // by the dependency tests as though it belonged to this repository.
  repo = mkdtempSync(path.join(tmpdir(), "engine-referee-live-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/*
 * The Python shape of #337's largest wall: 32 of the `@calls` arrows the bench
 * misses stop at a call on a value whose type is not written down. `thing` is
 * whatever `make()` returns and nothing in `a.py` says what that is, so the
 * body never closes and the arrow goes quiet whether it is right or wrong.
 */
const PYTHON: Record<string, string> = {
  "thing.py": "class Thing:\n    def greet(self):\n        return \"hi\"\n",
  "make.py": "from thing import Thing\n\n\ndef make():\n    return Thing()\n",
  "a.py": "from make import make\n\n\ndef run():\n    thing = make()\n    return thing.greet()\n",
  "b.py": "def render(n):\n    return n\n",
};

describe("a Python call on a value whose type the text does not give", () => {
  it("leaves the arrow unanswered with no referee, and calls it wrong with one", async () => {
    for (const [file, contents] of Object.entries(PYTHON)) write(file, contents);
    const workspace = createWorkspace(repo);
    // `run` never reaches `b.py`, so the arrow really is wrong -- the only
    // thing in the way is that `thing`'s type is not written down.
    const board = await boardOf("a.py#run", "b.py#render");

    const quiet = checkDrift(board, workspace, { edges: true });
    expect(quiet.edges.filter((finding) => finding.kind === "calls-refuted")).toEqual([]);
    expect(quiet.claims.callsNotClosed.receiver).toBe(1);

    const live = await refereedCheckLive(repo, (referee) =>
      checkDrift(board, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));

    expect(live.report.edges.filter((finding) => finding.kind === "calls-refuted")).toHaveLength(1);
    expect(live.checkedWith.answered).toContain("python");
  }, 120_000);

  it("still confirms the arrow the resolver places at the far end", async () => {
    /*
     * The same shape with the far end where the call actually lands. A
     * resolver that turned every unresolved receiver into an accusation would
     * fail here, and that is the failure worth having a test for: a false red
     * spends trust the tool cannot re-earn, and #337's definition of done
     * holds true claims called wrong at zero.
     */
    for (const [file, contents] of Object.entries(PYTHON)) write(file, contents);
    const workspace = createWorkspace(repo);
    const board = await boardOf("a.py#run", "thing.py#Thing");

    const live = await refereedCheckLive(repo, (referee) =>
      checkDrift(board, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));

    expect(live.report.edges.filter((finding) => finding.kind === "calls-refuted")).toEqual([]);
  }, 120_000);
});

describe("what a board pays", () => {
  it("starts nothing when the first pass already settled every arrow", async () => {
    /*
     * The common case and the whole reason this is affordable at draw time.
     * `run` reaches `render` in the text alone, so there is nothing a compiler
     * could add -- and a check that woke pyright to find that out is the shape
     * of a check people switch off. Twelve of the thirty Python and Rust
     * boards in the bench are this case.
     */
    write("b.py", "def render(n):\n    return n\n");
    write("a.py", "from b import render\n\n\ndef run():\n    return render(1)\n");
    const workspace = createWorkspace(repo);
    const board = await boardOf("a.py#run", "b.py#render");

    const asked: boolean[] = [];
    const started = Date.now();
    const live = await refereedCheckLive(repo, (referee) => {
      asked.push(referee !== undefined);
      return checkDrift(board, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) });
    });

    expect(asked).toEqual([false]);
    expect(live.checkedWith.nothingToAsk).toBe(true);
    expect(live.checkedWith.answered).toEqual([]);
    // pyright cannot start and answer in this, so the assertion is about the
    // server never having been reached rather than about the clock alone.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(live.report.edges).toEqual([]);
  }, 120_000);

  it("falls back to the text reading, and says so, when there is no time to start a server", async () => {
    /*
     * A tree whose servers cannot be up in the budget must degrade rather than
     * hang. Losing a confirmation is the right direction to err in; hanging a
     * check that runs every turn is not. Zero is the honest way to ask for
     * "no server may start", since the budget bounds starting rather than
     * answering.
     */
    for (const [file, contents] of Object.entries(PYTHON)) write(file, contents);
    const workspace = createWorkspace(repo);
    const board = await boardOf("a.py#run", "b.py#render");

    const live = await refereedCheckLive(repo, (referee) =>
      checkDrift(board, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }), { budgetMs: 0 });

    expect(live.report.edges.filter((finding) => finding.kind === "calls-refuted")).toEqual([]);
    expect(live.checkedWith.answered).not.toContain("python");
    expect(live.checkedWith.silent).toContain("python");
    expect(refereeSentence(live.checkedWith)).toContain("pyright did not answer");
  }, 120_000);
});

describe("a Rust call on a value whose type the text does not give", () => {
  /*
   * The other half of #337's largest wall: 25 of the missed `@calls` arrows
   * are Rust, and rust-analyzer is the thing that answers them. `c` is
   * whatever `make()` returns, which is written in another file, so the
   * reader's own name search inside `a.rs` has nothing to place.
   */
  function writeCrate(): void {
    write("Cargo.toml", "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n");
    write("src/lib.rs", "pub mod decl;\npub mod a;\npub mod b;\n");
    write("src/decl.rs",
      "pub struct Config { pub name: String }\n"
      + "impl Config {\n"
      + "    pub fn load(&self) -> u32 { 7 }\n"
      + "}\n"
      + "pub fn make() -> Config { Config { name: String::new() } }\n");
    write("src/a.rs",
      "use crate::decl::make;\n\n"
      + "pub fn run() -> u32 {\n    let c = make();\n    c.load()\n}\n");
    write("src/b.rs", "pub fn render(n: u32) -> u32 { n }\n");
  }

  it.skipIf(!hasRustAnalyzer)("calls the wrong arrow wrong, and leaves the right one alone", async () => {
    writeCrate();
    const workspace = createWorkspace(repo);

    const wrong = await boardOf("src/a.rs#run", "src/b.rs#render");
    // Quiet on the text alone, so what changes below is rust-analyzer's answer
    // and not something the reader could already see.
    const quiet = checkDrift(wrong, workspace, { edges: true });
    expect(quiet.edges.filter((finding) => finding.kind === "calls-refuted")).toEqual([]);
    expect(quiet.claims.callsNotClosed.receiver).toBe(1);

    const accused = await refereedCheckLive(repo, (referee) =>
      checkDrift(wrong, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));
    expect(accused.checkedWith.answered).toContain("rust");
    expect(accused.report.edges.filter((finding) => finding.kind === "calls-refuted")).toHaveLength(1);

    // The same crate with the far end where the call really lands. This is the
    // assertion a resolver that accused on every unresolved receiver fails.
    const right = await boardOf("src/a.rs#run", "src/decl.rs#Config");
    const kept = await refereedCheckLive(repo, (referee) =>
      checkDrift(right, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));
    expect(kept.report.edges.filter((finding) => finding.kind === "calls-refuted")).toEqual([]);
  }, 180_000);
});

describe("a machine with Rust but no rust-analyzer", () => {
  /*
   * Found by CI, which is this machine: rustup and cargo installed, the
   * rust-analyzer component not. `rust-analyzer` is then rustup's proxy, which
   * starts, prints "Unknown binary" and exits -- and the check waited for its
   * opening handshake forever, because nothing noticed the process was gone.
   * A board checked on every turn cannot hang on a tool somebody did not
   * install; it has to fall back to the text reading and say so.
   */
  let savedPath: string | undefined;
  let unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  beforeEach(() => {
    const bin = path.join(repo, ".fake-bin");
    mkdirSync(bin, { recursive: true });
    const stub = path.join(bin, "rust-analyzer");
    writeFileSync(stub,
      "#!/bin/sh\n"
      + "echo \"error: Unknown binary 'rust-analyzer' in official toolchain 'stable'.\" >&2\n"
      + "exit 1\n");
    chmodSync(stub, 0o755);
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    process.off("unhandledRejection", onUnhandled);
  });

  it.skipIf(process.platform === "win32")("falls back to the text reading instead of waiting forever", async () => {
    write("Cargo.toml", "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n");
    write("src/lib.rs", "pub mod decl;\npub mod a;\npub mod b;\n");
    write("src/decl.rs",
      "pub struct Config { pub name: String }\n"
      + "impl Config {\n    pub fn load(&self) -> u32 { 7 }\n}\n"
      + "pub fn make() -> Config { Config { name: String::new() } }\n");
    write("src/a.rs", "use crate::decl::make;\n\npub fn run() -> u32 {\n    let c = make();\n    c.load()\n}\n");
    write("src/b.rs", "pub fn render(n: u32) -> u32 { n }\n");
    const workspace = createWorkspace(repo);
    const board = await boardOf("src/a.rs#run", "src/b.rs#render");

    const started = Date.now();
    const live = await refereedCheckLive(repo, (referee) =>
      checkDrift(board, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(live.report.edges.filter((finding) => finding.kind === "calls-refuted")).toEqual([]);
    expect(live.checkedWith.answered).not.toContain("rust");
    expect(refereeSentence(live.checkedWith)).toContain("rust-analyzer did not answer");
    // Nothing left failing in the background after the check has answered.
    // Which way the handshake and the exit race depends on the machine; the
    // ordering CI hit is pinned deterministically by `connectTo`'s own test.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    expect(unhandled.map(String)).toEqual([]);
  }, 30_000);
});

describe("saying which check the board got (#334)", () => {
  /*
   * A board checked with a compiler and a board checked without one are not
   * the same claim, and until this existed they looked identical. The words
   * are the product of this -- a person reading a board has to be able to act
   * on them without having read this file.
   */
  it("names what answered, what did not, and when nothing needed asking", () => {
    expect(refereeSentence({ answered: [], silent: [], nothingToAsk: true }))
      .toBe("checked against the code; nothing was left for a compiler to settle");
    expect(refereeSentence({ answered: ["python"], silent: [], nothingToAsk: false }))
      .toBe("checked with pyright");
    expect(refereeSentence({ answered: ["python", "typescript"], silent: [], nothingToAsk: false }))
      .toBe("checked with pyright and the TypeScript compiler");
    expect(refereeSentence({ answered: [], silent: ["rust"], nothingToAsk: false }))
      .toBe("checked against the text only (rust-analyzer did not answer)");
    expect(refereeSentence({ answered: ["typescript"], silent: ["rust"], nothingToAsk: false }))
      .toBe("checked with the TypeScript compiler; rust-analyzer did not answer, so those arrows got the text reading");
  });
});

describe("the packaged build", () => {
  /*
   * The reason this never happened, pinned so it cannot happen again.
   *
   * The resolvers lived under `scripts/`, the product lives under `src/`, and
   * the product may not import from the harness that measures it. The visible
   * consequence was that only the standalone `check-drift` CLI ever asked
   * pyright or rust-analyzer anything: the shipped MCP server -- the thing
   * that runs when Claude draws a board and when anybody calls `check_drift`
   * -- carried no language-server code at all.
   */
  it("puts the Python and Rust referees in the server the product ships, not only the CLI", () => {
    assertFreshCliBundle();
    for (const entry of ["out/cli/server.mjs", "out/cli/drift.mjs"]) {
      const bundle = readFileSync(path.resolve(import.meta.dirname, "..", entry), "utf8");
      expect(bundle, `${entry} should be able to start pyright`).toContain("pyright-langserver");
      expect(bundle, `${entry} should be able to start rust-analyzer`).toContain("createRustAnalyzerReferee");
    }
  });
});
