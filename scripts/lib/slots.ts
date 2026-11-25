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
 * holder's pid inside; one whose holder has died is taken over. Without
 * `BOARD_AI_SLOTS` nothing here waits for anything.
 *
 * Measurement only. Nothing in `src/` uses this.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const slotsDir = (): string | undefined => process.env.BOARD_AI_SLOTS || undefined;

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

let sequence = 0;

/**
 * Run `work` once this process holds one of the shared slots, if there are
 * any; at once if there are none. `expectMs` orders the waiters: longest
 * first, then first come. `apart` is a name no two holders may share at once
 * (a Rust project: two rust-analyzers on one crate contend for its
 * `target/`); a waiter whose name is held lets the next one go ahead.
 */
export async function withSlot<T>(expectMs: number, work: () => Promise<T>, apart?: string): Promise<T> {
  const dir = slotsDir();
  if (!dir) return work();
  const waiting = path.join(dir, "waiting");
  mkdirSync(waiting, { recursive: true });
  const name = apart === undefined ? "none" : createHash("sha1").update(apart).digest("hex").slice(0, 12);
  const apartLock = path.join(dir, `apart-${name}`);
  const nameHeld = () => {
    if (apart === undefined) return false;
    let owner: number | undefined;
    try { owner = Number(readFileSync(path.join(apartLock, "pid"), "utf8")); } catch { owner = undefined; }
    let exists = true;
    try { readdirSync(apartLock); } catch { exists = false; }
    if (exists && owner !== undefined && !alive(owner)) { rmSync(apartLock, { recursive: true, force: true }); return false; }
    return exists;
  };
  // Longest first: a name that sorts the longest expectation to the front, then the oldest.
  const ticket = path.join(waiting, `${String(1e12 - Math.min(1e12 - 1, Math.round(expectMs))).padStart(13, "0")}-${String(Date.now()).padStart(15, "0")}-${process.pid}-${sequence++}-${name}`);
  writeFileSync(ticket, String(process.pid));
  let held: string | undefined;
  let heldApart = false;
  try {
    for (;;) {
      const n = count(dir);
      const free: string[] = [];
      for (let i = 0; i < n; i++) {
        const slot = path.join(dir, `slot-${i}`);
        let owner: number | undefined;
        try { owner = Number(readFileSync(path.join(slot, "pid"), "utf8")); } catch { owner = undefined; }
        let exists = true;
        try { readdirSync(slot); } catch { exists = false; }
        if (!exists) free.push(slot);
        else if (owner !== undefined && !alive(owner)) { rmSync(slot, { recursive: true, force: true }); free.push(slot); }
      }
      const queue = readdirSync(waiting).sort().filter((one) => {
        const pid = Number(one.split("-")[2]);
        if (alive(pid)) return true;
        try { unlinkSync(path.join(waiting, one)); } catch { /* another cleared it */ }
        return false;
      });
      // Only waiters whose name is free count for the queue: one held back must not hold back the rest.
      const free_ = (one: string) => { const key = one.split("-")[4] ?? "none"; return key === "none" || !existsSync(path.join(dir, `apart-${key}`)); };
      const position = queue.filter(free_).indexOf(path.basename(ticket));
      if (position >= 0 && position < free.length && !nameHeld()) {
        if (apart !== undefined) {
          try {
            mkdirSync(apartLock);
            writeFileSync(path.join(apartLock, "pid"), String(process.pid));
            heldApart = true;
          } catch { heldApart = false; }
        }
        if (apart === undefined || heldApart) {
          for (const slot of free) {
            try {
              mkdirSync(slot);
              writeFileSync(path.join(slot, "pid"), String(process.pid));
              held = slot;
              break;
            } catch { /* taken meanwhile */ }
          }
          if (held) break;
          if (heldApart) { rmSync(apartLock, { recursive: true, force: true }); heldApart = false; }
        }
      }
      await new Promise((resolve) => { setTimeout(resolve, 150); });
    }
  } finally {
    try { unlinkSync(ticket); } catch { /* gone */ }
  }
  try {
    return await work();
  } finally {
    rmSync(held, { recursive: true, force: true });
    if (heldApart) rmSync(apartLock, { recursive: true, force: true });
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
