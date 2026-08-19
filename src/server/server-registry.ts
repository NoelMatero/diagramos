/**
 * Where a running board server says that it exists.
 *
 * A board server does not have a predictable address. It takes 4747 when that
 * is free and an ephemeral port when it is not (#19), so "what is serving my
 * diagrams" cannot be answered by probing a known port -- and nine servers were
 * once found running here, on eight different ports, four of them serving test
 * directories that had already been deleted. Nobody could see them, so nobody
 * stopped them.
 *
 * Each server writes an entry here while it runs and removes it when it stops.
 * `diagramos stop` reads the directory rather than scanning for listeners, which
 * is what makes an ephemeral port as stoppable as the default one.
 *
 * One file per process, not one shared list: two servers starting in the same
 * moment would race on a single file, and the loser would be invisible for the
 * rest of its life. A directory of small files has no such write to lose.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** What one running board server records about itself. */
export interface RegisteredServer {
  pid: number;
  port: number;
  /**
   * The project it started in. Still the one relative board names resolve
   * against, and the one a listing names when it has to name a single place.
   */
  root?: string;
  /**
   * Every project it will serve, the first being `root`. A service adopts
   * another project when something asks it to, which is how one service comes
   * to serve a whole machine instead of one repository per port.
   */
  roots?: string[];
  /**
   * The secret that lets a local process widen this service to another project.
   *
   * Adding a root extends what `?file=` can reach, so it cannot be something any
   * page in the browser can ask for -- a site the user has open can POST to
   * 127.0.0.1 without permission. This file is readable only by its owner, so
   * holding the token is proof of being one of the user's own processes rather
   * than something rendered in their browser.
   */
  token?: string;
  /** ISO 8601. Answers "how long has this been here", which is how a leak looks. */
  startedAt: string;
  /**
   * The process this server belongs to, when it belongs to one. Present on a
   * server started on another process's behalf -- a test, a script -- which
   * should not outlive it. Absent on a shared server, which is meant to.
   */
  owner?: number;
  /** How it was started, for a listing a person has to read. */
  startedBy?: string;
}

/**
 * The registry directory.
 *
 * `DIAGRAMOS_STATE_DIR` exists so the test suite can point this at a temporary
 * directory. Without it, running the tests would file entries in the developer's
 * real registry and `diagramos stop` would offer to stop boards that were never
 * theirs.
 */
export function registryDir(): string {
  const override = process.env.DIAGRAMOS_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".diagramos", "servers");
}

const entryFile = (pid: number): string => path.join(registryDir(), `${pid}.json`);

/**
 * Records a running server, and returns the call that unrecords it.
 *
 * Failure here is deliberately not fatal. The registry is how a server is found
 * later; it is not how it serves boards. An unwritable home directory should
 * cost you `diagramos stop`, not the ability to look at a diagram.
 */
/**
 * Rewrites a running service's entry, for the parts that change while it runs.
 *
 * Only the roots do. Everything else about a service is settled the moment it
 * binds a port.
 */
export async function updateServer(pid: number, changes: Partial<RegisteredServer>): Promise<void> {
  const file = entryFile(pid);
  try {
    const current = JSON.parse(await fs.readFile(file, "utf8")) as RegisteredServer;
    await fs.writeFile(file, `${JSON.stringify({ ...current, ...changes }, undefined, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Same reasoning as registering: losing the record costs `diagramos stop`,
    // not the ability to look at a diagram.
  }
}

export async function registerServer(entry: RegisteredServer): Promise<() => Promise<void>> {
  const file = entryFile(entry.pid);
  try {
    // Owner-only, both of them: the entry carries the token that widens a
    // service, so a registry another user can read is a service another user can
    // point at their own directories.
    await fs.mkdir(registryDir(), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, `${JSON.stringify(entry, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    return async () => undefined;
  }
  return async () => {
    try {
      await fs.rm(file, { force: true });
    } catch {
      // Same reasoning: a stale entry is pruned on the next read anyway.
    }
  };
}

/** Whether a process is still there. Signal 0 asks without sending anything. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which still counts.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface RegistryReading {
  /** Servers whose process is still running. */
  running: RegisteredServer[];
  /**
   * Entries removed because the process behind them was gone. A server killed
   * with SIGKILL never gets to clean up after itself, so this is normal rather
   * than a symptom.
   */
  pruned: number;
}

/**
 * Every board server this machine knows about, with dead entries swept.
 *
 * Liveness is decided by the process, not by asking the port. A server busy
 * enough to miss a probe is still a server, and reporting it as gone would have
 * `stop` quietly skip the one thing somebody wanted stopped.
 */
export async function listServers(): Promise<RegistryReading> {
  let names: string[];
  try {
    names = await fs.readdir(registryDir());
  } catch {
    return { running: [], pruned: 0 };
  }

  const running: RegisteredServer[] = [];
  let pruned = 0;
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    const file = path.join(registryDir(), name);
    let entry: RegisteredServer | undefined;
    try {
      entry = JSON.parse(await fs.readFile(file, "utf8")) as RegisteredServer;
    } catch {
      entry = undefined;
    }
    // An unreadable entry is swept for the same reason a dead one is: it can
    // never be acted on, and leaving it makes the listing longer every run.
    if (!entry || typeof entry.pid !== "number" || typeof entry.port !== "number") {
      await fs.rm(file, { force: true }).catch(() => undefined);
      pruned += 1;
      continue;
    }
    if (!processAlive(entry.pid)) {
      await fs.rm(file, { force: true }).catch(() => undefined);
      pruned += 1;
      continue;
    }
    running.push(entry);
  }
  // Oldest first: in a pile of servers, age is what marks the ones nobody meant
  // to keep.
  running.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.pid - b.pid);
  return { running, pruned };
}

export interface StopOutcome {
  entry: RegisteredServer;
  /** `signalled` when it went quietly, `killed` when it needed SIGKILL. */
  how: "signalled" | "killed" | "gone" | "refused";
}

/**
 * Stops one server, politely first.
 *
 * SIGTERM lets it close its file watchers and drop its pages; SIGKILL is the
 * fallback for one that is wedged. The wait between them is what makes this
 * worth having over `kill -9`, which leaves the registry entry behind.
 */
export async function stopServer(
  entry: RegisteredServer,
  { graceMs = 2000, pollMs = 100 }: { graceMs?: number; pollMs?: number } = {},
): Promise<StopOutcome> {
  if (!processAlive(entry.pid)) return { entry, how: "gone" };
  /*
   * Never signal the process doing the asking, or the one that started it.
   *
   * An entry can name this very process -- a board server hosted inside it, for
   * instance -- and killing there would take down the caller instead of a board
   * server, or, in the parent's case, the terminal the command was typed into. A
   * server inside this process is stopped by closing it, not by signalling it.
   */
  if (entry.pid === process.pid || entry.pid === process.ppid) return { entry, how: "refused" };
  try {
    process.kill(entry.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return { entry, how: "gone" };
    return { entry, how: "refused" };
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!processAlive(entry.pid)) {
      await fs.rm(entryFile(entry.pid), { force: true }).catch(() => undefined);
      return { entry, how: "signalled" };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  try {
    process.kill(entry.pid, "SIGKILL");
  } catch {
    return { entry, how: processAlive(entry.pid) ? "refused" : "signalled" };
  }
  // SIGKILL gives the server no chance to remove its own entry, so it is swept
  // here instead of being left for the next read to find.
  await fs.rm(entryFile(entry.pid), { force: true }).catch(() => undefined);
  return { entry, how: "killed" };
}
