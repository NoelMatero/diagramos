#!/usr/bin/env node
/**
 * Re-asks the tooling about claims already in #296's answer keys, and changes
 * nothing else.
 *
 *   npx tsx scripts/bench-planted-rejudge.mts --word=calls --why="the from end is a type"
 *   npx tsx scripts/bench-planted-rejudge.mts --word=calls --why="the from end is a type" --write
 *
 * `bench-planted-key.mts` rebuilds a key from its board, and a rebuild grows
 * plants from every claim the tooling calls true -- so changing how one word
 * is judged and rebuilding would change *which* claims the score is computed
 * over, not only their answers. When the reading of a word is corrected
 * (#346), the population has to stay put and only the verdicts move. This is
 * that: the same claims, in the same order, with `truth` and `why` re-read.
 *
 * Without `--write` it prints every claim whose answer would change and
 * touches no file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createOracle, type Word } from "./lib/bench-oracle";
import { createTooling, type Language } from "./lib/bench-tooling";
import { plantedKeyFiles } from "./lib/planted-keys";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CORPUS = process.env.CORPUS ?? "/Users/noelmatero/board-ai/.corpus";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const word = flag("word") as Word | undefined;
const why = flag("why");
const write = argv.includes("--write");
if (!word) {
  console.log("Name the word to re-judge: --word=calls, and narrow it with --why=<start of the stored reason>.");
  process.exit(1);
}

let asked = 0;
const changed = new Map<string, number>();
for (const file of plantedKeyFiles(REPO)) {
  const key = JSON.parse(readFileSync(file, "utf8")) as {
    project: string; language: string;
    claims: Array<{ word: string; from: string; to: string; member?: string; truth: string; why: string; source: string }>;
  };
  const wanted = key.claims.filter((c) => c.word === word && (!why || c.why.startsWith(why)));
  if (wanted.length === 0) continue;
  const language = (key.language === "tsx" ? "ts" : key.language) as Language;
  const oracle = createOracle(await createTooling(language, path.join(CORPUS, key.project)));
  let moved = 0;
  for (const claim of wanted) {
    asked++;
    const answer = await oracle.judge({
      word, from: claim.from, to: claim.to, ...(claim.member ? { member: claim.member } : {}),
    });
    if (answer.truth === claim.truth && answer.why === claim.why) continue;
    moved++;
    const shift = `${claim.truth} -> ${answer.truth}`;
    changed.set(shift, (changed.get(shift) ?? 0) + 1);
    console.log(`  ${shift.padEnd(22)} ${claim.source.padEnd(9)} @${word} ${claim.from} -> ${claim.to}`
      + `\n      ${answer.why}`);
    claim.truth = answer.truth;
    claim.why = answer.why;
  }
  oracle.close();
  if (write && moved > 0) writeFileSync(file, `${JSON.stringify(key, null, 2)}\n`);
}

console.log();
console.log(`${asked} claims re-asked${write ? ", keys written" : " (dry run, nothing written)"}`);
for (const [shift, count] of [...changed.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${shift}`);
}
