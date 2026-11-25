/**
 * "Could the value called here be that function?" -- asked of the TypeScript
 * compiler for a call nobody can place (calls research 2026-11, step 2).
 *
 * `run(h: Handler)` calling `h("x", 1)` runs whatever it was handed, so an
 * arrow "run calls nofit" used to stay "not sure" whatever `nofit` was. But
 * `h` has a type, and `nofit(a: { x: number })` cannot be used where a
 * `Handler` is expected: no value of that type holds it, short of a cast or
 * an `any` on the way. So the arrow is wrong, and now it says so.
 *
 * The refusals come first: every shape where the types cannot vouch for what
 * the value holds keeps the arrow "not sure" -- an `any`, a `Function`, the
 * head cast or handed to `any`, a type variable, a JavaScript file, a value
 * with members of its own, a nameless function that calls the head and fits,
 * a decorated head, a head that fits.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { wouldHelp } from "../src/engine/referee";
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

async function boardOf(fromRef: string, toRef: string): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "caller", label: "caller", ref: fromRef },
      { id: "callee", label: "callee", ref: toRef },
    ],
    edges: [{ from: "caller", to: "callee", claim: "calls" }],
  });
  return board;
}

/** The check the product runs: the text first, then the compiler. */
async function checked(fromRef: string, toRef: string): Promise<DriftReport> {
  const board = await boardOf(fromRef, toRef);
  const workspace = createWorkspace(repo);
  const live = await refereedCheckLive(repo, (referee) =>
    checkDrift(board, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }), { compiler: false });
  return live.report;
}

/** The text alone: no compiler, so nobody asks the type question. */
async function textOnly(fromRef: string, toRef: string): Promise<DriftReport> {
  return checkDrift(await boardOf(fromRef, toRef), createWorkspace(repo), { edges: true });
}

const reds = (report: DriftReport) => report.edges.filter((finding) => ACCUSES.has(finding.kind)).map((finding) => finding.kind);

beforeEach(() => {
  // Outside the worktree on purpose: a scratch source file inside one is read
  // by the dependency tests as though it belonged to this repository.
  repo = mkdtempSync(path.join(tmpdir(), "calls-type-question-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const TSCONFIG = "{ \"compilerOptions\": { \"strict\": true, \"target\": \"es2022\", \"module\": \"esnext\", \"moduleResolution\": \"bundler\", \"experimentalDecorators\": true } }\n";

const BASE = {
  "tsconfig.json": TSCONFIG,
  "handler.ts": "export type Handler = (req: string, n: number) => string;\n",
  "heads.ts":
    "export function fits(req: string, n: number): string {\n  return req + n;\n}\n\n"
    + "export function nofit(a: { x: number }): number {\n  return a.x;\n}\n",
  "run.ts":
    "import type { Handler } from \"./handler\";\n\n"
    + "export function run(h: Handler): string {\n  return h(\"x\", 1);\n}\n",
  "wire.ts":
    "import { fits, nofit } from \"./heads\";\nimport { run } from \"./run\";\n\n"
    + "export function wire(): void {\n  run(fits);\n  const keep = nofit;\n  keep({ x: 1 });\n}\n",
};

describe("the types cannot vouch for what the value holds: the arrow stays not sure", () => {
  it("the head fits the value's type", async () => {
    write(BASE);
    expect(reds(await checked("run.ts#run", "heads.ts#fits"))).toEqual([]);
  }, 120_000);

  it("the value is typed any", async () => {
    write({ ...BASE, "any.ts": "export function runAny(h: any): unknown {\n  return h(1);\n}\n" });
    expect(reds(await checked("any.ts#runAny", "heads.ts#nofit"))).toEqual([]);
  }, 120_000);

  it("the value is typed Function", async () => {
    write({ ...BASE, "fn.ts": "export function runFn(h: Function): unknown {\n  return h(1);\n}\n" });
    expect(reds(await checked("fn.ts#runFn", "heads.ts#nofit"))).toEqual([]);
  }, 120_000);

  it("the value is unknown, narrowed only to a function", async () => {
    write({ ...BASE, "unk.ts": "export function runU(h: unknown): unknown {\n  if (typeof h === \"function\") return h(1);\n  return undefined;\n}\n" });
    expect(reds(await checked("unk.ts#runU", "heads.ts#nofit"))).toEqual([]);
  }, 120_000);

  it("the head is handed to an array of any", async () => {
    write({ ...BASE, "bag.ts": "import { nofit } from \"./heads\";\n\nexport const bag: any[] = [];\nbag.push(nofit);\n" });
    expect(reds(await checked("run.ts#run", "heads.ts#nofit"))).toEqual([]);
  }, 120_000);

  it("the head is cast", async () => {
    write({
      ...BASE,
      "cast.ts": "import type { Handler } from \"./handler\";\nimport { nofit } from \"./heads\";\nimport { run } from \"./run\";\n\n"
        + "export function sneak(): string {\n  return run(nofit as unknown as Handler);\n}\n",
    });
    expect(reds(await checked("run.ts#run", "heads.ts#nofit"))).toEqual([]);
  }, 120_000);

  it("the head is handed to a type variable", async () => {
    write({
      ...BASE,
      "keep.ts": "import { nofit } from \"./heads\";\n\nexport function keepIt<T>(x: T): T {\n  return x;\n}\n\nexport const kept = keepIt(nofit);\n",
    });
    expect(reds(await checked("run.ts#run", "heads.ts#nofit"))).toEqual([]);
  }, 120_000);

  it("the head is renamed on the way", async () => {
    write({ ...BASE, "renamed.ts": "export { nofit as handle } from \"./heads\";\n" });
    expect(reds(await checked("run.ts#run", "heads.ts#nofit"))).toEqual([]);
  }, 120_000);

  it("a function with no name calls the head and fits the value's type", async () => {
    write({
      ...BASE,
      "wrap.ts": "import { nofit } from \"./heads\";\nimport { run } from \"./run\";\n\n"
        + "export function wrapIt(): string {\n  return run((r, n) => String(nofit({ x: n })));\n}\n",
    });
    expect(reds(await checked("run.ts#run", "heads.ts#nofit"))).toEqual([]);
  }, 120_000);

  it("the caller is a JavaScript file", async () => {
    write({
      ...BASE,
      "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"allowJs\": true, \"checkJs\": true, \"target\": \"es2022\", \"module\": \"esnext\", \"moduleResolution\": \"bundler\" } }\n",
      "runjs.js": "/** @param {(req: string, n: number) => string} h */\nexport function runJs(h) {\n  return h(\"x\", 1);\n}\n",
    });
    expect(reds(await checked("runjs.js#runJs", "heads.ts#nofit"))).toEqual([]);
  }, 120_000);

  it("one of the head's overloads fits", async () => {
    write({
      ...BASE,
      "over.ts": "export function over(req: string, n: number): string;\nexport function over(a: { x: number }): number;\n"
        + "export function over(a: unknown, n?: number): unknown {\n  return n === undefined ? a : String(a) + n;\n}\n",
      "wire2.ts": "import { over } from \"./over\";\n\nexport const kept = [over];\n",
    });
    expect(reds(await checked("run.ts#run", "over.ts#over"))).toEqual([]);
  }, 120_000);

  it("the head is generic and fits once its type variable is chosen", async () => {
    write({
      ...BASE,
      "ident.ts": "export function ident<T>(x: T): T {\n  return x;\n}\n",
      "wire2.ts": "import { ident } from \"./ident\";\n\nexport const kept = [ident];\n",
    });
    expect(reds(await checked("run.ts#run", "ident.ts#ident"))).toEqual([]);
  }, 120_000);

  it("the value's type has a type variable the head fits", async () => {
    write({
      ...BASE,
      "store.ts": "export function getWith<T>(load: (key: string) => T, key: string): T {\n  return load(key);\n}\n",
      "loaders.ts": "export function loader(key: string): number {\n  return key.length;\n}\n",
      "wire2.ts": "import { loader } from \"./loaders\";\nimport { getWith } from \"./store\";\n\nexport const n = getWith(loader, \"k\");\n",
    });
    expect(reds(await checked("store.ts#getWith", "loaders.ts#loader"))).toEqual([]);
  }, 120_000);

  it("the value's type has members of its own besides the call", async () => {
    write({
      ...BASE,
      "meta.ts": "import type { Handler } from \"./handler\";\n\n"
        + "export function runMeta(h: Handler & { meta: string }): string {\n  return h(\"x\", 1) + h.meta;\n}\n",
    });
    expect(reds(await checked("meta.ts#runMeta", "heads.ts#fits"))).toEqual([]);
  }, 120_000);

  it("the tail builds what it calls out of the head itself", async () => {
    write({
      ...BASE,
      "adapt.ts": "import { nofit } from \"./heads\";\n\n"
        + "export function adapt(): number {\n  const g = nofit.bind(null, { x: 1 });\n  return g();\n}\n",
    });
    expect(reds(await checked("adapt.ts#adapt", "heads.ts#nofit"))).toEqual([]);
  }, 120_000);

  it("the head is decorated", async () => {
    write({
      ...BASE,
      "deco.ts": "function log(target: unknown, key: string, d: PropertyDescriptor): void {\n  void target; void key; void d;\n}\n\n"
        + "export class Box {\n  @log\n  open(a: { x: number }): number {\n    return a.x;\n  }\n}\n",
    });
    expect(reds(await checked("run.ts#run", "deco.ts#open"))).toEqual([]);
  }, 120_000);
});

describe("the value's type cannot hold the head: the arrow is wrong", () => {
  it("a function handed in", async () => {
    write(BASE);
    // Without a compiler nobody asks, and the arrow stays not sure.
    expect(reds(await textOnly("run.ts#run", "heads.ts#nofit"))).toEqual([]);
    const report = await checked("run.ts#run", "heads.ts#nofit");
    expect(reds(report)).toEqual(["calls-refuted"]);
    expect(report.edges[0]!.detail).toContain("one calls a value whose type the compiler says cannot hold nofit");
  }, 120_000);

  it("a method through an interface, when the head is stored under another name", async () => {
    const files = {
      ...BASE,
      "strategy.ts": "export interface Strategy {\n  show(n: number): string;\n}\n",
      "use.ts": "import type { Strategy } from \"./strategy\";\n\nexport function go(s: Strategy): string {\n  return s.show(1);\n}\n",
      "impls.ts": "export function format(d: Date): number {\n  return d.getTime();\n}\n\nexport function label(n: number): string {\n  return String(n);\n}\n",
      "wire2.ts": "import { format, label } from \"./impls\";\nimport type { Strategy } from \"./strategy\";\n\n"
        + "export const strategies: Strategy[] = [{ show: label }];\nexport const formats = [format];\n",
    };
    write(files);
    expect(reds(await checked("use.ts#go", "impls.ts#format"))).toEqual(["calls-refuted"]);
    // `label` is what the interface's `show` holds: that one stays not sure.
    expect(reds(await checked("use.ts#go", "impls.ts#label"))).toEqual([]);
  }, 120_000);

  it("a computed callee", async () => {
    write({
      ...BASE,
      "table.ts": "import type { Handler } from \"./handler\";\nimport { fits } from \"./heads\";\n\n"
        + "const table: Record<string, Handler> = { a: fits };\n\n"
        + "export function byKey(k: string): string {\n  return table[k](\"x\", 1);\n}\n",
    });
    expect(reds(await checked("table.ts#byKey", "heads.ts#nofit"))).toEqual(["calls-refuted"]);
    expect(reds(await checked("table.ts#byKey", "heads.ts#fits"))).toEqual([]);
  }, 120_000);

  it("a function handed in and run with call", async () => {
    write({ ...BASE, "via.ts": "import type { Handler } from \"./handler\";\n\nexport function viaCall(h: Handler): string {\n  return h.call(null, \"x\", 1);\n}\n" });
    expect(reds(await checked("via.ts#viaCall", "heads.ts#nofit"))).toEqual(["calls-refuted"]);
    expect(reds(await checked("via.ts#viaCall", "heads.ts#fits"))).toEqual([]);
  }, 120_000);

  it("a constructor handed in and run with new", async () => {
    write({
      ...BASE,
      "build.ts": "export function build(make: new (n: number) => { n: number }): { n: number } {\n  return new make(1);\n}\n",
    });
    expect(reds(await checked("build.ts#build", "heads.ts#nofit"))).toEqual(["calls-refuted"]);
  }, 120_000);

  it("a plain call never runs a class's constructor", async () => {
    write({
      ...BASE,
      "maker.ts": "export class Maker {\n  constructor(public n: number) {}\n}\n",
      "ready.ts": "import { Maker } from \"./maker\";\n\n"
        + "export function plainCall(x: { ready(): Promise<void> }): Promise<void> {\n  return x.ready();\n}\n\n"
        + "export function make(): Maker {\n  return new Maker(1);\n}\n",
    });
    expect(reds(await checked("ready.ts#plainCall", "maker.ts#constructor"))).toEqual(["calls-refuted"]);
    expect(reds(await checked("ready.ts#make", "maker.ts#constructor"))).toEqual([]);
  }, 120_000);
});

describe("the compiler is started for this question only on a TypeScript board", () => {
  it("counts a TypeScript call of a value nobody placed", async () => {
    write(BASE);
    const report = await textOnly("run.ts#run", "heads.ts#nofit");
    expect(report.claims.callsTypeAskable).toBe(1);
    expect(wouldHelp(report)).toBe(true);
  }, 120_000);

  it("does not count the same call in Python", async () => {
    write({
      "heads.py": "def nofit(a):\n    return a\n",
      "run.py": "def run(h):\n    return h(\"x\", 1)\n",
    });
    const report = await textOnly("run.py#run", "heads.py#nofit");
    expect(report.claims.callsTypeAskable).toBe(0);
  }, 120_000);
});
