/**
 * `resolveRustDefinitions` (#reach): "go to definition" in batch, which is the
 * question `resolveRustReceivers` cannot answer and Rust needs most.
 *
 * A receiver's *type* is the wrong question about `Config::new()`. There is no
 * value at that position -- `Config` is a type spelled as a path, which is how
 * Rust spells a constructor -- so `typeDefinition` has nothing to say and
 * `resolveRustReceivers` counts it apart as `pathReceiver`, calling it "the
 * single biggest reason Rust's reach is below TypeScript's". Asked as a
 * definition at `new`'s own position instead, rust-analyzer points straight at
 * the `impl`.
 *
 * One test per shape a caller has to tell apart: a path call, a method on a
 * value, and a call into the standard library -- which must come back
 * `"outside"` rather than unanswered, because that is the one answer entitled
 * to settle a call site.
 *
 * Skipped when `rust-analyzer` is not installed, the stance
 * `resolution-rust-receivers.test.ts` already takes.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveRustDefinitions } from "../scripts/lib/resolution-definitions";

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

describe.skipIf(!hasRustAnalyzer)("resolveRustDefinitions", () => {
  let repo: string;
  let source: string;
  let answers: Awaited<ReturnType<typeof resolveRustDefinitions>>;
  const at: Record<string, { start: number; end: number }> = {};

  beforeAll(async () => {
    repo = mkdtempSync(path.join(os.tmpdir(), "resolution-definitions-"));
    write(repo, "Cargo.toml",
      "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n");
    write(repo, "src/lib.rs", "pub mod decl;\npub mod use_site;\n");
    write(repo, "src/decl.rs",
      "pub struct Config { pub name: String }\n"
      + "impl Config {\n"
      + "    pub fn new() -> Config { Config { name: String::new() } }\n"
      + "    pub fn load(&self) -> u32 { 7 }\n"
      + "}\n");
    source =
      "use crate::decl::Config;\n\n"
      + "pub fn build() -> Config {\n    Config::new()\n}\n"
      + "pub fn read(c: &Config) -> u32 {\n    c.load()\n}\n"
      + "pub fn shout(word: &str) -> String {\n    word.to_uppercase()\n}\n";
    write(repo, "src/use_site.rs", source);

    /** The *called name*'s own range, which is what a definition is asked at. */
    const name = (needle: string, called: string) => {
      const site = source.indexOf(needle);
      if (site < 0) throw new Error(`fixture bug: ${JSON.stringify(needle)} not found`);
      const start = source.indexOf(called, site);
      return { start, end: start + called.length };
    };
    at.pathCall = name("Config::new", "new");
    at.method = name("c.load", "load");
    at.std = name("word.to_uppercase", "to_uppercase");

    answers = await resolveRustDefinitions(repo, [
      { file: "src/use_site.rs", at: at.pathCall! },
      { file: "src/use_site.rs", at: at.method! },
      { file: "src/use_site.rs", at: at.std! },
    ]);
  }, LIVE_TIMEOUT_MS);

  afterAll(() => {
    answers?.close();
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("started a server for the crate", () => {
    expect(answers.started).toBe(true);
  });

  it("places a path call at the impl, which is what a receiver's type cannot do", () => {
    expect(answers.cache.get("src/use_site.rs", at.pathCall!))
      .toEqual({ file: path.join("src", "decl.rs"), line: 3 });
  });

  it("places a method called on a value the same way", () => {
    expect(answers.cache.get("src/use_site.rs", at.method!))
      .toEqual({ file: path.join("src", "decl.rs"), line: 4 });
  });

  it("says outside for a call into the standard library", () => {
    // The one answer allowed to settle a call site: a call the compiler puts
    // outside this repository provably is not a routine in it.
    expect(answers.cache.get("src/use_site.rs", at.std!)).toBe("outside");
  });
});
