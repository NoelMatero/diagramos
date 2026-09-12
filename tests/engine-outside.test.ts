/**
 * Where code touches the outside world (#58).
 *
 * One test per shape a call to the outside is written in, per language, because
 * the three grammars spell a qualified callee three ways and a reader validated
 * on one of them is a reader that is wrong in the others.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { kindOfQualified, outsideCallsIn } from "../src/engine/outside";
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
  /*
   * `self.x.y()` is a method on the thing the routine belongs to, and the one
   * shape that must never be looked up in the imports. `use std::fs::{self}`
   * binds a name spelled `self`, so a chain starting `self.` matched it and
   * every method call on a field came back as file access -- 151 of ripgrep's
   * 181 outside calls, which is how the benchmark found this.
   */
  it("never reads a call on self as an import, whatever the file imports", () => {
    const source = [
      "use std::fs::{self, File};",
      "",
      "impl Walker {",
      "    fn run(&self) {",
      "        self.options.max_depth.is_some();",
      "    }",
      "}",
    ].join("\n");
    expect(readingsOf(source, "rust", "is_some")).toEqual([
      { routine: "run", line: 5, reading: { verdict: "unknown", why: "receiver" } },
    ]);
  });

  it("reads the module a grouped use brings in under its own name", () => {
    // `use std::fs::{self, File}` is how a crate says "fs and fs::File", and
    // the name it binds for the module is `fs` -- the last step of the prefix.
    const source = [
      "use std::fs::{self, File};",
      "",
      "fn save(path: &str, board: &str) {",
      "    fs::write(path, board).unwrap();",
      "}",
    ].join("\n");
    expect(readingsOf(source, "rust", "write")).toEqual([
      { routine: "save", line: 4, reading: { verdict: "outside", kind: "file", qualified: "std::fs::write" } },
    ]);
  });

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

/*
 * The benchmark names a call by where its own checker landed, and looks that
 * name up in this same list. So a module the runtime reaches under a second
 * name is a hole in the list rather than a disagreement about a call, and the
 * two below are the ones the corpus actually produced.
 */
describe("the list, under the names a checker lands on", () => {
  it("knows Python's socket module by the accelerator behind it", () => {
    expect(kindOfQualified("socket.gethostbyname", "python")).toBe("network");
    expect(kindOfQualified("_socket.gethostbyname", "python")).toBe("network");
  });

  it("knows the promise-shaped half of a Node module", () => {
    expect(kindOfQualified("node:dns.lookup", "ts")).toBe("network");
    expect(kindOfQualified("dns/promises.lookup", "ts")).toBe("network");
    expect(kindOfQualified("fs/promises.readFile", "ts")).toBe("file");
  });
});

