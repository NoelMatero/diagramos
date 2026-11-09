/**
 * trace.mts <rows.json>: check each listed claim exactly as bench:planted does (same libraries,
 * pool, budget), matched by project + topic + claim id, with WALLS_LOG set by the caller.
 * One JSON line per claim. Copy of ~/bench-why-468/trace-all.mts, rows-driven.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
const REPO = process.env.REPO!;
const { checkDrift, createWorkspace, newCheckCache, ACCUSING_EDGE_KINDS } = await import(path.join(REPO, "src/engine/drift.ts"));
const { liveRefereePool, refereedCheckLive } = await import(path.join(REPO, "src/engine/referee-live.ts"));
const { initEngine } = await import(path.join(REPO, "src/engine/parse.ts"));
const { plantedBoard, plantedKeys } = await import(path.join(REPO, "scripts/lib/planted-keys.ts"));
const { useLibraries } = await import(path.join(REPO, "scripts/lib/bench-libraries.ts"));
await initEngine();
const rows: Array<{ id: number; project: string; topic: string; cid: string }> = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const keys = plantedKeys(REPO);
let current: { project: string; root: string; cache: any; pool: any } | undefined;
for (const want of rows) {
  const key = keys.find((k: any) => k.project === want.project && k.topic === want.topic && k.claims.some((c: any) => c.id === want.cid));
  if (!key) { console.log(JSON.stringify({ id: want.id, missing: true })); continue; }
  const claim = key.claims.find((c: any) => c.id === want.cid);
  if (current?.project !== want.project) {
    current?.pool.close();
    const root = useLibraries(want.project);
    current = { project: want.project, root, cache: newCheckCache(createWorkspace(root)), pool: liveRefereePool(() => Date.now() + 120_000) };
  }
  const board = await plantedBoard(key, claim);
  (globalThis as any).__pass = 0;
  (globalThis as any).__arrow = `${want.id}|${claim.word}|${claim.from}|${claim.to}`;
  const t0 = Date.now();
  const { report } = await refereedCheckLive(current.root,
    (referee: any) => { (globalThis as any).__pass = ((globalThis as any).__pass ?? 0) + 1; return checkDrift(board, current!.cache.workspace, { edges: true, cache: current!.cache, ...(referee ? { closedBodyReferee: referee } : {}) }); },
    { budgetMs: 120_000, pool: current.pool });
  const e = report.edges[0], u = report.unconfirmedEdges[0], r = report.unreadEdges[0];
  const tally = report.claims as Record<string, unknown>;
  const confirmations = Object.entries(tally).filter(([n]) => n.endsWith("Confirmed")).reduce((s2, [, v]) => s2 + Number(v ?? 0), 0) + Number(tally.needsChecked ?? 0);
  const outcome = e && ACCUSING_EDGE_KINDS.includes(e.kind) ? "red" : (e || report.garbledClaims.length || u || r) ? "not sure" : confirmations > 0 ? "green" : "silent";
  console.log(JSON.stringify({ id: want.id, project: want.project, outcome, edge: e?.kind, detail: (e?.detail ?? "").slice(0, 400), unconfirmed: u?.reason, unread: r?.reason,
    passes: (globalThis as any).__pass, ms: Date.now() - t0,
    withheld: Object.fromEntries(Object.entries(report.claims as any).filter(([k]) => k.endsWith("Withheld") || k.endsWith("NotClosed")).filter(([, v]) => v && Object.keys(v as object).length)) }));
}
current?.pool.close();
process.exit(0);
