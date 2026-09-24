/**
 * `@calls` asks where a called function is declared, not what the value on
 * the left of the dot is (#351).
 *
 * An arrow that says "run calls render" can only be called wrong once every
 * call `run` makes has been placed somewhere. A call like `os.path.join(p)`,
 * `Box::new(n)` or `ctx.signal?.fire()` used to be placed by asking the
 * compiler for the *receiver's* type and mapping that back to a file -- and
 * for each of those three the answer fell through: a module reached through a
 * module, a type name with no value to ask about, an optional field whose
 * type prints as `Signal | undefined`. So the arrow went quiet, right or
 * wrong. On the planted bench that was the most common reason a wrong
 * `@calls` arrow was never caught.
 *
 * Each language here pins three things: the wrong arrow that now goes red,
 * the right one that stays unaccused, and the guard -- a call through an
 * interface, a trait or a Protocol lands on a declaration something else
 * stands in for at runtime, and no accusation rests on it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { refereedCheckLive } from "../src/engine/referee-live";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

/** The same check every other rust-analyzer test here makes: the live half needs the real binary. */
const hasRustAnalyzer = (() => {
  try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

let repo: string;

function write(files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
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

/** The check the product runs: the text first, then whatever compiler this tree has. */
async function checked(fromRef: string, toRef: string): Promise<DriftReport> {
  const board = await boardOf(fromRef, toRef);
  const workspace = createWorkspace(repo);
  const live = await refereedCheckLive(repo, (referee) =>
    checkDrift(board, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));
  return live.report;
}

/** The text alone, to show the arrow was quiet for want of a placement and not for some other reason. */
async function textOnly(fromRef: string, toRef: string): Promise<DriftReport> {
  return checkDrift(await boardOf(fromRef, toRef), createWorkspace(repo), { edges: true });
}

const accusations = (report: DriftReport) => report.edges.filter((finding) => ACCUSES.has(finding.kind));

beforeEach(() => {
  // Outside the worktree on purpose: a scratch source file inside one is read
  // by the dependency tests as though it belonged to this repository.
  repo = mkdtempSync(path.join(tmpdir(), "calls-ask-definition-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("TypeScript: a call through an optional field", () => {
  const FILES = {
    "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
    "signal.ts": "export class Signal {\n  fire(): void {}\n}\n",
    "logger.ts": "export interface Logger {\n  warn(message: string): void;\n}\n",
    "context.ts":
      "import type { Logger } from \"./logger\";\nimport type { Signal } from \"./signal\";\n"
      + "export interface Context {\n  signal?: Signal;\n  logger: Logger;\n}\n",
    "run.ts":
      "import type { Context } from \"./context\";\n"
      + "export function run(ctx: Context): void {\n  ctx.signal?.fire();\n}\n"
      + "export function report(ctx: Context): void {\n  ctx.logger.warn(\"x\");\n}\n",
    "render.ts": "export function render(n: number): number {\n  return n;\n}\n",
  };

  it("calls the wrong arrow wrong", async () => {
    write(FILES);
    // `ctx.signal`'s type prints as `Signal | undefined`, which names nothing
    // this file binds, so the text reading stops there.
    expect((await textOnly("run.ts#run", "render.ts#render")).claims.callsNotClosed.receiver).toBe(1);

    const report = await checked("run.ts#run", "render.ts#render");
    expect(accusations(report).map((finding) => finding.kind)).toEqual(["calls-refuted"]);
  }, 120_000);

  it("leaves the right arrow alone", async () => {
    write(FILES);
    expect(accusations(await checked("run.ts#run", "signal.ts#fire"))).toEqual([]);
  }, 120_000);

  it("accuses nothing on a call through an interface", async () => {
    write(FILES);
    // `warn` is declared on an interface: whatever implements `Logger` is what
    // runs, so the call is not placed and the arrow is not accused.
    expect(accusations(await checked("run.ts#report", "render.ts#render"))).toEqual([]);
  }, 120_000);
});

describe("Python: a call on a module reached through a module", () => {
  const FILES = {
    "thing.py": "class Thing:\n    def greet(self):\n        return \"hi\"\n",
    "make.py": "from thing import Thing\n\n\ndef make():\n    return Thing()\n",
    "greeter.py":
      "from typing import Protocol\n\n\nclass Greeter(Protocol):\n    def greet(self) -> str:\n        ...\n",
    "run.py":
      "import os\n\nfrom greeter import Greeter\nfrom make import make\n\n\n"
      + "def run(p):\n    return os.path.join(p, \"x\")\n\n\n"
      + "def welcome():\n    return make().greet()\n\n\n"
      + "def through(g: Greeter):\n    return g.greet()\n",
    "render.py": "def render(n):\n    return n\n",
  };

  it("calls the wrong arrow wrong", async () => {
    write(FILES);
    // `os.path` is an expression, not a name: the text cannot place `join`.
    expect((await textOnly("run.py#run", "render.py#render")).claims.callsNotClosed.receiver).toBe(1);

    const report = await checked("run.py#run", "render.py#render");
    expect(accusations(report).map((finding) => finding.kind)).toEqual(["calls-refuted"]);
  }, 120_000);

  it("leaves the right arrow alone", async () => {
    write(FILES);
    expect(accusations(await checked("run.py#welcome", "thing.py#greet"))).toEqual([]);
  }, 120_000);

  it("accuses nothing on a call through a Protocol", async () => {
    write(FILES);
    // pyright answers `Greeter.greet`, whose body is `...`: the class that
    // satisfies the Protocol is what runs, and nothing here says which.
    expect(accusations(await checked("run.py#through", "render.py#render"))).toEqual([]);
  }, 120_000);
});

describe("Rust: a call on a type's name", () => {
  const FILES = {
    "Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n",
    "src/lib.rs": "pub mod own;\npub mod store;\npub mod run;\npub mod render;\n",
    "src/own.rs":
      "pub struct Own {\n    pub n: u32,\n}\n\n"
      + "impl Own {\n    pub fn new(n: u32) -> Own {\n        Own { n }\n    }\n\n"
      + "    pub fn cast(self) -> u32 {\n        self.n\n    }\n}\n",
    "src/store.rs": "pub trait Store {\n    fn load(&self) -> u32;\n}\n",
    "src/run.rs":
      "use crate::own::Own;\nuse crate::store::Store;\n\n"
      + "pub fn run(n: u32) -> u32 {\n    let boxed = Box::new(n);\n    Own::new(*boxed).cast()\n}\n\n"
      + "pub fn through(store: &dyn Store) -> u32 {\n    store.load()\n}\n",
    "src/render.rs": "pub fn render(n: u32) -> u32 {\n    n\n}\n",
  };

  it.skipIf(!hasRustAnalyzer)("calls the wrong arrow wrong", async () => {
    write(FILES);
    // `Box::new` has a type's name where a value would be, so asking what the
    // value is has nothing to ask about.
    expect((await textOnly("src/run.rs#run", "src/render.rs#render")).claims.callsNotClosed.receiver).toBe(1);

    const report = await checked("src/run.rs#run", "src/render.rs#render");
    expect(accusations(report).map((finding) => finding.kind)).toEqual(["calls-refuted"]);
  }, 180_000);

  it.skipIf(!hasRustAnalyzer)("leaves the right arrow alone", async () => {
    write(FILES);
    expect(accusations(await checked("src/run.rs#run", "src/own.rs#cast"))).toEqual([]);
  }, 180_000);

  it.skipIf(!hasRustAnalyzer)("accuses nothing on a call through a trait", async () => {
    write(FILES);
    // rust-analyzer answers the trait's `fn load(&self) -> u32;`, which has no
    // body: whatever implements `Store` is what runs.
    expect(accusations(await checked("src/run.rs#through", "src/render.rs#render"))).toEqual([]);
  }, 180_000);
});
