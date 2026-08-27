/**
 * Writing a board is all-or-nothing.
 *
 * This did not matter while the Stop hook was the only thing that wrote a
 * `.excalidraw`. The board service promotes boxes live now (#130), so a read and
 * a write can genuinely overlap, and a board caught mid-write does not fail in a
 * way anybody would recognise: it is invalid JSON, `readBoard` throws, and the
 * board reports "could not read" until something happens to write it again.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, readBoard, writeBoard, type BoardFile } from "../src/engine/board-file";

let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "board-file-"));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** A board big enough that one write is many filesystem writes, not one. */
function bigBoard(fill: string): BoardFile {
  const elements = Array.from({ length: 4000 }, (_, index) => ({
    id: `${fill}-${index}`,
    type: "rectangle",
    x: index * 10,
    y: 0,
    width: 100,
    height: 60,
    version: 1,
    isDeleted: false,
    // Padding, so the serialized file is megabytes rather than kilobytes.
    customData: { node: `${fill}-${index}`, note: fill.repeat(64) },
  }));
  return { ...emptyBoard(), elements: elements as never };
}

describe("writeBoard", () => {
  it("leaves no scratch file behind", async () => {
    const file = path.join(workspace, "tidy.excalidraw");
    await writeBoard(file, emptyBoard());
    expect(readdirSync(workspace).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });

  it("names its scratch file so the board finder cannot mistake it for a board", async () => {
    // `findBoards` takes anything ending in `.excalidraw`. A scratch file named
    // `board.excalidraw.tmp` would be skipped, but one named
    // `tmp-board.excalidraw` would be offered as a real board and checked --
    // so the suffix is the load-bearing half of the name, not decoration.
    // Its own directory, so what is left in it is only ever this write's doing.
    const alone = await mkdtemp(path.join(os.tmpdir(), "board-file-named-"));
    const file = path.join(alone, "named.excalidraw");
    await writeBoard(file, emptyBoard());
    for (const name of readdirSync(alone)) {
      if (name === path.basename(file)) continue;
      expect(name.endsWith(".excalidraw")).toBe(false);
    }
    await rm(alone, { recursive: true, force: true });
  });

  it("never lets a reader see a half-written board", async () => {
    const file = path.join(workspace, "racy.excalidraw");
    await writeBoard(file, bigBoard("a"));

    // Read the board in a tight loop while it is rewritten underneath. With a
    // plain writeFile the reader lands inside a truncated file and readBoard
    // throws "is not valid JSON"; with the rename it always sees one whole
    // version or the other.
    let reading = true;
    const failures: string[] = [];
    const reader = (async () => {
      while (reading) {
        try {
          const board = await readBoard(file);
          // Whole file or nothing: a partial parse that happened to succeed
          // would still have lost elements.
          if (board.elements.length !== 4000) {
            failures.push(`saw ${board.elements.length} elements`);
          }
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    for (let round = 0; round < 12; round += 1) {
      await writeBoard(file, bigBoard(round % 2 === 0 ? "b" : "c"));
    }
    reading = false;
    await reader;

    expect(failures).toEqual([]);
  });
});
