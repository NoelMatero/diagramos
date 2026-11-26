/**
 * Measurement work spread over worker processes, one job per process, with
 * the answers merged back in a fixed order.
 *
 * ## The bad outcome
 *
 * A full batch measurement took three to four hours on a ten-core machine
 * whose load sat around 3. The checker is single-threaded and reads one
 * project after another, so nine cores waited while one did the work.
 *
 * ## The shape
 *
 * - **A process per job.** Each project already gets a fresh workspace,
 *   cache and language servers (`bench-planted.mts`, #311/#337), so a job in
 *   a process of its own asks exactly what it asked in the shared one -- and
 *   the operating system gives back both heaps at the end
 *   (`corpus-sweep-needs-a-process-per-tree`, #403's one-process-per-project
 *   run matched on all 1,264 arrows).
 * - **Answers come back over the IPC channel**, never stdout, so nothing a
 *   worker prints can end up in a report.
 * - **Merged by the caller in its own order**, not the order jobs finish, so
 *   a report reads the same whatever ran first.
 * - **A worker that has answered and does not exit is stopped.** The answer
 *   is in; a language server stuck in its own shutdown is not a reason to
 *   hold a run open (the exit hang behind `~/bench-491/bench.sh`'s 180 s
 *   kill).
 * - **A worker dies with its parent.** It watches the IPC channel and exits
 *   when the parent goes, however the parent went; its language servers go
 *   with it (`server-process.ts`).
 *
 * How many at once: `--jobs=<n>`, else `BOARD_AI_JOBS`, else sized to the
 * machine (`machineJobs`) and divided between the gate's lanes: a run that
 * holds one of two lanes gets half, one that holds them all gets every
 * worker (`machine-lock.ts`). Two lanes never mean twice the processes.
 *
 * Measurement only. Nothing in `src/` uses this.
 */
import { fork, type ChildProcess } from "node:child_process";
import os from "node:os";

import { heldLaneCount, laneCount } from "./machine-lock";

/**
 * Workers for this machine when nothing says otherwise: one per four GB of
 * memory (a worker with a rust-analyzer behind it has been seen at 2-3 GB),
 * leaving four cores for the language servers and everything else, never
 * more than six. A 10-core, 24 GB machine gets 6.
 */
export function machineJobs(): number {
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  const byMemory = Math.floor(os.totalmem() / (4 * 1024 ** 3));
  return Math.max(1, Math.min(6, cores - 4, byMemory));
}

/**
 * Worker slots for a batch that holds the whole machine (`measure:batch`):
 * the machine's workers (`machineJobs`, 6 here). Measured 2026-11-26 on one
 * arm of 76cc7e4: 6 slots took 54 min and every compiler answered exactly
 * as in the one-at-a-time runs; 8 slots took 45-47 min, and in one of two
 * runs rust-analyzer answered 64 fewer of the same questions and pyright 2
 * more -- no claim's answer changed, but a compiler giving up under load is
 * how one would. `--slots=8` is the faster choice when that risk is
 * acceptable.
 */
export function batchSlots(): number {
  return machineJobs();
}

/** `--jobs=<n>` from a script's arguments, then `BOARD_AI_JOBS`, then this run's share of `machineJobs()`. */
export function jobsFrom(argv: readonly string[]): number {
  const given = argv.find((one) => one.startsWith("--jobs="))?.slice("--jobs=".length) ?? process.env.BOARD_AI_JOBS;
  if (given === undefined || given === "") {
    const lanes = laneCount();
    const held = Math.max(1, heldLaneCount());
    return Math.max(1, Math.floor((machineJobs() * Math.min(held, lanes)) / lanes));
  }
  const n = Number(given);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--jobs=${given}: want a whole number of workers, 1 or more`);
  return n;
}

export type WorkerOutcome<T> = { ok: true; value: T; ms: number } | { ok: false; why: string; ms: number };

/** Workers alive right now, so a parent that exits takes them with it. */
const live = new Set<ChildProcess>();
let hooked = false;
function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", () => { for (const child of live) stop(child); });
}

function stop(child: ChildProcess): void {
  if (child.pid === undefined) return;
  // Its own group: the worker and anything it started that is not a server of its own.
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
}

/**
 * Run `script` with `args` in a worker and resolve with the one message it
 * sends (`sendResult`). A worker that exits without sending is a failure,
 * with the exit status; one that sends and has not exited `graceMs` later is
 * stopped. The worker's stdout goes to this process's stderr.
 */
export function runWorker<T>(script: string, args: readonly string[],
  { graceMs = 20_000, env = process.env, execArgv = process.execArgv }:
  { graceMs?: number; env?: NodeJS.ProcessEnv; execArgv?: readonly string[] } = {}): Promise<WorkerOutcome<T>> {
  const began = Date.now();
  hookExit();
  const child = fork(script, [...args], {
    // This process's own loader (`tsx`), so a worker can be a `.mts` script like its parent.
    execArgv: [...execArgv],
    env,
    // stdout to our stderr: a stray print in a worker must not land in a report.
    stdio: ["ignore", 2, 2, "ipc"],
    detached: process.platform !== "win32",
  });
  live.add(child);
  return new Promise((resolve) => {
    let result: T | undefined;
    let got = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    child.on("message", (message) => {
      if (got) return;
      got = true;
      result = message as T;
      grace = setTimeout(() => stop(child), graceMs);
    });
    child.once("error", (error) => {
      if (grace) clearTimeout(grace);
      live.delete(child);
      resolve({ ok: false, why: `could not start: ${error.message}`, ms: Date.now() - began });
    });
    child.once("exit", (code, signal) => {
      if (grace) clearTimeout(grace);
      live.delete(child);
      // Whatever it left in its group goes too.
      stop(child);
      const ms = Date.now() - began;
      if (got) resolve({ ok: true, value: result as T, ms });
      else resolve({ ok: false, why: `exited ${signal ?? `with ${code}`} before answering`, ms });
    });
  });
}

/**
 * The worker's half: send the answer, then exit. Waits for the message to be
 * written, because exiting first can cut a long one short.
 */
export async function sendResult(value: unknown, code = 0): Promise<never> {
  await new Promise<void>((resolve) => {
    if (!process.send) { resolve(); return; }
    process.send(value, undefined, {}, () => resolve());
  });
  process.exit(code);
}

/** A worker exits when its parent does (the IPC channel closes), however the parent went. */
export function exitWithParent(): void {
  if (process.send) process.once("disconnect", () => process.exit(1));
}

/**
 * Run `work` over `jobs`, at most `n` at once, starting them in the order
 * given, and return the results in that same order.
 *
 * `apart` names what a job must not share with another one running: two
 * jobs with the same name never run at once, and a job whose name is taken
 * waits while later ones go ahead. Two rust-analyzers on one crate contend
 * for its `target/` folder, and in a test run the one that lost the race
 * answered nothing (`dont-run-two-vitests-at-once`), so a Rust project's jobs
 * are kept apart.
 */
export async function inPool<J, R>(jobs: readonly J[], n: number, work: (job: J, index: number) => Promise<R>,
  apart: (job: J) => string | undefined = () => undefined): Promise<R[]> {
  const results = new Array<R>(jobs.length);
  const waiting = jobs.map((_, index) => index);
  const held = new Set<string>();
  let wake: () => void = () => {};
  const lane = async (): Promise<void> => {
    for (;;) {
      if (waiting.length === 0) return;
      const at = waiting.findIndex((index) => { const name = apart(jobs[index]!); return name === undefined || !held.has(name); });
      if (at < 0) {
        await new Promise<void>((resolve) => { const before = wake; wake = () => { before(); resolve(); }; });
        continue;
      }
      const index = waiting.splice(at, 1)[0]!;
      const name = apart(jobs[index]!);
      if (name !== undefined) held.add(name);
      try {
        results[index] = await work(jobs[index]!, index);
      } finally {
        if (name !== undefined) held.delete(name);
        const woken = wake;
        wake = () => {};
        woken();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, n), jobs.length) }, lane));
  return results;
}
