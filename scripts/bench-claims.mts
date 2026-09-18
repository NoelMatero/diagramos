#!/usr/bin/env -S npx tsx
/**
 * What every claim actually says about every shape, beside what it is
 * documented to say (#298).
 *
 *   npm run bench:claims              # the table
 *   npm run bench:claims -- --details # every arrow, not just the totals
 *   npm run bench:claims -- needs holds
 *
 * Exits non-zero when a verdict disagrees with the documentation. A square the
 * documentation does not settle is marked `open` and never fails the run: the
 * question goes in the report instead of being answered here.
 *
 * No model and no language server. `checkDrift` is called the way a project
 * with no tier-2 resolver gets it, which is the floor of what a user sees --
 * `scripts/check-drift.mjs` wires a TypeScript referee on top, and a square
 * that only moves with one is marked `open` rather than measured here.
 */
import path from "node:path";

import { emptyBoard, readBoard } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { accuses, checkDrift, createWorkspace, newCheckCache, UNCONFIRMED_WORDS } from "../src/engine/drift";
import type { ClaimTally, DriftReport } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { BOARD_FILE, FIXTURES } from "../bench/claim-fixtures";
import type { Fixture, FixtureEdge, Verdict } from "../bench/claim-fixtures";

const root = process.cwd();
const argv = process.argv.slice(2);
const details = argv.includes("--details");
const only = argv.filter((word) => !word.startsWith("--"));

/**
 * Which tally field carries "this word's reader declined to answer".
 *
 * Read off a board holding one arrow and nothing else, so the reason belongs to
 * that arrow. It is the second question a verdict cannot answer: a claim the
 * reader withheld does not leave the arrow blank -- it falls through to the
 * plain corroboration channels, which confirm on an import, a shared importer
 * or a shared route. The arrow then renders exactly like one whose claim held.
 */
const WITHHELD_FIELD: Record<string, keyof ClaimTally> = {
  needs: "needsWithheld",
  feeds: "feedsWithheld",
  takes: "signatureWithheld",
  returns: "signatureWithheld",
  holds: "holdsWithheld",
  builds: "buildsWithheld",
  calls: "callsWithheld",
  accesses: "accessesWithheld",
  conforms: "conformsWithheld",
};

/** One arrow's answer: the verdict a user sees, and the engine's own words for it. */
interface Answer {
  verdict: Verdict;
  detail: string;
  /** Why this word's reader declined, when it did. */
  withheld?: string;
}

/**
 * The verdict for one arrow, read out of a report the way the CLI reads it.
 *
 * A finding whose kind `accuses` is a red. An advisory finding, an unconfirmed
 * arrow and an unread arrow are all "not verified": what they have in common is
 * the only thing a reader cares about -- nothing was proved and nobody was
 * accused. Anything else is a green arrow.
 */
function answerFor(edge: FixtureEdge, report: DriftReport): Answer {
  const node = `${edge.from} -> ${edge.to}`;
  const finding = report.edges.find((entry) => entry.node === node);
  if (finding) {
    return {
      verdict: accuses(finding.kind) ? "red" : "not-verified",
      detail: `${finding.kind}: ${finding.detail}`,
    };
  }
  const unconfirmed = report.unconfirmedEdges.find(
    (entry) => entry.from === edge.from && entry.to === edge.to,
  );
  if (unconfirmed) {
    return {
      verdict: "not-verified",
      detail: `${unconfirmed.reason}: ${UNCONFIRMED_WORDS[unconfirmed.reason]}`,
    };
  }
  const unread = report.unreadEdges.find(
    (entry) => entry.from === edge.from && entry.to === edge.to,
  );
  if (unread) return { verdict: "not-verified", detail: `unread: ${unread.reason}` };
  return { verdict: "confirmed", detail: "corroborated, no finding" };
}

/** Why this word's reader declined about one arrow, asked one arrow at a time. */
async function withheldWhy(fixture: Fixture, edge: FixtureEdge): Promise<string | undefined> {
  const field = WITHHELD_FIELD[fixture.claim];
  if (!field) throw new Error(`no withheld field for @${fixture.claim}`);
  const drawn = await createDiagram(emptyBoard(), {
    name: `one-${fixture.claim}`,
    nodes: fixture.nodes.filter((node) => node.id === edge.from || node.id === edge.to),
    edges: [{ from: edge.from, to: edge.to, label: edge.label, claim: fixture.claim }],
  });
  const report = checkDrift(drawn.board, workspace, { edges: true, cache });
  const reasons = Object.keys((report.claims[field] ?? {}) as Record<string, number>);
  return reasons.length > 0 ? reasons.join(", ") : undefined;
}

interface Row {
  fixture: Fixture;
  edge: FixtureEdge;
  answer: Answer;
}

await initEngine();
const workspace = createWorkspace(root);
// One repository, one cache, for every check this run makes: the fixtures do
// not change under it. See `CheckCache` for why it is never one for two
// projects and never the server's (#311).
const cache = newCheckCache(workspace);

const chosen = FIXTURES.filter((fixture) => only.length === 0 || only.includes(fixture.claim));
if (chosen.length === 0) {
  console.error(`No fixture for ${only.join(", ")}.`);
  process.exit(2);
}

const rows: Row[] = [];
for (const fixture of chosen) {
  const file = path.join(root, fixture.dir, BOARD_FILE);
  const board = await readBoard(file);
  if (board.elements.length === 0) {
    console.error(`${fixture.dir}/${BOARD_FILE} is missing. Run npm run bench:claims:draw.`);
    process.exit(2);
  }
  const report = checkDrift(board, workspace, { edges: true, cache });
  if (report.damage.length > 0) {
    console.error(`${fixture.dir}/${BOARD_FILE} contradicts itself; its report means nothing.`);
    process.exit(2);
  }
  for (const edge of fixture.edges) {
    const answer = answerFor(edge, report);
    answer.withheld = await withheldWhy(fixture, edge);
    rows.push({ fixture, edge, answer });
  }
}

const agreed = (row: Row) => row.answer.verdict === row.edge.expect;
const disagreements = rows.filter((row) => !agreed(row) && !row.edge.open);
const opens = rows.filter((row) => row.edge.open);

const SHORT: Record<Verdict, string> = {
  confirmed: "confirmed",
  red: "red",
  "not-verified": "not verified",
};
const LANGUAGES = ["rust", "python", "typescript"] as const;
const SHAPES = [
  "plainly-true", "true-but-hidden", "false-and-provable", "false-and-unprovable",
  "alias-in-file", "wrong-half", "generic-wrapper", "wrong-kind-of-end",
] as const;

/** `expected` when they agree, `expected → actual` when they do not. */
function cell(row: Row | undefined): string {
  if (!row) return "—";
  const mark = row.edge.open ? " (open)" : "";
  if (agreed(row)) return `${SHORT[row.edge.expect]}${mark}`;
  return `${SHORT[row.edge.expect]} → **${SHORT[row.answer.verdict]}**${mark}`;
}

const width = (text: string) => text.replace(/\*\*/g, "").length;
const columns = ["claim", "language", ...SHAPES.map((shape) => shape.replace(/-/g, " "))];
const table: string[][] = [];
for (const claim of [...new Set(chosen.map((fixture) => fixture.claim))]) {
  for (const language of LANGUAGES) {
    const mine = rows.filter(
      (row) => row.fixture.claim === claim && row.fixture.language === language,
    );
    if (mine.length === 0) continue;
    table.push([
      `@${claim}`,
      language,
      ...SHAPES.map((shape) => cell(mine.find((row) => row.edge.shape === shape))),
    ]);
  }
}

const widths = columns.map((head, index) =>
  Math.max(width(head), ...table.map((line) => width(line[index] ?? ""))),
);
const line = (cells: string[]) =>
  `| ${cells.map((text, index) => text + " ".repeat(widths[index]! - width(text))).join(" | ")} |`;

console.log(line(columns));
console.log(`|${widths.map((size) => "-".repeat(size + 2)).join("|")}|`);
for (const entry of table) console.log(line(entry));

console.log();
console.log(
  `${rows.length} arrows · ${rows.length - disagreements.length - opens.length} agreed · `
  + `${disagreements.length} disagreed · ${opens.length} the documentation does not settle`,
);

for (const row of disagreements) {
  console.log();
  console.log(`DISAGREES  @${row.fixture.claim} · ${row.fixture.language} · ${row.edge.shape}`);
  console.log(`  arrow     ${row.edge.from} -> ${row.edge.to}  (${row.fixture.dir})`);
  console.log(`  expected  ${SHORT[row.edge.expect]} — ${row.edge.because}`);
  console.log(`  actual    ${SHORT[row.answer.verdict]} — ${row.answer.detail}`);
  if (row.answer.withheld) {
    console.log(`  note      this word's reader withheld: ${row.answer.withheld}`);
  }
}

if (opens.length > 0) {
  console.log();
  console.log("The documentation does not say what should happen here:");
  for (const row of opens) {
    console.log(`  @${row.fixture.claim} · ${row.fixture.language} · ${row.edge.shape}`);
    console.log(`    ${row.edge.open}`);
    console.log(
      `    it does: ${SHORT[row.answer.verdict]} — ${row.answer.detail}`
      + (row.answer.withheld ? ` (reader withheld: ${row.answer.withheld})` : ""),
    );
  }
}

if (details) {
  console.log();
  for (const row of rows) {
    const flag = row.edge.open ? "open " : agreed(row) ? "ok   " : "DIFF ";
    console.log(
      `${flag} @${row.fixture.claim}/${row.fixture.language} ${row.edge.shape}`
      + ` ${row.edge.from}->${row.edge.to}: ${SHORT[row.answer.verdict]}`
      + (row.answer.withheld ? ` [withheld: ${row.answer.withheld}]` : "")
      + ` — ${row.answer.detail}`,
    );
  }
}

process.exit(disagreements.length > 0 ? 1 : 0);
