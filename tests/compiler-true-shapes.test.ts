/**
 * Correct arrows `measure:compiler-true` found called wrong with no compiler,
 * each resting on something the text computes rather than writes (#393).
 *
 * - `...args: Parameters<typeof make>` names no type; the compiler knows the
 *   list holds a Thing. 13 vue arrows.
 * - `[Hooks.CAPTURED]: Hook` is a member whose name is an expression; the
 *   compiler knows it as `ec`. 7 vue arrows.
 *
 * Each with its guard: the same arrow wrong on written evidence stays red.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { dropRepo, scratchRepo, verdicts } from "./helpers/arrow-probe";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();
beforeAll(async () => { await initEngine(); }, 60_000);

let repo: string | undefined;
afterEach(() => { if (repo) dropRepo(repo); repo = undefined; });

const TS = {
  "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
  "types.ts": [
    "export class Thing { id = 1 }",
    "export class Other { id = 2 }",
    "export const enum Hooks { CAPTURED = 'ec' }",
    "export class Instance {",
    "  uid = 0;",
    "  [Hooks.CAPTURED]: number[] = [];",
    "}",
    "export class Plain {",
    "  uid = 0;",
    "}",
    "",
  ].join("\n"),
  "use.ts": [
    "import { Thing, Other, Instance, Plain } from './types'",
    "",
    "export function make(thing: Thing, count: number): void {",
    "  void thing; void count",
    "}",
    "",
    "export function forward(...args: Parameters<typeof make>): void {",
    "  make(...args)",
    "}",
    "",
    "export function named(other: Other): void {",
    "  void other",
    "}",
    "",
    "export function capture(instance: Instance): number {",
    "  return instance.ec.length",
    "}",
    "",
    "export function plain(p: Plain): number {",
    "  // @ts-expect-error: the arrow below is wrong on purpose",
    "  return p.ec.length",
    "}",
    "",
  ].join("\n"),
};

describe("a type the text computes is not written evidence", () => {
  it("does not call `...args: Parameters<typeof make>` wrong for taking a Thing", async () => {
    repo = scratchRepo(TS);
    const { each: [arrow] } = await verdicts(repo, [["types.ts#Thing", "use.ts#forward", "takes"]], { compiler: false });
    expect(arrow!.reds).toEqual([]);
  }, 60_000);

  it("still calls a written parameter type wrong", async () => {
    repo = scratchRepo(TS);
    const { each: [arrow] } = await verdicts(repo, [["types.ts#Thing", "use.ts#named", "takes"]], { compiler: false });
    expect(arrow!.reds).toEqual(["signature-absent"]);
  }, 60_000);
});

describe("a member whose name is an expression", () => {
  it("does not call reading it wrong", async () => {
    repo = scratchRepo(TS);
    const { each: [arrow] } = await verdicts(repo, [["use.ts#capture", "types.ts#Instance", "accesses", "ec"]], { compiler: false });
    expect(arrow!.reds).toEqual([]);
  }, 60_000);

  it("still calls a member a plain class does not declare wrong", async () => {
    repo = scratchRepo(TS);
    const { each: [arrow] } = await verdicts(repo, [["use.ts#plain", "types.ts#Plain", "accesses", "ec"]], { compiler: false });
    expect(arrow!.reds).toEqual(["accesses-absent"]);
  }, 60_000);
});
