/**
 * The recall measurement (#302), and the new referee it needed for `@feeds`.
 *
 * Two things a person could check by hand. The `@feeds` referee offers the two
 * shapes `feeds.ts` confirms and declines the ones it does not. And the recall
 * column is reading the reader: switched off with `--refuse-all`, it falls to
 * zero on the same tree where it was not zero -- because a zero has two causes,
 * and a column that cannot move is not a measurement.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { refereeFlows } from "../scripts/lib/feeds-scan";

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts/measure-recall.mts");
const TSX = path.join(REPO, "node_modules/.bin/tsx");

const trees: string[] = [];
afterAll(() => {
  for (const tree of trees) rmSync(tree, { recursive: true, force: true });
});

const pairs = (source: string, language: "ts" | "python") =>
  refereeFlows(source, language).map((flow) => `${flow.producer}>${flow.consumer}`);

describe("the @feeds referee", () => {
  it("reads a result handed straight on", () => {
    expect(pairs("function run() {\n  save(load(path));\n}\n", "ts")).toEqual(["load>save"]);
  });

  it("reads a result bound to a name and passed on a later line", () => {
    const source = "def run(path):\n    rows = load(path)\n    save(rows)\n";
    expect(pairs(source, "python")).toEqual(["load>save"]);
  });

  it("credits a name assigned again to the second producer, not the first", () => {
    const source = "function run() {\n  let rows = load();\n  rows = other();\n  save(rows);\n}\n";
    expect(pairs(source, "ts")).toEqual(["other>save"]);
  });

  it("declines a call whose result is not what gets bound", () => {
    const source = "def run(value):\n    value = super().to_python(value)\n    clean(value)\n";
    expect(pairs(source, "python")).toEqual([]);
  });

  it("declines a call on a receiver, and a value passed inside something else", () => {
    const source = "function run() {\n  store.save(load());\n  const rows = load();\n  save({ rows });\n}\n";
    expect(pairs(source, "ts")).toEqual([]);
  });

  it("does not read a flow written in a comment or a string", () => {
    const source = "function run() {\n  // save(load(x))\n  log(\"save(load(x))\");\n}\n";
    expect(pairs(source, "ts")).toEqual([]);
  });
});

function measure(extra: string[]): string {
  const tree = mkdtempSync(path.join(os.tmpdir(), "measure-recall-"));
  trees.push(tree);
  writeFileSync(path.join(tree, "shapes.ts"), [
    "export class Point {",
    "  x: number;",
    "}",
    "export class Line {",
    "  start: Point;",
    "}",
    "export function helper(): number {",
    "  return 1;",
    "}",
    "export function draw(line: Line): Point {",
    "  return make(helper());",
    "}",
    "export function make(n: number): Point {",
    "  return new Point();",
    "}",
    "",
  ].join("\n"));
  const run = spawnSync(TSX, [SCRIPT, tree, "--words=holds,takes,returns,builds,calls,feeds", ...extra], {
    cwd: REPO, encoding: "utf8",
  });
  return `${run.stdout ?? ""}${run.stderr ?? ""}`;
}

/** The `all` cell of one word's row: `[recall, asked]`. */
function recallOf(report: string, word: string): [string, number] {
  const row = report.split("\n").find((line) => line.trim().startsWith(`${word} `));
  const all = /([\d.]+%|n\/a) of (\d+)\s*$/.exec(row ?? "");
  return [all?.[1] ?? "missing", Number(all?.[2] ?? 0)];
}

describe("measure:recall", () => {
  it("confirms true arrows, and confirms none of them with the reader switched off", () => {
    const working = measure([]);
    const broken = measure(["--refuse-all"]);
    for (const word of ["holds", "takes", "returns", "builds", "calls", "feeds"]) {
      const [recall, asked] = recallOf(working, word);
      expect(asked, `${word} asked nothing:\n${working}`).toBeGreaterThan(0);
      expect(recall, `${word} confirmed nothing:\n${working}`).not.toBe("0.0%");
      expect(recallOf(broken, word), `${word} under --refuse-all`).toEqual(["0.0%", asked]);
    }
    expect(broken).toContain("broken-on-purpose");
    expect(working).not.toContain("UNLABELLED");
  });
});
