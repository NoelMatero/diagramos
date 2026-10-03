/**
 * "A is one of C" is not called wrong when A's base is one of C (#393).
 *
 * `measure:compiler-true` drew every base the TypeScript compiler lists for
 * TanStack's types and 14 went red: `InfiniteQueryObserverOptions` extends
 * `InfiniteQueryPageParamsOptions`, which extends `InitialPageParam`, and the
 * checker read only the first declaration -- "names other things" -- with the
 * second written one file away. Each base is now followed to its own
 * declaration before the red is believed.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { dropRepo, redsOf, scratchRepo, verdicts } from "./helpers/arrow-probe";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();
beforeAll(async () => { await initEngine(); }, 60_000);

let repo: string | undefined;
afterEach(() => { if (repo) dropRepo(repo); repo = undefined; });

const TS = {
  "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
  "param.ts": "export interface InitialPageParam<T = unknown> {\n  initialPageParam: T\n}\n\nexport interface Unrelated {\n  other: string\n}\n",
  "options.ts": [
    "import type { InitialPageParam } from './param'",
    "",
    "export interface PageParamsOptions<TData = unknown, TPage = unknown>",
    "  extends InitialPageParam<TPage> {",
    "  getNext: (last: TData) => TPage",
    "}",
    "",
  ].join("\n"),
  "observer.ts": [
    "import type { PageParamsOptions } from './options'",
    "",
    "export interface ObserverOptions<",
    "  TData = unknown,",
    "  TPage = unknown,",
    ">",
    "  extends",
    "    PageParamsOptions<",
    "      TData,",
    "      TPage",
    "    > {}",
    "",
    "export class Base {}",
    "",
    "export class Leaf extends Base {}",
    "",
    "export class Failure extends Error {}",
    "",
  ].join("\n"),
};

const PY = {
  "py/__init__.py": "",
  "py/base.py": "class Root:\n    pass\n\n\nclass Unrelated:\n    pass\n",
  "py/middle.py": "from .base import Root\n\n\nclass Middle(Root):\n    pass\n",
  "py/leaf.py": "from .middle import Middle\n\n\nclass Leaf(Middle):\n    pass\n\n\nclass Failure(Exception):\n    pass\n",
};

describe("TypeScript, a base of a base", () => {
  it("is not red with no compiler: the chain is written, a file at a time", async () => {
    repo = scratchRepo(TS);
    expect(await redsOf(repo, ["observer.ts#ObserverOptions", "param.ts#InitialPageParam", "conforms"], { compiler: false })).toEqual([]);
  }, 60_000);

  it("is not red with the compiler running", async () => {
    repo = scratchRepo(TS);
    expect(await redsOf(repo, ["observer.ts#ObserverOptions", "param.ts#InitialPageParam", "conforms"])).toEqual([]);
  }, 60_000);

  // TypeScript decides fit by shape, so with no compiler a base list is not
  // evidence (see gate-conforms); the compiler is what keeps these red.
  it("is still red when the chain ends without reaching it and the compiler says it does not fit", async () => {
    repo = scratchRepo(TS);
    const { each } = await verdicts(repo, [
      ["observer.ts#Leaf", "param.ts#Unrelated", "conforms"],
      // A global base leaves the repository, which nothing here can be a base of.
      ["observer.ts#Failure", "param.ts#Unrelated", "conforms"],
      // A generic's fit depends on its arguments (#395) -- except that it has
      // no `other`, which no argument gives it (#416).
      ["observer.ts#ObserverOptions", "param.ts#Unrelated", "conforms"],
    ]);
    expect(each.map((one) => one.reds)).toEqual([["conforms-absent"], ["conforms-absent"], ["conforms-absent"]]);
  }, 60_000);
});

describe("Python, a base of a base", () => {
  it("is not red with no compiler", async () => {
    repo = scratchRepo(PY);
    expect(await redsOf(repo, ["py/leaf.py#Leaf", "py/base.py#Root", "conforms"], { compiler: false })).toEqual([]);
  }, 120_000);

  it("is still red with no compiler when the chain ends without reaching it", async () => {
    repo = scratchRepo(PY);
    const { each } = await verdicts(repo, [
      ["py/leaf.py#Leaf", "py/base.py#Unrelated", "conforms"],
      ["py/leaf.py#Failure", "py/base.py#Unrelated", "conforms"],
    ], { compiler: false });
    expect(each.map((one) => one.reds)).toEqual([["conforms-absent"], ["conforms-absent"]]);
  }, 120_000);
});
