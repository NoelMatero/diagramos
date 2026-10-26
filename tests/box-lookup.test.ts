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
async function checked(fromRef: string, toRef: string, claim = "calls", headState?: "external"): Promise<DriftReport> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "tail", label: "tail", ref: fromRef },
      { id: "head", label: "head", ref: toRef, ...(headState ? { state: headState } : {}) },
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

/* ------------------------------------------------- #477: refusals first */

/*
 * Three more shapes a board names and the checker could not find (#477): a
 * function stored under a key of an object literal, an arrow function whose
 * one parameter has no brackets, and a TypeScript namespace. Each refusal
 * below is a place where finding more would find the wrong thing, so each
 * must stay "not sure" -- before the change, where nothing is found, and
 * after it.
 */
describe("refusals (#477): a key is a box only where it names one thing", () => {
  for (const [label, file] of [["TypeScript", "ws.ts"], ["JavaScript", "ws.js"]] as const) {
    it(`${label}: a key on an object handed to a call is not a box`, async () => {
      write({
        ...TSCONFIG,
        [file]: [
          "export function helper() { return 1; }",
          "export function other() { return 2; }",
          "function createWSContext(events) { return events; }",
          "export const ctx = createWSContext({ send: (data) => helper(data) });",
          "",
        ].join("\n"),
      });
      expect(outcome(await checked(`${file}#send`, `${file}#other`))).toBe("not sure");
      expect(outcome(await checked(`${file}#send`, `${file}#helper`))).toBe("not sure");
    }, 120_000);

    it(`${label}: a key nested in another object, returned, or in an array is not a box`, async () => {
      write({
        ...TSCONFIG,
        [file]: [
          "export function helper() { return 1; }",
          "export function other() { return 2; }",
          "export const config = { server: { onRequest: () => helper() } };",
          "export function make() { return { run: () => helper() }; }",
          "export const routes = [{ load: () => helper() }];",
          "",
        ].join("\n"),
      });
      for (const name of ["onRequest", "run", "load"]) {
        expect(outcome(await checked(`${file}#${name}`, `${file}#other`))).toBe("not sure");
      }
    }, 120_000);

    it(`${label}: two objects with the same key withhold, and neither answers for the box`, async () => {
      write({
        ...TSCONFIG,
        [file]: [
          "export function one() { return 1; }",
          "export function two() { return 2; }",
          "export const a = { run: () => one() };",
          "export const b = { run: () => two() };",
          "",
        ].join("\n"),
      });
      expect(outcome(await checked(`${file}#run`, `${file}#one`))).toBe("not sure");
      expect(outcome(await checked(`${file}#run`, `${file}#two`))).toBe("not sure");
    }, 120_000);
  }

  it("a key never joins a function of the same name: the box stays the function", async () => {
    write({
      ...TSCONFIG,
      "app.ts": [
        "export function one(): number { return 1; }",
        "export function two(): number { return 2; }",
        "export function run(): number { return one(); }",
        "export const api = { run: () => two() };",
        "",
      ].join("\n"),
    });
    expect(outcome(await checked("app.ts#run", "app.ts#one"))).toBe("green");
    expect(outcome(await checked("app.ts#run", "app.ts#two"))).toBe("red");
  }, 120_000);

  it("a quoted or computed key is not a name a board writes", async () => {
    write({
      ...TSCONFIG,
      "app.ts": [
        "export function helper(): number { return 1; }",
        "export function other(): number { return 2; }",
        "const key = \"dyn\";",
        "export const api = { \"quoted\": () => helper(), [key]: () => helper() };",
        "",
      ].join("\n"),
    });
    expect(outcome(await checked("app.ts#quoted", "app.ts#other"))).toBe("not sure");
  }, 120_000);

  it("a bare call never lands on a key: it is not reached through one", async () => {
    write({
      ...TSCONFIG,
      "app.ts": [
        "export function target(): number { return 1; }",
        "export const api = { send: () => target() };",
        "declare function send(): void;",
        "export function go(): void { send(); }",
        "",
      ].join("\n"),
    });
    expect(outcome(await checked("app.ts#go", "app.ts#target"))).not.toBe("green");
  }, 120_000);

  it("a catch clause takes a parameter and is still not a routine: its calls stay the function's own", async () => {
    write({
      ...TSCONFIG,
      "app.ts": [
        "export function risky(): number { return 1; }",
        "export function recover(): number { return 2; }",
        "export function other(): number { return 3; }",
        "export function run(): number {",
        "  try { return risky(); } catch (error) { return recover(); }",
        "}",
        "",
      ].join("\n"),
    });
    expect(outcome(await checked("app.ts#run", "app.ts#recover"))).toBe("green");
    expect(outcome(await checked("app.ts#run", "app.ts#other"))).toBe("red");
  }, 120_000);

  it("a namespace merged with a function adds nothing to the function's box", async () => {
    write({
      ...TSCONFIG,
      "driver.ts": [
        "export function connect(): number { return 1; }",
        "export function other(): number { return 2; }",
        "export function drizzle(): number { return connect(); }",
        "export namespace drizzle { export const mock = 1; }",
        "export function go(): number { return drizzle(); }",
        "",
      ].join("\n"),
    });
    expect(outcome(await checked("driver.ts#go", "driver.ts#drizzle"))).toBe("green");
    expect(outcome(await checked("driver.ts#drizzle", "driver.ts#connect"))).toBe("green");
    expect(outcome(await checked("driver.ts#drizzle", "driver.ts#other"))).toBe("red");
  }, 120_000);
});

/* --------------------------------------------------------- #477: finds */

describe("a function stored under a key of an object assigned to a name (#477)", () => {
  it("TypeScript: reads the key's function as the box, through `as const` and `satisfies` too", async () => {
    write({
      ...TSCONFIG,
      "ssg.ts": [
        "export function writeOut(path: string): string { return path; }",
        "export function unrelated(): number { return 2; }",
        "export const fs = { writeFile: async (path: string) => { writeOut(path); } };",
        "export const frozen = { flush: () => writeOut(\"x\") } as const;",
        "export const store = { save: () => { writeOut(\"y\"); } } satisfies Record<string, () => void>;",
        "",
      ].join("\n"),
    });
    for (const name of ["writeFile", "flush", "save"]) {
      expect(outcome(await checked(`ssg.ts#${name}`, "ssg.ts#writeOut"))).toBe("green");
      expect(outcome(await checked(`ssg.ts#${name}`, "ssg.ts#unrelated"))).toBe("red");
    }
  }, 180_000);

  it("JavaScript: a function expression under a key of module.exports", async () => {
    write({
      "lib.js": [
        "function helper() { return 1; }",
        "function unrelated() { return 2; }",
        "module.exports = { handle: function (req) { return helper(req); } };",
        "",
      ].join("\n"),
    });
    expect(outcome(await checked("lib.js#handle", "lib.js#helper"))).toBe("green");
    // Plain JavaScript has not earned a red for @calls (`licence.ts`); found, it is read and stays quiet.
    expect(outcome(await checked("lib.js#handle", "lib.js#unrelated"))).toBe("not sure");
  }, 120_000);

  it("confirms an arrow into the key's function from a call through the object", async () => {
    write({
      ...TSCONFIG,
      "keys.ts": "export const movieKeys = { list: () => [\"movies\"], detail: (id: string) => [\"movies\", id] };\n",
      "app.ts": [
        "import { movieKeys } from \"./keys\";",
        "export function load(id: string): string[] { return movieKeys.detail(id); }",
        "",
      ].join("\n"),
    });
    expect(outcome(await checked("app.ts#load", "keys.ts#detail"))).not.toBe("red");
  }, 120_000);
});

describe("an arrow function whose one parameter has no brackets (#477)", () => {
  for (const [label, file, typed] of [
    ["TypeScript", "renderer.ts", ": NextFn"],
    ["JavaScript", "bench.mjs", ""],
  ] as const) {
    it(`${label}: reads \`x => ..\` exactly as \`(x) => ..\``, async () => {
      write({
        ...TSCONFIG,
        [file]: [
          typed ? "type NextFn = (n: number) => number;" : "",
          "export function hostNode(n) { return n; }",
          "export function unrelated() { return 2; }",
          `export const getNextHostNode${typed} = vnode => hostNode(vnode);`,
          `export const bracketed${typed} = (vnode) => hostNode(vnode);`,
          "export function go() { return getNextHostNode(1); }",
          "",
        ].join("\n"),
      });
      for (const name of ["getNextHostNode", "bracketed"]) {
        expect(outcome(await checked(`${file}#${name}`, `${file}#hostNode`))).toBe("green");
      }
      // Red in TypeScript; in plain JavaScript @calls has not earned a red, and both spellings stay quiet alike.
      const wrong = await checked(`${file}#getNextHostNode`, `${file}#unrelated`);
      expect(outcome(wrong)).toBe(typed ? "red" : "not sure");
      expect(outcome(wrong)).toBe(outcome(await checked(`${file}#bracketed`, `${file}#unrelated`)));
      expect(outcome(await checked(`${file}#go`, `${file}#getNextHostNode`))).toBe("green");
    }, 180_000);
  }
});

describe("a TypeScript namespace (#477)", () => {
  it("finds a namespace that is the only thing with its name, and reads the functions in it", async () => {
    write({
      ...TSCONFIG,
      "util.ts": [
        "export function helper(): number { return 1; }",
        "export function unrelated(): number { return 2; }",
        "export namespace util {",
        "  export function assertNever(): number { return helper(); }",
        "}",
        "",
      ].join("\n"),
    });
    expect(outcome(await checked("util.ts#util", "util.ts#helper"))).toBe("green");
    // A box at a type is read through its routines, to confirm only -- the same as a class.
    expect(outcome(await checked("util.ts#util", "util.ts#unrelated"))).toBe("not sure");
  }, 120_000);

  it("reads a box marked external at a namespace in the repo like a built one, as it does a class (#435)", async () => {
    write({
      ...TSCONFIG,
      "util.ts": "export namespace util {\n  export function assertNever(): number { return 1; }\n}\n",
      "app.ts": "import { util } from \"./util\";\nexport function go(): number { return util.assertNever(); }\n",
    });
    // Before, both arrows were left unread: "endpoint-external".
    const needs = await checked("app.ts", "util.ts#util", "needs", "external");
    expect(needs.unreadEdges).toEqual([]);
    expect((needs.claims as unknown as Record<string, number>).needsChecked).toBe(1);
    expect(outcome(await checked("app.ts#go", "util.ts#util", "calls", "external"))).toBe("green");
  }, 120_000);
});
