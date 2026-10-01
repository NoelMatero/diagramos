/**
 * Correct arrows `measure:compiler-true` found called wrong with no compiler,
 * each resting on something the text computes rather than writes (#393).
 *
 * - `...args: Parameters<typeof make>` names no type; the compiler knows the
 *   list holds a Thing. 13 vue arrows.
 * - `[Hooks.CAPTURED]: Hook` is a member whose name is an expression; the
 *   compiler knows it as `ec`. 7 vue arrows.
 *
 * - `element: Element`, where `type Element = Shape | Label` and
 *   `type Shape = Line | Box` live in another file: a name that is an alias
 *   says nothing about what it stands for.
 *   934 excalidraw arrows; the same in Python (`Engines = list[Engine]`).
 * - `...rest: Thing[]` was asked of the compiler at the `...`, which has no
 *   type, so it could not say. 2 nest arrows.
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

const ALIASED = {
  "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
  "shapes.ts": [
    "export class Line { length = 1 }",
    "export class Box { width = 1 }",
    "export class Other { id = 1 }",
    "export class Label { text = '' }",
    "// Two aliases deep, as excalidraw's ExcalidrawElement is.",
    "export type Shape = Line | Box",
    "export type Element = Shape | Label",
    "",
  ].join("\n"),
  "draw.ts": [
    "import { Element, Other } from './shapes'",
    "",
    "export function draw(element: Element): void {",
    "  void element",
    "}",
    "",
    "export function drawOther(other: Other): void {",
    "  void other",
    "}",
    "",
    "export function drawAll(...elements: Element[]): void {",
    "  void elements",
    "}",
    "",
    "export class Scene {",
    "  current: Element | null = null",
    "}",
    "",
  ].join("\n"),
  "py/__init__.py": "",
  "py/engine.py": "class Engine:\n    pass\n\n\nclass Wheel:\n    pass\n\n\nEngines = list[Engine]\n",
  "py/car.py": "from .engine import Engines, Wheel\n\n\nclass Car:\n    engines: Engines\n    wheel: Wheel\n\n\nclass Bike:\n    wheel: Wheel\n",
};

describe("a type written through an alias is not written evidence", () => {
  it("does not call `draw(element: Element)` wrong for taking a Box, with no compiler", async () => {
    repo = scratchRepo(ALIASED);
    const { each } = await verdicts(repo, [
      ["shapes.ts#Box", "draw.ts#draw", "takes"],
      ["shapes.ts#Box", "draw.ts#Scene", "holds"],
    ], { compiler: false });
    expect(each.map((one) => one.reds)).toEqual([[], []]);
  }, 60_000);

  it("does not call it wrong with the compiler running, at a rest parameter either", async () => {
    repo = scratchRepo(ALIASED);
    const { each } = await verdicts(repo, [
      ["shapes.ts#Box", "draw.ts#draw", "takes"],
      ["shapes.ts#Box", "draw.ts#drawAll", "takes"],
    ]);
    expect(each.map((one) => one.reds)).toEqual([[], []]);
  }, 60_000);

  it("still calls a parameter typed as a class wrong, with no compiler", async () => {
    repo = scratchRepo(ALIASED);
    const { each: [arrow] } = await verdicts(repo, [["shapes.ts#Box", "draw.ts#drawOther", "takes"]], { compiler: false });
    expect(arrow!.reds).toEqual(["signature-absent"]);
  }, 60_000);

  it("does not call a Python field typed through a module-level alias wrong, and still calls a plain one wrong", async () => {
    repo = scratchRepo(ALIASED);
    const { each } = await verdicts(repo, [
      ["py/car.py#Car", "py/engine.py#Engine", "holds"],
      ["py/car.py#Bike", "py/engine.py#Engine", "holds"],
    ], { compiler: false });
    expect(each.map((one) => one.reds)).toEqual([[], ["holds-absent"]]);
  }, 120_000);
});
