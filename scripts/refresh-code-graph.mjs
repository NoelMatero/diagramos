#!/usr/bin/env node

/**
 * Refresh the code graph after a commit.
 *
 * Installed as a post-commit hook by scripts/install-hooks.mjs, which runs from
 * `prepare` -- so this is the path in the repo that develops this tool, where a
 * commit is the natural moment to spend a few seconds.
 *
 * It is no longer the only path. `prepare` never runs for a project that merely
 * installs the tool, so the check builds the graph itself when it finds one
 * missing or stale (#132). Both go through scripts/lib/code-graph.mjs; the
 * difference is only when. Keeping the hook means a commit-time build stays
 * ahead of the next check, which is the better steady state where it is wired.
 *
 * It must never block or fail a commit: no graphify, a failed extraction, no
 * git -- all of it exits 0 quietly, and the checker simply sees no graph.
 */

import { buildCodeGraph } from "./lib/code-graph.mjs";

buildCodeGraph(process.cwd());
process.exit(0);
