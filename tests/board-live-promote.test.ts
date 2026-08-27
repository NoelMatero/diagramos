/**
 * The whole loop of #130, through the real service: code lands, the box turns
 * solid, nothing is recorded as built.
 *
 * `engine-live-promote.test.ts` covers the flip itself and the safety property
 * behind it. This is the wiring around it -- the watcher's guard, the write, the
 * frame the page receives -- because every one of those is a place the feature
 * can be plumbed in backwards while the engine half stays perfect.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, writeBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { LIVE_PROMOTION_KEY } from "../src/engine/promote";
import { startBoardServer, type RunningBoardServer } from "../src/server/board-server";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

let workspace: string;
let boardFile: string;
let server: RunningBoardServer | undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function became(check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(50);
  }
  return Boolean(await check());
}

const onDisk = async (): Promise<BoardFile> =>
  JSON.parse(await readFile(boardFile, "utf8")) as BoardFile;

const boxNamed = (board: BoardFile, node: string) =>
  board.elements.find((element) => (element.customData as { node?: string })?.node === node)!;

/**
 * A page holding a stream open, which is the condition the code watcher is
 * guarded on. Returns the frames it receives and a way to hang up.
 */
function openPage(): { frames: Array<Record<string, unknown>>; close: () => void } {
  const frames: Array<Record<string, unknown>> = [];
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(new URL("/api/events", server!.url).href, {
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const match = /^data: (.*)$/m.exec(part);
          if (match) frames.push(JSON.parse(match[1]) as Record<string, unknown>);
        }
      }
    } catch {
      // Aborted on purpose when the test hangs up.
    }
  })();
  return { frames, close: () => controller.abort() };
}

beforeEach(async () => {
  // Resolved for the same reason board-server.test.ts resolves: the service
  // holds its root resolved, and /var is a link to /private/var on macOS.
  workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), "live-promote-server-")));
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  mkdirSync(path.join(workspace, "docs/diagrams"), { recursive: true });
  // A git repo, so the baseline channel behaves as it does in a real project
  // rather than as the degraded no-git case.
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");

  writeFileSync(path.join(workspace, "src/caller.ts"), "export const caller = 1;\n");
  boardFile = path.join(workspace, "docs/diagrams/arch.excalidraw");
  const built = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "caller", label: "Caller", ref: "src/caller.ts" },
      { id: "thing", label: "Thing", ref: "src/thing.ts", state: "planned" },
    ],
    edges: [],
  });
  await writeBoard(boardFile, built.board);
  git("add", "-A");
  git("commit", "-qm", "start");

  server = await startBoardServer({ file: boardFile, port: 0, root: workspace });
}, 60_000);

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("a board being watched while code lands", () => {
  it("turns the planned box solid without recording it as built", async () => {
    const page = openPage();
    // The stream has to attach before the write, or the watcher it arms does not
    // exist yet when the event it should catch goes past.
    await sleep(600);

    writeFileSync(path.join(workspace, "src/thing.ts"), "export const thing = 1;\n");

    expect(
      await became(async () => boxNamed(await onDisk(), "thing").strokeStyle === "solid"),
    ).toBe(true);

    const board = await onDisk();
    const box = boxNamed(board, "thing");
    // The picture ran ahead. The record did not move.
    expect(box.strokeStyle).toBe("solid");
    expect(box.customData).toMatchObject({ state: "planned", [LIVE_PROMOTION_KEY]: true });

    page.close();
  }, 30_000);

  it("tells the page the frame is a preview, so it does not refetch the status", async () => {
    const page = openPage();
    await sleep(600);

    writeFileSync(path.join(workspace, "src/thing.ts"), "export const thing = 1;\n");

    expect(await became(() => page.frames.some((frame) => frame.livePromotion === true))).toBe(true);
    page.close();
  }, 30_000);

  it("takes the box back to dashed when the file goes away again", async () => {
    const page = openPage();
    await sleep(600);

    const thing = path.join(workspace, "src/thing.ts");
    writeFileSync(thing, "export const thing = 1;\n");
    expect(
      await became(async () => boxNamed(await onDisk(), "thing").strokeStyle === "solid"),
    ).toBe(true);

    // Exactly the case that makes previewing rather than promoting the right
    // call: the evidence was real for a moment and then was not.
    unlinkSync(thing);
    expect(
      await became(async () => boxNamed(await onDisk(), "thing").strokeStyle === "dashed"),
    ).toBe(true);

    const box = boxNamed(await onDisk(), "thing");
    expect(box.customData).not.toHaveProperty(LIVE_PROMOTION_KEY);
    expect(box.customData).toMatchObject({ state: "planned" });
    page.close();
  }, 30_000);

  it("records the change in the timeline as its own kind of event", async () => {
    const page = openPage();
    await sleep(600);
    writeFileSync(path.join(workspace, "src/thing.ts"), "export const thing = 1;\n");
    expect(
      await became(async () => boxNamed(await onDisk(), "thing").strokeStyle === "solid"),
    ).toBe(true);

    const response = await fetch(new URL("/api/history", server!.url).href);
    const payload = (await response.json()) as { entries: Array<{ source: string }> };
    expect(payload.entries.some((entry) => entry.source === "live")).toBe(true);
    page.close();
  }, 30_000);
});

describe("a board nobody is watching", () => {
  /**
   * The guard end to end, and the reason this can be on by default. A recursive
   * watch over a repository plus a drift check per burst is real work, and a
   * service doing it for a board no page has asked about is spending a battery on
   * a question nobody is waiting for.
   *
   * This asserts the outcome -- an untouched board -- rather than the mechanism.
   * The two tests below pin the mechanism: that the watcher follows the listener
   * count up and back down again.
   */
  it("is not watched, so the board is left exactly as it was", async () => {
    // No page. The service is up and serving; nothing is subscribed.
    await sleep(600);
    const before = await onDisk();

    writeFileSync(path.join(workspace, "src/thing.ts"), "export const thing = 1;\n");
    await sleep(1500);

    expect(await onDisk()).toEqual(before);
    expect(boxNamed(await onDisk(), "thing").strokeStyle).toBe("dashed");
  }, 30_000);

  /**
   * The count matters, not a boolean. Two pages on one board is the ordinary case
   * -- a second tab, a reload that has not finished dropping the first stream --
   * and a watcher torn down by whichever one closes first would leave the
   * remaining page silently unwatched, looking exactly like a working one.
   */
  it("keeps watching while any page is still there", async () => {
    const first = openPage();
    const second = openPage();
    await sleep(600);
    first.close();
    await sleep(600);

    writeFileSync(path.join(workspace, "src/thing.ts"), "export const thing = 1;\n");
    expect(
      await became(async () => boxNamed(await onDisk(), "thing").strokeStyle === "solid"),
    ).toBe(true);
    second.close();
  }, 30_000);

  it("stops watching when the last page closes", async () => {
    const page = openPage();
    await sleep(600);
    page.close();
    // Let the close land and the watcher come down with it.
    await sleep(600);

    const before = await onDisk();
    writeFileSync(path.join(workspace, "src/thing.ts"), "export const thing = 1;\n");
    await sleep(1500);

    expect(await onDisk()).toEqual(before);
  }, 30_000);
});
