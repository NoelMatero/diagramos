/**
 * A measurement run whose language server stops answering is stopped, named
 * and passed by; one whose server is slow, or busy, is left alone (#486).
 *
 * The census child and `bench:planted` share `scripts/lib/stall-watchdog.ts`.
 * These tests drive it with stub servers in a child process of their own --
 * the watchdog counts the CPU of the process it runs in, and vitest's would
 * hide a stall -- with a 2 s window in place of the real 10 minutes.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { StallClock, cpuTimeMs, descendantsOf, stallWindowMs } from "../scripts/lib/stall-watchdog";

const REPO = path.resolve(__dirname, "..");

interface Unit { unit: string; result: string; ms: number; serverPid: number; childPid: number; reason?: string }

function run(...units: string[]): { results: Unit[]; notMeasured: string[] } {
  const ran = spawnSync(path.join(REPO, "node_modules/.bin/tsx"),
    [path.join(REPO, "tests/fixtures/stall-watchdog/run.mts"), ...units], { encoding: "utf8", timeout: 60_000 });
  expect(ran.status, ran.stderr).toBe(0);
  return JSON.parse(ran.stdout.trim().split("\n").pop()!) as { results: Unit[]; notMeasured: string[] };
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

describe("a server that stops answering", () => {
  it("is killed within the window, with what it started, and the run goes on and names it", () => {
    const { results, notMeasured } = run("stops", "slow");
    const [stops, slow] = results as [Unit, Unit];
    expect(stops.result).toBe("failed");
    expect(stops.reason).toMatch(/^stalled: nothing answered for 2\.\ds awake/);
    // The stub and its child by pid, never the process listing's own `ps`, whose pid is free once it exits.
    expect(stops.reason, stops.reason).toContain(`(pid ${stops.serverPid})`);
    expect(stops.reason, stops.reason).toContain(`(pid ${stops.childPid})`);
    expect(stops.reason, stops.reason).not.toMatch(/\bps \(pid/);
    // Two answers take ~20 ms; then the 2 s window, plus up to two 0.2 s ticks and the process listing.
    expect(stops.ms).toBeGreaterThanOrEqual(2000);
    expect(stops.ms).toBeLessThan(4500);
    expect(alive(stops.serverPid)).toBe(false);
    expect(stops.childPid).toBeGreaterThan(0);
    expect(alive(stops.childPid)).toBe(false);
    // The next unit ran, whole.
    expect(slow.result).toBe("done");
    expect(notMeasured).toEqual(["stops"]);
  }, 60_000);
});

describe("a server that is slow but answering, or busy", () => {
  it("is never killed: answers 1.5 s apart over 7.5 s, and 3.5 s of CPU before the first answer", () => {
    const { results, notMeasured } = run("slow", "busy");
    expect(results.map((one) => one.result)).toEqual(["done", "done"]);
    expect(results[0]!.ms).toBeGreaterThan(7000);
    expect(results[1]!.ms).toBeGreaterThan(3500);
    expect(notMeasured).toEqual([]);
  }, 60_000);
});

describe("the decision", () => {
  const options = { windowMs: 600_000, minCpuMs: 30_000, tickMs: 15_000 };

  it("stalls after the window of awake time with no answer and no work, and starts over", () => {
    const clock = new StallClock(options, 0);
    let stalledAt = -1;
    for (let t = 15_000; t <= 1_200_000 && stalledAt < 0; t += 15_000) {
      if (clock.look(t, 100, false).stalled) stalledAt = t;
    }
    expect(stalledAt).toBe(600_000);
    expect(clock.look(615_000, 0, false).stalled).toBe(false);
  });

  it("does not count a sleep: a ten-hour gap is two ticks of waiting", () => {
    const clock = new StallClock(options, 0);
    const look = clock.look(36_000_000, 0, false);
    expect(look.stalled).toBe(false);
    expect(look.idleAwakeMs).toBe(30_000);
    expect(look.sleptMs).toBe(36_000_000 - 30_000);
  });

  it("is reset by one answer, or by the CPU of real work", () => {
    const clock = new StallClock(options, 0);
    for (let t = 15_000; t < 600_000; t += 15_000) clock.look(t, 0, false);
    expect(clock.look(600_000, 0, true).stalled).toBe(false);
    for (let t = 615_000; t < 1_200_000; t += 15_000) clock.look(t, 0, false);
    expect(clock.look(1_200_000, 30_000, false).stalled).toBe(false);
    expect(clock.look(1_215_000, 0, false).idleAwakeMs).toBe(15_000);
  });

  it("reads ps's CPU time as macOS and Linux write it", () => {
    expect(cpuTimeMs("0:21.34")).toBe(21_340);
    expect(cpuTimeMs("1:02:03.50")).toBe(3_723_500);
    expect(cpuTimeMs("00:00:21")).toBe(21_000);
    expect(cpuTimeMs("2-01:00:00")).toBe(176_400_000);
  });

  it("finds every process below one, not beside it", () => {
    const rows = [
      { pid: 10, ppid: 1, cpuMs: 0, command: "node" },
      { pid: 11, ppid: 10, cpuMs: 0, command: "npx" },
      { pid: 12, ppid: 11, cpuMs: 0, command: "pyright-langserver" },
      { pid: 13, ppid: 1, cpuMs: 0, command: "other" },
    ];
    expect(descendantsOf(rows, 10).map((row) => row.pid)).toEqual([11, 12]);
  });

  it("takes --stall-min in minutes, fractions allowed, ten by default", () => {
    expect(stallWindowMs([])).toBe(600_000);
    expect(stallWindowMs(["--stall-min=0.5"])).toBe(30_000);
    expect(() => stallWindowMs(["--stall-min=0"])).toThrow();
  });
});
