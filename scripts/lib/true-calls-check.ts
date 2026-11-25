/**
 * Check "A calls B" arrows that a referee outside the checker says are true,
 * one arrow to a board, exactly the way `bench:planted` checks a claim: the
 * project's libraries in reach, the language servers running, the same budget
 * per arrow (`refereedCheckLive` over `checkDrift`).
 *
 * Shared by the referees whose population the compiler-true measurement does
 * not reach -- calls whose far end is never written at the call:
 * `measure:calls-at-run-time` (calls recorded while a project's own tests
 * ran) and `measure:handed-on` (a function handed to another that calls it,
 * followed one step with the TypeScript compiler's symbols). Every pair is
 * true, so a red is a false accusation.
 */
import { emptyBoard, type BoardFile } from "../../src/engine/board-file";
import { createDiagram } from "../../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, newCheckCache, type DriftReport } from "../../src/engine/drift";
import { initEngine } from "../../src/engine/parse";
import { liveRefereePool, refereedCheckLive } from "../../src/engine/referee-live";

export interface TrueCall {
  from: string;
  to: string;
}

export type CallOutcome = "green" | "not sure" | "red" | "error";

export interface CheckedCall extends TrueCall {
  outcome: CallOutcome;
  /** The red's kind, why it was not confirmed, or the error. */
  reason: string;
  /** The red's sentence, cut to 300 characters. */
  detail?: string;
  /** Which compilers answered this arrow's check, and which were asked and said nothing. */
  answered?: readonly string[];
  silent?: readonly string[];
}

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);
const BUDGET_MS = 120_000;

/** Why the check left an arrow unconfirmed: the reasons it tallied, or the unconfirmed edge's own. */
function whyNotSure(report: DriftReport): string {
  const unconfirmed = report.unconfirmedEdges[0];
  if (unconfirmed && unconfirmed.reason !== "claim-not-checked") return `unconfirmed: ${unconfirmed.reason}`;
  const reasons = Object.entries(report.claims as unknown as Record<string, unknown>)
    .filter(([name]) => name.endsWith("Withheld") || name === "callsNotClosed")
    .filter(([, tally]) => tally && typeof tally === "object" && !Array.isArray(tally))
    .flatMap(([name, tally]) => Object.entries(tally as Record<string, number>)
      .filter(([, n]) => Number(n) > 0)
      .map(([why]) => (name === "callsNotClosed" ? `not-closed ${why}` : why)))
    .sort();
  if (reasons.length > 0) return `declined: ${reasons.join(" + ")}`;
  const unread = report.unreadEdges[0];
  return unread ? `unread: ${unread.reason}` : "nothing said";
}

/** One arrow on a board of its own, as `plantedBoard` draws a claim: the refs as labels. */
async function boardOf(project: string, call: TrueCall): Promise<BoardFile> {
  const built = await createDiagram(emptyBoard(), {
    title: `${project} true calls`,
    nodes: [
      { id: "from", label: call.from.slice(0, 60), ref: call.from },
      { id: "to", label: call.to.slice(0, 60), ref: call.to },
    ],
    edges: [{ from: "from", to: "to", claim: "calls" }],
  });
  return JSON.parse(JSON.stringify(built.board)) as BoardFile;
}

/**
 * Each arrow's verdict, in order. `root` is the project as the bench reads it
 * (`useLibraries`), so the language servers see its libraries.
 */
export async function checkTrueCalls(project: string, root: string, calls: readonly TrueCall[]): Promise<CheckedCall[]> {
  await initEngine();
  const cache = newCheckCache(createWorkspace(root));
  const pool = liveRefereePool(() => Date.now() + BUDGET_MS);
  const out: CheckedCall[] = [];
  try {
    for (const call of calls) {
      try {
        const board = await boardOf(project, call);
        const { report, checkedWith } = await refereedCheckLive(root,
          (referee) => checkDrift(board, cache.workspace, { edges: true, cache, ...(referee ? { closedBodyReferee: referee } : {}) }),
          { budgetMs: BUDGET_MS, pool });
        const edge = report.edges[0];
        const confirmed = Object.entries(report.claims as unknown as Record<string, unknown>)
          .filter(([name]) => name.endsWith("Confirmed"))
          .reduce((sum, [, n]) => sum + Number(n ?? 0), 0);
        const said = { answered: checkedWith.answered, silent: checkedWith.silent };
        if (edge && ACCUSES.has(edge.kind)) {
          out.push({ ...call, outcome: "red", reason: edge.kind, detail: (edge.detail ?? "").slice(0, 300), ...said });
        } else if (edge) {
          out.push({ ...call, outcome: "not sure", reason: `advisory ${edge.kind}`, ...said });
        } else if (confirmed > 0 && report.unconfirmedEdges.length === 0) {
          out.push({ ...call, outcome: "green", reason: "confirmed", ...said });
        } else {
          out.push({ ...call, outcome: "not sure", reason: whyNotSure(report), ...said });
        }
      } catch (error) {
        out.push({ ...call, outcome: "error", reason: String(error).slice(0, 200) });
      }
    }
  } finally {
    pool.close();
  }
  return out;
}
