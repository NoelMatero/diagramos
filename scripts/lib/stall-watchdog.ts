/**
 * A measurement run that has stopped moving is stopped, named and passed by
 * (#486).
 *
 * ## The bad outcome
 *
 * A language server can stop answering without exiting. Every question then
 * waits out its own timeout, the next one does the same, and the run sits at
 * 0% CPU for as long as anybody lets it: #470's `bench:planted` sat 23 h on a
 * pyright at 0% CPU, #471's census sat 2 h on actix's rust-analyzer (21 s of
 * CPU in all) and then recorded actix with answers missing. Runs take turns on
 * this machine, so every queued run waited behind it.
 *
 * A wall-clock limit cannot fix that. The census has one (90 min a project,
 * 30x a normal one) and it still cannot tell a hang from a Mac asleep: axum
 * once took 67,351 s of wall clock while the machine slept.
 *
 * ## The rule
 *
 * Stalled means: for `windowMs` of *awake* time, nothing was answered and the
 * process with everything it started (the language servers, `npx`'s wrapper,
 * a proc-macro server) used less than `minCpuMs` of CPU between them. Either
 * one is progress. A slow server that answers is never stalled, and neither
 * is one busy indexing at full CPU that has not answered yet.
 *
 * - **Awake time** is counted from the watchdog's own ticks. Each tick adds
 *   the time since the last one, at most two tick lengths. A Mac asleep runs
 *   no timers, so the tick after a wake sees one huge gap and counts two
 *   ticks of it; the rest is reported as slept and never counted. A clock
 *   cannot do this on its own: Node's `hrtime` on macOS keeps counting through
 *   sleep (measured 2026-11-02: equal to the wall clock since boot after 833
 *   sleeps).
 * - **CPU** comes from `ps -A -o pid=,ppid=,time=`, which every Unix has, for
 *   this process's descendants, and from `process.cpuUsage()` for itself.
 *   Only growth counts, per process, so a server that exits does not read as
 *   negative work and a new one counts from zero.
 * - **On a stall**, every descendant and its process group is sent SIGKILL
 *   (servers lead groups of their own, `server-process.ts`) and the caller's
 *   `onStall` decides what failed. The clock starts over afterwards.
 *
 * The timer is `unref`'d: it never keeps a finished run alive, and a run that
 * is held open only by a server that will not exit is exactly what it kills.
 *
 * Measurement only. Nothing in `src/` uses this.
 */
import { execFileSync } from "node:child_process";

/** The exit code of a census child the watchdog stopped, so the parent can say why. */
export const STALLED_EXIT = 75;

export const DEFAULT_STALL_MINUTES = 10;

/** `--stall-min=<minutes>` from a script's arguments, fractions allowed. */
export function stallWindowMs(argv: readonly string[]): number {
  const given = argv.find((one) => one.startsWith("--stall-min="))?.slice("--stall-min=".length);
  const minutes = given === undefined ? DEFAULT_STALL_MINUTES : Number(given);
  if (!(minutes > 0)) throw new Error(`--stall-min=${given}: want a number of minutes above 0`);
  return minutes * 60_000;
}

/**
 * `ps`'s `time` column in milliseconds. macOS writes `[hh:]mm:ss.cc`, Linux
 * `[dd-]hh:mm:ss`; both are colon-separated with an optional day count.
 */
export function cpuTimeMs(text: string): number {
  const trimmed = text.trim();
  const [days, rest] = trimmed.includes("-") ? trimmed.split("-", 2) as [string, string] : ["0", trimmed];
  const parts = rest.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Math.round((Number(days) * 86_400 + seconds) * 1000);
}

export interface ProcessRow { pid: number; ppid: number; cpuMs: number; command: string }

/** Every process, or none where there is no `ps` (Windows). */
const PS_ARGS = ["-A", "-ww", "-o", "pid=,ppid=,time=,args="];

export function processRows(): ProcessRow[] {
  let listing: string;
  try {
    listing = execFileSync("ps", PS_ARGS, {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  return listing.split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(([, pid, ppid, time, command]) => ({ pid: Number(pid), ppid: Number(ppid), cpuMs: cpuTimeMs(time!), command: command! }))
    // The listing's own `ps`, gone by the time anybody reads this: its pid is free to be reused.
    .filter((row) => !(row.ppid === process.pid && row.command === `ps ${PS_ARGS.join(" ")}`));
}

/** Every process below `root`, children before grandchildren. */
export function descendantsOf(rows: readonly ProcessRow[], root: number): ProcessRow[] {
  const below: ProcessRow[] = [];
  const seen = new Set<number>([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (!seen.has(row.pid) && seen.has(row.ppid)) { seen.add(row.pid); below.push(row); grew = true; }
    }
  }
  return below;
}

/**
 * The decision, without processes or timers, so it can be tested on numbers.
 * Fed one look per tick: the wall time, the CPU used since the last look, and
 * whether anything was answered since then.
 */
export class StallClock {
  private idleAwakeMs = 0;
  private idleCpuMs = 0;
  private lastWall: number;

  constructor(
    private readonly options: { windowMs: number; minCpuMs: number; tickMs: number },
    wallNow: number,
  ) {
    this.lastWall = wallNow;
  }

  /** What one look found: whether the run is stalled, and how much of the gap was not awake. */
  look(wallNow: number, cpuGrewMs: number, answered: boolean): { stalled: boolean; sleptMs: number; idleAwakeMs: number; idleCpuMs: number } {
    const gap = Math.max(0, wallNow - this.lastWall);
    this.lastWall = wallNow;
    const counted = Math.min(gap, 2 * this.options.tickMs);
    const sleptMs = gap - counted;
    this.idleAwakeMs += counted;
    this.idleCpuMs += cpuGrewMs;
    const seen = { idleAwakeMs: this.idleAwakeMs, idleCpuMs: this.idleCpuMs };
    if (answered || this.idleCpuMs >= this.options.minCpuMs) {
      this.idleAwakeMs = 0;
      this.idleCpuMs = 0;
      return { stalled: false, sleptMs, ...seen };
    }
    if (this.idleAwakeMs < this.options.windowMs) return { stalled: false, sleptMs, ...seen };
    this.idleAwakeMs = 0;
    this.idleCpuMs = 0;
    return { stalled: true, sleptMs, ...seen };
  }
}

export interface Stall {
  /** One line for a log: how long nothing moved, and what was killed. */
  reason: string;
  killed: ProcessRow[];
}

export interface StallWatchdogOptions {
  /** Awake time with no answer and no work before the run counts as stalled. */
  windowMs: number;
  /** Less CPU than this over the window, for the whole tree, is no work. Default 5% of the window, at least 1 s. */
  minCpuMs?: number;
  /** How often to look. Default a fortieth of the window, between 0.2 s and 15 s. */
  tickMs?: number;
  /** Where the watchdog's own notes go: a stall, a sleep it did not count. */
  say: (line: string) => void;
  /** Called after the processes below this one were killed. */
  onStall: (stall: Stall) => void;
}

export interface StallWatchdog {
  /** A question came back with an answer. */
  answered(): void;
  stop(): void;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

/** A short name for a killed process: its program's base name. */
function nameOf(row: ProcessRow): string {
  const program = row.command.split(/\s+/)[0] ?? "";
  return `${program.split("/").pop() || program} (pid ${row.pid})`;
}

function killTree(rows: readonly ProcessRow[]): void {
  for (const row of rows) {
    // A server leads its own group (`server-process.ts`); the group reaches what it started.
    try { process.kill(-row.pid, "SIGKILL"); } catch { /* not a group leader, or gone */ }
    try { process.kill(row.pid, "SIGKILL"); } catch { /* gone */ }
  }
}

export function watchForStall(options: StallWatchdogOptions): StallWatchdog {
  const windowMs = options.windowMs;
  const minCpuMs = options.minCpuMs ?? Math.max(1000, windowMs / 20);
  const tickMs = options.tickMs ?? Math.min(15_000, Math.max(200, windowMs / 40));
  const clock = new StallClock({ windowMs, minCpuMs, tickMs }, Date.now());
  let answeredSince = false;
  let lastSelf = process.cpuUsage();
  let lastCpu = new Map<number, number>(descendantsOf(processRows(), process.pid).map((row) => [row.pid, row.cpuMs]));

  const timer = setInterval(() => {
    const now = Date.now();
    const below = descendantsOf(processRows(), process.pid);
    const self = process.cpuUsage(lastSelf);
    lastSelf = process.cpuUsage();
    let grew = (self.user + self.system) / 1000;
    const cpu = new Map<number, number>();
    for (const row of below) {
      cpu.set(row.pid, row.cpuMs);
      grew += Math.max(0, row.cpuMs - (lastCpu.get(row.pid) ?? 0));
    }
    lastCpu = cpu;
    const look = clock.look(now, grew, answeredSince);
    answeredSince = false;
    if (look.sleptMs >= 60_000) options.say(`watchdog: ${seconds(look.sleptMs)} asleep or stopped; not counted as waiting`);
    if (!look.stalled) return;
    killTree(below);
    const reason = `stalled: nothing answered for ${seconds(look.idleAwakeMs)} awake, and it and everything it started`
      + ` used ${seconds(look.idleCpuMs)} of CPU in that time; killed ${below.length > 0 ? below.map(nameOf).join(", ") : "nothing (no process below this one)"}`;
    options.say(reason);
    options.onStall({ reason, killed: below });
  }, tickMs);
  timer.unref();

  return {
    answered: () => { answeredSince = true; },
    stop: () => clearInterval(timer),
  };
}
