/**
 * The stamp a board carries: which build drew it, and what it means (#134).
 *
 * A board is a long-lived file in somebody's repository, and until now it
 * recorded nothing about the tool that produced it. The day the meaning of
 * something on a board changes, a board drawn last year and one drawn today are
 * byte-for-byte identical and need opposite treatment.
 *
 * Two failure modes matter more than the writing, and both are silent:
 *
 * - **Backfilling.** If merely reading a board stamped it, then opening an old
 *   one and saving it would relabel it as current — destroying the very signal
 *   the stamp exists to carry, for every board anybody touched.
 * - **Dropping.** The live board's browser rebuilds the file object from the
 *   canvas with a fixed set of keys, so a top-level field it does not know
 *   about vanishes the first time somebody drags a box. That is a stamp written
 *   once at generation and gone by the end of the session.
 *
 * So most of what is pinned here is about a stamp *not* appearing and *not*
 * disappearing, rather than about it being written.
 */
import { readFile } from "node:fs/promises";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import pkg from "../package.json";
import { emptyBoard, readBoard, writeBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { initEngine } from "../src/engine/parse";
import { BOARD_SCHEMA, TOOL_VERSION, currentStamp, schemaOf } from "../src/engine/version";
import { startBoardServer } from "../src/server/board-server";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => {
  await initEngine();
}, 60_000);

async function generated(): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [{ id: "a", label: "A" }],
    edges: [],
  });
  return board;
}

describe("the two numbers", () => {
  it("takes the npm version from package.json rather than restating it", () => {
    // Written out by hand, this said "0.1.0" to every MCP client for the whole
    // of the 0.2 line. A version recorded twice is one that disagrees.
    expect(TOOL_VERSION).toBe(pkg.version);
    expect(currentStamp()).toEqual({ version: pkg.version, schema: BOARD_SCHEMA });
  });

  it("reads a board with no stamp as schema 1 rather than as unknown", () => {
    // Every board drawn to date. The absence is a decision, not a gap.
    expect(schemaOf(undefined)).toBe(1);
    expect(schemaOf({ version: "0.9.0", schema: 4 })).toBe(4);
  });
});

describe("writing it", () => {
  it("stamps a board at the moment it is generated", async () => {
    expect((await generated()).diagramos).toEqual({
      version: pkg.version,
      schema: BOARD_SCHEMA,
    });
  });

  it("never puts one on a board it merely read", async () => {
    /*
     * The load-bearing one. `readBoard` fills defaults from `emptyBoard`, and a
     * stamp among those defaults would mean every old board silently became a
     * current one the moment anything opened it.
     */
    const workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), "stamp-read-")));
    try {
      const file = path.join(workspace, "old.excalidraw");
      await writeBoard(file, emptyBoard());
      const read = await readBoard(file);
      expect(read.diagramos).toBeUndefined();
      expect(schemaOf(read.diagramos)).toBe(1);

      // And it survives the round trip still absent, not defaulted on the way out.
      await writeBoard(file, read);
      expect(JSON.parse(await readFile(file, "utf8")).diagramos).toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps the stamp through a read-modify-write", async () => {
    const workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), "stamp-rmw-")));
    try {
      const file = path.join(workspace, "board.excalidraw");
      await writeBoard(file, await generated());
      const again = await readBoard(file);
      expect(again.diagramos?.version).toBe(pkg.version);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("surviving the live board", () => {
  let workspace: string;
  let boardFile: string;
  let server: Awaited<ReturnType<typeof startBoardServer>> | undefined;
  const api = (route: string) => `http://127.0.0.1:${server!.port}${route}`;

  beforeAll(async () => {
    workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), "stamp-live-")));
    boardFile = path.join(workspace, "board.excalidraw");
    await writeBoard(boardFile, await generated());
    server = await startBoardServer({ file: boardFile, port: 0, root: workspace });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it("keeps the stamp when the browser saves a board that never carried it", async () => {
    const before = (await (await fetch(api("/api/board"))).json()) as {
      revision: string;
      board: BoardFile;
    };
    expect(before.board.diagramos?.version).toBe(pkg.version);

    /*
     * Exactly what the viewer sends: the six keys it rebuilds from the canvas,
     * and nothing else. Before the merge this wrote the file without a stamp
     * and nothing anywhere said so.
     */
    const asBrowserSends = {
      type: "excalidraw",
      version: 2,
      source: "board-viewer",
      elements: before.board.elements,
      appState: {},
      files: {},
    };
    const response = await fetch(api("/api/board"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: before.revision, board: asBrowserSends }),
    });
    expect(response.status).toBe(200);

    const onDisk = JSON.parse(await readFile(boardFile, "utf8")) as BoardFile;
    expect(onDisk.diagramos).toEqual({ version: pkg.version, schema: BOARD_SCHEMA });
    // And the browser still won on everything it actually sent.
    expect(onDisk.source).toBe("board-viewer");
  }, 60_000);
});
