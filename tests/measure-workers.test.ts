/**
 * Measurement work in worker processes (`scripts/lib/workers.ts`) and which
 * worker asks which arrows (`scripts/lib/bench-jobs.ts`).
 *
 * The bad outcomes these guard: a report whose order depends on which worker
 * finished first; a run that never ends because a worker answered and then
 * sat in a language server's shutdown; a worker that died taking its answers
 * with it and the run not noticing; a slow project left whole so the run
 * waits on it alone. No language server is started.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JobTimes, type ProjectJob } from "../scripts/lib/bench-jobs";
import type { Key } from "../scripts/lib/planted-keys";
import { makeSlots, withSlot } from "../scripts/lib/slots";
import { inPool, jobsFrom, runWorker } from "../scripts/lib/workers";

const REPO = path.resolve(__dirname, "..");
/** A worker is a `.mts` script; a parent run by `tsx` hands on its loader, and vitest has none to hand on. */
const TS = ["--import", "tsx"];
let scratch: string;

beforeEach(() => { scratch = mkdtempSync(path.join(os.tmpdir(), "measure-workers-")); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

/** A worker script that does what `body` says, with the worker half of the library in reach. */
function worker(body: string): string {
  const file = path.join(scratch, `w${Math.random().toString(36).slice(2)}.mts`);
  writeFileSync(file, [
    `import { exitWithParent, sendResult } from ${JSON.stringify(path.join(REPO, "scripts/lib/workers.ts"))};`,
    "exitWithParent();",
    body,
  ].join("\n"));
  return file;
}

describe("worker pool", () => {
  it("never runs two jobs with the same name at once, and lets later jobs past one that waits", async () => {
    const going = new Map<string, number>();
    const order: string[] = [];
    let clash = false;
    await inPool(["rust:a", "rust:a", "ts:b", "rust:a", "ts:c"], 3, async (name, index) => {
      going.set(name, (going.get(name) ?? 0) + 1);
      if (name.startsWith("rust") && going.get(name)! > 1) clash = true;
      order.push(`${index}`);
      await new Promise((resolve) => { setTimeout(resolve, 30); });
      going.set(name, going.get(name)! - 1);
    }, (name) => (name.startsWith("rust") ? name : undefined));
    expect(clash).toBe(false);
    // The second rust:a job waits; ts:b and ts:c start before it.
    expect(order.slice(0, 3)).toEqual(["0", "2", "4"]);
  });

  it("returns results in the order the jobs were given, whichever finished first", async () => {
    const finished: number[] = [];
    const out = await inPool([300, 10, 150, 0], 4, async (ms, index) => {
      await new Promise((resolve) => { setTimeout(resolve, ms); });
      finished.push(index);
      return `job ${index}`;
    });
    expect(out).toEqual(["job 0", "job 1", "job 2", "job 3"]);
    expect(finished).not.toEqual([0, 1, 2, 3]);
  });

  it("never runs more jobs at once than it is given workers", async () => {
    let going = 0;
    let most = 0;
    await inPool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      going += 1;
      most = Math.max(most, going);
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      going -= 1;
    });
    expect(most).toBe(3);
  });

  it("takes --jobs over BOARD_AI_JOBS, and refuses a count that is not one or more", () => {
    const was = process.env.BOARD_AI_JOBS;
    try {
      process.env.BOARD_AI_JOBS = "5";
      expect(jobsFrom(["--jobs=2"])).toBe(2);
      expect(jobsFrom([])).toBe(5);
      expect(() => jobsFrom(["--jobs=0"])).toThrow(/whole number/);
    } finally {
      if (was === undefined) delete process.env.BOARD_AI_JOBS; else process.env.BOARD_AI_JOBS = was;
    }
  });
});

describe("slots shared between runs", () => {
  it("never lets more jobs hold slots than there are, nor two with the same name, and serves the longest first", async () => {
    const dir = path.join(scratch, "slots");
    makeSlots(dir, 2);
    process.env.BOARD_AI_SLOTS = dir;
    try {
      let going = 0;
      let most = 0;
      const rust = new Set<number>();
      let clash = false;
      const started: string[] = [];
      const job = (name: string, ms: number, apart?: string) => withSlot(ms, async () => {
        started.push(name);
        going += 1;
        most = Math.max(most, going);
        if (apart) { if (rust.size > 0) clash = true; rust.add(1); }
        await new Promise((resolve) => { setTimeout(resolve, 300); });
        if (apart) rust.clear();
        going -= 1;
      }, apart);
      // Two slots, both taken first, so the rest queue and are served by expectation.
      const first = [job("hold-1", 1), job("hold-2", 1)];
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      await Promise.all([...first, job("short", 10), job("long", 9_000), job("crate-1", 5_000, "rust:x"), job("crate-2", 4_000, "rust:x")]);
      expect(most).toBe(2);
      expect(clash).toBe(false);
      expect(started.slice(2, 4).sort()).toEqual(["crate-1", "long"]);
    } finally {
      delete process.env.BOARD_AI_SLOTS;
    }
  }, 30_000);
});

describe("a worker process", () => {
  it("hands back what it sent", async () => {
    const got = await runWorker<{ n: number }>(worker(`await sendResult({ n: 41 + 1 });`), [], { execArgv: TS });
    expect(got).toMatchObject({ ok: true, value: { n: 42 } });
  }, 30_000);

  it("is stopped when it has answered and does not exit", async () => {
    // A language server stuck in its own shutdown holds a process open just like this.
    const file = worker(`process.send!({ done: true }); setInterval(() => {}, 1000);`);
    const began = Date.now();
    const got = await runWorker<{ done: boolean }>(file, [], { graceMs: 500, execArgv: TS });
    expect(got).toMatchObject({ ok: true, value: { done: true } });
    expect(Date.now() - began).toBeLessThan(15_000);
  }, 30_000);

  it("is a failure, with how it ended, when it exits without answering", async () => {
    const got = await runWorker(worker(`process.exit(7);`), [], { execArgv: TS });
    expect(got).toMatchObject({ ok: false });
    expect(got.ok ? "" : got.why).toContain("with 7");
  }, 30_000);
});

describe("which worker asks which arrows", () => {
  const key = (project: string, n: number): Key => ({
    board: "b", project, topic: `${project}-topic`, language: "rust", scope: "", pin: "", tool: "",
    claims: Array.from({ length: n }, (_, i) => ({
      id: `c${i}`, word: "calls", from: "a", to: "b", fromLabel: "", toLabel: "", language: "rust",
      source: "drawn", truth: "true", why: "",
    })),
  });
  const keys = [key("slow", 6), key("quick", 4)];
  const job = (project: string, index: number, n: number): ProjectJob => ({
    kind: "project", project, share: 0, shares: 1, claims: Array.from({ length: n }, (_, i): [number, number] => [index, i]),
  });

  function timed(ms: Record<string, number>): JobTimes {
    const dir = mkdtempSync(path.join(scratch, "times-"));
    // Written as the file keeps them: by a hash of project, topic and claim id.
    const hashed = Object.fromEntries(Object.entries(ms).map(([name, n]) => [createHash("sha1").update(name).digest("hex").slice(0, 16), n]));
    writeFileSync(path.join(dir, "main.json"), JSON.stringify(hashed));
    process.env.BOARD_AI_BENCH_TIMES = dir;
    try {
      return new JobTimes("main", keys);
    } finally {
      delete process.env.BOARD_AI_BENCH_TIMES;
    }
  }

  it("splits a project far longer than its fair share, and asks each share's arrows in report order", () => {
    // slow: three arrows of 100 s and three of 1 s; quick: four of 1 s.
    const times = timed({
      "slow|slow-topic|c0": 100_000, "slow|slow-topic|c1": 1_000, "slow|slow-topic|c2": 100_000,
      "slow|slow-topic|c3": 1_000, "slow|slow-topic|c4": 100_000, "slow|slow-topic|c5": 1_000,
    });
    const plan = times.plan([job("slow", 0, 6), job("quick", 1, 4)], 4, []);
    const slow = plan.filter((one) => one.project === "slow");
    // 303 s against a fair share of 77 s: four shares.
    expect(slow.length).toBe(4);
    // Every arrow asked exactly once, by exactly one share.
    expect(slow.flatMap((one) => one.claims).map(([, at]) => at).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    // No two slow arrows in one share, and each share's arrows in report order.
    expect(slow.map((share) => share.claims.filter(([, at]) => at % 2 === 0).length).sort()).toEqual([0, 1, 1, 1]);
    for (const share of slow) {
      const order = share.claims.map(([, at]) => at);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
    // Longest first: each job's expected time never rises down the list.
    const costs = plan.map((one) => times.expect(one));
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
    expect(plan[0]!.project).toBe("slow");
  });

  it("leaves every project whole with --split=off, or with one worker", () => {
    const times = timed({ "slow|slow-topic|c0": 500_000 });
    expect(times.plan([job("slow", 0, 6), job("quick", 1, 4)], 4, ["--split=off"])).toHaveLength(2);
    expect(times.plan([job("slow", 0, 6), job("quick", 1, 4)], 1, [])).toHaveLength(2);
  });

  it("never splits a project the caller says cannot be, and splits nothing shorter than a given fair share", () => {
    const times = timed({ "slow|slow-topic|c0": 500_000 });
    expect(times.plan([job("slow", 0, 6), job("quick", 1, 4)], 4, [], { splittable: (one) => one.project !== "slow" })).toHaveLength(2);
    expect(times.plan([job("slow", 0, 6), job("quick", 1, 4)], 4, [], { minFairMs: 600_000 })).toHaveLength(2);
  });

  it("splits a project by hand with --split=<project>:<n>", () => {
    const times = timed({});
    const plan = times.plan([job("slow", 0, 6), job("quick", 1, 4)], 4, ["--split=quick:2"]);
    expect(plan.filter((one) => one.project === "quick")).toHaveLength(2);
    expect(plan.filter((one) => one.project === "slow")).toHaveLength(1);
  });
});
