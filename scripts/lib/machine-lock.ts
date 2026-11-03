/**
 * One measurement at a time on this machine, first come first served (#489).
 *
 * ## The bad outcome
 *
 * Every home-made gate was a busy check followed by a start: wait until no
 * bench, measure script or vitest is running, then go. Two gates waiting on
 * the same run both saw it end within the same second and both started
 * (2026-11-02: #486's `npm test` beside #484's holdout bench), and nothing
 * recorded that it happened, so the score looked clean. And a bench started
 * behind one gate deadlocked with another gate's place holder, each counting
 * the other as busy.
 *
 * ## The rule
 *
 * - **A lock, not a look.** `mkdir` is atomic: of two processes that try at
 *   once, one creates the directory and the other gets EEXIST. The holder
 *   writes who it is (pid, the start time `ps` gives that pid, the run it
 *   belongs to) into `owner.json`, renamed into place so a reader sees all of
 *   it or none. It is removed when the holder exits.
 * - **A dead holder's lock is taken over.** The owner is dead when no process
 *   has that pid with that start time, so a pid the system handed out again
 *   is not mistaken for the holder. A lock with no owner file is one being
 *   written, unless it is older than `UNWRITTEN_MS`. Taking over happens under
 *   a second `mkdir` (`takeover/`), and the owner is read again inside it, so
 *   two takers cannot both remove the lock and a fresh one cannot be removed
 *   for a stale one.
 * - **A queue, in order of arrival.** A waiter writes a ticket into
 *   `waiting/`, named by the time it arrived, and only the oldest live ticket
 *   tries for the lock. A ticket is also how a waiting process says "I am not
 *   running anything": the busy check (`bench-busy.ts`) does not count it.
 * - **A run is a tree.** `BOARD_AI_RUN` names the run a process belongs to and
 *   is passed down to everything it starts. The lock records it, so a bench a
 *   gate started sees that the lock is its own run's and does not wait on it,
 *   however many processes (npm, a shell, `caffeinate`) sit in between.
 * - **Overlap is written down.** Every measurement appends its start and end
 *   to `runs.jsonl`, so a run can say afterwards whether another one shared
 *   the machine with it, gated or not.
 *
 * The directory is `~/.board-ai-gate`, one per machine and shared by every
 * worktree and session; `BOARD_AI_GATE_DIR` moves it (the tests do).
 *
 * Measurement only. Nothing in `src/` uses this.
 */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

/** A lock directory with no owner file this long after it was made is a holder that died writing it. */
const UNWRITTEN_MS = 30_000;

export function gateDir(): string {
  return process.env.BOARD_AI_GATE_DIR ?? path.join(os.homedir(), ".board-ai-gate");
}
const lockPath = () => path.join(gateDir(), "lock");
const takeoverPath = () => path.join(gateDir(), "takeover");
const waitingPath = () => path.join(gateDir(), "waiting");
export const runsLogPath = () => path.join(gateDir(), "runs.jsonl");

/** A process as `ps` lists it. `started` is its start time, which a reused pid does not share. */
export interface Proc { pid: number; ppid: number; started: string; command: string }

/** Every process on the machine, in one `ps` call. Empty if `ps` fails. */
export function processes(): Proc[] {
  let listing: string;
  try {
    // `lstart` is five words wide on macOS and Linux alike: "Tue Nov  3 10:00:00 2026".
    listing = execFileSync("ps", ["-axo", "pid=,ppid=,lstart=,command="], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" },
    });
  } catch {
    return [];
  }
  const out: Proc[] = [];
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line);
    if (match) out.push({ pid: Number(match[1]), ppid: Number(match[2]), started: match[3]!.replace(/\s+/g, " "), command: match[4]! });
  }
  return out;
}

/** Whether `pid` is still the process that started at `started`. */
function alive(all: Proc[], pid: number, started: string): boolean {
  return all.some((one) => one.pid === pid && one.started === started);
}

function self(all: Proc[]): Proc | undefined {
  return all.find((one) => one.pid === process.pid);
}

/** The run this process belongs to, made up here (and passed to children) if nobody above made one. */
export function runId(): string {
  process.env.BOARD_AI_RUN ??= `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  return process.env.BOARD_AI_RUN;
}

export interface Owner { pid: number; started: string; run: string; command: string; since: number }

function readOwner(): Owner | undefined {
  try {
    return JSON.parse(readFileSync(path.join(lockPath(), "owner.json"), "utf8")) as Owner;
  } catch {
    return undefined;
  }
}

function ageMs(dir: string): number | undefined {
  try {
    return Date.now() - statSync(dir).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Who holds the machine: `undefined` when nobody does, or the holder is dead. */
export function holder(all: Proc[] = processes()): Owner | "being written" | undefined {
  const owner = readOwner();
  if (owner) return alive(all, owner.pid, owner.started) ? owner : undefined;
  const age = ageMs(lockPath());
  if (age === undefined) return undefined;
  return age < UNWRITTEN_MS ? "being written" : undefined;
}

/** Remove a lock whose holder is dead, unless somebody else is doing so or it changed hands meanwhile. */
function takeOver(seen: Owner | undefined): void {
  try {
    mkdirSync(takeoverPath());
  } catch {
    // Another taker is in the middle of it. One that died there is cleared after a while.
    if ((ageMs(takeoverPath()) ?? 0) > UNWRITTEN_MS) rmSync(takeoverPath(), { recursive: true, force: true });
    return;
  }
  try {
    const now = readOwner();
    const same = now === undefined
      ? seen === undefined && (ageMs(lockPath()) ?? 0) >= UNWRITTEN_MS
      : seen !== undefined && now.pid === seen.pid && now.started === seen.started && now.run === seen.run;
    if (same && holder() === undefined) rmSync(lockPath(), { recursive: true, force: true });
  } finally {
    rmSync(takeoverPath(), { recursive: true, force: true });
  }
}

let releaseHooked = false;

/** Take the lock if it is free or its holder is dead. True when this process now holds it. */
function tryLock(all: Proc[], command: string, onSignal: boolean): boolean {
  const me = self(all);
  if (!me) return false;
  if (holder(all) === undefined && ageMs(lockPath()) !== undefined) takeOver(readOwner());
  try {
    mkdirSync(lockPath());
  } catch {
    return false;
  }
  const owner: Owner = { pid: process.pid, started: me.started, run: runId(), command, since: Date.now() };
  const file = path.join(lockPath(), "owner.json");
  writeFileSync(`${file}.${process.pid}`, JSON.stringify(owner));
  renameSync(`${file}.${process.pid}`, file);
  if (!releaseHooked) {
    releaseHooked = true;
    process.once("exit", releaseLock);
    // A signal's default action skips "exit"; let go first, then die of it as before.
    if (onSignal) {
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.once(signal, () => { releaseLock(); process.kill(process.pid, signal); });
      }
    }
  }
  return true;
}

/** Let go of the lock, if this process holds it. Safe to call twice. */
export function releaseLock(): void {
  const owner = readOwner();
  if (owner && owner.pid === process.pid) rmSync(lockPath(), { recursive: true, force: true });
}

/** Whether this process's run holds the machine: it took the lock, or something above it did. */
export function runHoldsLock(): boolean {
  const owner = readOwner();
  return owner !== undefined && owner.run === process.env.BOARD_AI_RUN;
}

interface Ticket { pid: number; started: string; file: string }

function tickets(all: Proc[]): Ticket[] {
  let names: string[];
  try {
    names = readdirSync(waitingPath()).sort();
  } catch {
    return [];
  }
  const out: Ticket[] = [];
  for (const name of names) {
    const file = path.join(waitingPath(), name);
    let ticket: { pid: number; started: string };
    try {
      ticket = JSON.parse(readFileSync(file, "utf8")) as { pid: number; started: string };
    } catch {
      continue;
    }
    if (alive(all, ticket.pid, ticket.started)) out.push({ ...ticket, file });
    else try { unlinkSync(file); } catch { /* another reader cleared it */ }
  }
  return out;
}

/** The pids that are waiting for the machine, and so are not running anything. */
export function waitingPids(all: Proc[]): Set<number> {
  return new Set(tickets(all).map((one) => one.pid));
}

/**
 * Wait for the lock, in order of arrival, and keep it until this process
 * exits. Returns at once when this process's run already holds it.
 * `say` hears who is ahead, once per change. `onSignal: false` is for a
 * caller that handles signals itself and lets go on its own "exit" (the
 * gate, which must outlive its child).
 */
export async function takeMachine(command: string, say: (line: string) => void,
  { pollMs = 1_000, onSignal = true }: { pollMs?: number; onSignal?: boolean } = {}): Promise<void> {
  if (runHoldsLock()) return;
  runId();
  const all = processes();
  const me = self(all);
  if (!me) throw new Error("the gate cannot find its own process in `ps`");
  mkdirSync(waitingPath(), { recursive: true });
  const name = `${String(Date.now()).padStart(15, "0")}-${String(process.pid).padStart(8, "0")}.json`;
  const mine = path.join(waitingPath(), name);
  writeFileSync(mine, JSON.stringify({ pid: process.pid, started: me.started }));
  const drop = () => { try { unlinkSync(mine); } catch { /* gone */ } };
  process.once("exit", drop);
  let last = "";
  try {
    for (;;) {
      const now = processes();
      const queue = tickets(now);
      const first = queue[0]?.file === mine;
      if (first && tryLock(now, command, onSignal)) return;
      const held = holder(now);
      const line = held === "being written" ? "waiting: the machine is being taken by another run"
        : held ? `waiting: the machine is held by pid ${held.pid} since ${new Date(held.since).toLocaleTimeString("sv-SE")}: ${held.command.slice(0, 100)}`
        : first ? "waiting: the machine is being let go" : `waiting: ${queue.findIndex((one) => one.file === mine)} ahead in the queue`;
      if (line !== last) say(line);
      last = line;
      await new Promise((resolve) => { setTimeout(resolve, pollMs); });
    }
  } finally {
    drop();
    process.removeListener("exit", drop);
  }
}

/** One measurement, as the shared log has it. */
export interface LoggedRun { id: string; run: string; pid: number; ppid: number; started: string; command: string; at: number; end?: number }

function appendLog(entry: object): void {
  try {
    mkdirSync(gateDir(), { recursive: true });
    appendFileSync(runsLogPath(), `${JSON.stringify(entry)}\n`);
  } catch { /* a log that cannot be written leaves the run unmarked, never stopped */ }
}

/** Write this measurement's start to the shared log; the returned call writes its end. */
export function logStart(command: string, all: Proc[]): { id: string; at: number; end: () => void } {
  const id = randomBytes(6).toString("hex");
  const me = self(all);
  const at = Date.now();
  appendLog({ kind: "start", id, run: runId(), pid: process.pid, ppid: process.ppid, started: me?.started ?? "", command, at });
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    appendLog({ kind: "end", id, at: Date.now() });
  };
  process.once("exit", end);
  return { id, at, end };
}

/** Every measurement in the shared log, with its end where one was written. */
export function loggedRuns(): LoggedRun[] {
  let text: string;
  try {
    text = readFileSync(runsLogPath(), "utf8");
  } catch {
    return [];
  }
  const runs = new Map<string, LoggedRun>();
  for (const line of text.split("\n")) {
    let entry: { kind: string; id: string; at: number } & Partial<LoggedRun>;
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.kind === "start") runs.set(entry.id, entry as LoggedRun);
    else if (entry.kind === "end") { const run = runs.get(entry.id); if (run) run.end = entry.at; }
  }
  return [...runs.values()];
}

/** Whether a logged run with no end is still going (it may also have died without writing one). */
export function stillGoing(run: LoggedRun, all: Proc[]): boolean {
  return alive(all, run.pid, run.started);
}
