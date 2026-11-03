/**
 * A measurement run in miniature for `tests/stall-watchdog.test.ts` (#486).
 *
 * Each unit named on the command line starts a stub server, asks it five
 * questions one after another, and counts an answer the way the census does:
 * only a reply, never a timed-out question. The stub is started the way
 * `server-process.ts` starts a real one, leading a process group of its own,
 * and it starts a child of its own, as pyright does behind `npx`.
 *
 *   stops  answers two questions, then reads and never replies
 *   slow   answers every one, 1.5 s apart (under the 2 s window)
 *   busy   spins the CPU 3.5 s (over the window) before its first answer
 *
 * Prints one JSON line: each unit, done or failed, and the run's not-measured
 * list, the way the census and the bench name a hole.
 */
import { spawn } from "node:child_process";

import { watchForStall } from "../../../scripts/lib/stall-watchdog";

const units = process.argv.slice(2);
const windowMs = 2000;

const STUB = `
const { spawn } = require("node:child_process");
const mode = process.argv[1];
const child = spawn("sleep", ["60"], { stdio: "ignore" });
process.stdout.write("child " + child.pid + "\\n");
let n = 0;
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  n += 1;
  if (mode === "stops" && n > 2) return;
  if (mode === "busy" && n === 1) { const end = Date.now() + 3500; while (Date.now() < end); }
  setTimeout(() => process.stdout.write("answer " + n + "\\n"), mode === "slow" ? 1500 : 10);
});
`;

let failedNow: ((reason: string) => void) | undefined;
const notMeasured: string[] = [];
const watchdog = watchForStall({
  windowMs,
  say: () => {},
  onStall: ({ reason, killed }) => failedNow?.(`${reason} [${killed.length} killed]`),
});

const results: Array<{ unit: string; result: string; ms: number; serverPid: number; childPid: number; reason?: string }> = [];
for (const unit of units) {
  const began = Date.now();
  const server = spawn(process.execPath, ["-e", STUB, unit], { stdio: ["pipe", "pipe", "ignore"], detached: true });
  let childPid = 0;
  let waiting: ((line: string) => void) | undefined;
  let buffered = "";
  server.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (line.startsWith("child ")) childPid = Number(line.slice(6));
      else waiting?.(line);
    }
  });
  let failure: string | undefined;
  const failed = new Promise<"failed">((resolve) => { failedNow = (reason) => { failure = reason; resolve("failed"); }; });
  const exited = new Promise<"exited">((resolve) => server.once("exit", () => resolve("exited")));
  let answered = 0;
  while (answered < 5 && failure === undefined) {
    server.stdin.write("question\n");
    // Each question times out after 0.5 s, as a real one does after 20 s: no answer, ask the next.
    const got = await Promise.race([
      new Promise<string>((resolve) => { waiting = resolve; }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), unit === "slow" ? 2500 : 500)),
      failed,
      exited,
    ]);
    if (typeof got === "string" && got.startsWith("answer")) { answered += 1; watchdog.answered(); }
    if (got === "exited") break;
  }
  failedNow = undefined;
  if (failure === undefined && answered < 5) failure = "server exited";
  if (failure !== undefined) notMeasured.push(unit);
  else { server.stdin.end(); try { process.kill(-server.pid!, "SIGKILL"); } catch { /* gone */ } }
  results.push({ unit, result: failure === undefined ? "done" : "failed", ms: Date.now() - began, serverPid: server.pid!, childPid, ...(failure ? { reason: failure } : {}) });
}
watchdog.stop();
process.stdout.write(`${JSON.stringify({ results, notMeasured })}\n`);
process.exit(0);
