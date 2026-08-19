/**
 * Drives the *built* board CLI the way a consumer reaches it: through the
 * published `diagramos` bin, as `diagramos board`, rather than the TypeScript
 * source or the inner file the dispatcher happens to load.
 *
 * This bin exists so a board can be opened without an MCP client, which is the
 * offline story for the whole format. It is also the entry point most exposed to
 * the bundling hazard build-cli.mjs warns about: board-server.ts finds the
 * viewer at `../..` from its own file, so if this output ever moves depth the
 * page turns into a 503 that no source-run test can see.
 *
 * No graceful skip when the bundle is absent: `npm install` builds it through
 * `prepare`, so a missing bundle is a real regression, not a reason to pass.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, serializeBoard } from "../src/engine/board-file";
import { listServers, stopServer } from "../src/server/server-registry";

const REPO = path.resolve(__dirname, "..");
const BUNDLE = path.join(REPO, "out/cli/diagramos.mjs");

let workspace: string;
/** The port the running board is on, set once it is up and reused by later cases. */
let boardPort: number;

/** A port nobody is on yet. Racy in principle; the alternative is a fixed port that collides in CI. */
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

function writeBoardFile(file: string, label: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const board = emptyBoard();
  board.elements = [{ id: label, type: "rectangle", x: 0, y: 0, width: 10, height: 10 } as never];
  writeFileSync(file, serializeBoard(board), "utf8");
}

/**
 * Runs the bin and returns what it printed, once it has exited.
 *
 * `diagramos board` no longer stays in the foreground: it makes sure a
 * background service is running and gives the prompt back, which is what lets
 * the boards outlive the terminal. So the thing to wait for is the exit, and the
 * thing still running afterwards is the service -- stopped in afterAll through
 * the registry, exactly the way `diagramos stop` finds it.
 */
async function startBoard(cwd: string, args: string[], port: number): Promise<{ stdout: string }> {
  const result = await runToExit(cwd, args, port);
  if (result.code !== 0) {
    throw new Error(`board exited ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return { stdout: result.stdout };
}

/** Stops every board service this file started, so ports do not pile up between cases. */
async function stopAllServices(): Promise<void> {
  const { running } = await listServers();
  for (const entry of running) await stopServer(entry, { graceMs: 2000 });
}

/** Runs the bin to completion, for the paths that print and stop rather than serve. */
function runToExit(
  cwd: string,
  args: string[],
  port?: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BUNDLE, "board", ...args], {
      cwd,
      env: {
        ...process.env,
        DIAGRAMOS_NO_OPEN: "1",
        ...(port === undefined ? {} : { DIAGRAMOS_PORT: String(port) }),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

beforeAll(() => {
  if (!existsSync(BUNDLE)) throw new Error(`${BUNDLE} is not built. Run \`npm run build:cli\`.`);
  // A consumer's project, not this repo: the bin has to find boards by the
  // standard directory alone, with no package.json and no scripts to lean on.
  workspace = mkdtempSync(path.join(os.tmpdir(), "board-cli-"));
  writeBoardFile(path.join(workspace, "docs/diagrams/architecture.excalidraw"), "arch");
  writeBoardFile(path.join(workspace, "docs/diagrams/auth.excalidraw"), "auth");
});

afterAll(async () => {
  await stopAllServices();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("packaged board CLI", () => {
  it("finds every board in the standard directory with no arguments", async () => {
    boardPort = await freePort();
    const started = await startBoard(workspace, [], boardPort);

    // The command is gone and the boards are still being served: that is the
    // whole behaviour, so it is asserted before anything about the output.
    expect((await fetch(`http://127.0.0.1:${boardPort}/api/health`)).ok).toBe(true);
    expect(started.stdout).toContain("It keeps running after this terminal closes.");
    expect(started.stdout).toContain("docs/diagrams/architecture.excalidraw");
    expect(started.stdout).toContain("docs/diagrams/auth.excalidraw");
    // Several boards get pinned URLs, so two opened side by side stay put.
    expect(started.stdout).toContain(`http://127.0.0.1:${boardPort}/?file=`);
  }, 30_000);

  it("serves the viewer out of the tarball, which is the whole point of the bin", async () => {
    const response = await fetch(`http://127.0.0.1:${boardPort}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    // The 503 body when out/viewer is not found says "Viewer is not built yet",
    // so asserting on real viewer markup is what separates the two.
    expect(html).toContain("EXCALIDRAW_ASSET_PATH");
    expect((await fetch(`http://127.0.0.1:${boardPort}/index.js`)).status).toBe(200);
  }, 30_000);

  it("serves each discovered board on its own pinned URL", async () => {
    const response = await fetch(
      `http://127.0.0.1:${boardPort}/api/board?file=${encodeURIComponent("docs/diagrams/auth.excalidraw")}`,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { board: { elements: Array<{ id: string }> } };
    expect(payload.board.elements[0]!.id).toBe("auth");
  }, 30_000);

  it("leaves boards that already exist untouched on disk", () => {
    // Serving a board must not put a diff in someone's working tree.
    const file = path.join(workspace, "docs/diagrams/architecture.excalidraw");
    const board = JSON.parse(readFileSync(file, "utf8")) as { elements: Array<{ id: string }> };
    expect(board.elements[0]!.id).toBe("arch");
  });

  it("moves to a free port when the usual one is taken, rather than crashing", async () => {
    // The port is shared across every project on the machine, so finding it
    // occupied is ordinary. Before this, it was an EADDRINUSE stack trace.
    const taken = await freePort();
    // Something that answers but is not a board: the bin has to tell those apart
    // from a board server it could have shared.
    const squatter = createHttpServer((_request, response) => response.writeHead(404).end());
    await new Promise<void>((resolve) => squatter.listen(taken, "127.0.0.1", () => resolve()));
    try {
      const started = await startBoard(workspace, [], taken);
      expect(started.stdout).toContain(`port ${taken} was taken`);
      const used = Number(/127\.0\.0\.1:(\d+)\//.exec(started.stdout)![1]);
      expect(used).not.toBe(taken);
      expect((await fetch(`http://127.0.0.1:${used}/`)).status).toBe(200);
    } finally {
      await stopAllServices();
      // The bin probes the port before giving up on it, and close() alone waits
      // forever on that socket.
      squatter.closeAllConnections();
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  }, 30_000);

  it("shares a board service already serving this project rather than starting a second", async () => {
    const port = await freePort();
    await startBoard(workspace, [], port);
    try {
      const second = await runToExit(workspace, [], port);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain("already running");
      // On the same port, which is what "shared" means here: a second service
      // would have been pushed onto an ephemeral one.
      expect(second.stdout).toContain(`http://127.0.0.1:${port}/?file=`);
      // One service in the registry for this project, not two. Compared through
      // realpath: the service records process.cwd(), and on macOS a temporary
      // directory reaches it with /private prefixed.
      const real = realpathSync(workspace);
      const { running } = await listServers();
      expect(running.filter((entry) => entry.root === real)).toHaveLength(1);
    } finally {
      await stopAllServices();
    }
  }, 30_000);

  it("refuses a project with no boards, naming where it looked", async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "board-cli-empty-"));
    try {
      const { code, stderr } = await runToExit(empty, []);
      expect(code).toBe(2);
      expect(stderr).toContain("docs/diagrams");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 30_000);

  it("serves a board from another project, by adding that project to the service", async () => {
    /*
     * This used to be refused. A service was confined to one directory, so a
     * board outside it could only be served by removing the guard that stops a
     * page reaching an arbitrary file. A service now holds a set of projects,
     * so the board's own project is added to the set instead -- the guard stays
     * and the places it allows are the ones that were named.
     */
    const outside = path.join(workspace, "docs/diagrams/architecture.excalidraw");
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), "board-cli-elsewhere-"));
    try {
      // A port of our own: without one the service asks for 4747 and competes
      // with whatever board the developer has open (#77).
      const { code, stdout, stderr } = await runToExit(elsewhere, [outside], await freePort());
      expect(code, stderr).toBe(0);
      // Named absolutely, because a relative name would resolve against the
      // project the service started in and mean a different file.
      expect(stdout).toContain(encodeURIComponent(outside).replace(/%2F/g, "/"));

      const port = Number(/127\.0\.0\.1:(\d+)\//.exec(stdout)![1]);
      const response = await fetch(`http://127.0.0.1:${port}/api/board?file=${encodeURIComponent(outside)}`);
      expect(response.status).toBe(200);
    } finally {
      await stopAllServices();
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses a file that is not a board, before starting anything", async () => {
    const notABoard = path.join(workspace, "docs/diagrams/notes.md");
    writeFileSync(notABoard, "# notes\n", "utf8");
    const { code, stderr } = await runToExit(workspace, [notABoard]);
    expect(code).toBe(2);
    expect(stderr).toContain("a board is a .excalidraw file");
  }, 30_000);
});

describe("the diagram directory", () => {
  it("serves the directory the project asked for", async () => {
    const project = mkdtempSync(path.join(os.tmpdir(), "board-cli-configured-"));
    try {
      writeFileSync(path.join(project, ".diagramos.json"), JSON.stringify({ diagrams: "docs/architecture" }));
      writeBoardFile(path.join(project, "docs/architecture/system.excalidraw"), "sys");
      const started = await startBoard(project, [], await freePort());
      expect(started.stdout).toContain(path.join("docs", "architecture", "system.excalidraw"));
    } finally {
      await stopAllServices();
      rmSync(project, { recursive: true, force: true });
    }
  }, 30_000);

  it("names the boards it found elsewhere rather than only refusing", async () => {
    // "no boards" is true and useless when the boards are one directory away.
    const project = mkdtempSync(path.join(os.tmpdir(), "board-cli-stray-"));
    try {
      writeBoardFile(path.join(project, "diagrams/arch.excalidraw"), "arch");
      const { code, stderr } = await runToExit(project, []);
      expect(code).toBe(2);
      expect(stderr).toContain("found 1 elsewhere");
      expect(stderr).toContain(path.join("diagrams", "arch.excalidraw"));
      expect(stderr).toContain(".diagramos.json");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses a config it cannot honour", async () => {
    const project = mkdtempSync(path.join(os.tmpdir(), "board-cli-badconfig-"));
    try {
      writeBoardFile(path.join(project, "docs/diagrams/arch.excalidraw"), "arch");
      writeFileSync(path.join(project, ".diagramos.json"), JSON.stringify({ diagrams: "/etc" }));
      const { code, stderr } = await runToExit(project, []);
      expect(code).toBe(2);
      expect(stderr).toContain("relative to the project");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 30_000);
});
