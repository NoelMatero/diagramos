#!/usr/bin/env node
/**
 * The whole batch measurement in one command: every bench set and every
 * compiler-true language, for a base commit and a branch, side by side, then
 * the comparison.
 *
 *   npm run measure:batch -- --base=<sha> --branch=<sha>
 *   npm run measure:batch -- --base=<sha>                 base alone (to share)
 *   npm run measure:batch -- --base=<sha> --branch=<sha> --sets=main,holdout --no-ct
 *   npm run measure:batch -- --compare=<dir A>,<dir B>    compare two finished arms
 *   npm run measure:batch -- --base=<sha> --dry-run        what would run, and where
 *   npm run measure:batch -- --base=<sha> --base-dir=<dir> --branch=<sha>   a base taken some other way
 *
 * ## The bad outcome
 *
 * A batch took three to four hours: five bench sets and three compiler-true
 * languages, one after another, each through the gate, chained by shell
 * scripts under `~/bench-*` that each agent wrote again, with a 180 s kill
 * for runs that printed their report and never exited. The machine's load sat
 * around 3 on ten cores.
 *
 * ## What it does
 *
 * - **Takes the whole machine** (every gate lane) for the length of the
 *   batch, and keeps the Mac awake.
 * - **A worktree per commit**, made once under `~/.board-ai-batch/wt/<sha>`,
 *   with node_modules and vendor linked from the main checkout and the
 *   holdout sets that live on branches (`origin/holdout-{b,c,d}-bench`)
 *   extracted into it. An arm from before parallel measuring gets this
 *   commit's measuring scripts laid over its own (said in the output).
 * - **Every run at once**, sharing one set of worker slots (`slots.ts`,
 *   `--slots`, default sized to the machine), longest job first across all of
 *   them: the batch is as long as its longest project, not the sum.
 * - **Resumable and shared.** Each arm's results go to `<out>/<sha>/`
 *   (default `~/.board-ai-bench/batch`), a run's `.done` written only when it
 *   finished and could be compared. A base already measured is reused, so one
 *   base per batch serves every branch.
 * - **Compares what the batches compared by hand**: per set, caught, false
 *   reds, wrong greens and true greens; every changed claim on the study sets
 *   (main, holdout, holdout-b); for holdout-c and holdout-d only whether the
 *   score tables and the safety lines are identical -- their arrows are never
 *   printed; compiler-true's reds per word and any red on one side only.
 *
 * A run that could not be compared (NOT VALID, a project not measured, the
 * machine shared, a sleep) is named and its `.done` is not written, so the
 * next invocation runs it again.
 */
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { recordRun, waitForQuiet } from "./lib/bench-busy";
import {
  changedClaims, changedLine, loadDump, readCompilerTrue, reportProblems, safetyCompare, scoreOfDump, scoreOfReport,
  differingLines, scoreTables, textDifference, type Score,
} from "./lib/batch-compare";
import { STUDY_SETS } from "./lib/bench-set";
import { heldLaneCount, laneCount } from "./lib/machine-lock";
import { makeSlots } from "./lib/slots";
import { batchSlots } from "./lib/workers";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.find((one) => one.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = path.resolve(flag("out") ?? path.join(os.homedir(), ".board-ai-bench", "batch"));
const ALL_SETS = ["main", "holdout", "holdout-b", "holdout-c", "holdout-d"];
const sets = flag("sets")?.split(",") ?? ALL_SETS;
const languages = args.includes("--no-ct") ? [] : flag("ct")?.split(",") ?? ["ts", "python", "rust"];
const slots = Number(flag("slots") ?? batchSlots());
const say = (line: string) => console.error(`batch ${new Date().toLocaleTimeString("sv-SE")} ${line}`);

/*
 * The measuring scripts parallel measuring added or changed. An arm whose
 * own bench predates them gets these laid over its scripts, so both arms are
 * measured the same way; nothing under `src/` is ever touched.
 */
const HARNESS = [
  "scripts/bench-planted.mts", "scripts/measure-compiler-true.mts", "scripts/gate.mts",
  "scripts/lib/bench-busy.ts", "scripts/lib/bench-jobs.ts", "scripts/lib/bench-set.ts", "scripts/lib/machine-lock.ts",
  "scripts/lib/slots.ts", "scripts/lib/workers.ts",
];
/** The holdout sets kept on branches of their own, never merged. */
const SET_BRANCHES: Record<string, string> = {
  "holdout-b": "origin/holdout-b-bench", "holdout-c": "origin/holdout-c-bench", "holdout-d": "origin/holdout-d-bench",
};

const git = (...rest: string[]) => execFileSync("git", rest, { cwd: REPO, encoding: "utf8" }).trim();

if (flag("compare")) {
  const [a, b] = flag("compare")!.split(",");
  if (!a || !b) throw new Error("--compare=<dir A>,<dir B>");
  console.log(compare(path.resolve(a), path.resolve(b), path.basename(a), path.basename(b)).join("\n"));
  process.exit(0);
}

const baseRef = flag("base");
if (!baseRef) {
  console.error("usage: npm run measure:batch -- --base=<sha> [--branch=<sha>] [--sets=a,b] [--ct=ts,python,rust | --no-ct] [--slots=n] [--out=dir]");
  process.exit(2);
}
const shaOf = (ref: string) => git("rev-parse", "--short=7", `${ref}^{commit}`);
const arms = [shaOf(baseRef), ...(flag("branch") ? [shaOf(flag("branch")!)] : [])];
/**
 * A base measured some other way, as a folder with this script's file names
 * (`main.out`, `main.jsonl`, ..., `holdout-c.out`, `ct-rust.out`): read, never
 * run. For a base taken before this script existed.
 */
const baseDir = flag("base-dir") ? path.resolve(flag("base-dir")!) : undefined;
/** The arms this invocation runs: the branch alone when the base is a folder. */
const toRun = baseDir ? arms.slice(1) : arms;
const armDir = (sha: string) => (baseDir && sha === arms[0] ? baseDir : path.join(out, sha));
if (arms[0] === arms[1]) throw new Error(`--base and --branch are the same commit (${arms[0]}): nothing to compare`);
const jedi = process.env.JEDI_PYTHON ?? [path.join(os.homedir(), "bench-461/venv/bin/python")].find((one) => existsSync(one));
if (languages.includes("python") && !jedi) throw new Error("compiler-true for Python needs JEDI_PYTHON: a python with jedi installed");

/* ------------------------------------------------------------- worktrees */

function worktree(sha: string): string {
  const dir = path.join(os.homedir(), ".board-ai-batch", "wt", sha);
  if (!existsSync(path.join(dir, ".git"))) {
    mkdirSync(path.dirname(dir), { recursive: true });
    git("worktree", "add", "--detach", dir, sha);
  }
  const main = path.dirname(realpathSync(path.join(REPO, "node_modules")));
  for (const link of ["node_modules", "vendor"]) {
    if (!existsSync(path.join(dir, link))) symlinkSync(path.join(main, link), path.join(dir, link));
  }
  for (const [set, branch] of Object.entries(SET_BRANCHES)) {
    if (!sets.includes(set) || existsSync(path.join(dir, `bench-${set}`))) continue;
    execFileSync("sh", ["-c", `git -C '${REPO}' archive ${branch} bench-${set} | tar -x -C '${dir}'`]);
  }
  // The commit's own bench, not the worktree's copy: a copy laid over it before is laid over again, fresh.
  const own = git("show", `${sha}:scripts/bench-planted.mts`);
  if (!own.includes("BENCH_PLANTED_JOB")) {
    for (const file of HARNESS) copyFileSync(path.join(REPO, file), path.join(dir, file));
    say(`${sha}: predates parallel measuring; this commit's measuring scripts laid over its own (${HARNESS.length} files, nothing in src/)`);
  }
  return dir;
}

/* ------------------------------------------------------------------ runs */

interface Run { arm: string; name: string; dir: string; cwd: string; argv: string[]; out: string; err: string; done: string }

function runsFor(sha: string, cwd: string): Run[] {
  const dir = path.join(out, sha);
  mkdirSync(dir, { recursive: true });
  const list: Run[] = [];
  for (const set of sets) {
    const study = STUDY_SETS.includes(set);
    list.push({
      arm: sha, name: set, dir, cwd,
      argv: ["scripts/bench-planted.mts", `--set=${set}`, ...(study ? ["--details", `--dump=${path.join(dir, `${set}.jsonl`)}`] : [])],
      out: path.join(dir, `${set}.out`), err: path.join(dir, `${set}.err`), done: path.join(dir, `${set}.done`),
    });
  }
  for (const language of languages) {
    list.push({
      arm: sha, name: `ct-${language}`, dir, cwd,
      argv: ["scripts/measure-compiler-true.mts", `--language=${language}`, "--cases"],
      out: path.join(dir, `ct-${language}.out`), err: path.join(dir, `ct-${language}.err`), done: path.join(dir, `ct-${language}.done`),
    });
  }
  return list;
}

/** One run, its stdout and stderr to files. Resolves with its exit code and wall time. */
function start(run: Run, slotsDir: string): Promise<{ code: number | null; ms: number }> {
  const began = Date.now();
  const child = spawn(process.execPath, [...process.execArgv, ...run.argv], {
    cwd: run.cwd,
    env: {
      ...process.env, BOARD_AI_SLOTS: slotsDir, NODE_OPTIONS: "--max-old-space-size=8192",
      ...(jedi ? { JEDI_PYTHON: jedi } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const kill = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
  process.once("exit", kill);
  const outFd: Buffer[] = [];
  const errFd: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => outFd.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errFd.push(chunk));
  return new Promise((resolve) => {
    child.once("close", (code) => {
      process.removeListener("exit", kill);
      writeFileSync(run.out, Buffer.concat(outFd));
      writeFileSync(run.err, Buffer.concat(errFd));
      resolve({ code, ms: Date.now() - began });
    });
  });
}

/* ---------------------------------------------------------------- compare */

function pct(n: number, of: number): string {
  return of === 0 ? "n/a" : `${((n / of) * 100).toFixed(1)}%`;
}
function delta(a: number, b: number): string {
  return a === b ? `${b}` : `${a} -> ${b} (${b - a > 0 ? "+" : ""}${b - a})`;
}

function scoreLine(set: string, a: Score | undefined, b: Score | undefined): string {
  if (!a || !b) return `  ${set.padEnd(10)} no score on ${!a ? "the first" : "the second"} side`;
  return `  ${set.padEnd(10)} caught ${delta(a.caught, b.caught)}/${b.planted} (${pct(b.caught, b.planted)})`
    + ` · false reds ${delta(a.falseReds, b.falseReds)} · wrong greens ${delta(a.wrongGreens, b.wrongGreens)}`
    + ` · true greens ${delta(a.trueGreens, b.trueGreens)}/${b.correct}`;
}

/** The comparison of two arms' result folders, as lines to print. */
function compare(baseDir: string, branchDir: string, baseName: string, branchName: string): string[] {
  const lines = [`COMPARISON -- ${baseName} (first) vs ${branchName} (second)`];
  const read = (dir: string, file: string) => (existsSync(path.join(dir, file)) ? readFileSync(path.join(dir, file), "utf8") : undefined);
  const scores: string[] = [];
  const changes: string[] = [];
  const safety: string[] = [];
  for (const set of ALL_SETS) {
    const a = read(baseDir, `${set}.out`);
    const b = read(branchDir, `${set}.out`);
    if (a === undefined && b === undefined) continue;
    if (a === undefined || b === undefined) {
      scores.push(`  ${set.padEnd(10)} only measured on the ${a === undefined ? "second" : "first"} side`);
      continue;
    }
    if (STUDY_SETS.includes(set)) {
      const da = loadDump(path.join(baseDir, `${set}.jsonl`));
      const db = loadDump(path.join(branchDir, `${set}.jsonl`));
      scores.push(scoreLine(set, da.size ? scoreOfDump(da) : undefined, db.size ? scoreOfDump(db) : undefined));
      const changed = changedClaims(da, db);
      changes.push(`  ${set}: ${changed.length} of ${Math.max(da.size, db.size)} claims changed`);
      for (const one of changed) changes.push(`    ${changedLine(one)}`);
    } else {
      scores.push(scoreLine(set, scoreOfReport(a), scoreOfReport(b)));
      {
        const tablesSame = JSON.stringify(scoreTables(a)) === JSON.stringify(scoreTables(b));
        safety.push(`  ${set} (score only, no arrows printed): score tables ${tablesSame ? "identical" : "NOT identical"}`);
        for (const one of safetyCompare(a, b)) {
          safety.push(`    ${one.title}: ${one.base} lines vs ${one.branch} lines, identical: ${one.identical ? "yes" : "NO"};`
            + ` only in first ${one.onlyBase}, only in second ${one.onlyBranch}`);
        }
      }
    }
  }
  lines.push("", "SCORE, per set (first -> second)", ...scores);
  if (changes.length > 0) lines.push("", "CHANGED CLAIMS on the study sets", ...changes);
  if (safety.length > 0) lines.push("", "SCORE-ONLY SETS -- compared in counts only; not one of their arrows is printed", ...safety);
  const ct: string[] = [];
  for (const language of ["ts", "python", "rust"]) {
    const a = read(baseDir, `ct-${language}.out`);
    const b = read(branchDir, `ct-${language}.out`);
    if (a === undefined || b === undefined) continue;
    const ca = readCompilerTrue(a);
    const cb = readCompilerTrue(b);
    const words = [...new Set([...ca.words.keys(), ...cb.words.keys()])];
    const redLive = (c: typeof ca) => words.reduce((sum, word) => sum + (c.words.get(word)?.[2] ?? 0), 0);
    const redOff = (c: typeof ca) => words.reduce((sum, word) => sum + (c.words.get(word)?.[3] ?? 0), 0);
    const pairs = (c: typeof ca) => words.reduce((sum, word) => sum + (c.words.get(word)?.[0] ?? 0), 0);
    const onlyA = ca.reds.filter((one) => !cb.reds.includes(one));
    const onlyB = cb.reds.filter((one) => !ca.reds.includes(one));
    ct.push(`  ${language.padEnd(7)} pairs ${delta(pairs(ca), pairs(cb))} · red live ${delta(redLive(ca), redLive(cb))}`
      + ` · red off ${delta(redOff(ca), redOff(cb))} · word table ${JSON.stringify([...ca.words]) === JSON.stringify([...cb.words]) ? "identical" : "differs"}`);
    for (const one of onlyB) ct.push(`    new red: ${one}`);
    for (const one of onlyA) ct.push(`    red gone: ${one}`);
  }
  if (ct.length > 0) lines.push("", "COMPILER-TRUE -- every pair is correct code, so every red is a false accusation", ...ct);
  /* Whole reports, timing taken out: 0 differing lines is the same answer everywhere. Counts only, so a score-only set prints nothing of itself. */
  const same: string[] = [];
  for (const name of [...ALL_SETS, "ct-ts", "ct-python", "ct-rust"]) {
    const a = read(baseDir, `${name}.out`);
    const b = read(branchDir, `${name}.out`);
    if (a === undefined || b === undefined) continue;
    const differ = textDifference(a, b);
    same.push(`  ${name.padEnd(10)} ${differ === 0 ? "identical apart from timing" : `${differ} lines differ`}`);
    // Which, where no arrow is on the line: a compiler that answered a different number of questions shows here.
    if (differ > 0) {
      const { shown, hidden } = differingLines(a, b);
      for (const [first, second] of shown.slice(0, 12)) {
        same.push(`    first:  ${(first ?? "(none)").trim().slice(0, 160)}`);
        same.push(`    second: ${(second ?? "(none)").trim().slice(0, 160)}`);
      }
      if (hidden > 0) same.push(`    and ${hidden} differing line${hidden === 1 ? "" : "s"} holding an arrow, not shown`);
    }
  }
  if (same.length > 0) lines.push("", "WHOLE REPORTS, timing lines and per-claim ms taken out", ...same);
  return lines;
}

/* ------------------------------------------------------------------ main */

/* The plan first: worktrees and what is left to run. Nothing heavy, so it does not wait for the machine. */
const plan: Run[] = [];
for (const sha of toRun) {
  const cwd = worktree(sha);
  for (const run of runsFor(sha, cwd)) {
    if (existsSync(run.done)) { say(`${sha} ${run.name}: done before, reused`); continue; }
    plan.push(run);
  }
}
if (args.includes("--dry-run")) {
  for (const run of plan) console.log(`${run.arm} ${run.name}: (cd ${run.cwd} && tsx ${run.argv.join(" ")}) > ${run.out}`);
  process.exit(0);
}

const began = Date.now();
await waitForQuiet(say, 1_000, { whole: true });
/* Under a gate that took one lane, the other lanes are free for anybody: a batch needs them all. */
if (heldLaneCount() < laneCount()) {
  console.error(`measure:batch holds ${heldLaneCount()} of ${laneCount()} gate lanes: run it on its own (it takes the machine itself), or as \`npm run gate -- --whole ...\`.`);
  process.exit(2);
}
const machine = recordRun(`measure-batch ${args.join(" ")}`);
if (process.platform === "darwin" && existsSync("/usr/bin/caffeinate")) {
  spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" }).unref();
}
say(`machine taken after ${((Date.now() - began) / 1000).toFixed(0)}s; arms ${arms.join(", ")}; sets ${sets.join(",")}; compiler-true ${languages.join(",") || "none"}; ${slots} slots; ${plan.length} runs to go`);
const slotsDir = path.join(out, `.slots-${process.pid}`);
makeSlots(slotsDir, slots);
const ranAt = Date.now();
const results = await Promise.all(plan.map(async (run) => {
  say(`${run.arm} ${run.name}: start`);
  const ended = await start(run, slotsDir);
  const text = readFileSync(run.out, "utf8");
  const problems = [
    ...(ended.code === 0 ? [] : [`exit ${ended.code}`]),
    ...reportProblems(text),
  ];
  if (problems.length === 0) writeFileSync(run.done, `${new Date().toISOString()} ${ended.ms}ms\n`);
  say(`${run.arm} ${run.name}: ${problems.length === 0 ? "done" : `NOT COMPARABLE (${problems.join("; ")})`} in ${(ended.ms / 1000).toFixed(0)}s`);
  return { run, ...ended, problems };
}));
const wall = Date.now() - ranAt;

const report: string[] = [];
report.push(`MEASURE:BATCH -- ${arms.join(" vs ")} · ${plan.length} runs in ${(wall / 1000 / 60).toFixed(1)} min wall`
  + ` (${(results.reduce((sum, one) => sum + one.ms, 0) / 1000 / 60).toFixed(1)} min if one after another) · ${slots} slots`);
report.push(`  ${machine.line()}`);
for (const one of results) {
  report.push(`  ${one.run.arm} ${one.run.name.padEnd(10)} ${(one.ms / 1000).toFixed(0).padStart(5)}s  ${one.problems.length === 0 ? "ok" : `NOT COMPARABLE: ${one.problems.join("; ")}`}`);
}
const unusable = toRun.flatMap((sha) => runsFor(sha, "").filter((run) => !existsSync(run.done)).map((run) => `${sha} ${run.name}`));
if (unusable.length > 0) report.push(`  NOT COMPARABLE, run again to retry: ${unusable.join(", ")}`);
if (arms.length === 2) report.push("", ...compare(armDir(arms[0]!), armDir(arms[1]!), arms[0]!, arms[1]!));
rmSync(slotsDir, { recursive: true, force: true });
const text = report.join("\n");
writeFileSync(path.join(out, `report-${arms.join("-")}.txt`), `${text}\n`);
console.log(text);
machine.end();
await new Promise<void>((resolve) => { process.stdout.write("", () => resolve()); });
process.exit(unusable.length > 0 ? 1 : 0);
