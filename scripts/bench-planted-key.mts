#!/usr/bin/env node
/**
 * Builds #296's answer key: every claim the score is computed over, with the
 * language tooling's verdict on it.
 *
 *   npx tsx scripts/bench-planted-key.mts            # every board
 *   npx tsx scripts/bench-planted-key.mts anyhow     # one project
 *
 * Slow (it drives rust-analyzer, pyright and the TypeScript compiler), so it
 * is run once and its output checked in beside each board. `npm run
 * bench:planted` then scores from the stored key and calls no tool and no
 * model.
 *
 * ## What the key contains
 *
 * Four sources, and the difference matters when reading the score:
 *
 * - **drawn** -- the claim Haiku wrote on the arrow. Some are true and some
 *   are not; both are useful, and the false ones are mistakes nobody planted.
 * - **labelled** -- every other word, tried on the same arrow, kept when the
 *   tooling says it is true. This is where most of the true claims come from,
 *   and true claims are what a false red is measured against.
 * - **planted** -- the four mutations #296 asks for, generated from a claim
 *   the tooling called true: the word swapped, the arrow reversed, an end
 *   moved to another real symbol in the same file, and an end moved to a
 *   symbol of the wrong kind.
 *
 * A mutation is only a planted *mistake* once the tooling has called it false.
 * A reversed arrow between two routines that call each other is still true,
 * and scoring it as a missed mistake would be scoring the generator's
 * assumption rather than the checker.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readGraph } from "../src/engine/graph";
import { createOracle, kindProblemFor, WORDS, type ClaimUnderTest, type Oracle, type Word } from "./lib/bench-oracle";
import { createTooling, languageOfPath, type Language, type Sym } from "./lib/bench-tooling";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CORPUS = process.env.CORPUS ?? "/Users/noelmatero/board-ai/.corpus";

interface Scope { project: string; language: string; topic: string; scope: string; ask: string }

export interface KeyClaim {
  id: string;
  word: Word;
  from: string;
  to: string;
  member?: string;
  fromLabel: string;
  toLabel: string;
  /** The state the board gave each end. An `external` box is read by nothing. */
  fromState?: string;
  toState?: string;
  language: string;
  source: "drawn" | "labelled" | "swap" | "reverse" | "retarget" | "wrong-kind";
  /** The claim a plant was grown from. */
  parent?: string;
  truth: "true" | "false" | "undecidable";
  why: string;
}

/** A stable number from a string, so every plant is the same plant next run. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Which word a swap reaches for. The first one whose ends are of the right
 * kinds is taken, so a swap tests the checker on a wrong *word* rather than
 * on an end that could not carry it -- that is the wrong-kind plant's job.
 */
const SWAPS: Record<Word, Word[]> = {
  needs: ["calls", "holds"],
  // No plant swaps *into* `depends`: the population the score is measured
  // against stays the one #296 built (#323).
  depends: [],
  takes: ["returns"],
  returns: ["takes"],
  holds: ["conforms", "accesses"],
  builds: ["accesses", "calls"],
  calls: ["builds", "feeds"],
  accesses: ["builds", "holds"],
  conforms: ["holds"],
  feeds: ["calls"],
};

/** Which end a wrong-kind plant corrupts, and what it puts there. */
const WRONG_KIND: Record<Word, { end: "from" | "to"; want: Array<Sym["kind"]> }> = {
  needs: { end: "to", want: ["routine"] },
  depends: { end: "to", want: ["routine"] },
  takes: { end: "from", want: ["routine"] },
  returns: { end: "from", want: ["routine"] },
  holds: { end: "to", want: ["routine"] },
  builds: { end: "to", want: ["routine", "data"] },
  calls: { end: "to", want: ["data"] },
  accesses: { end: "to", want: ["routine"] },
  conforms: { end: "to", want: ["routine"] },
  feeds: { end: "from", want: ["type", "data"] },
};

const refFile = (ref: string) => ref.split("#")[0]!;
const refName = (ref: string) => ref.split("#")[1];

async function pickSymbol(
  oracle: Oracle, file: string, seed: number, want: Array<Sym["kind"]> | undefined, not: string[],
): Promise<Sym | undefined> {
  const syms = (await oracle.symbolsOf(file)) ?? [];
  const usable = syms.filter((s) =>
    !not.includes(s.name) && /^[A-Za-z_]\w*$/.test(s.name)
    && (want === undefined ? s.kind === "routine" || s.kind === "type" : want.includes(s.kind)));
  if (usable.length === 0) return undefined;
  return usable[seed % usable.length];
}

/** Another file beside this one, for a `needs` plant: a file is what it reads. */
function siblingFile(root: string, ref: string): string | undefined {
  const file = refFile(ref);
  const dir = path.dirname(path.join(root, file));
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return undefined; }
  const extension = path.extname(file);
  const siblings = entries
    .filter((e) => e.endsWith(extension) && e !== path.basename(file))
    .sort();
  if (siblings.length === 0) return undefined;
  return path.join(path.dirname(file), siblings[hash(ref) % siblings.length]!);
}

/** The first swap whose ends are of the right kinds, so the word is the mistake. */
async function pickSwap(
  oracle: Oracle, word: Word, fromRef: string, toRef: string, member: string | undefined, seed: number,
): Promise<Word | undefined> {
  const from = (await oracle.candidates(fromRef))?.[0];
  const to = (await oracle.candidates(toRef))?.[0];
  const options = SWAPS[word].filter((w) => w !== "accesses" || member);
  if (options.length === 0) return undefined;
  if (!from || !to) return options[seed % options.length];
  const fitting = options.filter((w) => kindProblemFor(w, from, to) === undefined);
  return (fitting.length > 0 ? fitting : options)[seed % (fitting.length > 0 ? fitting.length : options.length)];
}

async function buildKey(scope: Scope, boardPath: string): Promise<{ claims: KeyClaim[]; tool: string } | undefined> {
  const root = path.join(CORPUS, scope.project);
  const graph = readGraph(JSON.parse(readFileSync(boardPath, "utf8")));
  const label = new Map(graph.nodes.map((n) => [n.id, n.label.replace(/\s+/g, " ")]));
  const refOf = new Map(graph.nodes.flatMap((n) => (n.ref ? [[n.id, n.ref] as const] : [])));
  const stateOf = new Map(graph.nodes.map((n) => [n.id, n.state]));

  const language = (scope.language === "tsx" ? "ts" : scope.language) as Language;
  const tooling = await createTooling(language, root);
  const oracle = createOracle(tooling);
  const claims: KeyClaim[] = [];
  const seen = new Set<string>();

  const idOf = (c: ClaimUnderTest) => `${c.word}|${c.from}|${c.to}|${c.member ?? ""}`;
  const add = async (c: ClaimUnderTest, source: KeyClaim["source"], from: string, to: string, parent?: string) => {
    const id = idOf(c);
    if (seen.has(id)) return undefined;
    seen.add(id);
    const answer = await oracle.judge(c);
    const languageOfClaim = languageOfPath(refFile(c.from)) ?? language;
    const row: KeyClaim = {
      id, word: c.word, from: c.from, to: c.to, ...(c.member ? { member: c.member } : {}),
      fromLabel: label.get(from) ?? from, toLabel: label.get(to) ?? to,
      ...(stateOf.get(from) && stateOf.get(from) !== "built" ? { fromState: stateOf.get(from) } : {}),
      ...(stateOf.get(to) && stateOf.get(to) !== "built" ? { toState: stateOf.get(to) } : {}),
      language: refFile(c.from).endsWith(".tsx") || refFile(c.to).endsWith(".tsx") ? "tsx" : languageOfClaim,
      source, ...(parent ? { parent } : {}),
      truth: answer.truth, why: answer.why,
    };
    claims.push(row);
    return row;
  };

  for (const edge of graph.edges) {
    if (edge.state === "planned") continue;
    const fromRef = refOf.get(edge.from);
    const toRef = refOf.get(edge.to);
    if (!fromRef || !toRef) continue;
    // Only `@accesses` takes an argument off the label. Putting one on any
    // other word makes the board's own label unreadable rather than testing
    // the word, which the first run of this script did and the checker
    // reported as a garbled claim.
    const raw = edge.label?.trim().split(/\s+/)[0];
    const member = raw && /^[A-Za-z_]\w*$/.test(raw) ? raw : undefined;
    const withMember = (word: Word) => (word === "accesses" && member ? { member } : {});
    const base = { from: fromRef, to: toRef };

    const drawn = edge.claim as Word | undefined;
    const roots: KeyClaim[] = [];
    if (drawn && (WORDS as readonly string[]).includes(drawn)) {
      const row = await add({ ...base, ...withMember(drawn), word: drawn }, "drawn", edge.from, edge.to);
      if (row) roots.push(row);
    }
    for (const word of WORDS) {
      if (word === drawn) continue;
      const row = await add({ ...base, ...withMember(word), word }, "labelled", edge.from, edge.to);
      // Only a word the tooling calls true is kept as a claim of its own; the
      // rest are dropped, because "every other word is wrong" is the census
      // #293 already did, not a board anybody would draw.
      if (row && row.truth !== "true") { claims.pop(); seen.delete(row.id); continue; }
      if (row) roots.push(row);
    }

    for (const origin of roots.filter((r) => r.truth === "true")) {
      const seed = hash(origin.id);
      // 1. the word swapped for another
      const swap = await pickSwap(oracle, origin.word, fromRef, toRef, member, seed);
      if (swap) await add({ ...base, ...withMember(swap), word: swap }, "swap", edge.from, edge.to, origin.id);
      // 2. the arrow reversed
      await add({ from: toRef, to: fromRef, ...withMember(origin.word), word: origin.word },
        "reverse", edge.to, edge.from, origin.id);
      // 3. an end moved to another real thing: another symbol in the same
      //    file, or -- for a word read at file level -- a sibling file.
      const movedEnd = seed % 2 === 0 ? "to" : "from";
      const ref = movedEnd === "to" ? toRef : fromRef;
      const moved = origin.word === "needs"
        ? siblingFile(root, ref)
        : await (async () => {
          const other = await pickSymbol(oracle, refFile(ref), seed, undefined, [refName(ref) ?? ""]);
          return other ? `${refFile(ref)}#${other.name}` : undefined;
        })();
      if (moved) {
        await add({ ...base, ...withMember(origin.word), word: origin.word, ...(movedEnd === "to" ? { to: moved } : { from: moved }) },
          "retarget", edge.from, edge.to, origin.id);
      }
      // 4. an end moved to a symbol of the wrong kind for this word. `needs`
      //    has no kind rule -- a file imports a file -- so it gets none.
      if (origin.word !== "needs") {
        const plan = WRONG_KIND[origin.word];
        const kindRef = plan.end === "to" ? toRef : fromRef;
        const wrong = await pickSymbol(oracle, refFile(kindRef), seed, plan.want, [refName(kindRef) ?? ""]);
        if (wrong) {
          const at = `${refFile(kindRef)}#${wrong.name}`;
          await add({ ...base, ...withMember(origin.word), word: origin.word, ...(plan.end === "to" ? { to: at } : { from: at }) },
            "wrong-kind", edge.from, edge.to, origin.id);
        }
      }
    }
  }

  const tool = oracle.version();
  oracle.close();
  return { claims, tool };
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const scopes: Scope[] = JSON.parse(readFileSync(path.join(REPO, "bench/scopes.json"), "utf8"));
const pins = new Map<string, string>();
for (const entry of readdirSync(CORPUS)) {
  try {
    const head = readFileSync(path.join(CORPUS, entry, ".git/HEAD"), "utf8").trim();
    const ref = head.startsWith("ref: ") ? readFileSync(path.join(CORPUS, entry, ".git", head.slice(5)), "utf8").trim() : head;
    pins.set(entry, ref.slice(0, 10));
  } catch { /* not a clone */ }
}

for (const scope of scopes) {
  if (only.length > 0 && !only.includes(scope.project) && !only.includes(`${scope.project}/${scope.topic}`)) continue;
  const boardPath = path.join(REPO, "bench/boards", scope.project, `${scope.topic}.excalidraw`);
  if (!existsSync(boardPath)) { console.log(`- ${scope.project}/${scope.topic}: no board`); continue; }
  const started = Date.now();
  const built = await buildKey(scope, boardPath);
  if (!built) { console.log(`- ${scope.project}/${scope.topic}: no key`); continue; }
  const out = {
    board: `bench/boards/${scope.project}/${scope.topic}.excalidraw`,
    project: scope.project,
    topic: scope.topic,
    language: scope.language,
    scope: scope.scope,
    pin: pins.get(scope.project) ?? "unknown",
    tool: built.tool,
    claims: built.claims,
  };
  mkdirSync(path.dirname(boardPath), { recursive: true });
  writeFileSync(boardPath.replace(/\.excalidraw$/, ".answers.json"), `${JSON.stringify(out, null, 2)}\n`);
  const tally = (t: string) => built.claims.filter((c) => c.truth === t).length;
  console.log(`- ${scope.project}/${scope.topic}: ${built.claims.length} claims `
    + `(${tally("true")} true, ${tally("false")} false, ${tally("undecidable")} undecidable) `
    + `in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
