/**
 * Whether another benchmark, measurement or test run is using the machine
 * (#403).
 *
 * One of these at a time across every session: two at once starve the
 * language servers and produce reds that have nothing to do with the change,
 * and a score taken under that load is not comparable with one taken without.
 *
 * Every home-made version of this check matched its own commands at least
 * once, and each time a session sat "busy" for 40 to 60 minutes with nothing
 * else running. `pgrep -f vitest` skips itself but not the shell that ran it,
 * nor a `grep vitest` beside it, nor a wrapper script whose arguments happen to
 * name a measure script. So this one is narrow on purpose:
 *
 * - **Only a node process counts.** The command must *start* with a node
 *   binary; a shell, an editor or a `grep` that merely mentions the words is
 *   not running anything.
 * - **This process, its ancestors and its descendants never count.** A
 *   bench waiting on itself, on the `npm run` that started it, or on the
 *   child it forked for the previous project is the self-match in another
 *   shape.
 * - **A process waiting for the machine is not running anything (#489).**
 *   It holds a ticket in the gate's queue (`machine-lock.ts`), and neither it
 *   nor the `tsx` wrapper above it running the same script counts. Two
 *   waiters that each counted the other deadlocked on 2026-11-02. So does
 *   `measure-queue-hold.mts`, the place holder of the home-made gate in
 *   `~/bench-477`, which waits on us while we would wait on it.
 *
 * - **A run in another lane is not in the way (2026-11-25).** With more
 *   than one lane (`machine-lock.ts`), a run that holds a lane does not wait
 *   on, or count as sharing, a run that holds another: the holder and
 *   everything below it are that lane's. A run started without the gate is
 *   still counted by everyone, and an ungated run counts everything.
 *
 * And `waitForQuiet` takes the machine before it looks (#489): a look alone
 * let two waiters see the same quiet second and both start.
 */
import { spawn } from "node:child_process";

import {
  heldLane, laneCount, laneHolders, logStart, loggedRuns, processes, stillGoing, takeMachine, waitingPids, type Proc,
} from "./machine-lock";

export interface BusyProcess { pid: number; command: string }

/*
 * Split so that this file's own text, read by a process listing (an editor
 * with it open, a `cat`), is not a match. `BOARD_AI_GATE_RUNS` replaces the
 * names, so a test can stand up runs nobody else on the machine counts.
 */
const NAMES = process.env.BOARD_AI_GATE_RUNS ?? `(${["bench-plan" + "ted", "measure-[a-z-]+"].join("|")})\\.mts|/vi${"test"}`;
const RUNS = new RegExp(`^\\S*node(\\s|$).*(${NAMES})`);
/** The script a run's command names, last mention first, so a wrapper and what it starts read alike. */
const scriptOf = (command: string) => [...command.matchAll(new RegExp(NAMES, "g"))].at(-1)?.[0];
/**
 * Not runs: the home-made gate's place in the queue and ours for it
 * (`holdPlace`), and `measure:batch` only reading finished results
 * (`--compare`, `--dry-run`) -- one such call during a batch marked a set
 * "SHARED" on 2026-11-25.
 */
const PLACE_HOLDER = /measure-(queue|gate)-hold|measure-batch\.mts\b.*--(compare|dry-run)/;

/** This process's own family: itself, every ancestor and every descendant. */
function family(all: Proc[], self: number): Set<number> {
  const byPid = new Map(all.map((row) => [row.pid, row]));
  const mine = new Set<number>([self]);
  for (let at = byPid.get(self)?.ppid; at !== undefined && at > 1 && !mine.has(at); at = byPid.get(at)?.ppid) {
    mine.add(at);
  }
  const below = new Set<number>([self]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of all) {
      if (!below.has(row.pid) && below.has(row.ppid)) { below.add(row.pid); grew = true; }
    }
  }
  for (const pid of below) mine.add(pid);
  return mine;
}

/** Waiting processes, and each one's wrappers: the ancestors right above it running the same script. */
function waiting(all: Proc[]): Set<number> {
  const byPid = new Map(all.map((row) => [row.pid, row]));
  const out = new Set<number>();
  for (const pid of waitingPids(all)) {
    out.add(pid);
    const script = scriptOf(byPid.get(pid)?.command ?? "");
    if (script === undefined) continue;
    for (let up = byPid.get(byPid.get(pid)!.ppid); up && !out.has(up.pid) && scriptOf(up.command) === script; up = byPid.get(up.ppid)) {
      out.add(up.pid);
    }
  }
  return out;
}

/**
 * Everything below the holders of the lanes `which` picks: each holder, its
 * descendants, and the wrappers above it running the same script.
 */
function belowHolders(all: Proc[], which: (run: string) => boolean): Set<number> {
  const out = new Set<number>();
  const byPid = new Map(all.map((row) => [row.pid, row]));
  for (const owner of laneHolders(all)) {
    if (!which(owner.run)) continue;
    out.add(owner.pid);
    // And the wrappers right above it running the same script (`tsx`, as for a waiter): the same run.
    const script = scriptOf(byPid.get(owner.pid)?.command ?? "");
    if (script !== undefined) {
      for (let up = byPid.get(byPid.get(owner.pid)?.ppid ?? -1); up && scriptOf(up.command) === script; up = byPid.get(up.ppid)) {
        out.add(up.pid);
      }
    }
    for (let grew = true; grew;) {
      grew = false;
      for (const row of all) if (!out.has(row.pid) && out.has(row.ppid)) { out.add(row.pid); grew = true; }
    }
  }
  return out;
}

/**
 * The processes of runs that hold another lane, when this run holds one.
 * Empty for a run that holds no lane, which shares the machine with every
 * other run.
 */
function otherLanes(all: Proc[]): Set<number> {
  if (heldLane() === undefined) return new Set();
  const mine = process.env.BOARD_AI_RUN;
  return belowHolders(all, (run) => run !== mine);
}

/**
 * This run's own processes beyond its ancestors and descendants: everything
 * below the lock its run holds. `measure:batch` starts several benches side
 * by side under one lock, and a sibling is the same measurement, not another
 * one -- counted as busy, each would wait for the others for ever.
 */
function ownRun(all: Proc[]): Set<number> {
  const mine = process.env.BOARD_AI_RUN;
  return mine === undefined ? new Set() : belowHolders(all, (run) => run === mine);
}

function busyIn(all: Proc[], self: number): Proc[] {
  const mine = family(all, self);
  for (const pid of ownRun(all)) mine.add(pid);
  const parked = waiting(all);
  const beside = otherLanes(all);
  return all.filter((row) => !mine.has(row.pid) && !parked.has(row.pid) && !beside.has(row.pid)
    && RUNS.test(row.command) && !PLACE_HOLDER.test(row.command));
}

/** Other runs that are using the machine now; empty when it is free. */
export function otherRuns(self: number = process.pid): BusyProcess[] {
  return busyIn(processes(), self).map(({ pid, command }) => ({ pid, command }));
}

/**
 * Take the machine (#489), then wait until no other run is using it, saying
 * what was waited on. Inside a gate, or on a second call, the machine is
 * already this run's and only the second half happens. `say` is called once
 * per new reason, not once per poll.
 */
export async function waitForQuiet(say: (line: string) => void, pollMs = 2_000,
  { onSignal = true, whole = false }: { onSignal?: boolean; whole?: boolean } = {}): Promise<void> {
  await takeMachine(process.argv.slice(1).join(" "), say, { pollMs: Math.min(pollMs, 1_000), onSignal, whole });
  let last = "";
  let hold: (() => void) | undefined;
  try {
    for (;;) {
      const busy = otherRuns();
      if (busy.length === 0) return;
      hold ??= holdPlace();
      const line = `waiting: another run is going -- pid ${busy[0]!.pid}: ${busy[0]!.command.slice(0, 120)}`;
      if (line !== last) say(line);
      last = line;
      await new Promise((resolve) => { setTimeout(resolve, pollMs); });
    }
  } finally {
    hold?.();
  }
}

/*
 * Until no brief names them, the home-made gates (`~/bench-477/when-quiet.sh`)
 * start a chain's next run the moment its last one ends, and they cannot see
 * the lock, so a holder waiting for that chain would wait until it ran dry
 * (2026-11-03, behind #484's holdout run). This shows them a run that is not
 * one, the same trick their own place holder plays on us: a node process
 * their check counts as busy, gone when we start or when this process dies.
 */
function holdPlace(): () => void {
  const watch = `const p = Number(process.argv[1]); setInterval(() => { try { process.kill(p, 0); } catch { process.exit(0); } }, 1000);`;
  const child = spawn(process.execPath, ["-e", watch, String(process.pid), "measure-gate-hold.mts", "--one=gate"], { stdio: "ignore" });
  child.unref();
  const stop = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
  process.once("exit", stop);
  return () => { stop(); process.removeListener("exit", stop); };
}

/** A measurement being recorded: `line()` says whether anything shared the machine with it so far. */
export interface Recorded { line: () => string; end: () => void }

/**
 * Write this measurement into the machine's shared log and watch for others
 * beside it (#489): runs that logged themselves, and every other run the busy
 * check would count, looked for every `sampleMs` and once more at `line()`.
 * Runs of the same tree (a gate and the bench it started, a census and its
 * per-project children) are one measurement and never count.
 */
export function recordRun(command: string, sampleMs = 10_000): Recorded {
  const at = Date.now();
  /* Whether this run held a lane when it started: it may have let go by the time `line()` is read. */
  const inLane = heldLane() !== undefined;
  const log = logStart(command, processes());
  const seen = new Map<number, Proc & { from: number; to: number }>();
  const sample = () => {
    const all = processes();
    const now = Date.now();
    for (const row of busyIn(all, process.pid)) {
      const had = seen.get(row.pid);
      if (had && had.started === row.started) had.to = now;
      else seen.set(row.pid, { ...row, from: now, to: now });
    }
  };
  sample();
  const timer = setInterval(sample, sampleMs);
  timer.unref();
  const clock = (ms: number) => new Date(ms).toLocaleTimeString("sv-SE");
  const line = () => {
    sample();
    const now = Date.now();
    const all = processes();
    const overlapping = loggedRuns().filter((one) => one.run !== process.env.BOARD_AI_RUN
      && one.at < now && (one.end ?? (stillGoing(one, all) ? now : one.at)) >= at);
    // A run in a lane of its own beside this one, when this one holds a lane too, is by design.
    const laned = heldLane() !== undefined || inLane;
    const beside = laned ? overlapping.filter((one) => one.lane !== undefined) : [];
    const runs = overlapping.filter((one) => !beside.includes(one));
    // One line per other run tree, its first process.
    const treesOf = (list: typeof overlapping) => {
      const trees = new Map<string, typeof overlapping[number]>();
      for (const one of list) if (!trees.has(one.run)) trees.set(one.run, one);
      return [...trees.values()].map((one) => `pid ${one.pid} ${clock(one.at)}-${one.end ? clock(one.end) : "on"}: ${one.command.slice(0, 80)}`);
    };
    const logged = new Set(overlapping.flatMap((one) => [one.pid, one.ppid]));
    const loose = [...seen.values()].filter((one) => !logged.has(one.pid) && !logged.has(one.ppid));
    const shared = [
      ...treesOf(runs),
      ...loose.map((one) => `pid ${one.pid} seen ${clock(one.from)}-${clock(one.to)}: ${one.command.slice(0, 80)}`),
    ];
    const neighbours = treesOf(beside);
    const lanesNote = neighbours.length === 0 ? ""
      : `; beside it in other gate lanes (${laneCount()} lanes): ${neighbours.slice(0, 3).join("; ")}`
        + (neighbours.length > 3 ? `; and ${neighbours.length - 3} more` : "");
    if (shared.length === 0) {
      return neighbours.length === 0 ? "machine: no other measurement ran during this one"
        : `machine: no ungated measurement ran during this one${lanesNote}`;
    }
    return `machine: SHARED -- ${shared.length} other run${shared.length === 1 ? "" : "s"} used this machine during this one,`
      + ` so its numbers are not comparable with a run taken alone: ${shared.slice(0, 3).join("; ")}`
      + (shared.length > 3 ? `; and ${shared.length - 3} more` : "") + lanesNote;
  };
  return { line, end: () => { clearInterval(timer); log.end(); } };
}
