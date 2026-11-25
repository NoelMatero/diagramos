#!/usr/bin/env node
/**
 * Is a function that is handed to another, which calls it, ever called wrong
 * as that other's call? The referee is the TypeScript compiler, followed one
 * step (calls research 2026-11).
 *
 *   npm run measure:handed-on
 *   ... --projects=taskforcesh-bullmq,immerjs-immer   only these
 *   ... --out=<file.jsonl>   every arrow and its verdict, one line each, to compare two runs
 *
 * ## Why this referee
 *
 * `measure:compiler-true` takes its true arrows from the compilers' call
 * lists, and every one of them writes the far end's name at the call. A rule
 * about a function value -- `handler(req)`, `options.onDone()`,
 * `this.callback()` -- cannot be tested on that population. Here each true
 * arrow is a hand-over the compiler can follow one step: `run(fits)` where
 * the routine `run` resolves to calls its parameter, an option object's
 * routine called by its key, a field set to a routine and called by a method
 * of the same class (`scripts/lib/handed-on.ts`). "run calls fits" is true,
 * and nothing at the call in `run` names `fits`.
 *
 * Only routines of the project count, at both ends; tests, examples,
 * benchmarks and scripts are left out. Each pair says whether the hand-over
 * went through a cast (`cast`), where a type stops saying what a value is.
 *
 * Each pair is drawn as one arrow and checked the way `bench:planted` checks
 * a claim (`scripts/lib/true-calls-check.ts`). **Every pair is true, so the
 * reds must be 0.** Reds are the finding and are printed; they do not fail
 * the run. It exits 1 only when it could not measure: a project that crashed,
 * or no pairs at all.
 */
import { spawnSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((one) => one.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = flag("one");

/** The bench's TypeScript projects, by set. */
const PROJECTS: Record<string, string[]> = {
  main: ["TanStack-query", "excalidraw-excalidraw", "nestjs-nest", "vitejs-vite", "vuejs-core"],
  holdout: ["colinhacks-zod", "honojs-hono", "raineorshine-npm-check-updates", "taskforcesh-bullmq", "trpc-trpc"],
  "holdout-b": ["drizzle-team-drizzle-orm", "elysiajs-elysia", "google-zx", "immerjs-immer", "mobxjs-mobx"],
};

/** Not a routine anybody draws an arrow from or to. */
const NOT_SOURCE = /(^|\/)(tests?|__tests__|testing|spec|e2e|fixtures?|benches|benchmarks?|examples?|docs|docs_src|playground|sample|scripts|perf|runtime-tests|\.vitepress)(\/|$)|\.(test|spec|test-d|bench)\.[jt]sx?$/;

interface Pair { from: string; to: string; how: string; cast: boolean; site: string }
interface Row extends Pair { outcome: string; reason: string; detail?: string; answered?: readonly string[]; silent?: readonly string[] }
interface ProjectResult { project: string; set: string; found: number; rows: Row[] }

if (only) {
  const result = await measureOne(only, flag("set") ?? "main");
  await new Promise<void>((done) => process.stdout.write(`\n@@RESULT ${JSON.stringify(result)}\n`, () => done()));
  process.exit(0);
}

const wanted = flag("projects")?.split(",");
const results: ProjectResult[] = [];
const failed: string[] = [];
for (const [set, projects] of Object.entries(PROJECTS)) {
  for (const project of projects.filter((one) => !wanted || wanted.includes(one))) {
    process.stderr.write(`${project}...\n`);
    const run = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args, `--one=${project}`, `--set=${set}`], {
      encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, BENCH_SET: set },
    });
    const line = run.stdout.split("\n").find((text) => text.startsWith("@@RESULT "));
    if (run.status !== 0 || !line) {
      failed.push(`${project} (exit ${run.status}): ${(run.stderr || "").trim().split("\n").slice(-3).join(" | ")}`);
      continue;
    }
    results.push(JSON.parse(line.slice("@@RESULT ".length)) as ProjectResult);
  }
}
process.exit(report(results, failed) ? 0 : 1);

function report(results: ProjectResult[], failed: string[]): boolean {
  const rows = results.flatMap((one) => one.rows.map((row) => ({ project: one.project, ...row })));
  console.log("\nfunctions handed on one step, TypeScript");
  console.log("  project                          set        pairs  cast  green  not sure  red  error");
  for (const one of results) {
    const count = (outcome: string) => one.rows.filter((row) => row.outcome === outcome).length;
    console.log(`  ${one.project.padEnd(32)} ${one.set.padEnd(9)} ${String(one.rows.length).padStart(6)}  `
      + `${String(one.rows.filter((row) => row.cast).length).padStart(4)}  ${String(count("green")).padStart(5)}  `
      + `${String(count("not sure")).padStart(8)}  ${String(count("red")).padStart(3)}  ${String(count("error")).padStart(5)}`);
  }
  const reds = rows.filter((row) => row.outcome === "red");
  console.log(`\nreds on functions handed on: ${reds.length} (must be 0)`);
  for (const red of reds) {
    console.log(`  ${red.project}: ${red.from} -> ${red.to} (${red.how}${red.cast ? ", through a cast" : ""}, handed at ${red.site})`);
    console.log(`    ${red.reason}: ${red.detail ?? ""}`);
  }
  for (const error of rows.filter((row) => row.outcome === "error")) {
    console.log(`  ERROR ${error.project}: ${error.from} -> ${error.to}: ${error.reason}`);
  }
  const out = flag("out");
  if (out) writeFileSync(out, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const problems = [
    ...failed.map((one) => `a project did not finish: ${one}`),
    ...(rows.length === 0 ? ["no pairs at all"] : []),
  ];
  for (const problem of problems) console.log(`NOT VALID: ${problem}`);
  return problems.length === 0;
}

async function measureOne(project: string, set: string): Promise<ProjectResult> {
  // Imported here: the corpus and libraries are fixed by `--set` when these load.
  const { useLibraries } = await import("./lib/bench-libraries");
  const { checkTrueCalls } = await import("./lib/true-calls-check");
  const { eachTsProgram, isOutsideTree } = await import("../src/engine/referee-ts");
  const { flowPairsOf } = await import("./lib/handed-on");
  const root = realpathSync(useLibraries(project));
  const inTree = (file: string) => !isOutsideTree(file, root) && !/node_modules/.test(file);
  const pairs = new Map<string, Pair>();
  let found = 0;
  eachTsProgram(root, (program, checker, ts) => {
    for (const one of flowPairsOf(ts, program, checker, inTree)) {
      found += 1;
      const from = path.relative(root, one.from.file);
      const to = path.relative(root, one.to.file);
      if (from.startsWith("..") || to.startsWith("..") || NOT_SOURCE.test(from) || NOT_SOURCE.test(to)) continue;
      if (from === to && one.from.name === one.to.name) continue;
      const pair = { from: `${from}#${one.from.name}`, to: `${to}#${one.to.name}`, how: one.how, cast: one.cast, site: path.relative(root, one.site) };
      const key = `${pair.from}|${pair.to}`;
      const old = pairs.get(key);
      // One arrow per pair; a witness without a cast is the plainer truth.
      if (!old || (old.cast && !pair.cast)) pairs.set(key, pair);
    }
  });
  const list = [...pairs.values()].sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
  const checked = await checkTrueCalls(project, root, list);
  return { project, set, found, rows: checked.map((one, index) => ({ ...list[index]!, ...one })) };
}
