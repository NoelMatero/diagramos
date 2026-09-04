#!/usr/bin/env node
/**
 * How often the field reader is wrong, measured before it is allowed a red.
 *
 *   npm run measure:holds                  -- this repository, rust-test, orangutan, graphify
 *   npm run measure:holds -- <path>...     -- any trees you like
 *
 * `holds.ts` is the second thing in this engine that refutes from an *absence*:
 * it reads a type's field list and, finding no mention of another type, is
 * prepared to say the arrow claiming one is wrong. So a reader bug here is not a
 * missed finding, it is the tool telling somebody their correct diagram is
 * wrong, and that is not recoverable by being right afterwards. The number comes
 * before the word -- `AGENTS.md`, and the reason `licence.ts` exists.
 *
 * Two questions, and they are not the same:
 *
 *   1. **Does the reader miss a type plainly written in the field list?** Every
 *      miss is a potential false accusation. The referee is a text scan of the
 *      declaration source -- deliberately a different mechanism from the syntax
 *      tree the reader walks, so agreeing means two unrelated readings agree
 *      rather than one reading agreeing with itself. The bar is **zero**.
 *
 *   2. **How often does it refuse?** A reader that withholds on most real types
 *      is safe and useless: the word would ship, never fire, and read exactly
 *      like a claim that passed. Reported per language and per reason, because
 *      refusals concentrated in one language are a different problem from
 *      refusals spread evenly.
 *
 * The reader is driven through its public interface -- the same call `drift.ts`
 * makes -- rather than through an enumerate-everything helper written for the
 * measurement. A measurement that needs its own door into the thing it measures
 * is measuring a different thing.
 *
 * A run is a measurement, not a test: it prints and never fails. The bugs it
 * finds become tests.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { heldTypes } from "../src/engine/holds";
import { mayAccuse } from "../src/engine/licence";
import { initEngine, languageOf, type Language } from "../src/engine/parse";

await initEngine();

const HOME = process.env.HOME ?? "/Users/noelmatero";
const roots = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));

/*
 * Four languages, never one. A field is spelled three different ways and a
 * detector that misses a language's spelling produces a confident wrong answer
 * about whether the word generalises -- which has now happened twice in this
 * project, once in graphify and once in the census written for #187.
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

/**
 * The referee: type declarations and their field types, read out of the source
 * *text* by a scanner that never touches a syntax tree.
 *
 * Crude on purpose. It only claims the cases a person would read off the screen
 * without hesitating -- a declaration header, then lines that plainly say `name:
 * Type` -- and it deliberately does not try to understand generics, unions or
 * nesting beyond taking every capitalised word it finds. Being crude is what
 * makes it independent; being independent is the entire point.
 *
 * It will miss things the reader finds, and that direction is fine and not
 * counted against anybody. The direction that matters is the reverse: a name the
 * referee can see plainly and the reader cannot.
 */
interface RefereeType {
  name: string;
  /** Type names written in its field list, as a person would read them off. */
  held: string[];
  line: number;
}

const HEADER = new Map<Language, RegExp>([
  ["rust", /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum)\s+([A-Z]\w*)/],
  ["ts", /^\s*(?:export\s+)?(?:abstract\s+)?(?:interface|class)\s+([A-Z]\w*)/],
  ["tsx", /^\s*(?:export\s+)?(?:abstract\s+)?(?:interface|class)\s+([A-Z]\w*)/],
  ["js", /^\s*(?:export\s+)?class\s+([A-Z]\w*)/],
  ["python", /^\s*class\s+([A-Z]\w*)/],
]);

/** A line a person would read as "this field is of that type". */
const FIELD = new Map<Language, RegExp>([
  ["rust", /^\s*(?:pub(?:\([^)]*\))?\s+)?[a-z_]\w*\s*:\s*(.+?),?\s*$/],
  ["ts", /^\s*(?:readonly\s+|public\s+|private\s+|protected\s+|#)*[\w$]+\??\s*:\s*(.+?);\s*$/],
  ["tsx", /^\s*(?:readonly\s+|public\s+|private\s+|protected\s+|#)*[\w$]+\??\s*:\s*(.+?);\s*$/],
  ["js", /^$/],
  ["python", /^\s+[a-z_]\w*\s*:\s*([A-Z].*?)\s*$/],
]);

/**
 * Type names as a person would read them off a field line.
 *
 * A qualified name is taken whole and then reduced to its last part, because
 * that is what a box is labelled: `React.ReactNode` is a ReactNode, and reading
 * `React` out of it as a second type name produced 60 disagreements that were
 * the referee inventing a type, not the reader missing one.
 */
const NAMES = /\b([A-Z]\w*(?:\.\w+)*)\b/g;
const tailOf = (name: string) => name.split(".").pop()!;

function refereeTypes(source: string, language: Language): RefereeType[] {
  const header = HEADER.get(language);
  const field = FIELD.get(language);
  if (!header || !field) return [];

  const lines = source.split("\n");
  const found: RefereeType[] = [];
  let current: RefereeType | undefined;
  let depth = 0;
  /*
   * Parenthesis depth, so a method's parameter list is never read as a field
   * list. A multi-line `def send(self, request: httpx.Request, ...)` has
   * continuation lines indistinguishable from fields one line at a time, and
   * before this the referee claimed every parameter of every Protocol class in
   * the corpus -- 100-odd disagreements, all of them the referee's.
   */
  let parens = 0;

  for (const [index, line] of lines.entries()) {
    const start = header.exec(line);
    if (start) {
      current = { name: start[1]!, held: [], line: index + 1 };
      found.push(current);
      parens = 0;
      depth = language === "python" ? 0 : (line.match(/{/g) ?? []).length;
      continue;
    }
    if (!current) continue;

    const opened = parens;
    parens += (line.match(/[([]/g) ?? []).length - (line.match(/[)\]]/g) ?? []).length;
    if (parens < 0) parens = 0;
    if (opened > 0) continue;

    if (language === "python") {
      // A blank line does not end a class; an unindented one does.
      if (line.trim() !== "" && !/^\s/.test(line)) { current = undefined; continue; }
    } else {
      const outer = depth;
      depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
      if (depth <= 0) { current = undefined; continue; }
      /*
       * Only the declaration's own level. An interface method taking an inline
       * object -- `send(builder: { from: string | EmailAddress; ... })` -- has
       * members that look exactly like fields one line at a time, and they
       * belong to that anonymous type rather than to the interface. The reader
       * declines to descend into them; before this the referee claimed all of
       * them and reported the reader as having missed 25 types.
       */
      if (outer !== 1) continue;
    }

    /*
     * A trailing comment is prose, not a type. `model_id: Optional[str] = None
     * # HuggingFace ID e.g. "meta-llama/Llama-3.1-8B-Instruct"` has four
     * capitalised words in it and none of them is a field type; every one of the
     * last 11 disagreements was this.
     */
    const code = line.replace(/\s+(#|\/\/).*$/, "");
    const member = field.exec(code);
    if (!member) continue;
    // A method, not a field: the referee declines the same case the reader does.
    if (/\)\s*(?::|=>|\{)/.test(code) || /\(/.test(member[1] ?? "")) continue;
    for (const name of (member[1] ?? "").matchAll(NAMES)) current.held.push(tailOf(name[1]!));
  }
  return found;
}

/** Names nothing draws a box for, so a disagreement about them is noise. */
const BUILT_IN = new Set([
  "String", "Vec", "Option", "Result", "Box", "Arc", "Rc", "HashMap", "HashSet", "BTreeMap",
  "Self", "Array", "Promise", "Map", "Set", "Record", "Partial", "Readonly", "Date", "RegExp",
  "Optional", "List", "Dict", "Any", "Path", "Callable", "Sequence", "Iterable", "Union", "Tuple",
  // Not a type anybody draws a box for, and Python writes it in half its unions.
  "None", "True", "False",
]);

const missed: Array<{ file: string; type: string; name: string; line: number }> = [];
const invented: Array<{ file: string; type: string }> = [];
const asked = new Map<Language, number>();
const agreed = new Map<Language, number>();
const refusals = new Map<Language, Map<string, number>>();
const files = new Map<Language, number>();
let types = 0;

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

    for (const declared of refereeTypes(source, language)) {
      types += 1;
      const wanted = [...new Set(declared.held)].filter((name) => !BUILT_IN.has(name));
      for (const name of wanted) {
        bump(asked, language);
        const verdict = heldTypes(source, declared.name, [name], language);
        if (verdict.verdict === "confirmed") { bump(agreed, language); continue; }
        if (verdict.verdict === "withheld") {
          const byReason = refusals.get(language) ?? new Map<string, number>();
          byReason.set(verdict.why, (byReason.get(verdict.why) ?? 0) + 1);
          refusals.set(language, byReason);
          continue;
        }
        // The reader read the whole field list and did not see a name the
        // referee read straight off the screen. Every one of these is an arrow
        // that would be told it is wrong when it is not.
        missed.push({ file, type: declared.name, name, line: declared.line });
      }

      /*
       * The other direction, cheaply: a name that appears nowhere in the file
       * must never confirm. A reader that says yes to anything is not refuting,
       * it is agreeing, and the recall number above would not notice.
       */
      const sentinel = "ZzNotARealTypeName";
      if (heldTypes(source, declared.name, [sentinel], language).verdict === "confirmed") {
        invented.push({ file, type: declared.name });
      }
    }
  }
}

const LANGUAGES: Language[] = ["rust", "ts", "tsx", "python", "js"];
const percent = (part: number, whole: number) =>
  whole === 0 ? "   n/a" : `${((part / whole) * 100).toFixed(1)}%`.padStart(6);

console.log();
console.log("MEASURE HOLDS -- can the field reader be trusted with a red?");
console.log(`  ${trees.length} trees, ${[...files.values()].reduce((a, b) => a + b, 0)} files,`
  + ` ${types} type declarations the referee could read`);
console.log();
/*
 * `may accuse` is on the table rather than in a footnote, because the recall
 * number reads as a licence when it is not one. "python 74.6%" invites the
 * reading that the other three quarters are refutable; they are not, and
 * nothing in the table said so until this column existed.
 */
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
    + (mayAccuse("holds", language) ? "yes" : "no").padStart(9)
    + "  " + ([...byReason.entries()].sort((a, b) => b[1] - a[1])
      .map(([why, count]) => `${why} ${count}`).join(", ") || "—"));
}

console.log();
const unlicensed = LANGUAGES.filter((language) =>
  (asked.get(language) ?? 0) > 0 && !mayAccuse("holds", language));
if (unlicensed.length > 0) {
  console.log();
  console.log(`  ${unlicensed.join(", ")} has a grammar and no measured licence for \`holds\`, so`);
  console.log("  an absence there is withheld however good the recall looks. Confirming is");
  console.log("  unaffected. The recall above is what a licence would be measuring, not a");
  console.log("  licence -- and it is asked per word now, so a yes here says this reader was");
  console.log("  measured rather than that some reader was (#198, #207).");
}

console.log();
console.log(`  MISSED -- referee saw the name, reader did not: ${missed.length}`);
console.log("    The bar is zero. Each one is an arrow that would be called wrong when it is right.");
for (const miss of missed.slice(0, 25)) {
  console.log(`    ${path.relative(HOME, miss.file)}:${miss.line} ${miss.type} holds ${miss.name}`);
}
if (missed.length > 25) console.log(`    ... and ${missed.length - 25} more`);

console.log();
console.log(`  INVENTED -- reader confirmed a name that is not in the file: ${invented.length}`);
for (const one of invented.slice(0, 10)) {
  console.log(`    ${path.relative(HOME, one.file)} ${one.type}`);
}
console.log();
