#!/usr/bin/env node
/**
 * Is a correct arrow ever called wrong, when "correct" is what the compiler
 * says rather than what a text scan reads? (#393, part 3)
 *
 *   npm run measure:compiler-true -- --language=ts
 *   JEDI_PYTHON=<python with jedi> npm run measure:compiler-true -- --language=python
 *   npm run measure:compiler-true -- --language=rust          -- rustc on PATH
 *   ... --cases            print every red
 *   ... --words=holds,takes  only these words
 *   ... --projects=a,b     only these projects
 *   ... --one=<project>    one project, in this process (prints raw JSON)
 *   ... --jobs=<n>         projects at once, each in its own process (default: BOARD_AI_JOBS,
 *                          else sized to the machine); --jobs=1 is one after another
 *   ... --names=plain      Rust: draw a method as `file#new`, not `file#Money::new`
 *                          (#382). TypeScript and Python always draw `Class.method`.
 *   ... --dispatched       TypeScript, only `@calls` arrows through a call the compiler
 *                          resolves to an interface's or an abstract method (#351),
 *                          drawn to each routine stored under that method: a class
 *                          that implements it, or an object literal typed by the
 *                          interface naming a routine or wrapping one in an arrow.
 *   ... --handed-on        TypeScript, only `@calls` arrows to a routine handed on one
 *                          step (`npm run measure:compiler-true-handed-on`): `run(fits)` where `run`
 *                          calls that parameter, an option's member, or a field set
 *                          to the routine -- followed with the compiler's own symbols.
 *                          The population a type question about a function value
 *                          puts at risk; every one is correct (calls research 2026-11).
 *   ... --class-tails      only `@calls` arrows drawn FROM a class or struct (#459):
 *                          each call the compiler resolves in a method becomes
 *                          "the method's class calls it", drawn at the class in
 *                          the method's own file. A class calls what its own
 *                          code calls, so every one is correct too.
 *
 * **A measurement that fails only when it could not measure** (Fonseca 2017,
 * recommendation 1). It exits 1 when the pairs come to 0, or when more than
 * a quarter of the projects crashed, gave no pairs, or had a referee that
 * could not run -- on 2026-11-22 every Rust build failed for want of
 * downloaded dependencies, and this printed "0 pairs" and exited 0. Its
 * header says which compilers the checker's live arm got answers from, which
 * Rust crates built, and any sleep during the run. Reds never fail it: they
 * are the finding, and are printed.
 *
 * ## The question
 *
 * The licences for `holds`, `takes`, `returns`, `conforms`, `calls` and
 * `accesses` were earned against text scans, and a text scan reads what is
 * written -- the same blind spot as the readers it judged. #373 drew 448
 * correct arrows and 58 went red behind those zeros: a field with no type
 * written, a parameter typed by its variable, a class that fits an interface
 * without `implements`.
 *
 * So here the referee is a compiler, and the population is everything it says
 * is true: every field's type, every parameter's and return's, every base and
 * every interface a class fits, every call's target, every member a `.name`
 * reads. Each pair is drawn as an arrow and checked by the product's own
 * `checkDrift`. **Every one is correct, so the reds must be 0.**
 *
 * Two arms per pair:
 *
 *   - `live`: the way the MCP server checks a board, `refereedCheckLive` with
 *     the language servers running. This is the number the licence rests on.
 *   - `off`: no compiler at all, which is CI and a user without one. A red
 *     here rests on something the reader found written (#393's gate), so it
 *     is either the reader misreading a written thing or the written thing
 *     disagreeing with the compiler.
 *
 * Each pair says whether what made it true is written at the site or known to
 * the compiler only (`how`), because a zero over written pairs alone is the
 * old measurement again.
 *
 * ## The referees
 *
 *   - TypeScript: the compiler's type checker, asked through its API with a
 *     program of its own (`scripts/lib/compiler-true-ts.ts`).
 *   - Python: jedi -- parso and jedi's own inference, nothing shared with the
 *     pyright the product asks or the tree-sitter it reads
 *     (`scripts/lib/compiler_true_jedi.py`).
 *   - Rust: rustc's MIR, read by this script's own line patterns
 *     (`scripts/lib/compiler-true-rust.ts`): the types of each function's
 *     arguments and return, of each field a body reads or a struct literal
 *     fills, and the function each call lands on. rust-analyzer, which the
 *     product asks, is not involved.
 *
 * What each cannot see is in that file's header and in the licence notes.
 *
 * Arrows are checked forty to a board, never two between the same boxes, so
 * a red is always one arrow's. Each project runs in a process of its own, and
 * a project that fails is named, never dropped.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ClosedBodyReferee } from "../src/engine/drift";
import type { CrateOutcome } from "../src/engine/referee-rustc";
import type { TruePair, TrueWord } from "./lib/compiler-true-ts";
import { pausesLine, readPowerLogSleeps, watchPauses, type Pause } from "./lib/run-pauses";
import { CompilerTally, judgeCompilerTrue, type TallyData } from "./lib/run-validity";
import { projectTimes } from "./lib/bench-jobs";
import { RUST_AT_ONCE, rustCrateKey, sharingSlots, withSlot } from "./lib/slots";
import { inPool, jobsFrom } from "./lib/workers";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((one) => one.startsWith(`--${name}=`))?.split("=")[1];
const language = flag("language") ?? "ts";
const only = flag("one");
const showCases = args.includes("--cases");
/** How a method's box is drawn: `Type::method` / `Class.method`, or `--names=plain`. */
const plainNames = flag("names") === "plain";
const classTails = args.includes("--class-tails");
const dispatched = args.includes("--dispatched");
const handedOn = args.includes("--handed-on");
const words = (flag("words")?.split(",") ?? (classTails || dispatched || handedOn ? ["calls"] : undefined)) as TrueWord[] | undefined;
const WORDS: TrueWord[] = ["holds", "takes", "returns", "conforms", "calls", "accesses"];

/** The pinned clones live in the main checkout; a worktree has none. */
const CORPUS = existsSync(path.resolve(import.meta.dirname, "..", ".corpus"))
  ? path.resolve(import.meta.dirname, "..", ".corpus")
  : path.join(process.env.HOME ?? "", "board-ai", ".corpus");

/** The trees read, and the directories in each: `measure:builds-absent`'s, and the bench's projects. */
const TREES: Record<string, Record<string, string[]>> = {
  ts: {
    "TanStack-query": ["packages/query-core/src"],
    "vuejs-core": ["packages/reactivity/src", "packages/runtime-core/src"],
    "excalidraw-excalidraw": ["packages/element/src"],
    "nestjs-nest": ["packages/core", "packages/common"],
    "vitejs-vite": ["packages/vite/src"],
  },
  python: {
    "encode-httpx": ["httpx"],
    "pallets-flask": ["src/flask"],
    "python-poetry-poetry": ["src/poetry"],
    "pydantic-pydantic": ["pydantic"],
  },
  rust: { anyhow: ["."], clap: ["."], json: ["."], regex: ["."], ripgrep: ["."] },
};

type Arm = "live" | "off";

interface ProjectResult {
  project: string;
  /** `${word} ${how} ${arm} ${answer}` -> count. */
  tally: Record<string, number>;
  /** Every red, by arm. Must be empty on `live`. */
  reds: Record<Arm, string[]>;
  /** The pairs the referee gave, before any `--words` or shape filter: 0 is a project that measured nothing. */
  pairs: number;
  /** Set when the referee that makes the pairs could not run, with why. */
  couldNotRun?: string;
  /** Which compilers answered the live arm's checks. */
  compilers: TallyData;
  /** Times the child did not run while asking the checker. */
  pauses: Pause[];
}

if (only) {
  const result = await measureOne(only);
  // Waited for: a pipe takes a long line in pieces, and exiting first cuts it.
  await new Promise<void>((done) => process.stdout.write(`\n@@RESULT ${JSON.stringify(result)}\n`, () => done()));
  process.exit(0);
}

const trees = TREES[language];
if (!trees) {
  process.stderr.write(`--language=${language}: ts, python and rust are measured.\n`);
  process.exit(1);
}
const results: ProjectResult[] = [];
const failed: string[] = [];
const runStarted = Date.now();
const self = fileURLToPath(import.meta.url);
const projects = flag("projects")?.split(",") ?? Object.keys(trees);
/*
 * Up to `--jobs` projects at once (`scripts/lib/workers.ts`; `--jobs=1` is
 * one after another, as it was), each in its process of its own as before,
 * and read back in the order above whichever finished first.
 */
const childArgs = args.filter((one) => !one.startsWith("--jobs="));
/* Longest first, by the last run's times; inside `measure:batch`, sharing its worker slots (`slots.ts`). */
const times = projectTimes(`compiler-true-${language}${words ? `-${words.join("+")}` : ""}`);
const order = [...projects].sort((a, b) => times.of(b) - times.of(a));
/* A Rust project shares its crate with the bench's main set: never two rust-analyzers on it at once (`workers.ts`). */
const apart = (project: string) => (language === "rust" ? rustCrateKey(path.join(CORPUS, project)) : undefined);
const ran = await inPool(order, sharingSlots() ? order.length : jobsFrom(args), (project) => withSlot(times.of(project), async () => {
  process.stderr.write(`${project}...\n`);
  const began = Date.now();
  const run = await runChild(project);
  if (run.status === 0) times.record(project, Date.now() - began);
  process.stderr.write(`${project}: exit ${run.status} in ${((Date.now() - began) / 1000).toFixed(0)}s\n`);
  return run;
}, apart(project), language === "rust"), apart, { of: () => language === "rust", at: RUST_AT_ONCE });
times.save();
const runs = projects.map((project) => ran[order.indexOf(project)]!);
for (const [index, project] of projects.entries()) {
  const run = runs[index]!;
  const line = run.stdout.split("\n").find((one) => one.startsWith("@@RESULT "));
  if (run.status !== 0 || !line) {
    failed.push(`${project} (exit ${run.status}): ${(run.stderr || "").trim().split("\n").slice(-3).join(" | ")}`);
    continue;
  }
  try {
    results.push(JSON.parse(line.slice("@@RESULT ".length)) as ProjectResult);
  } catch {
    failed.push(`${project}: its result line did not parse (${line.length} characters)`);
  }
}
const valid = report(results, failed);
process.exit(valid ? 0 : 1);

/** One project's child, with everything it printed. Killed with this process, however that ends. */
function runChild(project: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [...process.execArgv, self, ...childArgs, `--one=${project}`], {
    env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
  });
  const kill = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
  process.once("exit", kill);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  return new Promise((resolve) => {
    child.once("error", (error) => {
      process.removeListener("exit", kill);
      resolve({ status: null, stdout: "", stderr: error.message });
    });
    child.once("close", (status) => {
      process.removeListener("exit", kill);
      resolve({ status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

/** Prints the run, and says whether it measured anything. */
function report(results: ProjectResult[], failed: string[]): boolean {
  const tally: Record<string, number> = {};
  for (const one of results) for (const [key, count] of Object.entries(one.tally)) tally[key] = (tally[key] ?? 0) + count;
  const count = (keep: (parts: string[]) => boolean) =>
    Object.entries(tally).filter(([key]) => keep(key.split(" "))).reduce((total, [, n]) => total + n, 0);

  console.log(`\ncompiler-true pairs, ${language}: ${results.length} project(s)`);
  const compilers = new CompilerTally();
  for (const one of results) compilers.merge(one.compilers);
  const pauses = results.flatMap((one) => one.pauses);
  console.log(`  ${pausesLine(pauses, readPowerLogSleeps(runStarted, Date.now()))}`);
  console.log(`  referee: ${results.map((one) => `${one.project} ${one.pairs}${one.couldNotRun ? ` (${one.couldNotRun})` : ""}`).join(", ") || "no project measured"}`);
  for (const line of compilers.lines([language])) console.log(`  ${line}`);
  const verdict = judgeCompilerTrue(language, results.map((one) => ({
    project: one.project, pairs: one.pairs, ...(one.couldNotRun ? { couldNotRun: one.couldNotRun } : {}),
  })), failed);
  // The live arm is the number the licence rests on: a checker whose compiler answered nothing measured the text reading.
  const problems = compilers.problems([language]).map((one) => `NOT VALID: the live arm's ${one}`);
  for (const line of [...verdict.lines.filter((one) => one.startsWith("NOT VALID")), ...problems]) console.log(`  ${line}`);
  for (const line of verdict.lines.filter((one) => !one.startsWith("NOT VALID") && !failed.includes(one))) console.log(`  ${line}`);
  console.log("  word       pairs   compiler-only   red live   red off   green live");
  for (const word of words ?? WORDS) {
    const pairs = count(([w, , arm]) => w === word && arm === "off");
    if (pairs === 0 && !words) { console.log(`  ${word.padEnd(9)}      0`); continue; }
    const compilerOnly = count(([w, how, arm]) => w === word && how !== "written" && arm === "off");
    const red = (arm: Arm) => count(([w, , a, answer]) => w === word && a === arm && answer === "red");
    const green = count(([w, , a, answer]) => w === word && a === "live" && answer === "green");
    console.log(`  ${word.padEnd(9)} ${String(pairs).padStart(6)}   ${String(compilerOnly).padStart(13)}   ${String(red("live")).padStart(8)}   ${String(red("off")).padStart(7)}   ${String(green).padStart(10)}`);
  }
  console.log("\n  by how, live:");
  for (const [key, n] of Object.entries(tally).filter(([key]) => key.split(" ")[2] === "live").sort()) {
    console.log(`    ${String(n).padStart(6)}  ${key}`);
  }
  for (const arm of ["live", "off"] as const) {
    const reds = results.flatMap((one) => one.reds[arm].map((red) => `${one.project}: ${red}`));
    if (reds.length === 0) continue;
    console.log(`\n  RED, ${arm === "live" ? "with the compiler running" : "with no compiler"} (${reds.length}):`);
    for (const red of showCases || arm === "live" ? reds : reds.slice(0, 20)) console.log(`    ${red}`);
    if (!showCases && arm === "off" && reds.length > 20) console.log(`    ... ${reds.length - 20} more (--cases)`);
  }
  if (failed.length > 0) {
    console.log("\n  FAILED, and not counted:");
    for (const one of failed) console.log(`    ${one}`);
  }
  if (!verdict.valid || problems.length > 0) {
    for (const line of [...verdict.lines, ...problems]) process.stderr.write(`compiler-true: ${line}\n`);
  }
  return verdict.valid && problems.length === 0;
}

async function measureOne(project: string): Promise<ProjectResult> {
  const root = path.join(CORPUS, project);
  const dirs = TREES[language]![project] ?? [];
  let pairs: TruePair[];
  let couldNotRun: string | undefined;
  if (language === "ts") {
    const ts = (await import("typescript")).default;
    const { typescriptTruePairs } = await import("./lib/compiler-true-ts");
    pairs = typescriptTruePairs(ts, root, dirs, { dispatched, handedOn });
  } else if (language === "python") {
    pairs = pythonTruePairs(project, dirs);
  } else {
    const { rustTruePairs } = await import("./lib/compiler-true-rust");
    pairs = await rustTruePairs(root, plainNames, (crates: readonly CrateOutcome[]) => {
      const tried = crates.filter((crate) => !crate.nothingToBuild);
      const built = tried.filter((crate) => crate.built).length;
      if (tried.length > 0 && built === 0) {
        couldNotRun = `the Rust compiler built none of ${tried.length} crates: ${tried[0]!.why ?? "no reason recorded"}`;
      }
    });
  }
  const referee = pairs.length;
  if (words) pairs = pairs.filter((pair) => words.includes(pair.word));
  if (classTails) pairs = classTailPairs(pairs);
  process.stderr.write(`${project}: ${pairs.length} pairs\n`);
  const result = await askChecker(project, root, pairs);
  return { ...result, pairs: referee, ...(couldNotRun ? { couldNotRun } : {}) };
}

/**
 * `--class-tails` (#459): each `@calls` pair drawn from a method, drawn again
 * from the method's class -- `a.ts#Dep.track -> b.ts#render` becomes
 * `a.ts#Dep -> b.ts#render`. The class is drawn in the method's file, which
 * for a Rust `impl` in another file is not where the struct is declared; that
 * arrow is then one the checker cannot place, which is a "not sure", never a
 * red. Free functions' pairs are dropped.
 */
function classTailPairs(pairs: TruePair[]): TruePair[] {
  const out: TruePair[] = [];
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (pair.word !== "calls") continue;
    const method = pair.from.match(/^(.*)#([A-Za-z_$][\w$]*)(?:\.|::)[A-Za-z_$][\w$]*$/);
    if (!method) continue;
    const from = `${method[1]}#${method[2]}`;
    if (from === pair.to || seen.has(`${from} ${pair.to}`)) continue;
    seen.add(`${from} ${pair.to}`);
    out.push({ ...pair, from });
  }
  return out;
}

function pythonTruePairs(project: string, dirs: string[]): TruePair[] {
  const python = process.env.JEDI_PYTHON ?? "python3";
  const script = path.join(import.meta.dirname, "lib", "compiler_true_jedi.py");
  const run = spawnSync(python, [script, path.join(CORPUS, project), ...dirs], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (run.status !== 0) {
    throw new Error(`jedi referee failed (${python}): ${run.stderr.trim().split("\n").pop()}. Set JEDI_PYTHON to a Python with jedi.`);
  }
  return JSON.parse(run.stdout) as TruePair[];
}

/**
 * Every pair drawn as an arrow and checked by the product, both arms. Forty
 * arrows to a board, and never two between the same two boxes, so a finding
 * on a node pair is one arrow's.
 */
async function askChecker(project: string, root: string, pairs: TruePair[]):
  Promise<Omit<ProjectResult, "pairs" | "couldNotRun">> {
  const { liveRefereePool, refereedCheckLive } = await import("../src/engine/referee-live");
  const { checkDrift, createWorkspace, newCheckCache, ACCUSING_EDGE_KINDS } = await import("../src/engine/drift");
  const { emptyBoard } = await import("../src/engine/board-file");
  const { createDiagram } = await import("../src/engine/diagram");
  const { initEngine } = await import("../src/engine/parse");
  const { installExcalifontMeasurer } = await import("../tests/helpers/excalifont");
  installExcalifontMeasurer();
  await initEngine();

  const accusing = new Set<string>(ACCUSING_EDGE_KINDS);
  const cache = newCheckCache(createWorkspace(root));
  /* Ten minutes per check, not two: wall clock stretches with a batch's load, and questions cut off by it change counts (bench-planted.mts, BENCH_BUDGET_MS). */
  const BUDGET_MS = 600_000;
  const pool = liveRefereePool(() => Date.now() + BUDGET_MS);
  const compilers = new CompilerTally();
  const pauses = watchPauses();
  const result = { project, tally: {} as Record<string, number>, reds: { live: [], off: [] } as Record<Arm, string[]> };

  // Batches with no two arrows between the same boxes.
  const batches: TruePair[][] = [];
  for (const pair of pairs) {
    const key = `${pair.from} ${pair.to}`;
    let batch = batches.find((one) => one.length < 40 && !one.some((other) => `${other.from} ${other.to}` === key));
    if (!batch) { batch = []; batches.push(batch); }
    batch.push(pair);
  }

  let done = 0;
  for (const batch of batches) {
    const ids = new Map<string, string>();
    const idOf = (ref: string) => {
      if (!ids.has(ref)) ids.set(ref, `n${ids.size}`);
      return ids.get(ref)!;
    };
    for (const pair of batch) { idOf(pair.from); idOf(pair.to); }
    const { board } = await createDiagram(emptyBoard(), {
      name: "b",
      nodes: [...ids].map(([ref, id]) => ({ id, label: ref.split(/[#.]/).pop()!, ref })),
      edges: batch.map((pair) => ({
        from: idOf(pair.from), to: idOf(pair.to), claim: pair.word, ...(pair.label ? { label: pair.label } : {}),
      })),
    });
    const run = (referee?: ClosedBodyReferee) =>
      checkDrift(JSON.parse(JSON.stringify(board)), cache.workspace, referee ? { edges: true, cache, closedBodyReferee: referee } : { edges: true, cache });
    for (const arm of ["off", "live"] as const) {
      let report;
      try {
        if (arm === "off") report = run(undefined);
        else {
          const live = await refereedCheckLive(root, run, { budgetMs: BUDGET_MS, pool });
          compilers.add(project, live.checkedWith);
          report = live.report;
        }
      } catch (error) {
        for (const pair of batch) bump(result, `${pair.word} ${pair.how} ${arm} throw`);
        process.stderr.write(`${project}: ${arm} threw ${(error as Error).message.slice(0, 80)}\n`);
        continue;
      }
      for (const pair of batch) {
        const node = `${idOf(pair.from)} -> ${idOf(pair.to)}`;
        const red = report.edges.find((finding) => finding.node === node && accusing.has(finding.kind));
        const quiet = report.unconfirmedEdges.find((one) => `${one.from} -> ${one.to}` === node);
        // Why the claim's own check declined, when it did: the word in the sentence's brackets.
        const why = quiet?.reason === "claim-not-checked" ? quiet.detail.match(/could not answer \(([^)]+)\)/)?.[1] : undefined;
        const unconfirmed = quiet ? `${quiet.reason}${why ? `:${why.replace(/\s+/g, "-")}` : ""}` : undefined;
        const answer = red ? "red" : unconfirmed ? "unconfirmed" : "green";
        bump(result, `${pair.word} ${pair.how} ${arm} ${answer}${unconfirmed && !red ? ` ${unconfirmed}` : ""}`);
        if (red) {
          const gate = report.gated.find((one) => one.node === node);
          result.reds[arm].push(
            `${pair.word} ${pair.from} -> ${pair.to}${pair.label ? ` [${pair.label}]` : ""} (${pair.how}) ${red.kind}`
            + `${gate?.said ? ` | compiler: ${gate.said}` : ""} | ${red.detail.slice(0, 160)}`,
          );
        }
      }
    }
    done += batch.length;
    if (batches.indexOf(batch) % 25 === 0) process.stderr.write(`${project}: ${done}/${pairs.length}\n`);
  }
  pool.close();
  pauses.stop();
  return { ...result, compilers: compilers.toJSON(), pauses: pauses.pauses() };
}

function bump(result: { tally: Record<string, number> }, key: string): void {
  result.tally[key] = (result.tally[key] ?? 0) + 1;
}
