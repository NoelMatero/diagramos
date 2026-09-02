#!/usr/bin/env node
/**
 * How often the signature reader is wrong, measured before it is allowed a red.
 *
 *   npm run measure:signature                 -- this repository, rust-test, graphify
 *   npm run measure:signature -- <path>...    -- any trees you like
 *
 * `signature.ts` is the first thing in this engine that refutes from an
 * *absence*: it reads a function's parameters and return type and, finding no
 * mention of a type, is prepared to say the arrow claiming one is wrong. Every
 * other verdict here either confirms or goes quiet, so this is the first place a
 * reader bug turns into the tool telling somebody their correct diagram is
 * wrong. That is not recoverable by being right afterwards, which is why the
 * number comes before the word.
 *
 * Two questions, and they are not the same:
 *
 *   1. **Does the reader miss a type that is plainly written in the signature?**
 *      Every miss is a potential false accusation. The referee is a text scan of
 *      the signature source -- deliberately a different mechanism from the
 *      syntax tree the reader walks, so agreeing means two unrelated readings
 *      agree rather than one reading agreeing with itself.
 *
 *   2. **How often does it refuse?** A reader that withholds on most real
 *      functions is safe and useless: the word would ship, never fire, and read
 *      exactly like a claim that passed. `aliased` is the interesting one -- it
 *      is the refusal that exists because a name in a signature can stand for
 *      something else, and it is the cost of being allowed to refute at all.
 *      `quoted-annotation` is the same cost in Python, added by #195.
 *
 * Nothing here decides anything. It prints the numbers so the decision about
 * what `absent` is allowed to say can be argued with.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { initEngine, languageOf, parseSource, type Language, type Node } from "../src/engine/parse";
import { signatureNames } from "../src/engine/signature";

await initEngine();

const roots = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
const trees = roots.length > 0 ? roots : [
  path.resolve("src"),
  path.resolve("scripts"),
  "/Users/noelmatero/board-ai/rust-test/src",
  "/Users/noelmatero/board-ai/rust-test/orangutan_macro/lib_shared/src",
  // Python, added by #195. The reader was allowed to refute in Python for
  // several releases with no Python in this corpus at all, and the false red
  // that found was in the shape no other language writes -- a type spelled
  // inside a string. A corpus with no Python in it could not have said so.
  "/Users/noelmatero/board-ai/graphify/graphify",
];

/** Files under a tree that this engine has a grammar for. */
function sourceFiles(root: string): string[] {
  try {
    return execFileSync("find", [root, "-type", "f"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((file) => !file.includes("/target/") && !file.includes("/node_modules/"))
      .filter((file) => languageOf(file) !== undefined);
  } catch {
    return [];
  }
}

const IDENTIFIER = /identifier$/;
const isName = (node: Node): boolean => node.childCount === 0 && IDENTIFIER.test(node.type);

function each(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child) each(child, visit);
  }
}

/**
 * The referee: type names read out of the signature *text*, by a scanner that
 * knows nothing about syntax trees.
 *
 * A parameter's binding name is dropped by taking only what follows a `:` or a
 * `->` up to the next comma at depth zero, which is how a person reads a
 * signature. Crude on purpose -- a referee that shared the reader's machinery
 * would agree with it for the wrong reason.
 */
function textTypeNames(signature: string, language: Language): Set<string> {
  const names = new Set<string>();
  const parameters = signature.slice(signature.indexOf("("), signature.lastIndexOf(")") + 1);
  const returned = signature.slice(signature.lastIndexOf(")") + 1);
  const typePart = /[:\->]\s*([^,)]*)/g;
  /*
   * Three things in a signature that are not types, removed before the scan.
   *
   * Not the referee being tuned to agree -- each one was checked against the
   * reader and the reader was right. A word in a doc comment inside an inline
   * object return type is prose; a word in a default value (`now: Date = new
   * Date()`) is an expression, and `new` is a keyword; a word in a string
   * literal (`foot = "/update-diagram"`) is text. A referee that counted any of
   * them would report a miss for a name that is not a type at all, and the
   * whole point of this number is that a miss means something.
   */
  const withoutProse = (text: string) => text
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""')
    .replace(/=\s*[^,)]*/g, "");
  /*
   * Python is the exception, and #195 is why.
   *
   * A quoted annotation -- `def unit_path(unit: "Path | FileSlice")` -- is how
   * Python writes a forward reference, and how a type imported only under `if
   * TYPE_CHECKING:` has to be written. The names in it are types, in the source,
   * in the signature, where anybody reading the file can see them. A referee
   * that blanks them the way it blanks a string in a default value cannot report
   * a miss for a name it never looked at, so it agreed with a reader that was
   * calling correct arrows wrong -- 49 of graphify's `def`s write one. Here the
   * quotes come off and the words inside are counted, after the default values
   * have already been removed, so what is left in a type position is a type.
   */
  const unquoted = (text: string) => text
    .replace(/#[^\n]*/g, " ")
    .replace(/=\s*[^,)]*/g, "")
    .replace(/["'`]/g, " ");
  const readable = language === "python" ? unquoted : withoutProse;
  for (const region of [readable(parameters), readable(returned)]) {
    for (const match of region.matchAll(typePart)) {
      for (const word of (match[1] ?? "").matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
        names.add(word[0]);
      }
    }
  }
  /*
   * A fourth, and the one that came out of #193: `Self` is not a name, it is a
   * stand-in for one. Nothing declares a type called `Self` and no box is ever
   * drawn for it, so asking "did the reader find the token `Self`" measures a
   * question production never asks -- the reader resolves it to the type the
   * `impl` names, which is the fix that issue asked for. Left in, the referee
   * reported 43 misses on the Rust corpus, every one of them the reader doing
   * exactly the right thing.
   */
  names.delete("Self");
  return names;
}

interface Tally {
  functions: number;
  /** Type names the text scan saw and the reader also saw. */
  agreed: number;
  /** Type names the text scan saw and the reader did not: potential false reds. */
  missed: number;
  /** Names the reader saw that the text scan did not. Harmless, but worth seeing. */
  invented: number;
  withheld: Record<string, number>;
  absent: number;
  confirmed: number;
  examples: string[];
}

const byLanguage = new Map<Language, Tally>();
const tallyFor = (language: Language): Tally => {
  const existing = byLanguage.get(language);
  if (existing) return existing;
  const fresh: Tally = {
    functions: 0, agreed: 0, missed: 0, invented: 0,
    withheld: {}, absent: 0, confirmed: 0, examples: [],
  };
  byLanguage.set(language, fresh);
  return fresh;
};

for (const root of trees) {
  for (const file of sourceFiles(root)) {
    const language = languageOf(file)!;
    let source: string;
    try { source = readFileSync(file, "utf8"); } catch { continue; }
    const tree = parseSource(source, language);
    if (!tree) continue;
    const tally = tallyFor(language);

    each(tree.rootNode, (node) => {
      const parameters = node.childForFieldName("parameters");
      if (!parameters) return;
      const nameNode = node.childForFieldName("name");
      if (!nameNode || nameNode.childCount > 0) return;
      const symbol = nameNode.text;
      const returned = node.childForFieldName("return_type");
      const signatureText = `${parameters.text}${returned ? ` -> ${returned.text.replace(/^:\s*/, "")}` : ""}`;
      tally.functions += 1;

      // Question 1: every type name a person can read in this signature should
      // be findable by the reader. Asked one name at a time, which is exactly
      // how the verdict will be asked in production.
      for (const name of textTypeNames(signatureText, language)) {
        const verdict = signatureNames(source, symbol, [name], "parameter", language);
        const other = signatureNames(source, symbol, [name], "return", language);
        const saw = verdict.verdict === "confirmed" || verdict.verdict === "misplaced"
          || other.verdict === "confirmed" || other.verdict === "misplaced";
        if (saw) { tally.agreed += 1; continue; }
        // A refusal is not a miss: the reader declined to answer rather than
        // answering wrongly, which is the whole design.
        if (verdict.verdict === "withheld" && other.verdict === "withheld") continue;
        tally.missed += 1;
        if (tally.examples.length < 12) {
          tally.examples.push(`${path.relative(process.cwd(), file)}: ${symbol}${signatureText} — did not find ${name}`);
        }
      }

      // Question 2: what the verdict actually is, for a name that is genuinely
      // not there. This is the shape every real refutation will have.
      const absentee = signatureNames(source, symbol, ["ZzNotARealTypeName"], "parameter", language);
      if (absentee.verdict === "withheld") {
        tally.withheld[absentee.why] = (tally.withheld[absentee.why] ?? 0) + 1;
      } else if (absentee.verdict === "absent") {
        tally.absent += 1;
      } else {
        tally.confirmed += 1;
      }
    });
  }
}

console.log("Signature reader, measured against a text scan of the same signatures.\n");
let totalMissed = 0;
let totalNames = 0;
for (const [language, tally] of [...byLanguage].sort()) {
  const names = tally.agreed + tally.missed;
  totalMissed += tally.missed;
  totalNames += names;
  const recall = names === 0 ? 1 : tally.agreed / names;
  console.log(`## ${language}`);
  console.log(`   functions read      ${tally.functions}`);
  console.log(`   type names in them  ${names}`);
  console.log(`   found by the reader ${tally.agreed}  (${(recall * 100).toFixed(2)}%)`);
  console.log(`   MISSED              ${tally.missed}   <- each one is a possible false red`);
  console.log(`   would refute        ${tally.absent}  of ${tally.functions} functions`);
  const refusals = Object.entries(tally.withheld).sort((a, b) => b[1] - a[1]);
  console.log(`   would withhold      ${refusals.reduce((sum, [, n]) => sum + n, 0)}`
    + (refusals.length ? `  (${refusals.map(([why, n]) => `${why} ${n}`).join(", ")})` : ""));
  for (const example of tally.examples) console.log(`     ! ${example}`);
  console.log();
}
console.log(`overall: ${totalNames} type names, ${totalMissed} missed`
  + ` (${totalNames === 0 ? "0" : ((totalMissed / totalNames) * 100).toFixed(3)}% miss rate)`);
