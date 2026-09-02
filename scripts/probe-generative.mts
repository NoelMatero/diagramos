#!/usr/bin/env node
/**
 * Can a session actually say what it means, with the words that exist?
 *
 *   npm run probe:generative
 *
 * Probe D of #187, and the only one that measures the vocabulary directly rather
 * than inferring it from artefacts. Everything else counts what is already on
 * disk. This draws new boards of code no board here has ever described, and asks
 * two questions of each arrow:
 *
 *   - **could it be claimed at all?** The relation an arrow means either has one
 *     of the four words or it does not, and the second case is the whole of #190.
 *   - **when it was claimed, did the claim hold?** A red on an arrow drawn by
 *     somebody who read the code is the failure that costs trust.
 *
 * ## Why the boards are written down here rather than drawn by an agent
 *
 * The graphs below were authored by reading each scope -- the public types, the
 * signatures, the fields -- and drawing what somebody wanting to understand that
 * code would want on a wall. They are checked in, so this run is reproducible and
 * the boards can be argued with; a probe whose input is regenerated each time
 * measures the weather.
 *
 * This makes the claim rate an **upper bound**, and it should be read as one.
 * The author had the vocabulary open and was looking for chances to use it,
 * which is the best case and not the average one. The finding that survives is
 * the one that goes the other way: where even an author trying to claim could
 * not, because there is no word.
 *
 * ## `wants`
 *
 * Every arrow records the relation it actually means, from #190's layer 2, next
 * to the claim it was able to carry. That is the measurement: `wants: "contains"`
 * with no claim is a sentence the tool cannot say.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace } from "../src/engine/drift";
import { emptyBoard } from "../src/engine/board-file";
import { initEngine } from "../src/engine/parse";
import { surveyScope } from "../src/engine/survey";

const HOME = process.env.HOME ?? "/Users/noelmatero";
const CORPUS = [
  `${HOME}/board-ai/.claude/worktrees/96-rust/.corpus`,
  `${process.cwd()}/.claude/worktrees/96-rust/.corpus`,
].find((candidate) => existsSync(candidate)) ?? "";

type Claim = "needs" | "feeds" | "takes" | "returns" | "holds";

interface Arrow {
  from: string;
  to: string;
  label?: string;
  /** The relation this arrow means, from #190 layer 2. Recorded whether or not a word exists. */
  wants: string;
  /** The word it was able to carry, if any. */
  claim?: Claim;
}

interface Board {
  name: string;
  language: string;
  root: string;
  /** The scope, for the surveyed board drawn beside this one. */
  scope: string;
  nodes: Array<{ id: string; label: string; ref?: string }>;
  edges: Arrow[];
}

/*
 * anyhow -- a small, dense Rust crate. Chosen because Rust is the language the
 * census says is worst covered (11%) and the one the trouble keeps surfacing in.
 */
const ANYHOW: Board = {
  name: "anyhow (rust)",
  language: "rust",
  root: `${CORPUS}/dtolnay-anyhow`,
  scope: "src",
  nodes: [
    { id: "error", label: "Error", ref: "src/lib.rs#Error" },
    { id: "chain", label: "Chain", ref: "src/lib.rs#Chain" },
    { id: "error-impl", label: "ErrorImpl", ref: "src/error.rs#ErrorImpl" },
    { id: "context-error", label: "ContextError", ref: "src/error.rs#ContextError" },
    { id: "new", label: "Error::new", ref: "src/error.rs#new" },
    { id: "msg", label: "Error::msg", ref: "src/error.rs#msg" },
    { id: "context", label: "Error::context", ref: "src/error.rs#context" },
    { id: "chain-of", label: "Error::chain", ref: "src/error.rs#chain" },
    { id: "chain-new", label: "Chain::new", ref: "src/chain.rs#new" },
    { id: "adhoc", label: "Adhoc", ref: "src/kind.rs#Adhoc" },
    { id: "adhoc-new", label: "Adhoc::new", ref: "src/kind.rs#new" },
    { id: "message-error", label: "MessageError", ref: "src/wrapper.rs#MessageError" },
    { id: "own", label: "Own<T>", ref: "src/ptr.rs#Own" },
  ],
  edges: [
    // The four words, used wherever they are true.
    { from: "error", to: "adhoc-new", claim: "returns", wants: "produces", label: "builds" },
    { from: "chain", to: "chain-of", claim: "returns", wants: "produces" },
    { from: "error", to: "new", claim: "returns", wants: "produces", label: "-> Self" },
    { from: "error", to: "msg", claim: "returns", wants: "produces", label: "-> Self" },
    { from: "error", to: "context", claim: "returns", wants: "produces", label: "-> Self" },
    // A type holding another type. No word.
    { from: "error", to: "error-impl", claim: "holds", wants: "contains", label: "one field" },
    { from: "error-impl", to: "own", claim: "holds", wants: "contains", label: "vtable" },
    { from: "chain", to: "chain-new", claim: "returns", wants: "produces" },
    { from: "context-error", to: "error", claim: "holds", wants: "contains", label: "error field" },
    // A routine building a value. No word.
    { from: "msg", to: "message-error", wants: "constructs", label: "wraps" },
    { from: "context", to: "context-error", wants: "constructs", label: "wraps" },
    { from: "adhoc", to: "adhoc-new", wants: "invokes", label: "kind dispatch" },
    // A routine calling a routine. No word.
    { from: "chain-of", to: "chain-new", wants: "invokes", label: "calls" },
  ],
};

/*
 * query-core -- TypeScript, and the language with the largest field population
 * in the census. Every `#queryCache: QueryCache` here is the relation #188 is
 * about.
 */
const QUERY_CORE: Board = {
  name: "query-core (ts)",
  language: "ts",
  root: `${CORPUS}/TanStack-query`,
  scope: "packages/query-core/src",
  nodes: [
    { id: "client", label: "QueryClient", ref: "packages/query-core/src/queryClient.ts#QueryClient" },
    { id: "cache", label: "QueryCache", ref: "packages/query-core/src/queryCache.ts#QueryCache" },
    { id: "mutation-cache", label: "MutationCache", ref: "packages/query-core/src/mutationCache.ts#MutationCache" },
    { id: "query", label: "Query", ref: "packages/query-core/src/query.ts#Query" },
    { id: "query-state", label: "QueryState", ref: "packages/query-core/src/query.ts#QueryState" },
    { id: "query-store", label: "QueryStore", ref: "packages/query-core/src/queryCache.ts#QueryStore" },
    { id: "observer", label: "QueryObserver", ref: "packages/query-core/src/queryObserver.ts#QueryObserver" },
    { id: "retryer", label: "Retryer", ref: "packages/query-core/src/retryer.ts#Retryer" },
    { id: "create-retryer", label: "createRetryer", ref: "packages/query-core/src/retryer.ts#createRetryer" },
    { id: "get-cache", label: "getQueryCache", ref: "packages/query-core/src/queryClient.ts#getQueryCache" },
    { id: "add", label: "QueryCache.add", ref: "packages/query-core/src/queryCache.ts#add" },
    { id: "subscribable", label: "Subscribable", ref: "packages/query-core/src/subscribable.ts#Subscribable" },
    { id: "removable", label: "Removable", ref: "packages/query-core/src/removable.ts#Removable" },
  ],
  edges: [
    // Fields. The most ordinary thing on this board, and none of it can be said.
    { from: "cache", to: "client", claim: "holds", wants: "contains", label: "#queryCache" },
    { from: "mutation-cache", to: "client", claim: "holds", wants: "contains", label: "#mutationCache" },
    { from: "cache", to: "query", claim: "holds", wants: "contains", label: "#cache" },
    { from: "client", to: "query", claim: "holds", wants: "contains", label: "#client" },
    { from: "query-state", to: "query", claim: "holds", wants: "contains", label: "state" },
    { from: "query-store", to: "cache", claim: "holds", wants: "contains", label: "#queries" },
    { from: "retryer", to: "query", claim: "holds", wants: "contains", label: "#retryer" },
    // Inheritance. Also no word.
    { from: "subscribable", to: "cache", wants: "conforms", label: "extends" },
    { from: "removable", to: "query", wants: "conforms", label: "extends" },
    // What the vocabulary does cover.
    { from: "cache", to: "get-cache", claim: "returns", wants: "produces" },
    { from: "query", to: "add", claim: "takes", wants: "accepts" },
    { from: "retryer", to: "create-retryer", claim: "returns", wants: "produces" },
    { from: "observer", to: "query", wants: "accesses", label: "observers" },
  ],
};

/*
 * A React component tree, in tsx. Included because #187 requires tsx and because
 * a UI board is the shape a vocabulary built out of types is least likely to fit.
 */
const DROPDOWN: Board = {
  name: "dropdownMenu (tsx)",
  language: "tsx",
  root: `${CORPUS}/excalidraw-excalidraw`,
  scope: "packages/excalidraw/components/dropdownMenu",
  nodes: [
    { id: "menu", label: "DropdownMenu", ref: "packages/excalidraw/components/dropdownMenu/DropdownMenu.tsx#DropdownMenu" },
    { id: "content", label: "MenuContent", ref: "packages/excalidraw/components/dropdownMenu/DropdownMenuContent.tsx#MenuContent" },
    { id: "trigger", label: "MenuTrigger", ref: "packages/excalidraw/components/dropdownMenu/DropdownMenuTrigger.tsx" },
    { id: "group", label: "MenuGroup", ref: "packages/excalidraw/components/dropdownMenu/DropdownMenuGroup.tsx#MenuGroup" },
    { id: "item", label: "DropdownMenuItem", ref: "packages/excalidraw/components/dropdownMenu/DropdownMenuItem.tsx#DropdownMenuItem" },
    { id: "item-props", label: "DropdownMenuItemProps", ref: "packages/excalidraw/components/dropdownMenu/DropdownMenuItem.tsx#DropdownMenuItemProps" },
    { id: "checkbox", label: "ItemCheckbox", ref: "packages/excalidraw/components/dropdownMenu/DropdownMenuItemCheckbox.tsx#DropdownMenuItemCheckbox" },
    { id: "link", label: "ItemLink", ref: "packages/excalidraw/components/dropdownMenu/DropdownMenuItemLink.tsx" },
    { id: "sub", label: "MenuSub", ref: "packages/excalidraw/components/dropdownMenu/DropdownMenuSub.tsx" },
    { id: "badge", label: "ItemBadge", ref: "packages/excalidraw/components/dropdownMenu/DropdownMenuItem.tsx#DropDownMenuItemBadge" },
    { id: "utils", label: "dropdownMenuUtils", ref: "packages/excalidraw/components/dropdownMenu/dropdownMenuUtils.ts" },
    { id: "common", label: "common", ref: "packages/excalidraw/components/dropdownMenu/common.ts" },
  ],
  edges: [
    // A component rendering another component. There is no relation for this at
    // all in #190's layer 2, let alone a word -- and it is most of any UI board.
    { from: "menu", to: "content", wants: "renders", label: "renders" },
    { from: "menu", to: "trigger", wants: "renders", label: "renders" },
    { from: "content", to: "group", wants: "renders", label: "renders" },
    { from: "group", to: "item", wants: "renders", label: "renders" },
    { from: "item", to: "badge", wants: "renders", label: "renders" },
    { from: "sub", to: "content", wants: "renders", label: "renders" },
    // Props: a type a component accepts. `takes` is exactly this.
    { from: "item-props", to: "item", claim: "takes", wants: "accepts", label: "props" },
    { from: "item-props", to: "checkbox", claim: "takes", wants: "accepts", label: "props" },
    // Imports.
    { from: "common", to: "content", claim: "needs", wants: "depends" },
    { from: "utils", to: "content", claim: "needs", wants: "depends" },
    { from: "item", to: "checkbox", claim: "needs", wants: "depends" },
    { from: "item", to: "link", claim: "needs", wants: "depends" },
  ],
};

/*
 * graphify -- Python, which #190 already flags as having no licence. The survey
 * refuses this scope outright, so this board could only ever be drawn by hand.
 */
const GRAPHIFY: Board = {
  name: "graphify (python)",
  language: "python",
  root: `${HOME}/board-ai/graphify`,
  scope: "graphify",
  nodes: [
    { id: "build", label: "build", ref: "graphify/build.py" },
    { id: "extract", label: "extract", ref: "graphify/extract.py" },
    { id: "detect", label: "detect", ref: "graphify/detect.py" },
    { id: "file-type", label: "FileType", ref: "graphify/detect.py#FileType" },
    { id: "file-slice", label: "FileSlice", ref: "graphify/file_slice.py#FileSlice" },
    { id: "affected-hit", label: "AffectedHit", ref: "graphify/affected.py#AffectedHit" },
    { id: "affected", label: "affected", ref: "graphify/affected.py" },
    { id: "dedup", label: "dedup", ref: "graphify/dedup.py" },
    { id: "cache", label: "cache", ref: "graphify/cache.py" },
    { id: "manifest", label: "manifest", ref: "graphify/manifest.py" },
    { id: "engine", label: "extractors/engine", ref: "graphify/extractors/engine.py" },
  ],
  edges: [
    { from: "detect", to: "extract", claim: "needs", wants: "depends" },
    { from: "extract", to: "build", claim: "needs", wants: "depends" },
    { from: "engine", to: "extract", claim: "needs", wants: "depends" },
    { from: "cache", to: "build", claim: "needs", wants: "depends" },
    { from: "manifest", to: "build", claim: "needs", wants: "depends" },
    { from: "dedup", to: "build", claim: "needs", wants: "depends" },
    // Fields on a frozen dataclass: the Python spelling of the #188 relation.
    { from: "file-slice", to: "extract", claim: "holds", wants: "contains", label: "path, start, end" },
    { from: "file-type", to: "detect", claim: "holds", wants: "contains", label: "enum" },
    { from: "affected-hit", to: "affected", claim: "holds", wants: "contains", label: "node_id, depth" },
    // Flow.
    { from: "extract", to: "dedup", wants: "flows", label: "nodes, edges" },
    { from: "dedup", to: "build", wants: "flows", label: "deduped" },
  ],
};

const BOARDS = [ANYHOW, QUERY_CORE, DROPDOWN, GRAPHIFY];

/** Which relations have a word at all. Everything else is the point of #190. */
const HAS_A_WORD: Record<string, Claim | undefined> = {
  depends: "needs",
  flows: "feeds",
  accepts: "takes",
  produces: "returns",
  contains: "holds",
  conforms: undefined,
  invokes: undefined,
  accesses: undefined,
  constructs: undefined,
  renders: undefined,
};

await initEngine();

if (!CORPUS || !existsSync(CORPUS)) {
  console.log("The #96 corpus is not on disk; nothing foreign to draw. Skipped.");
  process.exit(0);
}

const totals = {
  arrows: 0, claimed: 0, confirmed: 0, red: 0, withheld: 0,
  couldClaim: 0, noWord: 0, boxes: 0, boxesStale: 0,
};
const wanted = new Map<string, { arrows: number; claimed: number; red: number }>();
const reds: string[] = [];

console.log();
console.log("D · GENERATIVE PROBE -- boards drawn of code no board here has described");
console.log();

for (const board of BOARDS) {
  if (!existsSync(board.root)) {
    console.log(`  ${board.name.padEnd(22)} root not on disk, skipped`);
    continue;
  }
  const workspace = createWorkspace(board.root);

  const built = await createDiagram(emptyBoard(), {
    title: board.name,
    nodes: board.nodes,
    edges: board.edges.map((edge) => ({
      from: edge.from, to: edge.to, label: edge.label, claim: edge.claim,
    })),
  });
  const probe = `${board.root}/.generative-probe.excalidraw`;
  writeFileSync(probe, JSON.stringify(built.board, null, 2));
  const report = checkDrift(JSON.parse(readFileSync(probe, "utf8")), workspace, { edges: true });
  rmSync(probe);

  const claimed = board.edges.filter((edge) => edge.claim).length;
  const couldClaim = board.edges.filter((edge) => HAS_A_WORD[edge.wants]).length;
  const red = report.edges.filter((finding) =>
    finding.kind === "backwards-edge" || finding.kind === "signature-absent").length;
  const held = Object.values(report.claims.signatureWithheld ?? {})
    .concat(Object.values(report.claims.needsWithheld ?? {}))
    .reduce<number>((sum, value) => sum + Number(value), 0);
  const stale = report.findings.length;

  totals.arrows += board.edges.length;
  totals.claimed += claimed;
  totals.couldClaim += couldClaim;
  totals.noWord += board.edges.length - couldClaim;
  totals.confirmed += report.claims.signatureConfirmed + report.claims.needsChecked;
  totals.red += red;
  totals.withheld += held;
  totals.boxes += board.nodes.length;
  totals.boxesStale += stale;

  for (const edge of board.edges) {
    const row = wanted.get(edge.wants) ?? { arrows: 0, claimed: 0, red: 0 };
    row.arrows += 1;
    if (edge.claim) row.claimed += 1;
    wanted.set(edge.wants, row);
  }
  for (const finding of report.edges) {
    if (finding.kind !== "backwards-edge" && finding.kind !== "signature-absent") continue;
    reds.push(`  ${board.name}: ${finding.fromLabel.replace(/\s+/g, " ")} -> `
      + `${finding.toLabel.replace(/\s+/g, " ")}\n      ${finding.detail}`);
  }

  // The board the tool's own cheap path would have drawn, for comparison.
  let surveyed = "—";
  try {
    const survey = await surveyScope(board.scope, workspace);
    surveyed = survey.refused
      ? "REFUSED"
      : `${survey.units.length} boxes, ${survey.edges.length} arrows, `
        + `${survey.edges.filter((edge) => edge.claim).length} needs`;
  } catch (error) {
    surveyed = `failed: ${(error as Error).message}`;
  }

  console.log(`  ${board.name}`);
  console.log(`      authored : ${board.nodes.length} boxes, ${board.edges.length} arrows, `
    + `${claimed} claimed (${((claimed / board.edges.length) * 100).toFixed(0)}%), `
    + `${couldClaim} had a word available`);
  console.log(`      verdicts : ${report.claims.signatureConfirmed + report.claims.needsChecked} confirmed, `
    + `${red} red, ${held} withheld, ${stale} box findings`);
  console.log(`      surveyed : ${surveyed}`);
  console.log();
}

console.log("  WHAT THE ARROWS MEANT, and whether a word existed for it");
console.log("    " + "relation".padEnd(14) + "arrows".padStart(8) + "claimed".padStart(9) + "  word");
for (const [relation, row] of [...wanted.entries()].sort((a, b) => b[1].arrows - a[1].arrows)) {
  console.log("    " + relation.padEnd(14) + String(row.arrows).padStart(8)
    + String(row.claimed).padStart(9) + "  " + (HAS_A_WORD[relation] ? `@${HAS_A_WORD[relation]}` : "— none"));
}
console.log();

if (reds.length > 0) {
  console.log("  REDS -- claims written by an author who had read the code");
  for (const red of reds) console.log(red);
  console.log();
}

const pc = (part: number, whole: number) => whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(0)}%`;
console.log("  TOTAL");
console.log(`    ${totals.boxes} boxes, ${totals.arrows} arrows across ${BOARDS.length} boards`);
console.log(`    ${totals.claimed} arrows carried a claim (${pc(totals.claimed, totals.arrows)})`);
console.log(`    ${totals.noWord} arrows meant something with no word at all `
  + `(${pc(totals.noWord, totals.arrows)})`);
console.log(`    ${totals.confirmed} confirmed, ${totals.red} red, ${totals.withheld} withheld`);
console.log(`    ${totals.boxesStale} box findings -- refs the author got wrong, not vocabulary gaps`);
console.log();
