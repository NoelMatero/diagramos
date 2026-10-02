/**
 * The bench's own tools (#403): the check that waits for another run, and the
 * reader that compares two runs arrow for arrow.
 *
 * The busy check is tested on the shapes that fooled every home-made version:
 * a shell whose command text names a bench, a wait loop that names vitest, and
 * the process asking. Each of those stalled a session for 40-60 minutes. Only
 * a node process actually running a bench, measure script or vitest counts.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { otherRuns } from "../scripts/lib/bench-busy";
import { readRun } from "../scripts/lib/bench-details";

const REPO = path.resolve(__dirname, "..");

let started: number[] = [];
let scratch: string | undefined;
afterEach(() => {
  for (const pid of started) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  started = [];
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/**
 * A process that stays up, with `command` as what a process listing shows --
 * and not a child of this one. The check rightly ignores its own family, and
 * another session's run is nobody's child here; a shell that backgrounds the
 * process and exits hands it to the system, which is the same position.
 */
function running(command: string, args: string[]): number {
  const quoted = [command, ...args].map((one) => `'${one.replace(/'/g, `'\\''`)}'`).join(" ");
  const ran = spawnSync("sh", ["-c", `${quoted} >/dev/null 2>&1 & echo $!`], { encoding: "utf8" });
  const pid = Number(ran.stdout.trim());
  started.push(pid);
  // Long enough for the shell to be gone and exec to settle the command line.
  spawnSync("sleep", ["0.3"]);
  return pid;
}

const counted = (pid: number) => otherRuns().some((one) => one.pid === pid);

describe.skipIf(process.platform === "win32")("another run is using the machine", () => {
  const STAY = "setTimeout(() => {}, 30000)";

  it("is a node process running a bench script", () => {
    const pid = running(process.execPath, ["-e", STAY, "scripts/bench-planted.mts", "--project=regex"]);
    expect(counted(pid)).toBe(true);
  });

  it("is a node process running a measure script", () => {
    const pid = running(process.execPath, ["-e", STAY, "scripts/measure-calls.mts"]);
    expect(counted(pid)).toBe(true);
  });

  it("is a node process running vitest", () => {
    const pid = running(process.execPath, ["-e", STAY, "/x/node_modules/.bin/vitest", "run"]);
    expect(counted(pid)).toBe(true);
  });

  it("is not a shell whose command text names a bench", () => {
    const pid = running("sh", ["-c", "sleep 30; echo scripts/bench-planted.mts", "x"]);
    expect(counted(pid)).toBe(false);
  });

  it("is not a wait loop that names vitest and measure scripts", () => {
    const pid = running("sh", ["-c", "until ! pgrep -f 'vitest|measure-calls.mts'; do sleep 30; done", "x"]);
    expect(counted(pid)).toBe(false);
  });

  it("is not the process asking, nor what started it", () => {
    // This test runs inside vitest: its own worker and the vitest above it
    // are exactly what a careless check would wait on forever.
    const mine = new Set([process.pid, process.ppid]);
    expect(otherRuns().filter((one) => mine.has(one.pid))).toEqual([]);
  });
});

/*
 * Two `--details` lines from one project, as `bench:planted` prints them since
 * #393: the last columns are how long the check took and what the gate did.
 */
const LINES = [
  "    red       false  swap       rust   [missing-call] @calls src/a.rs#one -> src/b.rs#two | missing-call: one() never calls two() | 41ms | gate: -",
  "    green     true   labelled   rust   [confirmed] @calls src/a.rs#one -> src/b.rs#three | confirmed | 12ms | gate: -",
];

describe("reading a run back", () => {
  it("reads a folder of per-project files and one whole run the same way, timing aside", () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "bench-tools-"));
    const folder = path.join(scratch, "runs");
    mkdirSync(folder);
    writeFileSync(path.join(folder, "anyhow.txt"), `${LINES.join("\n")}\n`);
    writeFileSync(path.join(folder, "json.txt"), `${LINES[0]}\n`);
    const whole = path.join(scratch, "whole.txt");
    writeFileSync(whole, [
      "  some table above",
      "  == anyhow", LINES[0]!.replace("41ms", "9000ms"), LINES[1],
      "  == json", LINES[0],
      "  WORKLIST -- fixable reasons",
    ].join("\n"));

    const a = readRun(folder);
    const b = readRun(whole);

    expect([...a.arrows.keys()]).toEqual([...b.arrows.keys()]);
    expect([...a.arrows.values()]).toEqual([...b.arrows.values()]);
    expect(a.arrows.get("anyhow#0 @calls src/a.rs#one -> src/b.rs#two")).toMatchObject({
      outcome: "red", truth: "false", reason: "missing-call",
      detail: "missing-call: one() never calls two() | gate: -",
    });
  });

  it("names a project that printed no arrows rather than dropping it", () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "bench-tools-"));
    writeFileSync(path.join(scratch, "anyhow.txt"), `${LINES[0]}\n`);
    writeFileSync(path.join(scratch, "regex.txt"), "Error: the run died before scoring anything\n");

    expect(readRun(scratch).empty).toEqual(["regex"]);
  });

  it("compares two runs: one flip, one reworded, and says it was not the same", () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "bench-tools-"));
    const base = path.join(scratch, "base");
    const arm = path.join(scratch, "arm");
    mkdirSync(base);
    mkdirSync(arm);
    writeFileSync(path.join(base, "anyhow.txt"), `${LINES.join("\n")}\n`);
    writeFileSync(path.join(arm, "anyhow.txt"), [
      LINES[0]!.replace("never calls two()", "has no call to two()"),
      LINES[1]!.replace("green     true   labelled   rust   [confirmed]", "red       true   labelled   rust   [missing-call]"),
    ].join("\n"));

    const ran = spawnSync(path.join(REPO, "node_modules/.bin/tsx"),
      [path.join(REPO, "scripts/bench-planted-compare.mts"), base, arm], { encoding: "utf8" });

    expect(ran.status).toBe(1);
    expect(ran.stdout).toContain("TRUE    green -> red  rust anyhow#1 @calls src/a.rs#one -> src/b.rs#three");
    expect(ran.stdout).toContain("1 flipped, 1 same outcome with a different reason or wording");
  }, 30_000);
});
