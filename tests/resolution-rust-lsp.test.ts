/**
 * `createRustAnalyzerReferee`'s own two questions (#246): where a receiver's
 * *type* is declared (`textDocument/typeDefinition`), and where the *method
 * actually called* is declared (`textDocument/definition`).
 *
 * The shapes below are not branches of the anchor scan -- they are the ways a
 * receiver actually occurs in Rust source, which is what AGENTS.md asks for and
 * what the two languages genuinely differ on. Every expectation about what
 * rust-analyzer answers was measured against a live server first; the ones that
 * withhold do so because asking there returned nothing, or something wrong, not
 * because the scan found them awkward.
 *
 * One server for the whole describe block, matching the module's own "one per
 * tree, many queries" design.
 *
 * The live half is skipped when `rust-analyzer` is not installed, which is the
 * same stance the referee itself takes (#237's settled distribution decision:
 * no binary fetcher, silence when absent). The pure-scan half always runs -- it
 * is where the anchor rules are pinned, and it needs no server.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRustAnalyzerReferee, isOutsideRustTree, rustMemberRangeAfter, rustTypeAnchorFor,
  type RustLspReferee,
} from "../scripts/lib/resolution-rust-lsp";

const hasRustAnalyzer = (() => {
  try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

/**
 * Every live test's own timeout. An LSP round trip is not a 5ms operation and
 * vitest's 5s default is not enough for one under load: running this file
 * inside the full suite, rust-analyzer competes with every other worker for
 * CPU, and it may re-prime its cache mid-run (observed on ripgrep), which puts
 * a query on the retry ladder for as long as ~15s. Alone this file finishes in
 * about 3s; the generous bound is for the parallel case, where a tighter one
 * fails on machine load rather than on anything about the code.
 */
const LIVE_TIMEOUT_MS = 60_000;

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

describe.skipIf(!hasRustAnalyzer)("createRustAnalyzerReferee", () => {
  let repo: string;
  let referee: RustLspReferee;
  let useFile: string;
  let useSource: string;

  beforeAll(async () => {
    repo = mkdtempSync(path.join(os.tmpdir(), "resolution-rust-lsp-"));
    write(repo, "Cargo.toml",
      "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n");
    write(repo, "src/lib.rs", "pub mod decl;\npub mod use_site;\n");
    write(repo, "src/decl.rs",
      "pub struct Config { pub name: String }\n"
      + "impl Config {\n"
      + "    pub fn new() -> Config { Config { name: String::new() } }\n"
      + "    pub fn load(&self) -> u32 { 7 }\n"
      + "}\n"
      + "pub struct Builder { pub cfg: Config }\n"
      + "impl Builder {\n"
      + "    pub fn make() -> Builder { Builder { cfg: Config::new() } }\n"
      + "    pub fn step(&self) -> Builder { Builder::make() }\n"
      + "    pub fn finish(&self) -> Config { Config::new() }\n"
      + "}\n");
    useSource =
      "use crate::decl::{Builder, Config};\n\n"
      + "pub struct Holder { pub cache: Config, pub names: Vec<String> }\n\n"
      + "impl Holder {\n"
      + "    pub fn plain(&self) -> u32 {\n"
      + "        let c = Config::new();\n"
      + "        c.load()\n"
      + "    }\n"
      // A field receiver: its declared type (Config, in decl.rs) is not the
      // struct this method lives on (Holder, right here).
      + "    pub fn field(&self) -> u32 {\n"
      + "        self.cache.load()\n"
      + "    }\n"
      // A method-call chain: the receiver for `.load()` spans everything
      // before it, and its first token (`self`) is not what the chain is.
      + "    pub fn chained(&self) -> u32 {\n"
      + "        self.builder().step().finish().load()\n"
      + "    }\n"
      + "    pub fn builder(&self) -> Builder { Builder::make() }\n"
      // A std-typed receiver, for the outside-the-tree classification.
      + "    pub fn external(&self) -> usize {\n"
      + "        self.names.len()\n"
      + "    }\n"
      + "}\n";
    write(repo, "src/use_site.rs", useSource);
    useFile = path.join(repo, "src/use_site.rs");

    referee = await createRustAnalyzerReferee(repo);
    await referee.warmUp();
  }, 120_000);

  afterAll(() => {
    referee?.close();
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  /**
   * The bad outcome this file's readiness gate exists to prevent, stated as the
   * thing that stopped happening: the referee used to answer "no declaration
   * here" for receivers it resolves correctly a second later, because it
   * decided readiness from the shape of the answer instead of waiting for
   * rust-analyzer to say so. Two identical measurement runs then reported 68.7%
   * coverage and 13.6%.
   *
   * A test cannot easily reproduce that race, but it can pin the property that
   * removed it: the server states when it is primed, and the referee knows.
   */
  it("waits for rust-analyzer's own finished-indexing notification rather than guessing", () => {
    expect(referee.primedCleanly()).toBe(true);
  }, LIVE_TIMEOUT_MS);

  it("answers the same way when asked twice, which the pre-gate version did not", async () => {
    const { start, end } = rangeOf(useSource, "self.cache");
    const once = await referee.typeDeclarationAt(useFile, useSource, start, end);
    const twice = await referee.typeDeclarationAt(useFile, useSource, start, end);
    expect(once).toBeDefined();
    expect(twice).toBe(once);
  }, LIVE_TIMEOUT_MS);

  it("typeDeclarationAt follows a plain receiver to its type's own declaration, across files", async () => {
    const { start } = rangeOf(useSource, "c.load");
    const declaring = await referee.typeDeclarationAt(useFile, useSource, start, start + 1);
    expect(declaring && path.relative(repo, declaring)).toBe(path.join("src", "decl.rs"));
  }, LIVE_TIMEOUT_MS);

  it("methodDeclarationAt, asked at the method's own position, reaches the method", async () => {
    const receiverEnd = rangeOf(useSource, "c.load").start + 1;
    const member = rustMemberRangeAfter(useSource, receiverEnd, "load");
    expect(member).toBeDefined();
    const declaring = await referee.methodDeclarationAt(useFile, useSource, member!.start, member!.end);
    expect(declaring && path.relative(repo, declaring)).toBe(path.join("src", "decl.rs"));
  }, LIVE_TIMEOUT_MS);

  it("methodDeclarationAt at the receiver's position answers a different question entirely", async () => {
    // The regression this pins: the two LSP methods are not interchangeable.
    // Asked at `c`, `definition` reaches `c`'s own binding, in this file.
    const { start } = rangeOf(useSource, "c.load");
    const declaring = await referee.methodDeclarationAt(useFile, useSource, start, start + 1);
    expect(declaring).toBe(useFile);
  }, LIVE_TIMEOUT_MS);

  it("typeDeclarationAt on a field receiver follows the field's type, not the enclosing struct", async () => {
    const { start, end } = rangeOf(useSource, "self.cache");
    const declaring = await referee.typeDeclarationAt(useFile, useSource, start, end);
    expect(declaring && path.relative(repo, declaring)).toBe(path.join("src", "decl.rs"));
  }, LIVE_TIMEOUT_MS);

  it("typeDeclarationAt on a method-call chain follows the chain, not the enclosing `self`", async () => {
    const { start, end } = rangeOf(useSource, "self.builder().step().finish()");
    const declaring = await referee.typeDeclarationAt(useFile, useSource, start, end);
    expect(declaring && path.relative(repo, declaring)).toBe(path.join("src", "decl.rs"));
  }, LIVE_TIMEOUT_MS);

  it("classifies a std type's declaration as outside the tree", async () => {
    const { start, end } = rangeOf(useSource, "self.names");
    const declaring = await referee.typeDeclarationAt(useFile, useSource, start, end);
    expect(declaring).toBeDefined();
    expect(isOutsideRustTree(declaring!, repo)).toBe(true);
  }, LIVE_TIMEOUT_MS);

  it("returns undefined for a position with no real answer", async () => {
    // An empty array from a warm server, not a not-ready signal: this is the
    // answer the retry ladder must *not* spend itself on.
    const { start } = rangeOf(useSource, "pub struct Holder");
    const declaring = await referee.typeDeclarationAt(useFile, useSource, start, start + 3);
    expect(declaring).toBeUndefined();
  }, LIVE_TIMEOUT_MS);

  /**
   * The measured difference from Python, pinned so a later edit cannot quietly
   * "fix" the anchor scan into asking a question rust-analyzer answers with
   * nothing. `Builder::make()` is how Rust spells a constructor, and
   * `typeDefinition` at `make` returns an empty array -- so the scan withholds
   * instead, and this test is what says that is deliberate.
   */
  it("withholds a path-call receiver rather than asking where rust-analyzer answers nothing", async () => {
    const source = "        let b = Builder::make().load();\n";
    const { start, end } = rangeOf(source, "Builder::make()");
    expect(rustTypeAnchorFor(source, start, end)).toBeUndefined();
  }, LIVE_TIMEOUT_MS);
});

/* ------------------------------------------------------- the anchor scan */

describe("rustTypeAnchorFor", () => {
  it("anchors a plain name on itself", () => {
    const source = "x.foo()";
    const range = rustTypeAnchorFor(source, 0, 1);
    expect(range && source.slice(range.start, range.end)).toBe("x");
  });

  it("anchors a field access on the field, not the value it is read off of", () => {
    const source = "self.cache";
    const range = rustTypeAnchorFor(source, 0, source.length);
    expect(range && source.slice(range.start, range.end)).toBe("cache");
  });

  it("anchors a nested field access on the last field in the chain", () => {
    const source = "self.holder.items";
    const range = rustTypeAnchorFor(source, 0, source.length);
    expect(range && source.slice(range.start, range.end)).toBe("items");
  });

  it("anchors a method-call chain on its last callee name, past the matching parens", () => {
    const source = "self.builder().step()";
    const range = rustTypeAnchorFor(source, 0, source.length);
    expect(range && source.slice(range.start, range.end)).toBe("step");
  });

  /*
   * The four shapes below are all withheld, and each for its own measured
   * reason -- not one rule applied four times.
   */

  it("withholds an associated-function call: rust-analyzer answers nothing at `make`", () => {
    const source = "Builder::make()";
    expect(rustTypeAnchorFor(source, 0, source.length)).toBeUndefined();
  });

  it("withholds a free-function call, the same shape without the path", () => {
    const source = "free_fn()";
    expect(rustTypeAnchorFor(source, 0, source.length)).toBeUndefined();
  });

  it("withholds a turbofish call, reaching the name before deciding it is a path call", () => {
    const source = "Vec::<u32>::new()";
    expect(rustTypeAnchorFor(source, 0, source.length)).toBeUndefined();
  });

  it("withholds a `?` receiver, where the answer would be Result rather than the unwrapped type", () => {
    // Measured: anchoring at `tryit` resolves to core's Result -- a confident
    // wrong file, which is worse than a refusal.
    const source = "w.tryit()?";
    expect(rustTypeAnchorFor(source, 0, source.length)).toBeUndefined();
  });

  it("withholds rather than guessing when the range ends in a subscript", () => {
    const source = "table[key]";
    expect(rustTypeAnchorFor(source, 0, source.length)).toBeUndefined();
  });

  it("withholds rather than guessing on unbalanced brackets", () => {
    const source = "foo(bar))";
    expect(rustTypeAnchorFor(source, 0, source.length)).toBeUndefined();
  });

  it("anchors past a reference and parens on the field itself", () => {
    const source = "(&w.inner)";
    // The range ends at `)`, whose match is the leading `(` -- there is no
    // callee name before it, so this withholds rather than anchoring on
    // nothing. The engine hands this shape over as a `not-a-name` receiver.
    expect(rustTypeAnchorFor(source, 0, source.length)).toBeUndefined();
  });

  it("anchors a plain field receiver written with a reference prefix", () => {
    const source = "w.inner";
    const range = rustTypeAnchorFor(source, 0, source.length);
    expect(range && source.slice(range.start, range.end)).toBe("inner");
  });
});

describe("rustMemberRangeAfter", () => {
  it("finds the method name in a plain x.foo() receiver", () => {
    const source = "        c.load()\n";
    const receiverEnd = source.indexOf("c") + 1;
    const range = rustMemberRangeAfter(source, receiverEnd, "load");
    expect(range && source.slice(range.start, range.end)).toBe("load");
  });

  it("finds the method name after a field receiver, self.cache.foo()", () => {
    const source = "        self.cache.evict()\n";
    const receiverEnd = source.indexOf("self.cache") + "self.cache".length;
    const range = rustMemberRangeAfter(source, receiverEnd, "evict");
    expect(range && source.slice(range.start, range.end)).toBe("evict");
  });

  it("tolerates whitespace and a newline around the dot, as a rustfmt'd chain has", () => {
    const source = "        items\n            .iter()\n";
    const receiverEnd = source.indexOf("items") + "items".length;
    const range = rustMemberRangeAfter(source, receiverEnd, "iter");
    expect(range && source.slice(range.start, range.end)).toBe("iter");
  });

  it("withholds a range rather than guessing when the shape does not match", () => {
    const source = "        c.load()\n";
    const receiverEnd = source.indexOf("c") + 1;
    expect(rustMemberRangeAfter(source, receiverEnd, "save")).toBeUndefined();
  });

  it("refuses a name that merely starts the same way", () => {
    // `.loader()` is not `.load()`, and a plain prefix test would take it.
    const source = "        c.loader()\n";
    const receiverEnd = source.indexOf("c") + 1;
    expect(rustMemberRangeAfter(source, receiverEnd, "load")).toBeUndefined();
  });

  it("takes a tuple-index callee, which is a real call rather than a mismatch", () => {
    // `x.0()` calls a closure held in a tuple field, so `0` genuinely is the
    // callee's own position. The shape is rare, not wrong -- an earlier draft
    // of this file asserted the opposite and the test caught it.
    const source = "        pair.0()\n";
    const receiverEnd = source.indexOf("pair") + "pair".length;
    const range = rustMemberRangeAfter(source, receiverEnd, "0");
    expect(range && source.slice(range.start, range.end)).toBe("0");
  });
});

describe("isOutsideRustTree", () => {
  it("counts the standard library as outside", () => {
    expect(isOutsideRustTree("/Users/x/.rustup/toolchains/stable/lib/rustlib/src/rust/library/core/src/option.rs", "/repo")).toBe(true);
  });

  it("counts a registry dependency as outside", () => {
    expect(isOutsideRustTree("/Users/x/.cargo/registry/src/index.crates.io-abc/serde-1.0/src/lib.rs", "/repo")).toBe(true);
  });

  it("counts a build script's generated output as outside, though it sits inside the tree", () => {
    // Rust's `node_modules` equivalent lives *in* the tree, which is the one
    // way this differs from `resolution-ts.ts`'s version.
    expect(isOutsideRustTree("/repo/target/debug/build/serde-123/out/private.rs", "/repo")).toBe(true);
  });

  it("counts a real module in the tree as inside", () => {
    expect(isOutsideRustTree("/repo/src/engine.rs", "/repo")).toBe(false);
  });
});
