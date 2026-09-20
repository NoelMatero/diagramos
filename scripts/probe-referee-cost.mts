#!/usr/bin/env node
/**
 * What the second opinion costs at draw time (#328).
 *
 *   npm run probe:referee-cost
 *   npm run probe:referee-cost -- --project=TanStack-query
 *
 * The receiver referee asks the TypeScript compiler what a value is, and to
 * answer it has to build a `ts.Program` for the repository. The MCP server
 * checks a board every time Claude draws or edits one, so the question this
 * answers is not whether the check is better -- #324's ranking already said
 * it is -- but what the person waiting for their diagram pays for it.
 *
 * Measured on the pinned corpus rather than on this repository, because a
 * program build scales with the tree and this repository is small. Four
 * numbers per project, each one a real `@calls` board checked end to end:
 *
 *   plain     the check as it ran before, no referee
 *   cold      the first check of the process, which pays the program build
 *   warm      every check after that, which does not
 *   guarded   what `refereedCheck` actually does: one plain pass, then the
 *             referee only if that pass left an arrow unsettled
 *
 * `warm` is what a session costs after the first board. `cold` is paid once,
 * by whichever board is drawn first, and only when that board has an arrow a
 * second opinion could change.
 */
import path from "node:path";

import { checkDrift, createWorkspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { createClosedBodyReferee, refereedCheck } from "../src/engine/referee";
import { plantedBoard, plantedKeys } from "./lib/planted-keys";

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

/** One `@calls` board per project -- the word the referee exists for. */
const picks = new Map<string, ReturnType<typeof plantedKeys>[number]>();
for (const key of plantedKeys(REPO)) {
  if (only && key.project !== only) continue;
  if (picks.has(key.project)) continue;
  if (!key.claims.some((c) => c.word === "calls" && c.language !== "python" && c.language !== "rust")) continue;
  picks.set(key.project, key);
}

console.log();
console.log("#328 · WHAT THE RECEIVER REFEREE COSTS AT DRAW TIME");
console.log("  one planted @calls board per project, checked four ways");
console.log();
console.log(`  ${"project".padEnd(22)}${"build".padStart(8)}${"plain".padStart(8)}${"cold".padStart(8)}`
  + `${"warm".padStart(8)}${"guarded".padStart(9)}`);

for (const [project, key] of picks) {
  const claim = key.claims.find((c) => c.word === "calls" && c.language !== "python" && c.language !== "rust");
  if (!claim) continue;
  const root = path.join(CORPUS, project);
  const board = await plantedBoard(key, claim);
  const workspace = createWorkspace(root);

  const plain = ms(() => { checkDrift(structuredClone(board), workspace, { edges: true }); });
  // Built here, per project, so the number below is this tree's build and not
  // one left warm by the project before it.
  let referee: ReturnType<typeof createClosedBodyReferee>;
  const build = ms(() => { referee = createClosedBodyReferee(root); });
  const ask = (r: ReturnType<typeof createClosedBodyReferee>): void => {
    checkDrift(structuredClone(board), workspace, { edges: true, ...(r ? { closedBodyReferee: r } : {}) });
  };
  const cold = ms(() => { ask(referee); });
  const warm = ms(() => { ask(referee); });
  const guarded = ms(() => {
    refereedCheck(root, (r) => checkDrift(structuredClone(board), workspace, {
      edges: true, ...(r ? { closedBodyReferee: r } : {}),
    }));
  });

  console.log(`  ${project.padEnd(22)}${String(build).padStart(6)}ms${String(plain).padStart(6)}ms`
    + `${String(cold).padStart(6)}ms${String(warm).padStart(6)}ms${String(guarded).padStart(7)}ms`);
}
console.log();
