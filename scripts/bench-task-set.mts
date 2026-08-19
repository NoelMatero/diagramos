/**
 * Eight real questions about this repo, with ground truth written by hand,
 * once, before any arm ran. #63.
 *
 *   npx tsx scripts/bench-task-set.mts
 *
 * Every claim so far that "the board beats the docs" rested on one or two
 * data points (#52/#57, PR #61, PR #62 -- see docs/agent-context-brief.md).
 * This is not another data point about one task. It prints three arms --
 * prose only, boards only, both -- built from the SAME real repo content
 * `bench-default-fields.mts` used a synthetic one for, so a sealed reader can
 * be handed each arm in turn and asked all eight questions.
 *
 * This script does not grade anything. It prints reproducible payloads. The
 * grading -- what a sealed reader actually answered, against the ground truth
 * below -- is written up by hand in `docs/agent-context-brief.md`, the same
 * split `bench-default-fields.mts` uses.
 *
 * PROSE is every tracked .md an agent could plausibly be handed (AGENTS.md +
 * README.md + docs/*.md except this brief itself) -- the same file list
 * `audit-context.mts` prices as "every tracked .md". BOARD is the six
 * diagrams that actually anchor themselves in this repo (refs > 0; the same
 * "anchored" filter `audit-context.mts` uses), read through the exact
 * production path `read_diagram` uses -- `projectGraph` plus
 * `computeHonestGaps` -- not a copy of its rules. BOTH is their
 * concatenation.
 *
 * A sealed reader gets ONE arm's printed text and nothing else: no
 * filesystem, no repo access, no tools. Handing a sealed agent a real board
 * with filesystem access defeats the point -- it will go read the code
 * instead of the payload, which is the same trap `bench-default-fields.mts`
 * calls out.
 *
 * ============================================================================
 * THE EIGHT QUESTIONS, AND THE GROUND TRUTH -- written 2026-08-19, before any
 * arm ran, from reading the code directly. Never edited to match an answer.
 * ============================================================================
 *
 * Q1 (location) -- The `check_drift` MCP tool is registered in one file.
 * Which file actually performs the comparison against the working tree, and
 * is that the same code the standalone `diagramos drift` command uses, or a
 * separate copy?
 *
 *   `check_drift` is registered in src/mcp/server.ts (server.registerTool
 *   calling the imported checkDrift). The comparison itself lives in
 *   src/engine/drift.ts's checkDrift() function. scripts/check-drift.mjs --
 *   the standalone CLI -- imports and calls that exact same function. Same
 *   code, not a copy.
 *
 * Q2 (location, with a trap) -- Say you want to add a new subcommand to the
 * published `diagramos` CLI -- e.g. `diagramos audit`, running what
 * scripts/audit-context.mts does today. List every file that has to change
 * for `npx diagramos audit` to actually work, and explain why
 * scripts/diagramos.mjs's own source cannot show you the second one by
 * import analysis.
 *
 *   (1) scripts/diagramos.mjs -- add `audit: "audit.mjs"` to its COMMANDS
 *   map (and its USAGE string). (2) scripts/build-cli.mjs -- add a matching
 *   entry to its `entries` array so esbuild actually bundles the new script
 *   to out/cli/audit.mjs; miss this and the dispatcher's runtime import
 *   throws for a file that was never built. The trap: diagramos.mjs
 *   dispatches via `await import(new URL(`./${entry}`, import.meta.url).href)`
 *   -- a template string resolved at runtime, not a static import -- so
 *   nothing that walks the import graph can see which file it resolves to,
 *   or that build-cli.mjs is the thing that has to put it there first.
 *
 * Q3 (structure) -- If src/engine/graph.ts changed its exported shape (say,
 * renamed readGraph), which files outside its own tests would break?
 *
 *   Eight: src/mcp/projection.ts, src/mcp/server.ts, src/engine/gaps.ts,
 *   src/engine/drift.ts, src/engine/diagram.ts, src/engine/layout.ts
 *   (type-only import), scripts/audit-context.mts,
 *   scripts/make-example-diagram.mjs. (Two more files, both tests, also
 *   import it -- excluded because the question asks outside its own tests.)
 *
 * Q4 (structure) -- Walk render_diagram end to end, from the MCP tool call
 * to the pixels of the PNG. What actually draws the picture, and where does
 * that code come from?
 *
 *   render_diagram (src/mcp/server.ts) calls renderBoardToPng() in
 *   src/engine/render.ts, which launches headless Chromium (playwright-core)
 *   and serves it a prebuilt browser bundle, vendor/excalidraw-browser.js --
 *   built ahead of time by scripts/build-vendor.mjs from
 *   src/engine/vendor/browser-entry.ts. The real Excalidraw library, running
 *   in that headless page, does the actual drawing -- render.ts gets the
 *   board's elements into the page and screenshots it; there is no
 *   hand-written layout-to-pixels code in this repo.
 *
 * Q5 (status, with a trap) -- Across the six diagrams that actually describe
 * this repository (board-internals, drift-check, example, live-board,
 * picture-path, published-cli), is anything currently drawn as `planned` --
 * designed but not built yet?
 *
 *   No. Verified 2026-08-19 by reading every node and edge's state on all
 *   six boards: every single one is state: built (the default), provenance:
 *   recorded. Nothing planned, nothing external, nothing hand-drawn. The
 *   trap: docs/ref-brief.md opens "Status: design answered in
 *   docs/ref-design.md (2026-08-15), not yet built." That line is now stale
 *   -- the ref/route/symbol-assertion design it describes has since been
 *   built (src/engine/assert.ts; the @declared/@used/route-anchor logic
 *   inside src/engine/drift.ts's checkDrift), across PRs #36, #39, #43, #46.
 *   An answer that trusts that status line at face value is wrong.
 *
 * Q6 (trust) -- docs/diagrams has 12 .excalidraw files. How many actually
 * describe this repository, and how would you tell the rest apart from a
 * quick glance at the file?
 *
 *   Six describe this repo: board-internals, drift-check, example,
 *   live-board, picture-path, published-cli -- each has nodes carrying a
 *   ref. The other six (architecture, auth, ims, ims_2, ims-volte,
 *   state-legend) are all explicitly marked describes: "concept" and carry
 *   zero refs between them -- five are telecom/IMS reference diagrams and one
 *   is the state-legend demo, none about this codebase. The tell is the
 *   describes field (read_diagram reports title/describes; check_drift
 *   excuses every box on a concept board rather than flagging it unref'd),
 *   not the filename or a guess about subject matter.
 *
 * Q7 (absence) -- Read board-internals.excalidraw. What does it not show,
 * and how does it know?
 *
 *   As of 2026-08-19: "13 related files are drawn on other boards
 *   (drift-check, live-board, picture-path, published-cli); 4 related files
 *   are on no board: src/engine/normalize.ts, src/engine/font.ts,
 *   src/engine/contrast.ts, src/server/server-registry.ts." It knows because
 *   read_diagram runs check_drift's coverage walk (one hop of imports from
 *   the board's own ref'd files) and cross-checks every other board in
 *   docs/diagrams for the same files, live, on every read -- not a static
 *   note someone wrote by hand.
 *
 * Q8 (absence, repo-wide) -- Is there any real source file in this
 * repository that is not drawn on ANY diagram at all -- not even a sibling
 * board?
 *
 *   Yes. Cross-referencing every anchored board's "on no board" list
 *   (`check_drift --coverage`, run 2026-08-19) shows the same handful recur
 *   everywhere with nothing ever claiming them: src/engine/normalize.ts,
 *   src/engine/font.ts, src/engine/contrast.ts, src/server/server-registry.ts,
 *   src/viewer/styles.css. All five are real, imported files with no box on
 *   any of the 12 diagrams in the repo.
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readBoard } from "../src/engine/board-file";
import { computeHonestGaps } from "../src/engine/gaps";
import { readGraph } from "../src/engine/graph";
import { initEngine } from "../src/engine/parse";
import { projectGraph } from "../src/mcp/projection";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tok = (chars: number) => Math.round(chars / 4);

const SELF = "agent-context-brief.md";
const PROSE_DIR = path.join(REPO, "docs");
const proseFiles = [
  path.join(REPO, "AGENTS.md"),
  path.join(REPO, "README.md"),
  ...readdirSync(PROSE_DIR)
    .filter((e) => e.endsWith(".md") && e !== SELF)
    .map((e) => path.join(PROSE_DIR, e))
    .sort(),
];

function buildProse(): string {
  return proseFiles
    .map((file) => `----- ${path.relative(REPO, file)} -----\n${readFileSync(file, "utf8")}`)
    .join("\n\n");
}

async function buildBoards(): Promise<string> {
  await initEngine();
  const dir = path.join(REPO, "docs", "diagrams");
  const files = readdirSync(dir)
    .filter((e) => e.endsWith(".excalidraw"))
    .map((e) => path.join(dir, e))
    .sort();

  const parts: string[] = [];
  for (const file of files) {
    const board = await readBoard(file);
    const graph = readGraph(board);
    const refs = graph.nodes.filter((n) => n.ref).length;
    // Same filter audit-context.mts uses for "anchored": a concept board
    // carries no refs and is deliberately not about this codebase.
    if (refs === 0) continue;
    const notShown = await computeHonestGaps(board, file, REPO, "docs/diagrams");
    const payload = projectGraph(graph, { notShown });
    parts.push(
      `----- ${path.relative(REPO, file)} -----\n`
      + JSON.stringify({ file: path.relative(REPO, file), ...payload }),
    );
  }
  return parts.join("\n\n");
}

const prose = buildProse();
const board = await buildBoards();
const both = `${prose}\n\n${board}`;

for (const [name, text] of [["prose", prose], ["board", board], ["both", both]] as const) {
  console.log(`===== ARM ${name} (${tok(text.length)} tokens) =====`);
  console.log(text);
  console.log();
}
