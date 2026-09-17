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
import path from "node:path";

import { textTypeNames } from "./lib/signature-scan";
import { sourceFiles } from "./lib/source-files";

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


const IDENTIFIER = /identifier$/;
const isName = (node: Node): boolean => node.childCount === 0 && IDENTIFIER.test(node.type);

function each(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child) each(child, visit);
  }
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
        // `--all` for every miss rather than the first 12: over the pinned
        // clones TypeScript alone misses 78, and each one has to be read (#278).
        if (tally.examples.length < 12 || process.argv.includes("--all")) {
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
