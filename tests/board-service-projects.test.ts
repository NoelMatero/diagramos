/**
 * One board service, several projects.
 *
 * A service used to be confined to the directory it started in, so every
 * project you opened got a service of its own on a port of its own. That is
 * what made "which board server is that" unanswerable without `lsof`, and it is
 * why stopping them was a list rather than a command.
 *
 * The confinement itself stays. It is what stops a page in the browser reading
 * a file it was never shown, and removing it would be a much worse bargain than
 * the ports it saves. What changes is that the set of places is allowed to
 * grow: a service adopts a project when one of the user's own processes asks it
 * to, proving it is not a web page by presenting the token from the service's
 * registry entry, which only its owner can read.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, serializeBoard } from "../src/engine/board-file";
import { assertFreshCliBundle } from "./helpers/fresh-bundle";
import { DEFAULT_BOARD_PORT, probeBoard, startBoardServer } from "../src/server/board-server";
import { listServers, stopServer } from "../src/server/server-registry";

const REPO = path.resolve(__dirname, "..");
const BUNDLE = path.join(REPO, "out/cli/diagramos.mjs");

let home: string;
let stateDir: string;
/**
 * A port of this file's own.
 *
 * Left unset, every service these tests start would ask for 4747 and get it or
 * fall back -- which works, but means the suite competes with whatever board the
 * developer has open, and takes the default port from them for the length of a
 * run. `npm test` should answer "is the code right", not "is this machine
 * quiet" (#77).
 */
let port: number;

/** A port nobody is on yet. Racy in principle; a fixed one collides in CI. */
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

/** A project with one board in the standard place. */
async function makeProject(name: string): Promise<string> {
  const project = await fs.mkdtemp(path.join(home, `${name}-`));
  await fs.mkdir(path.join(project, "docs/diagrams"), { recursive: true });
  await fs.writeFile(
    path.join(project, "docs/diagrams/architecture.excalidraw"),
    serializeBoard(emptyBoard()),
    "utf8",
  );
  // Realpath: the service records process.cwd(), and on macOS a temporary
  // directory reaches it with /private prefixed.
  return await fs.realpath(project);
}

/** Runs the built bin to completion. */
function run(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], {
      cwd,
      env: {
        ...process.env,
        DIAGRAMOS_NO_OPEN: "1",
        DIAGRAMOS_STATE_DIR: stateDir,
        DIAGRAMOS_PORT: String(port),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

// A stale bundle fails as a wall of timeouts; refuse it in milliseconds (#77).
beforeAll(() => assertFreshCliBundle());

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "board-projects-"));
  stateDir = path.join(home, "state");
  process.env.DIAGRAMOS_STATE_DIR = stateDir;
  port = await freePort();
});

afterEach(async () => {
  for (const entry of (await listServers()).running) await stopServer(entry, { graceMs: 2000 });
  await fs.rm(home, { recursive: true, force: true });
});

describe("the suite itself", () => {
  it("never asks for the port a developer's own board is on", () => {
    /*
     * The guard, asserted rather than trusted. Removing the line in setup.ts
     * that sets this would go unnoticed otherwise: a service that cannot have
     * 4747 falls back to a free port and every test still passes, having taken
     * somebody's board away on the way past (#77).
     */
    expect(process.env.DIAGRAMOS_PORT).toBeDefined();
    expect(Number(process.env.DIAGRAMOS_PORT)).not.toBe(DEFAULT_BOARD_PORT);
    expect(process.env.DIAGRAMOS_STATE_DIR).toBeDefined();
    expect(process.env.DIAGRAMOS_STATE_DIR).not.toContain(os.homedir());
  });
});

describe("a second project", () => {
  it("joins the service already running instead of starting another", async () => {
    const first = await makeProject("alpha");
    const second = await makeProject("beta");

    const one = await run(first, ["board"]);
    expect(one.code, one.stderr).toBe(0);
    expect(one.stdout).toContain("started a board service");

    const two = await run(second, ["board"]);
    expect(two.code, two.stderr).toBe(0);
    // Not "started": the second project was taken on by the first's service.
    expect(two.stdout).toContain("using the board service already running");

    const { running } = await listServers();
    expect(running).toHaveLength(1);
    expect(running[0]!.roots).toEqual([first, second]);

    // And both are actually served, which is the part a registry entry cannot
    // promise on its own.
    const port = running[0]!.port;
    for (const project of [first, second]) {
      const board = path.join(project, "docs/diagrams/architecture.excalidraw");
      const response = await fetch(`http://127.0.0.1:${port}/api/board?file=${encodeURIComponent(board)}`);
      expect(response.status, `${project} should be served`).toBe(200);
    }
  }, 60_000);

  it("is found through a path that goes the long way round, rather than started twice", async () => {
    /*
     * A service records `process.cwd()`, which the operating system has already
     * resolved; a caller's path usually has not been. On macOS every temporary
     * directory is reached through `/var`, a link to `/private/var` -- so the
     * two spellings of one project never matched, a service was started and
     * registered and then never found again, and the next caller started
     * another. Exactly the pile this was all meant to end.
     */
    const here = await makeProject("alpha");
    const other = await makeProject("beta");
    // A marker, so the project resolves to the repository rather than to the
    // directory the board sits in -- the fallback for a directory nothing
    // claims, and not what is being measured here.
    await fs.mkdir(path.join(other, ".git"), { recursive: true });
    const link = path.join(home, "by-another-name");
    await fs.symlink(other, link);

    await run(here, ["board"]);
    // Named through the link, from somewhere else. The project this resolves to
    // is worked out from the path, not from a working directory -- a working
    // directory arrives already resolved, which is why this is the case that
    // reaches the problem.
    const viaLink = await run(here, ["board", path.join(link, "docs/diagrams/architecture.excalidraw")]);
    expect(viaLink.code, viaLink.stderr).toBe(0);

    const { running } = await listServers();
    expect(running).toHaveLength(1);
    // Recorded under the name the project really has, so the next caller --
    // spelling it either way -- finds this service instead of starting another.
    expect(running[0]!.roots).toContain(other);
    expect(running[0]!.roots).not.toContain(link);
  }, 60_000);

  it("is listed under its own heading by the command that stops them", async () => {
    const first = await makeProject("alpha");
    const second = await makeProject("beta");
    await run(first, ["board"]);
    await run(second, ["board"]);

    const { stdout } = await run(first, ["stop", "--list"]);
    expect(stdout).toContain("1 board service running");
    // Both projects named. A service covering two repositories that lists one
    // makes stopping it look smaller than it is.
    expect(stdout).toContain(first);
    expect(stdout).toContain(second);
  }, 60_000);
});

describe("the boundary a service keeps", () => {
  it("refuses to take on a project without the token from its registry entry", async () => {
    /*
     * The reason this is a token and not the header the other control endpoints
     * use: a header only proves the caller is not a page on another site. This
     * call widens what `?file=` can reach, so it has to prove the caller is one
     * of the user's own processes -- and a page cannot read a file that is
     * readable only by its owner.
     */
    const project = await makeProject("alpha");
    const elsewhere = await makeProject("beta");
    const server = await startBoardServer({
      file: path.join(project, "docs/diagrams/architecture.excalidraw"),
      port: 0,
      root: project,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/roots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: elsewhere, token: "not-the-token" }),
      });
      expect(response.status).toBe(403);

      // And the project really was not taken on.
      const board = path.join(elsewhere, "docs/diagrams/architecture.excalidraw");
      const denied = await fetch(`http://127.0.0.1:${server.port}/api/board?file=${encodeURIComponent(board)}`);
      expect(denied.status).toBe(403);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("serves boards and nothing else, however many projects it holds", async () => {
    /*
     * Narrowed as part of taking on more projects. Every path that gets through
     * is read and handed back, so without this the confinement still allowed any
     * file in the project -- an .env, a key -- to be fetched by a page that
     * guessed the name. Serving several projects is only safe because what it
     * will serve out of them got smaller.
     */
    const project = await makeProject("alpha");
    await fs.writeFile(path.join(project, ".env"), "SECRET=hunter2\n", "utf8");
    const server = await startBoardServer({
      file: path.join(project, "docs/diagrams/architecture.excalidraw"),
      port: 0,
      root: project,
    });
    try {
      const secret = path.join(project, ".env");
      const response = await fetch(`http://127.0.0.1:${server.port}/api/board?file=${encodeURIComponent(secret)}`);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("hunter2");
    } finally {
      await server.close();
    }
  }, 30_000);

  it("is not walked past by a link inside a project pointing out of it", async () => {
    /*
     * The reason the check resolves symlinks rather than comparing the path it
     * was given. A link is a perfectly ordinary thing to find in a repository,
     * and `docs/diagrams/elsewhere.excalidraw -> /somewhere/secret.excalidraw`
     * sits inside the project by every test that only looks at the text of the
     * path.
     */
    const project = await makeProject("alpha");
    const outside = await fs.mkdtemp(path.join(home, "outside-"));
    const secret = path.join(await fs.realpath(outside), "secret.excalidraw");
    await fs.writeFile(secret, serializeBoard(emptyBoard()), "utf8");
    const link = path.join(project, "docs/diagrams/elsewhere.excalidraw");
    await fs.symlink(secret, link);

    const server = await startBoardServer({
      file: path.join(project, "docs/diagrams/architecture.excalidraw"),
      port: 0,
      root: project,
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/board?file=${encodeURIComponent(link)}`,
      );
      expect(response.status).toBe(403);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("keeps a relative board name meaning the project it started in", async () => {
    /*
     * Two projects can both hold docs/diagrams/architecture.excalidraw. A
     * relative name resolving against whichever root happened to be checked
     * first would serve the wrong repository's diagram and look completely
     * normal doing it, so relative names mean the first project and boards in
     * adopted ones are named absolutely.
     */
    const first = await makeProject("alpha");
    const second = await makeProject("beta");
    await run(first, ["board"]);
    await run(second, ["board"]);

    const { running } = await listServers();
    const port = running[0]!.port;
    const payload = (await (
      await fetch(`http://127.0.0.1:${port}/api/board?file=docs/diagrams/architecture.excalidraw`)
    ).json()) as { file: string };
    expect(payload.file).toBe(path.join(first, "docs/diagrams/architecture.excalidraw"));
  }, 60_000);
});

describe("a service holding two projects", () => {
  /*
   * The three cases below are all one hazard: code written when a service had a
   * single root, meeting a service that has several. Each one read `root` where
   * it should have asked which project the board actually belongs to, and each
   * merged without a conflict because nothing about the text disagreed.
   */
  it("saves a board in the second project, rather than refusing it as foreign", async () => {
    const first = await makeProject("alpha");
    const second = await makeProject("beta");
    await run(first, ["board"]);
    await run(second, ["board"]);
    const port = (await listServers()).running[0]!.port;

    const board = path.join(second, "docs/diagrams/architecture.excalidraw");
    const current = (await (
      await fetch(`http://127.0.0.1:${port}/api/board?file=${encodeURIComponent(board)}`)
    ).json()) as { revision: string; board: unknown };

    const response = await fetch(`http://127.0.0.1:${port}/api/board`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: board, revision: current.revision, board: current.board }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(((await response.json()) as { file: string }).file).toBe(board);
  }, 60_000);

  it("will not write a board over a file that is not one", async () => {
    // A save names its own destination, which makes it the one way in that has
    // to be narrowed to boards as hard as reading was -- more so, since it
    // replaces what it lands on.
    const project = await makeProject("alpha");
    const secret = path.join(project, ".env");
    await fs.writeFile(secret, "SECRET=hunter2\n", "utf8");
    await run(project, ["board"]);
    const port = (await listServers()).running[0]!.port;

    const response = await fetch(`http://127.0.0.1:${port}/api/board`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: secret, revision: "whatever", board: emptyBoard() }),
    });
    expect(response.status).toBe(403);
    expect(await fs.readFile(secret, "utf8")).toContain("hunter2");
  }, 60_000);

  it("measures drift against the project the board belongs to", async () => {
    /*
     * Every ref on a board resolves inside its own repository. Checked against
     * the project the service happened to start in, a perfectly good board reads
     * as entirely drifted -- and the report would look like real findings rather
     * than like a question asked in the wrong place.
     */
    const first = await makeProject("alpha");
    const second = await makeProject("beta");
    // A file that exists only in the second project, referenced by its board.
    await fs.writeFile(path.join(second, "gateway.ts"), "export const gateway = true;\n", "utf8");
    const board = path.join(second, "docs/diagrams/architecture.excalidraw");
    await fs.writeFile(
      board,
      JSON.stringify({
        ...emptyBoard(),
        elements: [
          {
            id: "gw",
            type: "rectangle",
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            customData: { node: "gw", ref: "gateway.ts" },
          },
        ],
      }),
      "utf8",
    );

    await run(first, ["board"]);
    await run(second, ["board"]);
    const port = (await listServers()).running[0]!.port;

    const payload = (await (
      await fetch(`http://127.0.0.1:${port}/api/drift?file=${encodeURIComponent(board)}`)
    ).json()) as { report: { clean: boolean; checked: number; findings: Array<{ node: string }> } };

    expect(payload.report.checked).toBe(1);
    expect(payload.report.findings).toHaveLength(0);
    expect(payload.report.clean).toBe(true);
  }, 60_000);
});

describe("the index page", () => {
  it("groups every board it can show by the project it belongs to", async () => {
    const first = await makeProject("alpha");
    const second = await makeProject("beta");
    await run(first, ["board"]);
    await run(second, ["board"]);

    const { running } = await listServers();
    const payload = (await (
      await fetch(`http://127.0.0.1:${running[0]!.port}/api/boards`)
    ).json()) as { roots: string[]; boards: Array<{ project: string; name: string }> };

    expect(payload.roots).toEqual([first, second]);
    expect(payload.boards.map((board) => board.project).sort()).toEqual([first, second].sort());
    // Named within its own project, so the list does not read as a wall of
    // near-identical absolute paths.
    for (const board of payload.boards) {
      expect(board.name).toBe(path.join("docs", "diagrams", "architecture.excalidraw"));
    }
  }, 60_000);
});
