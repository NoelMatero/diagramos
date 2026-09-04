#!/usr/bin/env node
/**
 * How often the member reader is wrong, measured before it is allowed a red.
 *
 *   npm run measure:accesses                 -- this repo, rust-test, orangutan, mundane, infrarouter
 *   npm run measure:accesses -- <path>...    -- any trees you like
 *
 * `accesses.ts` has two ends and they are not on the same footing, so this
 * script has two measurements rather than one. Reporting a single recall over
 * both would hide the only number that matters.
 *
 *   **The type end may accuse.** A member list is a closed region, so a type
 *   that does not declare the member refutes the arrow. A reader that cannot
 *   see a member written in plain sight will call a correct diagram wrong, and
 *   that is not recoverable by being right afterwards. The column is ACCUSED
 *   and the bar is **zero**.
 *
 *   **The routine end never accuses.** Not finding an access in a body is not
 *   evidence there is none, so a reader that misses one costs a confirmation
 *   nobody was owed. The column is MISSED and it is reported because a word
 *   that never confirms is a word that ships and never fires -- not because a
 *   miss there is dangerous.
 *
 * Both directions are checked, per language, and INVENTED is the one that keeps
 * the other two honest: a member no declaration writes down must never come
 * back declared, and a member no body reads must never come back read. Without
 * it a reader that says yes to everything scores perfect recall.
 *
 * ## The referee
 *
 * A text scan of the same source, sharing **no tree-sitter query** with the
 * reader -- so agreeing means two unrelated readings agree rather than one
 * reading agreeing with itself, which is the mistake that got two orders of
 * magnitude into #190.
 *
 * Crude on purpose. It claims only what a person would read off the screen
 * without hesitating: a declaration header, then the lines under it that
 * plainly name a member; a routine opening, then the `.name` tokens inside it.
 * Being crude is what makes it independent, and being independent is the point.
 *
 * ## Why the accusing half is asked directly
 *
 * `declaresMember` rather than `memberAccesses`, and it is the one place this
 * script does not go through the front door. The reason is that the licence
 * gate sits in `memberAccesses`: with no measurement there is no licence, so
 * every refutation would come back `unlicensed` and ACCUSED would read zero
 * because nothing was permitted to accuse. A number that cannot be non-zero is
 * not a measurement, and this is the run that has to produce the licence in the
 * first place. `declaresMember` is one of the reader's two halves, not a door
 * cut for the measurement -- and the third block below drives the whole public
 * call on real triples, so the composition is measured too.
 *
 * A run is a measurement, not a test: it prints and never fails. The bugs it
 * finds become tests.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { accessesIn, declaresMember, memberAccesses } from "../src/engine/accesses";
import { mayAccuse } from "../src/engine/licence";
import { initEngine, languageOf, type Language } from "../src/engine/parse";

await initEngine();

const HOME = process.env.HOME ?? "/Users/noelmatero";
const roots = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));

/*
 * Four languages, never one. A member is spelled four different ways and a
 * detector that misses a language's spelling produces a confident wrong answer
 * about whether the word generalises -- which has now happened twice here.
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

/* ------------------------------------------------------------------ *
 * The referee, part one: what a type declares.
 * ------------------------------------------------------------------ */

interface RefereeType {
  name: string;
  /** Member names written in its declaration, as a person would read them off. */
  members: string[];
  line: number;
}

/**
 * A declaration header, and the parent clause if it has one.
 *
 * The parent is captured rather than skipped, because the reader withholds on
 * an inherited member list and a referee that never offered it one would be
 * unable to say how often that refusal fires.
 */
const HEADER = new Map<Language, RegExp>([
  ["rust", /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Z]\w*)/],
  ["ts", /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:interface|class)\s+([A-Z]\w*)/],
  ["tsx", /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:interface|class)\s+([A-Z]\w*)/],
  ["js", /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Z]\w*)/],
  ["python", /^\s*class\s+([A-Z]\w*)/],
]);

/** A line a person would read as "this type has a member of this name". */
const MEMBER = new Map<Language, RegExp>([
  ["rust", /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|const|unsafe)\s+)*(?:fn\s+)?([a-z_]\w*)\s*[:(]/],
  ["ts", /^\s*(?:(?:readonly|public|private|protected|static|abstract|declare|get|set|async)\s+)*#?([A-Za-z_$][\w$]*)\??\s*[:(<]/],
  ["tsx", /^\s*(?:(?:readonly|public|private|protected|static|abstract|declare|get|set|async)\s+)*#?([A-Za-z_$][\w$]*)\??\s*[:(<]/],
  ["js", /^\s*(?:(?:static|get|set|async)\s+)*#?([A-Za-z_$][\w$]*)\s*[(=]/],
  ["python", /^\s+(?:def\s+)?([a-z_]\w*)\s*[:(=]/],
]);

/** An attribute a Python method sets on the instance. Most of them are here. */
const SELF_SET = /\bself\.([a-z_]\w*)\s*(?:[:+\-*/|&^]?=[^=]|$)/g;

/** A Rust `impl` block, which is where a struct's methods actually live. */
const RUST_IMPL = /^\s*impl(?:\s*<[^>]*>)?\s+(?:([A-Za-z_]\w*(?:<[^>]*>)?)\s+for\s+)?([A-Z]\w*)/;

/**
 * Words a header line carries that mean the member list is not closed.
 *
 * The reader withholds on these and the referee has to know which lines they
 * are, or every inherited member reads as one the reader lost.
 */
function headerHasParent(line: string, language: Language): boolean {
  if (language === "python") return /^\s*class\s+[A-Z]\w*\s*\(\s*[^)\s]/.test(line);
  if (language === "rust") return /:\s*[A-Z]/.test(line.split("{")[0] ?? "");
  return /\b(extends|implements)\b/.test(line);
}

/**
 * The source with every block comment and docstring blanked, line count intact.
 *
 * A Python docstring is a string literal spanning lines, and it sits at exactly
 * the indent a member sits at. `run_scenario() which patches the four boundary
 * dependencies` in a class docstring read as a member called `run_scenario`,
 * and the reader was blamed for not finding it -- one of the three shapes left
 * in the second run's accusation column, all three of them the referee's.
 */
function blanked(source: string, language: Language): string {
  const hollow = (block: string) => block.replace(/[^\n]/g, " ");
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, hollow);
  if (language === "python") {
    return withoutComments.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, hollow);
  }
  /*
   * A template literal is a string, and this repository keeps whole scripts
   * and stylesheets inside them. `const SCRIPT = \`const fmt = (iso) => { .. }\``
   * in `boards-page.ts` read as fourteen routines the reader could not find,
   * because in the tree they are one string. Blanked, not parsed: what a
   * browser eventually runs is not a declaration in this file.
   */
  return withoutComments.replace(/`(?:[^`\\]|\\.)*`/g, hollow);
}

/**
 * A line with its comments and string literals taken out.
 *
 * The comment marker is per language, and getting that wrong cost the first
 * run more accusations than anything else. `#` is a comment in Python and a
 * **private field sigil** in TypeScript, so stripping it everywhere turned
 * `async #flush(): Promise<void> {` into `async` -- the brace went with it, the
 * method never opened, and every line of its body was read as a member of the
 * enclosing class. `BoardSync has no if` is what that looks like from the far
 * end, and `measure-holds.mts`'s referee carries the same line today.
 */
function strip(line: string, language: Language): string {
  const comment = language === "python" || language === "rust"
    ? /\s+(#|\/\/).*$/
    : /\s+\/\/.*$/;
  return line
    .replace(comment, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

function refereeTypes(source: string, language: Language): RefereeType[] {
  const header = HEADER.get(language);
  const member = MEMBER.get(language);
  if (!header || !member) return [];

  /*
   * Block comments blanked before anything else. This file's own header names
   * members in prose, and so does every well-commented declaration in the
   * corpus; reading them produced disagreements invented entirely out of
   * documentation, which is the trap `measure-constructs.mts` records.
   */
  const lines = blanked(source, language).split("\n");

  const found: RefereeType[] = [];
  const byName = new Map<string, RefereeType>();
  let current: RefereeType | undefined;
  let depth = 0;
  let parens = 0;
  /** The indent a member of the current class sits at. Python has no braces. */
  let bodyIndent = -1;
  /** The indent the class header itself sits at. A nested class is not at 0. */
  let headerIndent = 0;

  for (const [index, line] of lines.entries()) {
    const code = strip(line, language);

    const start = header.exec(line);
    if (start) {
      // An inherited member list is not closed, and the reader says so. The
      // referee drops the declaration rather than offering members it knows the
      // reader will refuse: a refusal counted as a miss is a lie about recall.
      if (headerHasParent(line, language)) { current = undefined; continue; }
      current = { name: start[1]!, members: [], line: index + 1 };
      found.push(current);
      byName.set(current.name, current);
      parens = 0;
      bodyIndent = -1;
      headerIndent = line.length - line.trimStart().length;
      depth = language === "python"
        ? 0
        : (code.match(/{/g) ?? []).length - (code.match(/}/g) ?? []).length;
      /*
       * A declaration written on one line -- `interface Row { rel: string; }` --
       * left `depth` at 1 with nothing after it to close it, so every line of
       * the rest of the file read as one of its members: `Row has no for`,
       * `Fn has no for`. Its own members are on that line, so they are taken
       * off it here and the declaration closes where it was written.
       */
      if (depth <= 0 && language !== "python") {
        for (const one of code.slice(code.indexOf("{") + 1).split(/[;,]/)) {
          const hit = member.exec(` ${one.trim()}`);
          if (hit) current.members.push(hit[1]!);
        }
        current = undefined;
      }
      continue;
    }

    /*
     * Rust keeps the methods somewhere else, so an `impl` block is folded back
     * onto the struct it belongs to. Without this every Rust method read as a
     * member the reader had invented -- the reader looks in the impl blocks and
     * the referee, reading top to bottom, had already closed the struct.
     */
    if (language === "rust") {
      const impl = RUST_IMPL.exec(line);
      if (impl) {
        // A trait impl brings the trait's names, not the type's own. Skipped:
        // the reader counts them and a disagreement about them is not about
        // whether either side can read a declaration.
        current = impl[1] ? undefined : byName.get(impl[2]!);
        depth = (line.match(/{/g) ?? []).length;
        continue;
      }
    }

    if (!current) continue;

    if (language === "python") {
      for (const hit of code.matchAll(SELF_SET)) current.members.push(hit[1]!);
      /*
       * A blank line does not end a class. A line back at or left of the
       * header's own indent does -- **not** a line at column 0, which was the
       * first rule and the last eleven accusations in the corpus. `class
       * FakeDB:` declared inside a test method sits at indent 8, so `with
       * patch(` at indent 8 never closed it and every keyword argument
       * underneath read as one of its members.
       */
      if (line.trim() === "") continue;
      const here = line.length - line.trimStart().length;
      if (here <= headerIndent) { current = undefined; continue; }
      /*
       * Only the class's own indent level, which is the brace check one
       * language over.
       *
       * Without it the referee read every local variable in every method as a
       * member of the enclosing class -- `hv = ..` inside `MinHash.update`,
       * `base_url = ..` inside `BaseSDK._get_url`, and `return` and `assert`
       * lines besides. It then blamed the reader for not finding them, which
       * was 180-odd of the first run's 321 accusations and every one of them
       * the referee's.
       */
      if (bodyIndent === -1) bodyIndent = here;
      if (here !== bodyIndent) continue;
    } else {
      const outer = depth;
      depth += (code.match(/{/g) ?? []).length - (code.match(/}/g) ?? []).length;
      if (depth <= 0) { current = undefined; continue; }
      // Only the declaration's own level. An inline object type's members look
      // exactly like members one line at a time and belong to that type.
      if (outer !== 1) continue;
    }

    const opened = parens;
    parens += (code.match(/[([]/g) ?? []).length - (code.match(/[)\]]/g) ?? []).length;
    if (parens < 0) parens = 0;
    // A continuation line of a multi-line parameter list is not a member.
    if (opened > 0) continue;

    const hit = member.exec(code);
    if (hit) current.members.push(hit[1]!);
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * The referee, part two: what a routine reads.
 * ------------------------------------------------------------------ */

/*
 * The `const` half wants an arrow, not just a parenthesis. `const raced =
 * (await findServing(root)) ?? ..` opens a paren and declares no routine, so
 * every `.name` for the rest of the enclosing function was credited to a
 * variable -- and `measure-constructs.mts` carries this regex unchanged.
 */
const TS_OPENS =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)|^\s*(?:export\s+)?const\s+(\w+)\s*(?::[^=]*)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]*)?=>/;

const OPENS = new Map<Language, RegExp>([
  ["rust", /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/],
  ["ts", TS_OPENS],
  ["tsx", TS_OPENS],
  ["js", TS_OPENS],
  ["python", /^\s*(?:async\s+)?def\s+(\w+)/],
]);

/**
 * A member read off a value. The one spelling all four languages share.
 *
 * The lookbehind is spread syntax, which is three dots and no member: `{
 * ...raced, started: false }` read as `raced` reading a member called `raced`,
 * and JavaScript object literals are full of it.
 */
const READ = /(?<!\.)\.([A-Za-z_$][\w$]*)/g;

interface RefereeRoutine {
  name: string;
  reads: string[];
  line: number;
}

function refereeRoutines(source: string, language: Language): RefereeRoutine[] {
  const opens = OPENS.get(language);
  if (!opens) return [];

  const lines = blanked(source, language).split("\n");

  const found: RefereeRoutine[] = [];
  let current: RefereeRoutine | undefined;
  let depth = 0;
  let opened = 0;
  let indent = 0;

  for (const [index, line] of lines.entries()) {
    const start = opens.exec(line);
    if (start) {
      current = { name: start[1] ?? start[2]!, reads: [], line: index + 1 };
      found.push(current);
      opened = depth;
      indent = line.length - line.trimStart().length;
      if (language === "python") continue;
    }
    if (!current) continue;

    if (language === "python") {
      // Indentation is the whole of Python's scoping, and a blank line is not
      // the end of anything.
      const here = line.length - line.trimStart().length;
      if (line.trim() !== "" && here <= indent) { current = undefined; continue; }
    }

    // A trailing comment is prose, and a string is not a member read. `"a.b"`
    // and a docstring between them accounted for most of the first run's noise.
    const code = line
      .replace(/(\/\/|#).*$/, "")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");

    for (const hit of code.matchAll(READ)) current.reads.push(hit[1]!);

    if (language !== "python") {
      depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
      if (depth <= opened && !start) current = undefined;
    }
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * The run.
 * ------------------------------------------------------------------ */

/**
 * Names nothing draws a box for, so a disagreement about them is noise.
 *
 * Deliberately short. The point of this word is ordinary members with ordinary
 * names, and a long exclusion list is a way of not measuring the population.
 */
const BUILT_IN = new Set([
  "length", "prototype", "constructor", "toString", "valueOf", "name",
  "then", "catch", "finally", "map", "filter", "forEach", "push", "pop", "slice",
  "join", "split", "trim", "replace", "test", "exec", "match", "keys", "values",
  "entries", "has", "get", "set", "add", "delete", "size", "clone", "unwrap",
  "iter", "collect", "into", "to_string", "append", "extend", "items", "format",
]);

const accused: Array<{ file: string; type: string; member: string; line: number }> = [];
const missed: Array<{ file: string; routine: string; member: string; line: number }> = [];
const invented: Array<{ file: string; where: string; end: string }> = [];

const declaredAsked = new Map<Language, number>();
const declaredAgreed = new Map<Language, number>();
const declaredRefused = new Map<Language, Map<string, number>>();
const readAsked = new Map<Language, number>();
const readAgreed = new Map<Language, number>();
/** The whole public call, on triples the referee produced both ends of. */
const wholeAsked = new Map<Language, number>();
const wholeVerdicts = new Map<Language, Map<string, number>>();

const files = new Map<Language, number>();
let types = 0;
let routines = 0;

const bump = <K,>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);
const bump2 = (map: Map<Language, Map<string, number>>, language: Language, key: string) => {
  const inner = map.get(language) ?? new Map<string, number>();
  inner.set(key, (inner.get(key) ?? 0) + 1);
  map.set(language, inner);
};

const SENTINEL = "zzNotARealMemberName";

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

    const declaredTypes = refereeTypes(source, language);
    const declaredRoutines = refereeRoutines(source, language);

    /* A · the accusing end. Every one of these that comes back refuted is a red
     * on a diagram whose author read the declaration and was right. */
    for (const type of declaredTypes) {
      types += 1;
      const wanted = [...new Set(type.members)].filter((name) => !BUILT_IN.has(name));
      for (const name of wanted) {
        bump(declaredAsked, language);
        const verdict = declaresMember(source, [type.name], name, language);
        if ("why" in verdict) { bump2(declaredRefused, language, verdict.why); continue; }
        if (verdict.declares) { bump(declaredAgreed, language); continue; }
        accused.push({ file, type: type.name, member: name, line: type.line });
      }

      // The other direction: a member no declaration writes down must never
      // come back declared, or the recall above is agreement with itself.
      const sentinel = declaresMember(source, [type.name], SENTINEL, language);
      if (!("why" in sentinel) && sentinel.declares) {
        invented.push({ file, where: type.name, end: "type" });
      }
    }

    /* B · the confirming end. A miss here costs a confirmation, never a red. */
    for (const routine of declaredRoutines) {
      routines += 1;
      const wanted = [...new Set(routine.reads)].filter((name) => !BUILT_IN.has(name));
      for (const name of wanted) {
        bump(readAsked, language);
        if (accessesIn(source, routine.name, name, language)) { bump(readAgreed, language); continue; }
        missed.push({ file, routine: routine.name, member: name, line: routine.line });
      }
      if (wanted.length > 0 && accessesIn(source, routine.name, SENTINEL, language)) {
        invented.push({ file, where: routine.name, end: "routine" });
      }
    }

    /* C · the whole public call, on triples the referee produced both ends of:
     * a routine that reads a member, and a type in the same file that declares
     * one of that name. The composition is what `drift.ts` runs. */
    const declares = new Map<string, string>();
    for (const type of declaredTypes) {
      for (const name of type.members) if (!declares.has(name)) declares.set(name, type.name);
    }
    for (const routine of declaredRoutines) {
      for (const name of [...new Set(routine.reads)].filter((one) => !BUILT_IN.has(one))) {
        const owner = declares.get(name);
        if (!owner) continue;
        bump(wholeAsked, language);
        const verdict = memberAccesses(source, routine.name, name, language, {
          source, names: [owner], language,
        });
        bump2(wholeVerdicts, language,
          verdict.verdict === "withheld" ? `withheld/${verdict.why}` : verdict.verdict);
      }
    }
  }
}

const LANGUAGES: Language[] = ["rust", "ts", "tsx", "python", "js"];
const percent = (part: number, whole: number) =>
  whole === 0 ? "   n/a" : `${((part / whole) * 100).toFixed(1)}%`.padStart(6);
const total = (map: Map<Language, number>) => [...map.values()].reduce((a, b) => a + b, 0);

console.log();
console.log("MEASURE ACCESSES -- can the member reader be trusted with a red?");
console.log(`  ${trees.length} trees, ${total(files)} files, ${types} type declarations`
  + ` and ${routines} routines the referee could read`);
console.log();
console.log("  Two ends, two footings, two tables. The first can accuse and the second");
console.log("  cannot, so a single recall over both would hide the only number that matters.");

console.log();
console.log("A · THE TYPE END -- does the type declare the member? This one may say wrong.");
console.log("  " + "language".padEnd(10) + "files".padStart(7) + "asked".padStart(8)
  + "agreed".padStart(8) + "recall".padStart(8) + "refused".padStart(9)
  + "accuses".padStart(9) + "  reasons");
for (const language of LANGUAGES) {
  const asked = declaredAsked.get(language) ?? 0;
  if (asked === 0 && (files.get(language) ?? 0) === 0) continue;
  const ok = declaredAgreed.get(language) ?? 0;
  const byReason = declaredRefused.get(language) ?? new Map<string, number>();
  const refused = [...byReason.values()].reduce((a, b) => a + b, 0);
  console.log("  " + language.padEnd(10)
    + String(files.get(language) ?? 0).padStart(7)
    + String(asked).padStart(8)
    + String(ok).padStart(8)
    + percent(ok, asked).padStart(8)
    + percent(refused, asked).padStart(9)
    + (mayAccuse("accesses", language) ? "yes" : "no").padStart(9)
    + "  " + ([...byReason.entries()].sort((a, b) => b[1] - a[1])
      .map(([why, count]) => `${why} ${count}`).join(", ") || "—"));
}

console.log();
console.log("B · THE ROUTINE END -- does the body read the member? This one never accuses.");
console.log("  " + "language".padEnd(10) + "asked".padStart(8) + "agreed".padStart(8)
  + "recall".padStart(8));
for (const language of LANGUAGES) {
  const asked = readAsked.get(language) ?? 0;
  if (asked === 0) continue;
  const ok = readAgreed.get(language) ?? 0;
  console.log("  " + language.padEnd(10) + String(asked).padStart(8)
    + String(ok).padStart(8) + percent(ok, asked).padStart(8));
}

console.log();
console.log("C · THE WHOLE CALL -- the composition `drift.ts` runs, on real triples.");
for (const language of LANGUAGES) {
  const asked = wholeAsked.get(language) ?? 0;
  if (asked === 0) continue;
  const byVerdict = wholeVerdicts.get(language) ?? new Map<string, number>();
  console.log("  " + language.padEnd(10) + String(asked).padStart(8) + "  "
    + [...byVerdict.entries()].sort((a, b) => b[1] - a[1])
      .map(([what, count]) => `${what} ${count}`).join(", "));
}

console.log();
console.log(`  ACCUSED -- referee read the member off the declaration, reader refutes it: ${accused.length}`);
console.log("    The bar is zero. Each one is an arrow that would be called wrong when it is right.");
for (const one of accused.slice(0, 25)) {
  console.log(`    ${path.relative(HOME, one.file)}:${one.line} ${one.type} has no ${one.member}`);
}
if (accused.length > 25) console.log(`    ... and ${accused.length - 25} more`);

console.log();
console.log(`  MISSED -- referee read the access, reader did not: ${missed.length}`);
console.log("    Not a red. Each one is a confirmation nobody gets, which is what a word");
console.log("    that ships and never fires is made of.");
for (const one of missed.slice(0, 15)) {
  console.log(`    ${path.relative(HOME, one.file)}:${one.line} ${one.routine} reads ${one.member}`);
}
if (missed.length > 15) console.log(`    ... and ${missed.length - 15} more`);

console.log();
console.log(`  INVENTED -- reader affirmed a name that is not there: ${invented.length}`);
for (const one of invented.slice(0, 10)) {
  console.log(`    ${one.end.padEnd(8)} ${path.relative(HOME, one.file)} ${one.where}`);
}
console.log();
