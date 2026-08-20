#!/usr/bin/env node

/**
 * Refresh the code graph after a commit.
 *
 * Runs graphify (code-only, local, ~5s) to precompute the whole-repo code
 * graph, then writes a sidecar naming the commit and graphify version, which
 * is what lets the checker trust the graph later.
 *
 * Installed as a post-commit hook by scripts/install-hooks.mjs. It must never
 * block or fail a commit: no graphify, a failed extraction, no git -- all of
 * it exits 0 quietly, and the checker simply sees no graph.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const run = (command, args) =>
  spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

// One probe answers both questions: is graphify installed, and which version.
// The output looks like "graphify 0.9.47"; the sidecar stores the bare number,
// which is what the checker's version gate compares against.
const probe = run("graphify", ["--version"]);
const version = probe.status === 0 ? /(\d+\.\d+\.\d+)/.exec(probe.stdout ?? "")?.[1] : undefined;
if (!version) process.exit(0);

const extract = run("graphify", ["extract", ".", "--code-only"]);
if (extract.status !== 0) process.exit(0);

const commit = run("git", ["rev-parse", "HEAD"]);
if (commit.status !== 0) process.exit(0);

try {
  writeFileSync(
    join(root, "graphify-out", "code-graph-meta.json"),
    `${JSON.stringify({ commit: commit.stdout.trim(), graphify: version }, null, 2)}\n`,
  );
} catch {
  // A tree we cannot write to: the checker sees no sidecar and stays silent.
}

process.exit(0);
