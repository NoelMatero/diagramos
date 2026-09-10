/**
 * `resolveRustReceivers` (#256): Rust's version of `resolvePythonReceivers`, the
 * async-to-sync seam that lets `measure:closed-bodies` hand rust-analyzer's
 * answers to `callSitesIn`'s synchronous `resolveReceiver`.
 *
 * One test per way a receiver's type is written in Rust source, because each
 * lands on a different declaration line and the adapter has to read that line
 * to say whether a call through it may be trusted: a struct and an enum are one
 * type, a trait object is the interface hazard item 14 named, a generic
 * parameter names no declaration of its own, a std type is outside the tree,
 * and `Type::new()` is withheld by `rustTypeAnchorFor` before anything is asked.
 *
 * The live half is skipped when `rust-analyzer` is not installed, the stance
 * `resolution-rust-lsp.test.ts` already takes.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cargoRootsIn, isConcreteRustDeclaration, resolveRustReceivers,
} from "../scripts/lib/resolution-rust-receivers";

const hasRustAnalyzer = (() => {
  try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

/** `resolution-rust-lsp.test.ts`'s own bound, for its own reason: load, and re-priming. */
const LIVE_TIMEOUT_MS = 120_000;

function write(root: string, relative: string, contents: string): void {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function rangeOf(source: string, needle: string): { start: number; end: number } {
  const start = source.indexOf(needle);
  if (start < 0) throw new Error(`fixture bug: ${JSON.stringify(needle)} not found`);
  return { start, end: start + needle.length };
}

describe("isConcreteRustDeclaration", () => {
  it("reads a struct, an enum and a union as one type", () => {
    expect(isConcreteRustDeclaration("struct")).toBe(true);
    expect(isConcreteRustDeclaration("enum")).toBe(true);
    expect(isConcreteRustDeclaration("union")).toBe(true);
  });

  it("reads a trait, and an alias that could name one, as not concrete", () => {
    expect(isConcreteRustDeclaration("trait")).toBe(false);
    expect(isConcreteRustDeclaration("type")).toBe(false);
  });
});

describe("cargoRootsIn", () => {
  let tree: string;

  beforeAll(() => {
    tree = mkdtempSync(path.join(os.tmpdir(), "cargo-roots-"));
    write(tree, "a/Cargo.toml", "[workspace]\n");
    write(tree, "a/member/Cargo.toml", "[package]\n");
    write(tree, "b/Cargo.toml", "[package]\n");
    write(tree, "node_modules/dep/Cargo.toml", "[package]\n");
  });

  afterAll(() => rmSync(tree, { recursive: true, force: true }));

  it("names the shallowest manifest of each crate graph, and nothing a skipped directory holds", () => {
    const roots = cargoRootsIn(tree, new Set(["node_modules"])).map((one) => path.relative(tree, one)).sort();
    expect(roots).toEqual(["a", "b"]);
  });
});

describe.skipIf(!hasRustAnalyzer)("resolveRustReceivers", () => {
  let repo: string;
  let source: string;
  let answers: Awaited<ReturnType<typeof resolveRustReceivers>>;
  const at: Record<string, { start: number; end: number }> = {};

  beforeAll(async () => {
    repo = mkdtempSync(path.join(os.tmpdir(), "resolution-rust-receivers-"));
    write(repo, "Cargo.toml",
      "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n");
    write(repo, "src/lib.rs", "pub mod decl;\npub mod use_site;\n");
    write(repo, "src/decl.rs",
      "pub struct Config { pub name: String }\n"
      + "impl Config {\n"
      + "    pub fn new() -> Config { Config { name: String::new() } }\n"
      + "    pub fn load(&self) -> u32 { 7 }\n"
      + "}\n"
      + "pub enum Mode { Fast, Slow }\n"
      + "impl Mode {\n"
      + "    pub fn is_fast(&self) -> bool { matches!(self, Mode::Fast) }\n"
      + "}\n"
      + "pub trait Store {\n"
      + "    fn run(&self) -> u32;\n"
      + "}\n"
      + "impl Store for Config {\n"
      + "    fn run(&self) -> u32 { 1 }\n"
      + "}\n");
    source =
      "use crate::decl::{Config, Mode, Store};\n\n"
      + "pub fn on_struct(c: &Config) -> u32 {\n    c.load()\n}\n"
      + "pub fn on_enum(m: Mode) -> bool {\n    m.is_fast()\n}\n"
      + "pub fn on_trait_object(s: &dyn Store) -> u32 {\n    s.run()\n}\n"
      + "pub fn on_generic<T: Store>(t: &T) -> u32 {\n    t.run()\n}\n"
      + "pub fn on_std(names: Vec<String>) -> usize {\n    names.len()\n}\n"
      + "pub fn on_path_call() -> u32 {\n    Config::new().load()\n}\n";
    write(repo, "src/use_site.rs", source);

    const receiver = (needle: string) => {
      const { start } = rangeOf(source, needle);
      return { start, end: start + needle.lastIndexOf(".") };
    };
    at.struct = receiver("c.load");
    at.enum = receiver("m.is_fast");
    at.traitObject = receiver("s.run");
    at.generic = receiver("t.run");
    at.std = receiver("names.len");
    at.pathCall = receiver("Config::new().load");

    answers = await resolveRustReceivers(
      repo, Object.values(at).map((one) => ({ file: "src/use_site.rs", at: one })));
    answers.close();
  }, LIVE_TIMEOUT_MS);

  afterAll(() => {
    answers?.close();
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  const get = (key: string) => answers.cache.get("src/use_site.rs", at[key]!);

  it("started, and heard rust-analyzer say it had finished indexing", () => {
    expect(answers.started).toBe(true);
    expect(answers.primedCleanly).toBe(true);
  });

  it("places a struct receiver at its declaration, as one type", () => {
    expect(get("struct")).toEqual({ kind: "declared", file: path.join("src", "decl.rs"), concrete: true });
  });

  it("places an enum receiver the same way", () => {
    expect(get("enum")).toEqual({ kind: "declared", file: path.join("src", "decl.rs"), concrete: true });
  });

  it("places a trait object at the trait, and never as one type", () => {
    expect(get("traitObject")).toEqual({ kind: "declared", file: path.join("src", "decl.rs"), concrete: false });
  });

  it("gives a generic parameter no answer at all", () => {
    // Confirmed by probing this fixture directly rather than assumed from the
    // `undefined`: rust-analyzer answers nothing here, so the withheld-line
    // counter stays at 0. `T` bounded by a trait is exactly where a closed-body
    // accusation must not rest on the bound's own declaration.
    expect(get("generic")).toBeUndefined();
    expect(answers.notATypeDeclaration).toBe(0);
  });

  it("places a std receiver outside the tree", () => {
    expect(get("std")).toEqual({ kind: "external" });
  });

  it("asks nothing for `Type::new()`, which rust-analyzer answers nothing for", () => {
    expect(get("pathCall")).toBeUndefined();
  });

  it("counts a type spelled as a path apart, since no value sits at that position", () => {
    /*
     * `Config::new()` inside `Config::new().load()` is itself a call whose
     * receiver is `Config` -- a type, not a value. Counted rather than asked,
     * because folding it into a refusal would report how Rust spells its
     * constructors as the resolver failing to answer. This is the single
     * biggest reason Rust's reach sits below TypeScript's.
     */
    expect(answers.pathReceiver).toBeGreaterThan(0);
  });

  it("answers a key never asked with undefined", () => {
    expect(answers.cache.get("src/use_site.rs", { start: 0, end: 1 })).toBeUndefined();
  });
});
