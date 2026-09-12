/**
 * The question set for `measure:reach`, drawn from the referee and from
 * nothing else.
 *
 * An ask is a pair of routines and the referee's own answer about them. Two
 * populations, and they are not symmetrical:
 *
 *   **reaches**, at a named distance. The referee found a chain of resolved
 *   calls from one to the other. A path found is a path, so this population
 *   needs no completeness argument -- only that the checker's landings are
 *   right, which is what the negative control in `measure:calls` already
 *   tests for the same checkers.
 *
 *   **never**, which has to be earned three times over. The referee's forward
 *   closure from the head must be *complete* -- every call site of every
 *   routine on it resolved -- and the tail must not be in it. The tail must
 *   not reach the head either, because the reader is bidirectional by design
 *   and may call such a pair connected. And the tail's name must appear
 *   nowhere in any file the closure touches *other than its own
 *   declaration*, which is what stands in for the callback the referee cannot
 *   see: a routine whose name the closure never writes cannot be handed out
 *   of it as a value.
 *
 * Seeds are picked by walking the sorted id list at a fixed stride rather
 * than at random, so two runs over the same commit ask the same questions and
 * a number can be compared with the one before it.
 */
import path from "node:path";

import { type Language } from "../../src/engine/parse";

import { idOf, namedAnywhere, type NodeId, type RefereeGraph, type RefereeNode } from "./reach-graph";

export interface Ask {
  from: RefereeNode;
  to: RefereeNode;
  /**
   * True when the tail's name **is** written somewhere on the closure, so
   * the callback guard did not clear it.
   *
   * A `never` ask like this is not ground truth and is never scored as one.
   * It exists to measure the population the *product* would be asked about,
   * against the one the benchmark can be sure of -- see `unguarded` in
   * `asksFrom`.
   */
  named?: true;
  /** What the referee says. */
  truth: "reaches" | "never";
  /** Shortest chain length the referee found, for a `reaches` ask. */
  distance: number;
  /** Routines on the referee's own shortest chain, head and tail included. */
  chain: string[];
  /** How many routines the closure held, for a `never` ask. */
  closure: number;
}

/** One forward closure, expanded lazily until it finishes or runs out of road. */
export interface Closure {
  /** Reached routine to the shortest referee distance from the seed. */
  distance: Map<NodeId, number>;
  /** Shortest-chain predecessor, for quoting the route. */
  came: Map<NodeId, NodeId>;
  /** True when every call site of every routine on it was resolved. */
  complete: boolean;
  /** Why it is not complete, when it is not. */
  why?: "leaked" | "budget" | "depth";
  /** Files any routine on the closure lives in. */
  files: Set<string>;
}

export async function closureFrom(
  graph: RefereeGraph,
  seed: NodeId,
  budget: number,
  maxDepth: number,
): Promise<Closure> {
  const distance = new Map<NodeId, number>([[seed, 0]]);
  const came = new Map<NodeId, NodeId>();
  const files = new Set<string>();
  let complete = true;
  let why: Closure["why"];
  let frontier = [seed];
  let depth = 0;

  while (frontier.length > 0) {
    if (depth >= maxDepth) {
      // Only a doubt if there was anywhere further to go.
      complete = false;
      why ??= "depth";
      break;
    }
    const next: NodeId[] = [];
    for (const id of frontier) {
      const node = graph.nodes.get(id);
      if (node) files.add(node.file);
      const found = await graph.expand(id);
      if (found.unresolved > 0) { complete = false; why ??= "leaked"; }
      for (const out of found.out) {
        if (distance.has(out)) continue;
        if (distance.size >= budget) { complete = false; why ??= "budget"; continue; }
        distance.set(out, depth + 1);
        came.set(out, id);
        next.push(out);
      }
    }
    frontier = next;
    depth += 1;
  }
  return { distance, came, complete, why, files };
}

const chainOf = (closure: Closure, graph: RefereeGraph, at: NodeId): string[] => {
  const names: string[] = [];
  let current: NodeId | undefined = at;
  while (current) {
    names.unshift(graph.nodes.get(current)?.name ?? current);
    current = closure.came.get(current);
  }
  return names;
};

/** Every id, sorted, so a stride picks the same seeds twice. */
const sorted = (graph: RefereeGraph): NodeId[] => [...graph.nodes.keys()].sort();

export interface AskSet {
  asks: Ask[];
  /** Seeds whose closure was complete, out of seeds tried. */
  complete: number;
  seeds: number;
  /** Why the incomplete closures stopped. */
  stopped: Map<string, number>;
}

/**
 * Ask sets from one referee graph.
 *
 * `perSeed` caps each population per seed, so one enormously connected
 * routine cannot supply half the questions and make the number a fact about
 * that routine. The two caps are separate because the populations are not
 * equally easy to come by: a reaching pair needs only a chain, while a
 * never-reaching one needs a whole closure to have closed, and at four per
 * seed the negative sample came to 116 asks -- of which the reader answered
 * 8. Eight is not a number anything may be licensed on, and the fix is a
 * bigger sample rather than a happier reading of that one.
 */
export async function asksFrom(
  graph: RefereeGraph,
  tree: string,
  language: Language,
  options: {
    seeds: number; budget: number; depth: number; perSeed: number; perSeedNever: number;
    /**
     * Also collect the never-asks the callback guard rejects, marked `named`.
     *
     * The guard is what makes the negative population sound: a name written
     * nowhere on the closure cannot be handed out of it as a value, so no
     * invisible indirect call can be hiding behind it. That is also the exact
     * property the product cannot rely on -- somebody drawing an arrow
     * between two real routines is usually drawing one whose names appear all
     * over the code.
     *
     * So the guarded population is the one anything may be scored against,
     * and this is the one that says how much of the real question it covers.
     */
    unguarded?: boolean;
  },
): Promise<AskSet> {
  const ids = sorted(graph);
  const asks: Ask[] = [];
  const stopped = new Map<string, number>();
  let complete = 0;
  let seeds = 0;
  if (ids.length === 0) return { asks, complete, seeds, stopped };

  const stride = Math.max(1, Math.floor(ids.length / options.seeds));
  for (let index = 0; index < ids.length && seeds < options.seeds; index += stride) {
    const seed = ids[index]!;
    const head = graph.nodes.get(seed)!;
    const closure = await closureFrom(graph, seed, options.budget, options.depth);
    // A routine that calls nothing in the tree asks nothing about reach.
    if (closure.distance.size <= 1) continue;
    seeds += 1;
    if (closure.complete) complete += 1;
    else stopped.set(closure.why!, (stopped.get(closure.why!) ?? 0) + 1);

    /* --------------------------------------------------- it does reach */
    const byDistance = new Map<number, NodeId[]>();
    for (const [id, at] of closure.distance) {
      if (at === 0) continue;
      const list = byDistance.get(at) ?? [];
      list.push(id);
      byDistance.set(at, list);
    }
    let taken = 0;
    // Deepest first, because the deep ones are the whole question and a
    // shallow sample would be the old measurement with more steps in it.
    for (const at of [...byDistance.keys()].sort((a, b) => b - a)) {
      for (const id of byDistance.get(at)!.sort()) {
        if (taken >= options.perSeed) break;
        const tail = graph.nodes.get(id)!;
        // A routine reaching itself is not a relationship anybody draws.
        if (tail.file === head.file && tail.name === head.name) continue;
        asks.push({
          from: head, to: tail, truth: "reaches", distance: at,
          chain: chainOf(closure, graph, id), closure: closure.distance.size,
        });
        taken += 1;
      }
      if (taken >= options.perSeed) break;
    }

    /* ------------------------------------------------ it does not reach */
    if (!closure.complete) continue;
    /*
     * Candidates in the head's own neighbourhood first. A pair drawn from
     * opposite ends of a monorepo is a question nobody would ask and a reader
     * nobody could fail; the interesting negative is the routine sitting in
     * the same file or the same directory, which every file-level channel
     * confirms and which the head genuinely never reaches.
     */
    const near = (id: NodeId): number => {
      const node = graph.nodes.get(id)!;
      if (node.file === head.file) return 0;
      if (path.dirname(node.file) === path.dirname(head.file)) return 1;
      return 2;
    };
    const candidates = ids
      .filter((id) => !closure.distance.has(id))
      .sort((a, b) => near(a) - near(b) || (a < b ? -1 : 1));
    /*
     * Two counters, not one, and that is load-bearing.
     *
     * A shared cap would make `--unguarded` change the *scored* population:
     * the guard-rejected asks would fill the quota and crowd out the ones the
     * benchmark can certify. Measured while building this -- the scored
     * `never` count went from 24 to 8 with the flag on, which is an
     * instrument moving its own reading. Capped separately, the guarded
     * population is identical with the flag and without it.
     */
    let negatives = 0;
    let alsoNamed = 0;
    for (const id of candidates) {
      if (negatives >= options.perSeedNever
        && (!options.unguarded || alsoNamed >= options.perSeedNever)) break;
      const tail = graph.nodes.get(id)!;
      if (tail.name === head.name) continue;
      // The callback guard: a name nowhere in the closure cannot be handed
      // out of it, so no unseen indirect call can be hiding behind it.
      const named = namedAnywhere(tail.name, closure.files, tree, language, tail);
      if (named && !options.unguarded) continue;
      if (named ? alsoNamed >= options.perSeedNever : negatives >= options.perSeedNever) continue;
      /*
       * And the reverse direction, because the reader is entitled to confirm
       * it. `checkSymbolEdge` tries both ends and says so -- "an arrow means
       * these two are connected, and the diagram's sense of direction is a
       * reading of the design rather than a claim about who calls whom" -- so
       * a pair where the *tail* reaches the head is a pair the reader may
       * call connected, and a referee that only looked forward would score
       * that as a wrong confirmation.
       *
       * It scored 15 of them on `vuejs-core` the moment the guard above
       * stopped rejecting the shape by accident: `transformElement` calls
       * `mergeAsArray` on line 881, so the arrow between them is real and the
       * forward closure from `mergeAsArray` is right to exclude it. Both
       * statements are true, and only the question was wrong.
       */
      const back = await closureFrom(graph, id, options.budget, options.depth);
      if (back.distance.has(seed)) continue;
      asks.push({
        from: head, to: tail, truth: "never", distance: 0,
        chain: [], closure: closure.distance.size,
        ...(named ? { named: true as const } : {}),
      });
      if (named) alsoNamed += 1;
      else negatives += 1;
    }
  }
  return { asks, complete, seeds, stopped };
}

export { idOf };
