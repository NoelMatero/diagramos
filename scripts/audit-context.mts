/**
 * What does it cost to hand an agent a board instead of the prose?
 *
 * #52 asks whether a diagram can do the job `AGENTS.md` and `docs/` do today.
 * Half that question is accuracy, which needs agents and a graded task and is
 * written up in `docs/agent-context-brief.md`. The other half is price, and
 * price is arithmetic -- this measures it, so nobody has to argue about it.
 *
 *   npx tsx scripts/audit-context.mts
 *
 * Three sizes matter per board, and they are wildly different:
 *
 *   raw          the .excalidraw file on disk. Every point of every stroke.
 *                What you get if an agent just cats the file. Never do this.
 *   geometry     readGraph as the engine sees it, coordinates included.
 *   semantic     what `read_diagram` actually returns -- server.ts drops x/y/
 *                width/height on the way out. This is the number to compare.
 *
 * On board-internals the semantic payload is ~4 kB against ~59 kB of raw file,
 * so the trim is worth roughly 15x. The geometry columns are the answer to the
 * doubt raised in #52 about `read_diagram` shipping coordinates nobody needs:
 * it does not, and has not since the trim in server.ts. Cost of the coordinates
 * had they been left in: about 12%, which is smaller than the issue assumed.
 *
 * The comparison that decides #52 is `semantic` against PROSE. Note that PROSE
 * counts every tracked .md, which is the fair denominator only if you believe
 * an agent reads them all; the AGENTS.md + README.md row is the honest floor,
 * because that pair is what actually gets loaded unprompted.
 *
 * The board side of that comparison is every board carrying at least one ref,
 * summed -- not one board. A repository is documented by all of its boards the
 * way it is documented by all of its prose, and comparing one board against the
 * whole of `docs/` flattered the board while it was losing anyway.
 *
 * Tokens here are chars/4. That is an estimate, not a tokenizer -- the repo has
 * no tokenizer dependency and this ratio is stable enough for a 10x question.
 * Do not quote these as exact.
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { readBoard } from "../src/engine/board-file";
import { readGraph } from "../src/engine/graph";

/** chars/4. An estimate; see the header. */
const tok = (chars: number) => Math.round(chars / 4);
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} kB`;
const pad = (s: string, n: number) => s.padEnd(n);
const num = (s: string | number, n: number) => String(s).padStart(n);

// ---------------------------------------------------------------- the prose

/**
 * The write-up of this very measurement. Counting it would make the prose arm
 * grow every time the result is described, so the number would stop
 * reproducing the moment it was written down.
 */
const SELF = "agent-context-brief.md";

/** Every tracked .md an agent could plausibly be handed as context. */
const PROSE_DIR = path.join(REPO, "docs");
const proseFiles = [
  path.join(REPO, "AGENTS.md"),
  path.join(REPO, "README.md"),
  ...readdirSync(PROSE_DIR)
    .filter((e) => e.endsWith(".md") && e !== SELF)
    .map((e) => path.join(PROSE_DIR, e))
    .sort(),
];

/** The pair that loads unprompted, with no one asking for it. */
const DEFAULT_PROSE = new Set(["AGENTS.md", "README.md"]);

let proseAll = 0;
let proseDefault = 0;
console.log("PROSE — what an agent is handed today\n");
console.log(`  ${pad("file", 34)}${num("bytes", 9)}${num("~tokens", 10)}`);
for (const file of proseFiles) {
  const bytes = readFileSync(file, "utf8").length;
  const rel = path.relative(REPO, file);
  proseAll += bytes;
  if (DEFAULT_PROSE.has(rel)) proseDefault += bytes;
  console.log(`  ${pad(rel, 34)}${num(bytes, 9)}${num(tok(bytes), 10)}`);
}
console.log(`  ${pad("-".repeat(34), 34)}${num("-".repeat(9), 9)}${num("-".repeat(10), 10)}`);
console.log(`  ${pad("AGENTS.md + README.md only", 34)}${num(proseDefault, 9)}${num(tok(proseDefault), 10)}  <- loads unprompted`);
console.log(`  ${pad("every tracked .md", 34)}${num(proseAll, 9)}${num(tok(proseAll), 10)}  <- if it reads them all`);

// --------------------------------------------------------------- the boards

const DIAGRAM_DIR = path.join(REPO, "docs", "diagrams");
const boards = readdirSync(DIAGRAM_DIR)
  .filter((e) => e.endsWith(".excalidraw"))
  .map((e) => path.join(DIAGRAM_DIR, e))
  .sort();

console.log("\n\nBOARDS — what read_diagram would cost instead\n");
// Every board lives in docs/diagrams, so the directory is noise in the table.
const NAME_W = Math.max(12, ...boards.map((f) => path.basename(f).length)) + 2;
console.log(
  `  ${pad("board", NAME_W)}${num("nodes", 6)}${num("edges", 6)}${num("refs", 6)}`
  + `${num("raw", 9)}${num("geometry", 10)}${num("semantic", 10)}${num("~tokens", 9)}${num("vs raw", 9)}`,
);

interface Row { rel: string; semantic: number; nodes: number; refs: number; }
const rows: Row[] = [];

for (const file of boards) {
  const rel = path.relative(REPO, file);
  const name = path.basename(file);
  const raw = statSync(file).size;
  let board;
  try {
    board = await readBoard(file);
  } catch (error) {
    console.log(`  ${pad(name, NAME_W)}  unreadable: ${(error as Error).message}`);
    continue;
  }
  const graph = readGraph(board);

  // Mirror what src/mcp/server.ts does on the way out: geometry is dropped
  // unless asked for. Keep this in step with the read_diagram handler.
  const trimmed = {
    ...graph,
    nodes: graph.nodes.map(({ x: _x, y: _y, width: _w, height: _h, ...rest }) => rest),
  };
  const withGeometry = JSON.stringify(graph).length;
  const semantic = JSON.stringify(trimmed).length;
  const refs = graph.nodes.filter((n) => n.ref).length;

  rows.push({ rel, semantic, nodes: graph.nodes.length, refs });
  console.log(
    `  ${pad(name, NAME_W)}${num(graph.nodes.length, 6)}${num(graph.edges.length, 6)}${num(refs, 6)}`
    + `${num(kb(raw), 9)}${num(kb(withGeometry), 10)}${num(kb(semantic), 10)}`
    + `${num(tok(semantic), 9)}${num(`${(raw / semantic).toFixed(0)}x`, 9)}`,
  );
}

// ----------------------------------------------------------- the comparison

// The board arm is every board that anchors itself in this repo. A concept
// board (`describes: "concept"`) carries no refs and is deliberately about
// something else, so it is not part of the price of documenting this codebase.
const anchored = rows.filter((r) => r.refs > 0).sort((a, b) => a.rel.localeCompare(b.rel));
const boardTotal = anchored.reduce((sum, r) => sum + r.semantic, 0);

console.log("\n\nTHE NUMBER #52 ASKS FOR\n");
if (!anchored.length) {
  console.log("  No board anchors itself in this repo; the comparison in #52 has no subject.");
} else {
  for (const row of anchored) {
    console.log(
      `  ${pad(path.basename(row.rel), NAME_W)}${num(row.nodes, 4)} nodes,`
      + `${num(row.refs, 4)} anchored ${num(tok(row.semantic), 8)} tokens`,
    );
  }
  console.log(`  ${pad("", NAME_W)}${"".padStart(4)}        ${"".padStart(9)}${num("-------", 8)}`);
  console.log(`  ${pad("every anchored board", NAME_W)}${num("", 4)}          ${num(tok(boardTotal), 8)} tokens`);
  console.log("");
  console.log(`  prose, floor         ${num(tok(proseDefault), 7)} tokens   ${(proseDefault / boardTotal).toFixed(1)}x the boards`);
  console.log(`  prose, everything    ${num(tok(proseAll), 7)} tokens   ${(proseAll / boardTotal).toFixed(1)}x the boards`);
  console.log("\n  Cheaper is not the same as better. Whether the cheap context answers");
  console.log("  the question is graded in docs/agent-context-brief.md, not here.");
}
