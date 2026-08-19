/**
 * Getting a board server, without becoming one.
 *
 * A board server used to live inside whoever asked for a board: the MCP server
 * hosted one, `diagramos board` held one in the foreground of a terminal. Both
 * die with their host, so quitting Claude took the board down with it -- and
 * when the host let go without shutting down, the server was reparented and
 * kept serving invisibly, which is how nine of them came to be running here.
 *
 * So nobody hosts one any more. The board service is spawned detached, owned by
 * the person rather than by a process, and everything that wants a board asks
 * for one through `ensureBoardServer`. Closing a terminal, ending a session or
 * quitting Claude leaves it exactly where it was; `diagramos stop` is what ends
 * it.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { probeBoard, type BoardProbe } from "./board-server";
import { listServers, registryDir, type RegisteredServer } from "./server-registry";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * How long to wait for a spawned service to say it is listening.
 *
 * Generous because the first start pays for the module graph and the viewer's
 * first read, and because failing early here means falling back to "no board",
 * which is a worse answer than a slow one.
 */
const START_TIMEOUT_MS = 15_000;
const POLL_MS = 100;

/**
 * Where a detached service writes what it would have printed.
 *
 * Detached with no terminal to inherit, its output has nowhere to go, and a
 * service that fails to start would otherwise fail in complete silence. This is
 * the file named in the error when a start times out.
 */
export function logFile(): string {
  return path.join(registryDir(), "service.log");
}

/**
 * The command that runs a sibling entry point, from source or from the tarball.
 *
 * Built, we are a bundle in out/cli and node can run the sibling directly.
 * From source we are TypeScript and need tsx, which only exists in a dev
 * install -- so the choice is made by where this module is running from rather
 * than by probing for files, which would pick a stale bundle over the sources
 * being edited.
 */
function serviceCommand(): { command: string; args: string[] } {
  const packaged = import.meta.url.includes("/out/cli/");
  if (packaged) return { command: process.execPath, args: [path.join(ROOT, "out/cli/serve.mjs")] };
  return {
    command: path.join(ROOT, "node_modules/.bin/tsx"),
    args: [path.join(ROOT, "scripts/serve.mjs")],
  };
}

export interface EnsureOptions {
  /** The project whose boards are to be served. */
  root: string;
  /** Port to ask for when a service has to be started. */
  port?: number;
  /** Recorded in the registry, so a listing can say where a service came from. */
  startedBy?: string;
  /**
   * The board to start on. Optional: a service asked for without one picks the
   * first board in the project, which is what `diagramos board` means by "the
   * boards here" anyway.
   */
  file?: string;
  /**
   * A process the service should not outlive.
   *
   * Left unset for anything a person asked for, which is the normal case and the
   * point of the service: the board is still there after the terminal or the
   * session that opened it is gone. Set by a caller that nobody is watching -- a
   * script, a CI step -- so an unattended run cannot leave a service running for
   * five days, which is how nine of them came to be found here.
   */
  ownerPid?: number;
}

export interface EnsuredServer {
  port: number;
  pid: number;
  /** Whether this call is what started it. Worth saying out loud the first time. */
  started: boolean;
  probe?: BoardProbe;
}

/**
 * A project path as the service will record it.
 *
 * A service records `process.cwd()`, which the operating system has already
 * resolved through every symlink. A caller's path usually has not been: on macOS
 * `/var` is a link to `/private/var`, so a project under a temporary directory
 * is named one way here and another way there, and the two never match --
 * meaning a service was started, registered, and then never found, and the next
 * caller started another. Resolving here is what keeps the two spellings the
 * same name.
 *
 * A path that cannot be resolved is passed through: it is about to fail for a
 * better reason than this one.
 */
async function normalizeRoot(root: string): Promise<string> {
  try {
    return await fs.realpath(path.resolve(root));
  } catch {
    return path.resolve(root);
  }
}

/** Whether a service already covers this project. */
function servesRoot(entry: RegisteredServer, root: string): boolean {
  const covered = entry.roots ?? (entry.root ? [entry.root] : []);
  return covered.some((candidate) => path.resolve(candidate) === path.resolve(root));
}

/**
 * A board service for this project: the one already running, or a new one.
 *
 * The registry is consulted rather than the port, because the port is not a
 * fixed address -- a service pushed off 4747 is on an ephemeral one, and
 * probing 4747 would report "nothing running" while it serves happily.
 */
export async function ensureBoardServer(options: EnsureOptions): Promise<EnsuredServer> {
  const root = await normalizeRoot(options.root);

  const existing = await findServing(root);
  if (existing) return { ...existing, started: false };

  /*
   * Nothing serves this project yet, but something may serve another one. Ask it
   * to take this project too, rather than starting a second service: one service
   * for every project you have open is the whole point, and it is what makes
   * `diagramos stop` a single answer instead of a list.
   */
  const adopted = await adoptInto(root);
  if (adopted) return { ...adopted, started: false };

  /*
   * Only one starter at a time. Two sessions opening a board in the same second
   * would otherwise both find nothing, both spawn, and the loser would end up on
   * an ephemeral port -- two services for one project, which is the pile this
   * whole change exists to prevent.
   */
  const release = await acquireStartLock(root);
  try {
    // Someone may have won the lock and started one while we waited for it.
    const raced = (await findServing(root)) ?? (await adoptInto(root));
    if (raced) return { ...raced, started: false };
    return { ...(await spawnService(root, options)), started: true };
  } finally {
    await release();
  }
}

/**
 * A running, answering service for this project, if there is one.
 *
 * Exported because asking "is a board up" and asking "give me a board" have to
 * agree about what counts, and the answer is not "something is listening on
 * 4747" -- a service takes an ephemeral port when that one is busy, and may be
 * serving this project from another project's port entirely.
 */
export async function findServing(root: string): Promise<{ port: number; pid: number; probe?: BoardProbe } | undefined> {
  const resolved = await normalizeRoot(root);
  const { running } = await listServers();
  for (const entry of running.filter((candidate) => servesRoot(candidate, resolved))) {
    const probe = await probeBoard(entry.port);
    // Registered but not answering: the process is alive and the port is not,
    // which is a service still starting or one wedged. Either way it is not a
    // board yet, so keep looking rather than hand back an address that fails.
    if (probe?.multiBoard) return { port: entry.port, pid: entry.pid, probe };
  }
  return undefined;
}

/**
 * Asks a service already running on this machine to serve this project too.
 *
 * The token comes from the service's own registry entry, which only its owner
 * can read -- that is what separates one of the user's processes from a page in
 * their browser, which can post to 127.0.0.1 but cannot read a file.
 *
 * Returns nothing when there is no service, when it predates serving more than
 * one project, or when it refuses. Every one of those means starting our own,
 * which is the behaviour before this existed.
 */
async function adoptInto(root: string): Promise<{ port: number; pid: number; probe?: BoardProbe } | undefined> {
  const { running } = await listServers();
  // Oldest first, which listServers already gives: the long-lived service is the
  // one most likely to still be there next time, and piling projects onto it
  // beats spreading them over whichever happened to start last.
  for (const entry of running) {
    if (!entry.token) continue;
    const probe = await probeBoard(entry.port);
    // A service that cannot say what it serves cannot be asked to serve more.
    if (!probe?.multiBoard || probe.roots === undefined) continue;
    try {
      const response = await fetch(`http://127.0.0.1:${entry.port}/api/roots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, token: entry.token }),
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) continue;
      return { port: entry.port, pid: entry.pid, probe: await probeBoard(entry.port) };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function spawnService(root: string, options: EnsureOptions): Promise<{ port: number; pid: number; probe?: BoardProbe }> {
  const { command, args } = serviceCommand();
  await fs.mkdir(registryDir(), { recursive: true }).catch(() => undefined);
  const log = await fs.open(logFile(), "a").catch(() => undefined);

  /*
   * detached puts it in a session of its own, which is what makes it survive the
   * terminal that started it: without it, closing the window sends SIGHUP to the
   * whole process group and takes the service with it. unref lets this process
   * exit while the service keeps running, which is the entire point.
   */
  const child = spawn(command, args, {
    cwd: root,
    detached: true,
    stdio: ["ignore", log?.fd ?? "ignore", log?.fd ?? "ignore"],
    env: {
      ...process.env,
      ...(options.port ? { DIAGRAMOS_PORT: String(options.port) } : {}),
      ...(options.startedBy ? { DIAGRAMOS_STARTED_BY: options.startedBy } : {}),
      ...(options.file ? { DIAGRAMOS_BOARD: path.resolve(options.file) } : {}),
      ...(options.ownerPid ? { DIAGRAMOS_OWNER_PID: String(options.ownerPid) } : {}),
    },
  });
  child.unref();
  await log?.close().catch(() => undefined);

  if (child.pid === undefined) throw new Error("could not start the board service");
  // Nothing waits on the exit code, and an unwatched child that ends is a
  // ECHILD-shaped surprise later. Errors are in the log; this keeps node quiet.
  child.on("error", () => undefined);

  /*
   * Wait for a service that serves this project, not for one with the pid we
   * were handed. From source the command is a `tsx` shim that re-execs, so the
   * process that registers is a grandchild and the pid here never appears in the
   * registry at all -- a wait on it times out while the service runs happily.
   *
   * Waiting on the port we asked for would be wrong for the same shape of
   * reason: the service may have been pushed onto an ephemeral one.
   */
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = await findServing(root);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`the board service did not come up within ${START_TIMEOUT_MS / 1000}s — see ${logFile()}`);
}

/**
 * How long a start lock is believed before it is treated as abandoned.
 *
 * A holder killed mid-start leaves the file behind, and a lock nobody can clear
 * would make every later start wait the full timeout and then spawn anyway. Set
 * above the start timeout so a slow but honest start is never overtaken.
 */
const LOCK_STALE_MS = START_TIMEOUT_MS + 5_000;

/**
 * Claims the right to start a service for this project.
 *
 * `wx` is the whole mechanism: creating a file exclusively is atomic on every
 * filesystem we care about, so exactly one of two simultaneous callers gets it
 * and the other waits.
 */
async function acquireStartLock(root: string): Promise<() => Promise<void>> {
  const file = path.join(registryDir(), `start-${hash(root)}.lock`);
  const deadline = Date.now() + LOCK_STALE_MS;
  await fs.mkdir(registryDir(), { recursive: true }).catch(() => undefined);

  while (Date.now() < deadline) {
    try {
      await fs.writeFile(file, `${process.pid}\n`, { flag: "wx" });
      return async () => {
        await fs.rm(file, { force: true }).catch(() => undefined);
      };
    } catch {
      const age = await fs
        .stat(file)
        .then((stats) => Date.now() - stats.mtimeMs)
        .catch(() => Number.POSITIVE_INFINITY);
      if (age > LOCK_STALE_MS) {
        await fs.rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
  // Waited longer than a start can honestly take. Proceeding unlocked risks a
  // second service; refusing guarantees no board at all, which is worse.
  return async () => undefined;
}

/** A short, filesystem-safe name for a path. Only needs to not collide. */
function hash(value: string): string {
  let accumulator = 0;
  for (let index = 0; index < value.length; index += 1) {
    accumulator = (accumulator * 31 + value.charCodeAt(index)) >>> 0;
  }
  return accumulator.toString(36);
}
