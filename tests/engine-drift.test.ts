/**
 * Drift detection. The tests that matter are the negative ones: a check that
 * reports something wrong gets switched off, and then it catches nothing.
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace, parseRef, refFromLabel, type Workspace } from "../src/engine/drift";
import { readGraph } from "../src/engine/graph";
import type { ExcalidrawElement } from "../src/engine/normalize";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

/** A workspace over a plain map, so the checks are testable without a tree. */
function fakeWorkspace(files: Record<string, string | "dir">): Workspace {
  // Normalize a path by removing leading ./, collapsing //, etc.
  function normalize(p: string): string | undefined {
    if (p.startsWith("../")) return undefined;
    while (p.startsWith("./")) {
      p = p.substring(2);
    }
    p = p.replace(/\/+/g, "/");  // Collapse multiple slashes
    return p;
  }

  return {
    resolve: (relative) => {
      const normalized = normalize(relative);
      return normalized ? normalized : undefined;
    },
    stat: (target) => {
      const normalized = normalize(target);
      if (!normalized) return "missing";
      const entry = files[normalized];
      if (entry === undefined) return "missing";
      return entry === "dir" ? "directory" : "file";
    },
    read: (target) => {
      const normalized = normalize(target);
      if (!normalized) return "";
      return String(files[normalized]);
    },
    // One level, matching the real workspace: entries directly inside, never a
    // walk. Derived from the flat map by taking the next path segment.
    list: (target) => {
      const normalized = normalize(target);
      if (!normalized) return [];
      const prefix = `${normalized.replace(/\/$/, "")}/`;
      const entries = new Set<string>();
      for (const key of Object.keys(files)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest) entries.add(rest.split("/")[0]!);
      }
      return [...entries];
    },
  };
}

async function boardWith(nodes: Array<{ id: string; label: string; ref?: string }>): Promise<BoardFile> {
  const result = await createDiagram(emptyBoard(), { name: "arch", nodes, edges: [] });
  return result.board;
}

// The first layout loads ELK and the font metrics, which costs seconds. Paid
// here so it lands on a hook's budget instead of whichever test happened to run
// first -- boards are built through the real pipeline on purpose, so that a ref
// is proven to survive schema, customData and readGraph rather than being
// hand-placed into an element.
beforeAll(async () => {
  await boardWith([{ id: "warmup", label: "Warm up" }]);
}, 60_000);

describe("parsing refs", () => {
  it("splits path#symbol", () => {
    expect(parseRef("src/engine/layout.ts#planDiagramLayout")).toEqual({
      path: "src/engine/layout.ts",
      symbol: "planDiagramLayout",
    });
    expect(parseRef("src/engine/layout.ts")).toEqual({ path: "src/engine/layout.ts" });
    // A trailing hash is a path, not a request to check the empty symbol.
    expect(parseRef("src/engine/layout.ts#")).toEqual({ path: "src/engine/layout.ts" });
  });

  it("reads a label as a path only when it unambiguously is one", () => {
    expect(refFromLabel("src/engine/layout.ts")).toBe("src/engine/layout.ts");
    expect(refFromLabel("  docs/diagrams/a.excalidraw  ")).toBe("docs/diagrams/a.excalidraw");
    // The cases that would make this feature a liability.
    expect(refFromLabel("Auth")).toBeUndefined();
    expect(refFromLabel("POST /api/file")).toBeUndefined();
    expect(refFromLabel("Layout engine")).toBeUndefined();
    expect(refFromLabel("src/engine")).toBeUndefined();
  });
});

describe("checking a board against the code", () => {
  it("is clean when every ref exists", async () => {
    const board = await boardWith([
      { id: "layout", label: "Layout", ref: "src/engine/layout.ts" },
      { id: "graph", label: "Graph", ref: "src/engine/graph.ts" },
    ]);
    const report = checkDrift(
      board,
      fakeWorkspace({ "src/engine/layout.ts": "x", "src/engine/graph.ts": "y" }),
    );
    expect(report).toMatchObject({ clean: true, findings: [], checked: 2, skipped: 0 });
  });

  it("reports exactly the node whose file is gone", async () => {
    const board = await boardWith([
      { id: "layout", label: "Layout", ref: "src/engine/layout.ts" },
      { id: "old", label: "Renderer", ref: "src/renderer/diagram-layout.ts" },
    ]);
    const report = checkDrift(board, fakeWorkspace({ "src/engine/layout.ts": "x" }));
    expect(report.clean).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      node: "old",
      label: "Renderer",
      kind: "missing-file",
      provenance: "recorded",
    });
    expect(report.findings[0].detail).toContain("no longer exists");
  });

  it("skips nodes with nothing to check instead of guessing", async () => {
    const board = await boardWith([
      { id: "auth", label: "Auth" },
      { id: "queue", label: "Job queue" },
    ]);
    const report = checkDrift(board, fakeWorkspace({}));
    // Clean, but honest about having examined nothing -- the tool turns this
    // into a note, because "clean" over zero checks is not a pass.
    expect(report).toMatchObject({ clean: true, checked: 0, skipped: 2 });
  });

  it("never reports hand-drawn nodes, even when their label looks like a path", () => {
    const board: BoardFile = {
      ...emptyBoard(),
      elements: [
        { id: "r1", type: "rectangle", x: 0, y: 0, width: 200, height: 100, isDeleted: false, version: 1 },
        {
          id: "t1",
          type: "text",
          x: 20,
          y: 40,
          width: 160,
          height: 20,
          text: "src/gone/away.ts",
          isDeleted: false,
          version: 1,
        },
      ] as ExcalidrawElement[],
    };
    const report = checkDrift(board, fakeWorkspace({}));
    expect(report).toMatchObject({ clean: true, findings: [], checked: 0, handDrawn: 1 });
  });

  it("checks a generated node's label when no ref was recorded, and says it inferred that", async () => {
    const board = await boardWith([{ id: "n1", label: "src/gone/away.ts" }]);
    const report = checkDrift(board, fakeWorkspace({}));
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ kind: "missing-file", provenance: "inferred" });
  });

  it("catches a renamed symbol inside a file that still exists", async () => {
    const board = await boardWith([
      { id: "a", label: "Layout", ref: "src/engine/layout.ts#planDiagramLayout" },
      { id: "b", label: "Old", ref: "src/engine/layout.ts#planOldLayout" },
    ]);
    const report = checkDrift(
      board,
      fakeWorkspace({ "src/engine/layout.ts": "export async function planDiagramLayout() {}" }),
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ node: "b", kind: "missing-symbol" });
  });

  it("does not match a symbol that is only part of a longer name", async () => {
    const board = await boardWith([{ id: "a", label: "Plan", ref: "f.ts#plan" }]);
    const report = checkDrift(board, fakeWorkspace({ "f.ts": "function planDiagramLayout() {}" }));
    expect(report.findings[0]).toMatchObject({ kind: "missing-symbol" });
  });

  it("treats a directory ref as satisfied by the directory having something in it", async () => {
    const board = await boardWith([{ id: "eng", label: "Engine", ref: "src/engine" }]);
    const files = { "src/engine": "dir" as const, "src/engine/layout.ts": "export const x = 1;" };
    expect(checkDrift(board, fakeWorkspace(files)).clean).toBe(true);
  });

  it("finds a symbol somewhere inside a directory", async () => {
    // This used to be unresolvable-ref -- "a directory cannot contain a symbol".
    // It is a reasonable thing to mean, and one listing answers it.
    const board = await boardWith([{ id: "eng", label: "Engine", ref: "src/engine#planLayout" }]);
    const files = {
      "src/engine": "dir" as const,
      "src/engine/layout.ts": "export function planLayout() {}",
      "src/engine/other.ts": "export const other = 1;",
    };
    expect(checkDrift(board, fakeWorkspace(files)).clean).toBe(true);
  });

  it("reports a symbol that is in no file directly inside the directory", async () => {
    const board = await boardWith([{ id: "eng", label: "Engine", ref: "src/engine#gone" }]);
    const files = { "src/engine": "dir" as const, "src/engine/layout.ts": "export const x = 1;" };
    const report = checkDrift(board, fakeWorkspace(files));
    expect(report.findings[0]).toMatchObject({ kind: "missing-symbol" });
    expect(report.findings[0].detail).toContain("directly in");
  });

  it("refuses a recorded ref that leaves the repository, but ignores an inferred one", async () => {
    const escaping = await boardWith([{ id: "a", label: "Secrets", ref: "../../.ssh/id_rsa" }]);
    const report = checkDrift(escaping, fakeWorkspace({}));
    expect(report.findings[0]).toMatchObject({ kind: "unresolvable-ref" });

    // Read off a label it is a guess, not a claim, so it is not worth a finding.
    const labelled = await boardWith([{ id: "a", label: "../../.ssh/id_rsa" }]);
    expect(checkDrift(labelled, fakeWorkspace({}))).toMatchObject({ clean: true, skipped: 1 });
  });

  it("survives a ref written with a regex metacharacter in the symbol", async () => {
    const board = await boardWith([{ id: "a", label: "Odd", ref: "f.ts#a(b" }]);
    expect(() => checkDrift(board, fakeWorkspace({ "f.ts": "nothing" }))).not.toThrow();
  });
});

describe("the real filesystem workspace", () => {
  const root = mkdtempSync(path.join(tmpdir(), "drift-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("resolves a path inside the root and reads it", () => {
    writeFileSync(path.join(root, "kept.ts"), "export const kept = 1;");
    const workspace = createWorkspace(root);
    const resolved = workspace.resolve("kept.ts");
    expect(resolved).toBeDefined();
    expect(workspace.stat(resolved!)).toBe("file");
    expect(workspace.read(resolved!)).toContain("kept");
  });

  it("reports a missing file as missing rather than throwing", () => {
    const workspace = createWorkspace(root);
    expect(workspace.stat(workspace.resolve("nope.ts")!)).toBe("missing");
  });

  it("refuses refs that escape the root, including via a symlink", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "x");
    mkdirSync(path.join(root, "nested"), { recursive: true });
    symlinkSync(outside, path.join(root, "nested", "escape"));

    const workspace = createWorkspace(root);
    expect(workspace.resolve("../outside/secret.txt")).toBeUndefined();
    expect(workspace.resolve("/etc/passwd")).toBeUndefined();
    // The symlink target exists, so without the realpath check this would
    // happily confirm a file outside the repository.
    expect(workspace.resolve("nested/escape/secret.txt")).toBeUndefined();
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("regression: real board must be clean", () => {
  it("board-internals.excalidraw has 0 false positives", async () => {
    // Load the real board from docs/diagrams and check it against the repo root.
    // This pins the measured result: 12 edges checked, 2 skipped (directory targets),
    // 0 flagged.
    const boardPath = path.join(import.meta.dirname, "../docs/diagrams/board-internals.excalidraw");
    const board = await (await import("../src/engine/board-file")).readBoard(boardPath);
    const workspace = createWorkspace(path.join(import.meta.dirname, ".."));
    const report = checkDrift(board, workspace);

    // Node checks: all nodes should be clean
    expect(report.findings).toHaveLength(0);

    // Edge checks: should have checked some edges with zero findings
    expect(report.edgesChecked).toBeGreaterThan(0);

    // Debug: print flagged edges if any
    if (report.edges.length > 0) {
      console.log(`\nFlagged edges (${report.edges.length}):`);
      for (const edge of report.edges) {
        console.log(`  ${edge.fromLabel} → ${edge.toLabel}: ${edge.detail.substring(0, 60)}...`);
      }
    }

    expect(report.edges).toHaveLength(0);
  });
});

describe("edge checking", () => {
  it("is clean when every edge is backed by a channel", async () => {
    const board = await boardWith([
      { id: "a", label: "A", ref: "a.ts" },
      { id: "b", label: "B", ref: "b.ts" },
    ]);
    // Manually patch the board to add an edge: normally edges come from create_diagram
    // with the edge in customData. We test this by creating the edge directly.
    const elements = [...board.elements];
    const nodeA = elements.find((el) => (el as any).customData?.node === "a");
    const nodeB = elements.find((el) => (el as any).customData?.node === "b");
    elements.push({
      id: "edge-test",
      type: "arrow",
      x: 0,
      y: 0,
      width: 100,
      height: 0,
      angle: 0,
      strokeColor: "#000",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: "a1",
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 0,
      link: null,
      locked: false,
      customData: { origin: "diagram", diagram: "test", edge: { from: "a", to: "b" } },
      points: [[0, 0], [100, 0]],
      lastCommittedPoint: null,
      startBinding: { elementId: nodeA?.id, focus: 0, gap: 0 },
      endBinding: { elementId: nodeB?.id, focus: 0, gap: 0 },
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
    } as any);

    // Channel 1: A imports B
    const report1 = checkDrift(
      { ...board, elements },
      fakeWorkspace({
        "a.ts": 'import { B } from "./b.ts";',
        "b.ts": "export const B = 1;",
      }),
    );
    expect(report1.edges).toHaveLength(0);
    expect(report1.edgesChecked).toBe(1);

    // Channel 2: B imports A
    const report2 = checkDrift(
      { ...board, elements },
      fakeWorkspace({
        "a.ts": "export const A = 1;",
        "b.ts": 'import { A } from "./a.ts";',
      }),
    );
    expect(report2.edges).toHaveLength(0);

    // Channel 3: Shared importer C (C must be on the board or imported by board members)
    const boardWithC = await boardWith([
      { id: "a", label: "A", ref: "a.ts" },
      { id: "b", label: "B", ref: "b.ts" },
      { id: "c", label: "C", ref: "c.ts" },
    ]);
    const elementsWithC = [...boardWithC.elements];
    const nodeAC = elementsWithC.find((el) => (el as any).customData?.node === "a");
    const nodeBC = elementsWithC.find((el) => (el as any).customData?.node === "b");
    elementsWithC.push({
      id: "edge-test-c",
      type: "arrow",
      x: 0,
      y: 0,
      width: 100,
      height: 0,
      angle: 0,
      strokeColor: "#000",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: "a1",
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 0,
      link: null,
      locked: false,
      customData: { origin: "diagram", diagram: "test", edge: { from: "a", to: "b" } },
      points: [[0, 0], [100, 0]],
      lastCommittedPoint: null,
      startBinding: { elementId: nodeAC?.id, focus: 0, gap: 0 },
      endBinding: { elementId: nodeBC?.id, focus: 0, gap: 0 },
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
    } as any);

    const report3 = checkDrift(
      { ...boardWithC, elements: elementsWithC },
      fakeWorkspace({
        "a.ts": "export const A = 1;",
        "b.ts": "export const B = 1;",
        "c.ts": 'import { A } from "./a.ts"; import { B } from "./b.ts";',
      }),
    );
    expect(report3.edges).toHaveLength(0);

    // Channel 4: Shared route literal
    const report4 = checkDrift(
      { ...board, elements },
      fakeWorkspace({
        "a.ts": 'const route = "/api/events";',
        "b.ts": 'const route = "/api/events";',
      }),
    );
    expect(report4.edges).toHaveLength(0);
  });

  it("flags an edge when no channel fires", async () => {
    const board = await boardWith([
      { id: "a", label: "A", ref: "a.ts" },
      { id: "b", label: "B", ref: "b.ts" },
    ]);
    const elements = [...board.elements];
    const nodeA = elements.find((el) => (el as any).customData?.node === "a");
    const nodeB = elements.find((el) => (el as any).customData?.node === "b");
    elements.push({
      id: "edge-test",
      type: "arrow",
      x: 0,
      y: 0,
      width: 100,
      height: 0,
      angle: 0,
      strokeColor: "#000",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: "a1",
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 0,
      link: null,
      locked: false,
      customData: { origin: "diagram", diagram: "test", edge: { from: "a", to: "b" } },
      points: [[0, 0], [100, 0]],
      lastCommittedPoint: null,
      startBinding: { elementId: nodeA?.id, focus: 0, gap: 0 },
      endBinding: { elementId: nodeB?.id, focus: 0, gap: 0 },
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
    } as any);

    const report = checkDrift(
      { ...board, elements },
      fakeWorkspace({
        "a.ts": "export const A = 1;",
        "b.ts": "export const B = 1;",
      }),
    );
    expect(report.edges).toHaveLength(1);
    expect(report.edges[0]).toMatchObject({
      from: "a.ts",
      to: "b.ts",
      fromLabel: "A",
      toLabel: "B",
      kind: "unsupported-edge",
    });
    expect(report.edges[0].detail).toContain("worth a look");
  });

  it("skips edges touching directory refs", async () => {
    const board = await boardWith([
      { id: "a", label: "A", ref: "src" },
      { id: "b", label: "B", ref: "b.ts" },
    ]);
    const elements = [...board.elements];
    const nodeA = elements.find((el) => (el as any).customData?.node === "a");
    const nodeB = elements.find((el) => (el as any).customData?.node === "b");
    elements.push({
      id: "edge-test",
      type: "arrow",
      x: 0,
      y: 0,
      width: 100,
      height: 0,
      angle: 0,
      strokeColor: "#000",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: "a1",
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 0,
      link: null,
      locked: false,
      customData: { origin: "diagram", diagram: "test", edge: { from: "a", to: "b" } },
      points: [[0, 0], [100, 0]],
      lastCommittedPoint: null,
      startBinding: { elementId: nodeA?.id, focus: 0, gap: 0 },
      endBinding: { elementId: nodeB?.id, focus: 0, gap: 0 },
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
    } as any);

    const report = checkDrift(
      { ...board, elements },
      fakeWorkspace({
        "src": "dir",
        "b.ts": "export const B = 1;",
      }),
    );
    expect(report.edgesSkipped).toBe(1);
    expect(report.edges).toHaveLength(0);
  });

  it("skips hand-drawn edges", async () => {
    const board: BoardFile = {
      ...emptyBoard(),
      elements: [
        { id: "r1", type: "rectangle", x: 0, y: 0, width: 200, height: 100, isDeleted: false, version: 1 },
        { id: "r2", type: "rectangle", x: 300, y: 0, width: 200, height: 100, isDeleted: false, version: 1 },
        {
          id: "t1",
          type: "text",
          x: 20,
          y: 40,
          width: 160,
          height: 20,
          text: "a.ts",
          isDeleted: false,
          version: 1,
        },
        {
          id: "t2",
          type: "text",
          x: 320,
          y: 40,
          width: 160,
          height: 20,
          text: "b.ts",
          isDeleted: false,
          version: 1,
        },
        {
          id: "arrow",
          type: "arrow",
          x: 200,
          y: 50,
          width: 100,
          height: 0,
          isDeleted: false,
          version: 1,
          points: [[0, 0], [100, 0]],
        },
      ] as ExcalidrawElement[],
    };
    const report = checkDrift(board, fakeWorkspace({ "a.ts": "x", "b.ts": "y" }));
    expect(report.edgesSkipped).toBe(1);
  });

  it("disables edge check with { edges: false }", async () => {
    const board = await boardWith([
      { id: "a", label: "A", ref: "a.ts" },
      { id: "b", label: "B", ref: "b.ts" },
    ]);
    const elements = [...board.elements];
    const nodeA = elements.find((el) => (el as any).customData?.node === "a");
    const nodeB = elements.find((el) => (el as any).customData?.node === "b");
    elements.push({
      id: "edge-test",
      type: "arrow",
      x: 0,
      y: 0,
      width: 100,
      height: 0,
      angle: 0,
      strokeColor: "#000",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: "a1",
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 0,
      link: null,
      locked: false,
      customData: { origin: "diagram", diagram: "test", edge: { from: "a", to: "b" } },
      points: [[0, 0], [100, 0]],
      lastCommittedPoint: null,
      startBinding: { elementId: nodeA?.id, focus: 0, gap: 0 },
      endBinding: { elementId: nodeB?.id, focus: 0, gap: 0 },
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
    } as any);

    const report = checkDrift(
      { ...board, elements },
      fakeWorkspace({
        "a.ts": "export const A = 1;",
        "b.ts": "export const B = 1;",
      }),
      { edges: false },
    );
    expect(report.edgesChecked).toBe(0);
    expect(report.edgesSkipped).toBe(0);
    expect(report.edges).toHaveLength(0);
  });

  it("shared importer in subdirectory (not on board) resolves correctly", async () => {
    // Regression test for one-hop expansion: when a shared importer is discovered
    // as an import of a board file, its relative path must be tracked correctly
    // so its own imports are resolved relative to its directory, not the repo root.
    const boardWithD = await boardWith([
      { id: "a", label: "A", ref: "src/a.ts" },
      { id: "b", label: "B", ref: "src/b.ts" },
      { id: "d", label: "D", ref: "src/d.ts" },
    ]);
    const elementsWithD = [...boardWithD.elements];
    const nodeAD = elementsWithD.find((el) => (el as any).customData?.node === "a");
    const nodeBD = elementsWithD.find((el) => (el as any).customData?.node === "b");
    elementsWithD.push({
      id: "edge-subdir",
      type: "arrow",
      x: 0,
      y: 0,
      width: 100,
      height: 0,
      angle: 0,
      strokeColor: "#000",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: "a1",
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 0,
      link: null,
      locked: false,
      customData: { origin: "diagram", diagram: "test", edge: { from: "a", to: "b" } },
      points: [[0, 0], [100, 0]],
      lastCommittedPoint: null,
      startBinding: { elementId: nodeAD?.id, focus: 0, gap: 0 },
      endBinding: { elementId: nodeBD?.id, focus: 0, gap: 0 },
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
    } as any);

    // d.ts imports c.ts; c.ts imports both a.ts and b.ts (shared importer NOT on board)
    const report = checkDrift(
      { ...boardWithD, elements: elementsWithD },
      fakeWorkspace({
        "src/a.ts": "export const A = 1;",
        "src/b.ts": "export const B = 1;",
        "src/d.ts": 'import { C } from "./c.ts";',
        "src/c.ts": 'import { A } from "./a.ts"; import { B } from "./b.ts";',
      }),
    );
    // The edge a→b must be backed because c.ts (discovered via d.ts import)
    // imports both a and b
    expect(report.edges).toHaveLength(0);
  });
});

/**
 * The arrow check used to refuse any edge it had not drawn itself. That rule read
 * as "hand-drawn arrows are unreliable" but meant "Claude did not draw it", and
 * it silently skipped the case this tool exists for: sketching the connection you
 * want between two components that already exist.
 *
 * Measured before shipping, as #17 insisted. Across 12 real boards in two
 * projects there were 357 arrows and not one hand-drawn — so the change moves
 * nothing that exists today, and the population it governs had to be built here
 * to be measured at all.
 */
describe("an arrow is trusted for its bindings, not its author", () => {
  /** Replaces the generated edge with a person's arrow between the same two boxes. */
  function handDrawnArrow(board: BoardFile, { bound }: { bound: boolean }): BoardFile {
    const shapes = board.elements.filter((element) => element.type === "rectangle");
    const [a, b] = shapes as Array<ExcalidrawElement & { x: number; y: number; width: number; height: number }>;
    const arrow = {
      id: "hand-arrow",
      type: "arrow",
      // Ends land on the two boxes, so the proximity fallback has something to
      // find when there is no binding to use.
      x: a.x + a.width,
      y: a.y + a.height / 2,
      width: b.x - (a.x + a.width),
      height: 0,
      points: [[0, 0], [b.x - (a.x + a.width), 0]],
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: "a99",
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 0,
      link: null,
      locked: false,
      startBinding: bound ? { elementId: a.id, focus: 0, gap: 4 } : null,
      endBinding: bound ? { elementId: b.id, focus: 0, gap: 4 } : null,
      // No customData at all: this is the human's arrow, not ours.
    } as unknown as ExcalidrawElement;
    return { ...board, elements: [...board.elements.filter((element) => element.type !== "arrow"), arrow] };
  }

  async function twoBoxes(): Promise<BoardFile> {
    return boardWith([
      { id: "a", label: "Left", ref: "left.ts" },
      { id: "b", label: "Right", ref: "right.ts" },
    ]);
  }

  const unconnected = { "left.ts": "export const left = 1;", "right.ts": "export const right = 1;" };
  const connected = {
    "left.ts": 'import { right } from "./right";\nexport const left = right;',
    "right.ts": "export const right = 1;",
  };

  it("checks a hand-drawn arrow bound at both ends", async () => {
    const board = handDrawnArrow(await twoBoxes(), { bound: true });
    const report = checkDrift(board, fakeWorkspace(unconnected));
    expect(report.edgesChecked).toBe(1);
    expect(report.edgesSkipped).toBe(0);
    // Nothing in the code connects these two, and the arrow says something does.
    expect(report.edges).toHaveLength(1);
    expect(report.edges[0]).toMatchObject({ kind: "unsupported-edge", fromLabel: "Left", toLabel: "Right" });
  });

  it("stays quiet about a hand-drawn arrow the code actually supports", async () => {
    // The half that keeps this usable: once the connection is written, the
    // sketch stops being a finding. Without this the check would flag every
    // arrow forever and get switched off.
    const board = handDrawnArrow(await twoBoxes(), { bound: true });
    const report = checkDrift(board, fakeWorkspace(connected));
    expect(report.edgesChecked).toBe(1);
    expect(report.edges).toHaveLength(0);
  });

  it("still skips an arrow whose ends were matched by proximity", async () => {
    // Geometry guesswork, whoever drew it. Both scenarios, so it is clear the
    // skip is about the endpoints and not about the code.
    for (const files of [unconnected, connected]) {
      const board = handDrawnArrow(await twoBoxes(), { bound: false });
      const report = checkDrift(board, fakeWorkspace(files));
      expect(report.edgesChecked).toBe(0);
      expect(report.edgesSkipped).toBe(1);
      expect(report.edges).toHaveLength(0);
      // And it says so. On the canvas this arrow is indistinguishable from a
      // bound one, so a bare count leaves the reader with no way to find out.
      expect(report.edgesSkippedWhy).toEqual({ "ends-not-bound": 1 });
    }
  });

  it("does not relabel who drew the arrow in order to check it", async () => {
    // Provenance stays an honest answer about authorship; trustworthiness moved
    // to its own field rather than being smuggled into this one.
    const board = handDrawnArrow(await twoBoxes(), { bound: true });
    const graph = readGraph(board);
    expect(graph.edges[0]).toMatchObject({ provenance: "inferred", endpoints: "bound" });
  });
});

describe("state: what the diagram claims about time", () => {
  /** A board whose nodes carry a state, built through the real pipeline. */
  async function stateBoard(
    nodes: Array<{ id: string; label: string; ref?: string; state?: "planned" | "built" | "external" }>,
    options?: { title?: string; describes?: "repo" | "concept"; edges?: Array<{ from: string; to: string; state?: "planned" | "built" | "external" }> },
  ): Promise<BoardFile> {
    const result = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes,
      edges: options?.edges ?? [],
      ...(options?.title ? { title: options.title } : {}),
      ...(options?.describes ? { describes: options.describes } : {}),
    });
    return result.board;
  }

  it("defaults to built, so every board drawn before this field means what it meant", async () => {
    const board = await stateBoard([{ id: "a", label: "A", ref: "src/a.ts" }]);
    expect(readGraph(board).nodes[0]!.state).toBe("built");
    // And the default is not written, so a board that says nothing about state
    // stays byte-identical to one written before the field existed.
    const shape = board.elements.find((e) => (e.customData as { node?: string })?.node === "a");
    expect(shape!.customData).toMatchObject({ node: "a", ref: "src/a.ts" });
    expect(shape!.customData).not.toHaveProperty("state");
  });

  it("falls back to built on a value it does not recognise", async () => {
    // A board is user data and can say anything; it must not throw.
    const board = await stateBoard([{ id: "a", label: "A", ref: "src/a.ts" }]);
    const shape = board.elements.find((e) => (e.customData as { node?: string })?.node === "a")!;
    shape.customData = { node: "a", ref: "src/a.ts", state: "wishful" };
    expect(readGraph(board).nodes[0]!.state).toBe("built");
  });

  it("reports a planned node whose file is absent as work, not as drift", async () => {
    const board = await stateBoard([{ id: "a", label: "Auth service", ref: "src/auth.ts", state: "planned" }]);
    const report = checkDrift(board, fakeWorkspace({}));
    // The distinction that makes a diagram usable as a spec.
    expect(report.findings).toHaveLength(0);
    expect(report.workItems).toHaveLength(1);
    expect(report.workItems[0]).toMatchObject({ node: "a", ref: "src/auth.ts", kind: "missing-file" });
    // A build must not fail because somebody sketched next week's work.
    expect(report.clean).toBe(true);
  });

  it("reports a planned node whose file arrived as a promotion", async () => {
    const board = await stateBoard([{ id: "a", label: "Auth service", ref: "src/auth.ts", state: "planned" }]);
    const report = checkDrift(board, fakeWorkspace({ "src/auth.ts": "export const x = 1;" }));
    expect(report.promotions).toHaveLength(1);
    expect(report.promotions[0]).toMatchObject({ node: "a", ref: "src/auth.ts" });
    expect(report.findings).toHaveLength(0);
    expect(report.clean).toBe(true);
  });

  it("still calls a built node's missing file a regression", async () => {
    // The same detection as the work item above; only the declared state differs.
    const board = await stateBoard([{ id: "a", label: "Auth service", ref: "src/auth.ts" }]);
    const report = checkDrift(board, fakeWorkspace({}));
    expect(report.findings).toHaveLength(1);
    expect(report.workItems).toHaveLength(0);
    expect(report.clean).toBe(false);
  });

  it("keeps a malformed ref loud even when the node is planned", async () => {
    // Escaping the root is not a thing waiting to be built: writing the code
    // would never make it resolve.
    const board = await stateBoard([{ id: "a", label: "A", ref: "../outside.ts", state: "planned" }]);
    const report = checkDrift(board, fakeWorkspace({}));
    expect(report.workItems).toHaveLength(0);
    expect(report.findings[0]).toMatchObject({ kind: "unresolvable-ref" });
    expect(report.clean).toBe(false);
  });

  it("excuses an external node instead of counting it as unannotated", async () => {
    const board = await stateBoard([
      { id: "browser", label: "Browser canvas", state: "external" },
      { id: "a", label: "A", ref: "src/a.ts" },
    ]);
    const report = checkDrift(board, fakeWorkspace({ "src/a.ts": "x" }));
    expect(report).toMatchObject({ excused: 1, skipped: 0, checked: 1, clean: true });
  });

  it("excuses every node on a concept board and checks none of its arrows", async () => {
    const board = await stateBoard(
      [
        { id: "ue", label: "UE" },
        { id: "cscf", label: "P-CSCF" },
      ],
      { title: "IMS registration", describes: "concept", edges: [{ from: "ue", to: "cscf" }] },
    );
    expect(readGraph(board).describes).toBe("concept");
    const report = checkDrift(board, fakeWorkspace({}));
    expect(report).toMatchObject({ concept: true, excused: 2, skipped: 0, checked: 0, clean: true });
    expect(report.edgesChecked).toBe(0);
  });

  it("does not record describes for a repo board, so existing files do not churn", async () => {
    const board = await stateBoard([{ id: "a", label: "A" }], { title: "How it works", describes: "repo" });
    const title = board.elements.find((e) => (e.customData as { role?: string })?.role === "title");
    expect(title!.customData).toMatchObject({ role: "title" });
    expect(title!.customData).not.toHaveProperty("describes");
    expect(readGraph(board).describes).toBeUndefined();
  });

  it("reports a planned edge with no corroboration as work, not as an unsupported arrow", async () => {
    const board = await stateBoard(
      [
        { id: "a", label: "A", ref: "src/a.ts" },
        { id: "b", label: "B", ref: "src/b.ts" },
      ],
      { edges: [{ from: "a", to: "b", state: "planned" }] },
    );
    const report = checkDrift(board, fakeWorkspace({ "src/a.ts": "export const a = 1;", "src/b.ts": "export const b = 2;" }));
    expect(report.edges).toHaveLength(0);
    expect(report.workItems).toHaveLength(1);
    expect(report.workItems[0]).toMatchObject({ kind: "unsupported-edge", node: "a -> b" });
    expect(report.clean).toBe(true);
  });

  it("promotes a planned edge once the code connects it", async () => {
    const board = await stateBoard(
      [
        { id: "a", label: "A", ref: "src/a.ts" },
        { id: "b", label: "B", ref: "src/b.ts" },
      ],
      { edges: [{ from: "a", to: "b", state: "planned" }] },
    );
    const report = checkDrift(board, fakeWorkspace({
      "src/a.ts": "import { b } from './b';\nexport const a = b;",
      "src/b.ts": "export const b = 2;",
    }));
    expect(report.promotions).toHaveLength(1);
    expect(report.promotions[0]).toMatchObject({ node: "a -> b" });
    expect(report.edges).toHaveLength(0);
  });

  it("skips an arrow that touches an external node", async () => {
    const board = await stateBoard(
      [
        { id: "a", label: "A", ref: "src/a.ts" },
        { id: "browser", label: "Browser", ref: "src/b.ts", state: "external" },
      ],
      { edges: [{ from: "a", to: "browser" }] },
    );
    const report = checkDrift(board, fakeWorkspace({ "src/a.ts": "export const a = 1;", "src/b.ts": "export const b = 2;" }));
    expect(report.edgesChecked).toBe(0);
    expect(report.edgesSkipped).toBe(1);
    expect(report.edges).toHaveLength(0);
  });
});

/**
 * What the board stopped saying.
 *
 * Deleting a box removes every other finding about it, so this is the check that
 * cannot be tested by adding something -- only by taking something away. The two
 * silences below matter as much as the finding: one is the mute, the other is the
 * deletion being honest.
 */
describe("a box removed while its code is still there", () => {
  /** A baseline over a board held in memory, so no git is involved. */
  function baselineOf(board: BoardFile | undefined) {
    return { committed: () => board };
  }

  async function withBoxes(ids: string[]) {
    const result = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: ids.map((id) => ({ id, label: id.toUpperCase(), ref: `src/${id}.ts` })),
      edges: [],
    });
    return result.board;
  }

  it("reports the box that went, naming the file that stayed", async () => {
    const before = await withBoxes(["layout", "convert"]);
    const after = await withBoxes(["convert"]);
    const report = checkDrift(after, fakeWorkspace({ "src/layout.ts": "x", "src/convert.ts": "y" }), {
      baseline: baselineOf(before),
    });
    expect(report.deleted).toHaveLength(1);
    expect(report.deleted[0]).toMatchObject({ node: "layout", ref: "src/layout.ts", kind: "deleted-claim" });
    // Loud: this is the one hole where the diagram got quieter by being wrong.
    expect(report.clean).toBe(false);
  });

  it("says nothing when the code went with the box", async () => {
    // The deletion tracks the code, so the board is telling the truth.
    const before = await withBoxes(["layout", "convert"]);
    const after = await withBoxes(["convert"]);
    const report = checkDrift(after, fakeWorkspace({ "src/convert.ts": "y" }), {
      baseline: baselineOf(before),
    });
    expect(report.deleted).toHaveLength(0);
    expect(report.clean).toBe(true);
  });

  it("says nothing when there is no baseline to compare against", async () => {
    // No git, an untracked board, or a board nobody has touched since committing.
    // layout.ts is present and unmentioned by the board -- exactly the state the
    // finding is about -- and with nothing to compare against there is no finding.
    const after = await withBoxes(["convert"]);
    const report = checkDrift(after, fakeWorkspace({ "src/layout.ts": "x", "src/convert.ts": "y" }), {
      baseline: baselineOf(undefined),
    });
    expect(report.deleted).toHaveLength(0);
    expect(report.clean).toBe(true);
  });

  it("does not call a changed ref a deletion", async () => {
    // The node is still there. The ordinary checks own whether its ref resolves.
    const before = await withBoxes(["layout"]);
    const after = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [{ id: "layout", label: "LAYOUT", ref: "src/engine/layout.ts" }],
      edges: [],
    });
    const report = checkDrift(
      after.board,
      fakeWorkspace({ "src/layout.ts": "x", "src/engine/layout.ts": "x" }),
      { baseline: baselineOf(before) },
    );
    expect(report.deleted).toHaveLength(0);
  });

  it("does not call a regenerated diagram a deletion", async () => {
    // Regeneration writes fresh element ids and keeps node ids, so anything keyed
    // on elements would report every redraw as a mass deletion.
    const before = await withBoxes(["layout", "convert"]);
    const after = await withBoxes(["layout", "convert"]);
    const elementIds = (board: BoardFile) => board.elements.map((element) => element.id);
    expect(elementIds(after)).toEqual(elementIds(before));
    const report = checkDrift(after, fakeWorkspace({ "src/layout.ts": "x", "src/convert.ts": "y" }), {
      baseline: baselineOf(before),
    });
    expect(report.deleted).toHaveLength(0);
  });

  it("ignores a removed external box, which never claimed anything", async () => {
    const before = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "browser", label: "Browser", ref: "src/layout.ts", state: "external" },
        { id: "convert", label: "CONVERT", ref: "src/convert.ts" },
      ],
      edges: [],
    });
    const after = await withBoxes(["convert"]);
    const report = checkDrift(after, fakeWorkspace({ "src/layout.ts": "x", "src/convert.ts": "y" }), {
      baseline: baselineOf(before.board),
    });
    expect(report.deleted).toHaveLength(0);
  });
});

/**
 * The other direction: code the diagram does not show.
 *
 * The reason this stayed unbuilt for so long is the relevance bar -- without one,
 * every file in the repo is drift. The bar here is inherited rather than invented,
 * so the tests that matter are the ones proving it stays inside the diagram's own
 * neighbourhood and never becomes a repo scan.
 */
/**
 * The other direction: a box with no code.
 *
 * These are the boxes every other check is blind to. `skippedWhy` has always
 * counted them, and a count is right for the per-turn notice, but a count is
 * not actionable -- nobody diffs a 33-box board against a number by eye, and
 * the measured evidence is that nobody annotates by hand at all. So the
 * on-demand channel names them.
 *
 * The tests that matter here are the ones proving what is *not* in the list. A
 * box that has already said it is not about this repo has given a complete
 * answer, and nagging about it would teach people to ignore the list.
 */
describe("boxes the diagram leaves unanchored", () => {
  async function boardOf(
    nodes: Array<{ id: string; label: string; ref?: string; state?: "planned" | "built" | "external" }>,
    describes?: "repo" | "concept",
  ) {
    // `describes` is recorded on the title element, so a concept board needs a
    // title. Passing one without the other is silently ignored, which this
    // helper would otherwise hide.
    return (await createDiagram(emptyBoard(), {
      name: "arch",
      nodes,
      edges: [],
      ...(describes ? { describes, title: "A board" } : {}),
    })).board;
  }
  const tree = { "src/a.ts": "export const a = 1;" };

  it("names the box and its label, which is the only evidence of intent", async () => {
    const board = await boardOf([
      { id: "a", label: "A", ref: "src/a.ts" },
      { id: "mystery", label: "Board MCP server" },
    ]);
    const report = checkDrift(board, fakeWorkspace(tree), { coverage: true });
    expect(report.unannotated).toEqual([{ node: "mystery", label: "Board MCP server" }]);
    // Unanchored is not drift. It was never a claim, so it cannot have broken.
    expect(report.clean).toBe(true);
  });

  it("stays silent unless asked, because a per-turn nag gets the check switched off", async () => {
    const board = await boardOf([{ id: "mystery", label: "Board MCP server" }]);
    const report = checkDrift(board, fakeWorkspace(tree));
    expect(report.unannotated).toEqual([]);
    // The count is still there every turn; only the naming is on demand.
    expect(report.skippedWhy).toEqual({ "no-ref": 1 });
  });

  it("says nothing about a box that declared itself external", async () => {
    // "not in this repo" is a complete answer, not a missing one.
    const board = await boardOf([{ id: "you", label: "You", state: "external" }]);
    expect(checkDrift(board, fakeWorkspace(tree), { coverage: true }).unannotated).toEqual([]);
  });

  it("says nothing about any box on a concept board", async () => {
    // A board about a protocol makes no claims about this tree, so having no
    // anchor is the point rather than an omission.
    const board = await boardOf(
      [{ id: "scscf", label: "S-CSCF" }, { id: "hss", label: "HSS" }],
      "concept",
    );
    expect(checkDrift(board, fakeWorkspace(tree), { coverage: true }).unannotated).toEqual([]);
  });

  it("says nothing about a hand-drawn box, which is a sketch and not a claim", async () => {
    const board = await boardOf([{ id: "a", label: "A", ref: "src/a.ts" }]);
    board.elements.push({
      id: "sketch", type: "rectangle", x: 900, y: 900, width: 100, height: 60,
    } as unknown as (typeof board.elements)[number]);
    expect(checkDrift(board, fakeWorkspace(tree), { coverage: true }).unannotated).toEqual([]);
  });

  it("drops the box from the list once it carries an anchor", async () => {
    const board = await boardOf([{ id: "mcp", label: "Board MCP server", ref: "src/a.ts" }]);
    expect(checkDrift(board, fakeWorkspace(tree), { coverage: true }).unannotated).toEqual([]);
  });
});

describe("code the diagram leaves out", () => {
  const tree = {
    "src/a.ts": "import { b } from './b';\nimport { deep } from './deep';\nexport const a = b;",
    "src/b.ts": "export const b = 1;",
    "src/deep.ts": "import { far } from './far';\nexport const deep = 2;",
    "src/far.ts": "export const far = 3;",
    "src/unrelated.ts": "export const unrelated = 4;",
  };

  async function boardOf(nodes: Array<{ id: string; label: string; ref?: string; state?: "planned" | "built" | "external" }>) {
    return (await createDiagram(emptyBoard(), { name: "arch", nodes, edges: [] })).board;
  }

  it("suggests a file the board's own boxes import but no box shows", async () => {
    const board = await boardOf([{ id: "a", label: "A", ref: "src/a.ts" }]);
    const report = checkDrift(board, fakeWorkspace(tree), { coverage: true });
    expect(report.unrepresented.map((entry) => entry.file)).toEqual(["src/b.ts", "src/deep.ts"]);
    expect(report.unrepresented[0]).toMatchObject({ importedBy: ["src/a.ts"] });
    // A suggestion is not a defect.
    expect(report.clean).toBe(true);
  });

  it("stops at one hop, so it never becomes a repo scan", async () => {
    // far.ts is imported by deep.ts, which is itself only a suggestion. Following
    // it would be the walk that made this unbuildable for the whole project.
    const board = await boardOf([{ id: "a", label: "A", ref: "src/a.ts" }]);
    const files = checkDrift(board, fakeWorkspace(tree), { coverage: true })
      .unrepresented.map((entry) => entry.file);
    expect(files).not.toContain("src/far.ts");
    // And nothing the board never pointed at can appear at all.
    expect(files).not.toContain("src/unrelated.ts");
  });

  it("drops a suggestion once it has a box, and the neighbourhood moves out with it", async () => {
    // Adding the box both answers the old suggestion and earns a new one: far.ts
    // is now one hop from something on the board. The frontier follows the
    // diagram, which is the property that keeps this bounded without a threshold.
    const board = await boardOf([
      { id: "a", label: "A", ref: "src/a.ts" },
      { id: "b", label: "B", ref: "src/b.ts" },
      { id: "d", label: "D", ref: "src/deep.ts" },
    ]);
    const report = checkDrift(board, fakeWorkspace(tree), { coverage: true });
    expect(report.unrepresented.map((entry) => entry.file)).toEqual(["src/far.ts"]);
  });

  it("has nothing left to suggest once every reachable file is drawn", async () => {
    const board = await boardOf([
      { id: "a", label: "A", ref: "src/a.ts" },
      { id: "b", label: "B", ref: "src/b.ts" },
      { id: "d", label: "D", ref: "src/deep.ts" },
      { id: "f", label: "F", ref: "src/far.ts" },
    ]);
    // unrelated.ts stays out of it: nothing on the board imports it, so it was
    // never a candidate. That is the whole reason this is not a repo scan.
    expect(checkDrift(board, fakeWorkspace(tree), { coverage: true }).unrepresented).toEqual([]);
  });

  it("lets one directory box cover everything beneath it", async () => {
    // Otherwise a box for a subsystem nominates every file in the subsystem.
    const board = await boardOf([
      { id: "a", label: "A", ref: "src/a.ts" },
      { id: "src", label: "Everything", ref: "src" },
    ]);
    const report = checkDrift(board, fakeWorkspace({ ...tree, src: "dir" }), { coverage: true });
    expect(report.unrepresented).toEqual([]);
  });

  it("ranks the module that several boxes depend on first", async () => {
    const shared = {
      "src/one.ts": "import { core } from './core';\nexport const one = core;",
      "src/two.ts": "import { core } from './core';\nexport const two = core;",
      "src/three.ts": "import { solo } from './solo';\nexport const three = solo;",
      "src/core.ts": "export const core = 1;",
      "src/solo.ts": "export const solo = 2;",
    };
    const board = await boardOf([
      { id: "one", label: "One", ref: "src/one.ts" },
      { id: "two", label: "Two", ref: "src/two.ts" },
      { id: "three", label: "Three", ref: "src/three.ts" },
    ]);
    const report = checkDrift(board, fakeWorkspace(shared), { coverage: true });
    expect(report.unrepresented[0]).toMatchObject({
      file: "src/core.ts",
      importedBy: ["src/one.ts", "src/two.ts"],
    });
    expect(report.unrepresented[1]).toMatchObject({ file: "src/solo.ts" });
  });

  it("is off unless asked for, because it suggests rather than reports", async () => {
    const board = await boardOf([{ id: "a", label: "A", ref: "src/a.ts" }]);
    expect(checkDrift(board, fakeWorkspace(tree)).unrepresented).toEqual([]);
  });

  it("says nothing on a concept board, and ignores an external box's ref", async () => {
    const concept = await createDiagram(emptyBoard(), {
      name: "arch",
      title: "A protocol",
      describes: "concept",
      nodes: [{ id: "a", label: "A", ref: "src/a.ts" }],
      edges: [],
    });
    expect(checkDrift(concept.board, fakeWorkspace(tree), { coverage: true }).unrepresented).toEqual([]);

    const external = await boardOf([{ id: "a", label: "A", ref: "src/a.ts", state: "external" }]);
    expect(checkDrift(external, fakeWorkspace(tree), { coverage: true }).unrepresented).toEqual([]);
  });
});

/**
 * Why something was not checked.
 *
 * "5 arrows skipped" is not usable by anyone: it cannot be told apart from "there
 * was nothing here I could read", and it never says which of seven reasons
 * applied. These pin the reason, not the count.
 */
describe("saying what was not looked at", () => {
  async function boardOf(
    nodes: Array<{ id: string; label: string; ref?: string; state?: "planned" | "built" | "external" }>,
    edges: Array<{ from: string; to: string }> = [],
  ) {
    return (await createDiagram(emptyBoard(), { name: "arch", nodes, edges })).board;
  }

  it("separates a box with no ref from one whose ref leaves the repo", async () => {
    const board = await boardOf([
      { id: "plain", label: "Auth" },
      { id: "outside", label: "../outside/thing.ts" },
    ]);
    const report = checkDrift(board, fakeWorkspace({}));
    expect(report.skipped).toBe(2);
    expect(report.skippedWhy).toEqual({ "no-ref": 1, "ref-outside-repo": 1 });
  });

  it("names the reason an arrow was skipped, for each distinct reason", async () => {
    const cases: Array<[string, () => Promise<BoardFile>, Record<string, string | "dir">, string]> = [
      [
        "an end with no ref",
        () => boardOf([{ id: "a", label: "A", ref: "src/a.ts" }, { id: "b", label: "B" }], [{ from: "a", to: "b" }]),
        { "src/a.ts": "x" },
        "endpoint-has-no-ref",
      ],
      [
        "an end marked external",
        () => boardOf(
          [{ id: "a", label: "A", ref: "src/a.ts" }, { id: "b", label: "B", ref: "src/b.ts", state: "external" }],
          [{ from: "a", to: "b" }],
        ),
        { "src/a.ts": "x", "src/b.ts": "y" },
        "endpoint-external",
      ],
      [
        "an end whose file is gone",
        () => boardOf(
          [{ id: "a", label: "A", ref: "src/a.ts" }, { id: "b", label: "B", ref: "src/b.ts" }],
          [{ from: "a", to: "b" }],
        ),
        { "src/a.ts": "x" },
        "endpoint-file-missing",
      ],
      [
        "an end refing a directory",
        () => boardOf(
          [{ id: "a", label: "A", ref: "src/a.ts" }, { id: "b", label: "B", ref: "src/lib" }],
          [{ from: "a", to: "b" }],
        ),
        { "src/a.ts": "x", "src/lib": "dir" },
        "directory-ref",
      ],
      [
        "an end in another language",
        () => boardOf(
          [{ id: "a", label: "A", ref: "src/a.ts" }, { id: "b", label: "B", ref: "src/b.py" }],
          [{ from: "a", to: "b" }],
        ),
        { "src/a.ts": "x", "src/b.py": "y" },
        "not-ts-or-js",
      ],
    ];

    for (const [name, make, files, reason] of cases) {
      const report = checkDrift(await make(), fakeWorkspace(files));
      expect(report.edgesSkipped, name).toBe(1);
      expect(report.edgesSkippedWhy, name).toEqual({ [reason]: 1 });
    }
  });

  it("counts the same reason more than once rather than collapsing it", async () => {
    const board = await boardOf(
      [
        { id: "a", label: "A", ref: "src/a.ts" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
      [{ from: "a", to: "b" }, { from: "a", to: "c" }],
    );
    const report = checkDrift(board, fakeWorkspace({ "src/a.ts": "x" }));
    expect(report.edgesSkippedWhy).toEqual({ "endpoint-has-no-ref": 2 });
  });

  it("leaves the breakdown empty when everything was checked", async () => {
    const board = await boardOf(
      [{ id: "a", label: "A", ref: "src/a.ts" }, { id: "b", label: "B", ref: "src/b.ts" }],
      [{ from: "a", to: "b" }],
    );
    const report = checkDrift(board, fakeWorkspace({
      "src/a.ts": "import { b } from './b';\nexport const a = b;",
      "src/b.ts": "export const b = 1;",
    }));
    expect(report.skippedWhy).toEqual({});
    expect(report.edgesSkippedWhy).toEqual({});
    expect(report.checked).toBe(2);
    expect(report.edgesChecked).toBe(1);
  });
});

/**
 * What a box is allowed to say.
 *
 * The measurement that motivated this: `#symbol` had never been used once in 117
 * nodes. The check was strongest at the claim people least wanted to make — this
 * file exists — and had no way to express the ones they actually draw.
 */
describe("anchor forms", () => {
  const engine = {
    "src/engine": "dir" as const,
    "src/engine/layout.ts": "export function planLayout() {}",
    "src/engine/convert.ts": "export const convert = 1;",
    "src/engine/notes.md": "# notes",
  };

  async function boardOf(nodes: Array<{ id: string; label: string; ref?: string; refs?: string[] }>) {
    return (await createDiagram(emptyBoard(), { name: "arch", nodes, edges: [] })).board;
  }

  it("accepts a trailing slash as saying 'directory', whatever is on disk", async () => {
    const board = await boardOf([{ id: "e", label: "Engine", ref: "src/engine/" }]);
    expect(checkDrift(board, fakeWorkspace(engine)).clean).toBe(true);
  });

  it("reports a trailing slash on something that is a file", async () => {
    // The point of allowing the slash is that it is a claim, so it can be wrong.
    const board = await boardOf([{ id: "e", label: "Layout", ref: "src/engine/layout.ts/" }]);
    const report = checkDrift(board, fakeWorkspace(engine));
    expect(report.findings[0]).toMatchObject({ kind: "unresolvable-ref" });
    expect(report.findings[0].detail).toContain("is a file, not a directory");
  });

  it("reports an empty directory rather than calling it satisfied", async () => {
    const board = await boardOf([{ id: "e", label: "Engine", ref: "src/empty/" }]);
    const report = checkDrift(board, fakeWorkspace({ "src/empty": "dir" }));
    expect(report.findings[0]).toMatchObject({ kind: "empty-ref" });
    expect(report.clean).toBe(false);
  });

  it("matches a glob over one directory", async () => {
    const board = await boardOf([{ id: "e", label: "Engine", ref: "src/engine/*.ts" }]);
    expect(checkDrift(board, fakeWorkspace(engine)).clean).toBe(true);
  });

  it("reports a glob that matches nothing", async () => {
    const board = await boardOf([{ id: "e", label: "Rust", ref: "src/engine/*.rs" }]);
    const report = checkDrift(board, fakeWorkspace(engine));
    expect(report.findings[0]).toMatchObject({ kind: "empty-ref" });
    expect(report.findings[0].detail).toContain("matches no files");
  });

  it("refuses a star outside the last segment, and refuses **", async () => {
    // This is the security boundary, not a parser limitation: the directory
    // prefix stays literal, so a ref lists one directory and never searches.
    for (const ref of ["src/*/layout.ts", "src/**/*.ts", "**/*.ts"]) {
      const board = await boardOf([{ id: "e", label: "Wide", ref }]);
      const report = checkDrift(board, fakeWorkspace(engine));
      expect(report.findings[0], ref).toMatchObject({ kind: "unresolvable-ref" });
      expect(report.findings[0].detail, ref).toContain("never searched");
    }
  });

  it("finds a symbol across the files a glob matched", async () => {
    const board = await boardOf([{ id: "e", label: "Engine", ref: "src/engine/*.ts#planLayout" }]);
    expect(checkDrift(board, fakeWorkspace(engine)).clean).toBe(true);
  });

  it("does not read a directory bigger than the cap, and says nothing about it", async () => {
    // A box standing for a thousand files is not making a checkable claim, and
    // reading them every turn is not a per-turn budget. Skipped, never guessed.
    const many: Record<string, string | "dir"> = { "src/big": "dir" };
    for (let i = 0; i < 60; i += 1) many[`src/big/file${i}.ts`] = "export const x = 1;";
    const board = await boardOf([{ id: "b", label: "Big", ref: "src/big/#nothingHere" }]);
    const report = checkDrift(board, fakeWorkspace(many));
    expect(report.findings).toEqual([]);
    expect(report.skipped).toBe(1);
  });

  it("checks every anchor a box lists, and names the one that broke", async () => {
    const board = await boardOf([
      { id: "log", label: "Logging", ref: "src/engine/layout.ts", refs: ["src/engine/convert.ts", "src/engine/gone.ts"] },
    ]);
    const report = checkDrift(board, fakeWorkspace(engine));
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ ref: "src/engine/gone.ts", kind: "missing-file" });
    // One box is one thing on the diagram, however many anchors it carries.
    expect(report.checked).toBe(1);
  });

  it("is clean only when every anchor holds", async () => {
    const board = await boardOf([
      { id: "log", label: "Logging", ref: "src/engine/layout.ts", refs: ["src/engine/convert.ts"] },
    ]);
    expect(checkDrift(board, fakeWorkspace(engine)).clean).toBe(true);
  });

  it("survives the round trip through customData", async () => {
    const board = await boardOf([
      { id: "log", label: "Logging", ref: "src/a.ts", refs: ["src/b.ts", "src/c.ts"] },
    ]);
    expect(readGraph(board).nodes[0]).toMatchObject({
      ref: "src/a.ts",
      refs: ["src/b.ts", "src/c.ts"],
    });
  });

  it("does not suggest a file that a secondary anchor already covers", async () => {
    const files = {
      "src/a.ts": "import { b } from './b';\nexport const a = b;",
      "src/b.ts": "export const b = 1;",
    };
    const board = await boardOf([{ id: "a", label: "A", ref: "src/a.ts", refs: ["src/b.ts"] }]);
    expect(checkDrift(board, fakeWorkspace(files), { coverage: true }).unrepresented).toEqual([]);
  });
});
