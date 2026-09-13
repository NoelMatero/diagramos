/**
 * The corpus `measure:dataflow` reads, against the corpus it reports (#203).
 *
 * Every number on #203 -- 19.2% of values contained, 1.4% for crossing a call,
 * 0 leaked -- is a share of whatever this script managed to open. It listed a
 * tree with `find` and filtered afterwards, so an installed `node_modules` was
 * listed in full first; on `~/mundane` (126,863 files) and `~/infrarouter` that
 * overflowed `execFileSync`'s 1 MB output buffer, a blanket `catch` read the
 * `ENOBUFS` as "no files here", and the report went on saying six trees while
 * it read four.
 *
 * That is #254's bug in a second script, and `scripts/lib/source-files.ts` is
 * the walk written to fix it -- a directory at a time, never entering a skipped
 * one. This test is here because a silently empty tree does not fail anything:
 * it lowers a number, and a lowered number reads as a finding.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("the corpus measure:dataflow reads", () => {
  let tree: string;

  beforeAll(() => {
    tree = mkdtempSync(path.join(os.tmpdir(), "measure-dataflow-corpus-"));
    writeFileSync(
      path.join(tree, "app.ts"),
      "export function run() {\n  const kept = [1, 2];\n  return kept.length;\n}\n",
    );
    // An installed dependency tree: more paths than `find`'s output buffer fits.
    const deps = path.join(tree, "node_modules", "some-package-with-a-long-name", "dist");
    mkdirSync(deps, { recursive: true });
    for (let i = 0; i < 14_000; i++) {
      writeFileSync(path.join(deps, `generated-module-number-${i}.js`), "");
    }
  });

  afterAll(() => rmSync(tree, { recursive: true, force: true }));

  it("reads a tree whose installed dependencies are too many to list", () => {
    const report = execFileSync(
      "npx",
      ["tsx", "scripts/measure-dataflow.mts", tree],
      { encoding: "utf8", cwd: path.resolve(__dirname, ".."), maxBuffer: 64 * 1024 * 1024 },
    );
    expect(report).toMatch(/1 trees, 1 files/);
  });
});
