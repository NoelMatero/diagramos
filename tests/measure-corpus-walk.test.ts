/**
 * Any measurement whose corpus includes a big tree must use the safe walk.
 *
 * The bug this guards has now been found three times in three scripts (#222,
 * #254, #203). `sourceFiles` shelled out to `find` and filtered the list
 * afterwards, so an installed `node_modules` was listed in full first; on
 * `~/mundane` (16.9 MB of paths) and `~/infrarouter` (1.5 MB) that overflowed
 * `execFileSync`'s 1 MB default `maxBuffer`, a blanket `catch` read the
 * `ENOBUFS` as "no files here", and the report went on naming seven trees.
 *
 * Measured directly, that walk read **230 of 1,506 files -- it lost 84.7%** --
 * and three scripts printed "7 trees, 230 files" while doing it. Nothing ever
 * went red, which is the whole reason for a test: a tree that drops out makes a
 * number *smaller*, and a smaller number reads as a finding rather than a
 * fault.
 *
 * The rule is narrow on purpose. `find` is not banned -- `scripts/lib/boards.ts`
 * lists `*.excalidraw` with `find -name`, whose output is tiny, and it
 * deliberately reads *inside* `.claude` worktrees, which the shared walk skips.
 * `measure-handles.mts` passes a 512 MB buffer and prints the tree it could not
 * read instead of swallowing it. What is banned is listing a **big** tree that
 * way, and the trees are the thing this test looks at.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { sourceFiles } from "../scripts/lib/source-files";

const SCRIPTS = path.resolve(__dirname, "..", "scripts");

/**
 * Comments stripped first, because the fix is usually *described* in the file
 * that carries it: `measure-accesses.mts` documents the `find` version it
 * replaced, and a plain grep reads that as the bug still being there. It did,
 * and this test was written after that mistake.
 */
const codeOf = (file: string): string =>
  readFileSync(path.join(SCRIPTS, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");

const measureScripts = (): string[] =>
  sourceFiles(SCRIPTS)
    .filter((file) => path.dirname(file) === SCRIPTS)
    .map((file) => path.basename(file))
    .filter((file) => file.startsWith("measure-") && file.endsWith(".mts"));

describe("the walk a measurement finds its corpus with", () => {
  it("has measure scripts to check at all", () => {
    // A guard on the guard: a glob that silently matched nothing would pass
    // every assertion below, which is this bug's own shape one level up.
    expect(measureScripts().length).toBeGreaterThan(10);
  });

  it("never lists one of the big trees with `find`", () => {
    /** The trees whose path list does not fit in the default output buffer. */
    const BIG = ["mundane", "infrarouter"];
    const offenders = measureScripts().filter((file) => {
      const code = codeOf(file);
      const readsABigTree = BIG.some((tree) => code.includes(tree));
      return readsABigTree && /execFileSync\(\s*"find"/.test(code);
    });
    expect(offenders).toEqual([]);
  });
});
