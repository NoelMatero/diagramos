/**
 * Re-measuring the dependency licence, so the committed number can be argued with.
 *
 *   npm run measure:licence                  -- every language, cloning what is missing
 *   npm run measure:licence -- --check       -- fail if the numbers have moved
 *   npm run measure:licence -- --only=rust   -- one language
 *   npm run measure:licence -- <path>        -- one tree of your own, nothing cloned
 *
 * Corpus clones land in .corpus/, which is gitignored: a licence records the
 * commit it was measured at, not a copy of somebody else's repository. Cloning
 * needs the network, which is why this is a command you run rather than a test
 * that runs itself.
 *
 * Each language has its own referee and its own harness -- the TypeScript
 * compiler for one, rust-analyzer for the other -- so what is shared here is the
 * arithmetic and the report, and nothing else. Measuring Rust needs
 * `rust-analyzer` on the PATH; without it that half fails loudly rather than
 * scoring zero disagreements against a referee that never ran.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  ACCUSING_RELATIONS, LICENCES, isMeasured, licenceTotals,
  type CorpusEntry, type Licence,
} from "../src/engine/licence";
import { languageOf, type Language } from "../src/engine/parse";
import { measureLicence, type LicenceMeasurement } from "./lib/licence";
import { measureRustLicence } from "./lib/licence-rust";
import { measurePythonLicence } from "./lib/licence-python";

/** The harness for a language. One per referee, because a referee is per language. */
function harnessFor(language: string): (root: string) => Promise<LicenceMeasurement> {
  if (language === "rust") return measureRustLicence;
  if (language === "python") return measurePythonLicence;
  return measureLicence;
}

/**
 * Which referee a tree given on the command line should be measured against.
 *
 * A Cargo manifest is the giveaway and it is at the top of the tree, so nothing
 * is walked. Pass `--only=<language>` to say so outright when the guess is
 * wrong -- a repository holding both is a real thing, and this picks one.
 */
function languageOfTree(root: string): string {
  if (existsSync(path.join(root, "Cargo.toml"))) return "rust";
  /*
   * A Python manifest, in the four spellings a repository actually uses. None
   * of them is conclusive -- a TypeScript project can carry a tox.ini for its
   * docs build -- which is why `--only=<language>` exists and why a repository
   * holding both is expected to say so rather than be guessed at.
   */
  const pythonManifests = ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"];
  if (pythonManifests.some((name) => existsSync(path.join(root, name)))) return "python";
  return "typescript";
}

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

async function report(root: string, label: string, language?: string): Promise<void> {
  const chosen = language ?? languageOfTree(root);
  const measured = await harnessFor(chosen)(root);
  const agreed = [...measured.refereeEdges].filter((edge) => measured.ourEdges.has(edge)).length;
  console.log(`\n${label}  (${chosen})`);
  console.log(`  files ${measured.files.length}  referee ${measured.refereeEdges.size}  reader ${measured.ourEdges.size}`);
  console.log(`  agreed ${agreed}  missed ${measured.missed.length}  invented ${measured.invented.length}`);
  console.log(`  incomplete ${measured.incomplete.length}  dynamic ${measured.dynamic.length}  no grammar ${measured.skipped.length}  referee skipped ${measured.unloaded?.length ?? 0}  oversized ${measured.oversized.length}`);
  for (const edge of measured.missed) console.log(`    missed   ${edge}`);
  for (const edge of measured.invented) console.log(`    invented ${edge}`);
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const only = args.find((argument) => argument.startsWith("--only="))?.slice("--only=".length);
const paths = args.filter((argument) => !argument.startsWith("--"));

if (paths.length > 0) {
  for (const one of paths) await report(one, path.resolve(one), only);
  process.exit(0);
}

function percentOf(agreed: number, total: number): string {
  return total === 0 ? "n/a" : percent(agreed / total);
}

let moved = false;
console.error(`corpus in ${CORPUS_DIRECTORY}`);

async function measureOne(licence: Licence): Promise<void> {
  const measure = harnessFor(licence.language);
  const rows: Array<{
    entry: CorpusEntry; files: number; edges: number; missed: number; invented: number; unmeasured: number;
  }> = [];

  for (const entry of licence.corpus) {
    const root = ensureClone(entry);
    if (!root) {
      moved = true;
      continue;
    }
    let measured: LicenceMeasurement;
    try {
      measured = await measure(root);
    } catch (error) {
      // A referee that cannot run is not a perfect score; it is no measurement.
      console.error(`  ${entry.name}: ${(error as Error).message}`);
      moved = true;
      continue;
    }
    rows.push({
      entry,
      files: measured.files.length,
      edges: measured.refereeEdges.size,
      missed: measured.missed.length,
      invented: measured.invented.length,
      unmeasured: measured.unloaded?.length ?? 0,
    });
    if (measured.skipped.length > 0) {
      console.error(`  ${entry.name}: ${measured.skipped.length} source files with no grammar -- the licence covers less than it claims`);
      moved = true;
    }
    for (const edge of measured.missed) console.error(`  ${entry.name} missed   ${edge}`);
    for (const edge of measured.invented) console.error(`  ${entry.name} invented ${edge}`);
  }

  console.log("");
  console.log(`${licence.language}`);
  console.log("repository                files   edges   missed  invented  unmeasured");
  for (const row of rows) {
    console.log(
      `${row.entry.name.padEnd(24)} ${String(row.files).padStart(5)}  ${String(row.edges).padStart(6)}  `
      + `${String(row.missed).padStart(6)}  ${String(row.invented).padStart(8)}  ${String(row.unmeasured).padStart(10)}`,
    );
    const same =
      row.files === row.entry.files && row.edges === row.entry.edges &&
      row.missed === row.entry.missed && row.invented === row.entry.invented
      && row.unmeasured === (row.entry.unmeasured ?? 0);
    if (!same) {
      moved = true;
      console.log(
        `${" ".repeat(24)} licence says ${row.entry.files} / ${row.entry.edges} / ${row.entry.missed}`
        + ` / ${row.entry.invented} / ${row.entry.unmeasured ?? 0}`,
      );
    }
  }

  const totals = rows.reduce(
    (into, row) => ({
      files: into.files + row.files, edges: into.edges + row.edges,
      missed: into.missed + row.missed, invented: into.invented + row.invented,
      unmeasured: into.unmeasured + row.unmeasured,
    }),
    { files: 0, edges: 0, missed: 0, invented: 0, unmeasured: 0 },
  );
  const agreed = totals.edges - totals.missed;
  console.log("");
  console.log(`${totals.files} files, ${totals.edges} dependency edges`);
  if (totals.unmeasured > 0) {
    const onDisk = totals.files + totals.unmeasured;
    console.log(
      `${totals.unmeasured} of the ${onDisk} source files present were left out: `
      + `the referee never opened them, so it has no opinion to disagree with `
      + `(${((totals.unmeasured / onDisk) * 100).toFixed(1)}% of the corpus)`,
    );
  }
  console.log(`recall    ${percentOf(agreed, totals.edges)}  (${totals.missed} the referee saw and the reader did not)`);
  console.log(`precision ${percentOf(agreed, agreed + totals.invented)}  (${totals.invented} the reader saw and the referee did not)`);

  const committed = licenceTotals(licence);
  console.log(`licence on record: recall ${percent(committed.recall)}, precision ${percent(committed.precision)}, measured ${licence.measured}`);
}

for (const licence of LICENCES) {
  if (only && licence.language !== only) continue;
  await measureOne(licence);
}

/**
 * The other axis, which the numbers above are only one row of.
 *
 * A licence is per language *and* per word. The corpus above measures the
 * dependency reader and nothing else -- `holds`, `takes`, `returns` and
 * `builds` each read something different, against a referee of their own, and
 * three of them are measured by a different command. Printing only the
 * dependency number here is how one entry came to speak for four words.
 *
 * Printed from the licence rather than re-measured: reproducing a row means
 * running the command in its last column. What this table is for is showing
 * which squares have a number at all, and an empty one is the interesting kind.
 */
/** Greedy wrap, so a reason reads as prose rather than running off the terminal. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > width) { lines.push(line); line = word; }
    else line = line === "" ? word : `${line} ${word}`;
  }
  if (line !== "") lines.push(line);
  return lines;
}

function printGrid(): void {
  console.log("");
  console.log("what each word may accuse about, and what earned it");
  console.log("");
  console.log(
    "word".padEnd(9) + "language".padEnd(12) + "asked".padStart(8)
    + "missed".padStart(8) + "invented".padStart(10) + "  reproduce",
  );
  for (const relation of ACCUSING_RELATIONS) {
    for (const licence of LICENCES) {
      if (only && licence.language !== only) continue;
      const row = licence.relations[relation];
      const head = relation.padEnd(9) + licence.language.padEnd(12);
      if (!isMeasured(row)) {
        console.log(head + "—".padStart(8) + "—".padStart(8) + "—".padStart(10)
          + "  may not accuse");
        // The reason in full rather than a first sentence: "no" without one is
        // the shrug this grid exists to replace.
        for (const line of wrap(row.unmeasured, 74)) console.log("    " + line);
        continue;
      }
      const totals = row.counts === "corpus"
        ? (() => {
            const all = licenceTotals(licence);
            return { asked: all.edges, missed: all.missed, invented: all.invented };
          })()
        : row.counts;
      // An absent `invented` is not a zero: `measure:signature` counts misses
      // and nothing else, and a dash says so where a 0 would lie.
      const invented = totals.invented === undefined ? "—" : String(totals.invented);
      console.log(
        head + String(totals.asked).padStart(8) + String(totals.missed).padStart(8)
        + invented.padStart(10) + "  " + row.reproduce,
      );
      /*
       * A licence covers several extensions and a run may not have asked about
       * all of them, so the languages left out are printed under the row. Four
       * words say yes for TypeScript and no for JavaScript on the same line of
       * this table, and without this the table cannot show it.
       */
      if (row.covers) {
        const outside = licence.extensions
          .map((extension) => languageOf(`x${extension}`))
          .filter((language): language is Language =>
            language !== undefined && !row.covers!.includes(language));
        if (outside.length > 0) {
          console.log(`    not ${[...new Set(outside)].join(", ")} — inside this licence, outside this number`);
        }
      }
      // A miss is only allowed if somebody read it, so say how many were read.
      for (const line of row.known ?? []) {
        for (const wrapped of wrap(line, 70)) console.log("      " + wrapped);
      }
    }
  }
  console.log("");
  console.log("An empty square is a word that may not accuse in that language. It is not a");
  console.log("gap to be filled in with a yes: the reason is in `relations` in licence.ts,");
  console.log("and the square stays empty until a run of the command puts a number in it.");
}

printGrid();

if (check && moved) {
  console.error("\nthe measurement has moved. Update src/engine/licence.ts, or find out why.");
  process.exit(1);
}
