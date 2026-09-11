/**
 * `@accesses` as it reaches a report (#213).
 *
 * `engine-accesses.test.ts` covers the reader. What is covered here is the half
 * that decides what anybody is told: which answer becomes a red, which becomes
 * silence, and whether a claim nobody could check is distinguishable in the
 * report from a claim that passed.
 *
 * Two things have to stay true, and they are the whole design:
 *
 *   **The type end may say wrong.** A member list is a closed region, so an
 *   arrow naming a member the type does not have is refuted, with the member
 *   list quoted. That is what the word is for.
 *
 *   **The routine end may not.** Not seeing the routine read the member is
 *   never a finding, because knowing what a body touches needs every receiver's
 *   type. There is no `accesses-unread` and there must not be one.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

function fakeWorkspace(files: Record<string, string>): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => {
      if (files[target] !== undefined) return "file";
      return Object.keys(files).some((file) => file.startsWith(`${target}/`)) ? "directory" : "missing";
    },
    read: (target) => files[target] ?? "",
    list: () => [],
  };
}

/**
 * A routine box and a type box, with the arrow drawn reader -> type and the
 * member on the label.
 *
 * The same direction as `calls` and `builds`: the thing doing the work first.
 */
async function boardOf(
  member: string | undefined,
  edge: { claim?: "accesses"; state?: "planned" } = {},
): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "renderer", label: "render", ref: "src/render.ts#render" },
      { id: "config", label: "Config", ref: "src/config.ts#Config" },
    ],
    edges: [{ from: "renderer", to: "config", ...(member ? { label: member } : {}), ...edge }],
  });
  return board;
}

const files = (config: string, render: string) => ({
  "src/config.ts": config,
  "src/render.ts": render,
});

const CONFIG = "export class Config { width = 0; height = 0; }\n";

describe("@accesses on an arrow the code confirms", () => {
  it("confirms it, and counts the claim as held", async () => {
    const render = "export function render(config: Config) { return config.width; }\n";
    const board = await boardOf("width", { claim: "accesses" });
    const report = checkDrift(board, fakeWorkspace(files(CONFIG, render)), { edges: true });

    expect(report.claims.accesses).toBe(1);
    expect(report.claims.accessesConfirmed).toBe(1);
    expect(report.clean).toBe(true);
  });

  it("needs both halves, so the type having the member is not enough", async () => {
    /*
     * The admission rule in `claim.ts`, as a test. If `Config` declaring a
     * `width` were enough, every arrow drawn at a type with a `width` would
     * come back green whatever sat at the other end -- a verdict that cannot
     * depend on what you asserted.
     */
    const render = "export function render(config: Config) { return measure(config); }\n";
    const board = await boardOf("width", { claim: "accesses" });
    const report = checkDrift(board, fakeWorkspace(files(CONFIG, render)), { edges: true });

    expect(report.claims.accessesConfirmed).toBe(0);
  });
});

describe("the type end says wrong, which is what the word is for", () => {
  it("reports a member the type does not declare, and quotes the member list", async () => {
    // The case the word exists for: `width` was renamed and the board still
    // names it. The rename lands and the arrow goes red the same turn.
    const config = "export class Config { w = 0; height = 0; }\n";
    const render = "export function render(config: Config) { return config.w; }\n";
    const board = await boardOf("width", { claim: "accesses" });
    const report = checkDrift(board, fakeWorkspace(files(config, render)), { edges: true });

    const wrong = report.edges.filter((finding) => finding.kind === "accesses-absent");
    expect(wrong).toHaveLength(1);
    expect(wrong[0]!.detail).toContain("width");
    // What it read, so the accusation can be checked rather than believed.
    expect(wrong[0]!.detail).toContain("height");
    expect(report.clean).toBe(false);
  });

  it("refuses a plan the accusation, and keeps its confirmation", async () => {
    // Sketching a member that does not exist yet is what a plan is for, and a
    // red about one would be a lie about a plan.
    const config = "export class Config { height = 0; }\n";
    const render = "export function render(config: Config) { return config.width; }\n";
    const board = await boardOf("width", { claim: "accesses", state: "planned" });
    const report = checkDrift(board, fakeWorkspace(files(config, render)), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "accesses-absent")).toEqual([]);
  });
});

describe("the routine end is silent wherever the body cannot be read whole", () => {
  it("says nothing when the type has the member and the routine reads no member at all", async () => {
    /*
     * `render` reads nothing, so there is no body of reads to be closed and
     * nothing was measured for one (#255). It may reach `width` through
     * `sizeOf`, which this file cannot see into.
     */
    const render = "export function render(config: Config) { return sizeOf(config); }\n";
    const board = await boardOf("width", { claim: "accesses" });
    const report = checkDrift(board, fakeWorkspace(files(CONFIG, render)), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "accesses-absent")).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it("says nothing when the member list is not closed", async () => {
    // `Config` inherits, so `width` may be its parent's and the parent is not
    // in front of us. A red here is a red about ordinary code.
    const config = "export class Config extends Base { height = 0; }\n";
    const render = "export function render(config: Config) { return config.width; }\n";
    const board = await boardOf("width", { claim: "accesses" });
    const report = checkDrift(board, fakeWorkspace(files(config, render)), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "accesses-absent")).toEqual([]);
    expect(report.claims.accessesWithheld.inherited).toBe(1);
    expect(report.clean).toBe(true);
  });
});

describe("a claim nothing can ever read is loud, not quiet", () => {
  /*
   * The rule `claim.ts` states: a claim that is rendered and judged by nothing
   * reads exactly like a claim that passed. Both of these are the board being
   * wrong rather than the code, so neither is a red -- but neither may sit
   * there silently either.
   */
  it("says so when the arrow names no member", async () => {
    const render = "export function render(config: Config) { return config.width; }\n";
    const board = await boardOf(undefined, { claim: "accesses" });
    const report = checkDrift(board, fakeWorkspace(files(CONFIG, render)), { edges: true });

    expect(report.garbledClaims).toHaveLength(1);
    expect(report.garbledClaims[0]!.detail).toContain("name the member");
    expect(report.edges.filter((finding) => finding.kind === "accesses-absent")).toEqual([]);
  });

  it("says so when the label is prose rather than a member name", async () => {
    const render = "export function render(config: Config) { return config.width; }\n";
    const board = await boardOf("reads the config", { claim: "accesses" });
    const report = checkDrift(board, fakeWorkspace(files(CONFIG, render)), { edges: true });

    expect(report.garbledClaims).toHaveLength(1);
    expect(report.garbledClaims[0]!.detail).toContain("reads the config");
  });

  it("says so when the far end is a routine, which has no members", async () => {
    const config = "export function Config(width: number) { return width; }\n";
    const render = "export function render() { return 1; }\n";
    const board = await boardOf("width", { claim: "accesses" });
    const report = checkDrift(board, fakeWorkspace(files(config, render)), { edges: true });

    expect(report.garbledClaims).toHaveLength(1);
    expect(report.garbledClaims[0]!.detail).toContain("has no members");
  });
});

/*
 * The routine end says wrong, by name (#255).
 *
 * A read of Config.width is written `something.width` whatever `something`
 * is, so a routine whose every read has a name, and none of whose reads is
 * called `width`, does not read width off Config. Unless a function it calls
 * does -- then the right board is `render --calls--> paint --accesses-->
 * Config`, and this arrow is that board drawn one level too high, not wrong.
 */
describe("the routine end says wrong when nothing in the body is called the member", () => {
  it("reports a routine that reads other members and never this one, and says what it reads", async () => {
    const render = "export function render(config: Config) { return config.height; }\n";
    const board = await boardOf("width", { claim: "accesses" });
    const report = checkDrift(board, fakeWorkspace(files(CONFIG, render)), { edges: true });

    const wrong = report.edges.filter((finding) => finding.kind === "accesses-not-read");
    expect(wrong).toHaveLength(1);
    expect(wrong[0]!.detail).toContain("nothing in render is called `width`");
    expect(wrong[0]!.detail).toContain("reads 1 other member");
    expect(report.clean).toBe(false);
  });

  it("stays quiet when a function in the same file reads the member for it", async () => {
    const render = [
      "function paint(config: Config) { return config.width; }",
      "export function render(config: Config) { return paint(config) + config.height; }",
    ].join("\n");
    const board = await boardOf("width", { claim: "accesses" });
    const report = checkDrift(board, fakeWorkspace(files(CONFIG, render)), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "accesses-not-read")).toEqual([]);
  });

  it("stays quiet when an imported function reads the member for it", async () => {
    const board = await boardOf("width", { claim: "accesses" });
    const report = checkDrift(board, fakeWorkspace({
      "src/config.ts": CONFIG,
      "src/paint.ts": "import { Config } from './config';\nexport function paint(config: Config) { return config.width; }\n",
      "src/render.ts": "import { paint } from './paint';\nexport function render(config: Config) { return paint(config) + config.height; }\n",
    }), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "accesses-not-read")).toEqual([]);
  });

  it("still says wrong past a call it cannot see into, and says how many there were", async () => {
    const render = "export function render(config: Config) { return sizeOf(config) + config.height; }\n";
    const board = await boardOf("width", { claim: "accesses" });
    const report = checkDrift(board, fakeWorkspace(files(CONFIG, render)), { edges: true });

    const wrong = report.edges.filter((finding) => finding.kind === "accesses-not-read");
    expect(wrong).toHaveLength(1);
    expect(wrong[0]!.detail).toContain("calls 1 function this check could not see into");
    expect(wrong[0]!.detail).toContain("render --calls--> that function --accesses--> Config");
  });

  it("counts a call to a parameter as one nobody can see into, not as a call to itself", async () => {
    // Where a checker's "go to definition" lands for `measure(..)`: the
    // parameter, on render's own line. Reading render's own reads as the
    // callee's would count that call as seen.
    const render = "export function render(config: Config, measure: (c: Config) => number) { return measure(config) + config.height; }\n";
    const board = await boardOf("width", { claim: "accesses" });
    const report = checkDrift(board, fakeWorkspace(files(CONFIG, render)), {
      edges: true,
      closedBodyReferee: {
        resolveReceiver: () => undefined,
        declarationAt: () => ({ file: "src/render.ts", line: 1 }),
      },
    });

    const wrong = report.edges.filter((finding) => finding.kind === "accesses-not-read");
    expect(wrong).toHaveLength(1);
    expect(wrong[0]!.detail).toContain("calls 1 function this check could not see into");
  });

  it("stays quiet when a checker finds the helper the call reader could not place", async () => {
    // `lookup().paint(..)` has a receiver nothing in the text names, so only a
    // checker can say which `paint` it is.
    const workspace = fakeWorkspace({
      "src/config.ts": CONFIG,
      "src/paint.ts": "export function paint(config: Config) { return config.width; }\n",
      "src/render.ts": "export function render(config: Config) { return lookup().paint(config) + config.height; }\n",
    });
    const board = await boardOf("width", { claim: "accesses" });
    const blind = checkDrift(board, workspace, { edges: true });
    expect(blind.edges.filter((finding) => finding.kind === "accesses-not-read")).toHaveLength(1);

    const seeing = checkDrift(board, workspace, {
      edges: true,
      closedBodyReferee: {
        resolveReceiver: () => undefined,
        declarationAt: () => ({ file: "src/paint.ts", line: 1 }),
      },
    });
    expect(seeing.edges.filter((finding) => finding.kind === "accesses-not-read")).toEqual([]);
  });

  it("never accuses a planned arrow", async () => {
    const render = "export function render(config: Config) { return config.height; }\n";
    const board = await boardOf("width", { claim: "accesses", state: "planned" });
    const report = checkDrift(board, fakeWorkspace(files(CONFIG, render)), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "accesses-not-read")).toEqual([]);
  });

  it("says nothing about a body that destructures, whatever else it reads", async () => {
    const render = "export function render(config: Config) { const { height } = config; return height; }\n";
    const board = await boardOf("width", { claim: "accesses" });
    const report = checkDrift(board, fakeWorkspace(files(CONFIG, render)), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "accesses-not-read")).toEqual([]);
    expect(report.clean).toBe(true);
  });
});
