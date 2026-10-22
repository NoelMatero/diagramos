/**
 * A box is found by the name a board writes for it, in every language, and
 * never at the wrong declaration (#464, #451, #462).
 *
 * Three ways the checker could not find the function a box named, so no
 * arrow at that box was ever checked:
 *
 * - a TypeScript name with `$` in it (`$ZodIssue`, `click$`) was reported as
 *   gone from its file, because a word boundary needs a letter on one side;
 * - a TypeScript `#private` method written without `#`, which is the only way
 *   a ref can spell it -- and a call to it was read as a call to something
 *   else, so a correct arrow went red (#451);
 * - a function after a line the parser cannot read: one interface with a
 *   generic call signature near the top of MobX's `action.ts` lost every
 *   function below it (#462).
 *
 * The refusals come first, and they are the point: a lookup that finds more
 * must not find the wrong thing, and a file read past a line nobody could
 * parse must not be read as though that line said nothing.
 */
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

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

let repo: string;

function write(files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}

/** One arrow, checked the way the MCP server checks a board: compilers live. */
async function checked(fromRef: string, toRef: string, claim = "calls"): Promise<DriftReport> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "tail", label: "tail", ref: fromRef },
      { id: "head", label: "head", ref: toRef },
    ],
    edges: [{ from: "tail", to: "head", claim: claim as never }],
  });
  const workspace = createWorkspace(repo);
  const live = await refereedCheckLive(repo, (referee) =>
    checkDrift(board as BoardFile, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));
  return live.report;
}

/** What a person sees on the arrow: red, green, or not sure. */
function outcome(report: DriftReport): "red" | "green" | "not sure" {
  if (report.edges.some((finding) => ACCUSES.has(finding.kind))) return "red";
  if (report.edges.length || report.unconfirmedEdges.length || report.unreadEdges.length || report.garbledClaims.length) return "not sure";
  const tally = report.claims as unknown as Record<string, unknown>;
  const confirmed = Object.entries(tally).filter(([name]) => name.endsWith("Confirmed"))
    .reduce((sum, [, value]) => sum + Number(value ?? 0), 0);
  return confirmed > 0 ? "green" : "not sure";
}

/** Box findings that say the name is not in its file. */
const unfound = (report: DriftReport) => report.findings
  .filter((finding) => ["missing-symbol", "missing-declaration", "unresolvable-ref"].includes(finding.kind))
  .map((finding) => `${finding.kind}: ${finding.ref}`);

beforeEach(() => {
  // Outside the worktree: a scratch source file inside one is read by the
  // dependency tests as though it belonged to this repository.
  repo = mkdtempSync(path.join(tmpdir(), "box-lookup-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const TSCONFIG = { "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"target\": \"es2022\" } }\n" };

/* ------------------------------------------------------------- refusals */

describe("refusals: finding more never finds the wrong thing", () => {
  it("keeps the red when a class has both dispatch and #dispatch and the call lands on the other one", async () => {
    write({
      ...TSCONFIG,
      "app.ts": [
        "export class App {",
        "  dispatch(): number { return 1; }",
        "  #dispatch(): number { return 2; }",
        "  fetch(): number { return this.#dispatch(); }",
        "}",
        "",
      ].join("\n"),
    });
    expect(outcome(await checked("app.ts#fetch", "app.ts#dispatch"))).toBe("red");
  }, 120_000);

  it("does not read Foo as $Foo, or $Foo as Foo", async () => {
    write({
      ...TSCONFIG,
      "util.ts": [
        "export function Foo(): number { return 1; }",
        "export function $Foo(): number { return 2; }",
        "export function usesDollar(): number { return $Foo(); }",
        "export function usesPlain(): number { return Foo(); }",
        "",
      ].join("\n"),
    });
    expect(outcome(await checked("util.ts#usesDollar", "util.ts#Foo"))).toBe("red");
    expect(outcome(await checked("util.ts#usesPlain", "util.ts#$Foo"))).toBe("red");
  }, 120_000);

  it("does not find a box named Foo in a file that only has $Foo", async () => {
    write({ ...TSCONFIG, "util.ts": "export function $Foo(): number { return 2; }\n" });
    expect(unfound(await checked("util.ts#Foo", "util.ts#$Foo"))).toEqual(["missing-symbol: util.ts#Foo"]);
  }, 120_000);

  it("never calls an arrow wrong when the call is on a line the parser could not read", async () => {
    write({
      ...TSCONFIG,
      "util.ts": [
        "export function helper(): number { return 1; }",
        "export function other(): number { return 2; }",
        "export function go(): number {",
        "  type P<in out T> = T; const n: P<number> = helper();",
        "  return n;",
        "}",
        "",
      ].join("\n"),
    });
    expect(outcome(await checked("util.ts#go", "util.ts#helper"))).not.toBe("red");
    expect(outcome(await checked("util.ts#go", "util.ts#other"))).not.toBe("red");
  }, 120_000);

  it("never says a file does not import something when an import may be on a line it could not read", async () => {
    write({
      ...TSCONFIG,
      "shape.ts": "export interface Shape { n: number }\n",
      "app.ts": [
        "import type { Shape } from \"./shape\"; type P<in out T> = T;",
        "export function area(s: P<Shape>): number { return s.n; }",
        "",
      ].join("\n"),
    });
    expect(outcome(await checked("app.ts", "shape.ts", "needs"))).not.toBe("red");
  }, 120_000);
});

/* ------------------------------------------------------------ the finds */

describe("a TypeScript name with $ in it (#464)", () => {
  const files = {
    ...TSCONFIG,
    "core.ts": [
      "export interface $ZodIssue { message: string }",
      "export function $make(): $ZodIssue { return { message: \"x\" }; }",
      "export function click$(): number { return 1; }",
      "export function plain(): number { return 1; }",
      "export function finalize(): $ZodIssue { click$(); return $make(); }",
      "export function quiet(): number { return plain(); }",
      "",
    ].join("\n"),
  };

  it("finds $make, click$ and $ZodIssue in their file", async () => {
    write(files);
    for (const name of ["$make", "click$", "$ZodIssue"]) {
      expect(unfound(await checked("core.ts#finalize", `core.ts#${name}`))).toEqual([]);
    }
  }, 120_000);

  it("confirms an arrow to $make and catches one that does not call it", async () => {
    write(files);
    expect(outcome(await checked("core.ts#finalize", "core.ts#$make"))).toBe("green");
    expect(outcome(await checked("core.ts#finalize", "core.ts#click$"))).toBe("green");
    expect(outcome(await checked("core.ts#quiet", "core.ts#$make"))).toBe("red");
  }, 120_000);
});

describe("a TypeScript #private method written without # (#451)", () => {
  const files = {
    ...TSCONFIG,
    "a.ts": [
      "export class A {",
      "  #run(): number { return 1; }",
      "  other(): number { return 2; }",
      "  go(): number { return this.#run(); }",
      "  idle(): number { return this.other(); }",
      "}",
      "",
    ].join("\n"),
  };

  it("does not call a correct arrow to #run wrong", async () => {
    write(files);
    expect(outcome(await checked("a.ts#go", "a.ts#run"))).toBe("green");
  }, 120_000);

  it("reads the box #run as its own end, and catches a wrong arrow from it", async () => {
    write(files);
    expect(outcome(await checked("a.ts#run", "a.ts#other"))).toBe("red");
    expect(outcome(await checked("a.ts#idle", "a.ts#run"))).toBe("red");
  }, 120_000);
});

describe("a function after a line the parser cannot read (#462)", () => {
  const files = {
    ...TSCONFIG,
    "core.ts": "export function execute(): number { return 1; }\nexport function unrelated(): number { return 2; }\n",
    "action.ts": [
      "import { execute, unrelated } from \"./core\";",
      "export interface Factory {",
      "  <T extends Function | undefined>(fn: T): T",
      "  <T extends Function | undefined>(name: string, fn: T): T",
      "}",
      "export function runInAction(): number {",
      "  return execute();",
      "}",
      "export function keep(): number { return unrelated(); }",
      "",
    ].join("\n"),
  };

  it("finds the function and confirms a correct arrow from it", async () => {
    write(files);
    const report = await checked("action.ts#runInAction", "core.ts#execute");
    expect(unfound(report)).toEqual([]);
    expect(outcome(report)).toBe("green");
  }, 120_000);

  it("catches a wrong arrow from it", async () => {
    write(files);
    expect(outcome(await checked("action.ts#runInAction", "core.ts#unrelated"))).toBe("red");
  }, 120_000);
});

describe("names outside ASCII, and Rust raw identifiers", () => {
  it("finds a Python function named with a letter outside ASCII", async () => {
    write({ "util.py": "def café():\n    return 1\n\n\ndef go():\n    return café()\n" });
    const report = await checked("util.py#go", "util.py#café");
    expect(unfound(report)).toEqual([]);
    expect(outcome(report)).not.toBe("red");
  }, 120_000);

  it("finds a Rust raw identifier written without r#", async () => {
    write({
      "Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n",
      "src/lib.rs": "pub fn r#match() -> i32 {\n    1\n}\n\npub fn go() -> i32 {\n    r#match()\n}\n",
    });
    const report = await checked("src/lib.rs#go", "src/lib.rs#match");
    expect(unfound(report)).toEqual([]);
    expect(outcome(report)).not.toBe("red");
  }, 180_000);
});
