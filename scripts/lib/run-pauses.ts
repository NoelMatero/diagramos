/**
 * When a measurement run was not running, stated in its header.
 *
 * ## The bad outcome
 *
 * The batch-1 main bench on 2026-11-15 stopped twice, for 79 s and 76 s; the
 * Mac most likely slept. The stall watchdog noticed and wrote it to stderr,
 * which nobody keeps with the score. The score's header said nothing, and the
 * run was recorded as "no sleep". A language server that times out across a
 * sleep can turn an answer into "not sure", so a run that slept is not quite
 * comparable with one that did not, and nobody could tell from the output.
 *
 * ## Two signs, both stated
 *
 * - **This process did not run.** A timer ticks every few seconds; a tick that
 *   comes much later than due, while the process used little CPU in the gap,
 *   means the process was stopped or the machine asleep. A late tick with the
 *   CPU busy is the process's own synchronous work holding the timer up, and
 *   is not a pause.
 * - **The Mac's power log** (`pmset -g log`, macOS only) says when it slept.
 *   Read once at the end of the run; a sleep is written there only when the
 *   Mac wakes, so a sleep that ends after the run does not show.
 *
 * Recorded, never a failure: a sleep usually changes nothing, and a run that
 * says so can be judged; one that hides it cannot.
 */
import { execFileSync } from "node:child_process";

export interface Pause { at: number; ms: number }

/**
 * The decision, without timers, so it can be tested on numbers. Fed the wall
 * time and this process's CPU time at each tick.
 */
export class PauseClock {
  private last: { wall: number; cpu: number };

  constructor(private readonly options: { tickMs: number; minPauseMs: number }, wall: number, cpu: number) {
    this.last = { wall, cpu };
  }

  /** The pause that ended at this tick, if there was one. */
  look(wall: number, cpu: number): Pause | undefined {
    const gap = wall - this.last.wall;
    const used = cpu - this.last.cpu;
    const since = this.last.wall;
    this.last = { wall, cpu };
    const late = gap - this.options.tickMs;
    if (late < this.options.minPauseMs) return undefined;
    // Busy for most of the gap: this process's own work held the timer up.
    if (used >= late / 2) return undefined;
    return { at: since + this.options.tickMs, ms: late };
  }
}

export interface PauseWatch {
  pauses(): Pause[];
  stop(): void;
}

/** Ticks every `tickMs` and keeps every pause of at least `minPauseMs`. The timer never keeps a run alive. */
export function watchPauses(options: { tickMs?: number; minPauseMs?: number } = {}): PauseWatch {
  const tickMs = options.tickMs ?? 5_000;
  const cpuMs = () => { const used = process.cpuUsage(); return (used.user + used.system) / 1000; };
  const clock = new PauseClock({ tickMs, minPauseMs: options.minPauseMs ?? 30_000 }, Date.now(), cpuMs());
  const found: Pause[] = [];
  const timer = setInterval(() => {
    const pause = clock.look(Date.now(), cpuMs());
    if (pause) found.push(pause);
  }, tickMs);
  timer.unref();
  return { pauses: () => [...found], stop: () => clearInterval(timer) };
}

export interface Sleep { at: number; why: string; seconds?: number }

/**
 * The sleeps in a `pmset -g log` text that began between `from` and `to`
 * (epoch ms). A line reads
 * `2026-11-22 13:08:11 +0200 Sleep  \tEntering Sleep state due to 'Maintenance Sleep':... 200 secs`.
 */
export function powerLogSleeps(text: string, from: number, to: number): Sleep[] {
  const out: Sleep[] = [];
  const line = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d) Sleep\s+Entering Sleep state due to '([^']+)'.*?(?:(\d+) secs)?\s*$/;
  for (const row of text.split("\n")) {
    const match = line.exec(row);
    if (!match) continue;
    const [, day, time, zoneHours, zoneMinutes, why, seconds] = match;
    const at = Date.parse(`${day}T${time}${zoneHours}:${zoneMinutes}`);
    if (!(at >= from && at <= to)) continue;
    out.push({ at, why: why!, ...(seconds ? { seconds: Number(seconds) } : {}) });
  }
  return out;
}

/** The Mac's sleeps during a run, or undefined where there is no power log to read. */
export function readPowerLogSleeps(from: number, to: number): Sleep[] | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const text = execFileSync("pmset", ["-g", "log"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return powerLogSleeps(text, from, to);
  } catch {
    return undefined;
  }
}

const clock = (at: number) => new Date(at).toTimeString().slice(0, 8);
const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;

/** One header line: what the run's own timer saw, and what the power log says. */
export function pausesLine(pauses: readonly Pause[], sleeps: readonly Sleep[] | undefined): string {
  const own = pauses.length === 0
    ? "none seen"
    : `${pauses.length} -- ${pauses.map((one) => `${seconds(one.ms)} at ${clock(one.at)}`).join(", ")}; this process did not run, most likely the machine slept`;
  const log = sleeps === undefined
    ? ""
    : sleeps.length === 0
      ? "; power log: no sleep during the run"
      : `; power log: ${sleeps.length} sleep${sleeps.length === 1 ? "" : "s"} during the run (${sleeps.map((one) => `${one.why} at ${clock(one.at)}${one.seconds !== undefined ? ` for ${one.seconds}s` : ""}`).join(", ")})`;
  const warn = pauses.length > 0 || (sleeps?.length ?? 0) > 0
    ? ". Servers may have timed out in them; compare this run with care"
    : "";
  return `pauses: ${own}${log}${warn}`;
}
