/**
 * The referee `@holds` is licensed against, driven over source it should be
 * able to read.
 *
 * It stripped `#` as a comment marker in every language. In Python that is one.
 * In TypeScript it is the private field sigil, so `#cache: Registry;` became
 * the empty string and the field vanished -- along with every other private
 * field in the corpus. `licence.ts` records what `holds` was measured against,
 * and a whole spelling of a TypeScript field was never asked about. (#223)
 *
 * The measurement is driven as a command over a fixture tree, because that is
 * how a person would check it: the totals it prints are the thing that was
 * wrong.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts/measure-holds.mts");
const TSX = path.join(REPO, "node_modules/.bin/tsx");

const trees: string[] = [];

function measure(files: Record<string, string>): string {
  const tree = mkdtempSync(path.join(os.tmpdir(), "measure-holds-"));
  trees.push(tree);
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(tree, name), body);
  const run = spawnSync(TSX, [SCRIPT, tree], { cwd: REPO, encoding: "utf8" });
  return `${run.stdout ?? ""}${run.stderr ?? ""}`;
}

/** The `asked` column for one language, which is the count that went missing. */
function asked(report: string, language: string): number {
  const row = report.split("\n").find((line) => line.trim().startsWith(language));
  if (!row) return 0;
  return Number(row.trim().split(/\s+/)[2]);
}

afterAll(() => {
  for (const tree of trees) rmSync(tree, { recursive: true, force: true });
});

describe("what the holds referee can see", () => {
  it("reads a TypeScript private field, which is a field and not a comment", () => {
    const report = measure({
      "a.ts": [
        "export class Board {",
        "  #registry: Registry;",
        "}",
        "export class Registry {",
        "  entries: string[] = [];",
        "}",
        "",
      ].join("\n"),
    });
    expect(asked(report, "ts")).toBe(1);
    expect(report).toContain("referee saw the name, reader did not: 0");
  });

  it("reads one behind a modifier, which is how the corpus mostly writes them", () => {
    const report = measure({
      "b.ts": [
        "export class Sync {",
        "  readonly #pending: Queue;",
        "  private readonly plain: Latch;",
        "}",
        "export class Queue {",
        "  depth = 0;",
        "}",
        "export class Latch {",
        "  open = false;",
        "}",
        "",
      ].join("\n"),
    });
    // Two fields holding two types, one behind the private sigil and one not.
    // Before the fix the private one was not a field at all and this was 1.
    expect(asked(report, "ts")).toBe(2);
    expect(report).toContain("referee saw the name, reader did not: 0");
  });

  it("still takes `#` off a Python line, where it really is a comment", () => {
    const report = measure({
      "c.py": [
        "class Holder:",
        "    widget: Widget  # not really a Registry",
        "",
        "class Widget:",
        "    pass",
        "",
      ].join("\n"),
    });
    // `Registry` is prose. Counting it would ask the reader about a type that
    // is not in the field list, and the answer would come back a miss.
    expect(asked(report, "python")).toBe(1);
    expect(report).toContain("referee saw the name, reader did not: 0");
  });

  it("still takes `#` off a Rust line, where it opens an attribute", () => {
    const report = measure({
      "d.rs": [
        "pub struct Board {",
        "    pub registry: Registry, // not a Queue",
        "}",
        "pub struct Registry {",
        "    pub depth: usize,",
        "}",
        "",
      ].join("\n"),
    });
    expect(asked(report, "rust")).toBe(1);
    expect(report).toContain("referee saw the name, reader did not: 0");
  });
});
