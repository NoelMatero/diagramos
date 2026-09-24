/**
 * Building the Rust compiler's call lists, for `@calls` (#357).
 *
 * `compiled-calls.ts` reads a dump; this gets one. `cargo rustc --lib --
 * --emit=mir` builds the crate a board's Rust routine is in and prints every
 * body after macro expansion. It works on stable, offline, with nothing the
 * machine does not already have if it can build the crate at all.
 *
 * ## What it costs, and who pays
 *
 * A build. #355 timed the five pinned Rust repositories at 0.1-3.7s each from
 * cold, dependencies included, and a warm rebuild of one crate at about 2s.
 * A large workspace can take minutes cold, and a check runs every turn, so a
 * build never holds a check up past its budget: it is started detached, the
 * check waits for it until the deadline `referee-live.ts` already keeps, and a
 * build still running then finishes on its own. The next check reads it. Until
 * then those arrows get the text reading, which is what they got before this
 * existed -- losing a catch, never gaining an accusation.
 *
 * ## What it touches
 *
 * - **Its own target directory**, under `~/.diagramos/rustc`, one per cargo
 *   workspace. Never the repository's `target/`: a build of ours must not
 *   invalidate or race the person's own.
 * - **Build scripts and proc macros** of the crate and its dependencies run,
 *   as they do for any build. rust-analyzer runs them too, and has since #342,
 *   so this is not a new trust boundary -- but it is one, and it is stated.
 * - **The network, never.** `--offline`: dependencies not already fetched are
 *   no answer, not a download and not a hang.
 *
 * ## When the dump is stale
 *
 * Every `.rs` file under the package, its `Cargo.toml` and the workspace's
 * `Cargo.lock`, by size and modification time, taken when the build starts.
 * An edit during the build makes the result stale on arrival, and it is
 * rebuilt next time rather than read. A build that failed is remembered
 * against the same inputs, so a crate that does not build is not rebuilt on
 * every check.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readCompiledCrate, type CompiledCrate } from "./compiled-calls";

/** Where builds and dumps live. `DIAGRAMOS_RUSTC_CACHE` moves it, for tests. */
export function rustcCacheDir(): string {
  return process.env.DIAGRAMOS_RUSTC_CACHE ?? path.join(os.homedir(), ".diagramos", "rustc");
}

/** Crates by repo-relative file, for the files one check asked about. */
export interface CompiledCrates {
  crateOf(file: string): CompiledCrate | undefined;
  /** Whether any crate was read, so a board can say what checked it. */
  answered: boolean;
}

export interface CompileOptions {
  /** Epoch ms past which nothing is waited for. A build still running keeps running. */
  until: number;
  /** Overrides `rustcCacheDir()`. */
  cacheDir?: string;
}

const NONE: CompiledCrates = { crateOf: () => undefined, answered: false };

/** Why a directory walk stops: a build's output, a dependency's tree, a VCS's. */
const SKIP = new Set(["target", "node_modules", ".git"]);

/**
 * The compiled crate for each of `files` (repo-relative, under `root`) that
 * one can be had for by `options.until`.
 *
 * Never throws and never waits past the deadline. Anything short of a fresh
 * dump -- no cargo, no `Cargo.toml`, a binary-only package, a build that
 * failed or has not finished -- is a file this answers nothing about.
 */
export async function compileCrates(
  root: string,
  files: readonly string[],
  options: CompileOptions,
): Promise<CompiledCrates> {
  if (process.platform === "win32" || files.length === 0) return NONE;
  const cache = options.cacheDir ?? rustcCacheDir();

  const byManifest = new Map<string, string[]>();
  for (const file of files) {
    const manifest = manifestOf(path.resolve(root, file), root);
    if (manifest) byManifest.set(manifest, [...(byManifest.get(manifest) ?? []), file]);
  }

  const found = new Map<string, CompiledCrate>();
  await Promise.all([...byManifest].map(async ([manifest, owned]) => {
    const crate = await crateFor(manifest, root, cache, options.until);
    if (crate) for (const file of owned) found.set(file, crate);
  }));
  if (found.size === 0) return NONE;
  return { crateOf: (file) => found.get(file), answered: true };
}

/** The nearest `Cargo.toml` above a file, without leaving the repository. */
function manifestOf(file: string, root: string): string | undefined {
  const top = path.resolve(root);
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    const manifest = path.join(directory, "Cargo.toml");
    if (existsSync(manifest)) return manifest;
    if (directory === top || path.dirname(directory) === directory) return undefined;
  }
}

/** What `cargo metadata` says about the package a manifest declares. */
interface Package {
  workspace: string;
  /** The library target's root file, absolute. Absent for a binary-only package. */
  lib?: string;
}

const packages = new Map<string, { stamp: string; package: Package | undefined }>();

function packageOf(manifest: string): Package | undefined {
  const stamp = statStamp(manifest);
  const known = packages.get(manifest);
  if (known && known.stamp === stamp) return known.package;
  const ran = spawnSync("cargo", ["metadata", "--no-deps", "--offline", "--format-version", "1", "--manifest-path", manifest], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, CARGO_NET_OFFLINE: "true" },
  });
  let found: Package | undefined;
  if (ran.status === 0) {
    try {
      const metadata = JSON.parse(ran.stdout) as {
        workspace_root: string;
        packages: Array<{ manifest_path: string; targets: Array<{ kind: string[]; src_path: string }> }>;
      };
      const own = metadata.packages.find((one) => path.resolve(one.manifest_path) === path.resolve(manifest));
      const lib = own?.targets.find((target) => target.kind.some((kind) => /lib|proc-macro/.test(kind)));
      if (own) found = { workspace: metadata.workspace_root, ...(lib ? { lib: lib.src_path } : {}) };
    } catch {
      found = undefined;
    }
  }
  packages.set(manifest, { stamp, package: found });
  return found;
}

/** Parsed dumps, by dump path and its modification time: a 3 MB dump is worth reading once. */
const parsed = new Map<string, { stamp: string; crate: CompiledCrate }>();

async function crateFor(manifest: string, root: string, cache: string, until: number): Promise<CompiledCrate | undefined> {
  const found = packageOf(manifest);
  if (!found?.lib) return undefined;
  const lib = found.lib;

  const key = hash(manifest);
  const directory = path.join(cache, key);
  mkdirSync(directory, { recursive: true });
  const dump = path.join(directory, "calls.mir");
  const depInfo = path.join(directory, "calls.d");
  const stampFile = path.join(directory, "stamp.json");
  const failedFile = path.join(directory, "failed.json");
  const lock = path.join(directory, "building");

  const inputs = inputsOf(path.dirname(manifest), found.workspace);
  const read = (): CompiledCrate | undefined => {
    if (readText(stampFile) !== inputs || !existsSync(dump) || !existsSync(depInfo)) return undefined;
    const stamp = statStamp(dump);
    const known = parsed.get(dump);
    if (known && known.stamp === stamp) return known.crate;
    const crate = readCompiledCrate(readFileSync(dump, "utf8"), readFileSync(depInfo, "utf8"), {
      workspace: found.workspace,
      repo: path.resolve(root),
      root: lib,
    });
    parsed.set(dump, { stamp, crate });
    return crate;
  };

  const ready = read();
  if (ready) return ready;
  if (readText(failedFile) === inputs) return undefined;
  if (!building(lock)) start(manifest, found.workspace, directory, inputs, lock);

  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const crate = read();
    if (crate) return crate;
    if (!building(lock)) return read();
  }
  return undefined;
}

/**
 * Start the build, detached, so it outlives this check if it has to.
 *
 * The shell script moves the dump into place and writes the stamp only on
 * success, and removes the lock either way; nothing in this process has to be
 * alive at the end for the result to be usable.
 *
 * `--cfg diagramos_calls="<nonce>"` is there because cargo skips a crate whose
 * inputs and flags have not changed, and a skipped crate writes no dump. The
 * nonce changes the flags. An unknown `cfg` name that nothing tests is inert.
 * `-C opt-level=0` because a profile that optimises may inline a call away,
 * and a call that is not in the list is exactly the mistake this cannot make.
 */
function start(manifest: string, workspace: string, directory: string, inputs: string, lock: string): void {
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  const target = path.join(path.dirname(directory), `target-${hash(workspace)}`);
  const partialDump = path.join(directory, "calls.mir.partial");
  const partialDeps = path.join(directory, "calls.d.partial");
  const next = path.join(directory, "stamp.next");
  writeFileSync(next, inputs);
  const nonce = `${Date.now()}`;
  const cargo = [
    "cargo", "rustc", "--lib", "--offline", "--quiet",
    "--manifest-path", quote(manifest),
    "--target-dir", quote(target),
    "--",
    `--emit=mir=${quote(partialDump)},dep-info=${quote(partialDeps)}`,
    "-C", "opt-level=0",
    "--cfg", quote(`diagramos_calls="${nonce}"`),
  ].join(" ");
  const script = [
    `if ${cargo} > ${quote(path.join(directory, "build.log"))} 2>&1;`,
    `then mv ${quote(partialDump)} ${quote(path.join(directory, "calls.mir"))}`,
    `&& mv ${quote(partialDeps)} ${quote(path.join(directory, "calls.d"))}`,
    `&& mv ${quote(next)} ${quote(path.join(directory, "stamp.json"))};`,
    `else mv ${quote(next)} ${quote(path.join(directory, "failed.json"))}; fi;`,
    `rm -f ${quote(lock)}`,
  ].join(" ");
  try {
    const child = spawn("sh", ["-c", script], {
      cwd: workspace,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, CARGO_NET_OFFLINE: "true", CARGO_TERM_COLOR: "never" },
    });
    child.on("error", () => {});
    if (child.pid !== undefined) writeFileSync(lock, `${child.pid}`);
    child.unref();
  } catch {
    // No shell: no answer, the same as no cargo.
  }
}

/** Whether the lock names a process that is still running. */
function building(lock: string): boolean {
  const pid = Number(readText(lock));
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The files a dump depends on, as one string: every `.rs` under the package,
 * its manifest, and the workspace's lockfile, each by size and mtime.
 */
function inputsOf(packageDirectory: string, workspace: string): string {
  const rows: string[] = [];
  const walk = (directory: string) => {
    let entries: string[];
    try { entries = readdirSync(directory); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith(".") || SKIP.has(entry)) continue;
      const full = path.join(directory, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) walk(full);
      else if (entry.endsWith(".rs")) rows.push(`${full}:${stat.size}:${stat.mtimeMs}`);
    }
  };
  walk(packageDirectory);
  rows.sort();
  rows.push(`${path.join(packageDirectory, "Cargo.toml")}:${statStamp(path.join(packageDirectory, "Cargo.toml"))}`);
  rows.push(`${path.join(workspace, "Cargo.lock")}:${statStamp(path.join(workspace, "Cargo.lock"))}`);
  return hash(rows.join("\n"));
}

function statStamp(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "absent";
  }
}

function readText(file: string): string | undefined {
  try { return readFileSync(file, "utf8"); } catch { return undefined; }
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}
