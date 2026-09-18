/**
 * One cache held across many checks of one repository (#311).
 *
 * `bench:planted` asks 1,661 arrows one board at a time, and every check used
 * to build its import and crate-layout cache from nothing and throw it away:
 * one clap arrow re-read the same 227 files each time it was asked. A caller
 * that runs many checks may now hold a cache per project and hand it in.
 *
 * The danger in that is a wrong answer, not a slow one. The crate layout sits
 * under one fixed key in the cache, so a cache handed from one project to
 * another would resolve the second project's modules against the first one's
 * tree. These tests are that case and its guard.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace, newCheckCache, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

const CARGO = (name: string) => `[package]\nname = "${name}"\nedition = "2021"\n`;

let scratch: string;

/** A crate on disk whose root declares one module, and that module's file. */
function crate(name: string, module: string): string {
  const root = path.join(scratch, name);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "Cargo.toml"), CARGO(name));
  writeFileSync(path.join(root, "src/lib.rs"), `pub mod ${module};\n`);
  writeFileSync(path.join(root, `src/${module}.rs`), "pub fn go() {}\n");
  return root;
}

/** An arrow from the crate root to the module it declares. */
async function arrowTo(module: string): Promise<BoardFile> {
  return (await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "lib", label: "lib", ref: "src/lib.rs" },
      { id: "mod", label: module, ref: `src/${module}.rs` },
    ],
    edges: [{ from: "lib", to: "mod" }],
  })).board;
}

/** The same workspace, counting every read it is asked for. */
function counted(root: string): { workspace: Workspace; reads: () => number } {
  const inner = createWorkspace(root);
  let reads = 0;
  return {
    workspace: { ...inner, read: (at) => { reads++; return inner.read(at); } },
    reads: () => reads,
  };
}

/** Confirmed means checked, with nothing said against it and nothing left unread. */
function confirmed(report: ReturnType<typeof checkDrift>): boolean {
  return report.edgesChecked === 1 && report.edges.length === 0
    && report.unreadEdges.length === 0 && report.unconfirmedEdges.length === 0;
}

beforeAll(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "check-cache-"));
  await initEngine();
}, 60_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("a cache held across checks of one repository", () => {
  it("gives the same answer as a check that starts cold", async () => {
    const root = crate("alpha", "route");
    const workspace = createWorkspace(root);
    const board = await arrowTo("route");
    const cold = checkDrift(board, workspace, { edges: true });
    const cache = newCheckCache(workspace);
    const first = checkDrift(board, workspace, { edges: true, cache });
    const second = checkDrift(board, workspace, { edges: true, cache });
    expect(confirmed(cold)).toBe(true);
    expect(first).toEqual(cold);
    expect(second).toEqual(cold);
  }, 60_000);

  it("does not read a file twice for the second arrow", async () => {
    // The whole point: without a cache every check pays for every file again.
    const root = crate("beta", "route");
    const board = await arrowTo("route");
    const cold = counted(root);
    checkDrift(board, cold.workspace, { edges: true });
    const once = cold.reads();
    checkDrift(board, cold.workspace, { edges: true });
    expect(cold.reads()).toBe(once * 2);

    const warm = counted(root);
    const cache = newCheckCache(warm.workspace);
    checkDrift(board, warm.workspace, { edges: true, cache });
    const first = warm.reads();
    checkDrift(board, warm.workspace, { edges: true, cache });
    expect(first).toBeGreaterThan(0);
    expect(warm.reads()).toBeLessThan(first * 2);
  }, 60_000);
});

describe("two projects checked by one script", () => {
  it("each resolves its own modules, asked one after the other", async () => {
    // clap's question, then ripgrep's: the second project's `pub mod search`
    // exists in no module tree but its own.
    const clap = createWorkspace(crate("clap-like", "builder"));
    const ripgrep = createWorkspace(crate("ripgrep-like", "search"));
    const caches = new Map<Workspace, ReturnType<typeof newCheckCache>>();
    const cacheOf = (workspace: Workspace) => {
      const held = caches.get(workspace) ?? newCheckCache(workspace);
      caches.set(workspace, held);
      return held;
    };
    const first = checkDrift(await arrowTo("builder"), clap, { edges: true, cache: cacheOf(clap) });
    const second = checkDrift(await arrowTo("search"), ripgrep, { edges: true, cache: cacheOf(ripgrep) });
    expect(confirmed(first)).toBe(true);
    expect(confirmed(second)).toBe(true);
  }, 60_000);

  it("refuses one project's cache for another, rather than answer from the wrong tree", async () => {
    const clap = createWorkspace(crate("clap-two", "builder"));
    const ripgrep = createWorkspace(crate("ripgrep-two", "search"));
    const cache = newCheckCache(clap);
    checkDrift(await arrowTo("builder"), clap, { edges: true, cache });
    const board = await arrowTo("search");
    expect(() => checkDrift(board, ripgrep, { edges: true, cache })).toThrow(/another workspace/);
  }, 60_000);

  it("refuses it for a second workspace on the same root, too", async () => {
    // Identity, not path: a caller that builds a fresh workspace per check is
    // exactly the caller that should not be sharing a cache.
    const root = crate("gamma", "route");
    const cache = newCheckCache(createWorkspace(root));
    const board = await arrowTo("route");
    expect(() => checkDrift(board, createWorkspace(root), { edges: true, cache })).toThrow(/another workspace/);
  }, 60_000);
});
