#!/usr/bin/env node
/**
 * Whether a parameter, a loop variable or a `let` that `parts.ts` reads as
 * "not a type" or "cannot be called" really is one (#417).
 *
 *   npm run measure:bound-parts -- /Users/noelmatero/board-ai/.corpus/*
 *   npm run measure:bound-parts -- <tree>... [--only=ts|python] [--show=20]
 *
 * `measure:parts` licensed every part over the names a file *declares*, and
 * those are what its referees list. #417 made `partsOf` read the names a file
 * binds without declaring them too -- every parameter, a loop's or a
 * `catch`'s binding, a Rust `let` -- so an arrow anchored at `**kwargs` can be
 * told "a parameter is not a type". That is a new population, and nothing
 * new may say "wrong" before it is measured against a referee that shares no
 * machinery with the reader (AGENTS.md).
 *
 * The referee is `lib/call-probe.ts`, `measure:parts --compiler`'s: it
 * writes `name()` where the binding is in scope, in a copy of the file, and
 * asks a checker whether the program still type-checks -- the TypeScript
 * compiler's diagnostics, and mypy for Python. It also says whether the
 * declaration is a value at all, which is `type`'s half.
 *
 *   wrong        the reader says "lacks", the checker accepted the call or
 *                says the name is not a value -- a false red waiting
 *   unrefereed   the checker never read the line, or the value is `any`
 *   agreed       both say "lacks"
 *
 * Every occurrence of the name in the file is probed, because a name lacks a
 * part only when every declaration and binding of it does.
 *
 * Rust has no call probe, so its bindings are counted and left unrefereed:
 * their reading is `couldBeCalled` on a written type, the same rule
 * `measure:parts` measured on Rust's fields and values.
 *
 * A measurement: it prints and never fails.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { initEngine, languageOf, type Language } from "../src/engine/parse";
import { declaredShapes } from "../src/engine/body";
import { boundNames, partsOf } from "../src/engine/parts";
import { sourceFiles } from "./lib/source-files";
import { probeCallsPython, probeCallsTs, probeKey, type ProbeAnswer, type ProbeSite } from "./lib/call-probe";

await initEngine();

const args = process.argv.slice(2);
const roots = args.filter((argument) => !argument.startsWith("--")).map((root) => path.resolve(root));
const only = args.find((argument) => argument.startsWith("--only="))?.slice(7);
const show = Number(args.find((argument) => argument.startsWith("--show="))?.slice(7) ?? 15);
if (roots.length === 0) {
  console.error("usage: measure-bound-parts <tree>... [--only=ts|python|rust]");
  process.exit(1);
}

type Family = "ts" | "python" | "rust";
const familyOf = (language: Language): Family =>
  language === "rust" ? "rust" : language === "python" ? "python" : "ts";
type Part = "type" | "callable";
type Outcome = "agreed" | "wrong" | "unrefereed";

const tally = new Map<string, Record<Outcome, number>>();
const examples = new Map<string, string[]>();
const bump = (family: Family, part: Part, outcome: Outcome, where: string) => {
  const key = `${family}\t${part}`;
  const row = tally.get(key) ?? { agreed: 0, wrong: 0, unrefereed: 0 };
  row[outcome] += 1;
  tally.set(key, row);
  if (outcome !== "agreed") examples.set(`${key}\t${outcome}`, [...(examples.get(`${key}\t${outcome}`) ?? []), where]);
};

const lineAt = (source: string, offset: number) => source.slice(0, offset).split("\n").length - 1;

interface Lack { file: string; name: string; parts: Part[]; sites: ProbeSite[] }

for (const root of roots) {
  const began = Date.now();
  const lacks: Lack[] = [];
  for (const file of sourceFiles(root)) {
    const language = languageOf(file);
    if (!language || (only && familyOf(language) !== only)) continue;
    let source: string;
    try { source = readFileSync(file, "utf8"); } catch { continue; }
    const bound = boundNames(source, language);
    const declared = declaredShapes(source, language);
    for (const name of new Set(bound.map((one) => one.name))) {
      /*
       * The new population only: a name nothing declares, which `partsOf`
       * reads off its bindings, or one declared only by loops, whose reading
       * #417 changed. Any other declaration is `measure:parts`' population.
       */
      const loops = new Set(bound.filter((one) => one.name === name).map((one) => one.start));
      if ((declared?.get(name) ?? []).some((one) => !loops.has(one.nameNode.startIndex))) continue;
      const parts = partsOf(source, name, language);
      const lacking = (["type", "callable"] as const).filter((part) => parts?.[part] === "lacks");
      if (lacking.length === 0) continue;
      const starts = [
        ...bound.filter((one) => one.name === name).map((one) => one.start),
        ...(declared?.get(name) ?? []).map((one) => one.nameNode.startIndex),
      ];
      const sites = [...new Set(starts.map((start) => lineAt(source, start)))].map((line) => ({ file, line, name }));
      lacks.push({ file, name, parts: lacking, sites });
    }
  }

  const byFamily = new Map<Family, Lack[]>();
  for (const lack of lacks) {
    const family = familyOf(languageOf(lack.file)!);
    byFamily.set(family, [...(byFamily.get(family) ?? []), lack]);
  }
  for (const [family, list] of byFamily) {
    const sites = list.flatMap((lack) => lack.sites);
    let answers: Map<string, ProbeAnswer> | undefined;
    let failure: string | undefined;
    if (family === "ts") answers = probeCallsTs(sites);
    else if (family === "python") ({ answers, failure } = probeCallsPython(root, sites));
    if (failure) console.log(`  ${path.basename(root)} ${family}: ${failure}`);
    for (const lack of list) {
      const heard = lack.sites.map((site) => answers?.get(probeKey(site.file, site.line, site.name)));
      const where = `${path.relative(path.dirname(root), lack.file)}:${lack.sites[0]!.line + 1} ${lack.name}`;
      for (const part of lack.parts) {
        let outcome: Outcome;
        if (part === "callable") {
          outcome = heard.some((answer) => answer?.callable === "has") ? "wrong"
            : heard.every((answer) => answer?.callable === "lacks") ? "agreed" : "unrefereed";
        } else {
          // `value` false is "not a value" or "never read"; only true is an answer.
          outcome = heard.every((answer) => answer?.value === true) ? "agreed" : "unrefereed";
        }
        bump(family, part, outcome, where);
      }
    }
  }
  console.log(`${path.basename(root)}: ${lacks.length} bound names read as lacking, ${((Date.now() - began) / 1000).toFixed(0)}s`);
}

console.log("\nlanguage  part       agreed   wrong  unrefereed");
for (const [key, row] of [...tally].sort()) {
  const [family, part] = key.split("\t");
  console.log(`${family!.padEnd(9)} ${part!.padEnd(10)} ${String(row.agreed).padStart(6)} ${String(row.wrong).padStart(7)} ${String(row.unrefereed).padStart(11)}`);
}
for (const [key, list] of [...examples].sort()) {
  console.log(`\n${key.replace(/\t/g, " ")} (${list.length}):`);
  for (const where of list.slice(0, show)) console.log(`  ${where}`);
}
