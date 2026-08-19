/**
 * Honest gaps computation: what a board does not show, split into gaps elsewhere and gaps nowhere.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { computeHonestGaps } from "../src/engine/gaps";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

async function createBoardFile(dir: string, name: string, board: BoardFile): Promise<string> {
  const filePath = path.join(dir, `${name}.excalidraw`);
  writeFileSync(filePath, JSON.stringify(board), "utf8");
  return filePath;
}

describe("honest gaps", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "gaps-test-"));
    // Create a diagrams directory
    const diagramsDir = path.join(tempDir, "docs", "diagrams");
    require("node:fs").mkdirSync(diagramsDir, { recursive: true });
    // Create some dummy source files for import simulation
    require("node:fs").mkdirSync(path.join(tempDir, "src"), { recursive: true });
    writeFileSync(path.join(tempDir, "src", "a.ts"), "export const a = 1;");
    writeFileSync(path.join(tempDir, "src", "b.ts"), "import { a } from './a';\nexport const b = a;");
    writeFileSync(path.join(tempDir, "src", "c.ts"), "import { b } from './b';\nexport const c = b;");
    writeFileSync(path.join(tempDir, "src", "unrelated.ts"), "export const x = 1;");
    // Create test files
    require("node:fs").mkdirSync(path.join(tempDir, "tests"), { recursive: true });
    writeFileSync(
      path.join(tempDir, "tests", "a.test.ts"),
      "import { a } from '../src/a';\ndescribe('a', () => { it('works', () => a()); });"
    );
  }, 60_000);

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns undefined when board is a concept board", async () => {
    const board = await createDiagram(emptyBoard(), {
      name: "concept-test",
      nodes: [{ id: "n1", label: "Concept node", ref: "src/a.ts" }],
      edges: [],
      title: "A Protocol",
      describes: "concept",
    });
    const boardPath = await createBoardFile(path.join(tempDir, "docs", "diagrams"), "concept", board.board);
    const result = await computeHonestGaps(board.board, boardPath, tempDir, "docs/diagrams");
    expect(result).toBeUndefined();
  });

  it("returns undefined when board has no anchored refs", async () => {
    const board = await createDiagram(emptyBoard(), {
      name: "no-refs-test",
      nodes: [
        { id: "n1", label: "Unanchored node" },
        { id: "n2", label: "Another one" },
      ],
      edges: [],
    });
    const boardPath = await createBoardFile(path.join(tempDir, "docs", "diagrams"), "no-refs", board.board);
    const result = await computeHonestGaps(board.board, boardPath, tempDir, "docs/diagrams");
    expect(result).toBeUndefined();
  });

  it("lists file paths when files are covered by no board", async () => {
    // Board with ref to a.ts (which imports b.ts, and b is not on any board)
    const board = await createDiagram(emptyBoard(), {
      name: "board-a-only",
      nodes: [{ id: "n1", label: "A", ref: "src/a.ts" }],
      edges: [],
    });
    const boardPath = await createBoardFile(path.join(tempDir, "docs", "diagrams"), "board-a-only", board.board);
    const result = await computeHonestGaps(board.board, boardPath, tempDir, "docs/diagrams");

    // Since b.ts is imported by a.ts but not on any board, it should appear
    expect(result).toBeDefined();
    expect(result).toContain("src/b.ts");
  });

  it("names boards where files are drawn, not the files themselves", async () => {
    // Board A with a.ts, Board B with b.ts
    const boardA = await createDiagram(emptyBoard(), {
      name: "board-a",
      nodes: [{ id: "n1", label: "A", ref: "src/a.ts" }],
      edges: [],
    });
    const boardB = await createDiagram(emptyBoard(), {
      name: "board-b",
      nodes: [{ id: "n2", label: "B", ref: "src/b.ts" }],
      edges: [],
    });

    const diagramsDir = path.join(tempDir, "docs", "diagrams");
    const pathA = await createBoardFile(diagramsDir, "board-a", boardA.board);
    const pathB = await createBoardFile(diagramsDir, "board-b", boardB.board);

    // Check board A: should report that b.ts is on board-b
    const result = await computeHonestGaps(boardA.board, pathA, tempDir, "docs/diagrams");
    expect(result).toBeDefined();
    expect(result).toContain("board-b");
    expect(result).not.toContain("src/b.ts");
  });

  it("caps file list at 8 entries with 'and N more'", async () => {
    // Create a board with refs that import many files
    // For this test, we'll create 10 unrelated files and one board that imports them
    for (let i = 0; i < 10; i++) {
      writeFileSync(path.join(tempDir, "src", `file-${i}.ts`), `export const f${i} = ${i};`);
    }
    // Create a board that imports all of them
    const imports = Array.from({ length: 10 }, (_, i) => `import { f${i} } from './file-${i}';`).join("\n");
    writeFileSync(path.join(tempDir, "src", "hub.ts"), `${imports}\nexport const hub = 1;`);

    const board = await createDiagram(emptyBoard(), {
      name: "hub-board",
      nodes: [{ id: "n1", label: "Hub", ref: "src/hub.ts" }],
      edges: [],
    });

    const boardPath = await createBoardFile(path.join(tempDir, "docs", "diagrams"), "hub-board", board.board);
    const result = await computeHonestGaps(board.board, boardPath, tempDir, "docs/diagrams");

    expect(result).toBeDefined();
    // 10 uncovered files: exactly 8 listed, the remainder counted, never elided
    // silently -- a partial list reading as complete is the failure this whole
    // feature exists to avoid.
    expect(result).toMatch(/and 2 more/);
    expect(result).not.toContain("file-9");
  });

  it("excludes test files from unrepresented", async () => {
    // tests/a.test.ts imports a.ts, but since it's a test file, it shouldn't appear
    const board = await createDiagram(emptyBoard(), {
      name: "test-exclusion",
      nodes: [{ id: "n1", label: "A", ref: "src/a.ts" }],
      edges: [],
    });

    const boardPath = await createBoardFile(path.join(tempDir, "docs", "diagrams"), "test-exclusion", board.board);
    const result = await computeHonestGaps(board.board, boardPath, tempDir, "docs/diagrams");

    // Test file should be excluded even though it imports a
    expect(result).not.toContain("tests/a.test.ts");
  });

  it("degrades gracefully when a sibling board fails to parse", async () => {
    // Create a valid board and a corrupted sibling
    const board = await createDiagram(emptyBoard(), {
      name: "graceful-a",
      nodes: [{ id: "n1", label: "A", ref: "src/a.ts" }],
      edges: [],
    });

    const diagramsDir = path.join(tempDir, "docs", "diagrams");
    const pathA = await createBoardFile(diagramsDir, "graceful-a", board.board);

    // Write a corrupted board file
    writeFileSync(path.join(diagramsDir, "corrupted.excalidraw"), "{ invalid json");

    // Should not crash, just skip the corrupted board
    const result = await computeHonestGaps(board.board, pathA, tempDir, "docs/diagrams");
    // Function should not throw
    expect(typeof result === "string" || result === undefined).toBe(true);
  });
});
