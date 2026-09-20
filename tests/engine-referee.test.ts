/**
 * The second opinion, where the product can reach it (#328).
 *
 * The resolver that answers "what is this value" has existed since #226 and
 * lived under `scripts/`, so only the standalone `check-drift` CLI ever used
 * one. Every other way of checking a board -- the MCP server Claude draws
 * through, the live board page, and the benchmark every change is judged by --
 * ran without it and said nothing about the difference. What is pinned here is
 * that a check can now get one, that it changes an answer, and that a
 * repository with no TypeScript installed is not worse off than before.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { createClosedBodyReferee, refereedCheck } from "../src/engine/referee";
import { installExcalifontMeasurer } from "./helpers/excalifont";
import { assertFreshCliBundle } from "./helpers/fresh-bundle";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

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
  repo = mkdtempSync(path.join(tmpdir(), "engine-referee-"));
  write("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", strict: true } }));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("a call on a value whose type the text does not give", () => {
  /*
   * The largest single reason a `@calls` arrow was never answered at all --
   * 79 of the 168 arrows whose call list could not be closed, by #324's own
   * ranking. The reader can see `thing.greet()` and cannot see what `thing`
   * is, so the body never closes and the arrow goes quiet whether it is right
   * or wrong.
   */
  const SOURCES = {
    "src/thing.ts": "export class Thing { greet(): string { return \"hi\"; } }\n",
    "src/make.ts": "import { Thing } from \"./thing\";\nexport function make() { return new Thing(); }\n",
    "src/a.ts": "import { make } from \"./make\";\nexport function run() {\n  const thing = make();\n  return thing.greet();\n}\n",
    "src/b.ts": "export function render(n: number) { return n; }\n",
  };

  it("leaves the arrow unanswered with no referee, and calls it wrong with one", async () => {
    for (const [file, contents] of Object.entries(SOURCES)) write(file, contents);
    const workspace = createWorkspace(repo);
    // `run` never reaches `src/b.ts`, so the arrow really is wrong -- the only
    // thing in the way is that `thing`'s type is not written down anywhere the
    // reader looks.
    const board = await boardOf("src/a.ts#run", "src/b.ts#render");

    const quiet = checkDrift(board, workspace, { edges: true });
    expect(quiet.edges.filter((finding) => finding.kind === "calls-refuted")).toEqual([]);
    expect(quiet.claims.callsNotClosed.receiver).toBe(1);

    const referee = createClosedBodyReferee(repo);
    expect(referee).toBeDefined();
    const asked = checkDrift(board, workspace, { edges: true, closedBodyReferee: referee });
    expect(asked.edges.filter((finding) => finding.kind === "calls-refuted")).toHaveLength(1);
  });

  it("still confirms the arrow the resolver places at the far end", async () => {
    // The same shape with the far end where the call actually lands. A
    // resolver that turned every unresolved receiver into an accusation
    // would fail here, and that is the failure worth having a test for.
    for (const [file, contents] of Object.entries(SOURCES)) write(file, contents);
    const workspace = createWorkspace(repo);
    const board = await boardOf("src/a.ts#run", "src/thing.ts#Thing");

    const referee = createClosedBodyReferee(repo);
    const asked = checkDrift(board, workspace, { edges: true, closedBodyReferee: referee });
    expect(asked.edges.filter((finding) => finding.kind === "calls-refuted")).toEqual([]);
  });
});

describe("refereedCheck", () => {
  it("does not pay for a referee when the first pass settled everything", async () => {
    write("src/a.ts", "import { render } from \"./b\";\nexport function run() { return render(1); }\n");
    write("src/b.ts", "export function render(n: number) { return n; }\n");
    const workspace = createWorkspace(repo);
    const board = await boardOf("src/a.ts#run", "src/b.ts#render");

    const asked: boolean[] = [];
    const report = refereedCheck(repo, (referee) => {
      asked.push(referee !== undefined);
      return checkDrift(board, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) });
    });

    // The arrow confirms on the text alone, so the compiler is never started.
    expect(asked).toEqual([false]);
    expect(report.edges).toEqual([]);
  });

  it("asks again with the referee when the first pass left an arrow unsettled", async () => {
    write("src/thing.ts", "export class Thing { greet(): string { return \"hi\"; } }\n");
    write("src/make.ts", "import { Thing } from \"./thing\";\nexport function make() { return new Thing(); }\n");
    write("src/a.ts", "import { make } from \"./make\";\nexport function run() {\n  const thing = make();\n  return thing.greet();\n}\n");
    write("src/b.ts", "export function render(n: number) { return n; }\n");
    const workspace = createWorkspace(repo);
    const board = await boardOf("src/a.ts#run", "src/b.ts#render");

    const asked: boolean[] = [];
    const report = refereedCheck(repo, (referee) => {
      asked.push(referee !== undefined);
      return checkDrift(board, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) });
    });

    expect(asked).toEqual([false, true]);
    expect(report.edges.filter((finding) => finding.kind === "calls-refuted")).toHaveLength(1);
  });
});

describe("the packaged build", () => {
  /*
   * `typescript` is a devDependency, and this referee is now in the shipped
   * tree. A static `import ts from "typescript"` would be hoisted to the top
   * of every bundle that reaches it, and a consumer checking a Python or Rust
   * repository -- who has no reason to have TypeScript installed -- would get
   * a crash before the first line of the server ran.
   *
   * The drift CLI shipped with exactly that import until this change, which
   * is what makes this worth pinning rather than trusting.
   */
  it("does not import typescript at load, in either shipped entry point", () => {
    assertFreshCliBundle();
    for (const entry of ["out/cli/server.mjs", "out/cli/drift.mjs"]) {
      const bundle = readFileSync(path.resolve(import.meta.dirname, "..", entry), "utf8");
      expect(bundle, entry).not.toMatch(/^import .* from "typescript";$/m);
    }
  });
});
