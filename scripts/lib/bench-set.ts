/**
 * Which planted-mistake set a bench script reads: the main one in `bench/`, or
 * a holdout -- `holdout` in `bench-holdout/`, `holdout-b` in
 * `bench-holdout-b/`, and so on, each with its clones in
 * `~/.board-ai-<set>/corpus`.
 *
 *   npm run bench:planted -- --set=holdout
 *   BENCH_SET=holdout-b sh scripts/bench-planted-draw.sh 0
 *
 * The holdout is the same machinery -- scopes, Haiku-drawn boards, the answer
 * key, planted mistakes, the projects' own libraries -- over projects nobody
 * has tuned the checker on. Its clones live outside this repository
 * (`~/.board-ai-holdout/corpus` unless `CORPUS` says otherwise), so no
 * `measure:* .corpus/*` run can ever read them into a licence.
 *
 * Read from the command line rather than passed in, because every bench
 * module's paths are fixed when it is imported, before a script parses its
 * own flags. `bench:planted:runs` passes the flag through to each project.
 */
import os from "node:os";
import path from "node:path";

const named = process.argv.find((one) => one.startsWith("--set="))?.slice("--set=".length) ?? process.env.BENCH_SET;
if (named !== undefined && named !== "main" && !/^holdout(-[a-z])?$/.test(named)) {
  throw new Error(`--set=${named}: the sets are main, holdout, and holdout-<letter>`);
}

/** The holdout set's name, or undefined on the main set. */
export const SET = named === undefined || named === "main" ? undefined : named;
export const HOLDOUT = SET !== undefined;
/** The folder under the repository holding the set's scopes, boards, keys and library pins. */
export const BENCH_DIR = SET ? `bench-${SET}` : "bench";
/** Where the set's pinned clones are. */
export const CORPUS = process.env.CORPUS
  ?? (SET ? path.join(os.homedir(), `.board-ai-${SET}/corpus`) : "/Users/noelmatero/board-ai/.corpus");

export interface HoldoutProject {
  project: string;
  language: "ts" | "python" | "rust";
  repo: string;
  pin: string;
  why: string;
  /** For a TypeScript project, the command that installs its packages in a checkout of the pin. */
  install?: string[];
}
