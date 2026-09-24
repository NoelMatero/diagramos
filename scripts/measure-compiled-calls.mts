#!/usr/bin/env node
/**
 * Does the Rust compiler's call list ever say "never" to a call that happens? (#357)
 *
 *   npm run measure:compiled-calls                -- the five Rust clones in .corpus
 *   npm run measure:compiled-calls -- <path>...   -- any Rust trees you like
 *   npm run measure:compiled-calls -- --cases     -- print every disagreement
 *
 * **The gate for #357. A measurement: it prints and never fails.**
 *
 * ## The question
 *
 * `@calls` may now call an arrow wrong on a Rust board because rustc's own
 * list of the tail's calls (`--emit=mir`) has nothing in it that could reach
 * the head (`compiled-calls.ts`). The accusation is only as good as that
 * "nothing". So: over every routine in every library crate of every pinned
 * Rust repository, take every call **rust-analyzer** says the routine makes
 * to a routine in the repository, and ask the product's own reader whether
 * the compiler's list could have made it. The answer must never be "never".
 *
 * ## The referee
 *
 * rust-analyzer's call hierarchy. It shares nothing with the reader judged:
 * that one reads rustc's MIR dump, matches it to a declaration with
 * tree-sitter and compares names; rust-analyzer resolves the source with its
 * own name resolution and type inference and answers over LSP.
 *
 * ## What it cannot see, stated before anybody reads the zero
 *
 * rust-analyzer drops every call written inside a macro (#355). A call that
 * both tools miss is a call this gate cannot count, and a zero here is a
 * zero over the calls rust-analyzer can see -- necessary, not sufficient.
 * The shapes a name comparison could get wrong where neither tool helps (a
 * call through a trait, an operator, `?`, a function passed as a value, a
 * drop) are the tests in `tests/calls-compiled-rust.test.ts`, one per shape.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { compiledBodiesFor, compiledVerdict, type CallSide } from "../src/engine/calls";
import { compiledBodiesOf } from "../src/engine/compiled-calls";
import { readDependencies } from "../src/engine/deps";
import type { ConfigCache } from "../src/engine/resolve";
import { createWorkspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { compileCrates } from "../src/engine/referee-rustc";
import { createTooling, isOutside, sourceOf } from "./lib/bench-tooling";

const args = process.argv.slice(2);
const showCases = args.includes("--cases");
/** The pinned clones live in the main checkout, as `measure:closed-bodies` reads them; a worktree has none. */
const CORPUS = existsSync(path.resolve(import.meta.dirname, "..", ".corpus"))
  ? path.resolve(import.meta.dirname, "..", ".corpus")
  : path.join(process.env.HOME ?? "", "board-ai", ".corpus");
const DEFAULT_TREES = ["anyhow", "clap", "json", "regex", "ripgrep"].map((one) => path.join(CORPUS, one));
const trees = args.filter((one) => !one.startsWith("--")).map((one) => path.resolve(one));
const SKIP = new Set(["target", "node_modules", ".git", "tests", "benches", "examples", "fuzz"]);

await initEngine();

const say = (line: string) => process.stderr.write(`${line}\n`);

interface Totals {
  routines: number;
  /** How far the product's reader got with each routine. */
  reading: Record<string, number>;
  /** Calls rust-analyzer lists into the repository, from routines the compiler answered for. */
  calls: number;
  /** What the compiler's list said about each of those calls. Every one must be a reason, never "never". */
  said: Record<string, number>;
  /** Routines whose compiled list could refute something: nothing in it goes through a value. */
  closable: number;
}

const all: Totals = { routines: 0, reading: {}, calls: 0, said: {}, closable: 0 };
const violations: string[] = [];
const bump = (into: Record<string, number>, key: string) => { into[key] = (into[key] ?? 0) + 1; };

for (const tree of trees.length > 0 ? trees : DEFAULT_TREES) {
  if (!existsSync(path.join(tree, "Cargo.toml"))) {
    // Said on stdout, with the totals: a tree that was never read is not a tree with nothing wrong in it.
    console.log(`NOT READ ${tree}: no Cargo.toml`);
    continue;
  }
  const name = path.basename(tree);
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith(".") || SKIP.has(entry)) continue;
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".rs")) files.push(path.relative(tree, full).split(path.sep).join("/"));
    }
  };
  walk(tree);

  const began = Date.now();
  const crates = await compileCrates(tree, files, { until: Date.now() + 20 * 60_000 });
  const built = files.filter((file) => crates.crateOf(file));
  say(`${name}: ${files.length} files, ${built.length} in a compiled library crate (${Date.now() - began} ms)`);

  const workspace = createWorkspace(tree);
  const configs: ConfigCache = new Map();
  const sideOf = (file: string): CallSide => {
    const source = sourceOf(path.join(tree, file));
    const declared = readDependencies(file, source, workspace, configs)?.dependencies ?? [];
    return {
      file,
      source,
      language: "rust",
      imports: declared.map((one) => ({ specifier: one.specifier, ...(one.file ? { file: one.file } : {}) })),
      compiled: () => crates.crateOf(file),
    };
  };

  const tooling = await createTooling("rust", tree);
  const totals: Totals = { routines: 0, reading: {}, calls: 0, said: {}, closable: 0 };
  try {
    for (const file of built) {
      const absolute = path.join(tree, file);
      const symbols = await tooling.symbols(absolute);
      if (!symbols) { bump(totals.reading, "rust-analyzer: no symbols"); continue; }
      const side = sideOf(file);
      const asked = new Set<string>();
      for (const symbol of symbols) {
        if (symbol.kind !== "routine" || asked.has(symbol.name)) continue;
        asked.add(symbol.name);
        totals.routines += 1;

        const reading = compiledBodiesOf(crates.crateOf(file)!, file, side.source, symbol.name);
        if (!("bodies" in reading)) { bump(totals.reading, reading.why); continue; }
        const bodies = compiledBodiesFor({ ...side, routine: symbol.name });
        if (!bodies) { bump(totals.reading, "a call the text shows is not in the list"); continue; }
        bump(totals.reading, "answered");
        if (!bodies.bodies.some((body) => body.calls.some((call) => call.kind === "opaque"))) totals.closable += 1;

        // Every declaration of the name, as the product asks: all of them or none.
        const declarations = symbols.filter((one) => one.kind === "routine" && one.name === symbol.name);
        const callees = new Map<string, { file: string; name: string }>();
        for (const declaration of declarations) {
          const locations = await tooling.outgoingCalls(declaration);
          for (const location of locations ?? []) {
            if (isOutside(location.file, tree)) continue;
            const text = sourceOf(location.file).slice(location.start, location.end);
            if (!/^[A-Za-z_]\w*$/.test(text)) continue;
            callees.set(`${location.file}#${text}`, { file: location.file, name: text });
          }
        }
        for (const callee of callees.values()) {
          totals.calls += 1;
          const verdict = compiledVerdict(bodies, { ...sideOf(path.relative(tree, callee.file).split(path.sep).join("/")), names: [callee.name] });
          if ("why" in verdict) { bump(totals.said, verdict.why); continue; }
          bump(totals.said, "NEVER -- rust-analyzer says it calls");
          violations.push(`${name}/${file}#${symbol.name} -> ${path.relative(tree, callee.file)}#${callee.name}`);
        }
      }
    }
  } finally {
    tooling.close();
  }

  say(`${name}: ${totals.routines} routines, ${totals.calls} calls checked`);
  report(name, totals);
  all.routines += totals.routines;
  all.calls += totals.calls;
  all.closable += totals.closable;
  for (const [key, count] of Object.entries(totals.reading)) all.reading[key] = (all.reading[key] ?? 0) + count;
  for (const [key, count] of Object.entries(totals.said)) all.said[key] = (all.said[key] ?? 0) + count;
}

report("ALL", all);
console.log(`\n"never" said to a call rust-analyzer sees: ${violations.length}`);
if (showCases || violations.length <= 20) for (const one of violations) console.log(`  ${one}`);
process.exit(0);

function report(label: string, totals: Totals): void {
  const answered = totals.reading.answered ?? 0;
  const percent = (part: number, whole: number) => (whole === 0 ? "-" : `${((100 * part) / whole).toFixed(1)}%`);
  console.log(`\n== ${label}`);
  console.log(`  routines in compiled library crates  ${totals.routines}`);
  for (const [why, count] of Object.entries(totals.reading).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${why.padEnd(44)} ${String(count).padStart(6)}  ${percent(count, totals.routines)}`);
  }
  console.log(`  answered, and nothing in the list goes through a value  ${totals.closable}  ${percent(totals.closable, answered)} of answered`);
  console.log(`  calls rust-analyzer lists from answered routines         ${totals.calls}`);
  for (const [said, count] of Object.entries(totals.said).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${said.padEnd(44)} ${String(count).padStart(6)}`);
  }
}
