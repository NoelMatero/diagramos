/**
 * Who owns a board server, and how one is found and stopped.
 *
 * The bug behind this file: nine board servers were found running on this
 * machine, on eight different ports, every one reparented to launchd because its
 * parent had died and it had not. The oldest was five days old and four were
 * serving test directories that no longer existed. A child process is not killed
 * when its parent dies, and nothing here was watching.
 *
 * Two halves are tested, because either alone leaves the pile:
 *
 *   - a server started on another process's behalf shuts down when that process
 *     is gone (the leak itself), and
 *   - a server that is *meant* to outlive its starter can still be found and
 *     stopped, since a board server takes an ephemeral port whenever 4747 is
 *     busy and `lsof` was previously the only way to find it.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, serializeBoard } from "../src/engine/board-file";
import { probeBoard, startBoardServer } from "../src/server/board-server";
import {
  listServers,
  processAlive,
  registerServer,
  registryDir,
  stopServer,
  type RegisteredServer,
} from "../src/server/server-registry";

const REPO = path.resolve(__dirname, "..");
const BUNDLE = path.join(REPO, "out/cli/diagramos.mjs");

let workspace: string;
let stateDir: string;

/** A port nobody is on yet. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") probe.close(() => resolve(address.port));
      else probe.close(() => reject(new Error("no port")));
    });
  });
}

/** Waits for a condition, so a test never sleeps a fixed amount and hopes. */
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/*
 * A registry of its own per test, not the shared one from setup: these tests
 * write entries for processes that do not exist, and a test asserting "two
 * servers are registered" must not count one another test left mid-run.
 */
beforeEach(async () => {
  // Resolved: the board service reports resolved paths, and /var is a link.
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "board-lifecycle-")));
  stateDir = path.join(workspace, "state");
  process.env.DIAGRAMOS_STATE_DIR = stateDir;
  await fs.mkdir(path.join(workspace, "docs/diagrams"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, "docs/diagrams/board.excalidraw"),
    serializeBoard(emptyBoard()),
    "utf8",
  );
});

afterEach(async () => {
  // Anything still registered here is a server this file started, so it is this
  // file's job to stop it rather than the suite's safety net's.
  const { running } = await listServers();
  for (const entry of running) await stopServer(entry, { graceMs: 1000 });
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("the registry of running board servers", () => {
  it("records a server while it runs and forgets it when it stops", async () => {
    const server = await startBoardServer({
      file: path.join(workspace, "docs/diagrams/board.excalidraw"),
      port: 0,
      root: workspace,
    });

    const { running } = await listServers();
    expect(running).toHaveLength(1);
    expect(running[0]!.pid).toBe(process.pid);
    expect(running[0]!.port).toBe(server.port);
    expect(running[0]!.root).toBe(workspace);
    // Without this a leak looks the same as a board somebody opened a minute ago.
    expect(Date.parse(running[0]!.startedAt)).toBeLessThanOrEqual(Date.now());

    await server.close();
    expect((await listServers()).running).toHaveLength(0);
  });

  it("sweeps an entry whose process is gone, which is what a killed server leaves", async () => {
    // A pid that cannot be alive: the entry is exactly what SIGKILL leaves behind,
    // since a killed server never gets to remove its own file.
    const dead = await deadPid();
    await registerServer({ pid: dead, port: 4747, startedAt: new Date().toISOString() });

    const reading = await listServers();
    expect(reading.running).toHaveLength(0);
    expect(reading.pruned).toBe(1);
    // Swept from disk, not merely filtered out of the answer: otherwise the
    // listing grows by one every time a server is killed.
    expect(await fs.readdir(registryDir())).toHaveLength(0);
  });

  it("sweeps an entry it cannot read rather than choking on it", async () => {
    await fs.mkdir(registryDir(), { recursive: true });
    await fs.writeFile(path.join(registryDir(), "99999999.json"), "{ this is not json", "utf8");

    const reading = await listServers();
    expect(reading.running).toHaveLength(0);
    expect(reading.pruned).toBe(1);
    // Swept, not just skipped: an entry nothing can parse would otherwise be
    // counted as pruned on every single read for the rest of the machine's life.
    expect(await fs.readdir(registryDir())).toHaveLength(0);
  });

  it("lists oldest first, because age is what marks a server nobody meant to keep", async () => {
    const alive = process.pid;
    await registerServer({ pid: alive, port: 4001, startedAt: "2026-08-13T02:38:07.000Z" });
    // One file per process is the rule, so a second entry needs a second pid;
    // the parent of this test process is alive and serves as one.
    await registerServer({ pid: process.ppid, port: 4002, startedAt: "2026-08-18T10:00:00.000Z" });

    const { running } = await listServers();
    expect(running.map((entry) => entry.port)).toEqual([4001, 4002]);
  });

  it("reports a server that is already gone instead of pretending to stop it", async () => {
    const entry: RegisteredServer = {
      pid: await deadPid(),
      port: 4747,
      startedAt: new Date().toISOString(),
    };
    expect((await stopServer(entry)).how).toBe("gone");
  });
});

describe("a board service", () => {
  /** Backgrounds a command under `sh`, so it has a real parent that can be killed. */
  function underShell(command: string, env: Record<string, string>): { shell: ReturnType<typeof spawn> } {
    const shell = spawn("sh", ["-c", `${command} & echo $!; wait`], {
      cwd: workspace,
      env: { ...process.env, DIAGRAMOS_NO_OPEN: "1", DIAGRAMOS_STATE_DIR: stateDir, ...env },
    });
    return { shell };
  }

  it("keeps serving after the process that started it is gone", async () => {
    /*
     * The promise this whole design exists for, staged the way it is lived: a
     * shell starts the service and is then killed outright, which is what
     * closing a terminal or quitting a session amounts to. Before this, the
     * board lived inside whoever asked for it and went down with them.
     */
    const port = await freePort();
    const log = path.join(workspace, "service.log");
    const { shell } = underShell(`exec node "${BUNDLE}" serve >"${log}" 2>&1`, {
      DIAGRAMOS_PORT: String(port),
    });

    expect(await until(async () => (await probeBoard(port)) !== undefined)).toBe(true);

    shell.kill("SIGKILL");
    expect(await until(() => !processAlive(shell.pid!))).toBe(true);

    // Long enough that an owner watchdog would have fired, so a pass cannot come
    // from simply not having waited.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await probeBoard(port)).toBeDefined();
    // And it is findable, which is what separates surviving from leaking.
    const { running } = await listServers();
    expect(running.map((entry) => entry.port)).toContain(port);

    for (const entry of running) await stopServer(entry);
    expect(await probeBoard(port)).toBeUndefined();
  }, 30_000);

  it("survives the terminal it was started from closing", async () => {
    /*
     * The case above proves the service does not die with its starter. This one
     * proves `diagramos board` puts it somewhere a closing terminal cannot reach:
     * a terminal hangs up on its whole process group, so a service merely spawned
     * as a child would go down with the window that opened it. Signalled here the
     * same way -- to the group, not to the shell.
     */
    const port = await freePort();
    const shell = spawn("sh", ["-c", `node "${BUNDLE}" board docs/diagrams/board.excalidraw`], {
      cwd: workspace,
      // Makes the shell a group leader, so the group can be signalled below.
      detached: true,
      env: { ...process.env, DIAGRAMOS_NO_OPEN: "1", DIAGRAMOS_STATE_DIR: stateDir, DIAGRAMOS_PORT: String(port) },
    });
    try {
      // The command returns the prompt rather than holding it; the service is
      // what is still there.
      expect(await until(() => shell.exitCode !== null)).toBe(true);
      expect(await until(async () => (await probeBoard(port)) !== undefined)).toBe(true);

      /*
       * ESRCH here means the group is already empty -- which is itself the
       * service having left it -- so it is not an error. The assertion is the
       * next line either way: a service still in that group would have been hung
       * up on and stopped answering.
       */
      try {
        process.kill(-shell.pid!, "SIGHUP");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));

      expect(await probeBoard(port)).toBeDefined();
    } finally {
      for (const entry of (await listServers()).running) await stopServer(entry);
    }
  }, 30_000);

  it("stops itself once nothing has looked at it for long enough", async () => {
    /*
     * The guard that replaced the owner watchdog. A service belongs to the
     * person rather than to a process, so nothing dying can end it -- which
     * leaves "a project opened once, on a machine that stays up" as the way a
     * process runs forever. An idle fuse ends that case without ever touching a
     * board somebody is using: an open page holds a stream, and a held stream is
     * not idle.
     */
    const port = await freePort();
    const log = path.join(workspace, "idle.log");
    const { shell } = underShell(`exec node "${BUNDLE}" serve >"${log}" 2>&1`, {
      DIAGRAMOS_PORT: String(port),
      // One second, expressed the way the setting is: in hours.
      DIAGRAMOS_IDLE_HOURS: String(1 / 3600),
    });
    try {
      expect(await until(async () => (await probeBoard(port)) !== undefined)).toBe(true);
      expect(await until(async () => (await probeBoard(port)) === undefined, 20_000)).toBe(true);
      // Gone from the registry too, so `stop` does not offer it afterwards.
      expect(await until(async () => (await listServers()).running.length === 0)).toBe(true);
    } finally {
      shell.kill("SIGKILL");
    }
  }, 30_000);

  it("stays up while a page is watching, however long that is", async () => {
    // The other half of the fuse, and the half that would hurt if it were wrong:
    // a diagram left open on a second screen must not close itself.
    const server = await startBoardServer({
      file: path.join(workspace, "docs/diagrams/board.excalidraw"),
      port: 0,
      root: workspace,
      idleMs: 200,
    });
    const controller = new AbortController();
    try {
      const stream = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
        signal: controller.signal,
      });
      expect(stream.ok).toBe(true);
      // Several times the fuse, with no request of any kind in between.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await probeBoard(server.port)).toBeDefined();
    } finally {
      controller.abort();
      await server.close();
    }
  }, 30_000);

  it("shuts down with its owner when an unattended caller named one", async () => {
    /*
     * Kept for the caller nobody is watching -- a script, a CI step -- which can
     * name a process the service must not outlive. The mechanism is the same one
     * that fixed the original leak: a child is reparented rather than killed when
     * its parent dies, so it has to notice on its own.
     */
    const port = await freePort();
    const log = path.join(workspace, "owned.log");
    // A real process to own it, and one this test can kill. Naming the test
    // worker would assert only that an owner is *reported*, since the worker is
    // still alive at the end of the case.
    const owner = spawn("sleep", ["300"]);
    const { shell } = underShell(`exec node "${BUNDLE}" serve >"${log}" 2>&1`, {
      DIAGRAMOS_PORT: String(port),
      DIAGRAMOS_OWNER_PID: String(owner.pid),
    });
    try {
      expect(await until(async () => (await probeBoard(port)) !== undefined)).toBe(true);
      const probe = await probeBoard(port);
      expect(probe?.owner).toBe(owner.pid);
      const servicePid = probe!.pid!;

      owner.kill("SIGKILL");
      expect(await until(() => !processAlive(owner.pid!))).toBe(true);

      // Reparented rather than killed, so it has to notice by itself -- and then
      // take its registry entry with it.
      expect(await until(() => !processAlive(servicePid))).toBe(true);
      expect(await probeBoard(port)).toBeUndefined();
      expect(await until(async () => (await listServers()).running.length === 0)).toBe(true);
    } finally {
      owner.kill("SIGKILL");
      shell.kill("SIGKILL");
      for (const entry of (await listServers()).running) await stopServer(entry);
    }
  }, 30_000);
});

describe("stopping a service from its own page", () => {
  it("lists the boards it can show", async () => {
    const server = await startBoardServer({
      file: path.join(workspace, "docs/diagrams/board.excalidraw"),
      port: 0,
      root: workspace,
    });
    try {
      const payload = (await (await fetch(`http://127.0.0.1:${server.port}/api/boards`)).json()) as {
        root: string;
        boards: Array<{ name: string; current: boolean }>;
      };
      expect(payload.root).toBe(workspace);
      expect(payload.boards.map((board) => board.name)).toContain(
        path.join("docs", "diagrams", "board.excalidraw"),
      );
      expect(payload.boards.find((board) => board.current)).toBeDefined();
      // The page that shows all this is served, not just the data behind it.
      const page = await fetch(`http://127.0.0.1:${server.port}/boards`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Stop this board service");
    } finally {
      await server.close();
    }
  }, 30_000);

  it("refuses a shutdown that did not come from one of our own pages", async () => {
    /*
     * A browser will send a simple cross-origin POST to 127.0.0.1 without asking
     * anyone, so any site the user has open could otherwise close their boards.
     * Requiring a header a simple request cannot carry means such a call never
     * arrives at all.
     */
    const server = await startBoardServer({
      file: path.join(workspace, "docs/diagrams/board.excalidraw"),
      port: 0,
      root: workspace,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/shutdown`, { method: "POST" });
      expect(response.status).toBe(403);
      expect(await probeBoard(server.port)).toBeDefined();
    } finally {
      await server.close();
    }
  }, 30_000);

  it("stops when the page asks", async () => {
    const server = await startBoardServer({
      file: path.join(workspace, "docs/diagrams/board.excalidraw"),
      port: 0,
      root: workspace,
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/shutdown`, {
      method: "POST",
      headers: { "x-diagramos": "stop" },
    });
    expect(response.status).toBe(200);
    expect(await until(async () => (await probeBoard(server.port)) === undefined)).toBe(true);
    // The registry entry goes with it, so nothing offers to stop it twice.
    expect(await until(async () => (await listServers()).running.length === 0)).toBe(true);
  }, 30_000);
});

describe("diagramos stop", () => {
  /** Runs the built bin and collects everything it said. */
  function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BUNDLE, ...args], {
        cwd: workspace,
        env: { ...process.env, DIAGRAMOS_STATE_DIR: stateDir },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  }

  it("says so plainly when nothing is running", async () => {
    const { code, stdout } = await run(["stop"]);
    expect(code).toBe(0);
    expect(stdout).toContain("no board services running");
  });

  it("shows a running server, with the port it took and how long it has been up", async () => {
    const server = await startBoardServer({
      file: path.join(workspace, "docs/diagrams/board.excalidraw"),
      port: 0,
      root: workspace,
    });
    const { code, stdout } = await run(["stop", "--list"]);
    await server.close();

    expect(code).toBe(0);
    expect(stdout).toContain(`pid ${process.pid}`);
    // The whole point: an ephemeral port is as findable as the default one.
    expect(stdout).toContain(`port ${server.port}`);
    expect(stdout).toContain("second");
    expect(stdout).not.toContain("stopped");
  });

  it("stops a server started by something else entirely", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [BUNDLE, "board", "docs/diagrams/board.excalidraw"], {
      cwd: workspace,
      env: { ...process.env, DIAGRAMOS_PORT: String(port), DIAGRAMOS_NO_OPEN: "1", DIAGRAMOS_STATE_DIR: stateDir },
    });
    expect(await until(async () => (await probeBoard(port)) !== undefined)).toBe(true);

    const { code, stdout } = await run(["stop"]);
    expect(code).toBe(0);
    expect(stdout).toContain("stopped");
    expect(await until(() => child.exitCode !== null || !processAlive(child.pid!))).toBe(true);
    expect(await probeBoard(port)).toBeUndefined();
  }, 30_000);

  it("refuses an argument it does not understand rather than stopping everything anyway", async () => {
    const { code, stderr } = await run(["stop", "--force"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown option --force");
  });
});

/**
 * A pid that is certainly not running.
 *
 * Picked by starting a process and letting it exit rather than by guessing a
 * high number: a guessed pid can belong to something real, and the test would
 * then assert the opposite of what it means.
 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => child.on("close", resolve));
  return child.pid!;
}
