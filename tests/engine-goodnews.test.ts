/**
 * Good news since the last commit (#67). The negative tests are the ones that
 * matter: a green line that fires on cosmetic edits gets the whole notice
 * switched off, and then the real news reaches nobody.
 */
import { describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { goodNewsIds, goodNewsLine, goodNewsSince, hasGoodNews, novelGoodNews } from "../src/engine/goodnews";
import type { ExcalidrawElement } from "../src/engine/normalize";
import type { NodeState } from "../src/engine/graph";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

type NodeSpec = { id: string; label: string; ref?: string; state?: NodeState };
type EdgeSpec = { from: string; to: string; label?: string; state?: NodeState };

async function boardWith(nodes: NodeSpec[], edges: EdgeSpec[] = []): Promise<BoardFile> {
  const result = await createDiagram(emptyBoard(), { name: "arch", nodes, edges });
  return result.board;
}

/** A bare element of the kind Excalidraw writes when a human draws it. */
function drawn(element: Partial<ExcalidrawElement> & { id: string; type: string }): ExcalidrawElement {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    isDeleted: false,
    version: 1,
    ...element,
  } as ExcalidrawElement;
}

describe("good news since the last commit", () => {
  it("is silence, not an error, when there is nothing to compare against", async () => {
    const board = await boardWith([{ id: "a", label: "A" }]);
    expect(goodNewsSince(board, undefined)).toBeUndefined();
  });

  it("reports a box the committed board did not have", async () => {
    const committed = await boardWith([{ id: "a", label: "A" }]);
    const board = await boardWith([
      { id: "a", label: "A" },
      { id: "b", label: "B", state: "planned" },
    ]);
    const news = goodNewsSince(board, committed)!;
    expect(news.addedBoxes).toEqual([{ node: "b", label: "B" }]);
    expect(news.builtBoxes).toEqual([]);
    expect(news.builtEdges).toEqual([]);
  });

  it("reports a planned box that now claims built, whoever flipped it", async () => {
    const committed = await boardWith([
      { id: "a", label: "A" },
      { id: "b", label: "B", state: "planned" },
    ]);
    const board = await boardWith([
      { id: "a", label: "A" },
      { id: "b", label: "B", state: "built" },
    ]);
    const news = goodNewsSince(board, committed)!;
    expect(news.addedBoxes).toEqual([]);
    expect(news.builtBoxes).toEqual([{ node: "b", label: "B" }]);
  });

  it("reports a planned arrow that now claims built", async () => {
    const nodes: NodeSpec[] = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ];
    const committed = await boardWith(nodes, [{ from: "a", to: "b", state: "planned" }]);
    const board = await boardWith(nodes, [{ from: "a", to: "b", state: "built" }]);
    const news = goodNewsSince(board, committed)!;
    expect(news.addedBoxes).toEqual([]);
    expect(news.builtBoxes).toEqual([]);
    expect(news.builtEdges).toEqual([{ from: "a", to: "b" }]);
  });

  it("says nothing about an identical board", async () => {
    const spec: NodeSpec[] = [
      { id: "a", label: "A" },
      { id: "b", label: "B", state: "planned" },
    ];
    const committed = await boardWith(spec, [{ from: "a", to: "b", state: "planned" }]);
    const board = await boardWith(spec, [{ from: "a", to: "b", state: "planned" }]);
    const news = goodNewsSince(board, committed)!;
    expect(hasGoodNews(news)).toBe(false);
  });

  it("says nothing about a relabel — the id is the identity", async () => {
    const committed = await boardWith([{ id: "a", label: "Auth" }]);
    const board = await boardWith([{ id: "a", label: "Auth service" }]);
    expect(hasGoodNews(goodNewsSince(board, committed)!)).toBe(false);
  });

  it("says nothing about deletions or regressions — those are the checker's job", async () => {
    const committed = await boardWith([
      { id: "a", label: "A" },
      { id: "b", label: "B", state: "built" },
    ]);
    // One box gone, the other demoted back to planned. Bad news, not this channel's.
    const board = await boardWith([{ id: "b", label: "B", state: "planned" }]);
    expect(hasGoodNews(goodNewsSince(board, committed)!)).toBe(false);
  });

  it("never announces an external box — scenery is not progress", async () => {
    const committed = await boardWith([{ id: "a", label: "A" }]);
    const board = await boardWith([
      { id: "a", label: "A" },
      { id: "browser", label: "Browser", state: "external" },
    ]);
    expect(hasGoodNews(goodNewsSince(board, committed)!)).toBe(false);
  });

  it("never announces the user's own hand-drawn additions back at them", async () => {
    const committed = await boardWith([{ id: "a", label: "A" }]);
    const generated = await boardWith([{ id: "a", label: "A" }]);
    const board: BoardFile = {
      ...generated,
      elements: [
        ...generated.elements,
        drawn({ id: "doodle", type: "rectangle", x: 500, y: 500, width: 120, height: 60 }),
      ],
    };
    expect(hasGoodNews(goodNewsSince(board, committed)!)).toBe(false);
  });
});

describe("the green line", () => {
  it("tallies each kind and stays one line", () => {
    expect(
      goodNewsLine({
        addedBoxes: [
          { node: "a", label: "A" },
          { node: "b", label: "B" },
        ],
        builtBoxes: [{ node: "c", label: "C" }],
        builtEdges: [{ from: "a", to: "c" }],
      }),
    ).toBe("+2 boxes · 1 built · 1 arrow wired");
  });

  it("uses singular forms and drops empty parts", () => {
    expect(
      goodNewsLine({ addedBoxes: [{ node: "a", label: "A" }], builtBoxes: [], builtEdges: [] }),
    ).toBe("+1 box");
  });

  it("is undefined when there is nothing to say — no empty green line", () => {
    expect(goodNewsLine({ addedBoxes: [], builtBoxes: [], builtEdges: [] })).toBeUndefined();
    expect(goodNewsLine(undefined)).toBeUndefined();
  });
});

describe("remembering what was already announced", () => {
  const news = {
    addedBoxes: [{ node: "a", label: "A" }],
    builtBoxes: [{ node: "a", label: "A" }],
    builtEdges: [{ from: "a", to: "b" }],
  };

  it("keeps an added box and a flipped box with the same id distinct", () => {
    expect(goodNewsIds(news)).toEqual(["+a", "=a", ">a→b"]);
  });

  it("filters to what has not been announced yet", () => {
    const novel = novelGoodNews(news, ["+a", ">a→b"]);
    expect(novel.addedBoxes).toEqual([]);
    expect(novel.builtBoxes).toEqual([{ node: "a", label: "A" }]);
    expect(novel.builtEdges).toEqual([]);
  });

  it("passes everything through when nothing was seen", () => {
    expect(novelGoodNews(news, [])).toEqual(news);
  });
});
