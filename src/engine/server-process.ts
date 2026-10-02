/**
 * Starting a language server so that it cannot outlive the check (#403).
 *
 * ## The bad outcome
 *
 * Every referee stops its server on a normal `close()`. When the process
 * holding the referee dies instead -- a hook's timeout, a `kill -9`, a crash,
 * the MCP server shut down mid-check -- the server is left to notice its input
 * closing and exit by itself. Usually it does: measured on 2026-10-01, a
 * checker killed idle or mid-question took its rust-analyzer and its pyright
 * with it every time.
 *
 * Not always. The same day one laptop was running five rust-analyzers whose
 * parent was gone, the oldest 37 hours old, each with its input closed and
 * stuck in its own shutdown: the main thread waiting on a writer thread that
 * waits for a message nothing will send. None was started by this checker --
 * a sixth in the same folder, parent still alive, belonged to a Claude Code
 * session -- but the hang is rust-analyzer's, and a checker's server can fall
 * into it the same way. One that does keeps its memory until the machine
 * restarts.
 *
 * Killing the child alone is not enough either. pyright is started through
 * `npx`, so the process this file spawns is a wrapper and the server is its
 * grandchild; rust-analyzer starts a proc-macro server of its own.
 *
 * ## The shape
 *
 * - **A process group per server.** `detached` makes the server the leader of
 *   a group of its own, and everything it starts joins it, so one signal to
 *   the group reaches the wrapper, the server and whatever the server started.
 * - **A watcher beside it.** A two-line shell loop that checks once a second
 *   whether this process and the server's group are both still there, and
 *   kills the group the moment this process is not. That is the only part
 *   that survives a `kill -9` of this process, which runs no handler at all.
 *   It exits on its own as soon as the group is gone, and it is `unref`'d, so
 *   it never holds a caller's event loop open.
 * - **An `exit` hook** for a caller that ends with `process.exit()`, so the
 *   group goes at once rather than up to a second later.
 *
 * Windows has no process groups to signal; there the server is spawned as it
 * always was.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** Servers this process started and has not stopped yet, by group id. */
const live = new Set<number>();

/*
 * $1 is this process, $2 the server's group. `kill -0` sends nothing; it only
 * asks whether the target exists. TERM first so a server may tidy up, KILL
 * after for one that will not.
 *
 * No `--` before the group: dash, which is `sh` on Ubuntu, takes it for a
 * process id and fails, and a watcher written with it killed nothing on Linux
 * (#404). Once a signal is named, every shell reads `-<n>` as a group.
 */
export const WATCH = [
  "while kill -0 \"$1\" 2>/dev/null && kill -0 \"-$2\" 2>/dev/null; do sleep 1; done",
  "kill -TERM \"-$2\" 2>/dev/null; sleep 2; kill -KILL \"-$2\" 2>/dev/null; exit 0",
].join("\n");

const guarded = process.platform !== "win32";

let hooked = false;
function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", () => { for (const group of live) signalGroup(group, "SIGKILL"); });
}

function signalGroup(group: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-group, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * `spawn` with piped stdio, for a server this process talks to over a pipe,
 * started so that it dies with this process however this process ends.
 */
export function spawnServer(command: string, args: readonly string[], cwd: string): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: guarded });
  if (!guarded || child.pid === undefined) return child;
  const group = child.pid;
  live.add(group);
  hookExit();
  child.once("exit", () => {
    // The leader is gone; anything it left in its group is not wanted either.
    signalGroup(group, "SIGKILL");
    live.delete(group);
  });
  try {
    const watcher = spawn("sh", ["-c", WATCH, "watch", String(process.pid), String(group)], {
      detached: true, stdio: "ignore",
    });
    watcher.on("error", () => {});
    watcher.unref();
  } catch {
    // No shell: the server still dies on `stopServer` and on a normal exit.
  }
  return child;
}

/** Stop a server started by `spawnServer`, and everything it started. */
export function stopServer(child: ChildProcessWithoutNullStreams): void {
  const group = child.pid;
  if (guarded && group !== undefined && live.has(group)) {
    live.delete(group);
    if (signalGroup(group, "SIGTERM")) return;
  }
  child.kill();
}
