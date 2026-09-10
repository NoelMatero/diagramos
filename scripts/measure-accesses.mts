#!/usr/bin/env node
/**
 * How often the member reader is wrong, measured before it is allowed a red.
 *
 *   npm run measure:accesses                 -- this repo, rust-test, orangutan, mundane, infrarouter
 *   npm run measure:accesses -- <path>...    -- any trees you like
 *   npm run measure:accesses -- --all        -- every disagreement, not the first few
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
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import path from "node:path";

import { accessesIn, declaresMember, memberAccesses } from "../src/engine/accesses";
import { mayAccuse } from "../src/engine/licence";
import { initEngine, languageOf, type Language } from "../src/engine/parse";
import {
  BUILT_IN, distinctReads, refereeRoutines, refereeTypes,
} from "./lib/access-scan";

await initEngine();

const HOME = process.env.HOME ?? "/Users/noelmatero";
const flags = new Set(process.argv.slice(2).filter((argument) => argument.startsWith("--")));
const roots = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
/**
 * `--all` prints every accusation, every miss and every invention rather than
 * the first handful.
 *
 * The default caps were how #222 stayed invisible for a release: the visible 15
 * misses read as a plausible tail of hard cases, and reading all of them --
 * which needed editing this file -- showed that eight sites were a fifth of the
 * list and whole clusters were not member reads at all. A refusal rate nobody
 * can audit is a number, not a measurement.
 */
const showAll = flags.has("--all");
const cap = (count: number, few: number) => (showAll ? count : Math.min(count, few));

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

/** Directories whose contents are somebody else's source, or not source at all. */
const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", "target", "dist", "build", "out", "vendor", ".venv", ".claude",
  "coverage", ".next", ".nuxt", ".output", ".turbo", ".yarn", ".cache",
]);

/**
 * Every source file under a tree, walked rather than shelled out to.
 *
 * `execFileSync("find", [root, "-type", "f"])` was here, and on two of the
 * seven trees it threw `ENOBUFS` -- `find` printed more than the default
 * stdout buffer holds, which `mundane` does at 126,863 files once its
 * dependencies are installed. A blanket `catch` turned that into "no files
 * here" and the report went on saying **7 trees** with a straight face.
 *
 * The corpus this word was licensed on was 5,833 asks. The same command today
 * asks 1,232, and none of that is a change to the reader: two of the seven
 * trees stopped being read and nothing said so. `measure-resolution.mts`
 * carries this fix already and says the same thing about it; the difference
 * here is that the number it quietly changed is on a licence.
 *
 * Skipping the heavy directories *during* the walk means the listing never
 * gets big enough to be a problem in the first place.
 */
function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      unreadable.push(directory);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && languageOf(entry.name) !== undefined) files.push(full);
    }
  };
  walk(root);
  return files;
}

/** Directories the walk could not open. Reported, never swallowed. */
const unreadable: string[] = [];


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
/**
 * The routine credited with the most member reads, which is where a broken
 * boundary shows itself first.
 *
 * 24 reads on one Python `def` was #222, and nothing in this report said so:
 * the misses were spread across the miss list fifteen at a time and the total
 * was the only number anybody saw. A routine that never closes collects
 * everything below it, so the top of this ranking is the shape of the bug.
 */
let widest = { reads: 0, file: "", routine: "", line: 0 };

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
      const wanted = distinctReads(routine);
      if (wanted.length > widest.reads) {
        widest = { reads: wanted.length, file, routine: routine.name, line: routine.line };
      }
      for (const { name, line } of wanted) {
        bump(readAsked, language);
        if (accessesIn(source, routine.name, name, language)) { bump(readAgreed, language); continue; }
        missed.push({ file, routine: routine.name, member: name, line });
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
      for (const { name } of distinctReads(routine)) {
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
for (const tree of trees) console.log(`    ${path.relative(HOME, tree)}`);
if (unreadable.length > 0) {
  console.log(`  ${unreadable.length} directories could not be opened, and are not in the`
    + " counts above:");
  for (const directory of unreadable.slice(0, cap(unreadable.length, 5))) {
    console.log(`    ${path.relative(HOME, directory)}`);
  }
  if (unreadable.length > cap(unreadable.length, 5)) {
    console.log(`    ... and ${unreadable.length - cap(unreadable.length, 5)} more (--all prints every one)`);
  }
}
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
for (const one of accused.slice(0, cap(accused.length, 25))) {
  console.log(`    ${path.relative(HOME, one.file)}:${one.line} ${one.type} has no ${one.member}`);
}
if (accused.length > cap(accused.length, 25)) {
  console.log(`    ... and ${accused.length - cap(accused.length, 25)} more (--all prints every one)`);
}

console.log();
console.log(`  WIDEST SITE -- most member reads credited to one routine: ${widest.reads}`);
console.log("    A routine whose end the referee cannot find collects every read below it,");
console.log("    so this is where a broken boundary shows first. Read it against the");
console.log("    routine's real end in the source before treating it as a finding: the");
console.log("    widest site in this corpus is a genuinely enormous function. When the");
console.log("    boundary was wrong (#222) the misses it caused were spread through the");
console.log("    list below and nothing here named the cause.");
if (widest.reads > 0) {
  console.log(`    ${path.relative(HOME, widest.file)}:${widest.line} ${widest.routine}`);
}

console.log();
console.log(`  MISSED -- referee read the access, reader did not: ${missed.length}`);
console.log("    Not a red. Each one is a confirmation nobody gets, which is what a word");
console.log("    that ships and never fires is made of.");
for (const one of missed.slice(0, cap(missed.length, 15))) {
  console.log(`    ${path.relative(HOME, one.file)}:${one.line} ${one.routine} reads ${one.member}`);
}
if (missed.length > cap(missed.length, 15)) {
  console.log(`    ... and ${missed.length - cap(missed.length, 15)} more (--all prints every one)`);
}

console.log();
console.log(`  INVENTED -- reader affirmed a name that is not there: ${invented.length}`);
for (const one of invented.slice(0, cap(invented.length, 10))) {
  console.log(`    ${one.end.padEnd(8)} ${path.relative(HOME, one.file)} ${one.where}`);
}
if (invented.length > cap(invented.length, 10)) {
  console.log(`    ... and ${invented.length - cap(invented.length, 10)} more (--all prints every one)`);
}
console.log();
