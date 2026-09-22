#!/usr/bin/env node
/**
 * Why one Python board takes sixteen seconds (#337 part A).
 *
 *   npm run probe:python-slow
 *
 * `probe-lsp-board-cost.mts` found `encode-httpx/client-send` costing 16s of
 * answering where every other Python board costs tens of milliseconds, and the
 * pipe is not the explanation: Rust answers 756 questions over the same kind of
 * pipe in 31ms.
 *
 * The suspect is the retry ladder in `resolution-python-lsp.ts`. A query pyright
 * has no answer for is asked three times, sleeping 300ms and then 800ms in
 * between -- 1.1 seconds spent per *unanswerable* query, which is the opposite
 * of the case worth paying for.
 *
 * So this counts the two populations apart: how many of a board's queries
 * pyright answers, how many it never will, and what each costs.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { checkDrift, createWorkspace, type ClosedBodyReferee } from "../src/engine/drift";
import { initEngine, languageOf } from "../src/engine/parse";
import { createPyrightLspReferee } from "./lib/resolution-python-lsp";
import { plantedKeys } from "./lib/planted-keys";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CORPUS = process.env.CORPUS ?? "/Users/noelmatero/board-ai/.corpus";

const argv = process.argv.slice(2);
const only = argv.find((a) => a.startsWith("--board="))?.split("=")[1] ?? "client-send";

await initEngine();

const key = plantedKeys(REPO).find((k) => k.language === "python" && k.topic === only);
if (!key) { console.error(`no python board called ${only}`); process.exit(1); }

const root = path.join(CORPUS, key.project);
const workspace = createWorkspace(root);
const board = JSON.parse(readFileSync(path.join(REPO, key.board), "utf8"));

/* The same recording pass the real check would run. */
const asked: { file: string; at: { start: number; end: number } }[] = [];
const seen = new Set<string>();
const recording: ClosedBodyReferee = {
  resolveReceiver: (file, at) => {
    if (languageOf(file) !== "python") return undefined;
    const id = `${file}:${at.start}:${at.end}`;
    if (!seen.has(id)) { seen.add(id); asked.push({ file, at }); }
    return undefined;
  },
  declarationAt: () => undefined,
};
try { checkDrift(structuredClone(board), workspace, { closedBodyReferee: recording }); } catch { /* report unread */ }

console.log();
console.log(`#337A · WHERE ${key.project}/${key.topic} SPENDS ITS TIME`);
console.log(`  ${asked.length} receivers the reader could not settle`);
console.log();

const referee = await createPyrightLspReferee(root);
const sources = new Map<string, string>();
const sourceOf = (file: string): string => {
  let text = sources.get(file);
  if (text === undefined) {
    try { text = readFileSync(path.resolve(root, file), "utf8"); } catch { text = ""; }
    sources.set(file, text);
  }
  return text;
};

/*
 * The suspect, timed on its own. `resolvePythonReceivers` warms up at
 * `queries[0]`, whatever that happens to be, and the warm-up ladder is
 * [250, 500, 1000, 2000, 4000, 8000] -- 15.75 seconds if every rung fires,
 * which is what it does when that first position is one pyright will never
 * have an answer for.
 */
const first = asked[0]!;
const warmStarted = performance.now();
await referee.warmUp([{ file: path.resolve(root, first.file), source: sourceOf(first.file), start: first.at.start }]).catch(() => {});
console.log(`  warmUp at queries[0] (${first.file}): ${Math.round(performance.now() - warmStarted)}ms`);
console.log();

/*
 * The same 97 queries at several widths. `resolution-python-live.ts` uses 32,
 * copied from the Rust resolver, and 32 is where the sixteen seconds came from:
 * pyright is single-threaded, so asking it 32 things at once does not make it
 * answer faster, it makes it answer all of them late.
 */
const widths = [1, 4, 8, 16, 32];
console.log(`  ${"at once".padStart(8)}${"total".padStart(10)}${"answered".padStart(10)}`);
for (const width of widths) {
  let cursor = 0;
  let answered = 0;
  const started = performance.now();
  const worker = async (): Promise<void> => {
    for (;;) {
      const query = asked[cursor++];
      if (query === undefined) return;
      const location = await referee.typeDeclarationLocationAt(
        path.resolve(root, query.file), sourceOf(query.file), query.at.start, query.at.end,
      ).catch(() => undefined);
      if (location) answered += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, asked.length) }, worker));
  const took = Math.round(performance.now() - started);
  console.log(`  ${String(width).padStart(8)}${String(took).padStart(8)}ms${String(answered).padStart(10)}`);
}
referee.close();
console.log();
