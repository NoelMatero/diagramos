#!/usr/bin/env node
/**
 * Does this value reach a door, and can the claim be corroborated? (#203, #270)
 *
 *   npm run measure:outflow              -- the seven default trees
 *   npm run measure:outflow -- <path>... -- any trees you like
 *
 * `outflow.ts` joins two readers that already existed: `dataflow.ts`, which
 * follows a value through the locals of one body and models a collection as one
 * value, and `outside.ts`, which knows which calls touch files, the network and
 * other processes. The claim it makes is the one #203 keeps arriving at --
 * **this value is created here, and it ends up written out** -- and it is a
 * confirmation, never a refutation.
 *
 * ## The bar is `invented`, because confirming is the only thing this does
 *
 * A door the reader fails to see costs silence, and the engine accepts silence
 * everywhere. The direction that can do damage is the other one: a path the
 * reader draws that is not in the code. So the referee is pointed there, and the
 * bar is **zero invented**.
 *
 * ## The referee, and what it can actually check
 *
 * A text scan sharing no parse, no tree and no index with the reader. For each
 * claimed flow it asks the cheap, decisive question: **is the name that was
 * handed over actually written in the door call's argument list?** If the reader
 * says `payload` reached `fs.writeFileSync` on line 40 and that call does not
 * mention `payload`, the reader connected two unrelated statements.
 *
 * The argument list, not the line -- and the difference cost the first run three
 * false `invented`, all of them the referee's own fault. `subprocess.run(` opens
 * on the door's line and `cli_args` is on the next one. See `argumentTextAt`.
 *
 * Then the hops, one at a time: for a path `rows -> shaped`, some line before
 * the door must both bind `shaped` and mention `rows`. A chain the text cannot
 * walk is counted apart rather than as a failure -- it is the referee's own
 * blindness, and item 24's lesson is that the apart pile is where bugs hide, so
 * it is printed with a number on it.
 *
 * ## What this cannot see, stated before any number is read off it
 *
 *   - **A value wrapped in an object literal.** `fetch(url, { body: payload })`
 *     is the usual spelling of the commonest door in TypeScript, and `payload`
 *     escapes `into-a-structure`, which `dataflow.ts` does not model the way it
 *     models a collection. Counted below as the silent miss it is.
 *   - **A door on a handle.** `f.write(row)`, where `f` came back from `open()`,
 *     is not a door to `outside.ts` at all -- it reads as a method on a value
 *     rather than a module. Knowing `f` is a file needs a type.
 *   - **Anything across a call.** A value handed to a routine that writes it out
 *     is not reported. That is the interprocedural question, worth 1.3% by
 *     measurement, and `reach.ts` already answers the routine-to-door half.
 *   - **Demand.** This says nothing about whether anybody draws such an arrow.
 *     `measure:vocabulary` reads the boards and `measure:doors` reads the far
 *     ends; no count is printed here, because a hardcoded one is exactly the
 *     mistake #203 already made once.
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { indexOf } from "./lib/dataflow-index";
import { sourceFiles } from "./lib/source-files";

import { outflowIn, type Outflow, type OutflowVia } from "../src/engine/outflow";
import { initEngine, languageOf, type Language } from "../src/engine/parse";
import { type OutsideKind } from "../src/engine/outside";

await initEngine();

const HOME = process.env.HOME ?? "";
const roots = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));

/** The same seven trees the other dataflow measurements read. */
const trees = roots.length > 0 ? roots : [
  path.resolve("src"),
  path.resolve("scripts"),
  path.resolve("rust-test"),
  `${HOME}/orangutan`,
  `${HOME}/board-ai/graphify/graphify`,
  `${HOME}/mundane`,
  `${HOME}/infrarouter`,
].filter((tree) => existsSync(tree));

const bump = <K,>(map: Map<K, number>, key: K, by = 1) =>
  map.set(key, (map.get(key) ?? 0) + by);

const flowsBy = new Map<Language, number>();
const routinesWith = new Map<Language, number>();
const byKind = new Map<OutsideKind, number>();
const byVia = new Map<OutflowVia, number>();
const byHops = new Map<number, number>();
/**
 * Which argument of the door the value arrived as.
 *
 * The qualifier that decides what any of these counts mean.
 * `writeFile(path, contents)` takes a place and a payload, and "this value is
 * written to a file" means the second one. Position 0 of a file door is
 * overwhelmingly a directory or a filename: true, reaching a door, and not the
 * data going out.
 */
const byPosition = new Map<string, number>();
/** The argument-1-or-later flows by which door they reach, so nobody has to eyeball it. */
const payloadDoors = new Map<string, number>();

/* The referee. */
let checked = 0;
let corroborated = 0;
const invented: string[] = [];
/** Hop chains the text scan could not walk -- its blindness, counted apart. */
let hopsUnreadable = 0;
let hopsWalked = 0;

/** Values the reader watched go into a structure in a body that holds a door. */
const intoAStructure = new Map<Language, number>();

const examples: string[] = [];
let files = 0;

/**
 * The door call's argument list, as text, from the line it opens on.
 *
 * The first run read the door's line and nothing else, and reported **3
 * invented** -- all three the referee's fault and the reader right:
 *
 *     proc = subprocess.run(
 *         cli_args,
 *
 * `cli_args` is passed to the door on the *next* line. So the scan follows the
 * parentheses opened on the door's line until they balance, which for a
 * well-formed call is exactly the arguments and nothing after them. Capped, so
 * an unbalanced quote cannot swallow a file.
 *
 * The direction of the remaining error is worth naming: reading *more* text
 * makes the referee more generous, so a cap that is too high weakens it. It
 * stops at the balancing paren for that reason rather than at a line count.
 */
const argumentTextAt = (lines: string[], line: number): string => {
  const MOST_LINES = 40;
  let depth = 0;
  let opened = false;
  const parts: string[] = [];
  for (let at = line - 1; at < lines.length && at < line - 1 + MOST_LINES; at += 1) {
    const text = lines[at] ?? "";
    parts.push(text);
    for (const character of text) {
      if (character === "(") { depth += 1; opened = true; }
      else if (character === ")") depth -= 1;
    }
    if (opened && depth <= 0) break;
  }
  return parts.join("\n");
};

/** A whole-word mention, the only text rule this referee has. */
const mentions = (line: string, name: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_$]|$)`)
    .test(line);

/** A line that binds this name, read off the text and nothing else. */
const binds = (line: string, name: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(:[^=]*)?=[^=]`)
    .test(line)
  || new RegExp(`\\b(for|foreach)\\b[^\\n]*\\b${name}\\b`).test(line);

for (const tree of trees) {
  const index = indexOf(tree);

  for (const file of sourceFiles(tree)) {
    const language = languageOf(file);
    if (!language) continue;
    const rel = path.relative(tree, file);
    const source = index.read(rel);
    if (source === undefined || source.length > 400_000) continue;

    const reading = outflowIn(source, language);
    if (!reading.read) continue;

    /* The silent-miss column, from the reader's own escape reasons. */
    if (reading.flows.length > 0) {
      for (const body of index.bodiesFor(rel)) {
        if (body.scope !== "routine") continue;
        if (!reading.flows.some((flow) => flow.routine === body.routine)) continue;
        for (const local of body.locals) {
          if (local.escapes.includes("into-a-structure")) bump(intoAStructure, language);
        }
      }
    }

    if (reading.flows.length === 0) continue;
    files += 1;
    const lines = source.split("\n");
    const routines = new Set<string>();

    for (const flow of reading.flows) {
      bump(flowsBy, language);
      routines.add(flow.routine);
      bump(byKind, flow.door.kind);
      bump(byVia, flow.via);
      bump(byHops, flow.through.length);
      bump(byPosition, flow.at === undefined ? "not recorded"
        : flow.at === 0 ? "argument 0" : "argument 1 or later");
      if (flow.at !== undefined && flow.at > 0) bump(payloadDoors, flow.door.qualified);

      /* -- the referee, on the one question it can settle -- */
      const doorLine = argumentTextAt(lines, flow.door.line);
      /*
       * The name actually written at the door: the last hop for a path, and the
       * value itself when it was handed over directly.
       */
      const handed = flow.through.length > 0
        ? flow.through[flow.through.length - 1]!
        : flow.value;
      checked += 1;
      if (mentions(doorLine, handed)) {
        corroborated += 1;
      } else {
        if (invented.length < 20) {
          invented.push(`${rel}:${flow.door.line} ${flow.routine} / ${flow.value}`
            + `${flow.through.length > 0 ? ` through ${flow.through.join(" -> ")}` : ""}`
            + ` -> ${flow.door.qualified}  call reads: ${doorLine.replace(/\s+/g, " ").trim().slice(0, 80)}`);
        }
      }

      /* -- and the hops, each of which the text may or may not be able to walk -- */
      for (let at = 1; at < flow.through.length; at += 1) {
        const from = flow.through[at - 1]!;
        const to = flow.through[at]!;
        const found = lines
          .slice(0, flow.door.line)
          .some((line) => binds(line, to) && mentions(line, from));
        if (found) hopsWalked += 1;
        else hopsUnreadable += 1;
      }

      /*
       * The examples are the argument-1-or-later population on purpose. Those
       * are the flows that mean what the question asked -- a payload going out
       * rather than a path naming where -- and they are the small half.
       */
      if (examples.length < 20 && flow.at !== undefined && flow.at > 0) {
        examples.push(`${rel}:${flow.door.line} ${flow.routine}: ${flow.value}`
          + (flow.through.length > 0 ? ` -> ${flow.through.join(" -> ")}` : "")
          + ` -> ${flow.door.qualified}[${flow.at}] (${flow.door.kind})`);
      }
    }
    bump(routinesWith, language, routines.size);
  }
}

const LANGUAGES: Language[] = ["rust", "ts", "tsx", "python", "js"];
const total = (map: Map<Language, number>) =>
  LANGUAGES.reduce((sum, language) => sum + (map.get(language) ?? 0), 0);
const share = (part: number, whole: number) =>
  whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;

console.log("");
console.log("MEASURE OUTFLOW -- values that reach a door, and whether the text agrees");
console.log(`  ${trees.length} trees, ${files} files holding at least one flow`);
console.log("  Confirming only. There is no `never reaches a door` verdict here and the");
console.log("  module doc says why: a wrong one would be unrecoverable.");
console.log("");

console.log("1 - WHAT REACHES A DOOR");
console.log("");
console.log("  " + "language".padEnd(10) + "flows".padStart(8) + "routines".padStart(10));
for (const language of LANGUAGES) {
  const found = flowsBy.get(language) ?? 0;
  if (found === 0) continue;
  console.log("  " + language.padEnd(10) + String(found).padStart(8)
    + String(routinesWith.get(language) ?? 0).padStart(10));
}
console.log("  " + "all".padEnd(10) + String(total(flowsBy)).padStart(8)
  + String(total(routinesWith)).padStart(10));

console.log("");
console.log("  BY WHAT THE DOOR TOUCHES");
for (const kind of ["file", "network", "process"] as OutsideKind[]) {
  const found = byKind.get(kind) ?? 0;
  console.log("    " + kind.padEnd(10) + String(found).padStart(7)
    + share(found, total(flowsBy)).padStart(8));
}

console.log("");
console.log("  BY HOW THE VALUE GOT THERE");
for (const via of ["handed-to-the-door", "through-a-local", "out-of-a-collection"] as OutflowVia[]) {
  const found = byVia.get(via) ?? 0;
  console.log("    " + via.padEnd(22) + String(found).padStart(7)
    + share(found, total(flowsBy)).padStart(8));
}

console.log("");
console.log("  BY WHICH ARGUMENT OF THE DOOR IT ARRIVED AS -- read this before the rest");
for (const [where, found] of [...byPosition].sort((a, b) => b[1] - a[1])) {
  console.log("    " + where.padEnd(22) + String(found).padStart(7)
    + share(found, total(flowsBy)).padStart(8));
}
console.log("");
console.log("    `writeFile(path, contents)` takes a place and a payload, and \"this value");
console.log("    is written to a file\" means the payload. Argument 0 of a file door is");
console.log("    overwhelmingly a directory or a filename -- it reaches the door, truthfully,");
console.log("    and it is not the data going out. Which position is the payload is a fact");
console.log("    about each library function rather than about a grammar, so it is split");
console.log("    here and not interpreted.");
console.log("");
console.log("  BY HOW MANY LOCALS IT CAME THROUGH");
for (const [hops, found] of [...byHops].sort((a, b) => a[0] - b[0])) {
  console.log("    " + `${hops} hop${hops === 1 ? "" : "s"}`.padEnd(10) + String(found).padStart(7)
    + share(found, total(flowsBy)).padStart(8));
}

console.log("");
console.log("2 - THE REFEREE -- the same claim read out of the text, sharing no machinery");
console.log("");
console.log(`  INVENTED -- the reader drew a path the text cannot see: ${checked - corroborated}`);
console.log("    The bar is zero. Confirming is all this reader does, so a path that is not");
console.log("    in the code is the only way it can be wrong. The question the scan settles");
console.log("    is the decisive one: is the name that was handed over written in the");
console.log("    door call's own argument list at all?");
console.log(`    Checked ${checked}, corroborated ${corroborated} (${share(corroborated, checked)}).`);
if (invented.length > 0) {
  console.log("");
  for (const one of invented) console.log("    " + one);
}

console.log("");
console.log(`  THE HOPS, which the scan can only sometimes walk: ${hopsWalked} walked, ${hopsUnreadable} not`);
console.log("    A hop is corroborated when some line before the door both binds the next");
console.log("    name and mentions the previous one. A chain the scan cannot follow is its");
console.log("    own blindness rather than the reader being wrong, so it is counted apart --");
console.log("    and printed, because the apart pile is where reader bugs hide (item 24).");
console.log(`    ${share(hopsWalked, hopsWalked + hopsUnreadable)} of hops walked.`);

console.log("");
console.log("3 - WHAT IT DID NOT SEE, in the bodies where it saw something");
console.log("");
console.log("  " + "language".padEnd(10) + "values into a structure".padStart(24));
for (const language of LANGUAGES) {
  const found = intoAStructure.get(language) ?? 0;
  if (found === 0) continue;
  console.log("  " + language.padEnd(10) + String(found).padStart(24));
}
console.log("  " + "all".padEnd(10) + String(total(intoAStructure)).padStart(24));
console.log("");
console.log("  `fetch(url, { body: payload })` is the usual spelling of the commonest door");
console.log("  in TypeScript, and `payload` escapes `into-a-structure` -- which");
console.log("  `dataflow.ts` does not model the way it models a collection, so nothing");
console.log("  connects it to the argument. Every one of these is a flow that may be real");
console.log("  and is not reported. It is the reason to read the counts above as a floor,");
console.log("  and the reason the network row is low.");

console.log("");
console.log("4 - THE POPULATION THE QUESTION WAS ACTUALLY ABOUT -- argument 1 or later");
console.log("");
console.log("  BY DOOR, because `argument 1` means different things at different doors");
for (const [door, found] of [...payloadDoors].sort((a, b) => b[1] - a[1])) {
  console.log("    " + door.padEnd(34) + String(found).padStart(5));
}
console.log("");
console.log("    Read this list rather than the total. Argument 1 of `rename`, `os.replace`,");
console.log("    `cpSync`, `copy2`, `copy` and `copytree` is a **destination path** -- the");
console.log("    value reaches the door truthfully and is still not the data going out.");
console.log("    Argument 1 of `execFileSync` and `spawnSync` is the argument list handed to");
console.log("    another process, which is. So the population that means what the question");
console.log("    asked is the subprocess rows, and it is one idiom -- a `git(args)` wrapper");
console.log("    -- repeated across the corpus.");
if (examples.length > 0) {
  console.log("");
  for (const one of examples) console.log("    " + one);
}
console.log("");
