#!/usr/bin/env node
/**
 * Record which of a repository's own routines called which, while that
 * repository's own test suite ran (#273).
 *
 *   npm run trace:reach -- --repo=pallets-flask
 *   npm run trace:reach -- --repo=nestjs-nest --out=/tmp/nest.json
 *   npm run trace:reach -- --repo=encode-httpx --no-install
 *
 * The output is the referee `measure:door-reach --trace=` scores the backward
 * walks against:
 *
 *   npm run measure:door-reach -- --only=nestjs-nest --trace=.probe/reach-nestjs-nest.json --no-checker
 *
 * **This script exists because the invocation was undocumented.** #270 scored
 * flask and httpx and recorded the result -- 0 false accusations in 90 (routine,
 * door) pairs -- but nothing recorded how the trace was produced.
 * `reach_trace.py` reads two environment variables and there was no script, no
 * npm target and no note, so the one number standing between this repository and
 * a false red could not be re-run by anybody, including its author. It
 * reproduces: flask 12 pairs and httpx 78, 55 -> 2 -> 0 down the three walks.
 *
 * ## What a referee is, here
 *
 * It shares no parse, no index and no name with the reader: Python's edges come
 * from `sys.setprofile`, TypeScript's from the real JS stack. That is the whole
 * of its value. It sees only the paths the tests ran, so it can find a false
 * accusation and can never show there are none -- **read its silence as
 * nothing.**
 *
 * ## Leaving the clone as it was found
 *
 * A corpus clone is pinned and a measurement must not edit it. Two suites here
 * write into their own working directory -- httpx's tests set `SSLKEYLOGFILE` to
 * the relative name `test` -- and httpx cannot run from anywhere else, because
 * it opens fixtures by relative path. So the working tree is compared before and
 * after, anything new is removed, and a modified tracked file stops the run
 * rather than being quietly reverted.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { sourceFiles } from "./lib/source-files";

import { LICENCES } from "../src/engine/licence";

const HOME = process.env.HOME ?? "/Users/noelmatero";
const argv = process.argv.slice(2);
const option = (name: string) => argv.find((one) => one.startsWith(`--${name}=`))?.slice(name.length + 3);
const noInstall = argv.includes("--no-install");
const requested = option("repo");

const CORPUS = existsSync(path.resolve(".corpus")) ? path.resolve(".corpus") : `${HOME}/board-ai/.corpus`;
const WORK = path.resolve(".probe/reach");

/** Where the hook's own record goes, written by `scripts/lib/reach_trace.py` and `reach-trace-node.mjs`. */
export interface Trace {
  root: string;
  testsCollected: number;
  testsFailed: number;
  edges: Array<[string, string, number, string, string, number, boolean, number]>;
}

/**
 * How one repository's suite is installed and run.
 *
 * Per repository rather than per language because each project pins its test
 * dependencies its own way, and a guess costs a session: flask locks with `uv`
 * and declares a `tests` group, httpx pins a `requirements.txt`, nestjs needs
 * `--legacy-peer-deps` because its own lock file disagrees with its
 * `package.json` about `@nestjs/apollo`.
 */
interface Recipe {
  /** The corpus directory name. */
  dir: string;
  language: "python" | "ts";
  /** Run once, in the clone, to get a runnable suite. */
  install: string[][];
  /** The suite, run in the clone. `{env}` entries are filled in per run. */
  test: string[];
  /** A vitest config in the clone to build on, for the TypeScript ones. */
  baseConfig?: string;
  /**
   * `REACH_SAMPLE`, for a suite whose own timeouts a hook on every call breaks.
   * Recording the first N entries of a routine and then one in M keeps the
   * distinct callers, which is all the score reads, and loses the counts.
   */
  sample?: string;
}

const RECIPES: Recipe[] = [
  {
    dir: "pallets-flask",
    language: "python",
    install: [["uv", "sync", "--frozen", "--group", "tests", "--no-dev"]],
    test: ["{python}", "-m", "pytest", "-p", "reach_trace", "-q"],
  },
  {
    dir: "encode-httpx",
    language: "python",
    install: [["uv", "venv", "{venv}", "--python", "3.13"], ["uv", "pip", "install", "--quiet", "-r", "requirements.txt"]],
    test: ["{python}", "-m", "pytest", "-p", "reach_trace", "-q"],
  },
  {
    /*
     * vue's projects say `extends: true`, so the plugin and the setup file added
     * to the root config reach all of them. `unit*` leaves out the two e2e
     * projects, one of which drives a real browser.
     */
    dir: "vuejs-core",
    language: "ts",
    install: [["npx", "--yes", "pnpm@11.19.0", "install", "--frozen-lockfile", "--ignore-scripts"]],
    test: ["npx", "vitest", "run", "--project", "unit*", "--config", "{config}",
      "--reporter=dot", "--reporter=json", "--outputFile.json={report}"],
    baseConfig: "vitest.config.ts",
    // Two of vue's scheduler tests queue hundreds of thousands of callbacks
    // inside a five-second timeout, and a stack capture on every one of them
    // times the test out.
    sample: "32,4096",
  },
  {
    /*
     * vite builds itself: its unit suite imports `vite/dist/node`, so an install
     * alone leaves every test file failing to resolve it.
     */
    dir: "vitejs-vite",
    language: "ts",
    install: [
      ["npx", "--yes", "pnpm@10.34.5", "install", "--frozen-lockfile", "--ignore-scripts"],
      ["npx", "--yes", "pnpm@10.34.5", "-r", "--filter=./packages/*", "run", "build"],
    ],
    test: ["npx", "vitest", "run", "--config", "{config}", "--reporter=dot", "--reporter=json", "--outputFile.json={report}"],
    baseConfig: "vitest.config.ts",
    sample: "32,4096",
  },
  {
    dir: "nestjs-nest",
    language: "ts",
    install: [["npm", "install", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund"]],
    test: ["npx", "vitest", "run", "--config", "{config}", "--reporter=dot", "--reporter=json", "--outputFile.json={report}"],
    baseConfig: "vitest.config.mts",
  },
];

/* -- the clone, pinned and left as it was found --------------------------- */

function pinnedCommit(dir: string): string | undefined {
  for (const licence of LICENCES) {
    for (const entry of licence.corpus) {
      const candidates = [entry.name.replace("/", "-"), entry.name.split("/").pop()!];
      if (candidates.includes(dir)) return entry.commit;
    }
  }
  return undefined;
}

const statusOf = (dir: string) => execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });

function restore(dir: string, before: string): void {
  const was = new Set(before.split("\n").filter(Boolean));
  const now = statusOf(dir).split("\n").filter(Boolean);
  for (const line of now) {
    if (was.has(line)) continue;
    const state = line.slice(0, 2);
    const file = line.slice(3).replace(/^"|"$/g, "");
    if (state !== "??") {
      throw new Error(`the run changed ${file}, a tracked file in ${dir} -- not reverting it, look at it first`);
    }
    rmSync(path.join(dir, file), { recursive: true, force: true });
    console.log(`  removed ${file}, which the suite wrote into the clone`);
  }
}

/* -- running one suite ---------------------------------------------------- */

function run(command: string[], options: { cwd: string; env: Record<string, string> }): number {
  const [program, ...rest] = command;
  console.log(`  $ ${command.join(" ")}`);
  const done = spawnSync(program!, rest, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (done.error) throw done.error;
  return done.status ?? 1;
}

/** `[python] -m pytest`, with its own environment outside the clone so the clone stays pinned. */
function tracePython(recipe: Recipe, dir: string, out: string): Trace {
  const venv = path.join(WORK, `${recipe.dir}-venv`);
  const python = path.join(venv, "bin", "python");
  if (!noInstall || !existsSync(python)) {
    for (const step of recipe.install) {
      const status = run(step.map((one) => one.replace("{venv}", venv)), {
        cwd: dir,
        env: { UV_PROJECT_ENVIRONMENT: venv, VIRTUAL_ENV: venv },
      });
      if (status !== 0) throw new Error(`install failed: ${step.join(" ")}`);
    }
  }
  const raw = path.join(WORK, `${recipe.dir}-raw.json`);
  const status = run(recipe.test.map((one) => one.replace("{python}", python)), {
    cwd: dir,
    env: { REACH_ROOT: dir, REACH_OUT: raw, PYTHONPATH: path.resolve("scripts/lib") },
  });
  if (!existsSync(raw)) throw new Error(`pytest exited ${status} and wrote no trace`);
  const trace = JSON.parse(readFileSync(raw, "utf8")) as Trace;
  writeFileSync(out, JSON.stringify(trace));
  return trace;
}

/**
 * `vitest run`, with the instrumenting plugin and the recording setup file
 * added to whatever config the repository already has.
 *
 * The config is written into the clone and deleted again, because a config
 * outside it resolves `vitest/config` and the repository's own config against
 * the wrong `node_modules`.
 */
function traceTypeScript(recipe: Recipe, dir: string, out: string): Trace {
  if (!noInstall && !existsSync(path.join(dir, "node_modules"))) {
    for (const step of recipe.install) {
      if (run(step, { cwd: dir, env: {} }) !== 0) throw new Error(`install failed: ${step.join(" ")}`);
    }
  }
  const parts = path.join(WORK, `${recipe.dir}-parts`);
  rmSync(parts, { recursive: true, force: true });
  mkdirSync(parts, { recursive: true });

  const config = path.join(dir, "vitest.reach.config.mts");
  const report = path.join(WORK, `${recipe.dir}-report.json`);
  const here = path.resolve("scripts/lib");
  /*
   * The recording setup file is copied into the clone rather than pointed at
   * where it lives. A setup file outside the project root is served over vite's
   * `/@fs/` path, and vue's jsdom project cannot resolve that: every one of its
   * 45 suites failed with `Cannot find module '/@fs/...'`.
   */
  const runtime = path.join(dir, "vitest.reach.runtime.mjs");
  copyFileSync(path.join(here, "reach-trace-node.mjs"), runtime);
  writeFileSync(config, `/* Written by scripts/trace-reach.mts (#273) and deleted again. */
import base from ${JSON.stringify(`./${recipe.baseConfig}`)};

import { reachTrace } from ${JSON.stringify(`${here}/reach-trace-plugin.mjs`)};

const resolved = typeof base === "function" ? base({ command: "serve", mode: "test" }) : base;

export default {
  ...resolved,
  plugins: [...(resolved.plugins ?? []), reachTrace({ root: ${JSON.stringify(dir)}, skip: ["vitest.reach.runtime.mjs"] })],
  test: {
    ...resolved.test,
    setupFiles: [...[resolved.test?.setupFiles ?? []].flat(), ${JSON.stringify("./vitest.reach.runtime.mjs")}],
  },
};
`);

  let status: number;
  try {
    status = run(recipe.test.map((one) => one.replace("{config}", config).replace("{report}", report)), {
      cwd: dir,
      env: { REACH_ROOT: dir, REACH_OUT_DIR: parts, ...(recipe.sample ? { REACH_SAMPLE: recipe.sample } : {}) },
    });
  } finally {
    rmSync(config, { force: true });
    rmSync(runtime, { force: true });
  }

  const written = readdirSync(parts).filter((one) => one.startsWith("part-"));
  if (written.length === 0) throw new Error(`vitest exited ${status} and no worker recorded anything`);

  const edges = new Map<string, number>();
  const loaded = new Set<string>();
  let dropped = 0;
  let root = "";
  for (const one of written) {
    const part = JSON.parse(readFileSync(path.join(parts, one), "utf8")) as
      { root: string; files: string[]; dropped: number; edges: Trace["edges"] };
    root = part.root;
    dropped += part.dropped;
    for (const file of part.files) loaded.add(file);
    for (const edge of part.edges) {
      const key = JSON.stringify(edge.slice(0, 7));
      edges.set(key, (edges.get(key) ?? 0) + edge[7]);
    }
  }

  /*
   * Two kinds of red, and only one of them invalidates the record.
   *
   * A file that failed to **collect** reports no tests rather than a failure, so
   * the run exits 0 and the trace silently holds a fraction of the code. That is
   * the shape of zero `AGENTS.md` warns about and it happened here: 45 of vite's
   * 67 suites would not parse, and the first score was read off the 22 that did.
   * Those stop the run.
   *
   * A test that ran and **failed on its own timing** is a different thing. A
   * hook on every call costs time, so a suite asserting how fast it is goes red
   * without anything being wrong with the record: vue's deeply-chained computed
   * test allows itself 30ms and takes 48. Those are named and the run goes on,
   * because the edges that file produced are real.
   */
  const suite = JSON.parse(readFileSync(report, "utf8")) as {
    numTotalTests: number; numFailedTests: number; numTotalTestSuites: number;
    testResults: Array<{ name: string; assertionResults?: Array<{ status: string; fullName: string }> }>;
  };
  const uncollected = suite.testResults.filter((one) => (one.assertionResults ?? []).length === 0);
  if (uncollected.length > 0) {
    throw new Error(`${uncollected.length} of ${suite.testResults.length} test files collected no tests -- `
      + `a trace off a suite that did not run is a floor nobody can read. First: ${uncollected[0]!.name}`);
  }
  const failures = suite.testResults.flatMap((one) =>
    (one.assertionResults ?? []).filter((each) => each.status === "failed")
      .map((each) => `${path.relative(dir, one.name)} > ${each.fullName}`));
  if (failures.length > 0) {
    console.log(`  ${failures.length} of ${suite.numTotalTests} tests failed under the hook, `
      + "which slows every call down. Each one is a test about its own speed unless it says otherwise:");
    for (const one of failures) console.log(`      ${one}`);
  }
  const trace: Trace = {
    root,
    testsCollected: suite.numTotalTests,
    testsFailed: suite.numFailedTests,
    edges: [...edges].map(([key, count]) => [...JSON.parse(key), count] as Trace["edges"][number]),
  };
  writeFileSync(out, JSON.stringify(trace));
  console.log(`  ${written.length} worker records, ${loaded.size} source files loaded, ${dropped} hook entries with no caller on the stack`);
  return trace;
}

/* -- the run -------------------------------------------------------------- */

const recipe = RECIPES.find((one) => one.dir === requested);
if (!recipe) {
  console.log(`--repo= one of: ${RECIPES.map((one) => one.dir).join(", ")}`);
  process.exit(1);
}

const dir = realpathSync(path.join(CORPUS, recipe.dir));
const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const pinned = pinnedCommit(recipe.dir);
console.log(`${recipe.dir}: ${head === pinned ? "pinned" : `AT ${head}, NOT the pinned ${pinned}`}`);

mkdirSync(WORK, { recursive: true });
const out = option("out") ?? path.join(WORK, `${recipe.dir}.json`);
const before = statusOf(dir);

let trace: Trace;
try {
  trace = recipe.language === "python" ? tracePython(recipe, dir, out) : traceTypeScript(recipe, dir, out);
} finally {
  restore(dir, before);
}

/* -- what it saw, and what share of the repository that is ---------------- */

const seen = new Set<string>();
for (const [fromFile, , , toFile] of trace.edges) { seen.add(fromFile); seen.add(toFile); }
const total = sourceFiles(dir).length;

console.log();
console.log(`  ${trace.testsCollected} tests collected, ${trace.testsFailed} failed`);
console.log(`  ${trace.edges.length} edges between its own routines, ${trace.edges.filter((one) => one[6]).length} through code that is not`);
console.log(`  ${seen.size} of ${total} source files appear in it (${((seen.size / total) * 100).toFixed(1)}%)`);
console.log(`  written to ${out}`);
console.log();
console.log("  A trace is a floor. It saw the paths these tests ran and no others, so it can");
console.log("  find a false accusation and can never show there are none.");
