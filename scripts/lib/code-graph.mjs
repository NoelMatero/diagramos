/**
 * Building the code graph: the one place that knows how.
 *
 * The graph is what lets the arrow check read ~40 languages instead of two,
 * and it takes seconds to build. It used to be built in exactly one place --
 * a post-commit hook installed by `npm prepare` -- which meant it was built
 * in the repo that develops this tool and nowhere else. `prepare` does not run
 * for a consumer: the tool arrives as a plugin-marketplace clone plus `npx`,
 * and neither path triggers it. So the project that most needed the graph was
 * the one project that never got one (#132).
 *
 * Both callers now come through here: the post-commit hook, and the check
 * itself when it finds the graph missing or a commit behind.
 *
 * Plain `.mjs` rather than TypeScript because one of those callers is a git
 * hook running under bare `node`, with no loader to compile anything.
 *
 * Nothing here may fail its caller. A commit must not be blocked, and a drift
 * check must not report a problem it invented: no graphify, no git, a failed
 * extraction, a tree we cannot write to -- all of it returns undefined, and
 * the check then behaves exactly as it does with no graph at all.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The PyPI name. The command it installs is `graphify`, without the third y. */
export const PACKAGE = "graphifyy";

/**
 * Python tool installers we know how to drive, in the order we prefer them.
 *
 * Shared with scripts/ensure-graphify.mjs on purpose: the installer that runs
 * and the sentence the check prints when graphify is missing have to name the
 * same command, or one of them is lying.
 */
export const INSTALLERS = [
  { command: "uv", args: ["tool", "install", PACKAGE], hint: `uv tool install ${PACKAGE}` },
  { command: "pipx", args: ["install", PACKAGE], hint: `pipx install ${PACKAGE}` },
];

/** Where graphify writes, and where we record what it read. */
const OUT_DIR = "graphify-out";
const GRAPH_FILE = "graph.json";
/** Read back by src/engine/codegraph.ts, which is the only reader. */
const SIDECAR_FILE = "code-graph-meta.json";

const run = (command, args, { cwd, timeout } = {}) =>
  spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout,
  });

/** Whether a command exists and answers, which is all "installed" can mean here. */
const answers = (command) => run(command, ["--version"], { timeout: 20_000 }).status === 0;

/**
 * The graphify version on this machine, or undefined when there is none.
 *
 * One probe answers both questions -- is it installed, which version -- and
 * the version is what the checker's gate compares against, so it is stored
 * rather than thrown away.
 */
export function graphifyVersion() {
  const probe = run("graphify", ["--version"], { timeout: 20_000 });
  if (probe.status !== 0) return undefined;
  return /(\d+\.\d+\.\d+)/.exec(probe.stdout ?? "")?.[1];
}

/** The first Python tool installer this machine has, if any. */
export function findInstaller() {
  return INSTALLERS.find((candidate) => answers(candidate.command));
}

/** This repo's HEAD, or undefined outside a repo -- or in one with no commits. */
export function headCommit(root) {
  const commit = run("git", ["rev-parse", "HEAD"], { cwd: root });
  if (commit.status !== 0) return undefined;
  const value = commit.stdout.trim();
  return /^[0-9a-f]{7,40}$/.test(value) ? value : undefined;
}

/**
 * Whether a graph exists here and describes the current commit.
 *
 * Only these two questions, and both are cheap: a file test and a small JSON
 * read. Whether the graph *parses*, and whether its graphify version is one we
 * trust, is the reader's business (src/engine/codegraph.ts) -- asking here
 * would mean parsing a megabyte of JSON to decide whether to build.
 *
 * Working-tree edits deliberately do not count as stale. The reader already
 * falls back to the live channels for any file touched since the graph was
 * built, so an uncommitted edit costs a little coverage and no correctness --
 * whereas rebuilding on every edit would mean rebuilding on every turn.
 */
export function codeGraphIsCurrent(root, commit) {
  try {
    if (!existsSync(path.join(root, OUT_DIR, GRAPH_FILE))) return false;
    const meta = JSON.parse(readFileSync(path.join(root, OUT_DIR, SIDECAR_FILE), "utf8"));
    return typeof meta.commit === "string" && meta.commit === commit;
  } catch {
    // No sidecar, or one we cannot read: treat the graph as absent.
    return false;
  }
}

/**
 * Build the graph for this repo and record what it describes.
 *
 * Returns `{ commit, version, seconds }` on success and undefined on every
 * failure, silently.
 *
 * HEAD is read *before* the extraction, not after. If a commit lands while
 * graphify is reading, the sidecar then names an older commit than the tree
 * that was read -- which errs the safe way: the reader treats everything
 * changed since that commit as modified and falls back to the live channels.
 * Naming a newer commit would do the opposite, and let a stale graph confirm
 * an arrow that had just been removed.
 *
 * `versionPrefix` is the caller saying which graphify releases its reader will
 * accept. A graph the reader would refuse is worth nothing, and finding that
 * out from a `--version` costs milliseconds against seconds of extraction.
 */
export function buildCodeGraph(root, { timeout = 120_000, versionPrefix } = {}) {
  const version = graphifyVersion();
  if (!version) return undefined;
  if (versionPrefix && !version.startsWith(versionPrefix)) return undefined;
  // No git means no way to say what the graph describes, and a graph nobody
  // can date is a graph the reader refuses. Cheaper to find out now than after
  // an extraction.
  const commit = headCommit(root);
  if (!commit) return undefined;

  const started = process.hrtime.bigint();
  const extract = run("graphify", ["extract", ".", "--code-only"], { cwd: root, timeout });
  if (extract.status !== 0) return undefined;
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;

  try {
    mkdirSync(path.join(root, OUT_DIR), { recursive: true });
    writeFileSync(
      path.join(root, OUT_DIR, SIDECAR_FILE),
      `${JSON.stringify({ commit, graphify: version }, null, 2)}\n`,
    );
    ignoreOurOwnOutput(root);
  } catch {
    // A tree we cannot write to: the reader sees no sidecar and stays silent.
    return undefined;
  }
  return { commit, version, seconds };
}

/**
 * Mark the output directory as ours, so it never shows up as somebody's
 * uncommitted work.
 *
 * The check now builds the graph in projects that only installed this tool, and
 * those projects never asked for a `graphify-out/` in their `git status` -- or
 * in a commit, which is where a megabyte of derived JSON would otherwise end
 * up. A `.gitignore` holding `*` ignores the directory's contents *and*
 * itself, which makes the whole thing invisible to git without editing a line
 * of anybody's own `.gitignore`. This repository ignores the directory the
 * ordinary way too; writing it twice costs nothing.
 */
function ignoreOurOwnOutput(root) {
  const marker = path.join(root, OUT_DIR, ".gitignore");
  if (!existsSync(marker)) writeFileSync(marker, "*\n");
}
