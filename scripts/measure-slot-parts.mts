#!/usr/bin/env node
/**
 * Whether an attribute, a key or a name in a destructuring target that
 * `parts.ts` reads as "cannot be called" or "not a type" really is one
 * (missed map 2026-11b, pattern 1d).
 *
 *   npm run measure:slot-parts -- /Users/noelmatero/board-ai/.corpus/*
 *   npm run measure:slot-parts -- <tree>... [--compiler] [--only=ts|python] [--show=20]
 *
 * `measure:parts` licensed every part over the names a file declares, and
 * `measure:bound-parts` over the ones it binds (#417). `partsOf` now also
 * reads a name that only gets a value -- `self._nested = False`,
 * `{ source: '' }`, `start, stop, step = s.indices(n)` -- so a box anchored
 * at one can be told it holds data. That is a new population, and nothing new
 * may say "wrong" before it is measured against a referee that shares no
 * machinery with the reader (AGENTS.md).
 *
 * `--compiler` reads the way a check holding a compiler does (#343): each
 * slot the text cannot judge is put to the TypeScript checker or pyright, as
 * `drift.ts` puts it, and what that adds is tallied on its own.
 *
 * The referee is `lib/call-probe.ts`: it writes the call where the value is
 * given -- `self.x()` on the line after the assignment, a key's value wrapped
 * and called where it stands, `name()` after a tuple is unpacked -- and asks
 * a checker whether the program still type-checks (the TypeScript compiler's
 * diagnostics; mypy, then pyright's command line, for Python).
 *
 *   wrong        the reader says "lacks", the checker accepted a call at
 *                one of the name's places -- a false red waiting
 *   unrefereed   the checker never read a line, or the value is `any`
 *   agreed       the checker refused the call at every place
 *
 * `type` is refereed by the probe placing the name as a value at every place,
 * as `measure:bound-parts` does: an attribute, a key or a name unpacked from a
 * tuple is a value. A measurement: it prints and never fails.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { initEngine, languageOf, type Language } from "../src/engine/parse";
import { partsOf, slotNames, type AskKind, type ValueKind } from "../src/engine/parts";
import { createTsReferee } from "../src/engine/referee-ts";
import { resolvePythonKinds } from "../src/engine/referee-pool";
import { sourceFiles } from "./lib/source-files";
import { probeCallsPython, probeCallsTs, probeKey, type ProbeAnswer, type ProbeSite } from "./lib/call-probe";

await initEngine();

const args = process.argv.slice(2);
const roots = args.filter((argument) => !argument.startsWith("--")).map((root) => path.resolve(root));
const only = args.find((argument) => argument.startsWith("--only="))?.slice(7);
const show = Number(args.find((argument) => argument.startsWith("--show="))?.slice(7) ?? 15);
const withCompiler = args.includes("--compiler");
if (roots.length === 0) {
  console.error("usage: measure-slot-parts <tree>... [--compiler] [--only=ts|python]");
  process.exit(1);
}

type Family = "ts" | "python";
const familyOf = (language: Language): Family | undefined =>
  language === "rust" ? undefined : language === "python" ? "python" : "ts";
type Part = "type" | "callable";
type Outcome = "agreed" | "wrong" | "unrefereed";

/** Every lack, and apart from it the lacks only a compiler's answer made. */
const tally = new Map<string, Record<Outcome, number>>();
const examples = new Map<string, string[]>();
const bump = (family: Family, part: Part, outcome: Outcome, where: string, byCompiler: boolean) => {
  for (const key of [`${family}\t${part}\tall`, ...(byCompiler ? [`${family}\t${part}\tcompiler`] : [])]) {
    const row = tally.get(key) ?? { agreed: 0, wrong: 0, unrefereed: 0 };
    row[outcome] += 1;
    tally.set(key, row);
    if (outcome !== "agreed") examples.set(`${key}\t${outcome}`, [...(examples.get(`${key}\t${outcome}`) ?? []), where]);
  }
};
let names = 0;

const lineAt = (source: string, offset: number) => source.slice(0, offset).split("\n").length - 1;

interface Lack { file: string; name: string; parts: Part[]; byCompiler: Part[]; sites: ProbeSite[] }

for (const root of roots) {
  const began = Date.now();
  const files = sourceFiles(root).filter((file) => {
    const language = languageOf(file);
    const family = language ? familyOf(language) : undefined;
    return family !== undefined && (!only || family === only);
  });

  /*
   * The compilers. TypeScript answers in process; pyright over a pipe, so its
   * questions are harvested first -- every one the reader would ask, asked
   * once -- the recording pass `referee-live.ts` makes for a board.
   */
  const asks = new Map<string, AskKind>();
  if (withCompiler) {
    const tsFiles = files.filter((file) => familyOf(languageOf(file)!) === "ts");
    if (tsFiles.length > 0) {
      const referee = createTsReferee(root);
      if (referee) for (const file of tsFiles) asks.set(file, (at) => referee.kindAt(file, at.start, at.end));
    }
    const pyFiles = files.filter((file) => languageOf(file) === "python");
    if (pyFiles.length > 0) {
      const queries: { file: string; at: { start: number; end: number } }[] = [];
      for (const file of pyFiles) {
        const source = readFileSync(file, "utf8");
        for (const name of new Set(slotNames(source, "python").map((one) => one.name))) {
          partsOf(source, name, "python", (at) => { queries.push({ file, at }); return undefined; });
        }
      }
      const kinds = await resolvePythonKinds(root, queries);
      kinds.close();
      if (queries.length > 0) console.error(`${path.basename(root)} python: ${queries.length} slots asked of pyright, ${kinds.started ? "answered" : "PYRIGHT DID NOT START"}`);
      for (const file of pyFiles) asks.set(file, (at) => kinds.cache.get(file, at) as ValueKind | undefined);
    }
  }

  const lacks: Lack[] = [];
  for (const file of files) {
    const language = languageOf(file)!;
    let source: string;
    try { source = readFileSync(file, "utf8"); } catch { continue; }
    const slots = slotNames(source, language);
    for (const name of new Set(slots.map((one) => one.name))) {
      names += 1;
      const text = partsOf(source, name, language);
      const ours = withCompiler ? partsOf(source, name, language, asks.get(file)) : text;
      const parts = (["type", "callable"] as const).filter((part) => ours?.[part] === "lacks");
      if (parts.length === 0) continue;
      const lines = [...new Set(slots.filter((one) => one.name === name).map((one) => lineAt(source, one.start)))];
      lacks.push({
        file, name, parts, byCompiler: parts.filter((part) => text?.[part] !== "lacks"),
        sites: lines.map((line) => ({ file, line, name })),
      });
    }
  }

  for (const family of ["ts", "python"] as const) {
    const list = lacks.filter((lack) => familyOf(languageOf(lack.file)!) === family);
    if (list.length === 0) continue;
    const sites = list.flatMap((lack) => lack.sites);
    let answers: Map<string, ProbeAnswer> | undefined;
    let failure: string | undefined;
    if (family === "ts") answers = probeCallsTs(sites);
    else ({ answers, failure } = probeCallsPython(root, sites));
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
          outcome = heard.every((answer) => answer?.value === true) ? "agreed" : "unrefereed";
        }
        bump(family, part, outcome, where, lack.byCompiler.includes(part));
      }
    }
  }
  console.log(`${path.basename(root)}: ${lacks.length} names read as lacking, ${((Date.now() - began) / 1000).toFixed(0)}s`);
}

console.log(`\n${names} names read through their slots${withCompiler ? ", with the compilers" : ", text alone"}`);
console.log("language  part       lacks from  agreed   wrong  unrefereed");
for (const [key, row] of [...tally].sort()) {
  const [family, part, from] = key.split("\t");
  console.log(`${family!.padEnd(9)} ${part!.padEnd(10)} ${from!.padEnd(10)} ${String(row.agreed).padStart(6)} ${String(row.wrong).padStart(7)} ${String(row.unrefereed).padStart(11)}`);
}
for (const [key, list] of [...examples].sort()) {
  console.log(`\n${key.replace(/\t/g, " ")} (${list.length}):`);
  for (const where of list.slice(0, show)) console.log(`  ${where}`);
}
