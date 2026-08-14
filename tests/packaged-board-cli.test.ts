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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, serializeBoard } from "../src/engine/board-file";

const REPO = path.resolve(__dirname, "..");
const BUNDLE = path.join(REPO, "out/cli/diagramos.mjs");

let workspace: string;
let running: ChildProcess | undefined;
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

/** Starts the bin and resolves once it says it is up. */
function startBoard(cwd: string, args: string[], port: number): Promise<{ child: ChildProcess; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE, "board", ...args], {
      cwd,
      env: { ...process.env, DIAGRAMOS_PORT: String(port), DIAGRAMOS_NO_OPEN: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out waiting for the board\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 20_000);
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("ctrl-c to stop")) {
        clearTimeout(timer);
        resolve({ child, stdout });
      }
    });
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`board exited ${code} before serving\nstderr: ${stderr}`));
    });
  });
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

afterAll(() => {
  running?.kill();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("packaged board CLI", () => {
  it("finds every board in the standard directory with no arguments", async () => {
    boardPort = await freePort();
    const started = await startBoard(workspace, [], boardPort);
    running = started.child;

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
    let started: { child: ChildProcess; stdout: string } | undefined;
    try {
      started = await startBoard(workspace, [], taken);
      expect(started.stdout).toContain(`port ${taken} is in use`);
      const used = Number(/127\.0\.0\.1:(\d+)\//.exec(started.stdout)![1]);
      expect(used).not.toBe(taken);
      expect((await fetch(`http://127.0.0.1:${used}/`)).status).toBe(200);
    } finally {
      started?.child.kill();
      // The bin probes the port before giving up on it, and close() alone waits
      // forever on that socket.
      squatter.closeAllConnections();
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  }, 30_000);

  it("shares a board server already serving this project rather than starting a second", async () => {
    const port = await freePort();
    const first = await startBoard(workspace, [], port);
    try {
      const second = await runToExit(workspace, [], port);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain("already running");
      // Named absolutely on purpose: a relative name resolves against the other
      // server's root, so two projects holding the same filename would serve
      // each other's diagram without either side noticing.
      expect(second.stdout).toContain(path.join(workspace, "docs/diagrams/architecture.excalidraw"));
    } finally {
      first.child.kill();
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

  it("refuses a board outside the directory it is rooted at", async () => {
    const outside = path.join(workspace, "docs/diagrams/architecture.excalidraw");
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), "board-cli-elsewhere-"));
    try {
      // Without a root, POST /api/file would let any local page point the board
      // at an arbitrary file on disk.
      const { code, stderr } = await runToExit(elsewhere, [outside]);
      expect(code).toBe(2);
      expect(stderr).toContain("outside");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("the diagram directory", () => {
  it("serves the directory the project asked for", async () => {
    const project = mkdtempSync(path.join(os.tmpdir(), "board-cli-configured-"));
    let started: { child: ChildProcess; stdout: string } | undefined;
    try {
      writeFileSync(path.join(project, ".diagramos.json"), JSON.stringify({ diagrams: "docs/architecture" }));
      writeBoardFile(path.join(project, "docs/architecture/system.excalidraw"), "sys");
      started = await startBoard(project, [], await freePort());
      expect(started.stdout).toContain(path.join("docs", "architecture", "system.excalidraw"));
    } finally {
      started?.child.kill();
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
