#!/usr/bin/env node
/**
 * How often the construction reader is wrong, measured before it is allowed a
 * verdict that accuses.
 *
 *   npm run measure:constructs                 -- this repo, orangutan, mundane, infrarouter
 *   npm run measure:constructs -- <path>...    -- any trees you like
 *
 * `constructs.ts` may say **backwards**, which is an accusation: your arrow
 * points one way and the construction runs the other. So a reader bug here is
 * not a missed finding, it is the tool telling somebody their correct diagram is
 * wrong -- and that is not recoverable by being right afterwards.
 *
 * Three questions, and they are not the same:
 *
 *   1. **Does it miss a construction that is plainly written?** A miss in the
 *      arrow's own direction, paired with a hit in the other, is exactly how a
 *      false `backwards` happens. The referee is a text scan, sharing no
 *      machinery with the syntax walk. The bar is **zero**.
 *
 *   2. **Does it invent one?** A name the file never constructs must never come
 *      back confirmed, or the confirmations mean nothing and the recall number
 *      is measuring agreement with itself.
 *
 *   3. **How often does it refuse, and why?** A reader that withholds on most
 *      real routines is safe and useless. Reported per language and per reason,
 *      because refusals concentrated in one language are a different problem
 *      from refusals spread evenly -- and here they are concentrated by design:
 *      Python spells construction as a call and gets no verdicts at all.
 *
 * The reader is driven through its public interface, the same call `drift.ts`
 * makes. A measurement that needs its own door into the thing it measures is
 * measuring a different thing.
 *
 * A run is a measurement, not a test: it prints and never fails. The bugs it
 * finds become tests.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { constructions } from "../src/engine/constructs";
import { mayAccuse } from "../src/engine/licence";
import { initEngine, languageOf, type Language } from "../src/engine/parse";

await initEngine();

const HOME = process.env.HOME ?? "/Users/noelmatero";
const roots = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));

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

/**
 * The referee: routines and what they construct, read out of the source *text*.
 *
 * Crude on purpose, and it claims only what a person would read off the screen
 * without hesitating: a line that opens a named routine, then the `new X`, `X {`
 * and `<X` tokens that follow it before the next one opens.
 *
 * It does not understand scope, so a construction inside a nested closure is
 * credited to the enclosing routine -- which is the same answer the reader gives
 * and the same answer a person would. It does not understand Rust's `X::new`, or
 * Python at all, because neither does the reader.
 *
 * It will miss things the reader finds, and that direction is fine. The
 * direction that matters is the reverse: a construction the referee reads
 * straight off the screen and the reader cannot see.
 */
const TS_OPENS =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)|^\s*(?:export\s+)?const\s+(\w+)\s*(?::[^=]*)?=\s*(?:async\s*)?\(/;

const OPENS = new Map<Language, RegExp>([
  ["rust", /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/],
  // `export default function` is one of the two ways React writes a component,
  // and leaving it out meant the routine before it never closed -- so a
  // component's JSX was credited to the helper above it.
  ["ts", TS_OPENS],
  ["tsx", TS_OPENS],
  ["js", TS_OPENS],
]);

/** `new X`, which is the one spelling every C-family language shares. */
const NEW_MADE = /\bnew\s+([A-Z]\w*(?:\.\w+)*)\s*[(<]/g;

/**
 * A JSX element -- **only** in a language that has JSX.
 *
 * Applied everywhere at first, and the cost was immediate: `Promise<BoardHistory>`
 * matches it, so every generic type argument in every `.ts` file was read as a
 * component being constructed. 613 questions in TypeScript, 78 of which the
 * reader agreed with, and the other 535 were the referee inventing constructions
 * out of type annotations.
 *
 * The leading character matters for the same reason inside a `.tsx` file, where
 * both forms are legal: `useRef<HTMLInputElement>` is a generic call and
 * `<MenuContent />` is an element, and what separates them is whether a name
 * comes immediately before the `<`.
 */
const JSX_MADE = /(^|[^\w$])<([A-Z]\w*)[\s/>]/g;
/**
 * Rust's struct literal.
 *
 * The brace is what separates `RouteInfo { .. }` from a bare mention, and the
 * lookbehinds separate it from the three things that also put a capitalised name
 * in front of a brace and construct nothing: `impl Foo {`, `struct Foo {`, and
 * -- the one that cost the most -- `fn make() -> Response {`, where the brace
 * belongs to the function body and the name is the return type. Without that
 * last one, every constructor-shaped function in orangutan read as constructing
 * its own return type and the reader was blamed for not seeing it.
 */
const RUST_MADE = /(?<!\b(?:impl|struct|enum|union|trait|mod|for)\s)(?<!->\s)(?<!->)\b([A-Z]\w*)\s*\{/g;

const tailOf = (name: string) => name.split(".").pop()!;

interface RefereeRoutine {
  name: string;
  makes: string[];
  line: number;
}

function refereeRoutines(source: string, language: Language): RefereeRoutine[] {
  const opens = OPENS.get(language);
  if (!opens) return [];

  /*
   * Block comments removed before anything else. This file's own header
   * contains `new Foo(new Bar())` as an example, and the referee read it as
   * `madeBy` constructing a Foo -- a disagreement invented entirely out of
   * documentation.
   */
  const lines = source.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, " ")).split("\n");
  const found: RefereeRoutine[] = [];
  let current: RefereeRoutine | undefined;
  /*
   * Where the routine ends, by brace depth.
   *
   * Without this the referee had no notion of an ending at all: it credited
   * everything up to the next routine it recognised, so in a React file the
   * component's JSX was attributed to whichever inner arrow function happened to
   * be declared above it -- `changeMaxNumber makes TabsList`, and 40-odd more of
   * the same shape. The reader scopes correctly and was being blamed for it.
   */
  let depth = 0;
  let opened = 0;

  for (const [index, line] of lines.entries()) {
    const start = opens.exec(line);
    if (start) {
      current = { name: start[1] ?? start[2]!, makes: [], line: index + 1 };
      found.push(current);
      opened = depth;
    }
    if (!current) continue;
    // A trailing comment is prose. Neither it nor a type annotation constructs.
    let code = line.replace(/(\/\/|#).*$/, "");
    if (language === "rust") {
      /*
       * Two things in Rust text look exactly like a struct literal and make
       * nothing, and both cost a disagreement here.
       *
       * A return type: `fn get_client(..) -> &mut Client {` puts a capitalised
       * name immediately before the body's brace. The `->` lookbehind alone did
       * not catch it, because `&mut ` sits in between.
       *
       * A match pattern: `ScorerError::Timeout { ms } => ..` destructures a
       * variant rather than building one. Everything left of `=>` on a match arm
       * is a pattern, so only the right-hand side is read.
       */
      code = code.replace(/->[^{]*(?=\{)/, " ");
      const arm = code.indexOf("=>");
      if (arm !== -1) code = code.slice(arm + 2);
    }
    for (const hit of code.matchAll(NEW_MADE)) current.makes.push(tailOf(hit[1]!));
    if (language === "tsx") {
      for (const hit of code.matchAll(JSX_MADE)) current.makes.push(hit[2]!);
    }
    if (language === "rust") {
      for (const hit of code.matchAll(RUST_MADE)) current.makes.push(hit[1]!);
    }
    depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
    if (depth <= opened && !start) current = undefined;
  }
  return found;
}

/** Names nothing draws a box for, so a disagreement about them is noise. */
const BUILT_IN = new Set([
  "Error", "String", "Map", "Set", "Date", "RegExp", "Promise", "Array", "Object",
  "Vec", "HashMap", "HashSet", "BTreeMap", "Box", "Some", "None", "Ok", "Err",
  "Self", "Number", "Boolean", "Symbol", "WeakMap", "TextEncoder", "TextDecoder",
  "URL", "URLSearchParams", "AbortController", "Intl", "JSON", "Math",
]);

const missed: Array<{ file: string; routine: string; name: string; line: number }> = [];
const invented: Array<{ file: string; routine: string }> = [];
/** Refusals, named rather than only counted, so a high rate can be checked. */
const held: Array<{ file: string; routine: string; name: string; why: string; line: number }> = [];
const asked = new Map<Language, number>();
const agreed = new Map<Language, number>();
const refusals = new Map<Language, Map<string, number>>();
const files = new Map<Language, number>();
let routines = 0;

const bump = <K,>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);

for (const tree of trees) {
  for (const file of sourceFiles(tree)) {
    const language = languageOf(file)!;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    bump(files, language);

    for (const declared of refereeRoutines(source, language)) {
      routines += 1;
      const wanted = [...new Set(declared.makes)].filter((name) => !BUILT_IN.has(name));
      for (const name of wanted) {
        bump(asked, language);
        const verdict = constructions(source, declared.name, [name], language);
        if (verdict.verdict === "confirmed") { bump(agreed, language); continue; }
        if (verdict.verdict === "withheld") {
          const byReason = refusals.get(language) ?? new Map<string, number>();
          byReason.set(verdict.why, (byReason.get(verdict.why) ?? 0) + 1);
          refusals.set(language, byReason);
          held.push({ file, routine: declared.name, name, why: verdict.why, line: declared.line });
          continue;
        }
        // The reader read the whole routine and did not see a construction the
        // referee read straight off the screen. Paired with a hit in the other
        // direction, every one of these is a false `backwards`.
        missed.push({ file, routine: declared.name, name, line: declared.line });
      }

      /*
       * The other direction: a name the file never constructs must never come
       * back confirmed. Without this the recall number is agreement with
       * itself, which is the mistake that got two orders of magnitude into #190.
       */
      if (wanted.length > 0) {
        const sentinel = "ZzNotARealTypeName";
        if (constructions(source, declared.name, [sentinel], language).verdict === "confirmed") {
          invented.push({ file, routine: declared.name });
        }
      }
    }
  }
}

const LANGUAGES: Language[] = ["rust", "ts", "tsx", "python", "js"];
const percent = (part: number, whole: number) =>
  whole === 0 ? "   n/a" : `${((part / whole) * 100).toFixed(1)}%`.padStart(6);

console.log();
console.log("MEASURE CONSTRUCTS -- can the reader be trusted to say `backwards`?");
console.log(`  ${trees.length} trees, ${[...files.values()].reduce((a, b) => a + b, 0)} files,`
  + ` ${routines} routines the referee could read`);
console.log();
console.log("  " + "language".padEnd(10) + "files".padStart(7) + "asked".padStart(8)
  + "agreed".padStart(8) + "recall".padStart(8) + "refused".padStart(9)
  + "accuses".padStart(9) + "  reasons");
for (const language of LANGUAGES) {
  const total = asked.get(language) ?? 0;
  if (total === 0 && (files.get(language) ?? 0) === 0) continue;
  const ok = agreed.get(language) ?? 0;
  const byReason = refusals.get(language) ?? new Map<string, number>();
  const refused = [...byReason.values()].reduce((a, b) => a + b, 0);
  console.log("  " + language.padEnd(10)
    + String(files.get(language) ?? 0).padStart(7)
    + String(total).padStart(8)
    + String(ok).padStart(8)
    + percent(ok, total).padStart(8)
    + percent(refused, total).padStart(9)
    + (mayAccuse(language) ? "yes" : "no").padStart(9)
    + "  " + ([...byReason.entries()].sort((a, b) => b[1] - a[1])
      .map(([why, count]) => `${why} ${count}`).join(", ") || "—"));
}

console.log();
console.log("  Python is absent from the `asked` column by construction: it spells making one");
console.log("  of something as an ordinary call, so the referee has no pattern and the reader");
console.log("  has no verdict. That is the finding, not a gap in the corpus.");

console.log();
/*
 * By file as well as by count, because a refusal rate that is really one file is
 * a different fact about the language. Rust's first reading was 82% refused,
 * which reads as "this word barely works in Rust" -- and four fifths of it was
 * one 2,500-line generated query module whose every routine is a macro.
 */
const heldFiles = new Map<string, number>();
for (const one of held) heldFiles.set(one.file, (heldFiles.get(one.file) ?? 0) + 1);
console.log(`  REFUSED -- ${held.length} across ${heldFiles.size} files. Named, because a`);
console.log("  refusal rate is only arguable if you can see where it comes from.");
const worst = [...heldFiles.entries()].sort((a, b) => b[1] - a[1])[0];
if (worst && held.length > 0 && worst[1] / held.length > 0.4) {
  console.log(`  ${((worst[1] / held.length) * 100).toFixed(0)}% of them are one file:`
    + ` ${path.relative(HOME, worst[0])}`);
}
for (const one of held.slice(0, 12)) {
  console.log(`    ${one.why.padEnd(12)} ${path.relative(HOME, one.file)}:${one.line}`
    + ` ${one.routine} / ${one.name}`);
}
if (held.length > 12) console.log(`    ... and ${held.length - 12} more`);

console.log();
console.log(`  MISSED -- referee saw the construction, reader did not: ${missed.length}`);
console.log("    The bar is zero. Each one, paired with a hit the other way, is a false `backwards`.");
for (const miss of missed.slice(0, 25)) {
  console.log(`    ${path.relative(HOME, miss.file)}:${miss.line} ${miss.routine} makes ${miss.name}`);
}
if (missed.length > 25) console.log(`    ... and ${missed.length - 25} more`);

console.log();
console.log(`  INVENTED -- reader confirmed a name the file never constructs: ${invented.length}`);
for (const one of invented.slice(0, 10)) {
  console.log(`    ${path.relative(HOME, one.file)} ${one.routine}`);
}
console.log();
