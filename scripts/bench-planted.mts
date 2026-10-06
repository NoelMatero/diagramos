#!/usr/bin/env node
/**
 * #296's score: of the mistakes planted in 45 boards of real code, how many
 * does the checker call wrong, how many does it show as not sure, and how many
 * pass in silence -- and how many *true* claims does it call wrong.
 *
 *   npm run bench:planted
 *   npm run bench:planted -- --language=rust --word=calls --details
 *   npm run bench:planted -- --source=wrong-kind
 *
 * ## The two halves of the same question
 *
 * The four columns below say how often the checker is right. Two tables under
 * them say why, and they are one ranking read from both ends (#320, #337):
 *
 * - **CAUGHT, BY VERDICT** -- which check produced each accusation.
 * - **UNDECIDED CLAIMS, BY REASON** -- what stood between every other claim
 *   and a verdict, in the reader's own word for it, with the words and the
 *   languages it fell on.
 *
 * Every filter above narrows both, so a ranking for one word or one kind of
 * planted mistake is one run and nobody has to write a throwaway script to
 * get it: `--word=calls` is the `@calls` wall list, `--source=wrong-kind` is
 * the arrows pointed at the wrong kind of thing.
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
import { liveRefereePool, refereedCheckLive, type LiveRefereePool } from "../src/engine/referee-live";
import { initEngine } from "../src/engine/parse";
import { waitForQuiet } from "./lib/bench-busy";
import { librariesLine, useLibraries } from "./lib/bench-libraries";
import { BENCH_DIR, HOLDOUT } from "./lib/bench-set";
import { plantedBoard, plantedKeys, type Key, type KeyClaim } from "./lib/planted-keys";
import { UNDECIDED_BUCKETS, type Bucket } from "./lib/undecided-buckets";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
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
/** Start at once even while another bench, measure script or vitest is running (#403). */
const noWait = argv.includes("--no-wait");
/**
 * The holdout set is read for its score and nothing else (bench-holdout/README.md).
 * Its arrows are never printed, except the two kinds that are safety failures
 * -- a correct arrow called wrong, a wrong one confirmed -- which have to be
 * read to tell a broken key from a broken checker. The per-reason tables and
 * the worklist are left out too: they are a list of what to fix next, drawn
 * from code the checker is not to be fixed against.
 */
const safetyOnly = (outcome: Outcome, truth: string) =>
  (outcome === "red" && truth === "true") || (outcome === "green" && truth === "false");
/** Prints a reason-by-reason line: on the main set only. */
const listed = HOLDOUT ? (..._: unknown[]) => undefined : console.log;

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
  const cache = newCheckCache(createWorkspace(rootOf(project)));
  held.set(project, cache);
  return cache;
}

/**
 * Where a project is read, with its own libraries in reach (#429): pyright
 * started from here on finds that project's venv, and TanStack is read from a
 * checkout with its packages installed. Projects are walked one at a time, so
 * switching here switches what every server started for the next one sees.
 */
let current: { project: string; root: string } | undefined;
function rootOf(project: string): string {
  if (current?.project !== project) current = { project, root: useLibraries(project) };
  return current.root;
}

/**
 * One language-server pool per project, and never two at once (#337).
 *
 * Every arrow is asked on a board of its own, so without a pool held across
 * them a Python project would start pyright once per arrow -- the start is
 * almost the whole cost, 1.0s to 4.1s per tree, and the questions are tens of
 * milliseconds. Held per project, the run pays each start once.
 *
 * The previous project's servers are closed the moment a new project asks,
 * for the reason `refereeFor` holds one root rather than a map of them: these
 * are live child processes, fifteen pinned clones' worth of rust-analyzer at
 * once is not something to find out about at the eleventh, and a run that
 * walks projects in turn never wants the one it has left.
 *
 * The deadline is generous and per check rather than per pool. This is a
 * measurement, so a board that would have degraded to the text reading under
 * the product's own budget should not degrade here: what this run is for is
 * the ceiling, and the product's cost is measured separately.
 */
const BENCH_BUDGET_MS = 120_000;
let pools: { project: string; pool: LiveRefereePool } | undefined;
function poolFor(project: string): LiveRefereePool {
  if (pools?.project !== project) {
    pools?.pool.close();
    pools = { project, pool: liveRefereePool(() => Date.now() + BENCH_BUDGET_MS) };
  }
  return pools.pool;
}

/**
 * Why an undecided arrow was left undecided, in one slug (#320).
 *
 * Read off a board carrying that one arrow, so every count in the tally
 * belongs to it and to nothing else. The slug is what the split is grouped by,
 * and `UNDECIDED_BUCKETS` has to name every one of them, so a new refusal word
 * shows up as a labelling job rather than disappearing into an "other" row.
 */
function withheldReasons(report: ReturnType<typeof checkDrift>): string[] {
  const tally = report.claims as unknown as Record<string, unknown>;
  return Object.entries(tally)
    .filter(([name]) => name.endsWith("Withheld") || name === "callsNotClosed")
    // `handlesWithheld` is a list rather than a breakdown, and a list's own
    // indices are not reasons.
    .filter(([, breakdown]) => breakdown && !Array.isArray(breakdown))
    .flatMap(([name, breakdown]) => Object.entries(breakdown as Record<string, number>)
      .filter(([, count]) => Number(count) > 0)
      .map(([why]) => (name === "callsNotClosed" ? `not-closed ${why}` : why)))
    .sort();
}

/**
 * How long the last arrow's check took, and what the gate did with its red
 * (#393): printed on `--details` lines so a run can be read for the cost of
 * a check and for every catch the gate gave up, with the answer that gave it
 * up.
 */
let lastAsked: { ms: number; gate: string } = { ms: 0, gate: "" };

/** What the checker said about one arrow, run on a board of its own. */
async function ask(key: Key, claim: KeyClaim): Promise<{ outcome: Outcome; detail: string; reason: string }> {
  const cache = cacheFor(key.project);
  const { workspace } = cache;
  const board = await plantedBoard(key, claim);
  /*
   * The same referee a real check gets (#328, widened to Python and Rust at
   * #337). This used to be left out entirely, and the score every change was
   * judged by was therefore the weaker check -- the one where a call on a
   * value whose type is not written down is never followed at all, which #324
   * measured as the largest single reason a `@calls` arrow goes unanswered.
   * Until #337 it was still the weaker check for Python and Rust, which is
   * two thirds of the corpus.
   */
  const began = performance.now();
  const { report } = await refereedCheckLive(
    rootOf(key.project),
    (referee) => checkDrift(board, workspace, {
      edges: true, cache, ...(referee ? { closedBodyReferee: referee } : {}),
    }),
    { budgetMs: BENCH_BUDGET_MS, pool: poolFor(key.project) },
  );
  const gated = (report as { gated?: Array<{ kind: string; outcome: string; said?: string }> }).gated ?? [];
  lastAsked = {
    ms: performance.now() - began,
    gate: gated.map((one) => `${one.kind} ${one.outcome}${one.said ? `: ${one.said.replace(/\s+/g, " ")}` : ""}`).join("; "),
  };
  // The engine quotes the declaration it read, and a Python class runs to
  // thousands of characters. What a reader of this table needs is which
  // verdict it was and the first line of why.
  const short = (text: string) => (text.length > 220 ? `${text.slice(0, 220)}…` : text).replace(/\s+/g, " ");
  const finding = report.edges[0];
  if (finding && ACCUSES.has(finding.kind)) {
    // The verdict that caught it, in the same field the undecided half uses
    // for the wall it stopped at: one arrow, one line, whichever way it went.
    return { outcome: "red", detail: `${finding.kind}: ${short(finding.detail)}`, reason: finding.kind };
  }
  const why = withheldReasons(report);
  if (finding) {
    return { outcome: "not sure", detail: `${finding.kind}: ${short(finding.detail)}`, reason: `advisory ${finding.kind}` };
  }
  if (report.garbledClaims.length > 0) return { outcome: "not sure", detail: "garbled claim", reason: "garbled claim" };
  const unconfirmed = report.unconfirmedEdges[0];
  if (unconfirmed) {
    // `claim-not-checked` says only that the claim's own reader declined; the
    // reason it declined is the thing anybody would have to fix, so it is the
    // slug (#304, #320).
    const reason = unconfirmed.reason !== "claim-not-checked"
      ? `unconfirmed: ${unconfirmed.reason}`
      // `@builds` goes silent on `absent` without tallying anything, so on
      // those arrows there is no reason to report at all -- which is itself
      // the finding, and is labelled as one.
      : `declined: ${why.length > 0 ? why.join(" + ") : "nothing recorded"}`;
    return { outcome: "not sure", detail: `unconfirmed: ${unconfirmed.reason}`, reason };
  }
  const unread = report.unreadEdges[0];
  if (unread) return { outcome: "not sure", detail: `unread: ${unread.reason}`, reason: `unread: ${unread.reason}` };
  const tally = report.claims as unknown as Record<string, unknown>;
  const confirmations = Object.entries(tally)
    .filter(([name]) => name.endsWith("Confirmed"))
    .reduce((sum, [, value]) => sum + Number(value ?? 0), 0) + report.claims.needsChecked;
  if (confirmations > 0) return { outcome: "green", detail: "confirmed", reason: "confirmed" };
  return {
    outcome: "silent",
    detail: why.length > 0 ? `withheld: ${why[0]}` : "nothing said",
    reason: why.length > 0 ? `declined: ${why.join(" + ")}` : "nothing said",
  };
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
const sumRed = (rows: Map<string, Row>) => [...rows.values()].reduce((sum, row) => sum + row.red, 0);
const sumGreen = (rows: Map<string, Row>) => [...rows.values()].reduce((sum, row) => sum + row.green, 0);

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

/*
 * One of these at a time on a machine (#403). Two benches, or a bench beside
 * a test run, starve the language servers: the score still comes out, slower
 * and with reds that have nothing to do with the code. On stderr, so a saved
 * `--details` run holds only the run.
 */
if (!noWait) await waitForQuiet((line) => console.error(`  ${line}`));

await initEngine();

const loaded = plantedKeys(REPO).filter((k) => !wantProject || k.project === wantProject);
if (loaded.length === 0) {
  console.log(`No answer keys under ${BENCH_DIR}/boards. Run scripts/bench-planted-key.mts first.`);
  process.exit(0);
}

const plantedByWord = new Map<string, Row>();
const plantedByLanguage = new Map<string, Row>();
const plantedByKind = new Map<string, Row>();
const trueByWord = new Map<string, Row>();
const trueByLanguage = new Map<string, Row>();
const undecidable = new Map<string, number>();
/** The split this run exists to print: one undecided claim, by why (#320). */
interface Split { total: number; byWord: Map<string, number>; byLanguage: Map<string, number> }
const splitFalse = new Map<string, Split>();
const splitTrue = new Map<string, Split>();
/**
 * The other half of the same question (#337): which verdict caught the ones
 * that were caught.
 *
 * The undecided split says what stands in the way of a verdict. This says
 * which check is paying, and the two are read together: a reason worth work is
 * one whose neighbours in this table already earn their keep.
 */
const caughtBy = new Map<string, Split>();
const countIn = (map: Map<string, number>, name: string) => map.set(name, (map.get(name) ?? 0) + 1);
function split(map: Map<string, Split>, claim: KeyClaim, reason: string) {
  const row = map.get(reason) ?? { total: 0, byWord: new Map(), byLanguage: new Map() };
  row.total++;
  countIn(row.byWord, claim.word);
  countIn(row.byLanguage, claim.language);
  map.set(reason, row);
}
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

/** The project whose `--details` lines are being printed; each gets a header (#403). */
let printedProject: string | undefined;
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
    const { outcome, detail, reason } = await ask(key, claim);
    claimsScored++;
    const planted = claim.source !== "drawn" && claim.source !== "labelled";
    if (outcome === "not sure" || outcome === "silent") {
      split(claim.truth === "false" ? splitFalse : splitTrue, claim, reason);
    }
    if (outcome === "red" && claim.truth === "false") split(caughtBy, claim, reason);
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
    const shown = details && (!HOLDOUT || safetyOnly(outcome, claim.truth));
    if (shown && key.project !== printedProject) {
      // Where each project starts, so a saved run can be compared arrow for arrow.
      console.log(`  == ${key.project}`);
      printedProject = key.project;
    }
    if (shown) console.log(`    ${outcome.padEnd(9)} ${claim.truth.padEnd(6)} ${claim.source.padEnd(10)} `
      + `${claim.language.padEnd(6)} [${reason}] @${claim.word} ${claim.from} -> ${claim.to} | ${detail}`
      + ` | ${lastAsked.ms.toFixed(0)}ms | gate: ${lastAsked.gate || "-"}`);
  }
}

console.log();
console.log("#296 · PLANTED MISTAKES, AND WHAT THE CHECKER SAID");
console.log(`  ${librariesLine()}`);
if (HOLDOUT) {
  console.log("  set: HOLDOUT -- projects nobody tunes on. Read the score, never the arrows: only safety failures are listed.");
}
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

/*
 * #320's split: the undecided half, by why, and what the score can reach.
 *
 * The four columns above say how often the checker is right. These say what
 * is in the way of it being right more often, which is a different question
 * and the one a worklist comes from.
 */
const undecidedTotal = (map: Map<string, Split>) => [...map.values()].reduce((sum, row) => sum + row.total, 0);
const top = (counts: Map<string, number>) => [...counts.entries()]
  .sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`).join(", ");
const labelOf = (reason: string) => UNDECIDED_BUCKETS[reason];

/*
 * #337: the caught half, by the verdict that caught it.
 *
 * The undecided table below says what is in the way. This says what is
 * already working, and they are the same question asked from both ends: a
 * reason worth a morning is one whose verdict is near the top of this table,
 * because that check will be the one widened to reach it.
 */
/*
 * Both tables, against the four columns they are meant to explain. A reason
 * silently dropped would show up as a ranking that is quietly short, which is
 * the one way a table like this goes wrong without anybody noticing.
 */
const accounted = [...caughtBy.values()].reduce((sum, row) => sum + row.total, 0)
  + undecidedTotal(splitFalse);
const plantedTotal = [...plantedByWord.values()].reduce((sum, row) => sum + total(row), 0);
const greens = [...plantedByWord.values()].reduce((sum, row) => sum + row.green, 0);
if (accounted + greens !== plantedTotal) {
  console.log(`  !! ${plantedTotal - accounted - greens} planted mistakes are in neither table below.`);
  console.log();
}

listed(`  CAUGHT, BY VERDICT -- the ${sumRed(plantedByWord)} planted mistakes that went red`);
listed("    which check produced the accusation. read with the table below, which is the rest of them.");
listed(`    ${"caught".padStart(7)}  verdict`);
for (const [verdict, row] of [...caughtBy.entries()].sort((a, b) => b[1].total - a[1].total)) {
  listed(`    ${String(row.total).padStart(7)}  ${verdict}`);
  listed(`             words: ${top(row.byWord)}`);
  listed(`             languages: ${top(row.byLanguage)}`);
}
listed();

listed(`  UNDECIDED CLAIMS, BY REASON -- ${undecidedTotal(splitFalse)} wrong, ${undecidedTotal(splitTrue)} true`);
listed("    what stands between this claim and a verdict. now = a reader stopped short of a fact that is");
listed("    in the code; work = it needs a type, an index or a measurement; never = the text does not say.");
listed(`    ${"wrong".padStart(7)}${"true".padStart(6)}${"bucket".padStart(8)}${"cost".padStart(6)}  reason`);
const reasons = [...new Set([...splitFalse.keys(), ...splitTrue.keys()])]
  .sort((a, b) => (splitFalse.get(b)?.total ?? 0) + (splitTrue.get(b)?.total ?? 0)
    - (splitFalse.get(a)?.total ?? 0) - (splitTrue.get(a)?.total ?? 0));
const unlabelled: string[] = [];
for (const reason of reasons) {
  const label = labelOf(reason);
  if (!label) unlabelled.push(reason);
  const wrong = splitFalse.get(reason)?.total ?? 0;
  const yes = splitTrue.get(reason)?.total ?? 0;
  const words = new Map<string, number>();
  const languages = new Map<string, number>();
  for (const map of [splitFalse, splitTrue]) {
    const row = map.get(reason);
    if (!row) continue;
    for (const [name, n] of row.byWord) words.set(name, (words.get(name) ?? 0) + n);
    for (const [name, n] of row.byLanguage) languages.set(name, (languages.get(name) ?? 0) + n);
  }
  listed(`    ${String(wrong).padStart(7)}${String(yes).padStart(6)}`
    + `${(label?.bucket ?? "?").padStart(8)}${String(label?.cost ?? "").padStart(6)}  ${reason}`);
  listed(`             words: ${top(words)}`);
  listed(`             languages: ${top(languages)}`);
  listed(`             ${label ? label.why : "NOT LABELLED -- add it to scripts/lib/undecided-buckets.ts"}`);
}
listed();

if (unlabelled.length > 0) {
  listed(`  UNLABELLED REASONS -- ${unlabelled.length}. Counted as not decidable, which is the safe way to be wrong.`);
  for (const reason of unlabelled) listed(`    ${reason}`);
  listed();
}

/** Every undecided claim, by bucket, with the true claims kept apart. */
const buckets: Record<Bucket, { wrong: number; yes: number }> = {
  now: { wrong: 0, yes: 0 }, work: { wrong: 0, yes: 0 }, never: { wrong: 0, yes: 0 },
};
for (const reason of reasons) {
  const bucket = labelOf(reason)?.bucket ?? "never";
  buckets[bucket].wrong += splitFalse.get(reason)?.total ?? 0;
  buckets[bucket].yes += splitTrue.get(reason)?.total ?? 0;
}

const decidedNow = sumRed(plantedByWord) + sumGreen(trueByWord);
const scored = claimsScored;
const pct = (n: number) => `${((n / scored) * 100).toFixed(0)}%`;
const bucketTotal = (name: Bucket) => buckets[name].wrong + buckets[name].yes;

console.log("  THE SCORE, AND WHAT IT COULD REACH");
console.log("    decided correctly = a wrong claim went red, a true claim went green (#320)");
console.log(`    today                          ${String(decidedNow).padStart(5)} / ${scored}  ${pct(decidedNow)}`);
console.log(`    + every 'now' claim decided    ${String(decidedNow + bucketTotal("now")).padStart(5)} / ${scored}  `
  + `${pct(decidedNow + bucketTotal("now"))}`);
console.log(`    + every 'work' claim decided   ${String(decidedNow + bucketTotal("now") + bucketTotal("work")).padStart(5)} / ${scored}  `
  + `${pct(decidedNow + bucketTotal("now") + bucketTotal("work"))}   <- the ceiling`);
console.log(`    out of reach: ${bucketTotal("never")} undecidable (${buckets.never.wrong} wrong, ${buckets.never.yes} true)`
  + `, and ${missed.length} wrong claims that came back green.`);
console.log("    Held fixed while that rises: reds on true claims, and greens on wrong claims.");
console.log();

listed("  WORKLIST -- fixable reasons, most claims per unit of work first");
listed(`    ${"claims".padStart(7)}${"cost".padStart(6)}${"per".padStart(7)}  reason`);
const work = reasons
  .map((reason) => {
    const label = labelOf(reason);
    const claims = (splitFalse.get(reason)?.total ?? 0) + (splitTrue.get(reason)?.total ?? 0);
    return { reason, label, claims };
  })
  .filter((row) => row.label && row.label.bucket !== "never")
  .sort((a, b) => b.claims / b.label!.cost - a.claims / a.label!.cost);
for (const { reason, label, claims } of work) {
  listed(`    ${String(claims).padStart(7)}${String(label!.cost).padStart(6)}`
    + `${(claims / label!.cost).toFixed(1).padStart(7)}  ${reason}`);
}
listed();

/*
 * The last project's servers, which nothing else will close. A live language
 * server is an open child-process handle and Node will not reach its own
 * natural exit while one is alive -- `check-drift.mjs` found that live, as the
 * script hanging after printing its whole report.
 */
pools?.pool.close();
