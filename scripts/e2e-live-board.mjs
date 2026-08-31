#!/usr/bin/env node
/**
 * Reproduces the real usage flow against the live board.
 *
 *   npx tsx scripts/e2e-live-board.mjs
 *
 * Every assertion reads the scene the canvas is actually showing, via the
 * __boardScene test hook. Asserting through /api/board instead only proves the
 * server is reachable, which is how an earlier version of this script passed
 * while the canvas silently failed to update.
 */
import path from "node:path";
import os from "node:os";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { chromium } from "playwright";

import { installExcalifontMeasurer } from "../tests/helpers/excalifont.ts";
import { emptyBoard, readBoard, writeBoard } from "../src/engine/board-file.ts";
import { createDiagram, connectNodes } from "../src/engine/diagram.ts";
import { startBoardServer } from "../src/server/board-server.ts";

installExcalifontMeasurer();

const workspace = mkdtempSync(path.join(os.tmpdir(), "board-e2e-"));
const file = path.join(workspace, "live.excalidraw");
const shot = (name) => path.join("/tmp", `live-${name}.png`);

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

/** The scene as rendered, not as served. */
const scene = (page) =>
  page.evaluate(() => window.__boardScene?.() ?? { count: -1, ids: [], revealing: false });

/** Settled means the reveal has finished, so a count can be trusted as final. */
const settled = (value) => !value.revealing;

async function waitForScene(page, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = await scene(page);
  while (Date.now() < deadline) {
    if (predicate(last)) return last;
    await page.waitForTimeout(150);
    last = await scene(page);
  }
  return last;
}

let server;
let browser;
try {
  const first = await createDiagram(emptyBoard(), {
    title: "Version one",
    name: "v1",
    nodes: [
      { id: "editor", label: "Your browser" },
      { id: "file", label: "board.excalidraw", backgroundColor: "#d0ebff" },
    ],
    edges: [{ from: "editor", to: "file", label: "saves" }],
  });
  await writeBoard(file, first.board);

  server = await startBoardServer({ file, port: 0 });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  // Not networkidle: the SSE stream never closes, so the page is never idle.
  await page.goto(server.url, { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.__boardScene === "function", undefined, { timeout: 20_000 });
  // Wait for the reveal to settle before counting: mid-reveal the canvas holds
  // a deliberate subset, and comparing against that would be measuring the
  // animation rather than the board.
  const initial = await waitForScene(page, (value) => value.count > 0 && settled(value));
  check("initial board reaches the canvas", initial.count > 0, `${initial.count} elements`);
  await page.screenshot({ path: shot("1-initial") });

  // 1. Adding to the same file, the case that already worked.
  const grown = await connectNodes(await readBoard(file), [
    { from: "file", to: "editor", label: "pushes back" },
  ]);
  await writeBoard(file, grown.board);
  const after = await waitForScene(page, (value) => value.count > initial.count);
  check("added arrow appears without a reload", after.count > initial.count, `${initial.count} -> ${after.count}`);

  // The board's timeline (#68): the write above must be on it, after the
  // baseline entry from the service first seeing the board — and the page must
  // offer it as a chip.
  // Resolved spelling: the service tracks boards by realpath, and on macOS the
  // tmpdir arrives through the /var -> /private/var link. The unresolved
  // spelling would be tracked as a second board with its own empty timeline.
  const historyUrl = new URL(
    `/api/history?file=${encodeURIComponent(realpathSync(file))}`,
    server.url,
  ).href;
  const timeline = await (await fetch(historyUrl)).json();
  check(
    "the write is on the board's timeline",
    Array.isArray(timeline.entries)
      && timeline.entries.length >= 2
      && timeline.entries.at(-1).source === "opened"
      && timeline.entries[0].added > 0,
    `${timeline.entries?.length ?? 0} entries, newest ${JSON.stringify(timeline.entries?.[0] ?? null)}`,
  );
  await page.waitForTimeout(700); // the panel refetches shortly after a board change
  const historyChip = await page.evaluate(() =>
    [...document.querySelectorAll(".drift-chip")].some((chip) => chip.textContent?.includes("history")),
  );
  check("the page offers the timeline as a chip", historyChip);

  // 2. The reported failure: an entirely new diagram replacing the old one in
  //    the same file. Every element id changes, so a viewer that only merges
  //    additions will look frozen.
  const replaced = await createDiagram(await readBoard(file), {
    title: "Version two",
    name: "v2",
    nodes: [
      { id: "alpha", label: "Alpha" },
      { id: "beta", label: "Beta" },
      { id: "gamma", label: "Gamma" },
    ],
    edges: [
      { from: "alpha", to: "beta", label: "one" },
      { from: "beta", to: "gamma", label: "two" },
    ],
  });
  await writeBoard(file, replaced.board);

  const expectedIds = new Set(
    replaced.board.elements.filter((element) => !element.isDeleted).map((element) => String(element.id)),
  );
  const swapped = await waitForScene(
    page,
    (value) => value.ids.some((id) => expectedIds.has(id)) && settled(value),
  );
  const shown = new Set(swapped.ids);
  const missing = [...expectedIds].filter((id) => !shown.has(id));
  const stale = swapped.ids.filter((id) => !expectedIds.has(id));

  check("replacement diagram reaches the canvas", missing.length === 0, `${missing.length} missing`);
  check("stale elements are gone from the canvas", stale.length === 0, `${stale.length} left: ${stale.slice(0, 4).join(", ")}`);
  await page.screenshot({ path: shot("2-after-replacement") });

  // 3. The reveal. A tool writes a diagram as one atomic save, so without this
  //    the whole picture flicks into existence at once. It should be drawn on.
  const revealNodes = Array.from({ length: 12 }, (_, index) => ({
    id: `s${index}`,
    label: `Step ${index}`,
  }));
  const revealed = await createDiagram(await readBoard(file), {
    title: "Revealed",
    name: "v3",
    nodes: revealNodes,
    edges: revealNodes.slice(1).map((node, index) => ({ from: revealNodes[index].id, to: node.id })),
  });
  const revealIds = new Set(
    revealed.board.elements.filter((element) => !element.isDeleted).map((element) => String(element.id)),
  );
  const revealTotal = revealIds.size;

  const before = (await scene(page)).count;
  await writeBoard(file, revealed.board);
  // Sample far faster than the reveal advances, so intermediate frames cannot
  // slip between two polls.
  const counts = [];
  for (let attempt = 0; attempt < 160; attempt++) {
    const value = await scene(page);
    counts.push(value.count);
    if (counts.length > 2 && settled(value) && value.count === revealTotal) break;
    await page.waitForTimeout(25);
  }
  // Ignore the outgoing scene's own count; only states belonging to the new
  // diagram say anything about how it was revealed.
  const partial = [...new Set(counts)].filter(
    (count) => count !== before && count > 0 && count < revealTotal,
  );

  check(
    "diagram is revealed in steps rather than all at once",
    partial.length >= 3,
    `${partial.length} intermediate scenes: ${[...new Set(counts)].join(" -> ")}`,
  );
  // Only from the first frame of the new diagram onwards. The step down from the
  // outgoing scene's count is the replacement itself, not a reveal going
  // backwards -- a wholesale swap has to drop the old elements to show the new.
  const during = counts.slice(counts.findIndex((count) => count !== before));
  check(
    "the reveal only ever grows once it has started",
    during.length > 1 && during.every((count, index) => index === 0 || count >= during[index - 1]),
    during.join(" "),
  );
  check(
    "the reveal finishes on the complete scene",
    counts.at(-1) === revealTotal,
    `${counts.at(-1)} of ${revealTotal}`,
  );
  await page.screenshot({ path: shot("3-after-reveal") });

  // 4. Every write must also survive on disk, not just on screen: a viewer that
  //    pushes a stale -- or half-revealed -- scene back would undo the tool.
  await page.waitForTimeout(1200);
  const onDisk = await readBoard(file);
  const diskIds = new Set(onDisk.elements.filter((element) => !element.isDeleted).map((element) => String(element.id)));
  check(
    "file still holds the full diagram after the viewer settles",
    [...revealIds].every((id) => diskIds.has(id)),
    `${diskIds.size} ids on disk, expected ${revealTotal}`,
  );

  // 5. The status pill has to name the board actually being served, and stop
  //    claiming to when it cannot know. Both failed before: a switch between two
  //    files holding identical content left the old name in place reading `live`,
  //    because the revision is a content hash and the page skipped the pull.
  const pillText = () => page.$eval(".status", (el) => el.textContent.replace(/\s+/g, " ").trim());
  const twin = path.join(workspace, "twin.excalidraw");
  await writeBoard(twin, await readBoard(file));

  await server.setFile(twin);
  await page.waitForFunction(() => document.querySelector(".status")?.textContent?.includes("twin"), undefined, {
    timeout: 8000,
  }).catch(() => undefined);
  check("pill follows a switch to a board with identical content", (await pillText()).includes("twin.excalidraw"), await pillText());

  // 6. Two boards side by side. Each page names its own board in the URL, and the
  //    point of that is isolation: writing one diagram, or re-pointing the follow
  //    view, must not drag the other page onto a different file. That is the
  //    failure the single-board server had by construction.
  const sideFile = path.join(workspace, "side.excalidraw");
  const side = await createDiagram(emptyBoard(), {
    title: "Second diagram",
    name: "side",
    nodes: [
      { id: "ue", label: "UE" },
      { id: "ims", label: "IMS core" },
    ],
    edges: [{ from: "ue", to: "ims", label: "SIP" }],
  });
  await writeBoard(sideFile, side.board);

  const pageMain = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const pageSide = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await pageMain.goto(server.urlFor(file), { waitUntil: "load" });
  await pageSide.goto(server.urlFor(sideFile), { waitUntil: "load" });
  for (const each of [pageMain, pageSide]) {
    await each.waitForFunction(() => typeof window.__boardScene === "function", undefined, { timeout: 20_000 });
  }
  const mainOpened = await waitForScene(pageMain, (value) => value.count > 0 && settled(value));
  const sideOpened = await waitForScene(pageSide, (value) => value.count > 0 && settled(value));
  const named = async (each) => await each.$eval(".status-file", (el) => el.textContent);
  check(
    "two pinned pages each name their own board",
    (await named(pageMain)) === path.basename(file) && (await named(pageSide)) === "side.excalidraw",
    `${await named(pageMain)} | ${await named(pageSide)}`,
  );
  check(
    "each pinned page shows its own diagram",
    sideOpened.count > 0 && sideOpened.count !== mainOpened.count,
    `${mainOpened.count} vs ${sideOpened.count} elements`,
  );

  // Write to one board only. The other page must not so much as flicker.
  const sideGrown = await connectNodes(await readBoard(sideFile), [
    { from: "ims", to: "ue", label: "200 OK" },
  ]);
  await writeBoard(sideFile, sideGrown.board);
  const sideGrew = await waitForScene(pageSide, (value) => value.count > sideOpened.count && settled(value));
  check("a write to one board reaches its own page", sideGrew.count > sideOpened.count, `${sideOpened.count} -> ${sideGrew.count}`);
  const mainAfter = await scene(pageMain);
  check(
    "a write to one board leaves the other page alone",
    mainAfter.count === mainOpened.count && (await named(pageMain)) === path.basename(file),
    `${mainOpened.count} -> ${mainAfter.count}, showing ${await named(pageMain)}`,
  );

  // Re-pointing the follow view is what used to move every open page.
  await server.setFile(sideFile);
  await page.waitForTimeout(1500);
  check(
    "re-pointing the follow view does not move a pinned page",
    (await named(pageMain)) === path.basename(file) && (await scene(pageMain)).count === mainOpened.count,
    `showing ${await named(pageMain)}`,
  );
  await pageMain.screenshot({ path: shot("4-pinned-main") });
  await pageSide.screenshot({ path: shot("5-pinned-side") });
  await pageMain.close();
  await pageSide.close();

  // 7. A save racing a file switch must never cross files (#70): composed
  //    against one board, it lands on that board or not at all. Before saves
  //    were addressed to their file, this exact timing wrote the whole old
  //    scene into the newly followed board via the 409-merge path.
  await waitForScene(page, (value) => value.count > 0 && settled(value));
  const liveBefore = await readBoard(file);
  const sideBefore = await readBoard(sideFile);
  await page.mouse.click(600, 300); // focus the canvas so the shortcut lands
  await page.keyboard.press("p");
  await page.mouse.move(220, 520);
  await page.mouse.down();
  await page.mouse.move(280, 560, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(390); // the save debounce is 400ms: switch mid-flush
  await server.setFile(file);
  await page.waitForTimeout(2500);

  const liveIds = new Set(liveBefore.elements.map((element) => String(element.id)));
  const sideIds = new Set(sideBefore.elements.map((element) => String(element.id)));
  const liveAfter = await readBoard(file);
  const crossed = liveAfter.elements.filter(
    (element) => sideIds.has(String(element.id)) && !liveIds.has(String(element.id)),
  );
  check(
    "a save racing a file switch does not leak into the next board",
    crossed.length === 0,
    `${crossed.length} foreign elements`,
  );
  const liveCount = (board) => board.elements.filter((element) => !element.isDeleted).length;
  const sideAfter = await readBoard(sideFile);
  check(
    "the board switched away from keeps its elements",
    liveCount(sideAfter) >= liveCount(sideBefore),
    `${liveCount(sideBefore)} -> ${liveCount(sideAfter)}`,
  );

  /*
   * What a box means, shown and set from the page (#114, #111).
   *
   * Its own board and its own tab, so none of the state above is disturbed.
   *
   * The selection is made the way a reader actually makes it: click the finding
   * in the status panel, which reveals and selects the box it is about. That is
   * the path #114 is really about -- a verdict names a file, and until now there
   * was no way to get from the verdict to the box on the canvas -- and it is
   * also the only way to select an element here without doing arithmetic on the
   * canvas transform to find where the box landed in screen pixels.
   *
   * The final assertion is against the *file*, not the panel. A panel that
   * looked right while writing nothing is exactly the failure worth catching.
   */
  const meaningFile = path.join(workspace, "meaning.excalidraw");
  const meaningBoard = await createDiagram(emptyBoard(), {
    title: "Meaning",
    name: "m1",
    nodes: [
      { id: "engine", label: "the engine", ref: "nowhere/missing.ts" },
      { id: "page", label: "the page" },
    ],
    edges: [{ from: "page", to: "engine", label: "asks" }],
  });
  await writeBoard(meaningFile, meaningBoard.board);

  const meaningPage = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  meaningPage.on("pageerror", (error) => errors.push(String(error)));
  await meaningPage.goto(`${server.url}?file=${encodeURIComponent(meaningFile)}`, { waitUntil: "load" });
  await meaningPage.waitForFunction(() => typeof window.__boardScene === "function", undefined, { timeout: 20_000 });
  await waitForScene(meaningPage, (value) => value.count > 0 && settled(value));

  await meaningPage.waitForSelector(".drift-chip", { timeout: 10_000 });
  await meaningPage.click(".drift-chip");
  await meaningPage.waitForSelector(".drift-row:not(:disabled)", { timeout: 10_000 });
  await meaningPage.click(".drift-row:not(:disabled)");

  const panel = await meaningPage.waitForSelector(".inspect", { timeout: 10_000 }).catch(() => null);
  check("selecting a box shows what it means", panel !== null);

  const shownRef = panel
    ? await meaningPage.$eval(".inspect .inspect-input", (el) => el.value)
    : "";
  check(
    "the panel shows the file the box points at, which the canvas never did",
    shownRef === "nowhere/missing.ts",
    shownRef,
  );

  const shownFinding = panel
    ? await meaningPage.$eval(".inspect-findings", (el) => el.textContent ?? "")
    : "";
  check(
    "the panel carries the verdict on that one box",
    shownFinding.includes("nowhere/missing.ts"),
    shownFinding.trim(),
  );

  // The gesture #111 is about: mark the thing that does not exist yet.
  const plannedButton = await meaningPage.$$(".inspect-option");
  const labels = await Promise.all(plannedButton.map((button) => button.textContent()));
  const planned = plannedButton[labels.indexOf("Planned")];
  if (planned) await planned.click();

  const marked = await (async () => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const board = await readBoard(meaningFile);
      const box = board.elements.find((element) => element.customData?.node === "engine");
      if (box?.customData?.state === "planned") return box;
      await meaningPage.waitForTimeout(150);
    }
    return (await readBoard(meaningFile)).elements.find((element) => element.customData?.node === "engine");
  })();

  check(
    "clicking Planned writes it to the file, with no agent in the loop",
    marked?.customData?.state === "planned",
    JSON.stringify(marked?.customData ?? null),
  );
  // The picture has to agree with the meaning, or the board says two things.
  check(
    "a box marked planned is drawn dashed",
    marked?.strokeStyle === "dashed",
    String(marked?.strokeStyle),
  );

  await meaningPage.screenshot({ path: shot("5-meaning") });
  await meaningPage.close();

  /*
   * Undo, on a board that was just opened (#164).
   *
   * This is the one that emptied a committed file. Excalidraw's undo is a delta
   * against its own snapshot of the scene; the viewer painted the board in
   * without telling it, so the snapshot stayed empty and the first Ctrl+Z
   * inverted "the whole diagram arrived" into "the whole diagram goes" --
   * 157 elements tombstoned, every container stripped of its `boundElements`,
   * saved over the file, and nothing anywhere said so.
   *
   * Its own board and its own tab, because the page has to be *freshly loaded*
   * for this: that is what makes the snapshot empty, and it is why the report
   * said a refresh came first.
   *
   * Asserted against the file, and against both halves of the binding, because
   * both halves are what went. The undo also has to still be an undo -- a fix
   * that made Ctrl+Z do nothing would pass a "the board survived" check.
   */
  const undoFile = path.join(workspace, "undo.excalidraw");
  const undoNodes = Array.from({ length: 6 }, (_, index) => ({
    id: `u${index}`,
    label: `Box ${index}`,
  }));
  const undoBoard = await createDiagram(emptyBoard(), {
    title: "Undo",
    name: "u",
    nodes: undoNodes,
    edges: undoNodes.slice(1).map((node, index) => ({
      from: undoNodes[index].id,
      to: node.id,
      label: `step ${index}`,
    })),
  });
  await writeBoard(undoFile, undoBoard.board);

  /** Labels the board carries, and labels whose box has stopped listing them. */
  const bindings = (board) => {
    const live = board.elements.filter((element) => !element.isDeleted);
    const byId = new Map(live.map((element) => [String(element.id), element]));
    const labelled = live.filter((element) => typeof element.containerId === "string");
    const orphaned = labelled.filter((element) => {
      const container = byId.get(element.containerId);
      if (!container) return true;
      return !(container.boundElements ?? []).some((entry) => String(entry?.id) === String(element.id));
    });
    return { live: live.length, labels: labelled.length, orphaned: orphaned.length };
  };

  const undoPage = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  undoPage.on("pageerror", (error) => errors.push(String(error)));
  await undoPage.goto(server.urlFor(undoFile), { waitUntil: "load" });
  await undoPage.waitForFunction(() => typeof window.__boardScene === "function", undefined, { timeout: 20_000 });
  await waitForScene(undoPage, (value) => value.count > 0 && settled(value));

  const undoBefore = bindings(await readBoard(undoFile));
  const placedBefore = (await readBoard(undoFile)).elements.find((element) => element.customData?.node === "u0");

  // One ordinary edit, made the way a person makes it: select the diagram and
  // drag it. A hand edit is what arms the undo -- it is the first thing
  // Excalidraw captures, and before the fix it captured the whole board with it.
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await undoPage.mouse.click(700, 400);
  await undoPage.keyboard.press(`${modifier}+a`);
  await undoPage.waitForTimeout(300);
  await undoPage.mouse.move(700, 400);
  await undoPage.mouse.down();
  await undoPage.mouse.move(760, 430, { steps: 10 });
  await undoPage.mouse.up();
  await undoPage.waitForTimeout(1500);
  const placedAfterDrag = (await readBoard(undoFile)).elements.find((element) => element.customData?.node === "u0");
  check(
    "the drag reaches the file",
    placedAfterDrag && placedBefore && placedAfterDrag.x !== placedBefore.x,
    `${placedBefore?.x} -> ${placedAfterDrag?.x}`,
  );

  await undoPage.keyboard.press(`${modifier}+z`);
  await undoPage.waitForTimeout(2500);

  const undoAfter = bindings(await readBoard(undoFile));
  check(
    "an undo on a freshly opened board does not empty it",
    undoAfter.live === undoBefore.live,
    `${undoBefore.live} -> ${undoAfter.live} elements`,
  );
  check(
    "an undo does not strip the boxes of their labels",
    undoAfter.orphaned === 0 && undoAfter.labels === undoBefore.labels,
    `${undoAfter.orphaned} orphaned of ${undoAfter.labels} labels`,
  );
  const placedAfterUndo = (await readBoard(undoFile)).elements.find((element) => element.customData?.node === "u0");
  check(
    "the undo is still an undo",
    placedAfterUndo && placedBefore && placedAfterUndo.x === placedBefore.x,
    `${placedAfterDrag?.x} -> ${placedAfterUndo?.x}, expected ${placedBefore?.x}`,
  );
  /*
   * Clearing a board by hand still works.
   *
   * Here because the first fix for #164 refused it: the guard was phrased as
   * "this save empties the board", which cannot tell select-all-and-Delete apart
   * from the wreck, and broke an obvious gesture to defend against a bug that
   * was already fixed a layer up. The guard now asks about the one thing the
   * wreck did that no deletion does -- tearing a label off a box going down with
   * it -- and this is what stops that from being widened back.
   */
  await undoPage.mouse.click(700, 400);
  await undoPage.keyboard.press(`${modifier}+a`);
  await undoPage.waitForTimeout(300);
  await undoPage.keyboard.press("Delete");
  await undoPage.waitForTimeout(2500);

  const cleared = bindings(await readBoard(undoFile));
  check(
    "selecting everything and deleting it clears the board",
    cleared.live === 0,
    `${undoBefore.live} -> ${cleared.live} elements left`,
  );
  const clearedCanvas = await scene(undoPage);
  check(
    "the cleared board is not pushed back onto the canvas",
    clearedCanvas.count === 0,
    `${clearedCanvas.count} on the canvas`,
  );
  const noRefusal = await undoPage.$(".status-note");
  check("clearing a board is not refused", noRefusal === null);

  await undoPage.screenshot({ path: shot("6-after-undo") });
  await undoPage.close();

  /*
   * The way from a board to every other board.
   *
   * The index exists and is printed by the command, but a page you can only
   * reach by having been told it exists is the one part of this that nobody
   * finds. The filename in the pill is the link, checked here rather than by
   * asserting an href: what matters is that clicking it lands somewhere that
   * lists boards.
   */
  const indexHref = await page.$eval(".status-file", (el) => el.getAttribute("href"));
  check("the board's name links to the index", indexHref === "/boards", String(indexHref));

  const indexPage = await browser.newPage();
  await indexPage.goto(new URL("/boards", server.url).href, { waitUntil: "load" });
  await indexPage.waitForFunction(() => document.querySelectorAll("#boards li a .name").length > 0, undefined, {
    timeout: 10_000,
  });
  const listed = await indexPage.$$eval("#boards li a .name", (nodes) => nodes.map((node) => node.textContent));
  check(
    "the index lists the board being served",
    listed.some((name) => String(name).endsWith("twin.excalidraw") || String(name).endsWith("live.excalidraw")),
    listed.join(", "),
  );
  await indexPage.screenshot({ path: shot("4-index") });
  await indexPage.close();

  // The pill must not present a filename as current once the connection is gone:
  // the server may have been re-pointed or replaced, and the page cannot tell.
  await server.close();
  await page.waitForFunction(() => document.querySelector(".status-file-stale") !== null, undefined, {
    timeout: 10_000,
  }).catch(() => undefined);
  check("pill marks the filename stale once disconnected", await page.$eval(".status", (el) => el.querySelector(".status-file-stale") !== null), await pillText());

  // Excalidraw owns the bottom-right corner: the Help button and the zen-mode
  // exit both live there, and the pill used to sit on top of them.
  const overlapping = await page.evaluate(() => {
    const rect = (el) => el.getBoundingClientRect();
    const hit = (a, b) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
    const pill = rect(document.querySelector(".status"));
    return [...document.querySelectorAll("button, .help-icon")]
      .filter((el) => rect(el).width > 0 && hit(pill, rect(el)))
      .map((el) => el.getAttribute("aria-label") ?? el.className.toString().slice(0, 30));
  });
  check("pill does not cover Excalidraw's own controls", overlapping.length === 0, overlapping.join(", "));

  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  console.log(
    `\nscreenshots: ${shot("1-initial")}  ${shot("2-after-replacement")}  ${shot("3-after-reveal")}`,
  );
} finally {
  await browser?.close();
  await server?.close();
  rmSync(workspace, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log("\nall checks passed");
}
