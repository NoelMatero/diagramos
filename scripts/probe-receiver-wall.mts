#!/usr/bin/env node
/**
 * Why an arrow still stops at "a call on a value whose type is not written
 * down", after #337 wired the language servers into the check.
 *
 *   npm run probe:receiver-wall -- --project=ripgrep
 *
 * The wall fell from 53 arrows to 25 when the resolvers reached the check.
 * The 25 left are what this reads: for each planted `@calls` claim that still
 * stops there, how many receivers the check asked about, how many the server
 * answered, and which positions it had nothing for. A wall that is still up
 * because no server started is a bug; one that is up because pyright and
 * rust-analyzer genuinely have no answer at those positions is a fact, and
 * the two are not fixed by the same work.
 */
import path from "node:path";

import { checkDrift, createWorkspace, newCheckCache, type ClosedBodyReferee } from "../src/engine/drift";
import { initEngine, languageOf } from "../src/engine/parse";
import { liveRefereePool, refereeSentence, refereedCheckLive } from "../src/engine/referee-live";
import { plantedKeys, plantedBoard } from "./lib/planted-keys";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CORPUS = process.env.CORPUS ?? "/Users/noelmatero/board-ai/.corpus";

const argv = process.argv.slice(2);
const only = argv.find((a) => a.startsWith("--project="))?.split("=")[1];

await initEngine();

console.log();
console.log("#337A · THE RECEIVERS STILL UNANSWERED");
console.log();

for (const key of plantedKeys(REPO)) {
  if (only && key.project !== only) continue;
  const language = key.language;
  if (language !== "python" && language !== "rust") continue;
  const root = path.join(CORPUS, key.project);
  const workspace = createWorkspace(root);
  const cache = newCheckCache(workspace);
  const pool = liveRefereePool(() => Date.now() + 120_000);

  for (const claim of key.claims) {
    if (claim.word !== "calls") continue;
    let board;
    try { board = await plantedBoard(key, claim); } catch { continue; }

    const plain = checkDrift(board, workspace, { edges: true, cache });
    if ((plain.claims.callsNotClosed.receiver ?? 0) === 0) continue;

    const asked: { file: string; at: { start: number; end: number } }[] = [];
    const answered: string[] = [];
    const watch = (inner?: ClosedBodyReferee): ClosedBodyReferee => ({
      resolveReceiver: (file, at) => {
        const got = inner?.resolveReceiver(file, at);
        if (languageOf(file) === language) {
          asked.push({ file, at });
          if (got !== undefined) answered.push(`${file}:${at.start}`);
        }
        return got;
      },
      declarationAt: (file, at) => inner?.declarationAt?.(file, at),
    });

    const live = await refereedCheckLive(root, (referee) =>
      checkDrift(board, workspace, { edges: true, cache, closedBodyReferee: watch(referee) }),
      { budgetMs: 120_000, pool });

    const still = live.report.claims.callsNotClosed.receiver ?? 0;
    if (still === 0) continue;
    const unanswered = asked.filter((one) => !answered.includes(`${one.file}:${one.at.start}`));
    console.log(`  ${key.project}/${key.topic} · @calls ${claim.from} -> ${claim.to}`);
    console.log(`    ${live.checkedWith.answered.length > 0 ? refereeSentence(live.checkedWith) : "NO SERVER ANSWERED"}`);
    console.log(`    receivers asked ${asked.length}, answered ${answered.length}, still unanswered ${unanswered.length}`);
    for (const one of unanswered.slice(0, 4)) console.log(`      ${one.file} @${one.at.start}`);
  }
  pool.close();
}
console.log();
