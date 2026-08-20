#!/usr/bin/env node

/**
 * Refresh the code graph: run graphify at commit time to precompute
 * the whole-repo code graph, and write a sidecar with the commit hash
 * and graphify version for freshness checks at check time.
 *
 * Run post-commit via git hook. Exit 0 always (never blocks a commit).
 * Exit 0 silently if graphify is not on PATH.
 */

import { execSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();
const graphifyOutDir = join(cwd, "graphify-out");

// Check if graphify is available
const which = spawnSync("which", ["graphify"], { stdio: "pipe", encoding: "utf-8" });
if (which.status !== 0) {
  // Graphify not installed, exit silently
  process.exit(0);
}

try {
  // Run graphify extract (writes graphify-out/graph.json)
  execSync("graphify extract . --code-only", {
    cwd,
    stdio: "inherit", // Show output to user during commit
  });

  // Get graphify version
  const versionOutput = spawnSync("graphify", ["--version"], {
    encoding: "utf-8",
  });
  const version = versionOutput.stdout.trim();

  // Get current commit
  const commit = execSync("git rev-parse HEAD", {
    cwd,
    encoding: "utf-8",
  }).trim();

  // Write sidecar metadata
  const metadata = {
    commit,
    graphify: version,
  };

  writeFileSync(
    join(graphifyOutDir, "code-graph-meta.json"),
    JSON.stringify(metadata, null, 2) + "\n",
  );
} catch (error) {
  // Silently ignore errors. Graphify extraction is not critical to the commit.
  // If it fails, the next check will see a missing or stale graph and skip the channel.
}

process.exit(0);
