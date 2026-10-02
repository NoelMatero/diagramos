#!/usr/bin/env node
/**
 * `bench:planted`, one process per project, into a folder (#403).
 *
 *   npm run bench:planted:runs -- <folder> [bench flags...]
 *   npm run bench:planted:runs -- <folder> --projects=regex,ripgrep --cap=600
 *   npm run bench:planted:compare -- <base folder> <arm folder>
 *
 * The whole bench in one process is about as fast (6-7 minutes on
 * 2026-10-01), and is still the one command for a score. This is for the runs
 * that are worth keeping:
 *
 * - **Resumable.** Each project's `--details` output is `<folder>/<project>.txt`,
 *   written only when that project finished. Run the same command again and
 *   only the missing projects run. A folder remembers the commit and the flags
 *   it was started with and refuses to be finished by another, because a
 *   folder that is half one commit and half another compares as a change
 *   nobody made.
 * - **Capped.** A project that runs past `--cap` seconds (default 900) is
 *   stopped with everything it started, and named at the end as not finished.
 *   A slow project costs its cap, not the night.
 * - **One at a time across sessions.** Before each project it waits while
 *   another bench, measure script or vitest is running -- `bench-busy.ts`,
 *   which never matches its own commands.
 *
 * Every project runs in a process group of its own, so stopping one stops its
 * language servers too.
 */
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, createWriteStream } from "node:fs";
import path from "node:path";

import { waitForQuiet } from "./lib/bench-busy";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BENCH = path.join(REPO, "scripts/bench-planted.mts");

const args = process.argv.slice(2);
const own = (name: string) => args.find((one) => one.startsWith(`--${name}=`))?.split("=")[1];
const folder = args.find((one) => !one.startsWith("--"));
if (!folder) {
  console.log("usage: bench-planted-runs.mts <folder> [--projects=a,b] [--cap=seconds] [bench flags...]");
  process.exit(2);
}
const out = path.resolve(folder);
const cap = Number(own("cap") ?? 900) * 1000;
/** Passed through to every project's bench, minus this script's own. */
const flags = args.filter((one) => one !== folder && !/^--(projects|cap)=/.test(one) && one !== "--details"
  && !one.startsWith("--project="));

const all = readdirSync(path.join(REPO, "bench/boards")).sort();
const wanted = own("projects")?.split(",") ?? all;
const unknown = wanted.filter((one) => !all.includes(one));
if (unknown.length > 0) {
  console.log(`no such project: ${unknown.join(" ")}`);
  process.exit(2);
}

const head = (() => {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "src", "scripts", "bench"], { cwd: REPO, encoding: "utf8" }).trim();
    return dirty ? `${sha}+uncommitted` : sha;
  } catch {
    return "unknown";
  }
})();

mkdirSync(out, { recursive: true });
const stamp = path.join(out, "_run.json");
const run = { repo: REPO, head, flags };
if (existsSync(stamp)) {
  const was = JSON.parse(readFileSync(stamp, "utf8")) as typeof run;
  if (was.repo !== run.repo || was.head !== run.head || JSON.stringify(was.flags) !== JSON.stringify(run.flags)) {
    console.log(`${out} was started on ${was.repo} at ${was.head} with [${was.flags.join(" ")}];`
      + ` this is ${run.repo} at ${run.head} with [${run.flags.join(" ")}]. Use a new folder.`);
    process.exit(2);
  }
} else {
  writeFileSync(stamp, `${JSON.stringify(run, null, 2)}\n`);
}

const time = () => new Date().toTimeString().slice(0, 8);
const say = (line: string) => {
  console.log(line);
  appendFileSync(path.join(out, "_log"), `${time()} ${line}\n`);
};

/** One project, in a process group of its own. Resolves with how it ended. */
function one(project: string): Promise<"ok" | "over its cap" | string> {
  const partial = path.join(out, `${project}.partial`);
  const sink = createWriteStream(partial);
  const child = spawn(process.execPath, [...process.execArgv, BENCH, `--project=${project}`, "--details", "--no-wait", ...flags], {
    cwd: REPO, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  child.stdout.pipe(sink);
  child.stderr.pipe(sink);
  const stop = (signal: NodeJS.Signals) => {
    try { process.kill(-child.pid!, signal); } catch { child.kill(signal); }
  };
  // Stopped with this runner, whatever stops it.
  const onExit = () => stop("SIGKILL");
  process.once("exit", onExit);
  return new Promise((resolve) => {
    let over = false;
    const timer = setTimeout(() => { over = true; stop("SIGTERM"); setTimeout(() => stop("SIGKILL"), 3_000).unref(); }, cap);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      process.removeListener("exit", onExit);
      // Anything the project left in its group goes with it.
      stop("SIGKILL");
      sink.end(() => {
        if (over) return resolve("over its cap");
        if (code !== 0) return resolve(`exit ${signal ?? code}`);
        renameSync(partial, path.join(out, `${project}.txt`));
        resolve("ok");
      });
    });
  });
}

/*
 * A project runs in a group of its own, so Ctrl-C at the terminal does not
 * reach it. Passed on here; `one`'s `exit` hook then stops the group.
 */
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => { say(`stopped by ${signal}`); process.exit(130); });
}

const began = Date.now();
say(`start ${REPO} at ${head}, flags [${flags.join(" ")}], cap ${cap / 1000}s`);
const unfinished: string[] = [];
for (const project of wanted) {
  if (existsSync(path.join(out, `${project}.txt`))) continue;
  await waitForQuiet(say);
  const started = Date.now();
  const ended = await one(project);
  say(`${project} ${ended} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  if (ended !== "ok") unfinished.push(`${project} (${ended})`);
}
say(`done in ${((Date.now() - began) / 1000).toFixed(0)}s`
  + (unfinished.length > 0 ? `; NOT FINISHED: ${unfinished.join(", ")} -- run again to retry them` : ""));
process.exit(unfinished.length > 0 ? 1 : 0);
