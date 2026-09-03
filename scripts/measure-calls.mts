#!/usr/bin/env node
/**
 * How often the call reader is wrong, measured before it is allowed a verdict
 * that accuses.
 *
 *   npm run measure:calls                 -- this repo, orangutan, mundane, infrarouter
 *   npm run measure:calls -- <path>...    -- any trees you like
 *
 * #189 gates the `@calls` word on this number rather than sequencing it behind
 * the other words, and the reason is that a call is the one relationship that
 * cannot be read inside a single file. A field list, a signature and a file's
 * imports are all local. `foo()` is a name, and which `foo` it means lives
 * somewhere else -- so the question this script exists to settle is **how often
 * the reader can answer at all**, and what it costs when it does.
 *
 * Four questions:
 *
 *   1. **Does it miss a call that is plainly written?** A miss in the arrow's
 *      own direction, paired with a hit in the other, is exactly how a false
 *      `backwards` happens. The bar is **zero**.
 *
 *   2. **Does it accuse on a call the referee can see?** Stronger than a miss and
 *      counted apart: the reader read the forward direction as empty *and* found
 *      a call the other way, so a correct arrow is being told to turn round.
 *      This is the number the decision turns on, and the bar is zero.
 *
 *   3. **Does it invent one?** A name the routine never calls must never come
 *      back confirmed, or the recall figure is agreement with itself.
 *
 *   4. **How often does it refuse, and why?** A reader that withholds on most
 *      real code is safe and useless. Reported per language and per reason,
 *      and split by whether the call crosses a file -- because same-file calls
 *      are the easy half and a number that mixes them hides the whole problem.
 *
 * The referee is a text scan and shares no machinery with the reader: it finds
 * routines by the shape of their opening line, calls by the shape of `name(`,
 * and it resolves nothing at all. Where it needs to know which file declares a
 * name it uses its own index, built the same crude way, and it only asks about
 * names **exactly one file in the tree declares** -- which is the population
 * #189 asks for (a call an arrow could point at) with the ambiguity removed
 * honestly rather than guessed at.
 *
 * A run is a measurement, not a test: it prints and never fails. The bugs it
 * finds become tests.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { callsBetween, type CallSide } from "../src/engine/calls";
import { readDependencies } from "../src/engine/deps";
import { createWorkspace } from "../src/engine/drift";
import { mayAccuse } from "../src/engine/licence";
import { initEngine, languageOf, resetEngineCache, type Language } from "../src/engine/parse";
import type { ConfigCache } from "../src/engine/resolve";

await initEngine();

const HOME = process.env.HOME ?? "/Users/noelmatero";
const flags = new Set(process.argv.slice(2).filter((argument) => argument.startsWith("--")));
const roots = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
/** `--all` prints every miss and every refusal rather than the first handful. */
const showAll = flags.has("--all");
const cap = (count: number) => (showAll ? count : Math.min(count, 20));

const real = (tree: string) => { try { return realpathSync(tree); } catch { return tree; } };

/*
 * Real paths, on purpose. #198's most expensive harness bug was a workspace
 * resolving through a symlink and renaming a whole directory underneath the
 * reader, which manufactured 95 disagreements the reader had right.
 */
const trees = (roots.length > 0 ? roots : [
  path.resolve("src"),
  path.resolve("scripts"),
  path.resolve("rust-test"),
  `${HOME}/orangutan`,
  `${HOME}/board-ai/graphify`,
  `${HOME}/mundane`,
  `${HOME}/infrarouter`,
]).filter((tree) => existsSync(tree)).map(real);

function sourceFiles(root: string): string[] {
  try {
    return execFileSync("find", [root, "-type", "f"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((file) => !/\/(target|node_modules|\.git|dist|out|vendor|\.venv|\.claude)\//.test(file))
      .filter((file) => languageOf(file) !== undefined);
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------- the referee */

const TS_OPENS =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)|^\s*(?:export\s+)?const\s+(\w+)\s*(?::[^=]*)?=\s*(?:async\s*)?\(/;

const OPENS = new Map<Language, RegExp>([
  ["rust", /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/],
  ["ts", TS_OPENS],
  ["tsx", TS_OPENS],
  ["js", TS_OPENS],
  ["python", /^\s*(?:async\s+)?def\s+(\w+)/],
]);

/**
 * Words that put a name in front of a bracket and call nothing.
 *
 * Control flow is most of it. `new` is the one that matters beyond that: a
 * construction is not a call node in any of these grammars, so counting `new
 * Foo(` as a call to `Foo` would blame the reader for a distinction the
 * language makes.
 */
const NOT_CALLS = new Set([
  "if", "for", "while", "switch", "catch", "return", "match", "with", "elif",
  "else", "and", "or", "not", "in", "is", "await", "yield", "typeof", "instanceof",
  "fn", "def", "class", "struct", "enum", "impl", "trait", "let", "const", "var",
  "function", "lambda", "assert", "del", "raise", "throw", "new", "print", "loop",
  "unsafe", "move", "as", "type", "interface", "mod", "use", "pub", "static",
  "do", "try", "except", "finally", "case", "default", "break", "continue",
]);

/**
 * Strings and comments, blanked so a mention in prose is not a call.
 *
 * Per language, and that is not fussiness. Blanking C block comments in Python
 * cost 38 of the 45 disagreements left in one run: a `.graphifyignore` test
 * writes the pattern `/*` into a file, which opens a comment that has no end
 * for two thousand lines. Every `def` in between vanished, one routine appeared
 * to span the rest of the file, and the calls in it were credited to the wrong
 * routine -- which the reader was then blamed for not seeing.
 *
 * Strings go before line comments so a `//` inside a URL survives, and Rust's
 * single quotes are left alone: `&'a str` is a lifetime, and reading it as a
 * character literal eats the rest of the line.
 *
 * Rust's raw strings are the same lesson as the template literal, found the same
 * way. `r#".."#` spans lines and honours no escape, so the per-line rule below
 * never closes one: ripgrep writes every flag's help text as a multi-line raw
 * string, and the prose in them read as code. `enabled`, `files` and `dot` are
 * ordinary English words and each is also a routine ripgrep declares exactly
 * once, so five calls were credited to `doc_long` and counted as the reader
 * missing them. Blanked with the block forms, before the line split.
 */
function stripNoise(source: string, language: Language): string {
  const blank = (block: string) => block.replace(/[^\n]/g, " ");
  const text = language === "python"
    ? source.replace(/"""[\s\S]*?"""/g, blank).replace(/'''[\s\S]*?'''/g, blank)
    : source.replace(/\/\*[\s\S]*?\*\//g, blank);
  /*
   * A template literal spans lines, so it is blanked with the block forms
   * rather than per line. A spinner's CSS keyframes live in one, and
   * `transform: rotate(45deg)` in there read as a call to a `rotate` declared
   * on the other side of the monorepo.
   */
  const spanned = language === "python" ? text : text.replace(/`(?:[^`\\]|\\.)*`/g, blank);
  /*
   * Most hashes first, because `r#"` is a prefix of `r##"` and the shorter
   * pattern would close on the longer one's opening quote. Three is past what
   * any of this corpus writes; a fourth would read as an ordinary string and
   * fail the way it does today rather than a new way.
   */
  const spanning = language === "rust"
    ? spanned.replace(
        /\bb?r###"[\s\S]*?"###|\bb?r##"[\s\S]*?"##|\bb?r#"[\s\S]*?"#|\bb?r"[^"]*"/g,
        blank,
      )
    : spanned;
  const quoted = language === "rust"
    ? /"(?:[^"\\\n]|\\.)*"/g
    : /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
  const comment = language === "python" ? /#.*$/ : /\/\/.*$/;
  return spanning.split("\n")
    .map((line) => line.replace(quoted, '""').replace(comment, ""))
    .join("\n");
}

interface RefereeRoutine {
  name: string;
  line: number;
  /** Names it calls, each with the line the call is on. */
  calls: Array<{ name: string; line: number; via: "bare" | "receiver" }>;
}

/**
 * A name in front of a bracket.
 *
 * `$` counts as part of an identifier, which is what keeps `db.$count(..)` from
 * reading as a bare call to a `count` declared elsewhere: without it the word
 * boundary falls between the `$` and the name, and the receiver disappears.
 */
const CALL_TOKEN = /([A-Za-z_$][\w$]*)\s*\(/g;

/**
 * Whether the calling file binds this name itself.
 *
 * The referee's own blind spot, stated rather than worked around. Its index
 * knows which files *declare a routine* of a name, and it recognises a routine
 * by the shape of its opening line -- so `const applyVar = React.useCallback(`
 * and `const provider = registry.get(elementId)` are invisible to it. When one
 * of those shares a name with a routine somewhere else in the tree, the referee
 * reads the local call as a call across the repository, and the reader
 * correctly disagrees.
 *
 * Five of the last five disagreements were exactly that. A referee that cannot
 * tell which of two same-named things is meant has no business asking, so it
 * does not ask.
 */
function bindsLocally(source: string, name: string): boolean {
  return new RegExp(`\\b(?:const|let|var|function|def|fn|class|struct)\\s+${name}\\b`).test(source);
}

/**
 * A method written in an object literal: `dispose() { .. }`, `play(name) { .. }`.
 *
 * A definition, not a call, and it looks exactly like one to a text scan. Six
 * of the disagreements in one run were an audio patch's `play`, `get` and
 * `dispose` shorthand methods being read as calls to same-named routines
 * elsewhere in the monorepo.
 *
 * The shape is the name at the head of the line and a brace at the end of it,
 * with no arrow in between -- `describe("x", () => {` is a call and keeps its
 * arrow, which is what separates the two.
 */
function isMethodShorthand(line: string, at: number): boolean {
  return line.slice(0, at).trim() === "" && /\{\s*$/.test(line) && !line.includes("=>");
}

/**
 * Whether a call token was written on a receiver: `path.resolve(..)`,
 * `Type::make(..)`, `obj?.run(..)`.
 *
 * This is the referee's own limit, and it decides the population. A text scan
 * can say with certainty that `foo()` is a call to whatever `foo` is; it cannot
 * say the first thing about whose `resolve` is being called in `path.resolve()`.
 * Counting those as calls to a same-named routine in the repository is how the
 * referee accused the reader of missing 137 calls to `_file_stem` and one to
 * `resolve` in `apps/server/src/lib/slack/config-token.ts`, which is Node's
 * `path.resolve` and nothing to do with that file at all.
 *
 * So the two populations are reported apart. A receiver call is a call the
 * referee cannot place either, and the reader refusing it is the right answer
 * rather than a refusal held against it.
 */
function viaReceiver(code: string, at: number): boolean {
  if (code[at - 1] === ".") return true;
  return code.slice(at - 2, at) === "::";
}
const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * Routines and the calls inside them, read off the screen.
 *
 * Braces bound a routine in three of the four languages and indentation bounds
 * it in the fourth, which is the only place this has to know a language apart.
 * Nested closures are credited to the routine that encloses them -- the same
 * answer the reader gives, and the same answer a person would.
 */
function refereeRoutines(source: string, language: Language): RefereeRoutine[] {
  const opens = OPENS.get(language);
  if (!opens) return [];
  const lines = stripNoise(source, language).split("\n");
  const found: RefereeRoutine[] = [];
  let current: RefereeRoutine | undefined;
  let depth = 0;
  let opened = 0;
  let indent = 0;
  /** Whether a brace body has actually opened, for the arrow-function case. */
  let started = false;

  for (const [index, raw] of lines.entries()) {
    const start = opens.exec(raw);
    if (start) {
      current = { name: start[1] ?? start[2]!, line: index + 1, calls: [] };
      found.push(current);
      opened = depth;
      indent = indentOf(raw);
      started = false;
    } else if (current && language === "python" && raw.trim() !== "" && indentOf(raw) <= indent) {
      current = undefined;
    }
    if (!current) continue;
    // The declaration's own name sits in front of its parameter list and is not
    // a call. Everything after the opening bracket is.
    const code = start ? raw.slice(raw.indexOf("(", start.index) + 1) : raw;
    for (const hit of code.matchAll(CALL_TOKEN)) {
      const name = hit[1]!;
      if (NOT_CALLS.has(name)) continue;
      if (isMethodShorthand(code, hit.index)) continue;
      current.calls.push({
        name,
        line: index + 1,
        via: viaReceiver(code, hit.index) ? "receiver" : "bare",
      });
    }
    if (language !== "python") {
      depth += (raw.match(/\{/g) ?? []).length - (raw.match(/\}/g) ?? []).length;
      if (depth > opened) started = true;
      /*
       * An arrow function with an expression body never opens a brace, so brace
       * depth alone kept it open until the next routine and credited it with
       * everything in between. `const customComparer = () => true;` in a test
       * file was read as making the five calls written after it.
       *
       * A statement that ends before a body opens is one of those, and it ends
       * where its semicolon is.
       */
      if (started && depth <= opened) current = undefined;
      else if (!started && depth <= opened && /;\s*$/.test(raw)) current = undefined;
    }
  }
  return found;
}

/* ------------------------------------------------------------------ the run */

interface Ask {
  file: string;
  routine: string;
  target: string;
  name: string;
  line: number;
  crossFile: boolean;
}

const missed: Ask[] = [];
const accused: Ask[] = [];
const invented: Array<{ file: string; routine: string }> = [];
const held: Array<Ask & { why: string }> = [];
const asked = new Map<Language, number>();
const agreed = new Map<Language, number>();
const refusals = new Map<Language, Map<string, number>>();
const files = new Map<Language, number>();
/** The same four counts again, for the calls that cross a file. */
const crossAsked = new Map<Language, number>();
const crossAgreed = new Map<Language, number>();
let routines = 0;
let ambiguousNames = 0;
/** What the reader answered about calls written on a receiver, by verdict. */
const throughReceiver = new Map<string, number>();

const bump = <K,>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);

for (const tree of trees) {
  const workspace = createWorkspace(tree);
  const configs: ConfigCache = new Map();
  const sources = new Map<string, string>();
  const importsOf = new Map<string, CallSide["imports"]>();

  const read = (rel: string): string | undefined => {
    if (sources.has(rel)) return sources.get(rel);
    const absolute = workspace.resolve(rel);
    if (!absolute || workspace.stat(absolute) !== "file") return undefined;
    const text = workspace.read(absolute);
    sources.set(rel, text);
    return text;
  };
  const imports = (rel: string, source: string): CallSide["imports"] => {
    const cached = importsOf.get(rel);
    if (cached) return cached;
    const declared = readDependencies(rel, source, workspace, configs)?.dependencies ?? [];
    const list = declared.map((one) => ({ specifier: one.specifier, ...(one.file ? { file: one.file } : {}) }));
    importsOf.set(rel, list);
    return list;
  };

  /** One more file, so a name forwarded through a barrel can be followed. */
  const open = (rel: string) => {
    const source = read(rel);
    const language = languageOf(rel);
    if (source === undefined || !language) return undefined;
    return { source, language, imports: imports(rel, source) };
  };

  const paths = sourceFiles(tree).map((file) => path.relative(tree, file));

  /*
   * The referee's own index of what declares what, and the population filter.
   *
   * A name two files declare is a question with two answers, and asking the
   * reader about one of them would count a correct refusal as a miss. Excluded
   * and counted, rather than resolved by a rule this script would then be
   * measuring itself against.
   */
  const declaredIn = new Map<string, Set<string>>();
  const byFile = new Map<string, RefereeRoutine[]>();
  for (const rel of paths) {
    const source = read(rel);
    if (source === undefined) continue;
    const language = languageOf(rel)!;
    const seen = refereeRoutines(source, language);
    byFile.set(rel, seen);
    for (const routine of seen) {
      const at = declaredIn.get(routine.name) ?? new Set<string>();
      at.add(rel);
      declaredIn.set(routine.name, at);
    }
  }
  const declaredOnceIn = new Map<string, string>();
  for (const [name, where] of declaredIn) {
    if (where.size === 1) declaredOnceIn.set(name, [...where][0]!);
    else ambiguousNames += 1;
  }

  for (const [rel, seen] of byFile) {
    const language = languageOf(rel)!;
    const source = read(rel)!;
    const cleaned = stripNoise(source, language);
    bump(files, language);

    for (const routine of seen) {
      routines += 1;
      const wanted = new Map<string, { line: number; target: string; via: "bare" | "receiver" }>();
      for (const call of routine.calls) {
        const target = declaredOnceIn.get(call.name);
        // A routine calling itself is not a relationship anybody draws.
        if (!target || (target === rel && call.name === routine.name)) continue;
        if (target !== rel && bindsLocally(cleaned, call.name)) continue;
        const already = wanted.get(call.name);
        // A name written both ways in one routine is the readable one: the bare
        // call is evidence, and the receiver call is the referee's blind spot.
        if (!already) wanted.set(call.name, { line: call.line, target, via: call.via });
        else if (already.via === "receiver" && call.via === "bare") {
          wanted.set(call.name, { line: call.line, target, via: "bare" });
        }
      }

      for (const [name, { line, target, via }] of wanted) {
        const targetSource = read(target);
        const targetLanguage = languageOf(target);
        if (targetSource === undefined || !targetLanguage) continue;
        const ask: Ask = { file: rel, routine: routine.name, target, name, line, crossFile: target !== rel };

        const verdict = callsBetween(
          { file: rel, source, language, imports: imports(rel, source), open, routine: routine.name },
          { file: target, source: targetSource, language: targetLanguage,
            imports: imports(target, targetSource), open, names: [name] },
        );

        if (via === "receiver") {
          // A population the referee cannot place either. Counted apart, and the
          // reader's refusal here is the right answer rather than a cost.
          bump(throughReceiver, verdict.verdict === "withheld" ? verdict.why : verdict.verdict);
          continue;
        }

        bump(asked, language);
        if (ask.crossFile) bump(crossAsked, language);

        if (verdict.verdict === "confirmed") {
          bump(agreed, language);
          if (ask.crossFile) bump(crossAgreed, language);
        } else if (verdict.verdict === "withheld") {
          const byReason = refusals.get(language) ?? new Map<string, number>();
          byReason.set(verdict.why, (byReason.get(verdict.why) ?? 0) + 1);
          refusals.set(language, byReason);
          held.push({ ...ask, why: verdict.why });
        } else if (verdict.verdict === "backwards") {
          accused.push(ask);
        } else {
          missed.push(ask);
        }
      }

      /*
       * The other direction: a name the routine never calls must never come back
       * confirmed. Without this the recall number is agreement with itself.
       */
      if (wanted.size > 0) {
        const sentinel = "zzNotARealRoutineName";
        const verdict = callsBetween(
          { file: rel, source, language, imports: imports(rel, source), open, routine: routine.name },
          { file: rel, source, language, imports: imports(rel, source), open, names: [sentinel] },
        );
        if (verdict.verdict === "confirmed") invented.push({ file: rel, routine: routine.name });
      }
    }
  }
  resetEngineCache();
}

/* ------------------------------------------------------------------- report */

const LANGUAGES: Language[] = ["python", "ts", "tsx", "rust", "js"];
const percent = (part: number, whole: number) =>
  whole === 0 ? "   n/a" : `${((part / whole) * 100).toFixed(1)}%`.padStart(6);
const total = (map: Map<unknown, number>) => [...map.values()].reduce((a, b) => a + b, 0);

console.log();
console.log("MEASURE CALLS -- can the reader be trusted to say `backwards`?");
console.log(`  ${trees.length} trees, ${total(files)} files, ${routines} routines the referee could read`);
console.log(`  ${ambiguousNames} names declared in more than one file, left out of the population`);
console.log();
console.log("  " + "language".padEnd(9) + "files".padStart(7) + "asked".padStart(8)
  + "agreed".padStart(8) + "recall".padStart(8) + "refused".padStart(9)
  + "  cross-file".padEnd(14) + "  reasons");
for (const language of LANGUAGES) {
  const askedHere = asked.get(language) ?? 0;
  if (askedHere === 0 && (files.get(language) ?? 0) === 0) continue;
  const ok = agreed.get(language) ?? 0;
  const byReason = refusals.get(language) ?? new Map<string, number>();
  const refused = [...byReason.values()].reduce((a, b) => a + b, 0);
  const cross = crossAsked.get(language) ?? 0;
  console.log("  " + language.padEnd(9)
    + String(files.get(language) ?? 0).padStart(7)
    + String(askedHere).padStart(8)
    + String(ok).padStart(8)
    + percent(ok, askedHere).padStart(8)
    + percent(refused, askedHere).padStart(9)
    + `  ${String(crossAgreed.get(language) ?? 0)}/${cross} ${percent(crossAgreed.get(language) ?? 0, cross).trim()}`.padEnd(16)
    + ([...byReason.entries()].sort((a, b) => b[1] - a[1])
      .map(([why, count]) => `${why} ${count}`).join(", ") || "—"));
}
console.log();
console.log(`  THROUGH A RECEIVER -- ${total(throughReceiver)} more calls the referee read as`);
console.log("  `x.foo(..)` or `Type::foo(..)`. It cannot say whose `foo` that is, so they are");
console.log("  not in the population above. What the reader said about them anyway:");
console.log("    " + [...throughReceiver.entries()].sort((a, b) => b[1] - a[1])
  .map(([verdict, count]) => `${verdict} ${count}`).join(", "));

console.log();
console.log("  every language above carries a licence: "
  + LANGUAGES.filter((one) => mayAccuse("calls", one)).join(", "));

console.log();
const heldFiles = new Map<string, number>();
for (const one of held) heldFiles.set(one.file, (heldFiles.get(one.file) ?? 0) + 1);
console.log(`  REFUSED -- ${held.length} across ${heldFiles.size} files. Named, because a`);
console.log("  refusal rate is only arguable if you can see where it comes from.");
for (const one of held.slice(0, cap(12))) {
  console.log(`    ${one.why.padEnd(11)} ${one.file}:${one.line} ${one.routine} -> ${one.name} (${one.target})`);
}
if (held.length > cap(12)) console.log(`    ... and ${held.length - cap(12)} more`);

console.log();
console.log(`  MISSED -- referee saw the call, reader said absent: ${missed.length}`);
console.log("    Silence, not a red. Each one is a confirmation nobody gets, and half of a false `backwards`.");
for (const one of missed.slice(0, cap(missed.length))) {
  console.log(`    ${one.file}:${one.line} ${one.routine} -> ${one.name} (${one.target})`);
}
if (missed.length > cap(missed.length)) console.log(`    ... and ${missed.length - cap(missed.length)} more`);

console.log();
console.log(`  ACCUSED -- referee saw the call, reader said backwards: ${accused.length}`);
console.log("    The bar is zero. Each one is a correct arrow told to turn round.");
for (const one of accused.slice(0, cap(accused.length))) {
  console.log(`    ${one.file}:${one.line} ${one.routine} -> ${one.name} (${one.target})`);
}
if (accused.length > cap(accused.length)) console.log(`    ... and ${accused.length - cap(accused.length)} more`);

console.log();
console.log(`  INVENTED -- reader confirmed a name the routine never calls: ${invented.length}`);
for (const one of invented.slice(0, 10)) console.log(`    ${one.file} ${one.routine}`);
console.log();
