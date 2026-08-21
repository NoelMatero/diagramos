/**
 * The code graph channel: loader strictness and the shape of a connection.
 *
 * The one idea under test everywhere here: a connection is a chain whose edges
 * all point the same way. The two everyday false positives — two files that
 * both import the same helper, and one file that imports both ends — must
 * never read as a connection, while a genuine chain through another file must.
 */

import { describe, expect, it } from "vitest";

import { connects, loadCodeGraph, refIsStale } from "../src/engine/codegraph";

type RawNode = { id?: unknown; source_file?: unknown };
type RawLink = { source?: unknown; target?: unknown; relation?: unknown; confidence?: unknown };

function raw(
  nodes: Array<[id: string, file: string]>,
  links: Array<[source: string, target: string, relation?: string, confidence?: string]>,
): { nodes: RawNode[]; links: RawLink[] } {
  return {
    nodes: nodes.map(([id, source_file]) => ({ id, source_file })),
    links: links.map(([source, target, relation, confidence]) => ({
      source,
      target,
      relation: relation ?? "calls",
      confidence: confidence ?? "EXTRACTED",
    })),
  };
}

function graphOf(
  nodes: Array<[id: string, file: string]>,
  links: Array<[source: string, target: string, relation?: string, confidence?: string]>,
) {
  const graph = loadCodeGraph(raw(nodes, links), "0.9.47");
  expect(graph).toBeDefined();
  return graph!;
}

describe("loading a graphify export", () => {
  const valid = raw([["a", "src/a.ts"]], []);

  it("loads a tested version and refuses everything else", () => {
    expect(loadCodeGraph(valid, "0.9.47")).toBeDefined();
    expect(loadCodeGraph(valid, "0.9.1")).toBeDefined();
    expect(loadCodeGraph(valid, "0.10.0")).toBeUndefined();
    expect(loadCodeGraph(valid, "1.0.0")).toBeUndefined();
    expect(loadCodeGraph(valid, "")).toBeUndefined();
  });

  it("refuses a shape it does not fully understand", () => {
    expect(loadCodeGraph({} as never, "0.9.47")).toBeUndefined();
    expect(loadCodeGraph({ nodes: [], links: "no" } as never, "0.9.47")).toBeUndefined();
    expect(
      loadCodeGraph({ nodes: [{ id: 7, source_file: "src/a.ts" }], links: [] }, "0.9.47"),
    ).toBeUndefined();
    expect(
      loadCodeGraph(
        { nodes: [{ id: "a", source_file: "src/a.ts" }], links: [{ source: "a" }] },
        "0.9.47",
      ),
    ).toBeUndefined();
  });

  it("keeps only whitelisted relations at EXTRACTED confidence", () => {
    const graph = graphOf(
      [["a", "src/a.ts"], ["b", "src/b.ts"], ["c", "src/c.ts"], ["d", "src/d.ts"]],
      [
        ["a", "b", "calls", "INFERRED"], // right relation, guessed — dropped
        ["a", "c", "references"], // wrong relation — dropped
        ["a", "d", "extends"], // wrong relation — dropped
      ],
    );
    expect(connects(graph, "src/a.ts", "src/b.ts")).toBe(false);
    expect(connects(graph, "src/a.ts", "src/c.ts")).toBe(false);
    expect(connects(graph, "src/a.ts", "src/d.ts")).toBe(false);
  });

  it("drops edges that point at nodes the graph does not declare", () => {
    const graph = graphOf(
      [["a", "src/a.ts"], ["b", "src/b.ts"]],
      [["a", "ghost"], ["ghost", "b"]],
    );
    expect(connects(graph, "src/a.ts", "src/b.ts")).toBe(false);
  });
});

describe("what counts as a connection", () => {
  it("a direct edge connects, in either reading direction", () => {
    const graph = graphOf(
      [["a", "src/a.ts"], ["b", "src/b.ts"]],
      [["a", "b", "imports"]],
    );
    expect(connects(graph, "src/a.ts", "src/b.ts")).toBe(true);
    expect(connects(graph, "src/b.ts", "src/a.ts")).toBe(true);
  });

  it("a chain through another file connects: a → c → b", () => {
    const graph = graphOf(
      [["a", "src/a.ts"], ["c", "src/c.ts"], ["b", "src/b.ts"]],
      [["a", "c", "imports"], ["c", "b", "calls"]],
    );
    expect(connects(graph, "src/a.ts", "src/b.ts")).toBe(true);
  });

  it("two files importing the same helper do NOT connect: a → h ← b", () => {
    // The lodash trap. Both depend on h; neither reaches the other.
    const graph = graphOf(
      [["a", "src/a.ts"], ["h", "src/h.ts"], ["b", "src/b.ts"]],
      [["a", "h", "imports"], ["b", "h", "imports"]],
    );
    expect(connects(graph, "src/a.ts", "src/b.ts")).toBe(false);
  });

  it("two symbols calling the same utility do NOT connect: a → u ← b", () => {
    const graph = graphOf(
      [["fa", "src/a.ts"], ["u", "src/util.ts"], ["fb", "src/b.ts"]],
      [["fa", "u", "calls"], ["fb", "u", "calls"]],
    );
    expect(connects(graph, "src/a.ts", "src/b.ts")).toBe(false);
  });

  it("one file importing both ends does NOT connect them: a ← h → b", () => {
    // An entry point that imports everything must not bridge its imports.
    const graph = graphOf(
      [["a", "src/a.ts"], ["h", "src/main.ts"], ["b", "src/b.ts"]],
      [["h", "a", "imports"], ["h", "b", "imports"]],
    );
    expect(connects(graph, "src/a.ts", "src/b.ts")).toBe(false);
  });

  it("a barrel chain connects: a imports the barrel, the barrel re-exports b", () => {
    const graph = graphOf(
      [["a", "src/a.ts"], ["index", "src/lib/index.ts"], ["b", "src/lib/b.ts"]],
      [["a", "index", "imports"], ["index", "b", "re_exports"]],
    );
    expect(connects(graph, "src/a.ts", "src/lib/b.ts")).toBe(true);
  });

  it("a dynamic import counts", () => {
    const graph = graphOf(
      [["a", "src/a.ts"], ["b", "src/b.ts"]],
      [["a", "b", "dynamic_import"]],
    );
    expect(connects(graph, "src/a.ts", "src/b.ts")).toBe(true);
  });

  it("three hops connect, four do not", () => {
    const nodes: Array<[string, string]> = [
      ["n0", "src/f0.ts"],
      ["n1", "src/f1.ts"],
      ["n2", "src/f2.ts"],
      ["n3", "src/f3.ts"],
      ["n4", "src/f4.ts"],
    ];
    const links: Array<[string, string, string?]> = [
      ["n0", "n1"], ["n1", "n2"], ["n2", "n3"], ["n3", "n4"],
    ];
    const graph = graphOf(nodes, links);
    expect(connects(graph, "src/f0.ts", "src/f3.ts")).toBe(true); // 3 hops
    expect(connects(graph, "src/f0.ts", "src/f4.ts")).toBe(false); // 4 hops
  });

  it("a chain broken by one wrong-way edge does NOT connect", () => {
    // a → x, then b → x: the last edge points the wrong way, so no chain
    // a…b exists in either direction, even though an undirected walk finds one.
    const graph = graphOf(
      [["a", "src/a.ts"], ["x", "src/x.ts"], ["b", "src/b.ts"], ["y", "src/y.ts"]],
      [["a", "y", "imports"], ["y", "x", "imports"], ["b", "x", "imports"]],
    );
    expect(connects(graph, "src/a.ts", "src/b.ts")).toBe(false);
  });

  it("a file's symbols count as the file", () => {
    // The call leaves a symbol inside a.ts and lands on a symbol inside b.ts.
    const graph = graphOf(
      [["file_a", "src/a.ts"], ["fn_a", "src/a.ts"], ["fn_b", "src/b.ts"]],
      [["fn_a", "fn_b", "calls"]],
    );
    expect(connects(graph, "src/a.ts", "src/b.ts")).toBe(true);
  });

  it("a file never connects to itself", () => {
    // Two boxes on the same file expand to the same node set. Whatever that
    // file does internally, it is not evidence about an arrow between them.
    const graph = graphOf(
      [["fn_one", "src/a.ts"], ["fn_two", "src/a.ts"]],
      [["fn_one", "fn_two", "calls"]],
    );
    expect(connects(graph, "src/a.ts", "src/a.ts")).toBe(false);
  });

  it("an endpoint the extractor never saw is silence", () => {
    const graph = graphOf([["a", "src/a.ts"]], []);
    expect(connects(graph, "src/a.ts", "src/unseen.ts")).toBe(false);
    expect(connects(graph, "src/unseen.ts", "src/a.ts")).toBe(false);
  });
});

describe("directory endpoints", () => {
  const graph = () =>
    graphOf(
      [
        ["inner", "src/engine/inner.ts"],
        ["deep", "src/engine/sub/deep.ts"],
        ["sibling", "src/eng/sibling.ts"],
        ["b", "src/b.ts"],
      ],
      [["inner", "b", "imports"], ["sibling", "b", "imports"]],
    );

  it("a directory stands for everything under it", () => {
    expect(connects(graph(), "src/engine", "src/b.ts")).toBe(true);
    expect(connects(graph(), "src/engine/", "src/b.ts")).toBe(true);
  });

  it("a directory containing the other end confirms nothing", () => {
    // src/engine → src/engine/inner.ts. The sets overlap, so the walk would
    // start on its goal; against a graph with no edge between them that is a
    // confirmation out of thin air.
    const g = graphOf(
      [["inner", "src/engine/inner.ts"], ["other", "src/engine/other.ts"]],
      [],
    );
    expect(connects(g, "src/engine", "src/engine/inner.ts")).toBe(false);
    expect(connects(g, "src/engine/inner.ts", "src/engine")).toBe(false);
  });

  it("two directories that overlap confirm nothing", () => {
    // src/engine is inside src, so one set contains the other.
    const g = graphOf(
      [["inner", "src/engine/inner.ts"], ["b", "src/b.ts"]],
      [["inner", "b", "imports"]],
    );
    expect(connects(g, "src", "src/engine")).toBe(false);
  });

  it("a directory never matches a sibling sharing its prefix", () => {
    // src/eng/sibling.ts connects to b; src/engineX must not borrow that.
    const g = graphOf(
      [["sibling", "src/eng/sibling.ts"], ["b", "src/b.ts"]],
      [["sibling", "b", "imports"]],
    );
    expect(connects(g, "src/eng", "src/b.ts")).toBe(true);
    expect(connects(g, "src/en", "src/b.ts")).toBe(false);
  });
});

describe("staleness of a ref", () => {
  it("a file is stale when it is in the modified set", () => {
    expect(refIsStale("src/a.ts", new Set(["src/a.ts"]))).toBe(true);
    expect(refIsStale("src/a.ts", new Set(["src/b.ts"]))).toBe(false);
  });

  it("a directory is stale as soon as anything under it is", () => {
    expect(refIsStale("src/engine", new Set(["src/engine/deep/x.ts"]))).toBe(true);
    expect(refIsStale("src/engine", new Set(["src/eng/x.ts"]))).toBe(false);
    expect(refIsStale("src/eng", new Set(["src/engine/x.ts"]))).toBe(false);
  });
});
