/**
 * `npm run gate -- <command...>`: run a command when the machine is this
 * session's alone (#489).
 *
 * Benches, censuses and test runs take turns on this machine, across every
 * session and worktree: two at once starve the language servers, and a score
 * taken that way is not comparable with one taken alone. This waits its turn
 * in a queue (first come first served), holds the machine's lock while the
 * command runs, and lets go when it ends. A bench or census the command
 * starts sees the lock is its own run's and does not wait on it again.
 *
 * - On macOS the Mac is kept from idle sleep (`caffeinate -i -w <gate>`)
 *   while the gate lives, so a run behind it need not be wrapped. Wrapping
 *   the gate in caffeinate deadlocked the home-made gates; here it is
 *   harmless, just not needed.
 * - When the command ends, one line on stderr says whether any other
 *   measurement shared the machine meanwhile (gated or not), then the gate
 *   exits with the command's own exit code.
 * - A signal (Ctrl-C, `kill`) is passed to the command, and the lock is let go
 *   once it has ended. A gate killed outright leaves a lock whose holder is
 *   dead, and the next gate takes it over.
 *
 *   npm run gate -- npm run bench:planted -- --project=regex
 *   npm run gate -- npm test
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";

import { recordRun, waitForQuiet } from "./lib/bench-busy";

let command = process.argv.slice(2);
if (command[0] === "--") command = command.slice(1);
if (command.length === 0) {
  console.error("usage: npm run gate -- <command...>   (runs it when no other measurement is using the machine)");
  process.exit(2);
}

const say = (line: string) => { console.error(`gate: ${line}`); };
const shown = command.join(" ");

/*
 * Until the command starts, a signal ends the gate at once; "exit" lets go of
 * the lock and the ticket. After it starts, signals go to the command.
 */
let child: ReturnType<typeof spawn> | undefined;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (child) child.kill(signal);
    else process.exit(130);
  });
}

await waitForQuiet(say, 1_000, { onSignal: false });
const run = recordRun(`gate: ${shown}`);
const began = Date.now();
say(`running ${shown}`);

/*
 * Awake for as long as the gate lives, beside the command rather than around
 * it: a wrapping caffeinate dies of a signal and leaves the command running.
 */
if (process.platform === "darwin" && existsSync("/usr/bin/caffeinate")) {
  spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" }).unref();
}
child = spawn(command[0]!, command.slice(1), { stdio: "inherit" });
const code = await new Promise<number>((resolve) => {
  child!.once("error", (error) => { say(`could not start ${command[0]}: ${error.message}`); resolve(127); });
  child!.once("exit", (exitCode, signal) => { resolve(exitCode ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)); });
});
say(`${shown} ended (exit ${code}) in ${((Date.now() - began) / 1000).toFixed(0)}s; ${run.line()}`);
run.end();
process.exit(code);
