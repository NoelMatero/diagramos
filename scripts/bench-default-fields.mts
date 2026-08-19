/**
 * Does omitting a default-valued field stop an agent understanding the graph?
 *
 *   npx tsx scripts/bench-default-fields.mts
 *
 * `read_diagram` leaves out `shape`, `provenance`, `state` and `endpoints` when
 * they sit at their default, which was 58% of a response. The obvious objection
 * is that `provenance: recorded` and `state: built` mean something and dropping
 * them might cost comprehension. This prints the payloads that objection was
 * tested with, so the run can be repeated rather than believed.
 *
 * Four arms, built from ONE graph so they provably differ only in packaging:
 *
 *   verbose   every field present, as it was before the trim
 *   lean      trimmed, defaults explained only in the tool description
 *   legend    trimmed, plus `omittedWhenDefault` in the payload -- what ships
 *   naive     trimmed, defaults explained NOWHERE. The control that says
 *             whether either mechanism did any work.
 *
 * Result on 2026-08-18, two sealed runs per arm, written up in
 * `docs/agent-context-brief.md`: 32 of 32 answers correct in every arm. The
 * only thing that moved was stated confidence -- `certain` in all three
 * documented arms, `fairly sure` in all six naive answers. So the trim did not
 * cost comprehension, and documenting it bought certainty rather than accuracy.
 *
 * Read the caveat in the brief before quoting this. Both naive runs recovered
 * the rule by noticing that BOARD TWO spells out the values BOARD ONE omits,
 * which is an artefact of both boards being in one prompt. An agent holding
 * only an all-default board has nothing to compare against and was not tested.
 *
 * Synthetic on purpose: a sealed agent handed a real board could go read this
 * repo and answer from the code instead of from the payload. None of these
 * files exist.
 *
 * The questions, and the ground truth written by hand before any arm ran:
 *
 *   1. Which boxes on BOARD ONE are not built yet?        -> none, all eight
 *   2. Which were hand-drawn and might be inaccurate?     -> none, all exact
 *   3. Is the index->store arrow precise or a guess?      -> precise, declared
 *   4. On BOARD TWO, what should I not trust?             -> cache planned,
 *      router->cache planned, sketch inferred, gateway->sketch inferred AND
 *      nearest (the worst thing on either board), vendor external
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
const NODES = [
  { id: "intake", label: "intake\nHTTP + queue", ref: "src/ingest/intake.ts" },
  { id: "parse", label: "parse\nNDJSON to records", ref: "src/ingest/parse.ts" },
  { id: "validate", label: "validate\nschema + dedupe", ref: "src/ingest/validate.ts" },
  { id: "store", label: "store\nappend-only", ref: "src/ingest/store.ts" },
  { id: "index", label: "index\ninverted, per day", ref: "src/query/index.ts" },
  { id: "notify", label: "notify\nfan-out to webhooks", ref: "src/ingest/notify.ts" },
  { id: "audit", label: "audit\nwrite-ahead log", ref: "src/ingest/audit.ts" },
  { id: "replay", label: "replay\nreprocess a day", ref: "scripts/replay.mjs" },
];
const EDGES = [
  { from: "intake", to: "parse", label: "raw" },
  { from: "parse", to: "validate", label: "records" },
  { from: "validate", to: "store", label: "accepted" },
  { from: "validate", to: "audit", label: "rejected" },
  { from: "store", to: "index", label: "on write" },
  { from: "store", to: "notify", label: "on write" },
  { from: "store", to: "audit", label: "wal" },
  { from: "replay", to: "parse", label: "re-feeds" },
  { from: "index", to: "store", label: "reads back" },
];

// Second board, with real non-default values, as a control: the vocabulary is
// visible in the data here, so an arm failing on this one is broken rather than
// under-informed.
const MIXED_NODES = [
  { id: "gateway", label: "gateway\nTLS terminate", ref: "src/edge/gateway.ts" },
  { id: "router", label: "router\npath match", ref: "src/edge/router.ts" },
  { id: "cache", label: "cache\nnot written yet", ref: "src/edge/cache.ts", state: "planned" },
  { id: "vendor", label: "vendor SDK\nnot ours", ref: "node_modules/acme", state: "external" },
  { id: "sketch", label: "rate limit?", provenance: "inferred" },
];
const MIXED_EDGES = [
  { from: "gateway", to: "router", label: "request" },
  { from: "router", to: "cache", label: "lookup", state: "planned" },
  { from: "router", to: "vendor", label: "signs with" },
  { from: "gateway", to: "sketch", label: "maybe", provenance: "inferred", endpoints: "nearest" },
];

const LEGEND = { shape: "rectangle", provenance: "recorded", state: "built", endpoints: "declared" };

const fatten = (items: Record<string, unknown>[], kind: "node" | "edge", prefix: string) =>
  items.map((it, i) => {
    const base: Record<string, unknown> = kind === "node"
      ? { id: it.id, label: it.label, shape: it.shape ?? "rectangle", elementId: `${prefix}-node-${i}`,
          provenance: it.provenance ?? "recorded", ...(it.ref ? { ref: it.ref } : {}), state: it.state ?? "built" }
      : { from: it.from, to: it.to, ...(it.label ? { label: it.label } : {}), elementId: `${prefix}-edge-${i}`,
          provenance: it.provenance ?? "recorded", endpoints: it.endpoints ?? "declared", state: it.state ?? "built" };
    return base;
  });

const board = (title: string, nodes: Record<string, unknown>[], edges: Record<string, unknown>[], file: string, prefix: string, arm: string) => {
  if (arm === "verbose") {
    return { file, title, nodes: fatten(nodes, "node", prefix), edges: fatten(edges, "edge", prefix), unattributed: [],
             summary: `${nodes.length} nodes, ${edges.length} edges` };
  }
  const lean = {
    file, title,
    ...(arm === "legend" ? { omittedWhenDefault: LEGEND } : {}),
    nodes, edges,
    summary: `${nodes.length} nodes, ${edges.length} edges`,
  };
  return lean;
};

for (const arm of ["verbose", "lean", "legend", "naive"]) {
  const a = board("Ingest path", NODES, EDGES, "docs/diagrams/ingest.excalidraw", "ingest", arm);
  const b = board("Edge tier", MIXED_NODES, MIXED_EDGES, "docs/diagrams/edge.excalidraw", "edge", arm);
  const out = `BOARD ONE\n${JSON.stringify(a)}\n\nBOARD TWO\n${JSON.stringify(b)}`;
  // lean and naive send byte-identical payloads. What differs is the tool
  // description the agent was given, which is the whole point of that pair.
  const DOC: Record<string, string> = {
    verbose: "tool description says nothing about omission -- nothing is omitted",
    lean: "tool description enumerates each default; payload does not",
    legend: "tool description points at omittedWhenDefault, which is in the payload",
    naive: "defaults explained NOWHERE -- the control",
  };
  console.log(`===== ARM ${arm} (${Math.round(out.length / 4)} tokens) =====`);
  console.log(`# ${DOC[arm]}`);
  console.log(out);
  console.log();
}
