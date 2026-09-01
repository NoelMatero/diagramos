/**
 * What a survey costs, and what a session pays without one.
 *
 *   npm run measure:survey
 *
 * Every number quoted in `docs/drawing-method-design.md` comes from here, so it
 * can be argued with. Runs over this repo plus whatever of the Rust/TS corpus
 * from #96 is on disk; scopes that are missing are skipped rather than faked.
 *
 * Three things are measured per scope:
 *
 * - **the shape the survey picks** -- boxes, arrows, how it renders, what it
 *   leaves for the next board.
 * - **whether the board it drafts survives `check_drift`** -- the whole idea
 *   rests on this. A draft its own checker reds is a mistake handed over, not a
 *   head start.
 * - **what the same board costs to work out by reading** -- the floor, taken as
 *   the first 40 lines of every file the board anchors or cites, which is the
 *   least a session could read and still transcribe rather than infer.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace } from "../src/engine/drift";
import { emptyBoard } from "../src/engine/board-file";
import { initEngine } from "../src/engine/parse";
import { surveyScope } from "../src/engine/survey";

/** The usual four-characters-a-token rule. Good enough to compare orders of magnitude. */
const tokens = (text: string) => Math.ceil(text.length / 4);

const HERE = process.cwd();

/**
 * The #96 corpus of ten real Rust and TypeScript repositories.
 *
 * It is a working checkout rather than a fixture, so it lives outside any one
 * worktree. Set `SURVEY_CORPUS` to point somewhere else; scopes that are not on
 * disk are skipped and said to be skipped, because a table that quietly drops
 * the foreign repositories would leave only the repository this engine was
 * written in, which is the one measurement that proves nothing.
 */
const CORPUS = process.env.SURVEY_CORPUS
  ?? [`${HERE}/.claude/worktrees/96-rust/.corpus`,
      `${HERE}/../../../.claude/worktrees/96-rust/.corpus`]
       .find((candidate) => existsSync(candidate))
  ?? `${HERE}/.claude/worktrees/96-rust/.corpus`;

/** Same reason: a Python scope has to come from somewhere with Python in it. */
const PYTHON = [`${HERE}/graphify/graphify`, `${HERE}/../../../graphify/graphify`]
  .find((candidate) => existsSync(candidate));

const SCOPES: Array<{ name: string; root: string; scope: string }> = [
  { name: "board-ai/src", root: HERE, scope: "src" },
  { name: "board-ai/src/engine", root: HERE, scope: "src/engine" },
  { name: "ripgrep/crates", root: `${CORPUS}/BurntSushi-ripgrep`, scope: "crates" },
  { name: "clap_builder", root: `${CORPUS}/clap-rs-clap`, scope: "clap_builder/src" },
  { name: "regex-automata", root: `${CORPUS}/rust-lang-regex`, scope: "regex-automata/src" },
  { name: "serde_json", root: `${CORPUS}/serde-rs-json`, scope: "src" },
  { name: "anyhow", root: `${CORPUS}/dtolnay-anyhow`, scope: "src" },
  { name: "vue runtime-core", root: `${CORPUS}/vuejs-core`, scope: "packages/runtime-core/src" },
  { name: "vite/node", root: `${CORPUS}/vitejs-vite`, scope: "packages/vite/src/node" },
  { name: "nest/core", root: `${CORPUS}/nestjs-nest`, scope: "packages/core" },
  { name: "query-core", root: `${CORPUS}/TanStack-query`, scope: "packages/query-core/src" },
  ...(PYTHON ? [{ name: "graphify (python)", root: PYTHON.replace(/\/graphify$/, ""), scope: "graphify" }] : []),
];

await initEngine();

const columns = [
  "scope", "files", "boxes", "arrows", "anchored", "needs", "conf", "held",
  "findings", "size", "label", "a/b", "next", "omit", "cut", "survey", "reading", "saving", "ms",
];
const widths = [20, 6, 6, 7, 9, 6, 5, 5, 9, 12, 6, 6, 5, 5, 5, 7, 8, 7, 6];
const row = (cells: Array<string | number>) =>
  cells.map((cell, i) => String(cell).padStart(i === 0 ? -widths[0] : widths[i])).map((cell, i) =>
    i === 0 ? String(cells[0]).padEnd(widths[0]) : cell).join("");

/**
 * A line a reader would recognise as declaring a dependency.
 *
 * Kept here rather than exported from the engine on purpose: this is the
 * measurement checking the engine's choice, so it has to be able to disagree
 * with it. If the two ever drift apart the totals below say so.
 */
const DECLARATION =
  /(?:^|[\s{,])(?:import\b|from\s*['"`]|require\s*\(|use\b|extern\s+crate\b|mod\b)|^\s*[}\])]\s*from\b/;

const totals = { boxes: 0, anchored: 0, arrows: 0, claimed: 0, quotable: 0, findings: 0, legible: 0, scopes: 0, dense: 0 };

console.log(row(columns));
console.log("-".repeat(widths.reduce((a, b) => a + b, 0)));

for (const { name, root, scope } of SCOPES) {
  if (!existsSync(`${root}/${scope}`)) {
    console.log(`${name.padEnd(20)} -- scope not on disk`);
    continue;
  }
  const started = Date.now();
  const workspace = createWorkspace(root);
  const survey = await surveyScope(scope, workspace);
  const elapsed = Date.now() - started;

  if (survey.refused) {
    console.log(`${name.padEnd(20)} REFUSED: ${survey.refused}`);
    continue;
  }

  // Draw the board the survey proposes and put the engine's own checker on it.
  const nodes = survey.units.map((unit) => ({
    id: unit.id,
    label: unit.label,
    ref: unit.dir ? `${unit.dir}/` : unit.files[0],
  }));
  const built = await createDiagram(emptyBoard(), {
    title: `${scope} (surveyed)`,
    nodes,
    edges: survey.edges.map((edge) => ({ from: edge.from, to: edge.to, claim: edge.claim })),
  });
  const probe = `${root}/.survey-probe.excalidraw`;
  writeFileSync(probe, JSON.stringify(built.board, null, 2));
  const report = checkDrift(JSON.parse(readFileSync(probe, "utf8")), workspace, { edges: true });
  rmSync(probe);
  const held = Object.values(report.claims.needsWithheld ?? {}).reduce<number>((a, b) => a + Number(b), 0);

  // What the survey's answer costs to put in front of a model.
  const surveyTokens = tokens(JSON.stringify({
    boxes: nodes, arrows: survey.edges, view: survey.view,
    next: survey.next, omitted: survey.omitted.length,
  }));

  // The floor for working the same board out by reading: the import block of
  // every file the board anchors or cites as evidence. A real session reads more
  // than this, and has to find the files first.
  const mustRead = new Set<string>();
  for (const unit of survey.units) for (const file of unit.files) mustRead.add(file);
  for (const edge of survey.edges) mustRead.add(edge.seen.split(":")[0]);
  let readingTokens = 0;
  for (const file of mustRead) {
    try {
      readingTokens += tokens(readFileSync(`${root}/${file}`, "utf8").split("\n").slice(0, 40).join("\n"));
    } catch {
      // A file that vanished between the scan and now is not this script's problem.
    }
  }

  // Read every quoted line back off disk and judge it independently, so the
  // claim rate in the summary is checked rather than asserted.
  let quotable = 0;
  for (const edge of survey.edges) {
    if (!edge.claim) continue;
    const [file, line] = edge.seen.split(":");
    try {
      const text = readFileSync(`${root}/${file}`, "utf8").split("\n")[Number(line) - 1] ?? "";
      if (DECLARATION.test(text)) quotable++;
      else console.log(`  ! ${name}: ${edge.seen} claims needs but reads "${text.trim().slice(0, 60)}"`);
    } catch {
      console.log(`  ! ${name}: ${edge.seen} could not be read back`);
    }
  }
  totals.scopes++;
  totals.boxes += nodes.length;
  totals.anchored += nodes.filter((n) => n.ref).length;
  totals.arrows += survey.edges.length;
  totals.claimed += survey.edges.filter((edge) => !!edge.claim).length;
  totals.quotable += quotable;
  totals.findings += report.findings.length;
  if (survey.view.verdict === "legible") totals.legible++;
  // The ceiling every board in this repo respects. A survey over it is a hairball.
  if (survey.edges.length / nodes.length > 1.5) totals.dense++;

  const filesTotal = survey.units.reduce((a, u) => a + u.files.length, 0) + survey.omitted.length;
  if (process.env.SURVEY_WHY) console.log(`   ${name} withheld: ${JSON.stringify(report.claims.needsWithheld)}`);
  console.log(row([
    name, filesTotal, nodes.length, survey.edges.length,
    `${nodes.filter((n) => n.ref).length}/${nodes.length}`,
    report.claims.needs, report.claims.needsChecked, held,
    report.findings.length === 0 ? "0 clean" : `${report.findings.length} RED`,
    `${survey.view.width}x${survey.view.height}`, survey.view.labelPx,
    (survey.edges.length / nodes.length).toFixed(2),
    survey.next.length, survey.omitted.length, survey.arrowsOmitted,
    surveyTokens, readingTokens, `${(readingTokens / surveyTokens).toFixed(1)}x`, elapsed,
  ]));
}

const pc = (part: number, whole: number) => `${part}/${whole} (${Math.round((part / whole) * 100)}%)`;

console.log(`
Across ${totals.scopes} scopes:
  boxes anchored     ${pc(totals.anchored, totals.boxes)}       this repo's own 16 boards: 89/209 (43%)
  arrows claimed     ${pc(totals.claimed, totals.arrows)}       those boards: 11/254 (4%)
  claims quotable    ${pc(totals.quotable, totals.claimed)}       every claim's line re-read and judged here
  boards legible     ${pc(totals.legible, totals.scopes)}       those boards: 8/16 (50%)
  arrows per box      ${(totals.arrows / totals.boxes).toFixed(2)}          every board in this repo is between 0.25 and 1.43
  over that ceiling  ${totals.dense}
  findings           ${totals.findings}

conf     needs claims the checker confirmed; held  recorded and withheld, never refuted
survey   tokens the survey's answer costs
reading  tokens the first 40 lines of every file it cites costs -- the floor, not a session
`);
