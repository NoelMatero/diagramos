/**
 * The file walk every `measure:calls` number rests on (#254).
 *
 * `~/mundane` and `~/infrarouter` are two of its seven default trees, and both
 * carry an installed `node_modules`. Listing that with `find` overflowed the
 * output buffer, the error was swallowed, and the tree was read as empty -- so
 * the report still said "7 trees" while it read five.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sourceFiles } from "../scripts/lib/source-files";

describe("sourceFiles", () => {
  let tree: string;

  beforeAll(() => {
    tree = mkdtempSync(path.join(os.tmpdir(), "measure-source-files-"));
    mkdirSync(path.join(tree, "src"));
    writeFileSync(path.join(tree, "src", "app.ts"), "export function run() {}\n");
    // An installed dependency tree: more paths than `find`'s output fits in.
    const deps = path.join(tree, "node_modules", "some-package-with-a-long-name", "dist");
    mkdirSync(deps, { recursive: true });
    for (let i = 0; i < 14_000; i++) {
      writeFileSync(path.join(deps, `generated-module-number-${i}.js`), "");
    }
  });

  afterAll(() => rmSync(tree, { recursive: true, force: true }));

  it("still reads a tree whose installed dependencies are too many to list", () => {
    expect(sourceFiles(tree)).toEqual([path.join(tree, "src", "app.ts")]);
  });
});
