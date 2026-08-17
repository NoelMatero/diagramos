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
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "board-lifecycle-"));
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

describe("a server that belongs to another process", () => {
  it("shuts down when that process dies, instead of being reparented and living on", async () => {
    const port = await freePort();
    const log = path.join(workspace, "board.log");

    /*
     * The leak, staged exactly as it happens. `sh` starts the board CLI in the
     * background and then waits, so the CLI adopts a real parent; killing the
     * shell with SIGKILL sends the CLI nothing at all. Before the watchdog, this
     * is the point where the server was reparented to launchd and kept serving
     * for five days.
     */
    const parent = spawn(
      "sh",
      ["-c", `exec node "${BUNDLE}" board docs/diagrams/board.excalidraw >"${log}" 2>&1 & echo $!; wait`],
      {
        cwd: workspace,
        env: { ...process.env, DIAGRAMOS_PORT: String(port), DIAGRAMOS_NO_OPEN: "1", DIAGRAMOS_STATE_DIR: stateDir },
      },
    );

    let announced = "";
    parent.stdout?.on("data", (chunk: Buffer) => {
      announced += chunk.toString();
    });

    const serverPid = await until(() => /\d/.test(announced)).then(() => Number.parseInt(announced.trim(), 10));
    expect(Number.isInteger(serverPid)).toBe(true);

    // Up and serving before anything is killed, so a pass cannot come from a
    // server that simply failed to start.
    expect(await until(async () => (await probeBoard(port)) !== undefined)).toBe(true);
    const probe = await probeBoard(port);
    expect(probe?.owner).toBe(parent.pid);

    parent.kill("SIGKILL");
    expect(await until(() => !processAlive(parent.pid!))).toBe(true);

    // The server is still there for a moment -- that is the mechanism, not a
    // failure -- and then notices and goes.
    expect(await until(() => !processAlive(serverPid))).toBe(true);
    expect(await probeBoard(port)).toBeUndefined();
    // And it took its registry entry with it, so `stop` does not offer it later.
    expect((await listServers()).running).toHaveLength(0);
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
    expect(stdout).toContain("no board servers running");
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
