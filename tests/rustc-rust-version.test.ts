/**
 * A crate that declares a newer `rust-version` than the toolchain is built
 * anyway (#366, section 7).
 *
 * ripgrep's `searcher`, `printer`, `cli` and four more declare
 * `rust-version = "1.96"`. On 1.93 cargo refused to build them, so the
 * compiler's call list (#357) and the "makes" check (#365) had nothing to
 * read there. `--ignore-rust-version` builds all seven in 16 s on 1.93; a
 * crate that truly needs a newer compiler still fails and stays unread, which
 * is the safe direction.
 *
 * A failure is remembered against the crate's inputs so it is not rebuilt on
 * every check -- and the build command is one of those inputs now, or every
 * machine that already tried ripgrep would keep the old failure until
 * somebody edited ripgrep.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { compileCrates } from "../src/engine/referee-rustc";

const HAS_CARGO = spawnSync("cargo", ["--version"]).status === 0;

beforeAll(async () => { await initEngine(); }, 60_000);

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A one-crate package outside the worktree, and a cache of its own. */
function crate(manifestExtra: string, lib: string): { repo: string; cache: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "rust-version-"));
  const cache = mkdtempSync(path.join(tmpdir(), "rustc-cache-"));
  dirs.push(repo, cache);
  writeFileSync(path.join(repo, "Cargo.toml"),
    `[package]\nname = "newer"\nversion = "0.1.0"\nedition = "2021"\n${manifestExtra}`);
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src/lib.rs"), lib);
  return { repo, cache };
}

async function compiled(repo: string, cache: string): Promise<boolean> {
  const crates = await compileCrates(repo, ["src/lib.rs"], { until: Date.now() + 120_000, cacheDir: cache });
  return crates.crateOf("src/lib.rs") !== undefined;
}

const LIB = "pub fn helper() -> u8 {\n    1\n}\n";

describe.skipIf(!HAS_CARGO)("a crate that asks for a newer Rust than this one", () => {
  it("is built anyway", async () => {
    const { repo, cache } = crate('rust-version = "1.999"\n', LIB);
    expect(await compiled(repo, cache)).toBe(true);
  }, 180_000);

  it("is built again when it was remembered as failed under the old build command", async () => {
    const { repo, cache } = crate('rust-version = "1.999"\n', LIB);
    /*
     * What a machine that ran the old command has on disk: `failed.json` holding
     * the inputs stamp as it was computed then -- every `.rs` file, the
     * manifest and the lockfile, by size and mtime, and nothing about the
     * command.
     */
    const manifest = path.join(repo, "Cargo.toml");
    const sha = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);
    const stat = (file: string) => {
      try { const one = statSync(file); return `${one.size}:${one.mtimeMs}`; } catch { return "absent"; }
    };
    const rows = readdirSync(path.join(repo, "src")).map((name) => {
      const full = path.join(repo, "src", name);
      const one = statSync(full);
      return `${full}:${one.size}:${one.mtimeMs}`;
    }).sort();
    rows.push(`${manifest}:${stat(manifest)}`, `${path.join(repo, "Cargo.lock")}:${stat(path.join(repo, "Cargo.lock"))}`);
    const directory = path.join(cache, sha(manifest));
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "failed.json"), sha(rows.join("\n")));

    expect(await compiled(repo, cache)).toBe(true);
  }, 180_000);

  it("still fails, and is remembered, when it does not compile", async () => {
    const { repo, cache } = crate('rust-version = "1.999"\n', "pub fn broken() -> u8 {\n    not_a_value\n}\n");
    expect(await compiled(repo, cache)).toBe(false);
    const [key] = readdirSync(cache).filter((name) => !name.startsWith("target-"));
    expect(existsSync(path.join(cache, key!, "failed.json"))).toBe(true);
    // Remembered: the second ask starts no build and answers at once.
    const started = Date.now();
    expect(await compiled(repo, cache)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 180_000);
});
