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
 * And `waitForQuiet` takes the machine before it looks (#489): a look alone
 * let two waiters see the same quiet second and both start.
 */
import { logStart, loggedRuns, processes, stillGoing, takeMachine, waitingPids, type Proc } from "./machine-lock";

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
const PLACE_HOLDER = /measure-queue-hold/;

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

function busyIn(all: Proc[], self: number): Proc[] {
  const mine = family(all, self);
  const parked = waiting(all);
  return all.filter((row) => !mine.has(row.pid) && !parked.has(row.pid) && RUNS.test(row.command) && !PLACE_HOLDER.test(row.command));
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
  { onSignal = true }: { onSignal?: boolean } = {}): Promise<void> {
  await takeMachine(process.argv.slice(1).join(" "), say, { pollMs: Math.min(pollMs, 1_000), onSignal });
  let last = "";
  for (;;) {
    const busy = otherRuns();
    if (busy.length === 0) return;
    const line = `waiting: another run is going -- pid ${busy[0]!.pid}: ${busy[0]!.command.slice(0, 120)}`;
    if (line !== last) say(line);
    last = line;
    await new Promise((resolve) => { setTimeout(resolve, pollMs); });
  }
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
    const runs = loggedRuns().filter((one) => one.run !== process.env.BOARD_AI_RUN
      && one.at < now && (one.end ?? (stillGoing(one, all) ? now : one.at)) >= at);
    // One line per other run tree, its first process.
    const trees = new Map<string, typeof runs[number]>();
    for (const one of runs) if (!trees.has(one.run)) trees.set(one.run, one);
    const logged = new Set(runs.flatMap((one) => [one.pid, one.ppid]));
    const loose = [...seen.values()].filter((one) => !logged.has(one.pid) && !logged.has(one.ppid));
    const shared = [
      ...[...trees.values()].map((one) => `pid ${one.pid} ${clock(one.at)}-${one.end ? clock(one.end) : "on"}: ${one.command.slice(0, 80)}`),
      ...loose.map((one) => `pid ${one.pid} seen ${clock(one.from)}-${clock(one.to)}: ${one.command.slice(0, 80)}`),
    ];
    if (shared.length === 0) return "machine: no other measurement ran during this one";
    return `machine: SHARED -- ${shared.length} other run${shared.length === 1 ? "" : "s"} used this machine during this one,`
      + ` so its numbers are not comparable with a run taken alone: ${shared.slice(0, 3).join("; ")}`
      + (shared.length > 3 ? `; and ${shared.length - 3} more` : "");
  };
  return { line, end: () => { clearInterval(timer); log.end(); } };
}
