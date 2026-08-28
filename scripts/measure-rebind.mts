/**
 * Re-measuring how often a stale ref could have been followed, so the committed
 * number can be argued with.
 *
 *   npm run measure:rebind                    -- both samples, whole history
 *   npm run measure:rebind -- --check         -- fail if the numbers have moved
 *   npm run measure:rebind -- --since=<rev>   -- a shorter walk while iterating
 *   npm run measure:rebind -- --rows          -- print every stale ref, not the summary
 *   npm run measure:rebind -- --repo=<path>   -- replay somebody else's history instead
 *
 * Two samples come out. The one that counts is refs that were on a board when
 * the code moved under them; in this repository that sample is empty, because
 * the boards are younger than the code. The second treats every source file
 * that left the tree as though a board had pointed at it, which is weaker and
 * says so, but is the only one here with anything in it. `--repo` exists because
 * one small history decides nothing: the second sample needs no boards, so it
 * runs against any checkout.
 *
 * Everything it needs is in `.git`, so unlike the licence corpus this needs no
 * network and clones nothing. It is a command rather than a test only because it
 * walks the whole history, parses every candidate file, and takes a few minutes.
 *
 * The buckets and the guard live in `scripts/lib/rebind.ts`; the number that came
 * out lives in `src/engine/rebind.ts`. What is here is the arithmetic and the
 * report.
 */
import { initEngine } from "../src/engine/parse";
import { REBIND, type RebindSample } from "../src/engine/rebind";
import {
  channels, measureHypothetical, measureRebind, tally, verdicts,
  type RebindMeasurement, type StaleRef,
} from "./lib/rebind";

const args = process.argv.slice(2);
const check = args.includes("--check");
const showRows = args.includes("--rows");
const since = args.find((argument) => argument.startsWith("--since="))?.slice("--since=".length);
const repo = args.find((argument) => argument.startsWith("--repo="))?.slice("--repo=".length);

// The symbol channel parses every candidate file looking for a declaration, so
// the grammars have to be up before the walk starts. Without this every symbol
// search silently finds nothing, and every ref that moved with its symbol would
// be scored "gone" -- a measurement that looks decisive and is measuring the
// parser being switched off.
await initEngine();

function progress(label: string) {
  return (index: number, total: number) => {
    if (index % 10 === 0) process.stderr.write(`  ${label} ${index}/${total}\r`);
  };
}

// Somebody else's repository has no boards of ours in it, so only the
// hypothetical sample is asked for. Reporting an empty board sample for a
// stranger's history would read as a result rather than as a category error.
const boards = repo
  ? undefined
  : await measureRebind({ since, onCommit: progress("boards") });
const everyFile = await measureHypothetical({ repo, since, onCommit: progress("every file") });
process.stderr.write("                              \r");

function sampleOf(measured: RebindMeasurement): RebindSample {
  const buckets = tally(measured.rows);
  const truth = verdicts(measured.rows.filter((row) => row.bucket === "followable"));
  const byChannel = channels(measured.rows.filter((row) => row.bucket === "followable"));
  return {
    anchors: measured.anchors,
    chances: measured.chances,
    breakingCommits: measured.breakingCommits,
    ...buckets,
    byRename: byChannel.rename,
    bySymbol: byChannel.symbol,
    byPath: byChannel.path,
    byDirectory: byChannel.directory,
    ...truth,
  };
}

function percentOf(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
}

function report(title: string, note: string, measured: RebindMeasurement): RebindSample {
  const sample = sampleOf(measured);
  const broke = sample.followable + sample.ambiguous + sample.gone;
  console.log("");
  console.log(title);
  console.log(`  ${note}`);
  console.log(`  anchors    ${sample.anchors}`);
  console.log(`  chances    ${sample.chances}  (a commit changed the file the anchor pointed at)`);
  console.log(`  broke      ${broke}  across ${sample.breakingCommits} commits`);
  console.log(`  followable ${sample.followable}  (${percentOf(sample.followable, broke)})`);
  console.log(`  ambiguous  ${sample.ambiguous}  (${percentOf(sample.ambiguous, broke)})   <- the number that decides the feature`);
  console.log(`  gone       ${sample.gone}  (${percentOf(sample.gone, broke)})`);
  if (sample.followable > 0) {
    console.log(
      `    by rename ${sample.byRename}  by symbol ${sample.bySymbol}  `
      + `by path ${sample.byPath}  by directory ${sample.byDirectory}`,
    );
    console.log(
      `  of the followable, a human later wrote: ${sample.agreed} the same, `
      + `${sample.disagreed} different, ${sample.unfixed} never corrected it`,
    );
  }
  return sample;
}

console.log(`repo   ${repo ?? process.cwd()}`);
console.log(`range  ${everyFile.from}..${everyFile.to}  (${everyFile.commits} first-parent commits)`);

const boardSample = boards && report(
  "on real boards",
  "refs that were on a board when the code moved under them",
  boards,
);
const everyFileSample = report(
  "on every file that left the tree  (hypothetical, weaker sample)",
  "each vanished source file, and each symbol it exported, as if a box had named it",
  everyFile,
);

function describe(row: StaleRef): string {
  const head = `  ${row.bucket.padEnd(10)} ${row.commit}  ${row.ref}`;
  if (row.bucket === "followable") {
    const truth = row.verdict === "disagreed" ? `disagreed: human wrote ${row.humanWrote}` : row.verdict;
    return `${head}\n${" ".repeat(13)}-> ${row.candidate}  (${row.channel}, ${truth})`;
  }
  if (row.bucket === "ambiguous") return `${head}\n${" ".repeat(13)}?  ${row.candidates.join("  ")}`;
  return head;
}

if (showRows) {
  for (const [title, measured] of [["real boards", boards], ["every file", everyFile]] as const) {
    if (!measured || measured.rows.length === 0) continue;
    console.log(`\n${title}`);
    for (const row of measured.rows) console.log(describe(row));
  }
}

if (!check) process.exit(0);

if (!boards || !boardSample || repo) {
  console.error("\n--check compares the committed number, which is this repository's own history.");
  process.exit(1);
}

/**
 * The committed number, re-derived.
 *
 * The range is pinned along with the counts: a measurement over a history that
 * has grown is a different measurement, and saying so is cheaper than quietly
 * comparing new totals against old ones.
 */
const moved: string[] = [];

function compare(name: string, was: unknown, now: unknown): void {
  if (was !== now) moved.push(`  ${name}: on record ${was}, measured ${now}`);
}

compare("from", REBIND.from, boards.from);
compare("to", REBIND.to, boards.to);
compare("commits", REBIND.commits, boards.commits);
for (const [name, sample, measured] of [
  ["boards", REBIND.boards, boardSample],
  ["everyFile", REBIND.everyFile, everyFileSample],
] as const) {
  for (const key of Object.keys(sample) as Array<keyof RebindSample>) {
    compare(`${name}.${key}`, sample[key], measured[key]);
  }
}

if (moved.length > 0) {
  console.error("\nthe measurement has moved:");
  for (const line of moved) console.error(line);
  console.error("\nUpdate src/engine/rebind.ts, or find out why.");
  process.exit(1);
}

console.log(`\non record in src/engine/rebind.ts, measured ${REBIND.measured}. Unchanged.`);
