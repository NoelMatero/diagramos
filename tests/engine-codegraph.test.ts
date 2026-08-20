/**
 * Code graph channel tests: a precomputed whole-repo graph read at check time.
 *
 * The channel corroborates arrows (suppresses "unsupported-edge") when the
 * endpoints connect through a path of extracted-confidence code relations:
 * calls, imports, imports_from, re_exports, dynamic_import. Directions are
 * treated as undirected (either direction is evidence).
 *
 * A path may not exceed 3 hops. Endpoints expand through contains/method
 * edges (these do not count as hops) to include symbols in the same file.
 */
import { describe, expect, it } from "vitest";

import { loadCodeGraph, connects } from "../src/engine/codegraph";

interface SimpleGraph {
  nodes: Array<{ id: string; source_file: string }>;
  links: Array<{
    source: string;
    target: string;
    relation: string;
    confidence: string;
  }>;
}

function makeGraph(
  nodes: Array<{ id: string; source_file: string }>,
  links: Array<{
    source: string;
    target: string;
    relation: string;
    confidence?: string;
  }>,
): SimpleGraph {
  return {
    nodes,
    links: links.map((l) => ({ ...l, confidence: l.confidence ?? "EXTRACTED" })),
  };
}

describe("loadCodeGraph", () => {
  it("loads a valid graph with nodes and links", () => {
    const graph = makeGraph(
      [
        { id: "a", source_file: "a.ts" },
        { id: "b", source_file: "b.ts" },
      ],
      [{ source: "a", target: "b", relation: "calls" }],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47");
    expect(loaded).toBeDefined();
  });

  it("returns undefined for missing nodes array", () => {
    const invalid = { links: [] } as any;
    const loaded = loadCodeGraph(invalid, "0.9.47");
    expect(loaded).toBeUndefined();
  });

  it("returns undefined for missing links array", () => {
    const invalid = { nodes: [] } as any;
    const loaded = loadCodeGraph(invalid, "0.9.47");
    expect(loaded).toBeUndefined();
  });

  it("returns undefined for node missing source_file", () => {
    const invalid = makeGraph(
      [{ id: "a" }] as any,
      [{ source: "a", target: "b", relation: "calls" }],
    );
    const loaded = loadCodeGraph(invalid as any, "0.9.47");
    expect(loaded).toBeUndefined();
  });

  it("returns undefined for edge missing required fields", () => {
    const invalid = makeGraph(
      [{ id: "a", source_file: "a.ts" }],
      [{ source: "a", target: "b" } as any],
    );
    const loaded = loadCodeGraph(invalid as any, "0.9.47");
    expect(loaded).toBeUndefined();
  });

  it("rejects version 0.10.0", () => {
    const graph = makeGraph(
      [{ id: "a", source_file: "a.ts" }],
      [],
    );
    const loaded = loadCodeGraph(graph as any, "0.10.0");
    expect(loaded).toBeUndefined();
  });

  it("accepts version 0.9.47", () => {
    const graph = makeGraph(
      [{ id: "a", source_file: "a.ts" }],
      [],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47");
    expect(loaded).toBeDefined();
  });

  it("accepts version 0.9.0", () => {
    const graph = makeGraph(
      [{ id: "a", source_file: "a.ts" }],
      [],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.0");
    expect(loaded).toBeDefined();
  });
});

describe("connects", () => {
  it("detects a direct call between files", () => {
    const graph = makeGraph(
      [
        { id: "a_fn", source_file: "a.ts" },
        { id: "b_fn", source_file: "b.ts" },
      ],
      [{ source: "a_fn", target: "b_fn", relation: "calls" }],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47")!;
    const result = connects(loaded, "a.ts", "b.ts");
    expect(result).toBe(true);
  });

  it("detects a call chain A→helper(C)→B within 3 hops", () => {
    // A calls helper in C, C calls B
    const graph = makeGraph(
      [
        { id: "a_main", source_file: "a.ts" },
        { id: "c_helper", source_file: "c.ts" },
        { id: "b_target", source_file: "b.ts" },
      ],
      [
        { source: "a_main", target: "c_helper", relation: "calls" },
        { source: "c_helper", target: "b_target", relation: "calls" },
      ],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47")!;
    const result = connects(loaded, "a.ts", "b.ts");
    expect(result).toBe(true);
  });

  it("treats imports as whitelisted edges", () => {
    const graph = makeGraph(
      [
        { id: "a_mod", source_file: "a.ts" },
        { id: "b_mod", source_file: "b.ts" },
      ],
      [{ source: "a_mod", target: "b_mod", relation: "imports" }],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47")!;
    const result = connects(loaded, "a.ts", "b.ts");
    expect(result).toBe(true);
  });

  it("treats imports_from as whitelisted", () => {
    const graph = makeGraph(
      [
        { id: "a_mod", source_file: "a.ts" },
        { id: "b_mod", source_file: "b.ts" },
      ],
      [{ source: "a_mod", target: "b_mod", relation: "imports_from" }],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47")!;
    const result = connects(loaded, "a.ts", "b.ts");
    expect(result).toBe(true);
  });

  it("treats re_exports as whitelisted", () => {
    const graph = makeGraph(
      [
        { id: "a_mod", source_file: "a.ts" },
        { id: "b_mod", source_file: "b.ts" },
      ],
      [{ source: "a_mod", target: "b_mod", relation: "re_exports" }],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47")!;
    const result = connects(loaded, "a.ts", "b.ts");
    expect(result).toBe(true);
  });

  it("treats dynamic_import as whitelisted", () => {
    const graph = makeGraph(
      [
        { id: "a_mod", source_file: "a.ts" },
        { id: "b_mod", source_file: "b.ts" },
      ],
      [{ source: "a_mod", target: "b_mod", relation: "dynamic_import" }],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47")!;
    const result = connects(loaded, "a.ts", "b.ts");
    expect(result).toBe(true);
  });

  it("ignores INFERRED edges", () => {
    const graph = makeGraph(
      [
        { id: "a_fn", source_file: "a.ts" },
        { id: "b_fn", source_file: "b.ts" },
      ],
      [{ source: "a_fn", target: "b_fn", relation: "calls", confidence: "INFERRED" }],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47")!;
    const result = connects(loaded, "a.ts", "b.ts");
    expect(result).toBe(false);
  });

  it("ignores AMBIGUOUS edges", () => {
    const graph = makeGraph(
      [
        { id: "a_fn", source_file: "a.ts" },
        { id: "b_fn", source_file: "b.ts" },
      ],
      [{ source: "a_fn", target: "b_fn", relation: "calls", confidence: "AMBIGUOUS" }],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47")!;
    const result = connects(loaded, "a.ts", "b.ts");
    expect(result).toBe(false);
  });

  it("ignores non-whitelisted relations", () => {
    const graph = makeGraph(
      [
        { id: "a_mod", source_file: "a.ts" },
        { id: "b_mod", source_file: "b.ts" },
      ],
      [
        { source: "a_mod", target: "b_mod", relation: "references" },
        { source: "a_mod", target: "b_mod", relation: "extends" },
      ],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47")!;
    const result = connects(loaded, "a.ts", "b.ts");
    expect(result).toBe(false);
  });

  it("respects undirectional path (B→A connection works when A→B is drawn)", () => {
    const graph = makeGraph(
      [
        { id: "a_fn", source_file: "a.ts" },
        { id: "b_fn", source_file: "b.ts" },
      ],
      [{ source: "b_fn", target: "a_fn", relation: "calls" }],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47")!;
    const result = connects(loaded, "a.ts", "b.ts");
    expect(result).toBe(true);
  });

  it("does not pass through a high-degree hub node (A→HUB←B pattern blocks A↔B)", () => {
    // A imports HUB, B imports HUB, but no whitelisted path A↔B without going through HUB twice
    const graph = makeGraph(
      [
        { id: "a_mod", source_file: "a.ts" },
        { id: "hub_mod", source_file: "hub.ts" },
        { id: "b_mod", source_file: "b.ts" },
      ],
      [
        { source: "a_mod", target: "hub_mod", relation: "imports" },
        { source: "b_mod", target: "hub_mod", relation: "imports" },
      ],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47")!;
    const result = connects(loaded, "a.ts", "b.ts");
    expect(result).toBe(false);
  });

  it("allows a legitimate 2-hop chain even with a hub present", () => {
    // A calls helper in B, B imports HUB, C imports HUB
    // A→B is legitimate even though the network has a hub
    const graph = makeGraph(
      [
        { id: "a_mod", source_file: "a.ts" },
        { id: "b_helper", source_file: "b.ts" },
        { id: "hub_mod", source_file: "hub.ts" },
        { id: "c_mod", source_file: "c.ts" },
      ],
      [
        { source: "a_mod", target: "b_helper", relation: "calls" },
        { source: "b_helper", target: "hub_mod", relation: "imports" },
        { source: "c_mod", target: "hub_mod", relation: "imports" },
      ],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47")!;
    const result = connects(loaded, "a.ts", "b.ts");
    expect(result).toBe(true);
  });

  it("expands file endpoints through contains edges to include symbols", () => {
    // file_a contains symbol_a, symbol_a calls symbol_b, file_b contains symbol_b
    const graph = makeGraph(
      [
        { id: "file_a", source_file: "a.ts" },
        { id: "symbol_a", source_file: "a.ts" },
        { id: "symbol_b", source_file: "b.ts" },
        { id: "file_b", source_file: "b.ts" },
      ],
      [
        { source: "file_a", target: "symbol_a", relation: "contains" },
        { source: "symbol_a", target: "symbol_b", relation: "calls" },
        { source: "file_b", target: "symbol_b", relation: "contains" },
      ],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47")!;
    const result = connects(loaded, "a.ts", "b.ts");
    expect(result).toBe(true);
  });

  it("expands directory endpoints to match files under the directory", () => {
    const graph = makeGraph(
      [
        { id: "a_fn", source_file: "a.ts" },
        { id: "b_fn", source_file: "src/engine/b.ts" },
      ],
      [{ source: "a_fn", target: "b_fn", relation: "calls" }],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47")!;
    // Testing with exact directory match
    const result = connects(loaded, "a.ts", "src/engine/");
    expect(result).toBe(true);
  });

  it("does not match directory endpoints to sibling paths with shared prefix", () => {
    const graph = makeGraph(
      [
        { id: "a_fn", source_file: "src/engine/a.ts" },
        { id: "b_fn", source_file: "src/eng/b.ts" },
      ],
      [], // No edge between them
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47")!;
    // src/eng/ should not match src/engine/ — they're separate directories
    const result = connects(loaded, "src/engine/", "src/eng/");
    expect(result).toBe(false);
  });

  it("respects 3-hop limit (4+ hops return false)", () => {
    // A→B→C→D→E is 4 hops, exceeds limit
    const graph = makeGraph(
      [
        { id: "a", source_file: "a.ts" },
        { id: "b", source_file: "b.ts" },
        { id: "c", source_file: "c.ts" },
        { id: "d", source_file: "d.ts" },
        { id: "e", source_file: "e.ts" },
      ],
      [
        { source: "a", target: "b", relation: "calls" },
        { source: "b", target: "c", relation: "calls" },
        { source: "c", target: "d", relation: "calls" },
        { source: "d", target: "e", relation: "calls" },
      ],
    );
    const loaded = loadCodeGraph(graph as any, "0.9.47")!;
    const result = connects(loaded, "a.ts", "e.ts");
    expect(result).toBe(false);
  });
});
