#!/usr/bin/env node
/**
 * Whether "no such member" is ever said about a member a TypeScript class
 * really has through a parent (#398).
 *
 *   npm run measure:inherited-members                -- the five TypeScript clones in .corpus
 *   npm run measure:inherited-members -- <root>...   -- any trees you like
 *
 * For every class with a parent, every member name written in the class or in
 * any in-tree ancestor is asked, the way `@accesses` asks it: `declaresMember`
 * with the TypeScript compiler behind it, as `drift.ts` wires it. **None may
 * come back "no such member".** That is the column, and the bar is zero.
 *
 * #394 found the compiler's member list alone says "none" wrongly in two real
 * shapes -- a parent's `#private` fields, an implemented interface's optional
 * member the class never declares -- 142 of 3,897 names. The product needs the
 * parents' text to agree, and this is the run that says whether that holds.
 *
 * A second row asks each class for a name nothing declares, so a zero above
 * cannot come from a check that never says no.
 *
 * ## The referee
 *
 * The names written are read by `scripts/lib/access-scan.ts`, the text scan
 * `measure:accesses` uses, which shares no tree-sitter query with the reader.
 * Which classes are a class's ancestors comes from the compiler, as it does
 * for the product; an ancestor outside the repository is not read, and the
 * product holds back on those classes, which the run counts.
 *
 * ## What it cannot see
 *
 * - A member a parent gets by declaration merging or a mixin's intersection.
 * - An interface's parents: the compiler answers `ancestorsAt` for classes.
 *
 * Each tree runs in a process of its own, and a tree that fails is named.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { refereeTypes } from "./lib/access-scan";
import { sourceFiles } from "./lib/source-files";

import { declaresMember, type InheritedMembers } from "../src/engine/accesses";
import { initEngine, languageOf, type Language } from "../src/engine/parse";
import { createClosedBodyReferee } from "../src/engine/referee";

const CORPUS = existsSync(path.resolve(import.meta.dirname, "..", ".corpus"))
  ? path.resolve(import.meta.dirname, "..", ".corpus")
  : path.join(process.env.HOME ?? "", "board-ai", ".corpus");
const TREES = ["TanStack-query", "vuejs-core", "excalidraw-excalidraw", "nestjs-nest", "vitejs-vite"];

interface TreeResult {
  tree: string;
  /** Classes with a parent the compiler could list. */
  classes: number;
  /** Of those, held back whole: a parent outside the repository, or one the referee could not read. */
  heldBack: number;
  asked: number;
  has: number;
  withheld: number;
  /** Written in the class or a parent, and called missing. Must be empty. */
  missing: string[];
  /** A name nothing declares: how often each class says no, holds back, or (wrongly) yes. */
  nobody: { no: number; withheld: number; yes: number };
}

const one = process.argv.find((arg) => arg.startsWith("--one="))?.slice("--one=".length);
if (one) {
  process.stdout.write(`\n@@RESULT ${JSON.stringify(await measureOne(one))}\n`);
  process.exit(0);
}

const roots = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const trees = roots.length > 0 ? roots.map((root) => path.resolve(root)) : TREES.map((tree) => path.join(CORPUS, tree));
const results: TreeResult[] = [];
const failed: string[] = [];
const self = fileURLToPath(import.meta.url);
for (const tree of trees) {
  process.stderr.write(`${path.basename(tree)}...\n`);
  const run = spawnSync(process.execPath, [...process.execArgv, self, `--one=${tree}`], {
    encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env },
  });
  const line = run.stdout.split("\n").find((text) => text.startsWith("@@RESULT "));
  if (run.status !== 0 || !line) {
    failed.push(`${path.basename(tree)} (exit ${run.status}): ${(run.stderr || "").trim().split("\n").slice(-3).join(" | ")}`);
    continue;
  }
  results.push(JSON.parse(line.slice("@@RESULT ".length)) as TreeResult);
}

const sum = (pick: (result: TreeResult) => number) => results.reduce((total, result) => total + pick(result), 0);
console.log(`\n@accesses into a TypeScript class with a parent: ${results.length} tree(s)`);
console.log("  tree                        classes  held back   asked     has  withheld  MISSING   nobody: no / held / yes");
for (const result of results) {
  console.log(`  ${result.tree.padEnd(26)}  ${String(result.classes).padStart(7)}  ${String(result.heldBack).padStart(9)}`
    + `  ${String(result.asked).padStart(6)}  ${String(result.has).padStart(6)}  ${String(result.withheld).padStart(8)}`
    + `  ${String(result.missing.length).padStart(7)}   ${result.nobody.no} / ${result.nobody.withheld} / ${result.nobody.yes}`);
}
console.log(`  ${"total".padEnd(26)}  ${String(sum((r) => r.classes)).padStart(7)}  ${String(sum((r) => r.heldBack)).padStart(9)}`
  + `  ${String(sum((r) => r.asked)).padStart(6)}  ${String(sum((r) => r.has)).padStart(6)}  ${String(sum((r) => r.withheld)).padStart(8)}`
  + `  ${String(sum((r) => r.missing.length)).padStart(7)}   ${sum((r) => r.nobody.no)} / ${sum((r) => r.nobody.withheld)} / ${sum((r) => r.nobody.yes)}`);
console.log("  MISSING must be 0; nobody-yes must be 0.");
const missing = results.flatMap((result) => result.missing.map((name) => `${result.tree}: ${name}`));
if (missing.length > 0) {
  console.log("\n  CALLED MISSING (written in the class or a parent):");
  for (const name of missing) console.log(`    ${name}`);
}
if (failed.length > 0) {
  console.log("\n  FAILED, and not counted:");
  for (const name of failed) console.log(`    ${name}`);
}

async function measureOne(root: string): Promise<TreeResult> {
  await initEngine();
  const result: TreeResult = {
    tree: path.basename(root), classes: 0, heldBack: 0, asked: 0, has: 0, withheld: 0, missing: [],
    nobody: { no: 0, withheld: 0, yes: 0 },
  };
  const referee = createClosedBodyReferee(root);
  if (!referee?.memberAt || !referee.ancestorsAt || !referee.parentsOutsideAt) return result;

  const sources = new Map<string, string | undefined>();
  const read = (file: string): string | undefined => {
    if (!sources.has(file)) {
      try { sources.set(file, readFileSync(path.join(root, file), "utf8")); } catch { sources.set(file, undefined); }
    }
    return sources.get(file);
  };
  /** The referee's member names for the type declared on this 1-based line. */
  const writtenAt = (file: string, line: number): string[] | undefined => {
    const source = read(file);
    const language = languageOf(file);
    if (source === undefined || !language) return undefined;
    return refereeTypes(source, language).find((type) => type.line === line)?.members;
  };

  for (const absolute of sourceFiles(root)) {
    const file = path.relative(root, absolute);
    const language = languageOf(file);
    if ((language !== "ts" && language !== "tsx") || file.endsWith(".d.ts")) continue;
    const source = read(file)!;
    const lines = source.split("\n");
    for (const type of refereeTypes(source, language as Language)) {
      const text = lines[type.line - 1] ?? "";
      const column = text.search(new RegExp(`\\b${type.name}\\b`));
      if (column < 0) continue;
      const start = lines.slice(0, type.line - 1).reduce((total, one) => total + one.length + 1, 0) + column;
      const at = { start, end: start + type.name.length };
      const ancestors = referee.ancestorsAt(file, at);
      const outside = referee.parentsOutsideAt(file, at);
      if (!ancestors || outside === undefined || (ancestors.length === 0 && !outside)) continue;
      result.classes += 1;
      const names = new Set(type.members);
      let readable = !outside;
      for (const ancestor of ancestors) {
        const written = writtenAt(ancestor.file, ancestor.line);
        if (!written) { readable = false; break; }
        for (const name of written) names.add(name);
      }
      if (!readable) result.heldBack += 1;

      const inherited: InheritedMembers = {
        memberAt: (range, name) => referee.memberAt!(file, range, name),
        ancestorsAt: (range) => referee.ancestorsAt!(file, range),
        parentsOutsideAt: (range) => referee.parentsOutsideAt!(file, range),
        read,
      };
      for (const name of names) {
        result.asked += 1;
        const said = declaresMember(source, [type.name], name, language as Language, inherited);
        if ("why" in said) result.withheld += 1;
        else if (said.declares) result.has += 1;
        else result.missing.push(`${file}#${type.name} .${name}`);
      }
      const nobody = declaresMember(source, [type.name], "__board_nobody__", language as Language, inherited);
      if ("why" in nobody) result.nobody.withheld += 1;
      else if (nobody.declares) result.nobody.yes += 1;
      else result.nobody.no += 1;
    }
  }
  return result;
}
