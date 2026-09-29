/**
 * The two of #393's questions Rust has a red resting on, asked of
 * rust-analyzer: what a type is made of (#380's `fn f<N: Named>(n: N)`) and
 * where a macro's path resolves (#383's `crate::cents!`). Skipped where
 * rust-analyzer is not installed, as CI has it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { partsInclude, type DeclaredAt } from "../src/engine/compiler-questions";
import {
  refereePool, resolveRustImports, resolveRustTypeParts, type QuestionQuery, type RefereePool,
} from "../src/engine/referee-pool";
import { rustTypeParts, type RustLspReferee } from "../src/engine/referee-rust-lsp";

const hasRustAnalyzer = (() => {
  try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

describe("reading rust-analyzer's hover", () => {
  const named = [{ title: "Named", file: "/r/src/parts.rs", line: 2 }];

  it("takes the hover's go-to targets as the parts", () => {
    expect(rustTypeParts("probe::car\n\nwheels: Vec<Engine, Global>", [
      { title: "Vec", file: "/std/vec.rs", line: 1 },
      { title: "Engine", file: "/r/src/parts.rs", line: 0 },
      { title: "Global", file: "/std/alloc.rs", line: 1 },
    ])).toEqual({
      parts: [
        { name: "Vec", file: "/std/vec.rs", line: 1 },
        { name: "Engine", file: "/r/src/parts.rs", line: 0 },
        { name: "Global", file: "/std/alloc.rs", line: 1 },
      ],
      whole: true,
    });
  });

  it("keeps a bounded type parameter partial: its bounds are all that is known", () => {
    expect(rustTypeParts("n: N\n\ntype param may need Drop", named)).toEqual({
      parts: [{ name: "Named", file: "/r/src/parts.rs", line: 2 }], whole: false,
    });
  });

  it("reads a primitive as whole, with nothing in it", () => {
    expect(rustTypeParts("size: u8", [])).toEqual({ parts: [], whole: true });
  });

  it("reads {unknown} as partial", () => {
    expect(rustTypeParts("let x: {unknown}", [])).toEqual({ parts: [], whole: false });
  });
});

let repo: string;
let pool: RefereePool<RustLspReferee>;
const sources = new Map<string, string>();

function write(relative: string, contents: string): void {
  const full = path.join(repo, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
  sources.set(relative, contents);
}

function at(file: string, needle: string, mark = needle): { start: number; end: number } {
  const from = sources.get(file)!.indexOf(needle);
  if (from < 0) throw new Error(`fixture bug: ${JSON.stringify(needle)} not in ${file}`);
  const start = from + needle.indexOf(mark);
  return { start, end: start + mark.length };
}

function line(file: string, needle: string): number {
  const text = sources.get(file)!;
  return text.slice(0, text.indexOf(needle)).split("\n").length;
}

const PARTS = "src/parts.rs";
const CAR = "src/car.rs";
const place = (needle: string, name: string): { name: string; at: DeclaredAt } =>
  ({ name, at: { file: PARTS, line: line(PARTS, needle) } });

describe.skipIf(!hasRustAnalyzer)("asked of rust-analyzer", () => {
  beforeAll(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), "compiler-questions-rs-"));
    write("Cargo.toml", '[package]\nname = "probe"\nversion = "0.1.0"\nedition = "2021"\n');
    write("src/lib.rs", "#[macro_use]\npub mod macros;\npub mod parts;\npub mod car;\n");
    write("src/macros.rs", "#[macro_export]\nmacro_rules! cents {\n    ($x:expr) => {\n        $crate::parts::Money($x)\n    };\n}\n");
    write(PARTS, [
      "pub struct Engine;",
      "pub trait Seat {}",
      "pub trait Named {",
      "    fn name(&self) -> String;",
      "}",
      "pub struct Money(pub i64);",
      "",
    ].join("\n"));
    write(CAR, [
      "use crate::parts::{Engine, Money, Named, Seat};",
      "",
      "pub struct Gen<S: Seat> {",
      "    seat: S,",
      "    wheels: Vec<Engine>,",
      "    size: u8,",
      "}",
      "",
      "pub fn run<N: Named>(n: N) -> String {",
      "    n.name()",
      "}",
      "",
      "pub fn wh<N>(n: N) -> String",
      "where",
      "    N: Named,",
      "{",
      "    n.name()",
      "}",
      "",
      "pub fn any<T>(t: T) -> T {",
      "    t",
      "}",
      "",
      "pub fn cash() -> Money {",
      "    crate::cents!(3)",
      "}",
      "",
    ].join("\n"));
    pool = refereePool();
  });

  afterAll(() => {
    pool?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("answers what a type is made of, through bounds and arguments", async () => {
    const asked: QuestionQuery[] = [
      { file: CAR, at: at(CAR, "seat: S", "seat") },
      { file: CAR, at: at(CAR, "wheels: Vec", "wheels") },
      { file: CAR, at: at(CAR, "run<N: Named>(n: N)", "n: N") },
      { file: CAR, at: at(CAR, "wh<N>(n: N)", "n: N") },
      { file: CAR, at: at(CAR, "size: u8", "size") },
      { file: CAR, at: at(CAR, "any<T>(t: T)", "t: T") },
      // Each asked at the name alone: `n`, not `n: N`.
    ].map((query) => ({ ...query, at: { start: query.at.start, end: query.at.start + sources.get(CAR)!.slice(query.at.start).search(/\W/) } }));
    const answers = await resolveRustTypeParts(repo, asked, pool);
    const [seat, wheels, run, where, size, any] = asked.map((one) => answers.cache.get(one.file, one.at));
    // #380 in a struct and in a function, with the bound written inline and in a where clause.
    expect(partsInclude(seat, place("trait Seat", "Seat"))).toBe(true);
    expect(partsInclude(run, place("trait Named", "Named"))).toBe(true);
    expect(partsInclude(where, place("trait Named", "Named"))).toBe(true);
    expect(partsInclude(wheels, place("struct Engine", "Engine"))).toBe(true);
    expect(partsInclude(size, place("struct Engine", "Engine"))).toBe(false);
    expect(partsInclude(any, place("struct Engine", "Engine"))).toBeUndefined();
  }, 180_000);

  it("follows a macro's path to the file that defines it (#383)", async () => {
    const asked: QuestionQuery[] = [{ file: CAR, at: at(CAR, "crate::cents!") }];
    const answers = await resolveRustImports(repo, asked, pool);
    expect(answers.cache.get(CAR, asked[0]!.at)).toEqual({ file: "src/macros.rs" });
  }, 180_000);
});
