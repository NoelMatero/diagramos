/**
 * "Circle is one of Shape" is not called wrong when Circle fits Shape without
 * writing it down (#379, #393).
 *
 * A TypeScript class with an interface's members, and a Python class with a
 * Protocol's, is one of it: the compiler accepts it wherever the other is
 * wanted. The checker read "declares no base at all" as "is not one". Now the
 * red is put to the compiler first; with no compiler, a class that writes no
 * base list is not evidence.
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
  "base.ts": "export interface Shape {\n  area(): number;\n}\n\nexport interface Named {\n  name: string;\n}\n\nexport class Other {}\n",
  "impl.ts": [
    "import { Other } from \"./base\";",
    "",
    "export class Circle {",
    "  area(): number {",
    "    return 3;",
    "  }",
    "}",
    "",
    "export class Square extends Other {",
    "  side = 1;",
    "}",
    "",
  ].join("\n"),
};

const PY = {
  "py/__init__.py": "",
  "py/base.py": "import abc\nfrom typing import Protocol\n\n\nclass Shape(Protocol):\n    def area(self) -> float: ...\n\n\nclass Node(abc.ABC):\n    pass\n\n\nclass Other:\n    pass\n",
  "py/impl.py": [
    "from .base import Node, Other",
    "",
    "",
    "class Circle:",
    "    def area(self) -> float:",
    "        return 3.0",
    "",
    "",
    "class Registered:",
    "    pass",
    "",
    "",
    "Node.register(Registered)",
    "",
    "",
    "class Plain:",
    "    pass",
    "",
    "",
    "class Child(Other):",
    "    pass",
    "",
  ].join("\n"),
};

describe("TypeScript, a class that fits an interface without `implements`", () => {
  it("stays quiet", async () => {
    repo = scratchRepo(TS);
    const { each: [arrow] } = await verdicts(repo, [["impl.ts#Circle", "base.ts#Shape", "conforms"]]);
    expect(arrow).toEqual({ reds: [], unconfirmed: "compiler-says-it-does" });
  }, 60_000);

  it("is withheld, not red, with no compiler", async () => {
    repo = scratchRepo(TS);
    const { each: [arrow] } = await verdicts(repo, [["impl.ts#Circle", "base.ts#Shape", "conforms"]], { compiler: false });
    expect(arrow).toEqual({ reds: [], unconfirmed: "rests-on-unwritten" });
  }, 60_000);

  it("still calls it wrong when the compiler says it does not fit", async () => {
    repo = scratchRepo(TS);
    expect(await redsOf(repo, ["impl.ts#Circle", "base.ts#Named", "conforms"])).toEqual(["conforms-absent"]);
  }, 60_000);

  /*
   * #393's measurement: a base list naming something else is not evidence in
   * TypeScript, where a class is one of whatever it fits. So with no
   * compiler this is held back, and with one it is red.
   */
  it("is held back with no compiler when the class writes a base list that is something else", async () => {
    repo = scratchRepo(TS);
    const { each: [arrow] } = await verdicts(repo, [["impl.ts#Square", "base.ts#Named", "conforms"]], { compiler: false });
    expect(arrow).toEqual({ reds: [], unconfirmed: "rests-on-unwritten" });
  }, 60_000);

  it("is red when the compiler says a class with a base list does not fit", async () => {
    repo = scratchRepo(TS);
    expect(await redsOf(repo, ["impl.ts#Square", "base.ts#Named", "conforms"])).toEqual(["conforms-absent"]);
  }, 60_000);

  // vue's `SchedulerJob` drawn as one of `SchedulerJobFlags`, an enum (#393's bench).
  it("is red when the compiler says an interface is not one of an enum", async () => {
    repo = scratchRepo({ ...TS, "flags.ts": "export enum Flags {\n  A = 1,\n  B = 2,\n}\n\nexport interface Job extends Function {\n  flags?: Flags\n}\n" });
    expect(await redsOf(repo, ["flags.ts#Job", "flags.ts#Flags", "conforms"])).toEqual(["conforms-absent"]);
  }, 60_000);

  it("is still red with no compiler when the arrow is drawn backwards", async () => {
    repo = scratchRepo(TS);
    expect(await redsOf(repo, ["base.ts#Other", "impl.ts#Square", "conforms"], { compiler: false })).toEqual(["conforms-absent"]);
  }, 60_000);
});

describe("Python, a class that fits a Protocol with no base", () => {
  it("stays quiet", async () => {
    repo = scratchRepo(PY);
    const { each: [arrow] } = await verdicts(repo, [["py/impl.py#Circle", "py/base.py#Shape", "conforms"]]);
    expect(arrow).toEqual({ reds: [], unconfirmed: "compiler-says-it-does" });
  }, 120_000);

  it("is withheld, not red, with no compiler: a Protocol can be fitted without being named", async () => {
    repo = scratchRepo(PY);
    const { each: [arrow] } = await verdicts(repo, [["py/impl.py#Circle", "py/base.py#Shape", "conforms"]], { compiler: false });
    expect(arrow).toEqual({ reds: [], unconfirmed: "rests-on-unwritten" });
  }, 120_000);

  it("is still red with no compiler against a plain class, which a Python class only fits by naming it", async () => {
    repo = scratchRepo(PY);
    expect(await redsOf(repo, ["py/impl.py#Plain", "py/base.py#Other", "conforms"], { compiler: false })).toEqual(["conforms-absent"]);
  }, 120_000);

  it("stays quiet on `Node.register(Registered)`, which pyright cannot see", async () => {
    repo = scratchRepo(PY);
    expect(await redsOf(repo, ["py/impl.py#Registered", "py/base.py#Node", "conforms"])).toEqual([]);
  }, 120_000);

  it("still calls wrong a class drawn as one of itself, which it always fits", async () => {
    repo = scratchRepo(PY);
    expect(await redsOf(repo, ["py/impl.py#Plain", "py/impl.py#Plain", "conforms"])).toEqual(["conforms-absent"]);
  }, 120_000);

  it("still calls it wrong when pyright says it does not fit", async () => {
    repo = scratchRepo(PY);
    expect(await redsOf(repo, ["py/impl.py#Plain", "py/base.py#Node", "conforms"])).toEqual(["conforms-absent"]);
  }, 120_000);

  it("is still red with no compiler when the class names another base", async () => {
    repo = scratchRepo(PY);
    expect(await redsOf(repo, ["py/impl.py#Child", "py/base.py#Node", "conforms"], { compiler: false })).toEqual(["conforms-absent"]);
  }, 120_000);
});
