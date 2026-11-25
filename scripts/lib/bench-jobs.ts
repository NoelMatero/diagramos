/**
 * Which worker asks which arrows, for `bench-planted.mts`'s pool.
 *
 * A run is only as short as its longest job. On 2026-11-25 one main-set
 * project, regex, was 431 s of a 1,036 s run -- three of its 37 arrows took
 * 100 s each -- so with every project in a worker of its own the run still
 * waited seven minutes on regex alone. So:
 *
 * - **Longest first.** Each arrow's time from the last run is remembered, per
 *   set, in `~/.board-ai-cache/bench-times/<set>.json` (by a hash of the
 *   claim, never the arrow itself), and jobs start in order of how long they
 *   took then. An arrow never timed counts a second.
 * - **A project longer than its fair share is split** into shares of about
 *   the same time, each in a worker of its own with its own workspace, cache
 *   and servers. Not a Rust project: its jobs never run at once anyway
 *   (`workers.ts`), so its shares would only pay rust-analyzer's start again.
 *   Inside `measure:batch` a fair share is at least ten minutes: the batch
 *   is as long as all its work spread over the slots, and only a project
 *   longer than that is worth splitting. Every arrow is asked on a board of its own, and what a
 *   project's cache holds is only what was read off disk (#311), so which
 *   worker asks an arrow does not change its answer; the identity runs that
 *   proved this are in the PR. `--split=off` turns it off,
 *   `--split=<project>:<n>[,...]` sets a project's shares by hand.
 *
 * Within a share, arrows are asked in report order, as they always were.
 *
 * Measurement only. Nothing in `src/` uses this.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Key, KeyClaim } from "./planted-keys";

/** One project's arrows, or one share of them, as [key, claim] indices among all the keys. */
export interface ProjectJob {
  kind: "project";
  project: string;
  share: number;
  shares: number;
  claims: Array<[key: number, claim: number]>;
}

/** An arrow nobody has timed yet is taken to cost this much. */
const UNTIMED_MS = 1_000;
/** A project is split only when it would otherwise run this much longer than a fair share. */
const SPLIT_ABOVE = 1.25;
/** And never into shares shorter than this: each share pays its own servers' start. */
const MIN_SHARE_MS = 60_000;

export const timesDir = (): string => process.env.BOARD_AI_BENCH_TIMES ?? path.join(os.homedir(), ".board-ai-cache", "bench-times");

export class JobTimes {
  private readonly file: string;
  private readonly known: Record<string, number>;
  private readonly fresh: Record<string, number> = {};

  constructor(set: string, private readonly keys: readonly Key[]) {
    this.file = path.join(timesDir(), `${set}.json`);
    let known: Record<string, number> = {};
    try {
      if (existsSync(this.file)) known = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, number>;
    } catch { /* unreadable: every arrow untimed */ }
    this.known = known;
  }

  /**
   * An arrow's name in the times file: a hash, because a claim's id spells
   * out the arrow, and a score-only set's arrows are never written out.
   */
  private name(key: Key, claim: KeyClaim): string {
    return createHash("sha1").update(`${key.project}|${key.topic}|${claim.id}`).digest("hex").slice(0, 16);
  }

  /** How long one arrow took the last time it was asked. */
  of(index: number, at: number): number {
    const key = this.keys[index]!;
    return this.known[this.name(key, key.claims[at]!)] ?? UNTIMED_MS;
  }

  expect(job: ProjectJob): number {
    return job.claims.reduce((sum, [index, at]) => sum + this.of(index, at), 0);
  }

  record(key: Key, claim: KeyClaim, ms: number): void {
    this.fresh[this.name(key, claim)] = Math.round(ms);
  }

  /** Keep this run's times beside the ones it did not ask. Never fails a run. */
  save(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const next = `${this.file}.${process.pid}`;
      writeFileSync(next, JSON.stringify({ ...this.known, ...this.fresh }));
      renameSync(next, this.file);
    } catch { /* a run's score never depends on its timing notes */ }
  }

  /**
   * The project jobs as the pool should start them: heavy projects split
   * into shares (unless `--split=off`), then longest first.
   */
  plan(projects: readonly ProjectJob[], workers: number, argv: readonly string[],
    { splittable = () => true, minFairMs = MIN_SHARE_MS }: { splittable?: (job: ProjectJob) => boolean; minFairMs?: number } = {}): ProjectJob[] {
    const given = argv.find((one) => one.startsWith("--split="))?.slice("--split=".length);
    const byHand = new Map<string, number>();
    if (given && given !== "off" && given !== "auto") {
      for (const part of given.split(",")) {
        const [project, n] = part.split(":");
        if (!project || !Number.isInteger(Number(n)) || Number(n) < 1) throw new Error(`--split=${given}: want off, auto, or <project>:<n>[,...]`);
        byHand.set(project, Number(n));
      }
    }
    const auto = given === undefined || given === "auto";
    const total = projects.reduce((sum, job) => sum + this.expect(job), 0);
    const fair = Math.max(total / Math.max(1, workers), minFairMs);
    const out: ProjectJob[] = [];
    for (const job of projects) {
      const cost = this.expect(job);
      const shares = Math.min(job.claims.length, byHand.get(job.project)
        ?? (auto && workers > 1 && splittable(job) && cost > SPLIT_ABOVE * fair ? Math.min(workers, Math.ceil(cost / fair)) : 1));
      out.push(...this.share(job, shares));
    }
    return out.sort((a, b) => this.expect(b) - this.expect(a));
  }

  /** `n` shares of about the same time: each arrow, slowest first, to the share with the least so far. */
  private share(job: ProjectJob, n: number): ProjectJob[] {
    if (n <= 1) return [job];
    const order = job.claims.map((claim, position) => ({ claim, position, ms: this.of(claim[0], claim[1]) }))
      .sort((a, b) => b.ms - a.ms || a.position - b.position);
    const shares = Array.from({ length: n }, () => ({ ms: 0, picked: [] as typeof order }));
    for (const one of order) {
      const least = shares.reduce((best, share) => (share.ms < best.ms ? share : best));
      least.ms += one.ms;
      least.picked.push(one);
    }
    return shares.filter((share) => share.picked.length > 0).map((share, index, all) => ({
      kind: "project",
      project: job.project,
      share: index,
      shares: all.length,
      // Report order within a share, as one worker would have asked them.
      claims: share.picked.sort((a, b) => a.position - b.position).map((one) => one.claim),
    }));
  }
}

/**
 * The same remembered times for a run whose jobs are whole projects
 * (`measure:compiler-true`): `<name>.json` beside the bench's, project by
 * project. A project never timed counts a minute.
 */
export function projectTimes(name: string): { of(project: string): number; record(project: string, ms: number): void; save(): void } {
  const file = path.join(timesDir(), `${name}.json`);
  let known: Record<string, number> = {};
  try {
    if (existsSync(file)) known = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
  } catch { /* unreadable: every project untimed */ }
  const fresh: Record<string, number> = {};
  return {
    of: (project) => known[project] ?? 60_000,
    record: (project, ms) => { fresh[project] = Math.round(ms); },
    save: () => {
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(`${file}.${process.pid}`, JSON.stringify({ ...known, ...fresh }));
        renameSync(`${file}.${process.pid}`, file);
      } catch { /* timing notes never fail a run */ }
    },
  };
}
