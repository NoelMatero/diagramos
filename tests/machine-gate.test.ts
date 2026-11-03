/**
 * The machine gate (#489): one measurement at a time, first come first
 * served, across every session.
 *
 * The home-made gates looked and then started, so two of them saw the same
 * quiet second and both started (2026-11-02), and a bench started behind one
 * deadlocked with another one's place holder. These tests stand up real
 * processes and a real lock, in a directory of their own and with a run name
 * nobody else on the machine uses (`BOARD_AI_GATE_DIR`, `BOARD_AI_GATE_RUNS`),
 * so they never wait on, or block, a real bench or this test run's own
 * vitest. No language server is started.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const TSX = path.join(REPO, "node_modules/.bin/tsx");
const GATE = path.join(REPO, "scripts/gate.mts");

let scratch: string;
let env: NodeJS.ProcessEnv;
let events: string;
let fake: string;
const stray: number[] = [];

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "machine-gate-"));
  events = path.join(scratch, "events.log");
  writeFileSync(events, "");
  // What counts as a run here, and nowhere else: a script by this name.
  const name = `gate-fake-run-${path.basename(scratch).replace(/[^a-zA-Z0-9]/g, "")}`;
  const { BOARD_AI_RUN: _drop, ...rest } = process.env;
  env = { ...rest, BOARD_AI_GATE_DIR: path.join(scratch, "gate"), BOARD_AI_GATE_RUNS: `${name}\\.mts` };
  /*
   * A bench in miniature: waits for a quiet machine and records itself the
   * way bench:planted does, then works for `HOLD_MS`, notes when it started
   * and ended, and prints its line about the machine.
   */
  fake = path.join(scratch, `${name}.mts`);
  writeFileSync(fake, [
    `import { appendFileSync } from "node:fs";`,
    `import { recordRun, waitForQuiet } from ${JSON.stringify(path.join(REPO, "scripts/lib/bench-busy.ts"))};`,
    `const tag = process.argv[2] ?? "x";`,
    `if (process.env.NO_WAIT !== "1") await waitForQuiet((line) => console.error(line), 100);`,
    `const run = recordRun("fake " + tag);`,
    `appendFileSync(${JSON.stringify(events)}, "start " + tag + "\\n");`,
    `await new Promise((r) => setTimeout(r, Number(process.env.HOLD_MS ?? 1500)));`,
    `appendFileSync(${JSON.stringify(events)}, "end " + tag + "\\n");`,
    `console.error(run.line());`,
    `run.end();`,
  ].join("\n"));
});

afterEach(() => {
  for (const pid of stray.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  rmSync(scratch, { recursive: true, force: true });
});

interface Ended { code: number | null; stderr: string; ms: number }

function start(command: string[], more: NodeJS.ProcessEnv = {}): { pid: number; done: Promise<Ended> } {
  const began = Date.now();
  const child = spawn(command[0]!, command.slice(1), { env: { ...env, ...more }, stdio: ["ignore", "ignore", "pipe"] });
  stray.push(child.pid!);
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<Ended>((resolve) => {
    child.once("close", (code) => { resolve({ code, stderr, ms: Date.now() - began }); });
  });
  return { pid: child.pid!, done };
}
const gate = (command: string[], more: NodeJS.ProcessEnv = {}) => start([TSX, GATE, "--", ...command], more);
const fakeRun = (tag: string) => [TSX, fake, tag];
const sh = (script: string) => ["sh", "-c", script];
const lines = () => readFileSync(events, "utf8").trim().split("\n").filter(Boolean);
const lockDir = () => path.join(env.BOARD_AI_GATE_DIR!, "lock");
const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Every start is followed by its own end before the next start: nothing ran side by side. */
function oneAtATime(seen: string[]): void {
  expect(seen.length % 2).toBe(0);
  for (let i = 0; i < seen.length; i += 2) {
    const tag = seen[i]!.replace(/^start /, "");
    expect([seen[i], seen[i + 1]]).toEqual([`start ${tag}`, `end ${tag}`]);
  }
}

/** The start time `ps` gives a pid, as the lock records it. */
function startedOf(pid: number): string {
  return spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } })
    .stdout.trim().replace(/\s+/g, " ");
}

function writeLock(owner: object | undefined): void {
  mkdirSync(lockDir(), { recursive: true });
  if (owner) writeFileSync(path.join(lockDir(), "owner.json"), JSON.stringify(owner));
}

describe.skipIf(process.platform === "win32")("the machine gate", () => {
  it("runs gated commands started at the same moment one after the other, never together", async () => {
    const runs = ["a", "b", "c"].map((tag) => gate(sh(`echo start ${tag} >> '${events}'; sleep 1; echo end ${tag} >> '${events}'`)));
    const ended = await Promise.all(runs.map((one) => one.done));
    expect(ended.map((one) => one.code)).toEqual([0, 0, 0]);
    expect(lines()).toHaveLength(6);
    oneAtATime(lines());
    expect(existsSync(lockDir())).toBe(false);
  }, 60_000);

  it("lets a bench inside the gate start, though it waits for quiet and another gate and a bench queue behind", async () => {
    // The 2026-11-02 deadlock: each waiting process counted the other as busy.
    const first = gate(fakeRun("gated-1"));
    await pause(300);
    const second = gate(fakeRun("gated-2"));
    const loose = start(fakeRun("ungated"));
    const ended = await Promise.all([first.done, second.done, loose.done]);
    expect(ended.map((one) => one.code)).toEqual([0, 0, 0]);
    expect(lines()).toHaveLength(6);
    oneAtATime(lines());
    expect(lines()[0]).toBe("start gated-1");
  }, 60_000);

  it("takes over a lock whose holder is dead, or whose pid now belongs to another process", async () => {
    const dead = spawnSync("true").pid!;
    writeLock({ pid: dead, started: "Mon Jan 1 00:00:00 2001", run: "gone", command: "x", since: 0 });
    const one = await gate(sh("exit 0")).done;
    expect(one.code).toBe(0);
    expect(one.ms).toBeLessThan(15_000);

    // A live pid, but not the process that took the lock: it started at another time.
    writeLock({ pid: process.pid, started: "Mon Jan 1 00:00:00 2001", run: "gone", command: "x", since: 0 });
    expect((await gate(sh("exit 0")).done).code).toBe(0);

    // A lock left half-made long ago, by a holder that died before writing who it was.
    writeLock(undefined);
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(lockDir(), old, old);
    expect((await gate(sh("exit 0")).done).code).toBe(0);
  }, 60_000);

  it("never takes a lock from a holder that is alive", async () => {
    const holder = spawn("sleep", ["30"], { stdio: "ignore" });
    stray.push(holder.pid!);
    await pause(200);
    writeLock({ pid: holder.pid, started: startedOf(holder.pid!), run: "theirs", command: "sleep 30", since: Date.now() });
    const waiting = gate(sh(`echo start w >> '${events}'; echo end w >> '${events}'`));
    await pause(4_000);
    expect(lines()).toEqual([]);
    holder.kill("SIGKILL");
    const ended = await waiting.done;
    expect(ended.code).toBe(0);
    expect(lines()).toEqual(["start w", "end w"]);
    expect(ended.stderr).toContain(`held by pid ${holder.pid}`);
  }, 60_000);

  it("says so when another measurement shared the machine, and says nothing of one that ran alone", async () => {
    const alone = await gate(sh("sleep 0.5")).done;
    expect(alone.stderr).toContain("machine: no other measurement ran during this one");

    // A run started without the gate, while the gated one goes: it cannot be stopped, but it is written down.
    const gated = gate(sh("sleep 3"));
    await pause(1_500);
    const beside = start(fakeRun("beside"), { NO_WAIT: "1", HOLD_MS: "500" });
    const [shared] = await Promise.all([gated.done, beside.done]);
    expect(shared.code).toBe(0);
    expect(shared.stderr).toMatch(/machine: SHARED -- 1 other run used this machine/);
    expect(shared.stderr).toContain("fake beside");
  }, 60_000);

  it("while it waits for an ungated run, shows the home-made gates a place holder, and takes it away", async () => {
    // ~/bench-477/when-quiet.sh cannot see the lock; without this a chain behind it never lets the gate in.
    const holders = () => spawnSync("ps", ["-axo", "ppid=,command="], { encoding: "utf8" }).stdout.split("\n")
      .filter((line) => /node(\s|$).*measure-gate-hold\.mts --one=gate/.test(line));
    const loose = start(fakeRun("loose"), { NO_WAIT: "1", HOLD_MS: "3000" });
    for (let i = 0; i < 100 && lines().length === 0; i++) await pause(100);
    const waiting = gate(sh(`echo start g >> '${events}'; echo end g >> '${events}'`));
    let seen = 0;
    for (let i = 0; i < 100 && seen === 0; i++) { await pause(100); seen = holders().length; }
    expect(seen).toBe(1);
    await Promise.all([loose.done, waiting.done]);
    expect(lines()).toEqual(["start loose", "end loose", "start g", "end g"]);
    expect(holders()).toEqual([]);
  }, 60_000);

  it("exits with the command's own code and lets go of the lock", async () => {
    const ended = await gate(sh("exit 3")).done;
    expect(ended.code).toBe(3);
    expect(existsSync(lockDir())).toBe(false);
  }, 60_000);

  it("passes a signal to the command and lets go only once the command has ended", async () => {
    const running = gate(sh(`trap 'echo end t >> "${events}"; exit 0' TERM; echo start t >> '${events}'; while :; do sleep 0.1; done`));
    for (let i = 0; i < 100 && lines().length === 0; i++) await pause(100);
    expect(existsSync(lockDir())).toBe(true);
    process.kill(running.pid, "SIGTERM");
    const ended = await running.done;
    expect(lines()).toEqual(["start t", "end t"]);
    expect(ended.code).toBe(0);
    expect(existsSync(lockDir())).toBe(false);
  }, 60_000);
});
