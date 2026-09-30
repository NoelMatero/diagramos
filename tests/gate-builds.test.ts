/**
 * "copy makes Money" is not called wrong when `copy` builds its own class
 * through `self.__class__(…)` (#387, #393).
 *
 * `type(self)(…)` and `self.__class__(…)` mean the same thing. The first was
 * always withheld as a call to something that is not a name; the second was
 * read as a call to an attribute somewhere outside the repository, and the
 * arrow went red. Both now say the same.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { dropRepo, redsOf, scratchRepo } from "./helpers/arrow-probe";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();
beforeAll(async () => { await initEngine(); }, 60_000);

let repo: string | undefined;
afterEach(() => { if (repo) dropRepo(repo); repo = undefined; });

const PY = {
  "m.py": [
    "import copy",
    "from dataclasses import dataclass",
    "",
    "",
    "@dataclass",
    "class Money:",
    "    c: int = 0",
    "",
    "    def copy(self):",
    "        return self.__class__(self.c)",
    "",
    "    def clone(self):",
    "        return type(self)(self.c)",
    "",
    "",
    "class Other:",
    "    pass",
    "",
    "",
    "def dup(m):",
    "    return copy.copy(m)",
    "",
  ].join("\n"),
};

describe("Python, a method that builds its own class", () => {
  it.each([
    ["`self.__class__(…)`", "m.py#copy"],
    ["`type(self)(…)`", "m.py#clone"],
  ])("stays quiet on %s, with the compiler and without", async (_shape, routine) => {
    repo = scratchRepo(PY);
    expect(await redsOf(repo, [routine, "m.py#Money", "builds"])).toEqual([]);
    expect(await redsOf(repo, [routine, "m.py#Money", "builds"], { compiler: false })).toEqual([]);
  }, 120_000);

  it("still calls wrong a routine that gets one back from a library (#360's design)", async () => {
    repo = scratchRepo(PY);
    expect(await redsOf(repo, ["m.py#dup", "m.py#Money", "builds"])).toEqual(["builds-refuted"]);
  }, 120_000);
});
