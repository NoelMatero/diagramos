#!/usr/bin/env node
/**
 * #296's score: of the mistakes planted in 45 boards of real code, how many
 * does the checker call wrong, how many does it show as not sure, and how many
 * pass in silence -- and how many *true* claims does it call wrong.
 *
 *   npm run bench:planted
 *   npm run bench:planted -- --language=rust --word=calls --details
 *
 * Reads the boards and the stored answer keys and calls no model and no
 * language server: the keys were built once by `bench-planted-key.mts`, from
 * rust-analyzer, pyright and the TypeScript compiler. Everything this script
 * asks is asked of `checkDrift`, one arrow at a time, so what it prints is the
 * verdict a person would see on a board carrying that one arrow.
 *
 * ## The four columns
 *
 * - **red** -- an accusing finding. The board is told it is wrong.
 * - **not sure** -- an advisory finding, or the arrow came back unconfirmed or
 *   unread. Visible in the report, not an accusation.
 * - **green** -- the claim was confirmed. On a planted mistake this is the
 *   worst outcome there is: the checker agreed with something false.
 * - **silent** -- nothing at all. The claim was withheld and no channel spoke.
 *
 * The number that matters most is the last column of the TRUE CLAIMS table:
 * a red on a correct board is the one mistake this tool cannot take back
 * (AGENTS.md, `licence.ts`).
 */
import path from "node:path";

import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, newCheckCache, type CheckCache } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { plantedBoard, plantedKeys, type Key, type KeyClaim } from "./lib/planted-keys";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CORPUS = process.env.CORPUS ?? "/Users/noelmatero/board-ai/.corpus";
const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

type Outcome = "red" | "not sure" | "green" | "silent";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const wantLanguage = flag("language");
const wantWord = flag("word");
const wantProject = flag("project");
/** One kind of planted mistake: `wrong-kind`, `retarget`, `reverse`, `swap`, `drawn`. */
const wantSource = flag("source");
const details = argv.includes("--details");

/**
 * One workspace and one cache per project, for the whole run (#311).
 *
 * Every arrow is still asked on a board of its own; what is kept between them
 * is only what was read off disk, which the pinned corpus never changes. Per
 * project and never one for all: the cache holds a crate layout, and clap's
 * would resolve ripgrep's modules. `checkDrift` refuses a cache from another
 * workspace, so a mistake here throws rather than scoring.
 */
const held = new Map<string, CheckCache>();
function cacheFor(project: string): CheckCache {
  const found = held.get(project);
  if (found) return found;
  const cache = newCheckCache(createWorkspace(path.join(CORPUS, project)));
  held.set(project, cache);
  return cache;
}

/** What the checker said about one arrow, run on a board of its own. */
async function ask(key: Key, claim: KeyClaim): Promise<{ outcome: Outcome; detail: string }> {
  const cache = cacheFor(key.project);
  const { workspace } = cache;
  const board = await plantedBoard(key, claim);
  const report = checkDrift(board, workspace, { edges: true, cache });
  // The engine quotes the declaration it read, and a Python class runs to
  // thousands of characters. What a reader of this table needs is which
  // verdict it was and the first line of why.
  const short = (text: string) => (text.length > 220 ? `${text.slice(0, 220)}…` : text).replace(/\s+/g, " ");
  const finding = report.edges[0];
  if (finding && ACCUSES.has(finding.kind)) return { outcome: "red", detail: `${finding.kind}: ${short(finding.detail)}` };
  if (finding) return { outcome: "not sure", detail: `${finding.kind}: ${short(finding.detail)}` };
  if (report.garbledClaims.length > 0) return { outcome: "not sure", detail: "garbled claim" };
  const unconfirmed = report.unconfirmedEdges[0];
  if (unconfirmed) return { outcome: "not sure", detail: `unconfirmed: ${unconfirmed.reason}` };
  const unread = report.unreadEdges[0];
  if (unread) return { outcome: "not sure", detail: `unread: ${unread.reason}` };
  const tally = report.claims as unknown as Record<string, unknown>;
  const confirmations = Object.entries(tally)
    .filter(([name]) => name.endsWith("Confirmed"))
    .reduce((sum, [, value]) => sum + Number(value ?? 0), 0) + report.claims.needsChecked;
  if (confirmations > 0) return { outcome: "green", detail: "confirmed" };
  const withheld = Object.entries(tally)
    .filter(([name]) => name.endsWith("Withheld"))
    .flatMap(([, breakdown]) => Object.entries((breakdown ?? {}) as Record<string, number>))
    .filter(([, count]) => count > 0);
  return { outcome: "silent", detail: withheld.length > 0 ? `withheld: ${withheld[0]![0]}` : "nothing said" };
}

interface Row { red: number; unsure: number; green: number; silent: number }
const empty = (): Row => ({ red: 0, unsure: 0, green: 0, silent: 0 });
const bump = (row: Row, outcome: Outcome) => {
  if (outcome === "red") row.red++;
  else if (outcome === "not sure") row.unsure++;
  else if (outcome === "green") row.green++;
  else row.silent++;
};
const total = (row: Row) => row.red + row.unsure + row.green + row.silent;

function table(title: string, note: string, rows: Map<string, Row>, caught: (row: Row) => number) {
  console.log(`  ${title}`);
  console.log(`    ${note}`);
  console.log(`    ${"".padEnd(12)}${"claims".padStart(8)}${"red".padStart(8)}${"not sure".padStart(10)}`
    + `${"green".padStart(8)}${"silent".padStart(8)}${"caught".padStart(9)}`);
  const sum = empty();
  for (const [name, row] of [...rows.entries()].sort((a, b) => total(b[1]) - total(a[1]))) {
    if (total(row) === 0) continue;
    sum.red += row.red; sum.unsure += row.unsure; sum.green += row.green; sum.silent += row.silent;
    console.log(`    ${name.padEnd(12)}${String(total(row)).padStart(8)}${String(row.red).padStart(8)}`
      + `${String(row.unsure).padStart(10)}${String(row.green).padStart(8)}${String(row.silent).padStart(8)}`
      + `${`${((caught(row) / total(row)) * 100).toFixed(0)}%`.padStart(9)}`);
  }
  console.log(`    ${"ALL".padEnd(12)}${String(total(sum)).padStart(8)}${String(sum.red).padStart(8)}`
    + `${String(sum.unsure).padStart(10)}${String(sum.green).padStart(8)}${String(sum.silent).padStart(8)}`
    + `${(total(sum) === 0 ? "n/a" : `${((caught(sum) / total(sum)) * 100).toFixed(0)}%`).padStart(9)}`);
  console.log();
}

await initEngine();

const loaded = plantedKeys(REPO).filter((k) => !wantProject || k.project === wantProject);
if (loaded.length === 0) {
  console.log("No answer keys under bench/boards. Run scripts/bench-planted-key.mts first.");
  process.exit(0);
}

const plantedByWord = new Map<string, Row>();
const plantedByLanguage = new Map<string, Row>();
const plantedByKind = new Map<string, Row>();
const trueByWord = new Map<string, Row>();
const trueByLanguage = new Map<string, Row>();
const undecidable = new Map<string, number>();
const falseReds: string[] = [];
const missed: string[] = [];
const get = (map: Map<string, Row>, name: string) => {
  const row = map.get(name) ?? empty();
  map.set(name, row);
  return row;
};

let boards = 0;
let claimsScored = 0;
let undecidableCount = 0;
const started = Date.now();

for (const key of loaded) {
  boards++;
  for (const claim of key.claims) {
    if (wantWord && claim.word !== wantWord) continue;
    if (wantLanguage && claim.language !== wantLanguage) continue;
    if (wantSource && claim.source !== wantSource) continue;
    if (claim.truth === "undecidable") {
      undecidableCount++;
      undecidable.set(claim.why, (undecidable.get(claim.why) ?? 0) + 1);
      continue;
    }
    const { outcome, detail } = await ask(key, claim);
    claimsScored++;
    const planted = claim.source !== "drawn" && claim.source !== "labelled";
    const where = `${key.project}/${key.topic}`;
    if (claim.truth === "false") {
      bump(get(plantedByWord, claim.word), outcome);
      bump(get(plantedByLanguage, claim.language), outcome);
      bump(get(plantedByKind, planted ? claim.source : "not planted"), outcome);
      if (outcome === "green") {
        missed.push(`  green on a false claim · ${where} · @${claim.word} ${claim.from} -> ${claim.to}`
          + `\n      tooling: ${claim.why}`);
      }
    } else {
      bump(get(trueByWord, claim.word), outcome);
      bump(get(trueByLanguage, claim.language), outcome);
      if (outcome === "red") {
        falseReds.push(`  ${where} · @${claim.word} ${claim.from} -> ${claim.to}`
          + `\n      checker: ${detail}\n      tooling: ${claim.why}`);
      }
    }
    if (details) console.log(`    ${outcome.padEnd(9)} ${claim.truth.padEnd(6)} ${claim.source.padEnd(10)} `
      + `@${claim.word} ${claim.from} -> ${claim.to} | ${detail}`);
  }
}

console.log();
console.log("#296 · PLANTED MISTAKES, AND WHAT THE CHECKER SAID");
console.log(`  ${boards} boards, ${claimsScored} claims scored, `
  + `${undecidableCount} left out as undecidable, in ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log();

table("FALSE CLAIMS -- planted mistakes and the ones Haiku drew",
  "caught = red. A green here is the checker agreeing with something false.",
  plantedByWord, (row) => row.red);
table("FALSE CLAIMS, by language", "same claims, grouped the other way", plantedByLanguage, (row) => row.red);
table("FALSE CLAIMS, by how the mistake was made", "each plant is one of #296's four, or a claim Haiku drew wrong",
  plantedByKind, (row) => row.red);
table("TRUE CLAIMS -- what the checker says about a correct board",
  "caught = green. Every red in this table is a false accusation.",
  trueByWord, (row) => row.green);
table("TRUE CLAIMS, by language", "the red column is the number that matters", trueByLanguage, (row) => row.green);

if (falseReds.length > 0) {
  console.log(`  FALSE REDS -- ${falseReds.length} true claims the checker called wrong`);
  for (const line of falseReds.slice(0, 40)) console.log(line);
  if (falseReds.length > 40) console.log(`  ... and ${falseReds.length - 40} more`);
  console.log();
} else {
  console.log("  FALSE REDS -- none.");
  console.log();
}

if (missed.length > 0) {
  console.log(`  GREEN ON A FALSE CLAIM -- ${missed.length}`);
  for (const line of missed.slice(0, 20)) console.log(line);
  if (missed.length > 20) console.log(`  ... and ${missed.length - 20} more`);
  console.log();
}

console.log("  LEFT OUT -- claims the tooling could not decide, by reason");
for (const [why, count] of [...undecidable.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`    ${String(count).padStart(5)}  ${why}`);
}
console.log();
