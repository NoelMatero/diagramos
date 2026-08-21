/**
 * Re-measuring the dependency licence, so the committed number can be argued with.
 *
 *   npm run measure:licence            -- the whole corpus, cloning what is missing
 *   npm run measure:licence -- --check -- fail if the numbers have moved
 *   npm run measure:licence -- <path>  -- one tree of your own, nothing cloned
 *
 * Corpus clones land in .corpus/, which is gitignored: a licence records the
 * commit it was measured at, not a copy of somebody else's repository. Cloning
 * needs the network, which is why this is a command you run rather than a test
 * that runs itself.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { LICENCES, licenceTotals, type CorpusEntry } from "../src/engine/licence";
import { measureLicence } from "./lib/licence";

const CORPUS_DIRECTORY = path.resolve(".corpus");

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A clone at the pinned commit, made if it is not already there. */
function ensureClone(entry: CorpusEntry): string | undefined {
  const target = path.join(CORPUS_DIRECTORY, entry.name.replace("/", "-"));
  if (existsSync(path.join(target, ".git"))) {
    const at = run("git", ["rev-parse", "HEAD"], target);
    if (!entry.commit.startsWith(at) && !at.startsWith(entry.commit)) {
      console.error(`  ${entry.name}: clone is at ${at.slice(0, 12)}, licence says ${entry.commit.slice(0, 12)}`);
    }
    return target;
  }
  console.error(`  cloning ${entry.name}...`);
  try {
    run("git", ["clone", "--filter=blob:none", "--quiet", entry.url, target]);
    run("git", ["checkout", "--quiet", entry.commit], target);
    return target;
  } catch (error) {
    console.error(`  ${entry.name}: could not clone -- ${(error as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(3)}%`;
}

async function report(root: string, label: string): Promise<void> {
  const measured = await measureLicence(root);
  const agreed = [...measured.refereeEdges].filter((edge) => measured.ourEdges.has(edge)).length;
  console.log(`\n${label}`);
  console.log(`  files ${measured.files.length}  referee ${measured.refereeEdges.size}  reader ${measured.ourEdges.size}`);
  console.log(`  agreed ${agreed}  missed ${measured.missed.length}  invented ${measured.invented.length}`);
  console.log(`  incomplete ${measured.incomplete.length}  dynamic ${measured.dynamic.length}  no grammar ${measured.skipped.length}  oversized ${measured.oversized.length}`);
  for (const edge of measured.missed) console.log(`    missed   ${edge}`);
  for (const edge of measured.invented) console.log(`    invented ${edge}`);
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const paths = args.filter((argument) => !argument.startsWith("--"));

if (paths.length > 0) {
  for (const one of paths) await report(one, path.resolve(one));
  process.exit(0);
}

const licence = LICENCES.find((entry) => entry.language === "typescript")!;
let moved = false;

console.error(`corpus in ${CORPUS_DIRECTORY}`);
const rows: Array<{ entry: CorpusEntry; files: number; edges: number; missed: number; invented: number }> = [];

for (const entry of licence.corpus) {
  const root = ensureClone(entry);
  if (!root) {
    moved = true;
    continue;
  }
  const measured = await measureLicence(root);
  const row = {
    entry,
    files: measured.files.length,
    edges: measured.refereeEdges.size,
    missed: measured.missed.length,
    invented: measured.invented.length,
  };
  rows.push(row);
  if (measured.skipped.length > 0) {
    console.error(`  ${entry.name}: ${measured.skipped.length} source files with no grammar -- the licence covers less than it claims`);
    moved = true;
  }
  for (const edge of measured.missed) console.error(`  ${entry.name} missed   ${edge}`);
  for (const edge of measured.invented) console.error(`  ${entry.name} invented ${edge}`);
}

console.log("");
console.log("repository                files   edges   missed  invented");
for (const row of rows) {
  console.log(
    `${row.entry.name.padEnd(24)} ${String(row.files).padStart(5)}  ${String(row.edges).padStart(6)}  ${String(row.missed).padStart(6)}  ${String(row.invented).padStart(8)}`,
  );
  const same =
    row.files === row.entry.files && row.edges === row.entry.edges &&
    row.missed === row.entry.missed && row.invented === row.entry.invented;
  if (!same) {
    moved = true;
    console.log(
      `${" ".repeat(24)} licence says ${row.entry.files} / ${row.entry.edges} / ${row.entry.missed} / ${row.entry.invented}`,
    );
  }
}

const measuredTotals = rows.reduce(
  (into, row) => ({
    files: into.files + row.files, edges: into.edges + row.edges,
    missed: into.missed + row.missed, invented: into.invented + row.invented,
  }),
  { files: 0, edges: 0, missed: 0, invented: 0 },
);
const agreed = measuredTotals.edges - measuredTotals.missed;
console.log("");
console.log(`${measuredTotals.files} files, ${measuredTotals.edges} dependency edges`);
console.log(`recall    ${percent(agreed / measuredTotals.edges)}  (${measuredTotals.missed} the compiler saw and the reader did not)`);
console.log(`precision ${percent(agreed / (agreed + measuredTotals.invented))}  (${measuredTotals.invented} the reader saw and the compiler did not)`);

const committed = licenceTotals(licence);
console.log(`\nlicence on record: recall ${percent(committed.recall)}, precision ${percent(committed.precision)}, measured ${licence.measured}`);

if (check && moved) {
  console.error("\nthe measurement has moved. Update src/engine/licence.ts, or find out why.");
  process.exit(1);
}
