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
 *   ... --names=plain      Rust: draw a method as `file#new`, not `file#Money::new`
 *                          (#382). TypeScript and Python always draw `Class.method`.
 *
 * **A measurement: it prints and never fails.**
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
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ClosedBodyReferee } from "../src/engine/drift";
import type { TruePair, TrueWord } from "./lib/compiler-true-ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((one) => one.startsWith(`--${name}=`))?.split("=")[1];
const language = flag("language") ?? "ts";
const only = flag("one");
const showCases = args.includes("--cases");
/** How a method's box is drawn: `Type::method` / `Class.method`, or `--names=plain`. */
const plainNames = flag("names") === "plain";
const words = flag("words")?.split(",") as TrueWord[] | undefined;
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
const self = fileURLToPath(import.meta.url);
const projects = flag("projects")?.split(",") ?? Object.keys(trees);
for (const project of projects) {
  process.stderr.write(`${project}...\n`);
  const run = spawnSync(process.execPath, [...process.execArgv, self, ...args, `--one=${project}`], {
    encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env },
  });
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
report(results, failed);

function report(results: ProjectResult[], failed: string[]): void {
  const tally: Record<string, number> = {};
  for (const one of results) for (const [key, count] of Object.entries(one.tally)) tally[key] = (tally[key] ?? 0) + count;
  const count = (keep: (parts: string[]) => boolean) =>
    Object.entries(tally).filter(([key]) => keep(key.split(" "))).reduce((total, [, n]) => total + n, 0);

  console.log(`\ncompiler-true pairs, ${language}: ${results.length} project(s)`);
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
}

async function measureOne(project: string): Promise<ProjectResult> {
  const root = path.join(CORPUS, project);
  const dirs = TREES[language]![project] ?? [];
  let pairs: TruePair[];
  if (language === "ts") {
    const ts = (await import("typescript")).default;
    const { typescriptTruePairs } = await import("./lib/compiler-true-ts");
    pairs = typescriptTruePairs(ts, root, dirs);
  } else if (language === "python") {
    pairs = pythonTruePairs(project, dirs);
  } else {
    const { rustTruePairs } = await import("./lib/compiler-true-rust");
    pairs = await rustTruePairs(root, plainNames);
  }
  if (words) pairs = pairs.filter((pair) => words.includes(pair.word));
  process.stderr.write(`${project}: ${pairs.length} pairs\n`);
  return askChecker(project, root, pairs);
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
async function askChecker(project: string, root: string, pairs: TruePair[]): Promise<ProjectResult> {
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
  const pool = liveRefereePool(() => Date.now() + 120_000);
  const result: ProjectResult = { project, tally: {}, reds: { live: [], off: [] } };

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
        report = arm === "off" ? run(undefined) : (await refereedCheckLive(root, run, { budgetMs: 120_000, pool })).report;
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
  return result;
}

function bump(result: ProjectResult, key: string): void {
  result.tally[key] = (result.tally[key] ?? 0) + 1;
}
