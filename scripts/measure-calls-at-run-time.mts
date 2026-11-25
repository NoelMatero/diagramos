#!/usr/bin/env node
/**
 * Is a call that really happens ever called wrong? The referee is the Python
 * interpreter, while each project's own tests run (calls research 2026-11).
 *
 *   npm run measure:calls-at-run-time
 *   ... --projects=Textualize-rich,pallets-flask   only these
 *   ... --names=qualified    draw a method as `file#Class.method` (default: `file#method`, as the research did)
 *   ... --out=<file.jsonl>   every arrow and its verdict, one line each, to compare two runs
 *   ... --fresh              record again even when a recording of this clone is kept
 *
 * Each set's projects are read where `bench:planted --set=<set>` reads them, so a
 * worktree needs that set's folder (`bench-holdout-b/` is not on main: copy it in).
 *
 * ## Why this referee
 *
 * `measure:compiler-true` takes its true arrows from the compilers, and every
 * one of them writes the far end's name at the call. A rule about a function
 * that is handed around, stored or found by dispatch cannot be tested on that
 * population: nothing in it is a callback. Here the true arrows are calls the
 * interpreter made -- `sys.monitoring` hands over the function object at every
 * call, so a callback, a stored function and a method found by dispatch are
 * each seen as what they are (`scripts/lib/calls_at_run_time.py`). It shares
 * no parse, no index and no name with the checker.
 *
 * It sees only what the tests ran, so it can find a false accusation and can
 * never show there are none.
 *
 * ## What is checked
 *
 * Every pair "T calls H" recorded between two functions of the project -- not
 * a test, a doc, an example or a script -- drawn as one arrow and checked the
 * way `bench:planted` checks a claim (`scripts/lib/true-calls-check.ts`). A
 * call made by a function nested in T counts as T's, as the checker reads it.
 * A class called is its `__init__`. Each pair says whether H's name is written
 * at the call (`written`), because the unwritten ones are the population this
 * referee exists for.
 *
 * **Every pair is true, so the reds must be 0.** Reds are the finding and are
 * printed; they do not fail the run. It exits 1 only when it could not
 * measure: a project whose tests recorded nothing, or no pairs at all.
 *
 * ## Leaving the clones as they were found
 *
 * A project's tests run in a copy of its clone, under a cache folder
 * (`CALLS_AT_RUN_TIME_CACHE`, default `~/.board-ai-rt`), with the test
 * dependencies pinned in `scripts/lib/calls-at-run-time.requirements.txt`
 * installed there with `uv` (the network, once). The project's own libraries
 * are `bench:libraries`' venvs. A recording is kept per clone commit and
 * recorder, so a second run only checks.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((one) => one.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = flag("one");
const qualified = flag("names") === "qualified";

/** The projects whose tests run here, with where their source and tests are. httpx and black recorded nothing in 2026-11. */
const PROJECTS: Array<{ project: string; set: string; src: string; tests: string }> = [
  { project: "pallets-flask", set: "main", src: "src", tests: "tests" },
  { project: "Textualize-rich", set: "holdout", src: ".", tests: "tests" },
  { project: "psf-requests", set: "holdout", src: "src", tests: "tests" },
  { project: "marshmallow-code-marshmallow", set: "holdout-b", src: "src", tests: "tests" },
];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDER = path.join(HERE, "lib", "calls_at_run_time.py");
const REQUIREMENTS = path.join(HERE, "lib", "calls-at-run-time.requirements.txt");
const CACHE = process.env.CALLS_AT_RUN_TIME_CACHE ?? path.join(os.homedir(), ".board-ai-rt");
/** Fifteen minutes for one project's tests. */
const TESTS_MS = 15 * 60_000;

/** Not a function anybody draws an arrow from or to. */
const NOT_SOURCE = /(^|\/)(tests?|testing|docs|docs_src|examples?|benchmarks?|scripts|tools|profiling|action|autoload|gallery)(\/|$)|(^|\/)(test_[^/]*|conftest|setup)\.py$|_test\.py$/;

interface Edge { file: string; caller: string; line: number | null; calleeFile: string; callee: string; how: string }
interface Pair { from: string; to: string; how: string; written: boolean; line: number; text: string }
interface Row extends Pair { outcome: string; reason: string; detail?: string; answered?: readonly string[]; silent?: readonly string[] }
interface ProjectResult { project: string; set: string; recorded: number; tests: string; rows: Row[]; couldNotRun?: string }

if (only) {
  const result = await measureOne(only);
  await new Promise<void>((done) => process.stdout.write(`\n@@RESULT ${JSON.stringify(result)}\n`, () => done()));
  process.exit(0);
}

const wanted = flag("projects")?.split(",");
const results: ProjectResult[] = [];
const failed: string[] = [];
for (const one of PROJECTS.filter((entry) => !wanted || wanted.includes(entry.project))) {
  process.stderr.write(`${one.project}...\n`);
  const run = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args, `--one=${one.project}`, `--set=${one.set}`], {
    encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, BENCH_SET: one.set },
  });
  const line = run.stdout.split("\n").find((text) => text.startsWith("@@RESULT "));
  if (run.status !== 0 || !line) {
    failed.push(`${one.project} (exit ${run.status}): ${whyItStopped(run.stderr)}`);
    continue;
  }
  results.push(JSON.parse(line.slice("@@RESULT ".length)) as ProjectResult);
}
process.exit(report(results, failed) ? 0 : 1);

/** The error a child stopped on: its first `Error` line, not the stack's tail. */
function whyItStopped(stderr: string | null): string {
  const lines = (stderr || "").trim().split("\n");
  return lines.find((line) => /^\w*Error\b|^Error:/.test(line.trim()))?.trim() ?? lines.slice(-3).join(" | ");
}

function report(results: ProjectResult[], failed: string[]): boolean {
  const rows = results.flatMap((one) => one.rows.map((row) => ({ project: one.project, ...row })));
  console.log(`\ncalls recorded while the projects' own tests ran (${qualified ? "methods drawn Class.method" : "methods drawn by their name"})`);
  console.log("  project                          recorded  pairs  unwritten  green  not sure  red  error");
  for (const one of results) {
    const count = (outcome: string) => one.rows.filter((row) => row.outcome === outcome).length;
    console.log(`  ${one.project.padEnd(32)} ${String(one.recorded).padStart(8)}  ${String(one.rows.length).padStart(5)}  `
      + `${String(one.rows.filter((row) => !row.written).length).padStart(9)}  ${String(count("green")).padStart(5)}  `
      + `${String(count("not sure")).padStart(8)}  ${String(count("red")).padStart(3)}  ${String(count("error")).padStart(5)}`
      + `${one.couldNotRun ? `   COULD NOT RUN: ${one.couldNotRun}` : ""}  (tests: ${one.tests})`);
  }
  const reds = rows.filter((row) => row.outcome === "red");
  console.log(`\nreds on calls that happened: ${reds.length} (must be 0)`);
  for (const red of reds) {
    console.log(`  ${red.project}: ${red.from} -> ${red.to} (${red.written ? "written" : "not written"} at the call, line ${red.line}: ${red.text})`);
    console.log(`    ${red.reason}: ${red.detail ?? ""}`);
  }
  const errors = rows.filter((row) => row.outcome === "error");
  for (const error of errors) console.log(`  ERROR ${error.project}: ${error.from} -> ${error.to}: ${error.reason}`);
  const out = flag("out");
  if (out) writeFileSync(out, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const problems = [
    ...failed.map((one) => `a project did not finish: ${one}`),
    ...results.filter((one) => one.couldNotRun).map((one) => `${one.project} could not run: ${one.couldNotRun}`),
    ...(rows.length === 0 ? ["no pairs at all"] : []),
  ];
  for (const problem of problems) console.log(`NOT VALID: ${problem}`);
  return problems.length === 0;
}

async function measureOne(project: string): Promise<ProjectResult> {
  const entry = PROJECTS.find((one) => one.project === project);
  if (!entry) throw new Error(`--one=${project}: not one of ${PROJECTS.map((one) => one.project).join(", ")}`);
  // Imported here: the corpus and libraries are fixed by `--set` when these load.
  const { useLibraries, LIBRARIES } = await import("./lib/bench-libraries");
  const { checkTrueCalls } = await import("./lib/true-calls-check");
  const root = useLibraries(project);
  const python = path.join(LIBRARIES, "python", project, "bin", "python");
  const recording = record(entry, root, python);
  if ("couldNotRun" in recording) return { project, set: entry.set, recorded: 0, tests: "-", rows: [], couldNotRun: recording.couldNotRun };
  const pairs = pairsOf(recording.edges, root);
  const checked = await checkTrueCalls(project, root, pairs);
  return {
    project, set: entry.set, recorded: recording.edges.length, tests: recording.status,
    rows: checked.map((one, index) => ({ ...pairs[index]!, ...one })),
  };
}

/** The recording of this clone's tests: kept, or made now. */
function record(
  entry: (typeof PROJECTS)[number], root: string, python: string,
): { edges: Edge[]; status: string } | { couldNotRun: string } {
  if (!existsSync(python)) return { couldNotRun: `no venv at ${python} -- npm run bench:libraries` };
  const commit = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim().slice(0, 12) || "unversioned";
  const recorder = createHash("sha1").update(readFileSync(RECORDER)).update(readFileSync(REQUIREMENTS)).digest("hex").slice(0, 8);
  const kept = path.join(CACHE, `${entry.project}-${commit}-${recorder}.edges.json`);
  if (existsSync(kept) && !args.includes("--fresh")) {
    const data = JSON.parse(readFileSync(kept, "utf8")) as { status: string; edges: Edge[] };
    return data.edges.length > 0 ? { edges: data.edges, status: data.status } : { couldNotRun: `the kept recording ${kept} holds no calls` };
  }

  const version = spawnSync(python, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" }).stdout.trim();
  if (!/^3\.(1[2-9]|[2-9]\d)$/.test(version)) return { couldNotRun: `${python} is Python ${version || "?"}; sys.monitoring needs 3.12` };
  const libraries = path.join(CACHE, `pylib-${version}-${recorder}`);
  if (!existsSync(path.join(libraries, ".done"))) {
    mkdirSync(libraries, { recursive: true });
    const install = spawnSync("uv", ["pip", "install", "--quiet", "--python", python, "--target", libraries, "-r", REQUIREMENTS], { encoding: "utf8" });
    if (install.status !== 0) return { couldNotRun: `uv could not install the test dependencies: ${(install.stderr || "").trim().split("\n").slice(-2).join(" | ")}` };
    writeFileSync(path.join(libraries, ".done"), "");
  }

  const work = path.join(CACHE, "work", entry.project);
  rmSync(work, { recursive: true, force: true });
  cpSync(root, work, { recursive: true, filter: (from) => !/(^|\/)(\.git|node_modules|\.venv)$/.test(from) });
  const out = path.join(CACHE, "work", `${entry.project}.edges.json`);
  rmSync(out, { force: true });
  const run = spawnSync(python, [
    RECORDER, work, out,
    "-q", "--no-header", "-p", "no:cacheprovider", "-o", "addopts=", "-o", "filterwarnings=", "-W", "ignore",
    "--maxfail=100000", entry.tests,
  ], {
    cwd: work,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    timeout: TESTS_MS,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: [path.join(work, entry.src), work, libraries].join(path.delimiter),
    },
  });
  rmSync(work, { recursive: true, force: true });
  if (!existsSync(out)) {
    return { couldNotRun: `the tests wrote no recording (exit ${run.status}${run.signal ? `, ${run.signal}` : ""}): ${(run.stderr || "").trim().split("\n").slice(-2).join(" | ")}` };
  }
  const data = JSON.parse(readFileSync(out, "utf8")) as { status: string; edges: Edge[] };
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(kept, JSON.stringify({ status: data.status, edges: data.edges }));
  rmSync(out, { force: true });
  return data.edges.length > 0
    ? { edges: data.edges, status: data.status }
    : { couldNotRun: `the tests recorded no call (pytest status ${data.status}): ${(run.stderr || "").trim().split("\n").slice(-2).join(" | ")}` };
}

/**
 * One arrow per caller and callee, from the recorded calls. Where a pair was
 * recorded at several calls, the one whose callee's name is not written at
 * the call is kept: it is the one that says more.
 */
function pairsOf(edges: Edge[], root: string): Pair[] {
  const lines = new Map<string, string[]>();
  const linesOf = (file: string) => {
    let found = lines.get(file);
    if (!found) {
      try { found = readFileSync(path.join(root, file), "utf8").split("\n"); } catch { found = []; }
      lines.set(file, found);
    }
    return found;
  };
  /** `outer.<locals>.inner` is outer's; a method is drawn `Class.method` or by its name. */
  const drawn = (qualname: string) => {
    const parts = qualname.split(".<locals>")[0]!.split(".");
    return qualified ? parts.slice(-2).join(".") : parts[parts.length - 1]!;
  };
  const seen = new Map<string, Pair>();
  for (const edge of edges) {
    if (NOT_SOURCE.test(edge.file) || NOT_SOURCE.test(edge.calleeFile)) continue;
    const caller = edge.caller.split(".<locals>")[0]!;
    if (caller.includes("<") || edge.callee.includes("<")) continue;
    const from = `${edge.file}#${drawn(caller)}`;
    const to = `${edge.calleeFile}#${drawn(edge.callee)}`;
    if (from === to) continue;
    const source = linesOf(edge.file);
    const at = edge.line ?? 0;
    const text = source.slice(Math.max(0, at - 1), at + 2).join(" ");
    const parts = edge.callee.split(".");
    // A class called is written by the class's name; anything else by its own.
    const name = edge.how === "class" && parts.length > 1 ? parts[parts.length - 2]! : parts[parts.length - 1]!;
    const written = new RegExp(`(?<![\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`).test(text);
    const key = `${from}|${to}`;
    const old = seen.get(key);
    if (!old || (old.written && !written)) {
      seen.set(key, { from, to, how: edge.how, written, line: at, text: (source[at - 1] ?? "").trim().slice(0, 110) });
    }
  }
  return [...seen.values()].sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
}
