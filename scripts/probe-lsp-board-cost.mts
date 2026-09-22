#!/usr/bin/env node
/**
 * What a whole Python or Rust board pays for a second opinion (#337 part A).
 *
 *   npm run probe:lsp-board-cost
 *   npm run probe:lsp-board-cost -- --project=pallets-flask
 *
 * Asked of the real bench board, every arrow on it, which is what the MCP
 * server runs on every turn. A one-arrow board flatters the answer: most of
 * them leave the server nothing to do, and a board nobody would draw is not
 * the thing whose cost is in question.
 *
 * Four numbers per board:
 *
 *   plain      the text-only check, what a board gets today
 *   questions  receivers the reader leaves for a server
 *   start      time to a server that will answer, on this tree
 *   harvest    recording pass + batched answers + the real check, end to end
 *
 * All three routes #337 lists pay `start` and one round trip per question. The
 * pre-pass batches the round trips and is the only one already written
 * (`scripts/check-drift.mjs`), so `harvest` is the best case of the three, not
 * an average of them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { checkDrift, createWorkspace, type ClosedBodyReferee } from "../src/engine/drift";
import { initEngine, languageOf } from "../src/engine/parse";
import { refereePool } from "./lib/resolution-definitions";
import type { PyrightLspReferee } from "./lib/resolution-python-lsp";
import type { RustLspReferee } from "./lib/resolution-rust-lsp";
import { resolvePythonReceivers } from "./lib/resolution-python-live";
import { resolveRustReceivers } from "./lib/resolution-rust-receivers";
import { plantedKeys } from "./lib/planted-keys";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CORPUS = process.env.CORPUS ?? "/Users/noelmatero/board-ai/.corpus";

const argv = process.argv.slice(2);
const only = argv.find((a) => a.startsWith("--project="))?.split("=")[1];

await initEngine();

const ms = (run: () => void): number => {
  const started = performance.now();
  run();
  return Math.round(performance.now() - started);
};
const msAsync = async (run: () => Promise<unknown>): Promise<number> => {
  const started = performance.now();
  await run();
  return Math.round(performance.now() - started);
};

console.log();
console.log("#337A · WHAT A WHOLE PYTHON OR RUST BOARD PAYS FOR A SECOND OPINION");
console.log("  the real bench board, every arrow, through the CLI's own resolving path");
console.log();
console.log(`  ${"board".padEnd(34)}${"lang".padEnd(8)}${"plain".padStart(8)}${"questions".padStart(11)}`
  + `${"start".padStart(9)}${"harvest".padStart(10)}`);

for (const key of plantedKeys(REPO)) {
  if (only && key.project !== only) continue;
  const language = key.language;
  if (language !== "python" && language !== "rust") continue;
  const root = path.join(CORPUS, key.project);
  const workspace = createWorkspace(root);
  let board: unknown;
  try {
    board = JSON.parse(readFileSync(path.join(REPO, key.board), "utf8"));
  } catch { continue; }
  const name = `${key.project}/${key.topic}`;

  let plain = 0;
  try {
    plain = ms(() => { checkDrift(structuredClone(board) as never, workspace, { edges: true }); });
  } catch (error) {
    console.log(`  ${name.padEnd(34)}${language.padEnd(8)}  check failed: ${(error as Error).message.slice(0, 50)}`);
    continue;
  }

  const asked: { file: string; at: { start: number; end: number } }[] = [];
  const seen = new Set<string>();
  const recording: ClosedBodyReferee = {
    resolveReceiver: (file, at) => {
      if (languageOf(file) !== language) return undefined;
      const id = `${file}:${at.start}:${at.end}`;
      if (!seen.has(id)) { seen.add(id); asked.push({ file, at }); }
      return undefined;
    },
    declarationAt: () => undefined,
  };
  try {
    checkDrift(structuredClone(board) as never, workspace, { closedBodyReferee: recording });
  } catch { /* the recording pass's report is never read */ }

  if (asked.length === 0) {
    console.log(`  ${name.padEnd(34)}${language.padEnd(8)}${String(plain).padStart(6)}ms`
      + `${"0".padStart(11)}${"-".padStart(9)}${"-".padStart(10)}`);
    continue;
  }

  const pool = refereePool<PyrightLspReferee & RustLspReferee>(Date.now() + 180_000);
  try {
    const resolveOnce = async () => (language === "python"
      ? resolvePythonReceivers(root, asked, pool)
      : resolveRustReceivers(root, asked, undefined, pool));

    let answers: ClosedBodyReferee | undefined;
    const harvest = await msAsync(async () => {
      const resolved = await resolveOnce();
      answers = { resolveReceiver: (file, at) => resolved.cache.get(file, at) };
      checkDrift(structuredClone(board) as never, workspace, { edges: true, closedBodyReferee: answers });
      resolved.close();
    });
    // Again, against a pool that is now warm: the gap is the server start.
    const warm = await msAsync(async () => {
      const resolved = await resolveOnce();
      resolved.close();
    });
    const start = Math.max(0, harvest - warm - plain);
    pool.close();

    console.log(`  ${name.padEnd(34)}${language.padEnd(8)}${String(plain).padStart(6)}ms`
      + `${String(asked.length).padStart(11)}${String(start).padStart(7)}ms${String(harvest).padStart(8)}ms`);
  } catch (error) {
    pool.close();
    console.log(`  ${name.padEnd(34)}${language.padEnd(8)}${String(plain).padStart(6)}ms`
      + `${String(asked.length).padStart(11)}${"failed".padStart(9)}${"".padStart(10)}`
      + `  ${(error as Error).message.slice(0, 50)}`);
  }
}
console.log();
