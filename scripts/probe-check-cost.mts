#!/usr/bin/env node
/**
 * What one arrow costs to check, and what it costs the second time (#311).
 *
 * The probe that found the problem: `bench:planted` asked 1,661 arrows and
 * every one of them re-read the same files, because `checkDrift` built its
 * cache on entry and dropped it on return. One clap `@needs` arrow did 227
 * reads, 5,846 stats and 1,447 directory listings -- identically, on every one
 * of three runs. There was no second-run discount, which was the finding.
 *
 *   npm run probe:check-cost
 *   npm run probe:check-cost -- --project=clap --word=needs --runs=3
 *
 * It prints the same arrow asked twice: cold, the way the server asks it, and
 * through one held cache, the way a measurement script now does. Cold must
 * stay flat -- that is `check_drift` over MCP keeping no memory of a working
 * tree that changes underneath it. The held column is what the bench buys.
 *
 * ## The third block: what the type checker costs (#328)
 *
 * The MCP server now hands `checkDrift` a receiver resolver, including at draw
 * time. That resolver builds a `ts.Program` over the package a query lands in,
 * which is the single most expensive thing on this path -- and the question
 * that decides whether it belongs at draw time is not what it costs, but
 * whether it costs that *again*. So the referee rows reuse one referee across
 * runs, exactly as the server does: the first row is the compiler being built,
 * every row after it is the compiler being asked.
 */
import path from "node:path";

import { checkDrift, createWorkspace, newCheckCache } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { createClosedBodyReferee } from "../src/engine/referee";
import type { Workspace } from "../src/engine/workspace";
import { plantedBoard, plantedKeys } from "./lib/planted-keys";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CORPUS = process.env.CORPUS ?? "/Users/noelmatero/board-ai/.corpus";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const runs = Number(flag("runs") ?? 3);
/** Default to the two arrows the issue priced: the worst square and a cheap one. */
const wanted = [
  { project: flag("project") ?? "clap", word: flag("word") ?? "needs" },
  ...(flag("project") || flag("word") ? [] : [
    { project: "vuejs-core", word: "holds" },
    // A TypeScript project, and a big one: the referee rows below are blank
    // for a language whose resolver cannot run in process, and a small tree
    // would price the compiler at a number no real repository would see.
    { project: "vitejs-vite", word: "calls" },
  ]),
];

interface Counts { reads: number; distinct: number; stats: number; lists: number; ms: number }

/** The same workspace, counting what it is asked for. */
function counting(root: string): { workspace: Workspace; take: () => Omit<Counts, "ms"> } {
  const inner = createWorkspace(root);
  let reads = 0, stats = 0, lists = 0;
  const seen = new Set<string>();
  return {
    workspace: {
      resolve: (at) => inner.resolve(at),
      stat: (at) => { stats++; return inner.stat(at); },
      read: (at) => { reads++; seen.add(at); return inner.read(at); },
      list: (at) => { lists++; return inner.list(at); },
    },
    take: () => {
      const taken = { reads, distinct: seen.size, stats, lists };
      reads = 0; stats = 0; lists = 0; seen.clear();
      return taken;
    },
  };
}

await initEngine();

console.log();
console.log("#311 · WHAT ONE ARROW COSTS TO CHECK, ASKED AGAIN");
console.log(`  ${runs} runs of the same arrow on the same board, cold and through one held cache`);
console.log();

for (const pick of wanted) {
  const key = plantedKeys(REPO).find((k) =>
    k.project === pick.project && k.claims.some((c) => c.word === pick.word && c.truth !== "undecidable"));
  const claim = key?.claims.find((c) => c.word === pick.word && c.truth !== "undecidable");
  if (!key || !claim) {
    console.log(`  no stored ${pick.project} @${pick.word} claim -- run scripts/bench-planted-key.mts first`);
    continue;
  }
  const board = await plantedBoard(key, claim);
  const root = path.join(CORPUS, key.project);

  const rows: Array<{ how: string; counts: Counts }> = [];
  const cold = counting(root);
  for (let run = 1; run <= runs; run++) {
    const started = Date.now();
    checkDrift(structuredClone(board), cold.workspace, { edges: true });
    rows.push({ how: `cold ${run}`, counts: { ...cold.take(), ms: Date.now() - started } });
  }
  const warm = counting(root);
  const cache = newCheckCache(warm.workspace);
  for (let run = 1; run <= runs; run++) {
    const started = Date.now();
    checkDrift(structuredClone(board), warm.workspace, { edges: true, cache });
    rows.push({ how: `held ${run}`, counts: { ...warm.take(), ms: Date.now() - started } });
  }

  /*
   * Cold workspace, one referee, which is the server's own shape: it keeps no
   * memory of a working tree that changes underneath it, but it does keep the
   * compiler, because the compiler re-verifies its own programs against every
   * source file's mtime before answering (#234).
   */
  const refereed = counting(root);
  const closedBodyReferee = createClosedBodyReferee(root);
  for (let run = 1; run <= runs; run++) {
    const started = Date.now();
    checkDrift(structuredClone(board), refereed.workspace, { edges: true, closedBodyReferee });
    rows.push({ how: `tsc ${run}`, counts: { ...refereed.take(), ms: Date.now() - started } });
  }

  console.log(`  ${key.project} @${claim.word} (${claim.language}) · ${claim.from} -> ${claim.to}`);
  console.log(`    ${"".padEnd(9)}${"reads".padStart(8)}${"distinct".padStart(10)}${"stats".padStart(8)}`
    + `${"listings".padStart(10)}${"ms".padStart(8)}`);
  for (const { how, counts } of rows) {
    console.log(`    ${how.padEnd(9)}${String(counts.reads).padStart(8)}${String(counts.distinct).padStart(10)}`
      + `${String(counts.stats).padStart(8)}${String(counts.lists).padStart(10)}${String(counts.ms).padStart(8)}`);
  }
  console.log();
}
