/**
 * Where code touches the outside world (#58).
 *
 * One test per shape a call to the outside is written in, per language, because
 * the three grammars spell a qualified callee three ways and a reader validated
 * on one of them is a reader that is wrong in the others.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { outsideCallsIn } from "../src/engine/outside";
import { initEngine } from "../src/engine/parse";

beforeAll(async () => { await initEngine(); }, 120_000);

/** The readings for calls to one name, without the byte ranges. */
function readingsOf(source: string, language: Parameters<typeof outsideCallsIn>[1], name: string) {
  return outsideCallsIn(source, language).calls
    .filter((call) => source.slice(call.nameAt.start, call.nameAt.end) === name)
    .map(({ routine, line, reading }) => ({ routine, line, reading }));
}

describe("TypeScript", () => {
  it("reads a call through a namespace import of node:fs as file access", () => {
    const source = [
      'import * as fs from "node:fs";',
      "export function save(board: string) {",
      '  fs.writeFileSync("board.excalidraw", board);',
      "}",
    ].join("\n");
    expect(readingsOf(source, "ts", "writeFileSync")).toEqual([
      { routine: "save", line: 3, reading: { verdict: "outside", kind: "file", qualified: "node:fs.writeFileSync" } },
    ]);
  });
});

describe("Python", () => {
  it("reads a call through a plain module import of os as file access", () => {
    const source = [
      "import os",
      "",
      "def cleanup(path):",
      "    os.remove(path)",
    ].join("\n");
    expect(readingsOf(source, "python", "remove")).toEqual([
      { routine: "cleanup", line: 4, reading: { verdict: "outside", kind: "file", qualified: "os.remove" } },
    ]);
  });
});

describe("Rust", () => {
  it("reads a call through a use of std::fs as file access", () => {
    const source = [
      "use std::fs;",
      "",
      "fn save(path: &str, board: &str) {",
      "    fs::write(path, board).unwrap();",
      "}",
    ].join("\n");
    expect(readingsOf(source, "rust", "write")).toEqual([
      { routine: "save", line: 4, reading: { verdict: "outside", kind: "file", qualified: "std::fs::write" } },
    ]);
  });
});

