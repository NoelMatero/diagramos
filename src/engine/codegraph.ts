/**
 * Code graph channel: a precomputed whole-repo graph of code relations.
 *
 * Built at commit time by graphify (`scripts/refresh-code-graph.mjs`), read at
 * check time as plain JSON. No model, no subprocess, nothing non-deterministic
 * in the check path: the same graph and the same question always give the same
 * answer.
 *
 * False positives are worse than silence, so the channel only ever *confirms*
 * arrows. A gap in the graph, a stale graph, a version we have not tested, a
 * file the extractor missed -- all of it means silence, identical to the
 * checker without this channel.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** The shape we require of graphify's NetworkX node-link export. */
interface CodeGraphSchema {
  nodes?: Array<{ id?: unknown; source_file?: unknown }>;
  links?: Array<{
    source?: unknown;
    target?: unknown;
    relation?: unknown;
    confidence?: unknown;
  }>;
}

export interface LoadedCodeGraph {
  /** source_file -> every node extracted from that file (the file node and its symbols). */
  nodesByFile: Map<string, string[]>;
  /** node id -> node ids it points at, over whitelisted EXTRACTED edges only. */
  forward: Map<string, Set<string>>;
}

/** The graph plus which files have changed since it was built. */
export interface CodeGraphOption {
  graph: LoadedCodeGraph;
  modified: Set<string>;
}

/**
 * The graphify versions this channel has been tested against. Anything else
 * turns the channel off: a new major or minor release may change what the
 * extractor emits, and we bump this deliberately, after re-testing that a
 * rebuild on the same tree is byte-identical.
 *
 * Exported because the builder asks before it spends anything: a graph this
 * loader would refuse is not worth the seconds it takes to make.
 */
export const TESTED_VERSION_PREFIX = "0.9.";

/**
 * Relations that count as a hop. Each is a claim the extractor read directly
 * from source (we additionally require EXTRACTED confidence): a call, an
 * import, a re-export, a dynamic import. Everything else -- `contains`,
 * `references`, `extends`, anything INFERRED -- is not evidence that code
 * reaches code, and never travels.
 */
const WHITELISTED_RELATIONS = new Set([
  "calls",
  "imports",
  "imports_from",
  "re_exports",
  "dynamic_import",
]);

/** How many hops a chain may take between the two endpoint sets. */
const MAX_HOPS = 3;

/**
 * Parse and validate a graphify export.
 *
 * Returns undefined -- channel off -- when the version is untested or the
 * shape is not what we know how to read. Validation is strict on purpose:
 * a graph we half-understand is a graph we might confirm the wrong arrow with.
 */
export function loadCodeGraph(
  graph: CodeGraphSchema,
  graphifyVersion: string,
): LoadedCodeGraph | undefined {
  if (typeof graphifyVersion !== "string" || !graphifyVersion.startsWith(TESTED_VERSION_PREFIX)) {
    return undefined;
  }
  if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.links)) return undefined;

  const nodesByFile = new Map<string, string[]>();
  const known = new Set<string>();
  for (const node of graph.nodes) {
    if (typeof node?.id !== "string" || typeof node?.source_file !== "string") {
      return undefined;
    }
    known.add(node.id);
    const list = nodesByFile.get(node.source_file);
    if (list) list.push(node.id);
    else nodesByFile.set(node.source_file, [node.id]);
  }

  const forward = new Map<string, Set<string>>();
  for (const edge of graph.links) {
    if (
      typeof edge?.source !== "string"
      || typeof edge?.target !== "string"
      || typeof edge?.relation !== "string"
      || typeof edge?.confidence !== "string"
    ) {
      return undefined;
    }
    if (!WHITELISTED_RELATIONS.has(edge.relation) || edge.confidence !== "EXTRACTED") continue;
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    const out = forward.get(edge.source);
    if (out) out.add(edge.target);
    else forward.set(edge.source, new Set([edge.target]));
  }

  return { nodesByFile, forward };
}

/**
 * Whether the code reaches from one endpoint to the other through a chain of
 * at most MAX_HOPS whitelisted edges, all pointing the same way.
 *
 * Direction-consistency is the correctness core, not a nicety. An undirected
 * walk connects nearly everything to nearly everything: two files that both
 * import the same helper meet in the middle (A -> H <- B), and one file that
 * imports both endpoints bridges them (A <- H -> B). Neither is evidence that
 * A and B are connected, and both are everywhere in a real repo. A chain whose
 * edges all point one way (A -> H -> B, or B -> H -> A) is different: the
 * dependency genuinely flows end to end. So the search runs twice, once from
 * each side, forward only.
 *
 * An endpoint may be a file or a directory. A directory stands for everything
 * under it, matched on the path segment ("src/eng" never matches
 * "src/engine/a.ts").
 *
 * Two endpoints that share any node are refused outright, before the search.
 * Two boxes on the same file expand to the same set, and a subsystem box
 * pointing at a file inside it expands to a superset -- so the walk would
 * start already standing on its goal and confirm the arrow against a graph
 * holding no edge at all. "A reaches A" says nothing about two different
 * things drawn on a board, and counting it as checked would inflate the
 * coverage tally while silencing a question nobody asked. Silence here is
 * the honest answer: the other channels still get their say.
 */
export function connects(
  graph: LoadedCodeGraph,
  refA: string | readonly string[],
  refB: string | readonly string[],
): boolean {
  const a = expandEndpoints(graph, refA);
  if (a.size === 0) return false;
  const b = expandEndpoints(graph, refB);
  if (b.size === 0) return false;
  for (const node of a) if (b.has(node)) return false;
  return reachesForward(graph, a, b) || reachesForward(graph, b, a);
}

/**
 * Breadth-first, forward edges only, at most MAX_HOPS deep.
 *
 * The two sets are disjoint by the time this runs, so a chain of at least one
 * real edge is the only thing that can return true.
 */
function reachesForward(
  graph: LoadedCodeGraph,
  start: Set<string>,
  goal: Set<string>,
): boolean {
  let frontier = start;
  const seen = new Set(start);
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const next = new Set<string>();
    for (const node of frontier) {
      const out = graph.forward.get(node);
      if (!out) continue;
      for (const target of out) {
        if (seen.has(target)) continue;
        if (goal.has(target)) return true;
        seen.add(target);
        next.add(target);
      }
    }
    if (next.size === 0) return false;
    frontier = next;
  }
  return false;
}

/**
 * One endpoint's nodes, from one ref or from a list of them.
 *
 * A list is how a glob arrives: `*.ts` names the files it matches and not the
 * directory holding them, so the caller lists them and the union is the
 * endpoint. Unioning before the disjointness check below is the point -- asking
 * per file and taking any yes would let a set overlapping the other end at one
 * file still confirm through another, which is not the question `connects` is
 * documented to answer.
 */
function expandEndpoints(
  graph: LoadedCodeGraph,
  refs: string | readonly string[],
): Set<string> {
  if (typeof refs === "string") return expandEndpoint(graph, refs);
  const out = new Set<string>();
  for (const ref of refs) {
    for (const node of expandEndpoint(graph, ref)) out.add(node);
  }
  return out;
}

/** All nodes standing for a file, or for everything under a directory. */
function expandEndpoint(graph: LoadedCodeGraph, ref: string): Set<string> {
  const exact = graph.nodesByFile.get(ref);
  if (exact) return new Set(exact);
  const prefix = ref.endsWith("/") ? ref : `${ref}/`;
  const result = new Set<string>();
  for (const [file, nodes] of graph.nodesByFile) {
    if (file.startsWith(prefix)) for (const node of nodes) result.add(node);
  }
  return result;
}

/**
 * Whether a ref (file or directory) has changed since the graph was built.
 * A directory is stale as soon as anything under it is.
 */
export function refIsStale(ref: string, modified: Set<string>): boolean {
  if (modified.has(ref)) return true;
  const prefix = ref.endsWith("/") ? ref : `${ref}/`;
  for (const file of modified) {
    if (file.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Load graphify-out/graph.json for a repo, ready to hand to checkDrift.
 *
 * Mirrors createGitBaseline's stance: every failure is silence. No graph, no
 * sidecar, unparseable JSON, an untested graphify version, a sidecar commit
 * git does not recognise, no git at all -- all `undefined`, and the checker
 * behaves exactly as it does without the channel.
 *
 * The modified set is what makes the graph safe to consult between commits:
 * the graph describes the sidecar's commit, so any file changed since then
 * (staged, unstaged, or in later commits) falls back to the live channels.
 *
 * ## Why the parse is cached and the modified set is not
 *
 * A one-shot `drift` run calls this once and the cost is invisible. The board
 * service calls it per request, and #130 makes it call it per save while a board
 * is being watched, which is where the split starts to matter. Measured on this
 * repository, whose graph is 15 MB:
 *
 *     read + parse graph.json   ~35ms
 *     loadCodeGraph              ~9ms
 *     two git diffs             ~30ms
 *
 * The first two depend only on the file, which is rebuilt at commit time and
 * never between -- so keying them on the file's identity is exact rather than a
 * guess, and a rebuilt graph invalidates itself. The git half depends on the
 * working tree, which is precisely what changes while somebody is typing, so it
 * is recomputed every time. Caching *that* on a timer would let the channel
 * confirm an arrow from a graph that no longer describes the file, which is the
 * one thing `modified` exists to prevent.
 */
interface CachedGraph {
  /** The file's identity when it was parsed: size and modification time. */
  stamp: string;
  graphify: string;
  graph: LoadedCodeGraph | undefined;
}

const graphCache = new Map<string, CachedGraph>();

/**
 * The parsed graph for a path, reusing the last parse when the file has not
 * moved. A cached `undefined` is a cached answer too: an unloadable graph should
 * not be re-parsed 15 MB at a time on every keystroke to be refused again.
 */
function cachedGraph(graphPath: string, graphify: string): LoadedCodeGraph | undefined {
  const info = statSync(graphPath);
  const stamp = `${info.size}:${info.mtimeMs}`;
  const hit = graphCache.get(graphPath);
  if (hit && hit.stamp === stamp && hit.graphify === graphify) return hit.graph;
  const graph = loadCodeGraph(
    JSON.parse(readFileSync(graphPath, "utf8")) as CodeGraphSchema,
    graphify,
  );
  graphCache.set(graphPath, { stamp, graphify, graph });
  return graph;
}

export function createCodeGraphOption(root: string): CodeGraphOption | undefined {
  try {
    const graphPath = path.join(root, "graphify-out", "graph.json");
    const metaPath = path.join(root, "graphify-out", "code-graph-meta.json");
    if (!existsSync(graphPath) || !existsSync(metaPath)) return undefined;

    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      commit?: unknown;
      graphify?: unknown;
    };
    if (typeof meta.commit !== "string" || !/^[0-9a-f]{7,40}$/.test(meta.commit)) return undefined;
    if (typeof meta.graphify !== "string") return undefined;

    const graph = cachedGraph(graphPath, meta.graphify);
    if (!graph) return undefined;

    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 32 * 1024 * 1024,
      });
    const modified = new Set<string>();
    // Working tree against HEAD (staged and unstaged in one call), then
    // anything committed after the graph was built.
    for (const chunk of [git(["diff", "--name-only", "HEAD"]), git(["diff", "--name-only", `${meta.commit}..HEAD`])]) {
      for (const line of chunk.split("\n")) {
        const file = line.trim();
        if (file) modified.add(file.split(path.sep).join("/"));
      }
    }

    return { graph, modified };
  } catch {
    return undefined;
  }
}
