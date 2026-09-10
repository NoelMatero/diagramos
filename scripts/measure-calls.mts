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
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  bindsLocally, refereeRoutines, stripNoise, type RefereeRoutine,
} from "./lib/call-scan";
import {
  callSitesOn, checkerFor, landingOf, scoreReceiverCall,
  type CallChecker, type Declared, type Landing, type ReceiverScore,
} from "./lib/call-receivers";
import { sourceFiles } from "./lib/source-files";

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
/**
 * `--no-checker` runs exactly the measurement the licence was earned on and
 * starts no checker. `--control` also asks the checker about every bare call,
 * whose answer the text scan already has -- which is how the checker is shown
 * to agree with the referee it joins, before it is trusted on the calls that
 * referee could not read (#254).
 */
const useChecker = !flags.has("--no-checker");
const control = useChecker && flags.has("--control");
/**
 * `--dump=<file>` writes every call put to the checker, agreements included, as
 * JSON. Reading only the flagged cases is how a check that measures the wrong
 * thing survives; this is what the agreements are read from.
 */
const dumpTo = [...flags].find((flag) => flag.startsWith("--dump="))?.slice("--dump=".length);
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

/* -------------------------------------------------------------- the referee */
/*
 * The referee lives in `scripts/lib/call-scan.ts`, because #217's measurement
 * needs the same one and a referee copied is a referee that drifts. It is
 * unchanged: same regexes, same brace and indentation bounding, same blanking
 * of strings and comments.
 */
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

/*
 * #254: the same receiver calls, asked of a real checker. Every one ends in a
 * score or in a named reason it could not be scored -- never dropped without a
 * word, which is how 1,995 of them came to sit outside the licence.
 */
type Verdict = ReturnType<typeof callsBetween>;
interface Pending extends Ask {
  tree: string;
  language: Language;
  lines: number[];
  via: "bare" | "receiver";
  verdict: Verdict;
}
interface Scored extends Pending { score: ReceiverScore; at?: Declared }
const receiverScores = new Map<Language, Map<ReceiverScore, number>>();
const receiverRefusals = new Map<Language, Map<string, number>>();
const receiverSilent = new Map<Language, Map<string, number>>();
const receiverCases: Scored[] = [];
const controlCounts = new Map<Language, Map<Landing["kind"], number>>();
/**
 * The negative control (#250's own guard, applied here): every scored call's
 * answers judged against **another** call's target instead of its own. A check
 * that says `lands` either way is measuring nothing, and a corpus-scale
 * agreement rate is no evidence until this number is near zero.
 */
const negativeControl = new Map<Language, Map<Landing["kind"], number>>();
const controlElsewhere: Array<Pending & { at: Declared }> = [];
/**
 * `elsewhere` answers that name the target file at some **other** line, per
 * language. `landingOf` calls a landing only when the line the checker points
 * at declares the name, so this is the class where that strictness could turn
 * a real call into a false `invented`. Counted rather than assumed empty.
 */
const elsewhereInTarget = new Map<Language, number>();
const unavailable = new Map<string, string>();
const checkerLabels = new Set<string>();
const dumped: unknown[] = [];

const bump = <K,>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);
const bumpIn = <K,>(outer: Map<Language, Map<K, number>>, language: Language, key: K) => {
  const inner = outer.get(language) ?? new Map<K, number>();
  outer.set(language, inner);
  bump(inner, key);
};

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
  /** Calls to put to a checker once every routine in this tree has been read. */
  const pending: Pending[] = [];

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
      const wanted = new Map<string, { line: number; target: string; via: "bare" | "receiver"; lines: number[] }>();
      for (const call of routine.calls) {
        const target = declaredOnceIn.get(call.name);
        // A routine calling itself is not a relationship anybody draws.
        if (!target || (target === rel && call.name === routine.name)) continue;
        if (target !== rel && bindsLocally(cleaned, call.name)) continue;
        const already = wanted.get(call.name);
        // A name written both ways in one routine is the readable one: the bare
        // call is evidence, and the receiver call is the referee's blind spot.
        if (!already) wanted.set(call.name, { line: call.line, target, via: call.via, lines: [call.line] });
        else if (already.via === "receiver" && call.via === "bare") {
          wanted.set(call.name, { line: call.line, target, via: "bare", lines: [call.line] });
        } else if (already.via === call.via && !already.lines.includes(call.line)) {
          // Every line it is written on, so a checker is asked at each (#254).
          already.lines.push(call.line);
        }
      }

      for (const [name, { line, target, via, lines }] of wanted) {
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
          if (useChecker) pending.push({ ...ask, tree: path.basename(tree), language, lines, via, verdict });
          continue;
        }
        if (control) pending.push({ ...ask, tree: path.basename(tree), language, lines, via, verdict });

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

  /*
   * #254. Asked once the whole tree is read: one checker per language family,
   * started only when this tree has a call for it, closed before the next tree.
   * Held as a promise so a batch asking at once still starts one server.
   */
  const checkers = new Map<string, Promise<CallChecker | { unavailable: string }>>();
  const checkerOf = (language: Language) => {
    const family = language === "tsx" || language === "js" ? "ts" : language;
    if (!checkers.has(family)) {
      checkers.set(family, checkerFor(tree, language).then((made) => {
        if ("unavailable" in made) unavailable.set(`${path.basename(tree)} ${family}`, made.unavailable);
        else checkerLabels.add(made.label);
        return made;
      }));
    }
    return checkers.get(family)!;
  };
  const BATCH = 16;
  for (let start = 0; start < pending.length; start += BATCH) {
    await Promise.all(pending.slice(start, start + BATCH).map(async (one, offset) => {
      const checker = await checkerOf(one.language);
      /** How `landingOf` reads these answers against any one target file. */
      const against = (answers: Array<Declared | undefined>, target: string, name: string) => {
        const absolute = path.join(tree, target);
        const lines = read(target)?.split("\n") ?? [];
        return landingOf(answers, absolute, name, (file, at) => (file === absolute ? lines[at] : undefined));
      };
      let landing: Landing;
      if ("unavailable" in checker) {
        landing = { kind: "silent", why: "no-checker" };
      } else {
        const source = read(one.file)!;
        const sites = one.lines.flatMap((at) => callSitesOn(source, at, one.name, one.via, one.language));
        const answers = await Promise.all(sites.map((site) =>
          checker.definitionAt(path.join(tree, one.file), source, site)));
        landing = against(answers, one.target, one.name);
        /*
         * The same answers, judged against a **different** call's target -- the
         * next one along the pending list, whose file and name are unrelated.
         * Costs no query, because the checker has already spoken.
         */
        const other = pending[(start + offset + 1) % pending.length];
        if (answers.length > 0 && other && other.target !== one.target) {
          bumpIn(negativeControl, one.language, against(answers, other.target, other.name).kind);
        }
      }
      if (dumpTo) {
        dumped.push({
          tree: one.tree, file: one.file, lines: one.lines, routine: one.routine, name: one.name,
          target: one.target, via: one.via, language: one.language, verdict: one.verdict.verdict,
          ...(one.verdict.verdict === "withheld" ? { why: one.verdict.why } : {}), landing,
        });
      }
      if (one.via === "bare") {
        bumpIn(controlCounts, one.language, landing.kind);
        if (landing.kind === "elsewhere") controlElsewhere.push({ ...one, at: landing.at });
        return;
      }
      if (landing.kind === "silent") {
        bumpIn(receiverSilent, one.language, landing.why);
        return;
      }
      if (landing.kind === "elsewhere" && landing.at.file === path.join(tree, one.target)) {
        bump(elsewhereInTarget, one.language);
      }
      const score = scoreReceiverCall(landing, one.verdict.verdict);
      bumpIn(receiverScores, one.language, score);
      if (one.verdict.verdict === "withheld" && score === "refused") {
        bumpIn(receiverRefusals, one.language, one.verdict.why);
      }
      if (score !== "agreed" && score !== "refused" && score !== "rightly-unconfirmed") {
        receiverCases.push({ ...one, score, ...(landing.kind === "elsewhere" ? { at: landing.at } : {}) });
      }
    }));
  }
  for (const made of checkers.values()) {
    const checker = await made;
    if (!("unavailable" in checker)) checker.close();
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

const listed = (map?: Map<string, number>) => (map && map.size > 0
  ? [...map.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key} ${count}`).join(", ")
  : "—");
const shortPath = (file: string) => file.replace(HOME, "~").replace(/^.*\/node_modules\//, "node_modules/");

if (useChecker) {
  const scoreOf = (language: Language, key: ReceiverScore) => receiverScores.get(language)?.get(key) ?? 0;
  const realOf = (language: Language) =>
    scoreOf(language, "agreed") + scoreOf(language, "refused") + scoreOf(language, "missed") + scoreOf(language, "accused");
  const elsewhereOf = (language: Language) =>
    scoreOf(language, "invented") + scoreOf(language, "rightly-unconfirmed") + scoreOf(language, "backwards-elsewhere");

  console.log();
  console.log(`  THROUGH A RECEIVER, ASKED OF A CHECKER (#254) -- ${[...checkerLabels].sort().join(", ") || "no checker started"}`);
  console.log("  The same calls, each asked \"go to definition\" at its name. REAL: the checker");
  console.log("  landed on the routine the scan meant. ELSEWHERE: somewhere else, so the call is");
  console.log("  not to that routine and confirming it is an invention. SILENT: not scored.");
  console.log();
  console.log("  " + "language".padEnd(9) + "calls".padStart(7) + "real".padStart(7) + "elsewhere".padStart(11)
    + "silent".padStart(8) + "  |" + "agreed".padStart(8) + "refused".padStart(9) + "missed".padStart(8)
    + "accused".padStart(9) + "invented".padStart(10));
  for (const language of LANGUAGES) {
    const silent = total(receiverSilent.get(language) ?? new Map());
    const real = realOf(language);
    const elsewhere = elsewhereOf(language);
    if (real + elsewhere + silent === 0) continue;
    console.log("  " + language.padEnd(9) + String(real + elsewhere + silent).padStart(7) + String(real).padStart(7)
      + String(elsewhere).padStart(11) + String(silent).padStart(8) + "  |"
      + String(scoreOf(language, "agreed")).padStart(8) + String(scoreOf(language, "refused")).padStart(9)
      + String(scoreOf(language, "missed")).padStart(8) + String(scoreOf(language, "accused")).padStart(9)
      + String(scoreOf(language, "invented")).padStart(10));
  }

  console.log();
  console.log("  THE POPULATION THE LICENCE RESTS ON, before and after the checker:");
  for (const language of LANGUAGES) {
    const before = asked.get(language) ?? 0;
    const real = realOf(language);
    if (before + real === 0) continue;
    const agreedAll = (agreed.get(language) ?? 0) + scoreOf(language, "agreed");
    console.log(`    ${language.padEnd(8)} ${String(before).padStart(6)} -> ${String(before + real).padStart(6)}`
      + `   recall ${percent(agreed.get(language) ?? 0, before).trim()} -> ${percent(agreedAll, before + real).trim()}`);
  }
  console.log();
  console.log("  NOT SCORED, by reason. `checker-silent`: no answer at any site; `partly-silent`:");
  console.log("  some sites answered elsewhere and one did not, which could be the real call;");
  console.log("  `no-site`: the scan's line holds no such call once strings are read as strings.");
  for (const language of LANGUAGES) {
    if (receiverSilent.has(language)) console.log(`    ${language.padEnd(8)} ${listed(receiverSilent.get(language))}`);
  }
  for (const [where, why] of unavailable) console.log(`    no checker in ${where}: ${why}`);
  console.log();
  console.log("  REFUSED, on calls the checker says are real, by the reader's reason:");
  for (const language of LANGUAGES) {
    if (receiverRefusals.has(language)) console.log(`    ${language.padEnd(8)} ${listed(receiverRefusals.get(language))}`);
  }

  for (const [score, heading, meaning] of [
    ["missed", "MISSED", "the checker says the call is real, the reader said absent"],
    ["accused", "ACCUSED", "the checker says the call is real, the reader said backwards"],
    ["invented", "INVENTED", "the reader confirmed a call the checker places somewhere else"],
    ["backwards-elsewhere", "BACKWARDS, CALL ELSEWHERE", "not scored: only the forward half was checked"],
  ] as const) {
    const cases = receiverCases.filter((one) => one.score === score);
    console.log();
    console.log(`  ${heading} -- ${meaning}: ${cases.length}`);
    for (const one of cases.slice(0, cap(cases.length))) {
      console.log(`    ${one.tree}/${one.file}:${one.line} ${one.routine} -> ${one.name} (${one.target})`
        + (one.at ? `  checker: ${shortPath(one.at.file)}:${one.at.line + 1}` : ""));
    }
  }

  console.log();
  console.log("  A call is `real` only when the line the checker points at declares the name, so an");
  console.log("  answer naming the right file at another line reads as `elsewhere` -- the one way");
  console.log(`  that strictness could invent an INVENTED. It happened: ${total(elsewhereInTarget)} times.`);

  console.log();
  console.log("  NEGATIVE CONTROL -- every answer above judged against a different call's target.");
  console.log("  A check that lands either way is measuring nothing, so `real` here should be ~0.");
  for (const language of LANGUAGES) {
    const counts = negativeControl.get(language);
    if (!counts) continue;
    const all = total(counts);
    console.log(`    ${language.padEnd(8)} real ${counts.get("lands") ?? 0} of ${all}`
      + ` (${percent(counts.get("lands") ?? 0, all).trim()}), elsewhere ${counts.get("elsewhere") ?? 0},`
      + ` silent ${counts.get("silent") ?? 0}`);
  }

  if (control) {
    console.log();
    console.log("  CONTROL -- the checker asked about the bare calls above, whose answer the scan");
    console.log("  already has. It should land on the scan's routine; ELSEWHERE is a disagreement.");
    for (const language of LANGUAGES) {
      const counts = controlCounts.get(language);
      if (!counts) continue;
      console.log(`    ${language.padEnd(8)} real ${counts.get("lands") ?? 0}, elsewhere ${counts.get("elsewhere") ?? 0},`
        + ` silent ${counts.get("silent") ?? 0}`);
    }
    for (const one of controlElsewhere.slice(0, cap(controlElsewhere.length))) {
      console.log(`    ${one.tree}/${one.file}:${one.line} ${one.routine} -> ${one.name} (${one.target})`
        + `  checker: ${shortPath(one.at.file)}:${one.at.line + 1}`);
    }
  }
  if (dumpTo) {
    writeFileSync(dumpTo, JSON.stringify(dumped, null, 1));
    console.log();
    console.log(`  every call put to the checker (${dumped.length}) written to ${dumpTo}`);
  }
}

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
