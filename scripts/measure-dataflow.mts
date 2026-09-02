#!/usr/bin/env node
/**
 * What following a value through one function body actually buys.
 *
 *   npm run measure:dataflow                 -- this repo, rust-test, orangutan,
 *                                               graphify, mundane, infrarouter
 *   npm run measure:dataflow -- <path>...    -- any trees you like
 *
 * #203 says the engine reads syntax and has no notion of a value, and makes a
 * prediction worth checking before anything is built on it:
 *
 *   > Dataflow makes confirmation dramatically better and refutation only
 *   > slightly better.
 *
 * This is the cheapest thing that can answer it (#208). **No word ships from
 * it.** `@feeds` keeps the behaviour it has whatever these numbers say, nothing
 * here is wired into `drift.ts`, and no call is resolved -- a value that leaves
 * the body is counted as escaping rather than chased, which is what keeps this
 * out of #189.
 *
 * Two numbers, and the second is the experiment:
 *
 *   1  CONFIRMATION GAIN  how many more `@feeds` arrows confirm once the reader
 *      follows a value through the locals of a body instead of one hop
 *
 *   2  REFUTATION GAIN    what share of values provably never leave the body
 *      they were made in -- the escape-analysis case. If a value never escapes
 *      the region it was made in, everything that can be in it is enumerable,
 *      and an absence is proof on the footing a signature is.
 *
 * A few percent on the second and #203's prediction holds, which makes #203 a
 * note rather than a framework. A high number and the closed-region argument
 * generalises from declarations to scopes, which is a significant finding.
 *
 * ## The referee
 *
 * The house pattern: count the shape one way, count it again by a completely
 * different mechanism, report the disagreement. Here the referee is a text scan
 * that shares nothing with the syntax walk, and it is pointed at the direction
 * that can do damage -- **a value the reader called contained and the referee
 * can see leaving.** Every one of those is the reader claiming an absence is
 * proof, which is the false accusation `licence.ts` is written to prevent. The
 * bar is zero.
 *
 * The other direction -- the reader saying a value escaped where the referee
 * sees nothing -- costs a value counted out of a number that is meant to be a
 * floor. Reported as a ratio, and not a bug.
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { chainFrom, contained, readBodies, type Body, type Local } from "../src/engine/dataflow";
import { checkFeeds } from "../src/engine/feeds";
import { initEngine, languageOf, type Language } from "../src/engine/parse";

await initEngine();

const HOME = process.env.HOME ?? "/Users/noelmatero";
const roots = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));

/**
 * The trees, taken as they sit on disk rather than pinned -- the same corpus
 * `measure-constructs.mts` reads, and for the same reason: four languages
 * throughout, never one. A single-language corpus here would produce a
 * confident wrong answer, which has happened twice in this repository.
 */
const trees = roots.length > 0 ? roots : [
  path.resolve("src"),
  path.resolve("scripts"),
  path.resolve("rust-test"),
  `${HOME}/orangutan`,
  `${HOME}/board-ai/graphify/graphify`,
  `${HOME}/mundane`,
  `${HOME}/infrarouter`,
].filter((tree) => existsSync(tree));

function sourceFiles(root: string): string[] {
  try {
    return execFileSync("find", [root, "-type", "f"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((file) => !/\/(target|node_modules|\.git|dist|out|vendor|\.venv)\//.test(file))
      .filter((file) => languageOf(file) !== undefined);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ referee */

/**
 * Where a routine opens, read off the text.
 *
 * The same crude rule `measure-constructs.mts` uses, and Python added, because
 * this measurement's largest population is Python and a referee that cannot see
 * it would leave the biggest language unrefereed.
 */
const TS_OPENS =
  /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)|^(\s*)(?:export\s+)?const\s+(\w+)\s*(?::[^=]*)?=\s*(?:async\s*)?\(/;

const OPENS = new Map<Language, RegExp>([
  ["rust", /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/],
  ["ts", TS_OPENS],
  ["tsx", TS_OPENS],
  ["js", TS_OPENS],
  ["python", /^(\s*)(?:async\s+)?def\s+(\w+)/],
]);

interface RefereeBody {
  name: string;
  /** 1-based line the routine opens on. */
  line: number;
  /** The routine's lines, comments blanked, in source order. */
  lines: string[];
}

/**
 * The routines of a file, as ranges of text.
 *
 * Braces for the C-family, indentation for Python -- which is the easier of the
 * two and the reason Python is refereed here and not in `measure-constructs`.
 * Block comments are blanked first: this file's own header contains
 * `const rows = parse(input)` as an example, and without that the referee reads
 * a pipeline out of the documentation.
 */
function refereeBodies(source: string, language: Language): RefereeBody[] {
  const opens = OPENS.get(language);
  if (!opens) return [];

  const lines = source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/(\/\/|#).*$/, ""))
    /*
     * And the strings. `data.get("norm_label")` is not a use of the value
     * called `norm_label`, and `re.sub(r"[^\w]+", "_", cur)` is not a use of a
     * loop variable called `_` -- both were reported as the value being handed
     * to a routine. Blanked rather than removed, so a column still lines up
     * with the source it came from.
     */
    .map((line) => line.replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g,
      (quoted) => quoted[0]! + " ".repeat(Math.max(0, quoted.length - 2)) + quoted[0]!))
    /*
     * And the prefix letters, which are part of the literal and not a name.
     * `lines.append(f"...")` was read as passing a variable called `f` -- and
     * `f` is exactly what a Python comprehension calls its loop variable.
     */
    .map((line) => line.replace(/\b[frbuFRBU]{1,2}(?=["'])/g, (prefix) => " ".repeat(prefix.length)));

  const found: RefereeBody[] = [];
  let current: RefereeBody | undefined;
  let indent = 0;
  let depth = 0;
  let opened = 0;

  for (const [index, line] of lines.entries()) {
    const start = opens.exec(line);
    if (start) {
      current = { name: start[2] ?? start[4]!, line: index + 1, lines: [] };
      found.push(current);
      indent = (start[1] ?? start[3] ?? "").length;
      opened = depth;
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      continue;
    }
    if (!current) continue;
    if (language === "python") {
      const blank = line.trim().length === 0;
      const here = line.length - line.trimStart().length;
      if (!blank && here <= indent) { current = undefined; continue; }
      current.lines.push(line);
      continue;
    }
    current.lines.push(line);
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth <= opened) current = undefined;
  }
  return found;
}

/** Words that open a block and are not routines being called. */
const NOT_A_CALL = new Set([
  "if", "for", "while", "switch", "match", "catch", "return", "fn", "def", "function",
  "and", "or", "not", "in", "is", "elif", "else", "with", "assert", "await", "yield",
  "print", "len", "str", "int", "super", "lambda", "type", "range", "enumerate", "zip",
]);

/** `name = callee(args)`, which is a result being bound. */
const BOUND =
  /^\s*(?:const|let|var|pub)?\s*(?:mut\s+)?([A-Za-z_]\w*)\s*(?::[^=]*?)?=\s*(?:await\s+|&\s*|\*\s*)?([A-Za-z_]\w*)\s*\(/;

/** Every `callee(args)` on a line, with the argument text. */
const CALLED = /([A-Za-z_]\w*)\s*\(([^()]*)\)/g;

/** A producer reaching a consumer, as the text reads it. */
interface RefereePair {
  producer: string;
  consumer: string;
  /** How many locals the value passed through. 1 is what the shipped reader can see. */
  hops: number;
}

/**
 * The pairs the text says are wired, per routine.
 *
 * Deliberately crude and it claims only what a person would read off the
 * screen: a name bound to a call's result, that name handed to another call,
 * and the chain of those. It knows nothing about scope beyond the routine's own
 * range, and nothing about grammar at all -- which is exactly what makes it a
 * referee for a walk that knows both.
 */
function refereePairs(routine: RefereeBody): RefereePair[] {
  /** name -> the producers whose result reached it, and through how many hops. */
  const origins = new Map<string, Map<string, number>>();
  const pairs: RefereePair[] = [];
  const seen = new Set<string>();

  for (const line of routine.lines) {
    // Every call on the line, read for a bound name being handed on.
    for (const call of line.matchAll(CALLED)) {
      const callee = call[1]!;
      if (NOT_A_CALL.has(callee)) continue;
      for (const word of (call[2] ?? "").matchAll(/[A-Za-z_]\w*/g)) {
        const from = origins.get(word[0]!);
        if (!from) continue;
        for (const [producer, hops] of from) {
          const key = `${producer}>${callee}`;
          if (producer === callee || seen.has(key)) continue;
          seen.add(key);
          pairs.push({ producer, consumer: callee, hops });
        }
      }
    }

    const bound = BOUND.exec(line);
    if (!bound) continue;
    const [, name, callee] = bound as unknown as [string, string, string];
    if (NOT_A_CALL.has(callee)) continue;
    const carried = new Map<string, number>([[callee, 1]]);
    const openArguments = line.slice(line.indexOf(callee) + callee.length);
    for (const word of openArguments.matchAll(/[A-Za-z_]\w*/g)) {
      const from = origins.get(word[0]!);
      if (!from) continue;
      for (const [producer, hops] of from) {
        if (!carried.has(producer)) carried.set(producer, hops + 1);
      }
    }
    origins.set(name, carried);
  }
  return pairs;
}

/**
 * The referee's reading of whether one value left the body.
 *
 * Only ever asked about a value the reader called **contained**, and only to
 * catch the reader being too generous. Text shapes, in the order a person would
 * scan for them.
 */
function refereeEscape(routine: RefereeBody, local: Local): string | undefined {
  const name = local.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const after = routine.lines.slice(Math.max(0, local.line - routine.line));
  for (const line of after) {
    /*
     * A second declaration of the name ends the scan rather than skipping the
     * line. The referee has no notion of scope, so past that point `custom`
     * means the other one -- and `readGraph` binds `custom` in three sibling
     * blocks, which is how a plain field read 120 lines later was reported as
     * this value being handed to a routine.
     *
     * Stopping is the conservative direction for a referee whose whole job is
     * catching the reader being too generous: it accuses only where the text is
     * unambiguous.
     */
    if (new RegExp(`(?:const|let|var|mut)\\s+${name}\\b`).test(line)) break;
    /*
     * A parameter is a re-binding too, and the `const` rule above cannot see
     * one. `generate-drizzle-schema.ts` binds `field` eight times as a lambda
     * parameter after binding it once in a loop, and past the first of those
     * every `field` on the page belongs to somebody else -- which is how a
     * value only ever read through its own fields was reported as handed away.
     */
    if (new RegExp(`[([,]\\s*${name}\\s*[),:]`).test(line)
      && /=>|\bfunction\b|\blambda\b|\bfn\b/.test(line)) break;

    /*
     * What sits *at* an index is not the index. `channels[ch][i]` is a sample
     * and `args[++i]` is an argument; both were read as the loop counter being
     * handed somewhere. Stripped repeatedly rather than once, because one pass
     * over `channels[ch][i]` leaves a bare `[i]` behind that reads as a list.
     */
    const values = line.replace(/\w+(?:\s*\[[^\]]*\])+/g, (at) => " ".repeat(at.length));
    /* `return provider()` hands back what it produced, not the routine itself. */
    const invoked = new RegExp(`\\b${name}\\s*\\(`).test(values);

    if (!invoked) {
      if (new RegExp(`\\breturn\\s+${name}\\b`).test(values)) return "returned";
      if (new RegExp(`\\b(?:throw|raise)\\s+${name}\\b`).test(values)) return "thrown";
      if (new RegExp(`\\byield\\s+${name}\\b`).test(values)) return "yielded";
    }
    /*
     * `a.b = v` stores v. `a.b = dims.width = v` does not store `dims` -- it
     * writes *into* it, and a chained assignment puts the second target on the
     * right of the first, exactly where a value would be.
     */
    const isTarget = new RegExp(`\\b${name}(?:\\s*\\.\\s*\\w+)*\\s*=[^=]`).test(values);
    if (!isTarget
      && new RegExp(`[\\w\\]]\\s*\\.\\s*\\w+\\s*=\\s*[^=]*\\b${name}\\b`).test(values)) {
      return "stored-in-a-field";
    }
    if (new RegExp(`\\b${name}\\s*\\.\\s*\\w+\\s*\\(`).test(line)) return "used-as-a-receiver";
    /*
     * Read through the same call scan the pair half uses, rather than with a
     * pattern of its own, because the pattern of its own did not know what a
     * keyword is: `if (opens)` matched `\w\(` and the referee reported every
     * flag in this repository as passed to a routine called `if`.
     *
     * A dotted `foo(bar.name)` is somebody else's field and not this value.
     */
    for (const call of values.matchAll(CALLED)) {
      if (NOT_A_CALL.has(call[1]!)) continue;
      if (new RegExp(`(?<![.\\w])${name}(?![\\w])`).test(call[2] ?? "")) return "passed-to-a-call";
    }
    /*
     * `[v, 1]` and `{ v }` put a value in a structure. Two things that look
     * exactly like that and do not:
     *
     *   `${v}`      prints it, and every interpolated value in this repository
     *               was being read as escaping into an object literal
     *   `mapping[v]` indexes with it, which is why an open bracket has to not
     *               have a name in front of it
     */
    if (new RegExp(`(?<![\\w\\])$])[[{]\\s*${name}\\s*[,\\]}]`).test(values)) {
      return "into-a-structure";
    }
    if (new RegExp(`,\\s*${name}\\s*[,\\]}]`).test(values)) return "into-a-structure";
  }
  return undefined;
}

/* ------------------------------------------------------------------- tally */

const LANGUAGES: Language[] = ["rust", "ts", "tsx", "python", "js"];

const files = new Map<Language, number>();
const routines = new Map<Language, number>();

/** 1 -- confirmation. */
const pairsAsked = new Map<Language, number>();
const pairsFar = new Map<Language, number>();
const oneHop = new Map<Language, number>();
const multiHop = new Map<Language, number>();
const gained: Array<{ file: string; line: number; producer: string; consumer: string; through: string[] }> = [];
/** The cost side: flows the shipped one-hop reader confirms and this one does not. */
const lost: Array<{ file: string; producer: string; consumer: string }> = [];
let invented = 0;

/** 2 -- refutation. */
const values = new Map<Language, number>();
const heldValues = new Map<Language, number>();
const escapedValues = new Map<Language, number>();
const withheldValues = new Map<Language, number>();
const reasons = new Map<Language, Map<string, number>>();
const refusals = new Map<string, number>();
const unreadShapes = new Map<string, number>();
/** Bodies with at least one value that never left them. */
const bodiesWithHeld = new Map<Language, number>();

/**
 * The vector case, counted separately.
 *
 * `v.push(widget); use(v[i])` is #203's own example of the wall, and the
 * question it raises is not "can a reader be written" -- it can, and it is --
 * but **how much of a real codebase is that shape**. Collections modelled,
 * values followed into one, and how many of those stayed: three numbers, because
 * following a value into a container buys nothing if the container leaves.
 */
const collections = new Map<Language, number>();
const collectionsHeld = new Map<Language, number>();
const putIn = new Map<Language, number>();
const putInHeld = new Map<Language, number>();
/** Values whose only escape is the collection they sit in leaving. */
const lostWithContainer = new Map<Language, number>();
const bodiesRead = new Map<Language, number>();

/** The referee disagreeing in the direction that can do damage. */
const leaked: Array<{ file: string; routine: string; name: string; line: number; saw: string }> = [];
/**
 * Disagreements the referee cannot settle, because the thing in dispute is the
 * collection abstraction itself.
 *
 * `const byId = new Map(); byId.set(k, v)` -- the reader says the Map did not
 * escape, and it is right: `set` puts something in and the Map stays. The
 * referee's rule is that a method call on a value might store it anywhere, and
 * it cannot know better without being told what a Map is.
 *
 * Teaching it would end its independence on exactly the axis it is meant to
 * check, so these are counted under their own name instead. **This is the one
 * part of the measurement no independent mechanism verifies**, and the number is
 * how much of the containment rests on it.
 */
const disputed: Array<{ file: string; routine: string; name: string; saw: string }> = [];
/** The reader saying gone where the referee sees nothing. Safe, and counted by reason. */
const unseenByReferee = new Map<string, number>();

const bump = <K,>(map: Map<K, number>, key: K, by = 1) =>
  map.set(key, (map.get(key) ?? 0) + by);

/** How many pairs one file may contribute, so one generated file cannot own the number. */
const MOST_PAIRS = 200;

for (const tree of trees) {
  for (const file of sourceFiles(tree)) {
    const language = languageOf(file)!;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (source.length > 400_000) continue;
    bump(files, language);

    const { bodies } = readBodies(source, language);
    const refereed = refereeBodies(source, language);
    bump(routines, language, bodies.length);

    /* ---- 2. what became of every value in every body ---- */
    for (const body of bodies) {
      /*
       * Routines only. A file's top level is a region the flow half reads, and
       * a module-level binding is visible to the whole file by construction --
       * counting one as "never left the body" would be counting the question
       * away rather than answering it.
       */
      if (body.scope !== "routine") continue;
      bump(bodiesRead, language);
      let anyHeld = false;
      const twin = refereed.find((one) => one.name === body.routine);
      for (const local of body.locals) {
        bump(values, language);
        /*
         * The vector case, tallied before the three outcomes below, because a
         * collection is also an ordinary value and gets counted in both.
         */
        if (local.collection) {
          bump(collections, language);
          if (contained(local) && !local.spilled) bump(collectionsHeld, language);
        }
        if (local.inside.length > 0) {
          bump(putIn, language);
          if (contained(local)) bump(putInHeld, language);
          else if (local.escapes.length === 1
            && local.escapes[0] === "left-inside-a-collection") {
            bump(lostWithContainer, language);
          }
        }
        if (local.why) {
          bump(withheldValues, language);
          bump(refusals, local.why);
          continue;
        }
        if (local.escapes.length === 0 && local.unread.length > 0) {
          bump(withheldValues, language);
          for (const shape of local.unread) bump(unreadShapes, shape);
          continue;
        }
        if (local.escapes.length > 0) {
          bump(escapedValues, language);
          const byReason = reasons.get(language) ?? new Map<string, number>();
          for (const reason of local.escapes) {
            byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
          }
          reasons.set(language, byReason);
          if (twin && !refereeEscape(twin, local)) bump(unseenByReferee, local.escapes[0]!);
          continue;
        }
        bump(heldValues, language);
        anyHeld = true;
        // The one disagreement that matters: the reader says nothing can have
        // left, and the text says something did.
        const saw = twin ? refereeEscape(twin, local) : undefined;
        if (!saw) continue;
        /*
         * Two shapes of disagreement are the abstraction rather than a leak: a
         * write method called on a modelled collection, and a value handed to
         * one of those writes. Both are cases where the referee's rule is
         * right in general and wrong about a Map.
         */
        const aboutCollections =
          (local.collection && saw === "used-as-a-receiver")
          || (local.inside.length > 0 && saw === "passed-to-a-call")
          || (local.readKey && saw === "passed-to-a-call");
        if (aboutCollections) {
          disputed.push({ file, routine: body.routine, name: local.name, saw });
          continue;
        }
        leaked.push({ file, routine: body.routine, name: local.name, line: local.line, saw });
      }
      if (anyHeld) bump(bodiesWithHeld, language);
    }

    /* ---- 1. how many more flows confirm ---- */
    const candidate = [{ path: path.relative(HOME, file), source, language }];
    let asked = 0;
    for (const routine of refereed) {
      if (asked >= MOST_PAIRS) break;
      /*
       * Every body in the file, not only the one whose name matches the
       * referee's. `checkFeeds` searches the whole file, so restricting this
       * reader to the matching routine measured a narrower question and came
       * back with a *negative* gain -- the new reader losing to the old one on
       * flows it could see perfectly well, in a method the text referee has no
       * pattern for. The comparison has to give both readers the same file.
       */
      for (const pair of refereePairs(routine)) {
        if (asked >= MOST_PAIRS) break;
        asked += 1;
        bump(pairsAsked, language);
        if (pair.hops > 1) bump(pairsFar, language);
        const shipped = checkFeeds(
          { symbols: [pair.producer] },
          { symbols: [pair.consumer] },
          candidate,
        ).verdict === "confirmed";
        if (shipped) bump(oneHop, language);
        let chain: ReturnType<typeof chainFrom>;
        for (const body of bodies) {
          chain = chainFrom(body, [pair.producer], [pair.consumer]);
          if (chain) break;
        }
        if (chain) bump(multiHop, language);
        if (shipped && !chain && lost.length < 4000) {
          lost.push({
            file: path.relative(HOME, file),
            producer: pair.producer,
            consumer: pair.consumer,
          });
        }
        if (chain && !shipped && gained.length < 4000) {
          gained.push({
            file: path.relative(HOME, file),
            line: chain.line,
            producer: chain.producer,
            consumer: chain.consumer,
            through: chain.through,
          });
        }
      }
      /*
       * The other direction, without which the confirmation number is agreement
       * with itself: a name the body never calls must never come back with a
       * chain. The mistake that got two orders of magnitude into #190.
       */
      for (const body of bodies.filter((one) => one.routine === routine.name)) {
        if (chainFrom(body, ["ZzNotARealProducer"], ["ZzNotARealConsumer"])) invented += 1;
      }
    }
  }
}

/* ------------------------------------------------------------------ report */

const percent = (part: number, whole: number) =>
  whole === 0 ? "   n/a" : `${((part / whole) * 100).toFixed(1)}%`.padStart(6);
const total = (map: Map<Language, number>) => [...map.values()].reduce((a, b) => a + b, 0);

console.log();
console.log("MEASURE DATAFLOW -- what following a value through one body buys");
console.log(`  ${trees.length} trees, ${total(files)} files, ${total(routines)} bodies read`);
console.log("  A body is a routine or a file's top level. The escape half reads routines only.");
console.log("  Locals only. No call is resolved; a value handed to a routine is counted as gone.");
console.log();

console.log("1 · CONFIRMATION GAIN -- @feeds arrows that go from unconfirmed to confirmed");
console.log();
console.log("  Boards: the corpus carries 0 @feeds arrows -- 13 claims across 19 boards, all of");
console.log("  them @takes, @needs and @returns. There is no board number to report, and that is");
console.log("  itself the finding: the word nobody draws is the one dataflow would improve.");
console.log();
console.log("  " + "language".padEnd(10) + "files".padStart(7) + "pairs".padStart(8)
  + "2+ hops".padStart(9) + "one-hop".padStart(9) + "this".padStart(8)
  + "gain".padStart(8) + "  of pairs");
for (const language of LANGUAGES) {
  const asked = pairsAsked.get(language) ?? 0;
  if (asked === 0 && (files.get(language) ?? 0) === 0) continue;
  const before = oneHop.get(language) ?? 0;
  const after = multiHop.get(language) ?? 0;
  console.log("  " + language.padEnd(10)
    + String(files.get(language) ?? 0).padStart(7)
    + String(asked).padStart(8)
    + String(pairsFar.get(language) ?? 0).padStart(9)
    + String(before).padStart(9)
    + String(after).padStart(8)
    + String(after - before).padStart(8)
    + "  " + percent(after - before, asked));
}
console.log("  " + "all".padEnd(10)
  + String(total(files)).padStart(7)
  + String(total(pairsAsked)).padStart(8)
  + String(total(pairsFar)).padStart(9)
  + String(total(oneHop)).padStart(9)
  + String(total(multiHop)).padStart(8)
  + String(total(multiHop) - total(oneHop)).padStart(8)
  + "  " + percent(total(multiHop) - total(oneHop), total(pairsAsked)));
console.log();
console.log(`  INVENTED -- a chain for names the body never calls: ${invented}. The bar is zero.`);
console.log();
console.log(`  GAINED -- flows the shipped one-hop reader cannot see: ${gained.length}`);
for (const one of gained.slice(0, 15)) {
  const through = one.through.length > 0 ? one.through.join(" -> ") : "handed straight over";
  console.log(`    ${one.file}:${one.line} ${one.producer} -> ${one.consumer}  (${through})`);
}
if (gained.length > 15) console.log(`    ... and ${gained.length - 15} more`);
console.log();
console.log(`  LOST -- the shipped one-hop reader confirms these and this one does not: ${lost.length}`);
console.log("    The cost of scoping the search to a body instead of a file. Named, because a");
console.log("    gain quoted without its cost is half a measurement.");
for (const one of lost.slice(0, 10)) {
  console.log(`    ${one.file} ${one.producer} -> ${one.consumer}`);
}
if (lost.length > 10) console.log(`    ... and ${lost.length - 10} more`);

console.log();
console.log("2 · REFUTATION GAIN -- values that provably never leave the body they were made in");
console.log("  Three outcomes, never two. `withheld` is the doubt, and it counts against");
console.log("  `contained` rather than being rounded away: contained is a floor.");
console.log();
console.log("  " + "language".padEnd(10) + "bodies".padStart(8) + "values".padStart(8)
  + "contained".padStart(11) + "share".padStart(8) + "escaped".padStart(9)
  + "withheld".padStart(10) + "  bodies with one");
for (const language of LANGUAGES) {
  const seen = values.get(language) ?? 0;
  if (seen === 0 && (files.get(language) ?? 0) === 0) continue;
  const bodies = bodiesRead.get(language) ?? 0;
  console.log("  " + language.padEnd(10)
    + String(bodies).padStart(8)
    + String(seen).padStart(8)
    + String(heldValues.get(language) ?? 0).padStart(11)
    + percent(heldValues.get(language) ?? 0, seen).padStart(8)
    + String(escapedValues.get(language) ?? 0).padStart(9)
    + String(withheldValues.get(language) ?? 0).padStart(10)
    + "  " + percent(bodiesWithHeld.get(language) ?? 0, bodies));
}
console.log("  " + "all".padEnd(10)
  + String(total(bodiesRead)).padStart(8)
  + String(total(values)).padStart(8)
  + String(total(heldValues)).padStart(11)
  + percent(total(heldValues), total(values)).padStart(8)
  + String(total(escapedValues)).padStart(9)
  + String(total(withheldValues)).padStart(10)
  + "  " + percent(total(bodiesWithHeld), total(bodiesRead)));

console.log();
console.log("  THE VECTOR CASE -- `v.push(widget); use(v[i])`, which is #203's own example");
console.log("  A collection is modelled only where this body watched it being made, so its");
console.log("  type is in the text. One bound from an ordinary call gets nothing.");
console.log();
console.log("  " + "language".padEnd(10) + "collections".padStart(12) + "stayed".padStart(8)
  + "share".padStart(8) + "  " + "values put in".padStart(14) + "stayed".padStart(8)
  + "share".padStart(8) + "  lost with it");
for (const language of LANGUAGES) {
  const made = collections.get(language) ?? 0;
  if (made === 0 && (putIn.get(language) ?? 0) === 0) continue;
  const inside = putIn.get(language) ?? 0;
  console.log("  " + language.padEnd(10)
    + String(made).padStart(12)
    + String(collectionsHeld.get(language) ?? 0).padStart(8)
    + percent(collectionsHeld.get(language) ?? 0, made).padStart(8)
    + "  " + String(inside).padStart(14)
    + String(putInHeld.get(language) ?? 0).padStart(8)
    + percent(putInHeld.get(language) ?? 0, inside).padStart(8)
    + "  " + String(lostWithContainer.get(language) ?? 0).padStart(6));
}
console.log("  " + "all".padEnd(10)
  + String(total(collections)).padStart(12)
  + String(total(collectionsHeld)).padStart(8)
  + percent(total(collectionsHeld), total(collections)).padStart(8)
  + "  " + String(total(putIn)).padStart(14)
  + String(total(putInHeld)).padStart(8)
  + percent(total(putInHeld), total(putIn)).padStart(8)
  + "  " + String(total(lostWithContainer)).padStart(6));
console.log();
console.log("  `lost with it` is the price of the whole idea: a value followed into a container");
console.log("  and then counted as gone anyway, because the container did not stay. Following");
console.log("  it in bought nothing for those, and they are what says whether this is worth it.");

console.log();
console.log("  WHERE THE VALUES WENT -- by name, because one shape and twenty are different facts");
const everyReason = new Map<string, number>();
for (const byLanguage of reasons.values()) {
  for (const [reason, count] of byLanguage) {
    everyReason.set(reason, (everyReason.get(reason) ?? 0) + count);
  }
}
const escapes = [...everyReason.values()].reduce((a, b) => a + b, 0);
for (const [reason, count] of [...everyReason.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${reason.padEnd(24)} ${String(count).padStart(8)}  ${percent(count, escapes)}`
    + `  ${LANGUAGES.filter((one) => (reasons.get(one)?.get(reason) ?? 0) > 0)
      .map((one) => `${one} ${reasons.get(one)!.get(reason)}`).join(", ")}`);
}

console.log();
console.log("  WITHHELD -- the doubt, by reason");
for (const [why, count] of [...refusals.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${why.padEnd(24)} ${String(count).padStart(8)}`);
}
const unreadTotal = [...unreadShapes.values()].reduce((a, b) => a + b, 0);
console.log(`    ${"a use not recognised".padEnd(24)} ${String(unreadTotal).padStart(8)}`
  + `  by the syntax around it, top shapes:`);
for (const [shape, count] of [...unreadShapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`      ${shape.padEnd(30)} ${String(count).padStart(7)}`);
}

console.log();
console.log("REFEREE -- the same values read out of the text, sharing no machinery");
console.log(`  LEAKED -- reader said contained, text says it left: ${leaked.length}`);
console.log("    The bar is zero. Each one is a claim that an absence is proof, and it is not.");
for (const one of leaked.slice(0, 20)) {
  console.log(`    ${one.file}:${one.line} ${one.routine} / ${one.name} -- text reads ${one.saw}`);
}
if (leaked.length > 20) console.log(`    ... and ${leaked.length - 20} more`);
console.log();
console.log(`  UNREFEREED -- the collection abstraction itself: ${disputed.length}`);
console.log("    The referee says a method call on a value might store it, which is right in");
console.log("    general and wrong about a Map. Teaching it what a Map is would end its");
console.log("    independence on the one axis it is here to check, so these are named rather");
console.log("    than settled. This is the part of the measurement nothing else verifies.");
for (const one of disputed.slice(0, 8)) {
  console.log(`    ${path.relative(HOME, one.file)} ${one.routine} / ${one.name}`
    + ` -- text reads ${one.saw}`);
}
if (disputed.length > 8) console.log(`    ... and ${disputed.length - 8} more`);
console.log();
const unseen = [...unseenByReferee.values()].reduce((a, b) => a + b, 0);
console.log(`  Reader said gone where the text sees nothing: ${unseen}`
  + ` of ${total(escapedValues)} (${percent(unseen, total(escapedValues)).trim()}).`);
console.log("  Not a bug and not free: every one is a value counted out of a floor. By reason,");
console.log("  because the referee has no pattern at all for a closure capture and a fair share");
console.log("  of this column is that rather than a disagreement:");
for (const [reason, count] of [...unseenByReferee.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${reason.padEnd(24)} ${String(count).padStart(8)}`
    + `  of ${everyReason.get(reason) ?? 0}`);
}
console.log();
