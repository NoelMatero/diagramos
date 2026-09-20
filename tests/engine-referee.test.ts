/**
 * The referee the engine builds for itself (#328).
 *
 * The thing worth testing is not that a wrapper returns an object. It is the
 * behaviour change the wrapper exists for: a call written `thing.render()` is a
 * call the reader cannot place on its own, so the routine's call set never
 * closes and a wrong `@calls` arrow goes by in silence -- until something can
 * say what `thing` is. Both halves of that are asserted below, on the same
 * board, so the pair states the difference rather than describing it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { createClosedBodyReferee } from "../src/engine/referee";
import { createTsReferee } from "../src/engine/referee-ts";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

let repo: string;

function write(relative: string, contents: string): void {
  const full = path.join(repo, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/** One `@calls` arrow, caller -> callee, on a board of its own. */
async function boardOf(callerRef: string, calleeRef: string): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "caller", label: "run", ref: callerRef },
      { id: "callee", label: "paint", ref: calleeRef },
    ],
    edges: [{ from: "caller", to: "callee", claim: "calls" }],
  });
  return board;
}

afterAll(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

describe("a call on a value the text does not type (#328)", () => {
  /*
   * `run`'s body is `make().draw()`. The receiver of `draw` is an expression,
   * so its type is nowhere in `app.ts`'s text -- only the compiler knows
   * `make()` returns a `Renderer`. Nothing in `run` is constructed, so this
   * isolates the one question: can anything say what that receiver is.
   */
  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "referee-"));
    write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }));
    write("src/renderer.ts", "export class Renderer {\n  draw(): void {}\n}\n");
    write("src/other.ts", "export function paint(): void {}\n");
    write("src/factory.ts",
      'import { Renderer } from "./renderer";\n'
      + "export function make(): Renderer {\n"
      + "  return new Renderer();\n"
      + "}\n");
    write("src/app.ts",
      'import { make } from "./factory";\n'
      + "export function run(): void {\n"
      + "  make().draw();\n"
      + "}\n");
  });

  it("is silence without a referee, which is what every board drew before", async () => {
    const board = await boardOf("src/app.ts#run", "src/other.ts#paint");
    const report = checkDrift(board, createWorkspace(repo), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "calls-refuted")).toEqual([]);
    // Not merely quiet: the arrow names the wall it hit, which is #324's word.
    expect(report.claims.callsNotClosed).toHaveProperty("receiver");
  }, 60_000);

  it("is a refutation with one, because the call set finally closes", async () => {
    const board = await boardOf("src/app.ts#run", "src/other.ts#paint");
    const report = checkDrift(board, createWorkspace(repo), {
      edges: true,
      closedBodyReferee: createClosedBodyReferee(repo),
    });

    const refuted = report.edges.filter((finding) => finding.kind === "calls-refuted");
    expect(refuted).toHaveLength(1);
    // And the reason that used to stop it is gone rather than merely outvoted.
    expect(report.claims.callsNotClosed).not.toHaveProperty("receiver");
  }, 60_000);

  it("still confirms an arrow the code really does support", async () => {
    const board = await boardOf("src/app.ts#run", "src/factory.ts#make");
    const report = checkDrift(board, createWorkspace(repo), {
      edges: true,
      closedBodyReferee: createClosedBodyReferee(repo),
    });

    expect(report.claims.callsConfirmed).toBe(1);
    expect(report.edges.filter((finding) => finding.kind === "calls-refuted")).toEqual([]);
  }, 60_000);
});

describe("a construction is code running that nobody enumerated (#328)", () => {
  /*
   * The false accusation this PR's first bench run produced, reduced.
   *
   * `build` makes two calls and constructs one thing. The call reader sees the
   * calls and not the construction, so once a resolver could place both calls,
   * the body looked fully enumerated and a true arrow was called wrong. The
   * resolver did not cause that -- it removed the thing that had been hiding
   * it, which is why the fix belongs in the reader and not in the referee.
   */
  let built: string;

  beforeAll(() => {
    built = mkdtempSync(path.join(tmpdir(), "construct-"));
    const here = repo;
    repo = built;
    write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }));
    write("src/mutation.ts", "export class Mutation {\n  run(): void {}\n}\n");
    write("src/options.ts", "export class Client {\n  defaults(): number { return 1; }\n}\n");
    write("src/cache.ts",
      'import { Mutation } from "./mutation";\n'
      + 'import { Client } from "./options";\n'
      + "export function build(client: Client): Mutation {\n"
      + "  client.defaults();\n"
      + "  return new Mutation();\n"
      + "}\n");
    repo = here;
  });

  afterAll(() => { if (built) rmSync(built, { recursive: true, force: true }); });

  it("does not accuse an arrow whose only reach is a construction", async () => {
    const board = await boardOf("src/cache.ts#build", "src/mutation.ts#Mutation");
    const report = checkDrift(board, createWorkspace(built), {
      edges: true,
      closedBodyReferee: createClosedBodyReferee(built),
    });

    expect(report.edges.filter((finding) => finding.kind === "calls-refuted")).toEqual([]);
    // And it says so, rather than going quiet for an unexplained reason.
    expect(report.claims.callsNotClosed).toHaveProperty("construction");
  }, 60_000);

  it("still refutes when the construction is the only other thing in the body", async () => {
    // `build` constructs a `Mutation` and nothing reaches `options.ts#Client`
    // through it -- but the constructor is real code, so this stays unproven
    // rather than becoming a red on the strength of a body nobody finished.
    const board = await boardOf("src/cache.ts#build", "src/options.ts#Client");
    const report = checkDrift(board, createWorkspace(built), {
      edges: true,
      closedBodyReferee: createClosedBodyReferee(built),
    });

    expect(report.edges.filter((finding) => finding.kind === "calls-refuted")).toEqual([]);
  }, 60_000);
});

describe("what the referee will and will not answer", () => {
  it("says nothing about a language whose resolver cannot run at draw time", () => {
    const referee = createClosedBodyReferee(repo);
    expect(referee.resolveReceiver("src/thing.py", { start: 0, end: 1 })).toBeUndefined();
    expect(referee.resolveReceiver("src/thing.rs", { start: 0, end: 1 })).toBeUndefined();
  });

  it("uses answers a caller harvested for those languages instead", () => {
    const referee = createClosedBodyReferee(repo, {
      python: { resolveReceiver: () => ({ kind: "declared", file: "src/model.py", concrete: true }) },
    });

    expect(referee.resolveReceiver("src/thing.py", { start: 0, end: 1 }))
      .toEqual({ kind: "declared", file: "src/model.py", concrete: true });
    // Handed one language's answers, it does not start answering for the other.
    expect(referee.resolveReceiver("src/thing.rs", { start: 0, end: 1 })).toBeUndefined();
  });

  it("costs nothing until it is asked", () => {
    /*
     * The MCP server builds one of these at module scope, on every start, in
     * whatever repository it was pointed at. If construction walked the tree or
     * loaded the compiler, that would be a startup cost paid by every board
     * including the ones with no call arrow on them -- so a directory that does
     * not exist has to be a perfectly fine thing to build one for.
     */
    expect(() => createClosedBodyReferee(path.join(repo, "no", "such", "tree"))).not.toThrow();
  });
});

describe("the compiler is a devDependency, and the engine treats it as optional", () => {
  it("declines rather than throws, so a tree without one still gets checked", () => {
    /*
     * This checkout has TypeScript, so what is pinned here is the *shape* of
     * the answer: a value the caller can test, not an exception it has to
     * catch. `src/` is what the package publishes and `typescript` is not a
     * runtime dependency of it -- a consumer's install has no compiler, and
     * the published drift CLI died on `Cannot find package 'typescript'`
     * before this moved here.
     */
    const referee = createTsReferee(repo);
    expect(referee === undefined || typeof referee.typeAt === "function").toBe(true);
  });
});
