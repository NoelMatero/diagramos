/**
 * The watcher that lets a board react to code (#130).
 *
 * Timing tests over a real filesystem watcher, so everything here polls to a
 * deadline rather than sleeping a fixed amount: recursive watching is FSEvents
 * on macOS and inotify on Linux, and neither promises when an event lands.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { watchCode, type CodeWatch } from "../src/server/code-watch";

const SETTLE_MS = 60;

let root: string;
let watcher: CodeWatch | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "code-watch-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
});

afterEach(() => {
  watcher?.close();
  watcher = undefined;
  rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` is true, or gives up. Returns whether it happened. */
async function became(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(15);
  }
  return check();
}

let armed = false;

/**
 * Starts the watcher, waits until it is genuinely watching, and only then lets
 * the callback count.
 *
 * Both halves are needed. Without the pause the first write races the watch
 * itself and loses often enough to make everything here flaky. And FSEvents
 * hands a new watcher a short replay of what happened just before it started --
 * measured here, the temp directory itself arrives as a `change` under its own
 * basename, and the `src/` that `beforeEach` made arrives as a `rename`. Those
 * are real events about a real tree and the watcher is right to pass them on; in
 * the service they cost one extra drift check when a page connects, which is
 * harmless and arguably the correct thing to do on arrival. In a test they are
 * somebody else's changes being attributed to this one, so the count starts
 * after they have drained.
 */
async function start(onSettled: () => void | Promise<void>): Promise<void> {
  armed = false;
  watcher = watchCode({
    root,
    settleMs: SETTLE_MS,
    onSettled: () => (armed ? onSettled() : undefined),
  });
  expect(watcher).toBeDefined();
  await sleep(450);
  armed = true;
}

describe("watchCode", () => {
  it("wakes on a code change", async () => {
    let calls = 0;
    await start(() => {
      calls += 1;
    });

    writeFileSync(path.join(root, "src/thing.ts"), "export const a = 1;\n");
    expect(await became(() => calls > 0)).toBe(true);
  });

  it("collapses a save storm into one check", async () => {
    let calls = 0;
    await start(() => {
      calls += 1;
    });

    // Twenty writes in a tight loop: one refactor, not twenty checks.
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(path.join(root, `src/file-${index}.ts`), `export const n = ${index};\n`);
    }
    expect(await became(() => calls > 0)).toBe(true);
    // Let anything still queued arrive before counting.
    await sleep(SETTLE_MS * 6);
    expect(calls).toBe(1);
  });

  /**
   * The service writes board files -- that is how a live promotion reaches the
   * page -- and this watcher covers the tree those files live in. Waking on them
   * would mean the check that wrote the board woke itself, forever.
   */
  it("ignores board files, so a live promotion cannot wake the check that wrote it", async () => {
    // The directory exists before the watch does, on purpose. Creating it is a
    // real change to the tree and rightly wakes the check -- what must not wake
    // it is the board file landing inside it, which is the event a live
    // promotion actually produces.
    mkdirSync(path.join(root, "docs/diagrams"), { recursive: true });
    let calls = 0;
    await start(() => {
      calls += 1;
    });

    writeFileSync(path.join(root, "docs/diagrams/arch.excalidraw"), "{}\n");
    await sleep(SETTLE_MS * 8);
    expect(calls).toBe(0);

    // And the same directory still wakes it for a code file, so the exclusion is
    // the extension and not the place.
    writeFileSync(path.join(root, "docs/diagrams/notes.ts"), "export const a = 1;\n");
    expect(await became(() => calls > 0)).toBe(true);
  });

  it("ignores the scratch file an atomic board write leaves for an instant", async () => {
    let calls = 0;
    await start(() => {
      calls += 1;
    });

    writeFileSync(path.join(root, "src/.arch.excalidraw.123.tmp"), "{}\n");
    await sleep(SETTLE_MS * 8);
    expect(calls).toBe(0);
  });

  it("ignores the directories nobody edits by hand", async () => {
    let calls = 0;
    await start(() => {
      calls += 1;
    });

    for (const ignored of ["node_modules", ".git", "out", "vendor"]) {
      mkdirSync(path.join(root, ignored), { recursive: true });
      writeFileSync(path.join(root, ignored, "thing.ts"), "export const a = 1;\n");
    }
    await sleep(SETTLE_MS * 8);
    expect(calls).toBe(0);
  });

  /**
   * A drift check is tens of milliseconds and an editor can beat that. Without
   * this the checks stack up behind a fast typist and each one is reading a tree
   * that has already moved on.
   */
  it("never runs two checks at once", async () => {
    let running = 0;
    let overlaps = 0;
    let finished = 0;
    await start(async () => {
      running += 1;
      if (running > 1) overlaps += 1;
      await sleep(120);
      running -= 1;
      finished += 1;
    });

    for (let index = 0; index < 6; index += 1) {
      writeFileSync(path.join(root, `src/burst-${index}.ts`), `export const n = ${index};\n`);
      await sleep(40);
    }

    expect(await became(() => finished >= 1)).toBe(true);
    await sleep(600);
    expect(overlaps).toBe(0);
  });

  it("delivers a change that arrived while a check was running", async () => {
    const seen: number[] = [];
    let slow = true;
    await start(async () => {
      seen.push(Date.now());
      if (slow) {
        slow = false;
        await sleep(200);
      }
    });

    writeFileSync(path.join(root, "src/first.ts"), "export const a = 1;\n");
    expect(await became(() => seen.length >= 1)).toBe(true);
    // Lands mid-check, so it cannot be delivered until that one is done.
    writeFileSync(path.join(root, "src/second.ts"), "export const b = 2;\n");
    expect(await became(() => seen.length >= 2)).toBe(true);
  });

  it("stops when closed", async () => {
    let calls = 0;
    await start(() => {
      calls += 1;
    });
    watcher!.close();

    writeFileSync(path.join(root, "src/after.ts"), "export const a = 1;\n");
    await sleep(SETTLE_MS * 8);
    expect(calls).toBe(0);
  });

  it("keeps watching after a check throws", async () => {
    let calls = 0;
    await start(() => {
      calls += 1;
      throw new Error("the check blew up");
    });

    writeFileSync(path.join(root, "src/one.ts"), "export const a = 1;\n");
    expect(await became(() => calls >= 1)).toBe(true);
    writeFileSync(path.join(root, "src/two.ts"), "export const b = 2;\n");
    expect(await became(() => calls >= 2)).toBe(true);
  });
});
