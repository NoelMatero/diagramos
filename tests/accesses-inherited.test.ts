/**
 * "Reads this member" into a TypeScript class with a parent gets an answer
 * (#398).
 *
 * The bad outcome: vite's `DevEnvironment extends BaseEnvironment` declares
 * `transformRequest` itself, and an arrow saying `transformMiddleware` reads
 * it got no answer, because any type with a parent was refused outright. So a
 * wrong arrow into such a class was never caught either.
 *
 * The risk is a correct arrow called wrong. The compiler's member list alone
 * says "none" for a parent's `#private` field, for an implemented interface's
 * optional member the class never declares, and for an inherited `static`.
 * So "no such member" needs the compiler and every parent's own text to
 * agree, and a parent outside the repository is no answer at all.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { refereedCheckLive } from "../src/engine/referee-live";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler" },
    include: ["src"],
  }),
  "node_modules/extlib/package.json": JSON.stringify({ name: "extlib", version: "1.0.0", types: "index.d.ts" }),
  "node_modules/extlib/index.d.ts": "export declare class External {\n  ext(): number;\n}\n",
  "src/base.ts": [
    "export class Base {",
    "  #client = 1;",
    "  base = 2;",
    "  static make(): Base { return new Base(); }",
    "  peek(): number { return this.#client; }",
    "}",
    "",
  ].join("\n"),
  "src/child.ts": [
    'import { Base } from "./base";',
    "",
    "export class Child extends Base {",
    "  own = 3;",
    "}",
    "",
  ].join("\n"),
  "src/opts.ts": [
    "export interface Opts {",
    "  flag?: boolean;",
    "  size: number;",
    "}",
    "",
    "export class Sized implements Opts {",
    "  size = 4;",
    "}",
    "",
  ].join("\n"),
  "src/wrapped.ts": [
    'import { External } from "extlib";',
    "",
    "export class Wrapped extends External {",
    "  mine = 5;",
    "}",
    "",
  ].join("\n"),
  "src/use.ts": [
    'import { Child } from "./child";',
    'import { Sized } from "./opts";',
    'import { Wrapped } from "./wrapped";',
    "",
    "export function readsOwn(c: Child): number { return c.own; }",
    "export function readsBase(c: Child): number { return c.base; }",
    "export function readsStatic(): unknown { return Child.make(); }",
    "export function readsNothing(c: Child): number { return c.own + 1; }",
    "export function readsSize(s: Sized): number { return s.size; }",
    "export function readsMine(w: Wrapped): number { return w.mine; }",
    "",
  ].join("\n"),
};

let repo: string;

beforeAll(async () => {
  await initEngine();
  repo = mkdtempSync(path.join(os.tmpdir(), "accesses-inherited-"));
  for (const [relative, contents] of Object.entries(FILES)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}, 60_000);

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

async function boardFor(routine: string, type: string, member: string): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "reads",
    nodes: [
      { id: "a", label: routine, ref: `src/use.ts#${routine}` },
      { id: "b", label: type.split("#")[1]!, ref: type },
    ],
    edges: [{ from: "a", to: "b", label: member, claim: "accesses" }],
  });
  return board as BoardFile;
}

interface Answer {
  confirmed: number;
  red?: string;
  inherited: number;
}

function answerOf(report: DriftReport): Answer {
  const red = report.edges.find((finding) => ACCUSES.has(finding.kind));
  return {
    confirmed: report.claims.accessesConfirmed,
    inherited: report.claims.accessesWithheld.inherited ?? 0,
    ...(red ? { red: `${red.kind}: ${red.detail}` } : {}),
  };
}

/** One `@accesses` arrow, checked the way a live check does: the TypeScript compiler asked in process. */
async function check(routine: string, type: string, member: string): Promise<Answer> {
  const board = await boardFor(routine, type, member);
  const workspace = createWorkspace(repo);
  const live = await refereedCheckLive(repo, (referee) =>
    checkDrift(board, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));
  return answerOf(live.report);
}

const CHILD = "src/child.ts#Child";

describe("a class with a parent: members it has", () => {
  it("confirms a member the class declares itself", async () => {
    expect(await check("readsOwn", CHILD, "own")).toEqual({ confirmed: 1, inherited: 0 });
  }, 60_000);

  it("confirms a member its parent declares", async () => {
    expect(await check("readsBase", CHILD, "base")).toEqual({ confirmed: 1, inherited: 0 });
  }, 60_000);

  /*
   * The routines below never name the member, so the arrow is red either
   * way. Which red says whether the member was found: "doesn't read it" for
   * a member the class has, "no such member" for one it lacks.
   */
  it("finds a parent's static, which the compiler leaves out of an instance's members", async () => {
    const answer = await check("readsNothing", CHILD, "make");
    expect(answer.red).toMatch(/^accesses-not-read: /);
    expect(answer.inherited).toBe(0);
  }, 60_000);

  it("finds a parent's #private field, in either spelling", async () => {
    for (const member of ["#client", "client"]) {
      const answer = await check("readsNothing", CHILD, member);
      expect(answer.red).toMatch(/^accesses-not-read: /);
      expect(answer.inherited).toBe(0);
    }
  }, 60_000);

  it("never calls an implemented interface's optional member missing", async () => {
    const answer = await check("readsSize", "src/opts.ts#Sized", "flag");
    expect(answer.red).toMatch(/^accesses-not-read: /);
    expect(answer.inherited).toBe(0);
  }, 60_000);
});

describe("a class with a parent: a member nothing declares", () => {
  it("is red when the routine doesn't read it either", async () => {
    const answer = await check("readsNothing", CHILD, "missing");
    expect(answer.confirmed).toBe(0);
    expect(answer.red).toMatch(/^accesses-absent: /);
  }, 60_000);

  it("is held back when a parent comes from node_modules", async () => {
    expect(await check("readsMine", "src/wrapped.ts#Wrapped", "missing")).toEqual({ confirmed: 0, inherited: 1 });
  }, 60_000);

  it("still confirms a member of a class whose parent comes from node_modules", async () => {
    expect(await check("readsMine", "src/wrapped.ts#Wrapped", "mine")).toEqual({ confirmed: 1, inherited: 0 });
  }, 60_000);
});

describe("a class with a parent, with no compiler", () => {
  it("is held back as before, and counted so a live check asks one", async () => {
    const report = checkDrift(await boardFor("readsNothing", CHILD, "missing"), createWorkspace(repo), { edges: true });
    expect(answerOf(report)).toEqual({ confirmed: 0, inherited: 1 });
    expect(report.claims.endsUnsettled).toBe(1);
  });
});
