#!/usr/bin/env node
/**
 * How often the base-list reader is wrong, measured before it is allowed a red.
 *
 *   npm run measure:conforms                 -- this repo, rust-test, orangutan, mundane, infrarouter
 *   npm run measure:conforms -- <path>...    -- any trees you like
 *   npm run measure:conforms -- --all        -- print every disagreement, not the first 25
 *
 * The default corpus holds 22 Rust files, and the Rust row is the one this word
 * had to be sure about. So it is also run over the five clones the dependency
 * licence already pins, the way `measure:calls` widened its own Rust row:
 *
 *   npm run measure:conforms -- .claude/worktrees/96-rust/.corpus/BurntSushi-ripgrep \
 *     .claude/worktrees/96-rust/.corpus/dtolnay-anyhow \
 *     .claude/worktrees/96-rust/.corpus/clap-rs-clap \
 *     .claude/worktrees/96-rust/.corpus/rust-lang-regex \
 *     .claude/worktrees/96-rust/.corpus/serde-rs-json
 *
 * 775 files and 4,975 asks against the default corpus's 308, and it is what
 * found the derive half of the relation: the reader saw `impl Trait for Type`
 * and nothing else, and `#[derive(..)]` is two and a half times the population.
 *
 * `conforms` reads a declaration, so unlike `accesses` it has one end rather
 * than two -- and unlike every other word on the list, one of its languages is
 * on a different footing from the rest. Three blocks:
 *
 *   **A · the declaring end.** A base list is closed in Python and TypeScript,
 *   so a base absent from it refutes the arrow. A reader that cannot see a base
 *   written in plain sight will call a correct diagram wrong, and that is not
 *   recoverable by being right afterwards. The column is ACCUSED and the bar is
 *   **zero**.
 *
 *   **B · the direction that does damage.** #216 asks for this one by name. Take
 *   a pair the referee read one way and ask the reader the *other* way: the
 *   reader must never confirm it. A word that comes back green whichever way the
 *   arrow was drawn is decoration in a verdict's clothes, and the whole reason
 *   to have this word is the arrow somebody drew from the base down to the
 *   subclass. The column is BOTH-WAYS and the bar is **zero**.
 *
 *   **C · the whole call.** `conformedTypes` with a far end, which is the
 *   composition `drift.ts` runs -- the category error, the reverse detection and
 *   the licence gate included. Reported as a verdict breakdown, because what
 *   matters here is which answers real code produces rather than a recall.
 *
 * Rust is measured and reported and is **not** asking to be licensed. `impl
 * Trait for Type` may sit in any file in the crate, so its refusals are the
 * design working rather than a reader failing, and the row exists to put a
 * number on what confirm-only costs.
 *
 * ## The referee
 *
 * A text scan of the same source, sharing **no tree-sitter query** with the
 * reader -- so agreeing means two unrelated readings agree rather than one
 * reading agreeing with itself, which is the mistake that got two orders of
 * magnitude into #190.
 *
 * It reads declaration *headers* only, and that makes it far simpler than the
 * one in `measure-accesses.mts`: no class body to scope, no indentation to
 * track, no docstring to blank out of a member list. A header either says what
 * it extends on one line or the referee does not offer it -- a smaller sample,
 * never a wrong one.
 *
 * ## Why the accusing half is asked through `declaredBases`
 *
 * The licence gate sits in `conformedTypes`: with no measurement there is no
 * licence, so every refutation would come back `unlicensed` and ACCUSED would
 * read zero because nothing was permitted to accuse. A number that cannot be
 * non-zero is not a measurement, and this is the run that has to produce the
 * licence in the first place. `declaredBases` is one of the reader's halves
 * rather than a door cut for the harness -- and block C drives the whole public
 * call, so the composition is measured too.
 *
 * A run is a measurement, not a test: it prints and never fails. The bugs it
 * finds become tests.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { conformedTypes, declaredBases } from "../src/engine/conforms";
import { mayAccuse } from "../src/engine/licence";
import { initEngine, languageOf, type Language } from "../src/engine/parse";

await initEngine();

const HOME = process.env.HOME ?? "/Users/noelmatero";
const flags = process.argv.slice(2).filter((argument) => argument.startsWith("--"));
const roots = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
/**
 * Every disagreement rather than the first 25.
 *
 * Here because #224 is the same script one word over shipping a cap with no way
 * past it: a list that says "and 300 more" is a list nobody can work through,
 * and the whole point of these runs is that the bugs they find become tests.
 */
const showAll = flags.includes("--all");

/*
 * Four languages, never one. Inheritance is spelled five ways across them and a
 * detector that misses a language's spelling produces a confident wrong answer
 * about whether the word generalises -- which is what #216 had to resolve before
 * it could be sized at all.
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
 * The referee.
 * ------------------------------------------------------------------ */

/** One thing the text plainly says a type is one of. */
interface Heritage {
  /** The type doing the conforming. */
  subject: string;
  /** What it says it is one of, as a diagram would name it. */
  base: string;
  line: number;
}

/**
 * The source with every comment and docstring blanked, line count intact.
 *
 * A class header quoted in a comment is not a declaration, and this repository's
 * own headers quote several. Carried from `measure-accesses.mts`, where reading
 * prose as source was the largest single source of noise in the first run.
 */
function blanked(source: string, language: Language): string {
  const hollow = (block: string) => block.replace(/[^\n]/g, " ");
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, hollow)
    .split("\n")
    .map((line) => line.replace(language === "python" ? /(^|\s)#.*$/ : /(^|\s)\/\/.*$/, "$1"))
    .join("\n");
  if (language === "python") {
    return withoutComments.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, hollow);
  }
  // A template literal in this repository holds whole scripts, `class` keywords
  // included. What a browser eventually runs is not a declaration in this file.
  return withoutComments.replace(/`(?:[^`\\]|\\.)*`/g, hollow);
}

/**
 * A base as a diagram would name it: no generics, no namespace, no subscript.
 *
 * `abc.ABCMeta` is one name with a namespace on the front and nobody labels a
 * box with the namespace. `Generic[T]`, `Cache<Entry>` and `Base(object)` are
 * the outer name, which is the thing being extended.
 */
function plainName(written: string): string | undefined {
  const trimmed = written.trim();
  if (!trimmed) return undefined;
  // An expression rather than a name -- `mixin(Cache)`, `make_base()`, `*bases`.
  // The reader refuses these, so offering them would measure disagreement about
  // something both sides decline to read.
  if (/[(*]/.test(trimmed)) return undefined;
  const head = trimmed.split(/[<[]/)[0]!.trim();
  const tail = head.split(/::|\./).pop()?.trim();
  return tail && /^[A-Za-z_]\w*$/.test(tail) ? tail : undefined;
}

/** Type-argument and subscript groups removed, innermost first. */
function withoutArguments(written: string): string {
  let text = written;
  for (let round = 0; round < 8; round += 1) {
    const next = text.replace(/<[^<>]*>|\[[^[\]]*\]/g, " ");
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * A heritage list, split at the commas and plus signs that separate bases.
 *
 * The arguments come off **before** the split, and that is the third bug this
 * one run turned up in its own referee. `class MoodMiddleware(AgentMiddleware[
 * AgentState, ContextT, ResponseT])` splits into four things at the commas, and
 * three of them are type arguments of the first -- so the referee offered
 * `MoodMiddleware -> ContextT` as a base and accused the reader of missing it.
 * The reader was right: a type argument is not something a class is one of, and
 * `conforms.ts` had just been changed to stop reading through them.
 */
function basesOf(written: string): string[] {
  return withoutArguments(written)
    .split(/[,+]/)
    // `metaclass=ABCMeta` is not a base. Reading its value as one would confirm
    // an arrow drawn at the metaclass, which is a green nothing could refute.
    .filter((entry) => !entry.includes("="))
    .map(plainName)
    .filter((name): name is string => name !== undefined);
}

/** Type-argument lists removed, so a constraint's `extends` is not a heritage. */
function withoutGenerics(header: string): string {
  let text = header;
  for (let round = 0; round < 6; round += 1) {
    const next = text.replace(/<[^<>]*>/g, " ");
    if (next === text) break;
    text = next;
  }
  return text;
}

const PYTHON_CLASS = /^[ \t]*class[ \t]+(\w+)[ \t]*\(([^)]*)\)[ \t]*:/;
const TS_DECLARATION = /\b(?:class|interface)\s+([A-Za-z_$][\w$]*)/;
const RUST_IMPL = /^\s*impl(?:\s*<[^>]*>)?\s+([\w:]+(?:\s*<[^>]*>)?)\s+for\s+([A-Za-z_]\w*)/;
const RUST_TRAIT = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)(?:\s*<[^>]*>)?\s*:\s*([^{]+)/;
/** `#[derive(..)]`, which is where most Rust conformance is actually written. */
const RUST_DERIVE = /^\s*#\[derive\(/;
/** The declaration a derive list is attached to. */
const RUST_TYPE = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|union)\s+([A-Za-z_]\w*)/;

function refereeHeritage(source: string, language: Language): Heritage[] {
  const lines = blanked(source, language).split("\n");
  const found: Heritage[] = [];
  const add = (subject: string, written: string, line: number) => {
    for (const base of basesOf(written)) {
      if (base !== subject) found.push({ subject, base, line });
    }
  };

  for (const [index, line] of lines.entries()) {
    if (language === "python") {
      const hit = PYTHON_CLASS.exec(line);
      if (hit) add(hit[1]!, hit[2]!, index + 1);
      continue;
    }
    if (language === "rust") {
      const impl = RUST_IMPL.exec(line);
      if (impl) add(impl[2]!, impl[1]!, index + 1);
      const trait = RUST_TRAIT.exec(line);
      // A lifetime and a `?Sized` are bounds rather than supertraits, and
      // `plainName` drops them: neither is a type anybody draws a box for.
      if (trait) add(trait[1]!, trait[2]!.replace(/'\w+/g, ""), index + 1);
      /*
       * A derive list, and the declaration it is attached to.
       *
       * Two and a half times the written-impl population -- 3,741 against 1,401
       * over the five pinned clones -- and the reader could see none of it until
       * this block existed to ask about it. That is what widening the Rust
       * corpus was for: the default corpus holds 21 of these facts, and a
       * measurement over 21 asks cannot tell you which half of a relation you
       * are missing.
       */
      if (RUST_DERIVE.test(line)) {
        let attribute = line;
        for (let ahead = 1; ahead < 12; ahead += 1) {
          const opens = (attribute.match(/\(/g) ?? []).length;
          const closes = (attribute.match(/\)/g) ?? []).length;
          if (opens <= closes) break;
          attribute += ` ${lines[index + ahead] ?? ""}`;
        }
        const traits = attribute.slice(attribute.indexOf("(") + 1, attribute.lastIndexOf(")"));
        // The declaration underneath, past any other attributes on the way.
        for (let ahead = 1; ahead < 12; ahead += 1) {
          const next = lines[index + ahead];
          if (next === undefined) break;
          const declaration = RUST_TYPE.exec(next);
          if (declaration) { add(declaration[1]!, traits, index + 1); break; }
          // A blank line or anything that is not another attribute ends the run.
          if (next.trim() !== "" && !next.trimStart().startsWith("#[")) break;
        }
      }
      continue;
    }

    const declaration = TS_DECLARATION.exec(line);
    if (!declaration) continue;
    /*
     * A header can wrap. `export class Store\n  extends Cache\n  implements
     * Reader {` is three lines and one declaration, so the header is read up to
     * the brace or the semicolon that ends it -- with a bound, because a line
     * that opens no body is a header the referee should give up on rather than
     * follow to the end of the file.
     */
    let header = line;
    /*
     * Angle brackets as well as braces, and that is the second half of the
     * type-argument bug in `conforms.ts`. `class ListboxStore extends
     * ReactStore<\n  ListboxState,\n  ListboxContext,\n  typeof selectors\n> {`
     * is five lines: stopping at three left the referee holding an unbalanced
     * `<`, so `withoutGenerics` could not strip it and the commas inside the
     * type arguments read as three separate bases. It then blamed the reader for
     * not finding two of them.
     *
     * Both halves were one run's output and neither was visible without the
     * other, which is the sixth entry in `docs/claim-vocabulary.md` happening
     * again: a referee is a program somebody wrote and it can be read wrongly.
     */
    const balanced = (text: string) =>
      /[{;]/.test(text) && (text.match(/</g) ?? []).length <= (text.match(/>/g) ?? []).length;
    for (let ahead = 1; ahead < 10 && !balanced(header); ahead += 1) {
      header += ` ${lines[index + ahead] ?? ""}`;
    }
    const clean = withoutGenerics(header.split(/[{;]/)[0]!);
    /*
     * `[^]]*?` was the first spelling of "anything up to the implements", and in
     * JavaScript `[^]` means *any character* -- so `[^]]` is any character
     * followed by a literal `]`, and the pattern could never match a heritage
     * clause at all. TypeScript read 13 pairs against the census's 296 and tsx
     * read 0 against 313, which is the whole reason this run reports its sample
     * size next to a number the census can be compared to.
     */
    const extend = /\bextends\s+(.*?)(?:\bimplements\b|$)/.exec(clean);
    if (extend) add(declaration[1]!, extend[1]!, index + 1);
    const implement = /\bimplements\s+(.*)$/.exec(clean);
    if (implement) add(declaration[1]!, implement[1]!, index + 1);
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * The run.
 * ------------------------------------------------------------------ */

const accused: Array<{ file: string; subject: string; base: string; line: number; bases: string }> = [];
const bothWays: Array<{ file: string; subject: string; base: string; line: number }> = [];
const invented: Array<{ file: string; subject: string }> = [];
/**
 * Every refusal, kept rather than only counted.
 *
 * A reason column with a number in it says a shape exists; it does not say
 * which shape, and the licence rows are written by somebody deciding whether a
 * refusal is the design working or a reader that cannot read something. Printed
 * under `--all`, because on this corpus it is 2,700 lines.
 */
const refusedList: Array<{ file: string; subject: string; base: string; line: number; why: string }> = [];

const asked = new Map<Language, number>();
const agreed = new Map<Language, number>();
const refused = new Map<Language, Map<string, number>>();
const reverseAsked = new Map<Language, number>();
const reverseCaught = new Map<Language, number>();
const wholeAsked = new Map<Language, number>();
const wholeVerdicts = new Map<Language, Map<string, number>>();
const reversedFlag = new Map<Language, number>();

const files = new Map<Language, number>();
let declarations = 0;

const bump = <K,>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);
const bump2 = (map: Map<Language, Map<string, number>>, language: Language, key: string) => {
  const inner = map.get(language) ?? new Map<string, number>();
  inner.set(key, (inner.get(key) ?? 0) + 1);
  map.set(language, inner);
};

const SENTINEL = "ZzNotARealBaseName";

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

    const heritage = refereeHeritage(source, language);
    const subjects = new Set(heritage.map((one) => one.subject));
    declarations += subjects.size;

    /*
     * A · the declaring end. Every one of these that comes back refuted is a red
     * on a diagram whose author read the declaration and was right.
     */
    for (const one of heritage) {
      bump(asked, language);
      const note = (why: string) => {
        bump2(refused, language, why);
        refusedList.push({ file, subject: one.subject, base: one.base, line: one.line, why });
      };
      const read = declaredBases(source, one.subject, language);
      if ("why" in read) { note(read.why); continue; }
      if (read.bases.some((candidate) => candidate.name === one.base)) {
        bump(agreed, language);
        continue;
      }
      if (read.doubt) { note(read.doubt); continue; }
      if (!read.closed) { note("region-is-the-crate"); continue; }
      accused.push({
        file, subject: one.subject, base: one.base, line: one.line, bases: read.written,
      });
    }

    /*
     * B · the direction that does damage. The same pair asked backwards, and
     * only where the reader can read the far end at all -- a base declared in
     * another file comes back `not-declared`, which is a refusal rather than an
     * answer and would flatter this column.
     */
    for (const one of heritage) {
      const back = declaredBases(source, one.base, language);
      if ("why" in back) continue;
      bump(reverseAsked, language);
      if (back.bases.some((candidate) => candidate.name === one.subject)) {
        bothWays.push({ file, subject: one.subject, base: one.base, line: one.line });
        continue;
      }
      // Refused or absent: either way it did not confirm the reversal, which is
      // the only thing this block is about.
      bump(reverseCaught, language);
    }

    /*
     * The other direction of A: a base no declaration writes down must never
     * come back named, or the recall above is the reader agreeing with itself.
     */
    for (const subject of subjects) {
      const read = declaredBases(source, subject, language);
      if ("why" in read) continue;
      if (read.bases.some((candidate) => candidate.name === SENTINEL)) {
        invented.push({ file, subject });
      }
    }

    /*
     * C · the whole public call, on pairs the referee produced both ends of.
     * This is the composition `drift.ts` runs, licence gate included.
     */
    for (const one of heritage) {
      const far = declaredBases(source, one.base, language);
      if ("why" in far) continue;
      bump(wholeAsked, language);
      const verdict = conformedTypes(source, one.subject, [one.base], language, { source, language });
      bump2(wholeVerdicts, language,
        verdict.verdict === "withheld" ? `withheld/${verdict.why}` : verdict.verdict);
      // The same pair backwards, through the whole call: how often the report
      // can say "you drew it the wrong way round" rather than only "wrong".
      const backwards = conformedTypes(source, one.base, [one.subject], language, { source, language });
      if (backwards.verdict === "absent" && backwards.reversed) bump(reversedFlag, language);
    }
  }
}

const LANGUAGES: Language[] = ["rust", "ts", "tsx", "python", "js"];
const percent = (part: number, whole: number) =>
  whole === 0 ? "   n/a" : `${((part / whole) * 100).toFixed(1)}%`.padStart(6);
const total = (map: Map<Language, number>) => [...map.values()].reduce((a, b) => a + b, 0);
const cap = <T,>(list: T[]) => (showAll ? list : list.slice(0, 25));

console.log();
console.log("MEASURE CONFORMS -- can the base-list reader be trusted with a red?");
console.log(`  ${trees.length} trees, ${total(files)} files, ${declarations} declarations`
  + " naming something they are one of");
console.log();
console.log("  Python and TypeScript write their bases on the declaration, which is a closed");
console.log("  region. Rust writes `impl Trait for Type` anywhere in the crate, which is not,");
console.log("  and its refusals below are the design working rather than a reader failing.");

console.log();
console.log("A · THE DECLARING END -- does the declaration name the base?");
console.log("  " + "language".padEnd(10) + "files".padStart(7) + "asked".padStart(8)
  + "agreed".padStart(8) + "recall".padStart(8) + "refused".padStart(9)
  + "accuses".padStart(9) + "  reasons");
for (const language of LANGUAGES) {
  const count = asked.get(language) ?? 0;
  if (count === 0 && (files.get(language) ?? 0) === 0) continue;
  const ok = agreed.get(language) ?? 0;
  const byReason = refused.get(language) ?? new Map<string, number>();
  const declined = [...byReason.values()].reduce((a, b) => a + b, 0);
  console.log("  " + language.padEnd(10)
    + String(files.get(language) ?? 0).padStart(7)
    + String(count).padStart(8)
    + String(ok).padStart(8)
    + percent(ok, count).padStart(8)
    + percent(declined, count).padStart(9)
    + (mayAccuse("conforms", language) ? "yes" : "no").padStart(9)
    + "  " + ([...byReason.entries()].sort((a, b) => b[1] - a[1])
      .map(([why, count_]) => `${why} ${count_}`).join(", ") || "—"));
}

console.log();
console.log("B · THE DIRECTION THAT DOES DAMAGE -- the same pair asked backwards.");
console.log("  Never confirmed. A green that does not depend on which way the arrow was");
console.log("  drawn is decoration, and this arrow drawn backwards is the whole point.");
console.log("  " + "language".padEnd(10) + "asked".padStart(8) + "refused".padStart(10)
  + "both ways".padStart(11));
for (const language of LANGUAGES) {
  const count = reverseAsked.get(language) ?? 0;
  if (count === 0) continue;
  const caught = reverseCaught.get(language) ?? 0;
  console.log("  " + language.padEnd(10) + String(count).padStart(8)
    + String(caught).padStart(10) + String(count - caught).padStart(11));
}

console.log();
console.log("C · THE WHOLE CALL -- the composition `drift.ts` runs, on real pairs.");
for (const language of LANGUAGES) {
  const count = wholeAsked.get(language) ?? 0;
  if (count === 0) continue;
  const byVerdict = wholeVerdicts.get(language) ?? new Map<string, number>();
  console.log("  " + language.padEnd(10) + String(count).padStart(8) + "  "
    + [...byVerdict.entries()].sort((a, b) => b[1] - a[1])
      .map(([what, count_]) => `${what} ${count_}`).join(", "));
  console.log("  " + " ".repeat(10) + " ".repeat(8) + "  "
    + `${reversedFlag.get(language) ?? 0} of them, drawn backwards, report which way round`);
}

console.log();
console.log(`  ACCUSED -- referee read the base off the header, reader refutes it: ${accused.length}`);
console.log("    The bar is zero. Each one is an arrow that would be called wrong when it is right.");
for (const one of cap(accused)) {
  console.log(`    ${path.relative(HOME, one.file)}:${one.line} ${one.subject} is not a `
    + `${one.base} · read: ${one.bases || "nothing"}`);
}
if (!showAll && accused.length > 25) {
  console.log(`    ... and ${accused.length - 25} more (--all prints every one)`);
}

console.log();
console.log(`  BOTH WAYS -- reader confirmed the pair in both directions: ${bothWays.length}`);
console.log("    The bar is zero, and it is a different bar: nothing here is a false red.");
console.log("    A word that agrees whichever way you point it is not saying anything.");
for (const one of cap(bothWays)) {
  console.log(`    ${path.relative(HOME, one.file)}:${one.line} ${one.subject} <-> ${one.base}`);
}
if (!showAll && bothWays.length > 25) {
  console.log(`    ... and ${bothWays.length - 25} more (--all prints every one)`);
}

if (showAll) {
  console.log();
  console.log(`  REFUSED -- reader declined to answer: ${refusedList.length}`);
  console.log("    Not a red and not a miss. Each one is a confirmation nobody gets, and the");
  console.log("    reason is what says whether that is the design or a reader that cannot read.");
  for (const one of refusedList) {
    console.log(`    ${path.relative(HOME, one.file)}:${one.line} ${one.subject} -> ${one.base} `
      + `· ${one.why}`);
  }
}

console.log();
console.log(`  INVENTED -- reader named a base that is not written anywhere: ${invented.length}`);
for (const one of cap(invented)) {
  console.log(`    ${path.relative(HOME, one.file)} ${one.subject}`);
}
console.log();
