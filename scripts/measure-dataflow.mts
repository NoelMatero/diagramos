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

import { bindingsIn, callsBetween, type Bindings, type CallSide } from "../src/engine/calls";
import { type ConfigCache } from "../src/engine/resolve";
import {
  chainFrom, contained, readBodies, settleCalls,
  type Body, type Callee, type Local, type Resolver,
} from "../src/engine/dataflow";
import { readDependencies } from "../src/engine/deps";
import { createWorkspace } from "../src/engine/drift";
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

  /*
   * Comments, and the marker is not the same in every language. `//` opens one
   * in the C family and is floor division in Python, so stripping both
   * everywhere turned `return chars // _CHARS_PER_TOKEN` into `return chars`
   * and reported a computed number as the value being handed back.
   */
  const comment = language === "python" ? /#.*$/ : /\/\/.*$/;
  const lines = source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(comment, ""))
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
/** What the referee made of one value: whether it saw it, and whether it left. */
interface RefereeReading {
  /**
   * Whether the name is used at all after its binding, in the lines this
   * referee is willing to read.
   *
   * The number this exists for: "the referee found nothing" is two situations
   * wearing one answer. It looked, saw the value used, and every use was
   * harmless -- that is agreement, and it is the only kind worth counting. Or
   * it never saw the name again, in which case it has no opinion, and counting
   * that as agreement inflates the check into saying nothing at all.
   */
  seen: boolean;
  /** How it left, if the text shows it leaving. */
  left?: string;
}

function refereeEscape(routine: RefereeBody, local: Local): RefereeReading {
  const name = local.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const after = routine.lines.slice(Math.max(0, local.line - routine.line));
  const mentions = new RegExp(`(?<![.\\w])${name}(?![\\w])`);
  let seen = false;
  for (const [where, line] of after.entries()) {
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
    // Read on the whole line rather than on `values`: a value used only as
    // an index is still one this referee looked at and had an opinion about.
    if (mentions.test(line)) seen = true;
    /* `return provider()` hands back what it produced, not the routine itself. */
    const invoked = new RegExp(`\\b${name}\\s*\\(`).test(values);

    /*
     * `return owner.root` hands back the property, not the object -- so the
     * name must not be followed by a dot. Same for an argument: `foo(obj.field)`
     * passes the field. A text fact rather than an abstraction, so the referee
     * can check it and stays independent.
     */
    /*
     * And the same rule for what is handed back: the name has to be the whole
     * returned expression. `return scaled <= x ? a : b` returns a number
     * computed from `scaled`, and `return owner.root` returns a property --
     * both were read as the value itself being handed out.
     */
    /*
     * And not the head of a method chain that runs onto the next line.
     * `return reasons` followed by `.filter(..).join(",")` returns a string
     * built from `reasons`, not `reasons` -- and the referee reads one line at a
     * time, so the continuation is the only thing that says so.
     */
    const continues = /^\s*[.?]/.test(after[where + 1] ?? "");
    if (!invoked && !continues) {
      const whole = (keyword: string) =>
        new RegExp(`\\b${keyword}\\s+${name}\\s*;?\\s*$`).test(values.trimEnd());
      if (whole("return")) return { seen, left: "returned" };
      if (whole("throw") || whole("raise")) return { seen, left: "thrown" };
      if (whole("yield")) return { seen, left: "yielded" };
    }
    /*
     * `a.b = v` stores v. `a.b = dims.width = v` does not store `dims` -- it
     * writes *into* it, and a chained assignment puts the second target on the
     * right of the first, exactly where a value would be.
     */
    /*
     * And once more the whole-name rule. `next.strokeStyle = stroke.strokeStyle`
     * stores a property of `stroke`, not `stroke`, and `state.revision =
     * revisionOf(live.board)` stores neither. Only the right-hand side being
     * exactly the name is the value going in.
     */
    const isTarget = new RegExp(`\\b${name}(?:\\s*\\.\\s*\\w+)*\\s*=[^=]`).test(values);
    if (!isTarget
      && new RegExp(`[\\w\\]]\\s*\\.\\s*\\w+\\s*=\\s*${name}\\s*;?\\s*$`)
        .test(values.trimEnd())) {
      return { seen, left: "stored-in-a-field" };
    }
    /*
     * And not a name that is itself somebody's property. `parent.parent.resolve()`
     * calls a method on `parent.parent`, and the `\b` alone matched the second
     * `parent` -- so a property read two deep was reported as the original value
     * being used as a receiver.
     */
    if (new RegExp(`(?<![.\\w])${name}\\s*\\.\\s*\\w+\\s*\\(`).test(values)) {
      return { seen, left: "used-as-a-receiver" };
    }
    /*
     * Read through the same call scan the pair half uses, rather than with a
     * pattern of its own, because the pattern of its own did not know what a
     * keyword is: `if (opens)` matched `\w\(` and the referee reported every
     * flag in this repository as passed to a routine called `if`.
     *
     * A dotted `foo(bar.name)` is somebody else's field and not this value.
     */
    /*
     * The name has to be the *whole* argument, not a piece of one.
     *
     * `Math.round(seconds / 60)` passes a number computed from `seconds`;
     * `foo(obj.field)` passes the field. Both were being read as the value
     * itself being handed over. Comparing whole arguments is stricter than any
     * of the patterns that came before it and subsumes them, and it is still a
     * plain text fact -- no notion of what an operator does gets imported.
     */
    for (const call of values.matchAll(CALLED)) {
      if (NOT_A_CALL.has(call[1]!)) continue;
      const given = (call[2] ?? "").split(",").map((one) => one.trim());
      if (given.includes(local.name)) return { seen, left: "passed-to-a-call" };
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
    /*
     * A call whose arguments run onto the next line looks exactly like a list.
     * `_record_node(target, n, sign, weight, date,` has no closing paren, so
     * the call scan above -- which needs one -- skips it and `, sign,` reads as
     * a structure literal. An unclosed paren to the left of the name says which
     * it is, and it says so from the text alone.
     */
    const opensCall = new RegExp(
      `\\b(\\w+)\\s*\\(([^)]*[(,]\\s*${name}\\s*[,)])`,
    ).exec(values);
    /*
     * Unless the argument is a comprehension. `sum(1 for t in terms if t in
     * label)` hands `sum` a generator, and what the generator does with `label`
     * is a comparison -- so the name is inside the call's parentheses and is not
     * one of its arguments. The referee cannot read that and declines rather
     * than claiming it.
     *
     * And the name has to be a whole argument here too, which is why a comma or
     * an open paren has to sit immediately before it: `sum((c / n) * log(c / n))`
     * puts `n` inside the parentheses of a call and passes it to nothing.
     */
    if (opensCall && !NOT_A_CALL.has(opensCall[1]!) && !/\bfor\b/.test(opensCall[2] ?? "")) {
      return { seen, left: "passed-to-a-call" };
    }
    if (new RegExp(`(?<![\\w\\])$])[[{]\\s*${name}\\s*[,\\]}]`).test(values)) {
      return { seen, left: "into-a-structure" };
    }
    if (new RegExp(`,\\s*${name}\\s*[,\\]}]`).test(values)) return { seen, left: "into-a-structure" };
  }
  return { seen };
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
 * Contained values that are actually used somewhere after being made.
 *
 * The share above quietly includes every value bound and then never touched
 * again. Those never leave, correctly and for no interesting reason -- nothing
 * can be refuted about a value nobody uses. This is the number a word would
 * rest on, and it is the smaller one.
 */
const heldAndUsed = new Map<Language, number>();

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
/**
 * Methods on a known collection that no table in `dataflow.ts` classifies.
 *
 * The tables saying `push` appends and `get` reads are the part of this that no
 * structural rule reaches -- library knowledge, not grammar -- so they cannot
 * be derived and can only be shown. An unclassified method falls through to
 * "a method was called on it, which might store it", which counts the
 * collection as escaping: a missing entry quietly *lowers* the number for
 * whichever language spells that operation differently.
 *
 * Printed by name and by count, so the edge of the table is a number somebody
 * can argue with. `docs/reading-a-grammar.md` is why.
 */
const unknownMethods = new Map<string, number>();
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
/**
 * Disagreements that rest on having read another routine's body.
 *
 * The referee sees a value handed to a call and says it left. The reader read
 * the callee and says it did not. Nothing here can settle that: a text scan
 * that reads callee bodies *is* this analysis, so it would share the machinery
 * it is meant to check. Counted apart from the collection disputes, because
 * they are two different unverified things.
 */
const acrossACall: Array<{ file: string; routine: string; name: string }> = [];
/** The reader saying gone where the referee sees nothing. Safe, and counted by reason. */
const unseenByReferee = new Map<string, number>();
/**
 * What the referee did about each value the reader called contained.
 *
 * `agreed` is the only one that is a check: the referee read the routine, saw
 * the value used, and every use it recognised was harmless. `no opinion` is the
 * referee never seeing the name again after its binding, which is not agreement
 * and was previously being counted alongside it -- so "0 disagreements" was
 * being quoted without the denominator that makes it mean anything.
 *
 * `no routine` is the referee's own crude reader failing to find the routine at
 * all, which is a gap in the referee rather than a fact about the value.
 */
const refereeSaid = new Map<string, number>();

const bump = <K,>(map: Map<K, number>, key: K, by = 1) =>
  map.set(key, (map.get(key) ?? 0) + by);

/* ------------------------------------------------------- across a call */

/**
 * Values a resolved call stopped being an exit for, and why the rest did not.
 *
 * 42.4% of every value in the corpus escapes because it was handed to a routine
 * and nothing could follow the call. #189 made a call's *name* resolvable, so
 * the question is now answerable and this is the answer.
 */
const freed = new Map<Language, number>();
const freedSpilling = new Map<Language, number>();
const stillOut = new Map<string, number>();
/** Callees resolved to a routine, and how the resolution was reached. */
const resolvedHow = new Map<string, number>();
/**
 * The resolution half, checked against #189's reader.
 *
 * `callsBetween` was measured over 6,654 calls at 0 missed and 0 wrongly
 * accused, so it is a referee for the one half of this that has one: if it
 * cannot confirm the call this resolver claims to have followed, the resolution
 * is wrong. The *escape* half has no independent referee and is counted apart --
 * a text scan cannot read a callee's body without becoming this analysis.
 */
const resolutionChecked = new Map<string, number>();
const resolutionDisputed: Array<{ file: string; routine: string; callee: string }> = [];

/** One repository's lazily-built index: sources, bindings, bodies, imports. */
function indexOf(tree: string) {
  const workspace = createWorkspace(tree);
  const configs: ConfigCache = new Map();
  const sources = new Map<string, string | undefined>();
  const bindings = new Map<string, Bindings | undefined>();
  const bodies = new Map<string, Body[]>();
  const importsOf = new Map<string, CallSide["imports"]>();

  const read = (rel: string): string | undefined => {
    if (sources.has(rel)) return sources.get(rel);
    const absolute = workspace.resolve(rel);
    const text = absolute && workspace.stat(absolute) === "file"
      ? workspace.read(absolute)
      : undefined;
    sources.set(rel, text);
    return text;
  };

  const bindingsFor = (rel: string): Bindings | undefined => {
    if (bindings.has(rel)) return bindings.get(rel);
    const source = read(rel);
    const language = languageOf(rel);
    const found = source !== undefined && language
      ? bindingsIn(source, language)
      : undefined;
    bindings.set(rel, found);
    return found;
  };

  const bodiesFor = (rel: string): Body[] => {
    const cached = bodies.get(rel);
    if (cached) return cached;
    const source = read(rel);
    const language = languageOf(rel);
    const found = source !== undefined && language && source.length <= 400_000
      ? readBodies(source, language).bodies
      : [];
    bodies.set(rel, found);
    return found;
  };

  const importsFor = (rel: string): CallSide["imports"] => {
    const cached = importsOf.get(rel);
    if (cached) return cached;
    const source = read(rel);
    const declared = source === undefined
      ? []
      : readDependencies(rel, source, workspace, configs)?.dependencies ?? [];
    const list = declared.map((one) =>
      ({ specifier: one.specifier, ...(one.file ? { file: one.file } : {}) }));
    importsOf.set(rel, list);
    return list;
  };

  /** The routine of that name in that file, if exactly one body carries it. */
  const routineIn = (rel: string, name: string): Callee | undefined => {
    const found = bodiesFor(rel).filter((one) => one.routine === name);
    // Two routines of one name in one file is a question with two answers, and
    // picking one would be inventing the resolution rather than reading it.
    return found.length === 1 ? { body: found[0]!, file: rel } : undefined;
  };

  /**
   * Which routine a called name means, read the way `calls.ts` reads a binding.
   *
   * Three answers and a refusal. Declared here, imported from a file this
   * repository holds, or forwarded through one barrel -- and `undefined` for
   * everything else, which is what keeps a call an exit. A name bound twice, or
   * brought in by a wildcard, is a refusal on the same footing `calls.ts`
   * refuses it: the text does not say which.
   */
  const resolver = (rel: string): Resolver => (callee: string) => {
    const bound = bindingsFor(rel);
    if (!bound || bound.wildcard || bound.ambiguous.has(callee)) return undefined;

    if (bound.local.has(callee)) {
      const own = routineIn(rel, callee);
      if (own) bump(resolvedHow, "declared here");
      return own;
    }

    const imported = bound.imported.get(callee);
    if (!imported || imported.namespace) return undefined;
    const from = importsFor(rel).find((one) => one.specifier === imported.specifier);
    if (!from?.file) return undefined;

    const direct = routineIn(from.file, callee);
    if (direct) { bump(resolvedHow, "imported"); return direct; }

    /*
     * One hop through a barrel, which `calls.ts` needed for the same reason:
     * `from graphify.extract import extract_objc` where `extract.py` re-exports
     * what `extractors/objc.py` declares. One hop and no further -- a chain of
     * barrels is a call graph, and that is the line this does not cross.
     */
    const onward = bindingsFor(from.file)?.forwarded.get(callee);
    if (!onward) return undefined;
    const next = importsFor(from.file).find((one) => one.specifier === onward.specifier);
    if (!next?.file) return undefined;
    const forwarded = routineIn(next.file, callee);
    if (forwarded) bump(resolvedHow, "forwarded once");
    return forwarded;
  };

  /** #189's reader, asked whether the call this resolver followed is there. */
  const confirms = (rel: string, routine: string, callee: Callee): boolean => {
    const source = read(rel);
    const target = read(callee.file);
    const language = languageOf(rel);
    const targetLanguage = languageOf(callee.file);
    if (source === undefined || target === undefined || !language || !targetLanguage) {
      return true; // Nothing to check against is not a disagreement.
    }
    const verdict = callsBetween(
      { file: rel, source, language, imports: importsFor(rel), routine },
      { file: callee.file, source: target, language: targetLanguage,
        imports: importsFor(callee.file), names: [callee.body.routine] },
    );
    // `withheld` is a doubt rather than a contradiction, and this reader has its
    // own reasons to withhold that say nothing about the resolution.
    return verdict.verdict !== "backwards" && verdict.verdict !== "absent";
  };

  return { resolver, confirms, read, bodiesFor };
}

/** How many pairs one file may contribute, so one generated file cannot own the number. */
const MOST_PAIRS = 200;

for (const tree of trees) {
  const index = indexOf(tree);

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
    const rel = path.relative(tree, file);
    const resolve = index.resolver(rel);
    for (const body of bodies) {
      /*
       * Settle the calls first, so what follows counts what is left. A value
       * handed only to routines that provably keep it stops being an exit here,
       * and every other reason it might have left is untouched.
       */
      if (body.scope === "routine") {
        const settled = settleCalls(body, resolve);
        bump(freed, language, settled.freed);
        bump(freedSpilling, language, settled.freedSpilling);
        for (const [why, count] of settled.why) bump(stillOut, why, count);

        /*
         * And check the resolution half against #189's reader, on the calls
         * this one claims to have followed. Sampled rather than exhaustive:
         * `callsBetween` re-reads and re-parses both files, and running it on
         * every call site in the corpus turns a two-minute measurement into an
         * afternoon. One in twenty is enough to catch a resolver that is wrong
         * in general, which is what this is looking for.
         */
        for (const call of body.calls) {
          if (!call.callee || Math.random() > 0.05) continue;
          const found = resolve(call.callee);
          if (!found) continue;
          bump(resolutionChecked, "asked");
          if (index.confirms(rel, body.routine, found)) {
            bump(resolutionChecked, "agreed");
          } else {
            resolutionDisputed.push({ file: rel, routine: body.routine, callee: call.callee });
          }
        }
      }
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
          if (twin && !refereeEscape(twin, local).left) {
            bump(unseenByReferee, local.escapes[0]!);
          }
          continue;
        }
        bump(heldValues, language);
        if (local.everRead) bump(heldAndUsed, language);
        anyHeld = true;
        // The one disagreement that matters: the reader says nothing can have
        // left, and the text says something did.
        const reading = twin ? refereeEscape(twin, local) : undefined;
        if (!reading) { bump(refereeSaid, "no routine"); continue; }
        const saw = reading.left;
        if (!saw) {
          bump(refereeSaid, reading.seen ? "agreed" : "no opinion");
          continue;
        }
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
        /*
         * And the interprocedural claim, which is the other thing no text scan
         * can settle: the reader read the callee's body and the referee cannot.
         * Counted apart from the collection disputes because it is a different
         * unverified thing, and the two numbers should not be one.
         */
        /*
         * Any reason, not only `passed-to-a-call`. The referee is looking at a
         * call this reader followed into, and what it calls that call is its own
         * business -- a multi-line one reads as a list. The unverifiable thing
         * is the same either way: a callee's body was read.
         */
        if (local.freedByCall) {
          acrossACall.push({ file, routine: body.routine, name: local.name });
          continue;
        }
        leaked.push({ file, routine: body.routine, name: local.name, line: local.line, saw });
      }
      for (const method of body.unknownMethods) bump(unknownMethods, method.name);
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
console.log("  AND OF THOSE, THE ONES ANYTHING IS EVER DONE WITH");
console.log("  " + "language".padEnd(10) + "contained".padStart(11) + "also used".padStart(11)
  + "share of all".padStart(14));
for (const language of LANGUAGES) {
  const held = heldValues.get(language) ?? 0;
  if (held === 0) continue;
  console.log("  " + language.padEnd(10)
    + String(held).padStart(11)
    + String(heldAndUsed.get(language) ?? 0).padStart(11)
    + percent(heldAndUsed.get(language) ?? 0, values.get(language) ?? 0).padStart(14));
}
console.log("  " + "all".padEnd(10)
  + String(total(heldValues)).padStart(11)
  + String(total(heldAndUsed)).padStart(11)
  + percent(total(heldAndUsed), total(values)).padStart(14));
console.log();
console.log("  A value bound and never touched again never leaves, correctly and for no");
console.log("  interesting reason -- nothing can be refuted about a value nobody uses. The");
console.log("  right-hand column is what a word built on this would actually rest on, and it");
console.log("  is the smaller number. Quote it rather than the one above.");

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
const unknownTotal = [...unknownMethods.values()].reduce((a, b) => a + b, 0);
console.log(`  THE TABLE'S OWN EDGE -- methods on a collection nothing here classifies: ${unknownTotal}`);
console.log("  That `push` appends and `get` reads is knowledge about a standard library, not");
console.log("  about a grammar, so it is a table and no structural rule derives one. What a");
console.log("  table can do is show where it stops. Each of these falls through to \"a method");
console.log("  was called on it\", which counts the collection as gone -- so a missing entry");
console.log("  lowers the number rather than raising it, and does so silently.");
for (const [name, count] of [...unknownMethods.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`    ${name.padEnd(24)} ${String(count).padStart(6)}`);
}
if (unknownMethods.size > 15) {
  console.log(`    ... and ${unknownMethods.size - 15} more distinct methods`);
}

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
console.log("3 · ACROSS A CALL -- the 42% that escaped because no call could be followed");
console.log("  #189 made a call's name resolvable, so the question is answerable: does the");
console.log("  callee let the argument out? A value stops escaping only when EVERY call it was");
console.log("  handed to resolves, reads cleanly, and keeps its argument.");
console.log();
console.log("  " + "language".padEnd(10) + "freed".padStart(8) + "of values".padStart(11)
  + "  " + "cleanly".padStart(9) + "contents out".padStart(14));
for (const language of LANGUAGES) {
  const gained = freed.get(language) ?? 0;
  if (gained === 0 && (values.get(language) ?? 0) === 0) continue;
  const spilling = freedSpilling.get(language) ?? 0;
  console.log("  " + language.padEnd(10)
    + String(gained).padStart(8)
    + percent(gained, values.get(language) ?? 0).padStart(11)
    + "  " + String(gained - spilling).padStart(9)
    + String(spilling).padStart(14));
}
console.log("  " + "all".padEnd(10)
  + String(total(freed)).padStart(8)
  + percent(total(freed), total(values)).padStart(11)
  + "  " + String(total(freed) - total(freedSpilling)).padStart(9)
  + String(total(freedSpilling)).padStart(14));
console.log();
console.log("  `contents out` is the honest half of the gain: the value stayed in its body and");
console.log("  the callee read a property out of it and passed that on. \"It never left\" holds;");
console.log("  \"everything in it is enumerable\" does not, and the two are different claims.");

console.log();
console.log("  STILL AN EXIT -- why a call could not be followed, by name");
const blockedTotal = [...stillOut.values()].reduce((a, b) => a + b, 0);
for (const [why, count] of [...stillOut.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${why.padEnd(24)} ${String(count).padStart(8)}  ${percent(count, blockedTotal)}`);
}
console.log();
console.log("  `callee-not-resolved` is two things this cannot tell apart: a routine in a file");
console.log("  nothing here holds, and a builtin. `len(x)` and `println!` are not a missing");
console.log("  call graph, and counting them as one would overstate what #189 left undone.");
console.log();
console.log("  RESOLVED HOW");
for (const [how, count] of [...resolvedHow.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${how.padEnd(24)} ${String(count).padStart(8)}`);
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
const asked = resolutionChecked.get("asked") ?? 0;
const agreed = resolutionChecked.get("agreed") ?? 0;
console.log(`  RESOLUTION -- checked against \`calls.ts\`, which has its own licence: ${agreed}/${asked}`);
console.log("    A 5% sample of the calls this resolver followed, put to #189's reader -- 6,654");
console.log("    calls at 0 missed and 0 wrongly accused, and the only independent check");
console.log("    available for the half that has one. A disagreement is this resolver naming");
console.log("    the wrong routine.");
for (const one of resolutionDisputed.slice(0, 8)) {
  console.log(`    ${one.file} ${one.routine} -> ${one.callee}`);
}
if (resolutionDisputed.length > 8) {
  console.log(`    ... and ${resolutionDisputed.length - 8} more`);
}
console.log();
console.log("    The *escape* half has no referee and cannot have one: reading a callee's body");
console.log("    to see whether it keeps an argument is this analysis, so a second mechanism");
console.log("    doing it would share the machinery it is meant to check. Every value in the");
console.log("    `freed` column above rests on that, and this is the sentence saying so.");

console.log();
const refereeAgreed = refereeSaid.get("agreed") ?? 0;
const noOpinion = refereeSaid.get("no opinion") ?? 0;
const noRoutine = refereeSaid.get("no routine") ?? 0;
const checkable = refereeAgreed + leaked.length + acrossACall.length + disputed.length;
console.log("  AND HOW MUCH IT CHECKED, without which the `0` above says nothing");
console.log(`    ${String(refereeAgreed).padStart(6)}  agreed -- read the routine, saw the value used, and every`);
console.log("            use it recognised was harmless. This is the check.");
console.log(`    ${String(noOpinion).padStart(6)}  never seen again -- the name does not appear after its`);
console.log("            binding, or the scan stopped at a re-binding before it did");
console.log(`    ${String(noRoutine).padStart(6)}  no routine -- the referee's own crude reader could not find`);
console.log("            the body at all, which is a gap in the referee");
console.log(`    ${String(checkable).padStart(6)}  of ${total(heldValues)} contained values it had any opinion about`
  + ` (${percent(checkable, total(heldValues)).trim()})`);
console.log();
console.log("    The middle row is not a failure and not a check either, and it is worth being");
console.log("    exact about which. A value whose name never appears again cannot have gone");
console.log("    anywhere, so the reader is right about it -- trivially, and for the same");
console.log("    reason the referee has nothing to say. It counts towards `contained` and it");
console.log("    is the least interesting kind: nothing can be refuted about a value nobody");
console.log("    touches. Read the headline share with that in mind.");

console.log();
console.log(`  UNREFEREED -- having read another routine's body: ${acrossACall.length}`);
console.log("    The referee sees the call and says the value left; the reader read the callee");
console.log("    and says it did not. See the note above: this half cannot have a referee.");
for (const one of acrossACall.slice(0, 6)) {
  console.log(`    ${path.relative(HOME, one.file)} ${one.routine} / ${one.name}`);
}
if (acrossACall.length > 6) console.log(`    ... and ${acrossACall.length - 6} more`);

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
