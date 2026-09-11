#!/usr/bin/env node
/**
 * Where does real code touch the outside world, and does the door reader see it? (#58)
 *
 *   npm run measure:doors                            -- every pinned repository in .corpus
 *   npm run measure:doors -- --only=ripgrep,anyhow   -- some of them
 *   npm run measure:doors -- --sample=1500           -- calls per language the checker is asked about
 *   npm run measure:doors -- --all                   -- every disagreement, not the first few
 *
 * **A benchmark. No word ships from it and nothing here can colour a diagram.**
 *
 * ## Why
 *
 * An arrow onto a box outside the repository -- a file, a service, a database --
 * cannot be read, because every check asks whether code A reaches code B. #58's
 * way out is to anchor the outside box at its *door*: the code inside the
 * repository that talks to it. That only works if doors can be found, and only
 * matters if real code reaches the outside through a few of them. This measures
 * both, on real repositories and never on this repository's own test boards.
 *
 * ## The reader and the answer key
 *
 * `src/engine/outside.ts` names each call from the text and its imports, and
 * looks the name up in one list. The answer key asks each language's own
 * checker "go to definition" at the same call -- tsc, pyright, rust-analyzer --
 * and names the call from where that landed: `@types/node/fs.d.ts`, typeshed's
 * `os/__init__.pyi`, `library/std/src/fs.rs`. It looks that name up in **the
 * same list**. So a disagreement is about which thing a call is, never about
 * what counts as the outside, and the list's own edge is printed separately:
 * every standard-library module and package the checker reached that the list
 * does not cover.
 *
 * Asking a checker about every call is too slow for django, so it is asked
 * about every call the reader calls outside (how often the reader invents one),
 * and about a fixed-seed sample of everything else (how often it misses one).
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { checkerFor, type CallChecker, type Declared } from "./lib/call-receivers";
import { isOutsideRustTree } from "./lib/resolution-rust-lsp";
import { isOutsideTree } from "./lib/resolution-ts";
import { sourceFiles } from "./lib/source-files";

import { LICENCES } from "../src/engine/licence";
import { kindOfQualified, outsideCallsIn, type CallReading, type OutsideKind } from "../src/engine/outside";
import { initEngine, languageOf, resetEngineCache, type Language } from "../src/engine/parse";

const HOME = process.env.HOME ?? "/Users/noelmatero";
const argv = process.argv.slice(2);
const option = (name: string) => argv.find((one) => one.startsWith(`--${name}=`))?.slice(name.length + 3);
const showAll = argv.includes("--all");
const only = option("only")?.split(",").filter(Boolean);
const sampleSize = Number(option("sample") ?? 1500);
const CASES = showAll ? Infinity : 15;

const CORPUS = existsSync(path.resolve(".corpus")) ? path.resolve(".corpus") : `${HOME}/board-ai/.corpus`;

/** Checkers answer per family: tsx and js are TypeScript's compiler too. */
type Family = "ts" | "python" | "rust";
const familyOf = (language: Language): Family | undefined =>
  language === "ts" || language === "tsx" || language === "js" ? "ts"
    : language === "python" ? "python" : language === "rust" ? "rust" : undefined;

/**
 * Test code is left out and counted: a temporary file a test writes is real I/O
 * and not a door anybody draws. A hand-written pattern, so the files it drops
 * are reported rather than silently shrinking the corpus.
 */
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|benches|examples|fixtures|testing)(\/|$)|\.(test|spec)\.|(^|\/)test_[^/]*\.py$|_test\.(py|rs)$/;

/* -- the corpus: whatever licence.ts pins, as it sits in .corpus ---------- */

interface Repo { name: string; dir: string; commit: string; state: "pinned" | "moved" | "missing" }

const repos: Repo[] = LICENCES.flatMap((licence) => licence.corpus.map((entry) => {
  const candidates = [entry.name.replace("/", "-"), entry.name.split("/").pop()!];
  const dir = candidates.map((one) => path.join(CORPUS, one)).find((one) => existsSync(one)) ?? path.join(CORPUS, candidates[0]!);
  let state: Repo["state"] = "missing";
  if (existsSync(dir)) {
    let head = "";
    try { head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
    state = head === entry.commit ? "pinned" : "moved";
  }
  return { name: entry.name, dir, commit: entry.commit, state };
}))
  .filter((repo, index, all) => all.findIndex((other) => other.dir === repo.dir) === index)
  .filter((repo) => !only || only.some((one) => repo.dir.endsWith(`/${one}`) || repo.name === one));

/* -- pass one: the reader, over every call -------------------------------- */

interface Asked {
  repo: Repo;
  file: string;
  language: Language;
  family: Family;
  routine?: string;
  line: number;
  nameAt: { start: number; end: number };
  name: string;
  reading: CallReading;
  key: string;
}

await initEngine();

interface ReaderTally { files: number; calls: number; outside: Record<string, number>; notOutside: number; unknown: Record<string, number> }
const readerTally = new Map<Family, ReaderTally>();
const testFilesLeftOut = new Map<string, number>();
const doors = new Map<string, Record<OutsideKind, Set<string>>>();
const routinesSeen = new Map<string, Set<string>>();
const outsideCalls: Asked[] = [];
const others: Asked[] = [];
const bump = (into: Record<string, number>, key: string) => { into[key] = (into[key] ?? 0) + 1; };

for (const repo of repos) {
  if (repo.state === "missing") continue;
  const perKind: Record<OutsideKind, Set<string>> = { file: new Set(), network: new Set(), process: new Set() };
  const routines = new Set<string>();
  doors.set(repo.dir, perKind);
  routinesSeen.set(repo.dir, routines);
  for (const absolute of sourceFiles(repo.dir)) {
    const language = languageOf(absolute);
    const family = language ? familyOf(language) : undefined;
    if (!language || !family) continue;
    const rel = path.relative(repo.dir, absolute);
    if (TEST_PATH.test(rel)) { testFilesLeftOut.set(repo.dir, (testFilesLeftOut.get(repo.dir) ?? 0) + 1); continue; }
    let source: string;
    try { source = readFileSync(absolute, "utf8"); } catch { continue; }
    if (source.length > 1_000_000) continue;
    const { read, calls } = outsideCallsIn(source, language);
    if (!read) continue;
    const tally = readerTally.get(family) ?? { files: 0, calls: 0, outside: {}, notOutside: 0, unknown: {} };
    readerTally.set(family, tally);
    tally.files += 1;
    for (const call of calls) {
      tally.calls += 1;
      if (call.routine) routines.add(`${rel}#${call.routine}`);
      const asked: Asked = {
        repo, file: absolute, language, family, ...(call.routine ? { routine: call.routine } : {}),
        line: call.line, nameAt: call.nameAt, name: source.slice(call.nameAt.start, call.nameAt.end),
        reading: call.reading,
        key: createHash("sha1").update(`${repo.name}/${rel}:${call.nameAt.start}`).digest("hex"),
      };
      if (call.reading.verdict === "outside") {
        bump(tally.outside, call.reading.kind);
        perKind[call.reading.kind].add(`${rel}#${call.routine ?? "(top level)"}`);
        outsideCalls.push(asked);
      } else {
        if (call.reading.verdict === "unknown") bump(tally.unknown, call.reading.why);
        else tally.notOutside += 1;
        others.push(asked);
      }
    }
  }
  resetEngineCache();
}

/* -- pass two: the answer key --------------------------------------------- */

type KeyVerdict =
  | { verdict: "silent" }
  | { verdict: "inside" }
  | { verdict: "outside"; kind: OutsideKind; qualified: string }
  | { verdict: "not-outside"; qualified: string; where: "standard library" | "package" | "unplaced" };

const fileLines = new Map<string, string[]>();
const linesOf = (file: string) => {
  if (!fileLines.has(file)) {
    try { fileLines.set(file, readFileSync(file, "utf8").split("\n")); } catch { fileLines.set(file, []); }
  }
  return fileLines.get(file)!;
};

/** The name a declaration line declares, or the name written at the call. */
function declaredName(declared: Declared, fallback: string): string {
  const text = linesOf(declared.file)[declared.line] ?? "";
  const match = text.match(/\b(?:def|fn|function|class|interface|const|let|var)\s+([A-Za-z_$][\w$]*)/)
    ?? text.match(/^\s*(?:export\s+)?(?:declare\s+)?([A-Za-z_$][\w$]*)\s*[(:=<]/);
  return match?.[1] ?? fallback;
}

/** The `impl` a Rust declaration sits in, read upward from its own line. */
function rustImplOf(declared: Declared): string | undefined {
  const lines = linesOf(declared.file);
  for (let index = declared.line - 1; index >= 0; index -= 1) {
    const text = lines[index] ?? "";
    const impl = text.match(/^impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_]\w*)/);
    if (impl) return impl[1];
    if (/^(pub(\([^)]*\))?\s+)?(fn|struct|enum|mod|trait|const|static|type|macro_rules!)\b/.test(text)) return undefined;
  }
  return undefined;
}

/** Name a call from where "go to definition" landed, and look it up in the one list. */
function keyVerdictOf(declared: Declared | undefined, asked: Asked): KeyVerdict {
  if (!declared) return { verdict: "silent" };
  const tree = asked.repo.dir;
  const outsideTree = asked.family === "rust" ? isOutsideRustTree(declared.file, tree) : isOutsideTree(declared.file, tree);
  if (!outsideTree) return { verdict: "inside" };
  const member = declaredName(declared, asked.name);
  const named = (qualified: string, where: "standard library" | "package" | "unplaced"): KeyVerdict => {
    const kind = kindOfQualified(qualified, asked.language);
    return kind ? { verdict: "outside", kind, qualified } : { verdict: "not-outside", qualified, where };
  };
  const file = declared.file.split(path.sep).join("/");
  if (asked.family === "ts") {
    const node = file.match(/\/node_modules\/@types\/node\/(.+)\.d\.ts$/);
    if (node) {
      return /globals|web-globals/.test(node[1]!)
        ? named(member, "standard library")
        : named(`${node[1]}.${member}`, "standard library");
    }
    if (/\/typescript\/lib\/lib\.[^/]+\.d\.ts$/.test(file) || /\/undici-types\//.test(file)) return named(member, "standard library");
    const pkg = file.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    return pkg ? named(`${pkg[1]}.${member}`, "package") : named(member, "unplaced");
  }
  if (asked.family === "python") {
    const stdlib = file.match(/\/typeshed-fallback\/stdlib\/(.+)\.pyi$/);
    if (stdlib) {
      let module = stdlib[1]!.replace(/\/__init__$/, "").split("/").join(".");
      if (module === "posixpath" || module === "ntpath" || module === "genericpath") module = "os.path";
      return module === "builtins" ? named(member, "standard library") : named(`${module}.${member}`, "standard library");
    }
    const pkg = file.match(/\/(?:site-packages|typeshed-fallback\/stubs\/[^/]+)\/([^/]+)/);
    return pkg ? named(`${pkg[1]!.replace(/\.pyi?$/, "")}.${member}`, "package") : named(member, "unplaced");
  }
  const std = file.match(/\/library\/(std|core|alloc)\/src\/(.+)\.rs$/);
  if (std) {
    const module = [std[1], ...std[2]!.replace(/(^|\/)(mod|lib)$/, "").split("/").filter(Boolean)].join("::");
    const impl = rustImplOf(declared);
    return named([module, ...(impl ? [impl] : []), member].join("::"), "standard library");
  }
  const crate = file.match(/\/\.cargo\/registry\/src\/[^/]+\/([A-Za-z0-9_-]+?)-\d+\.\d+/);
  return crate ? named(`${crate[1]}::${member}`, "package") : named(member, "unplaced");
}

/** A fixed-seed sample per family: the same calls every run, spread across every repository. */
const sampled: Asked[] = [];
for (const family of ["ts", "python", "rust"] as const) {
  const pool = others.filter((one) => one.family === family).sort((a, b) => a.key.localeCompare(b.key));
  sampled.push(...pool.slice(0, sampleSize));
}

const answers = new Map<Asked, KeyVerdict>();
const checkerLabels = new Set<string>();
const unavailable = new Map<string, string>();
const byTree = new Map<string, Asked[]>();
for (const one of [...outsideCalls, ...sampled]) {
  const group = `${one.repo.dir}\t${one.family}`;
  byTree.set(group, [...(byTree.get(group) ?? []), one]);
}
for (const [group, asks] of byTree) {
  const [dir, family] = group.split("\t") as [string, Family];
  const made = await checkerFor(dir, asks[0]!.language);
  if ("unavailable" in made) {
    unavailable.set(`${path.basename(dir)} ${family}`, made.unavailable);
    for (const one of asks) answers.set(one, { verdict: "silent" });
    continue;
  }
  const checker: CallChecker = made;
  checkerLabels.add(checker.label);
  const BATCH = 16;
  for (let start = 0; start < asks.length; start += BATCH) {
    await Promise.all(asks.slice(start, start + BATCH).map(async (one) => {
      let declared: Declared | undefined;
      try {
        declared = await checker.definitionAt(one.file, readFileSync(one.file, "utf8"), one.nameAt);
      } catch {
        declared = undefined;
      }
      answers.set(one, keyVerdictOf(declared, one));
    }));
  }
  checker.close();
}

/* -- the report ----------------------------------------------------------- */

const percent = (part: number, whole: number) => (whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`);
const where = (one: Asked) => `${one.repo.name}/${path.relative(one.repo.dir, one.file)}:${one.line}`;
const readerSays = (reading: CallReading) =>
  reading.verdict === "outside" ? `${reading.kind} (${reading.qualified})`
    : reading.verdict === "unknown" ? `unknown: ${reading.why}` : `not outside (${reading.qualified})`;
const keySays = (verdict: KeyVerdict) =>
  verdict.verdict === "outside" ? `${verdict.kind} (${verdict.qualified})`
    : verdict.verdict === "not-outside" ? `not outside (${verdict.qualified}, ${verdict.where})` : verdict.verdict;

console.log();
console.log("CORPUS -- the repositories licence.ts pins, product code only");
for (const repo of repos) {
  const left = testFilesLeftOut.get(repo.dir) ?? 0;
  console.log(`  ${repo.name.padEnd(24)} ${repo.state.padEnd(8)} ${left} test files left out`);
}
console.log(`  checkers: ${[...checkerLabels].join(", ") || "none"}`);
for (const [what, why] of unavailable) console.log(`  no checker for ${what}: ${why}`);

console.log();
console.log("READER -- every call, named from the text and its imports");
for (const [family, tally] of readerTally) {
  const unknown = Object.values(tally.unknown).reduce((sum, count) => sum + count, 0);
  const outside = Object.values(tally.outside).reduce((sum, count) => sum + count, 0);
  console.log(`  ${family.padEnd(7)} ${tally.files} files, ${tally.calls} calls: ${outside} outside `
    + `(${Object.entries(tally.outside).map(([kind, count]) => `${kind} ${count}`).join(", ")}), `
    + `${tally.notOutside} not outside, ${unknown} unknown (${percent(unknown, tally.calls)})`);
}

console.log();
console.log("INVENTED -- calls the reader says touch the outside, asked of the checker");
const invented: Asked[] = [];
for (const family of ["ts", "python", "rust"] as const) {
  const mine = outsideCalls.filter((one) => one.family === family);
  if (mine.length === 0) continue;
  const tally: Record<string, number> = {};
  for (const one of mine) {
    const key = answers.get(one) ?? { verdict: "silent" };
    const reading = one.reading as Extract<CallReading, { verdict: "outside" }>;
    const score = key.verdict === "silent" ? "silent"
      : key.verdict === "outside" ? (key.kind === reading.kind ? "agreed" : "other kind") : "invented";
    bump(tally, score);
    if (score === "invented" || score === "other kind") invented.push(one);
  }
  const answered = mine.length - (tally.silent ?? 0);
  console.log(`  ${family.padEnd(7)} ${mine.length} asked: agreed ${tally.agreed ?? 0}, invented ${tally.invented ?? 0}, `
    + `other kind ${tally["other kind"] ?? 0}, checker silent ${tally.silent ?? 0} `
    + `-- ${percent(tally.invented ?? 0, answered)} of answered calls invented`);
}
for (const one of invented.slice(0, CASES)) {
  console.log(`      ${where(one)}  ${one.name}  reader: ${readerSays(one.reading)}  checker: ${keySays(answers.get(one)!)}`);
}
if (invented.length > CASES) console.log(`      ... and ${invented.length - CASES} more (--all)`);

console.log();
console.log("MISSED -- a fixed sample of every other call, asked of the checker");
const missed: Asked[] = [];
for (const family of ["ts", "python", "rust"] as const) {
  const mine = sampled.filter((one) => one.family === family);
  const population = others.filter((one) => one.family === family).length;
  if (mine.length === 0) continue;
  const tally: Record<string, number> = {};
  const byReader: Record<string, number> = {};
  for (const one of mine) {
    const key = answers.get(one) ?? { verdict: "silent" };
    if (key.verdict === "silent") { bump(tally, "silent"); continue; }
    if (key.verdict === "outside") {
      bump(tally, "missed");
      bump(byReader, one.reading.verdict === "unknown" ? `unknown: ${one.reading.why}` : "named, off the list");
      missed.push(one);
    } else bump(tally, "rightly not outside");
  }
  const answered = mine.length - (tally.silent ?? 0);
  const rate = answered === 0 ? 0 : (tally.missed ?? 0) / answered;
  console.log(`  ${family.padEnd(7)} ${mine.length} of ${population} asked: missed ${tally.missed ?? 0} `
    + `(${Object.entries(byReader).map(([why, count]) => `${why} ${count}`).join(", ") || "none"}), `
    + `rightly not outside ${tally["rightly not outside"] ?? 0}, checker silent ${tally.silent ?? 0} `
    + `-- ${percent(tally.missed ?? 0, answered)} of the ${percent(answered, mine.length)} the checker answered, `
    + `which is ~${Math.round(rate * population)} across the population only if the silent calls are like the answered ones`);
}
for (const one of missed.slice(0, CASES)) {
  console.log(`      ${where(one)}  ${one.name}  reader: ${readerSays(one.reading)}  checker: ${keySays(answers.get(one)!)}`);
}
if (missed.length > CASES) console.log(`      ... and ${missed.length - CASES} more (--all)`);

console.log();
console.log("THE EDGE OF THE LIST -- outside the repository, not on the list, as the checker named it");
const edge = new Map<string, number>();
for (const [one, key] of answers) {
  if (key.verdict !== "not-outside" || key.where === "unplaced") continue;
  const step = one.family === "rust" ? "::" : ".";
  const module = key.qualified.split(step).slice(0, -1).join(step) || key.qualified;
  const label = `${one.family} ${key.where}: ${module}`;
  edge.set(label, (edge.get(label) ?? 0) + 1);
}
for (const [label, count] of [...edge].sort((a, b) => b[1] - a[1]).slice(0, showAll ? Infinity : 25)) {
  console.log(`  ${String(count).padStart(5)}  ${label}`);
}

console.log();
console.log("DOORS -- routines with a direct call outside, by the reader (see INVENTED for how far to trust it)");
for (const repo of repos) {
  const perKind = doors.get(repo.dir);
  if (!perKind) continue;
  const routines = routinesSeen.get(repo.dir)?.size ?? 0;
  console.log(`  ${repo.name.padEnd(24)} ${routines} routines -- file ${perKind.file.size}, `
    + `network ${perKind.network.size}, process ${perKind.process.size}`);
}
