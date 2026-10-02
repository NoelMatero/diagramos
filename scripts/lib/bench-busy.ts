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
 */
import { execFileSync } from "node:child_process";

export interface BusyProcess { pid: number; command: string }

/*
 * Split so that this file's own text, read by a process listing (an editor
 * with it open, a `cat`), is not a match.
 */
const RUNS = new RegExp(
  "^\\S*node(\\s|$).*(" + ["bench-plan" + "ted", "measure-[a-z-]+"].join("|") + ")\\.mts"
  + "|^\\S*node(\\s|$).*/vi" + "test",
);

interface Row { pid: number; ppid: number; command: string }

function rows(): Row[] {
  let listing: string;
  try {
    listing = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  return listing.split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
}

/** This process's own family: itself, every ancestor and every descendant. */
function family(all: Row[], self: number): Set<number> {
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

/** Other runs that are using the machine now; empty when it is free. */
export function otherRuns(self: number = process.pid): BusyProcess[] {
  const all = rows();
  const mine = family(all, self);
  return all
    .filter((row) => !mine.has(row.pid) && RUNS.test(row.command))
    .map(({ pid, command }) => ({ pid, command }));
}

/**
 * Wait until no other run is using the machine, saying what was waited on.
 * `say` is called once per new reason, not once per poll.
 */
export async function waitForQuiet(say: (line: string) => void, pollMs = 30_000): Promise<void> {
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
