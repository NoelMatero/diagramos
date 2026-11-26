/**
 * Worker slots shared by several measurement runs at once, longest job first.
 *
 * `measure:batch` runs every set of both arms and every compiler-true
 * language side by side, each as its own `bench:planted` or
 * `measure:compiler-true` process with its own pool of workers. Left to
 * themselves, ten pools of six would start sixty workers on a ten-core
 * machine. So the batch hands them one folder of slots (`BOARD_AI_SLOTS`,
 * the count in `<folder>/count`), and a worker starts only once it holds a
 * slot. A waiter says how long its job is expected to take, and a free slot
 * goes to the longest job waiting, from whichever run: the batch is only as
 * short as its longest job, so that one should never wait behind a short one.
 *
 * A slot is a directory made with `mkdir`, which is atomic, with its
 * holder's pid inside; one whose holder has died is taken over. `apart` is a
 * name no two holders share at once (a Rust project: two rust-analyzers on
 * one crate contend for its `target/`), held the same way.
 *
 * One poll per process, for all of its waiting jobs at once, every 200 ms.
 * The first version polled once per waiting job every 150 ms: 67 waiters
 * each reading every slot and checking every queued process was alive, and
 * a fifth of the machine's CPU went to system calls during a batch
 * (2026-11-26).
 *
 * Without `BOARD_AI_SLOTS` nothing here waits for anything.
 *
 * Measurement only. Nothing in `src/` uses this.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const slotsDir = (): string | undefined => process.env.BOARD_AI_SLOTS || undefined;
const POLL_MS = 200;

function count(dir: string): number {
  try {
    const n = Number(readFileSync(path.join(dir, "count"), "utf8").trim());
    return Number.isInteger(n) && n >= 1 ? n : 1;
  } catch {
    return 1;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The pid inside a lock directory; `exists` without a pid is a lock being written. */
function ownerOf(lock: string): { exists: boolean; pid?: number } {
  let pid: number | undefined;
  try { pid = Number(readFileSync(path.join(lock, "pid"), "utf8")); } catch { pid = undefined; }
  if (pid !== undefined && Number.isFinite(pid) && pid > 0) return { exists: true, pid };
  return { exists: existsSync(lock) };
}

/** Take a lock directory, writing this process's pid into it. */
function take(lock: string): boolean {
  try {
    mkdirSync(lock);
  } catch {
    return false;
  }
  writeFileSync(path.join(lock, "pid"), String(process.pid));
  return true;
}

interface Waiter {
  ticket: string;
  apartLock?: string;
  grant: (held: { slot: string; apartLock?: string }) => void;
}

let sequence = 0;
const waiters: Waiter[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function schedule(dir: string, ms: number): void {
  if (timer || waiters.length === 0) return;
  timer = setTimeout(() => { timer = undefined; poll(dir); }, ms);
}

/** One look at the shared folder for every job of this process that waits. */
function poll(dir: string): void {
  const waiting = path.join(dir, "waiting");
  const livePids = new Map<number, boolean>();
  const isAlive = (pid: number) => {
    let known = livePids.get(pid);
    if (known === undefined) { known = alive(pid); livePids.set(pid, known); }
    return known;
  };
  const free: string[] = [];
  for (let i = 0; i < count(dir); i++) {
    const slot = path.join(dir, `slot-${i}`);
    const owner = ownerOf(slot);
    if (!owner.exists) free.push(slot);
    else if (owner.pid !== undefined && !isAlive(owner.pid)) { rmSync(slot, { recursive: true, force: true }); free.push(slot); }
  }
  let names: string[] = [];
  try { names = readdirSync(waiting).sort(); } catch { /* no queue yet */ }
  const live = names.filter((one) => {
    if (isAlive(Number(one.split("-")[2]))) return true;
    try { unlinkSync(path.join(waiting, one)); } catch { /* another cleared it */ }
    return false;
  });
  const apartHeld = new Map<string, boolean>();
  const held = (key: string) => {
    if (key === "none") return false;
    let known = apartHeld.get(key);
    if (known === undefined) {
      const lock = path.join(dir, `apart-${key}`);
      const owner = ownerOf(lock);
      const dead = owner.pid !== undefined && !isAlive(owner.pid);
      if (owner.exists && dead) rmSync(lock, { recursive: true, force: true });
      known = owner.exists && !dead;
      apartHeld.set(key, known);
    }
    return known;
  };
  // Only waiters whose name is free count for the queue: one held back must not hold back the rest.
  const eligible = live.filter((one) => !held(one.split("-")[4] ?? "none"));
  // As many of the first eligible waiters as there were free slots when this look began.
  const room = free.length;
  for (const [position, name] of eligible.entries()) {
    if (position >= room) break;
    const at = waiters.findIndex((one) => path.basename(one.ticket) === name);
    // A place another process's waiter holds in the queue: its slot is kept for it.
    if (at < 0) continue;
    const waiter = waiters[at]!;
    if (waiter.apartLock && !take(waiter.apartLock)) continue;
    const slot = free.find((one) => take(one));
    if (!slot) {
      if (waiter.apartLock) rmSync(waiter.apartLock, { recursive: true, force: true });
      break;
    }
    free.splice(free.indexOf(slot), 1);
    waiters.splice(at, 1);
    try { unlinkSync(waiter.ticket); } catch { /* gone */ }
    waiter.grant({ slot, ...(waiter.apartLock ? { apartLock: waiter.apartLock } : {}) });
  }
  schedule(dir, POLL_MS);
}

/**
 * Run `work` once this process holds one of the shared slots, if there are
 * any; at once if there are none. `expectMs` orders the waiters: longest
 * first, then first come. `apart` is a name no two holders may share at once;
 * a waiter whose name is held lets the next one go ahead.
 */
export async function withSlot<T>(expectMs: number, work: () => Promise<T>, apart?: string): Promise<T> {
  const dir = slotsDir();
  if (!dir) return work();
  const waiting = path.join(dir, "waiting");
  mkdirSync(waiting, { recursive: true });
  const name = apart === undefined ? "none" : createHash("sha1").update(apart).digest("hex").slice(0, 12);
  // Longest first: a name that sorts the longest expectation to the front, then the oldest.
  const ticket = path.join(waiting, `${String(1e12 - Math.min(1e12 - 1, Math.round(expectMs))).padStart(13, "0")}-${String(Date.now()).padStart(15, "0")}-${process.pid}-${sequence++}-${name}`);
  writeFileSync(ticket, String(process.pid));
  const held = await new Promise<{ slot: string; apartLock?: string }>((grant) => {
    waiters.push({ ticket, ...(apart === undefined ? {} : { apartLock: path.join(dir, `apart-${name}`) }), grant });
    schedule(dir, 0);
  });
  try {
    return await work();
  } finally {
    rmSync(held.slot, { recursive: true, force: true });
    if (held.apartLock) rmSync(held.apartLock, { recursive: true, force: true });
    schedule(dir, 0);
  }
}

/** Make a slots folder with `n` slots, for a batch to hand its runs. */
export function makeSlots(dir: string, n: number): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "waiting"), { recursive: true });
  writeFileSync(path.join(dir, "count"), String(n));
}

/** Whether runs in this process share slots with others (`BOARD_AI_SLOTS`). */
export const sharingSlots = (): boolean => slotsDir() !== undefined;

/** The name that keeps two jobs on one Rust project apart, the same from every script and every arm. */
export const rustCrateKey = (root: string): string => `rust:${path.resolve(root)}`;
