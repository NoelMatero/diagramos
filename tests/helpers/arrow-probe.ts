/**
 * A tiny repository, one board of arrows over it, and each arrow's verdict --
 * checked the way the MCP server checks a board (`refereedCheckLive` over
 * `checkDrift`), or with every compiler switched off.
 *
 * The harness #373's probes used, kept here so the shapes they found can stay
 * tests (#393).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { emptyBoard, type BoardFile } from "../../src/engine/board-file";
import { createDiagram } from "../../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type ClosedBodyReferee, type DriftReport } from "../../src/engine/drift";
import { refereedCheckLive } from "../../src/engine/referee-live";

/** Whether rust-analyzer really runs here. CI's rustup proxy exits at once. */
export const hasRustAnalyzer = (() => {
  try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

/** One arrow: `[from ref, to ref, claim]`, and the label an `accesses` arrow names its member with. */
export type Arrow = [from: string, to: string, claim: string, label?: string];

/** What one arrow came back as: its accusing kinds (empty when none) and why it went unconfirmed, if it did. */
export interface ArrowVerdict {
  reds: string[];
  unconfirmed?: string;
}

/**
 * A fresh repository outside the worktree -- a scratch source file inside one
 * is read by the dependency tests as though it belonged to this repository.
 */
export function scratchRepo(files: Record<string, string>, prefix = "arrow-probe-"): string {
  const repo = mkdtempSync(path.join(tmpdir(), prefix));
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return repo;
}

export function dropRepo(repo: string): void {
  rmSync(repo, { recursive: true, force: true });
}

/**
 * Every arrow's verdict. `compiler: false` runs `checkDrift` once with no
 * referee at all, which is a user with no compiler installed, or CI.
 */
export async function verdicts(
  repo: string,
  arrows: Arrow[],
  options: { compiler?: boolean } = {},
): Promise<{ each: ArrowVerdict[]; report: DriftReport }> {
  const ids = new Map<string, string>();
  const idOf = (ref: string) => {
    if (!ids.has(ref)) ids.set(ref, `n${ids.size}`);
    return ids.get(ref)!;
  };
  for (const [from, to] of arrows) { idOf(from); idOf(to); }
  const { board } = await createDiagram(emptyBoard(), {
    name: "probe",
    nodes: [...ids].map(([ref, id]) => ({ id, label: ref.split("#").pop()!, ref })),
    edges: arrows.map(([from, to, claim, label]) => ({
      from: idOf(from), to: idOf(to), claim: claim as never, ...(label ? { label } : {}),
    })),
  });
  const workspace = createWorkspace(repo);
  const run = (referee?: ClosedBodyReferee) =>
    checkDrift(board as BoardFile, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) });
  const report = options.compiler === false ? run(undefined) : (await refereedCheckLive(repo, run)).report;
  const each = arrows.map(([from, to]): ArrowVerdict => {
    const node = `${idOf(from)} -> ${idOf(to)}`;
    const reds = report.edges.filter((finding) => finding.node === node && ACCUSES.has(finding.kind)).map((finding) => finding.kind);
    const unconfirmed = report.unconfirmedEdges.find((one) => `${one.from} -> ${one.to}` === node)?.reason;
    return { reds, ...(unconfirmed ? { unconfirmed } : {}) };
  });
  return { each, report };
}

/** One arrow's accusing kinds, for the common one-arrow test. */
export async function redsOf(repo: string, arrow: Arrow, options: { compiler?: boolean } = {}): Promise<string[]> {
  return (await verdicts(repo, [arrow], options)).each[0]!.reds;
}
