#!/usr/bin/env -S npx tsx
/**
 * Draws the boards for `bench/fixtures/*`, one per claim per language.
 *
 *   npm run bench:claims:draw
 *
 * The boards are committed, and this regenerates them from `bench/claim-fixtures.ts`.
 * No model is involved: the graph is written down in the spec, so an unchanged
 * spec redraws byte-identically and `git status` stays clean.
 */
import path from "node:path";

import { emptyBoard, writeBoard } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { BOARD_FILE, FIXTURES } from "../bench/claim-fixtures";

const root = process.cwd();

for (const fixture of FIXTURES) {
  const board = emptyBoard();
  const result = await createDiagram(board, {
    title: `${fixture.claim} · ${fixture.language}`,
    name: `${fixture.claim}-${fixture.language}`,
    nodes: fixture.nodes,
    edges: fixture.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      label: edge.label,
      claim: fixture.claim,
    })),
  });
  const file = path.join(root, fixture.dir, BOARD_FILE);
  await writeBoard(file, result.board);
  console.log(`${fixture.dir}/${BOARD_FILE}  ${result.nodeCount} boxes, ${result.edgeCount} arrows`);
}
