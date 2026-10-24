/**
 * "viaConst calls Handler" where Handler is a type alias (#476).
 *
 * The bad outcome, before this: the same arrow drawn at an interface was "not
 * sure", and drawn at a type alias it was called wrong. `viaConst` calls
 * `handle`, and `handle` *is* a `Handler` -- yet the checker read the alias as
 * a routine that has to be called by name, read every call `viaConst` makes,
 * found none named `Handler`, and went red. A board with a box for a callback
 * type (`type Middleware`, `type Handler`, `type Listener`) was told it was
 * wrong when it was not.
 *
 * An arrow at a type alias is now answered the way one at an interface is: a
 * value of that type may be what is called, or one may be made by writing a
 * literal, and neither has the alias's name on it. What the alias names does
 * not change that -- every shape below is asked for "not red", with the reason
 * that says why. The guards the other way: a name that is a routine as well as
 * an alias is still read as the routine, and an arrow at a routine is still
 * called wrong.
 *
 * And the other half of #351's rule, which already held and is pinned here: a
 * call made *through* a value whose type is an alias is treated as one made
 * through an interface, so it never grounds a red at a function head either.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { refereedCheckLive } from "../src/engine/referee-live";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

function tree(files: Record<string, string>): string {
  // Outside the worktree: a scratch source file inside one is read by the
  // dependency tests as though it belonged to this repository.
  const repo = mkdtempSync(path.join(tmpdir(), "calls-type-alias-head-"));
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return repo;
}

type Said = "red" | "green" | "quiet";

/**
 * One `@calls` arrow, checked. TypeScript is asked with its compiler behind
 * it, as a live check does -- that is in process and starts no server. Python
 * and Rust are read from the text alone, which is where their reds came from,
 * so this file starts no language server another test file owns.
 */
async function said(repo: string, fromRef: string, toRef: string, live: boolean): Promise<{ said: Said; report: DriftReport }> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "tail", label: "tail", ref: fromRef },
      { id: "head", label: "head", ref: toRef },
    ],
    edges: [{ from: "tail", to: "head", claim: "calls" }],
  });
  const workspace = createWorkspace(repo);
  const report = live
    ? (await refereedCheckLive(repo, (referee) =>
      checkDrift(board as BoardFile, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }))).report
    : checkDrift(board as BoardFile, workspace, { edges: true });
  if (report.edges.some((finding) => ACCUSES.has(finding.kind))) return { said: "red", report };
  return { said: report.claims.callsConfirmed > 0 ? "green" : "quiet", report };
}

function over(files: Record<string, string>, live: boolean) {
  let repo = "";
  beforeAll(() => { repo = tree(files); });
  afterAll(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });
  return (from: string, to: string) => said(repo, from, to, live);
}

/** Not red, and held back because the far end is a type alias -- not for some other reason that happened to fire. */
function heldForTheAlias(found: { said: Said; report: DriftReport }): void {
  expect(found.said).not.toBe("red");
  expect(found.report.claims.callsNotClosed["type-alias"]).toBe(1);
}

describe("TypeScript", () => {
  const ask = over({
    "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
    "types.ts": [
      "export interface Shape { n: number }",
      "export type Plain = { n: number };",
      "export type Handler = (n: number) => number;",
      "export type WithCall = { (n: number): number; label: string };",
      "export type Either = Handler | Shape;",
      "export type Fn<T> = (x: T) => T;",
      "export type Named = Shape;",
      // A type and a routine under one name: the routine is what a call runs.
      "export type Make = { n: number };",
      "export function Make(): Make { return { n: 1 }; }",
      "",
    ].join("\n"),
    "main.ts": [
      'import type { Handler, Plain, Fn, Named } from "./types";',
      "export function run(n: number): number { return n * 2; }",
      "export const handle: Handler = (n) => run(n);",
      "export const twice: Fn<number> = (x) => x * 2;",
      "export function viaConst(): number { return handle(1); }",
      "export function viaRun(): number { return run(1); }",
      "export function viaGeneric(): number { return twice(1); }",
      "export function viaAlias(): Plain { return { n: 1 }; }",
      "export function viaNamed(): Named { return { n: 1 }; }",
      "export function viaNothing(): number { return 1; }",
      "",
    ].join("\n"),
    // A call made through a value whose type is an alias, at a function head.
    "through.ts": [
      'import { run } from "./main";',
      "export type Calls = { m(n: number): number };",
      "export interface ICalls { m(n: number): number }",
      "export function viaAliasValue(x: Calls): number { return x.m(1); }",
      "export function viaInterfaceValue(x: ICalls): number { return x.m(1); }",
      "export function direct(): number { return run(1); }",
      "",
    ].join("\n"),
  }, true);

  it("does not accuse a call of a value declared with the alias -- #475's case", async () => {
    heldForTheAlias(await ask("main.ts#viaConst", "types.ts#Handler"));
  }, 120_000);

  it("does not accuse a call of a function whose type the alias names", async () => {
    heldForTheAlias(await ask("main.ts#viaRun", "types.ts#Handler"));
  }, 120_000);

  it("does not accuse a function returning the alias's shape", async () => {
    heldForTheAlias(await ask("main.ts#viaAlias", "types.ts#Plain"));
  }, 120_000);

  it("does not accuse an alias to an object type with a call signature", async () => {
    heldForTheAlias(await ask("main.ts#viaRun", "types.ts#WithCall"));
  }, 120_000);

  it("does not accuse an alias to a union one of whose members can be called", async () => {
    heldForTheAlias(await ask("main.ts#viaRun", "types.ts#Either"));
  }, 120_000);

  it("does not accuse a generic alias", async () => {
    heldForTheAlias(await ask("main.ts#viaGeneric", "types.ts#Fn"));
  }, 120_000);

  it("does not accuse an alias that names an interface", async () => {
    heldForTheAlias(await ask("main.ts#viaNamed", "types.ts#Named"));
  }, 120_000);

  it("answers the alias as it answers the interface it stands beside", async () => {
    // Withheld at the interface for its own reason (a literal may make one); never red at either.
    expect((await ask("main.ts#viaNothing", "types.ts#Shape")).said).not.toBe("red");
    heldForTheAlias(await ask("main.ts#viaNothing", "types.ts#Plain"));
  }, 120_000);

  it("still reads a name that is a routine as well as an alias as the routine", async () => {
    expect((await ask("main.ts#viaNothing", "types.ts#Make")).said).toBe("red");
  }, 120_000);

  it("still calls wrong an arrow at a routine the tail never calls", async () => {
    expect((await ask("main.ts#viaNothing", "main.ts#run")).said).toBe("red");
  }, 120_000);

  it("does not accuse a call through a value whose type is an alias, as through an interface", async () => {
    const aliased = await ask("through.ts#viaAliasValue", "main.ts#run");
    const interfaced = await ask("through.ts#viaInterfaceValue", "main.ts#run");
    expect(aliased.said).not.toBe("red");
    expect(aliased.report.claims.callsNotClosed).toEqual(interfaced.report.claims.callsNotClosed);
  }, 120_000);
});

describe("Python", () => {
  const ask = over({
    "shapes.py": [
      "from typing import Callable, TypeAlias",
      "",
      "class Shape:",
      "    n: int = 1",
      "",
      "type Handler = Callable[[int], int]",
      "Annotated: TypeAlias = Callable[[int], int]",
      "",
      "def run(n: int) -> int:",
      "    return n * 2",
      "",
      "def via_run() -> int:",
      "    return run(1)",
      "",
      "def via_nothing() -> int:",
      "    return 1",
      "",
    ].join("\n"),
  }, false);

  it("does not accuse an alias written with the type statement", async () => {
    heldForTheAlias(await ask("shapes.py#via_run", "shapes.py#Handler"));
  }, 120_000);

  it("does not accuse an alias written with a TypeAlias annotation", async () => {
    heldForTheAlias(await ask("shapes.py#via_run", "shapes.py#Annotated"));
  }, 120_000);

  it("still calls wrong an arrow at a routine the tail never calls", async () => {
    expect((await ask("shapes.py#via_nothing", "shapes.py#run")).said).toBe("red");
  }, 120_000);
});

describe("Rust", () => {
  const ask = over({
    "Cargo.toml": '[package]\nname = "aliashead"\nversion = "0.1.0"\nedition = "2021"\n',
    "src/types.rs": [
      "pub struct Shape {\n    pub n: u32,\n}",
      "pub type Named = Shape;",
      "pub type Handler = fn(u32) -> u32;",
      "",
    ].join("\n\n"),
    "src/lib.rs": [
      "pub mod types;",
      "use crate::types::Shape;",
      "pub fn run(n: u32) -> u32 {\n    n * 2\n}",
      "pub fn make_shape() -> Shape {\n    Shape { n: 1 }\n}",
      "pub fn via_run() -> u32 {\n    run(1)\n}",
      "pub fn via_nothing() -> u32 {\n    1\n}",
      "",
    ].join("\n\n"),
  }, false);

  it("does not accuse a tail that builds what the alias names", async () => {
    // The same arrow at `Shape` itself is green.
    expect((await ask("src/lib.rs#make_shape", "src/types.rs#Shape")).said).toBe("green");
    heldForTheAlias(await ask("src/lib.rs#make_shape", "src/types.rs#Named"));
  }, 120_000);

  it("does not accuse a call of a function whose type the alias names", async () => {
    heldForTheAlias(await ask("src/lib.rs#via_run", "src/types.rs#Handler"));
  }, 120_000);

  it("still calls wrong an arrow at a routine the tail never calls", async () => {
    expect((await ask("src/lib.rs#via_nothing", "src/lib.rs#run")).said).toBe("red");
  }, 120_000);
});
