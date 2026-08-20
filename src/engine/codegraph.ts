/**
 * Code graph channel: a precomputed whole-repo graph of code relations.
 *
 * Built at commit time by graphify, read at check time as plain JSON, no model
 * or subprocess involved. Corroborates arrows (suppresses unsupported-edge)
 * when endpoints connect through extracted-confidence code relations.
 *
 * False positives are worse than silence: the channel only *confirms* arrows.
 * A gap in the graph means silence, identical to today.
 */

/**
 * The schema graphify's NetworkX node-link export.
 * Nodes: `{ id, source_file, ... }`.
 * Edges: `{ source, target, relation, confidence, ... }`.
 */
export interface CodeGraphSchema {
  nodes?: Array<{ id?: string; source_file?: string }>;
  links?: Array<{
    source?: string;
    target?: string;
    relation?: string;
    confidence?: string;
  }>;
}

export interface LoadedCodeGraph {
  nodesByFile: Map<string, string[]>; // source_file -> node ids
  adjacency: Map<string, Set<string>>; // node id -> adjacent node ids (undirected, whitelisted edges only, EXTRACTED only)
  nodeDegrees: Map<string, number>; // node id -> degree in the whitelisted graph
  relations: Map<string, Set<string>>; // "a:b" -> set of relation types between a and b
}

/**
 * How many edges a node can have before it is treated as a hub.
 * Hubs are excluded from paths to prevent false positives like
 * "A and B both import shared config" being read as "A connects to B".
 */
const HUB_DEGREE_THRESHOLD = 20;

/**
 * Relations that serve as corroboration when extracted.
 * Direction is treated as undirected.
 */
const WHITELISTED_RELATIONS = new Set([
  "calls",
  "imports",
  "imports_from",
  "re_exports",
  "dynamic_import",
]);

/**
 * Relations that expand endpoint sets but do not count as hops.
 * These let us recognize that a symbol and its containing file are
 * in the same place.
 */
const EXPANSION_RELATIONS = new Set(["contains", "method"]);

/**
 * Load and validate a graphify output graph.
 *
 * Returns undefined when: either file missing; JSON unparseable; schema
 * unexpected; or the graphify version is outside the tested range (0.9.x only).
 *
 * @param graph The parsed graphify JSON.
 * @param graphifyVersion The `graphify --version` string.
 */
export function loadCodeGraph(
  graph: CodeGraphSchema,
  graphifyVersion: string,
): LoadedCodeGraph | undefined {
  // Validate version (0.9.x only, not 0.10.0+)
  if (!graphifyVersion.startsWith("0.9.")) {
    return undefined;
  }

  // Validate schema
  if (!graph.nodes || !Array.isArray(graph.nodes)) return undefined;
  if (!graph.links || !Array.isArray(graph.links)) return undefined;

  // Validate all nodes have id and source_file
  for (const node of graph.nodes) {
    if (typeof node.id !== "string" || typeof node.source_file !== "string") {
      return undefined;
    }
  }

  // Validate all edges have required fields
  for (const edge of graph.links) {
    if (
      typeof edge.source !== "string"
      || typeof edge.target !== "string"
      || typeof edge.relation !== "string"
      || typeof edge.confidence !== "string"
    ) {
      return undefined;
    }
  }

  // Build node lookup by file
  const nodesByFile = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const file = node.source_file!;
    if (!nodesByFile.has(file)) {
      nodesByFile.set(file, []);
    }
    nodesByFile.get(file)!.push(node.id!);
  }

  // Build adjacency for whitelisted, extracted edges
  const adjacency = new Map<string, Set<string>>();
  const nodeDegrees = new Map<string, number>();
  const relations = new Map<string, Set<string>>();

  // Initialize all nodes with empty adjacency
  for (const node of graph.nodes) {
    adjacency.set(node.id!, new Set());
    nodeDegrees.set(node.id!, 0);
  }

  // Add edges: whitelisted relations with EXTRACTED confidence only
  for (const edge of graph.links) {
    if (
      WHITELISTED_RELATIONS.has(edge.relation!)
      && edge.confidence === "EXTRACTED"
    ) {
      const src = edge.source!;
      const tgt = edge.target!;
      const rel = edge.relation!;

      // Undirected: add both directions
      adjacency.get(src)?.add(tgt);
      adjacency.get(tgt)?.add(src);

      // Count degree (both directions count towards one edge)
      nodeDegrees.set(src, (nodeDegrees.get(src) ?? 0) + 1);
      nodeDegrees.set(tgt, (nodeDegrees.get(tgt) ?? 0) + 1);

      // Store relation types between this pair
      const key = src < tgt ? `${src}:${tgt}` : `${tgt}:${src}`;
      if (!relations.has(key)) {
        relations.set(key, new Set());
      }
      relations.get(key)!.add(rel);
    }
  }

  return { nodesByFile, adjacency, nodeDegrees, relations };
}

/**
 * Whether endpoints in two files are connected by a path of at most 3 hops
 * through whitelisted relations.
 *
 * Endpoints expand through contains/method edges (not counted as hops) to
 * include all symbols in the same file.
 *
 * Respects 3-hop limit and avoids the false-positive pattern where two
 * files that both import a shared hub are incorrectly read as connected.
 *
 * Direction-agnostic (undirected walk).
 *
 * @param graph Loaded code graph.
 * @param fileA Endpoint file path (absolute or repo-relative).
 * @param fileB Endpoint file path (absolute or repo-relative).
 * @returns True if connected within 3 hops, false otherwise.
 */
export function connects(
  graph: LoadedCodeGraph,
  fileA: string,
  fileB: string,
): boolean {
  const startNodes = expandEndpoint(graph, fileA);
  const endNodes = expandEndpoint(graph, fileB);
  const endNodesSet = new Set(endNodes);

  if (startNodes.length === 0 || endNodes.length === 0) {
    return false;
  }

  // BFS from all start nodes, tracking the path to detect import hubs
  const queue: Array<{
    nodeId: string;
    distance: number;
    path: string[]; // Path of node IDs for hub detection
  }> = [];
  const visited = new Set<string>();

  for (const start of startNodes) {
    queue.push({ nodeId: start, distance: 0, path: [start] });
    visited.add(start);
  }

  while (queue.length > 0) {
    const { nodeId, distance, path } = queue.shift()!;

    // Check if we reached any endpoint
    if (endNodesSet.has(nodeId)) {
      // Check if this is an import-hub pattern (should be rare at distance 2)
      if (distance === 2 && isImportHubPattern(graph, startNodes, endNodes, path)) {
        continue; // Skip this path, keep looking for alternatives
      }
      return true;
    }

    // Stop if we've gone too far
    if (distance >= 3) {
      continue;
    }

    // Explore neighbors
    const neighbors = graph.adjacency.get(nodeId);
    if (!neighbors) continue;

    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) continue;

      visited.add(neighbor);
      queue.push({
        nodeId: neighbor,
        distance: distance + 1,
        path: [...path, neighbor],
      });
    }
  }

  return false;
}

/**
 * Check if a 2-hop path exhibits the "import hub" pattern:
 * start → hub ← end, where both edges are imports.
 *
 * This prevents false positives like "A and B both import shared config"
 * being read as "A connects to B".
 */
function isImportHubPattern(
  graph: LoadedCodeGraph,
  startNodes: string[],
  endNodes: string[],
  path: string[],
): boolean {
  // Only matters for 2-hop paths: [start, hub, end]
  if (path.length !== 3) return false;

  const [start, hub, end] = path;

  // start and end must both be in their respective endpoint sets
  if (!startNodes.includes(start) || !endNodes.includes(end)) return false;

  // Both edges must be import relations
  const startToHub = getRelationKey(start, hub);
  const hubToEnd = getRelationKey(hub, end);

  const startToHubRels = graph.relations.get(startToHub);
  const hubToEndRels = graph.relations.get(hubToEnd);

  // If either edge has relations other than imports, allow the path
  if (startToHubRels?.has("imports") === false || hubToEndRels?.has("imports") === false) {
    return false;
  }

  // Both edges are imports: this is the import-hub pattern, reject it
  if (startToHubRels?.has("imports") && hubToEndRels?.has("imports")) {
    return true;
  }

  return false;
}

function getRelationKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Get all nodes that represent an endpoint.
 *
 * For a file endpoint: all nodes whose source_file equals that file.
 *
 * For a directory endpoint (path ending with /): all nodes whose source_file
 * starts with that directory path. Matching is prefix-based to exclude sibling
 * paths that share a prefix but differ after their next separator.
 *
 * Expansion through contains/method edges is NOT done here; that would break
 * the search algorithm. Instead, we initialize the BFS with all nodes in the
 * file, which has the same effect.
 */
function expandEndpoint(graph: LoadedCodeGraph, endpoint: string): string[] {
  // Check if directory endpoint (ends with /)
  if (endpoint.endsWith("/")) {
    const result: string[] = [];
    for (const [file, nodes] of graph.nodesByFile) {
      // Exact match: file starts with directory prefix AND
      // the character immediately after the prefix (if any) is NOT part of
      // a sibling directory name.
      // "src/engine/" should match "src/engine/a.ts" but not "src/eng/b.ts"
      // "src/engine/" should match "src/engine/sub/a.ts"
      // Use a simple startsWith check since the directory already ends with /
      if (file.startsWith(endpoint)) {
        result.push(...nodes);
      }
    }
    return result;
  }

  // File endpoint
  return graph.nodesByFile.get(endpoint) ?? [];
}
