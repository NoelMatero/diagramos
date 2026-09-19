#!/usr/bin/env node
/**
 * How often each claim word says **yes** to an arrow that is true (#302).
 *
 *   npm run measure:recall -- .corpus/*                   -- every word
 *   npm run measure:recall -- .corpus/* --words=holds,calls
 *   npm run measure:recall -- .corpus/* --refuse-all      -- the reader broken on purpose
 *   npm run measure:recall -- .corpus/* --examples=5      -- more cases per refusal reason
 *   npm run measure:recall -- .corpus/* --dump=<file>     -- every unconfirmed ask, as JSON
 *
 * Every other `measure-*` script asks whether it is safe for a word to say
 * *wrong*. This asks the other question. A word that is perfectly safe and
 * never confirms anything goes from "not sure" to "not sure" forever, and no
 * accusation count would notice.
 *
 * Three steps per word, on the pattern `measure-calls.mts` set:
 *
 *   1. **A referee lists relationships that genuinely exist** in the tree. It
 *      is the referee that word's licence was measured with, moved into
 *      `scripts/lib` rather than copied: `holds-scan`, `signature-scan`,
 *      `construct-scan`, `call-scan`, `access-scan`, `heritage-scan`,
 *      `dispatch-scan`, the compilers behind `@needs`. `@feeds` never accused,
 *      so it never had one, and `feeds-scan` is new.
 *   2. **The word's own reader is asked**, with the arguments `drift.ts` passes
 *      it -- including the far end's file, which is where a Rust `impl` or a
 *      member's owner lives.
 *   3. **Every answer lands in one bucket**: confirmed, refused with the
 *      reader's reason, or a definite *no* named by its verdict.
 *
 * ## The population, which is the part to argue with
 *
 * An arrow needs a box at each end, and a box points at code in the repository.
 * So a relationship is asked about only when **both ends are declared in the
 * tree, and the far end's name is declared exactly once** -- `measure-calls`'
 * own rule, with the ambiguity removed rather than guessed at. A name declared
 * twice in its own file is left out too, because which declaration a box means
 * is not a question the claim answers. Both exclusions are counted.
 *
 * What that leaves out is on purpose: a derive of `Clone`, a field of type
 * `str`, a call into a library. Nobody draws those as two boxes.
 *
 * ## Two labels per refusal reason
 *
 * `REASONS` below sorts every reason a reader gives into **the reader cannot
 * see it** (the fact is in the file; a better reader would confirm) or **the
 * fact is not in the file** (no reader of this file could). The second needs
 * evidence, so each entry names it, and the closed issue that did or did not
 * already address it. A reason the table does not know is printed as
 * UNLABELLED, loudly -- a list nobody can see the edge of is the bug
 * `docs/reading-a-grammar.md` is about.
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { distinctReads, refereeRoutines as accessRoutines, refereeTypes as accessTypes } from "./lib/access-scan";
import { refereeRoutines as callRoutines, bindsLocally, stripNoise } from "./lib/call-scan";
import { BUILT_IN as NOT_BUILT, refereeRoutines as constructRoutines } from "./lib/construct-scan";
import { labelsIn, type ScanLanguage } from "./lib/dispatch-scan";
import { dispatchesInRust, flatten, type RustDispatch } from "./lib/dispatch-scan-rust";
import { refereeFlows } from "./lib/feeds-scan";
import { refereeHeritage } from "./lib/heritage-scan";
import { BUILT_IN as NOT_HELD, refereeTypes as holdsTypes } from "./lib/holds-scan";
import { measureLicence, type LicenceMeasurement } from "./lib/licence";
import { measurePythonLicence } from "./lib/licence-python";
import { measureRustLicence } from "./lib/licence-rust";
import { textTypeNamesIn } from "./lib/signature-scan";
import { sourceFiles } from "./lib/source-files";

import { memberAccesses } from "../src/engine/accesses";
import { callsBetween, type CallSide } from "../src/engine/calls";
import { conformedTypes } from "../src/engine/conforms";
import { constructions, routineNamesIn } from "../src/engine/constructs";
import { readDependencies } from "../src/engine/deps";
import { createWorkspace } from "../src/engine/drift";
import { checkFeeds, type FeedsCandidate } from "../src/engine/feeds";
import { checkHandles } from "../src/engine/handles";
import { heldTypes } from "../src/engine/holds";
import { checkNeeds } from "../src/engine/needs";
import { initEngine, languageOf, parseSource, resetEngineCache, type Language, type Node } from "../src/engine/parse";
import type { ConfigCache } from "../src/engine/resolve";
import { signatureNames } from "../src/engine/signature";

await initEngine();

const WORDS = ["needs", "takes", "returns", "holds", "builds", "calls", "accesses", "conforms", "feeds", "handles"] as const;
type Word = (typeof WORDS)[number];

const argv = process.argv.slice(2);
const flag = (name: string) => argv.find((one) => one.startsWith(`--${name}=`))?.slice(name.length + 3);
const roots = argv.filter((one) => !one.startsWith("--"));
const only = new Set((flag("words")?.split(",") ?? WORDS) as Word[]);
/**
 * The reader broken on purpose: every ask comes back refused. A recall column
 * that does not fall to zero under this is not reading the reader (#302).
 */
const refuseAll = argv.includes("--refuse-all");
const perReason = Number(flag("examples") ?? 2);
/**
 * Every ask that was not confirmed, written out. Reading only the handful of
 * examples per reason is how a reason that is mostly the referee's mistake
 * gets labelled as the reader's.
 */
const dumpTo = flag("dump");
const dumped: Array<{ word: Word; language: Language; reason: string; crossFile: boolean; where: string }> = [];

if (roots.length === 0) {
  console.log("usage: npm run measure:recall -- <tree>... [--words=a,b] [--refuse-all] [--examples=N]");
  console.log("  the pinned corpus is .corpus/* -- see docs/claim-vocabulary.md");
  process.exit(0);
}
const trees = roots.filter((tree) => existsSync(tree)).map((tree) => realpathSync(tree));
const missingTrees = roots.filter((tree) => !existsSync(tree));

/* ---------------------------------------------------------------- the labels */

type Kind = "cannot-see" | "not-in-file" | "not-an-arrow";
interface Label { kind: Kind; why: string }

/**
 * Every reason a reader gives, sorted. Keys are `word/reason`, or `*\/reason`
 * where one reason means the same for every word. `not-an-arrow` is for the
 * handful that say the *referee's* pair is not one a board would draw, so they
 * are named rather than counted against either side.
 */
const REASONS: Record<string, Label> = {
  "*/broken-on-purpose": { kind: "cannot-see", why: "--refuse-all: the reader was switched off" },
  "*/unreadable": { kind: "cannot-see", why: "no grammar, or the file would not parse" },
  "*/incomplete": { kind: "cannot-see", why: "tree-sitter recovered from an error in the file; the text is still there" },
  "*/not-declared": { kind: "cannot-see", why: "the reader found no declaration the text scan found -- a reader gap until read case by case" },
  "*/aliased": { kind: "cannot-see", why: "an import or type alias renames the name; resolving it is a reader's job (#227 tier 1)" },
  "*/macro": { kind: "cannot-see", why: "macro tokens the reader does not expand; the text is in the file" },
  "*/unlicensed": { kind: "cannot-see", why: "a measurement gate, not a fact about the code (#207)" },
  "*/said:absent": { kind: "cannot-see", why: "the reader looked and did not find what the text scan found" },

  "needs/incomplete": { kind: "cannot-see", why: "EITHER file had a parse error somewhere, so nothing can be proved absent in it. Since #308 this refuses the accusation only: an import the grammar did read still confirms" },
  "needs/unvouched": { kind: "cannot-see", why: "no source index has read the file" },
  "needs/dynamic": { kind: "cannot-see", why: "EITHER file reaches out at run time (`table[name]()`, a Rust item macro), so neither can be said to declare nothing. Since #308 this refuses the accusation only: an import written in the tail confirms regardless (the rest here is the tail declaring nothing on the head)" },
  "needs/same-file": { kind: "not-an-arrow", why: "a file depending on itself" },
  "needs/said:backwards": { kind: "cannot-see", why: "the compiler sees the forward import and the reader does not" },
  "needs/said:indirect": { kind: "cannot-see", why: "the compiler sees a direct import and the reader reaches the far end only through another file -- mostly a Python `__init__.py` re-export. Amber, not red (#323)" },
  "needs/said:refuted": { kind: "cannot-see", why: "the compiler sees the import and the reader finds none, and no chain either: a false red. Every one must be in the licence's `known` (#323)" },

  "takes/no-signature": { kind: "cannot-see", why: "the name is declared as something the reader does not read as a function" },
  "returns/no-signature": { kind: "cannot-see", why: "the name is declared as something the reader does not read as a function" },
  "takes/quoted-annotation": { kind: "cannot-see", why: "a Python string annotation; the type is in the file, in quotes (#195)" },
  "returns/quoted-annotation": { kind: "cannot-see", why: "a Python string annotation; the type is in the file, in quotes (#195)" },
  "takes/self-type": { kind: "cannot-see", why: "`Self` stands for the impl's type, written a few lines up (#193)" },
  "returns/self-type": { kind: "cannot-see", why: "`Self` stands for the impl's type, written a few lines up (#193)" },
  "returns/untyped-return": { kind: "not-in-file", why: "the language writes no return type (JavaScript); nothing to read" },
  "takes/said:misplaced": { kind: "cannot-see", why: "the reader places the type in the other half of the signature from the text scan" },
  "returns/said:misplaced": { kind: "cannot-see", why: "the reader places the type in the other half of the signature from the text scan" },

  "holds/no-fields": { kind: "cannot-see", why: "declared, and the reader reads no field list off it" },
  "holds/quoted": { kind: "cannot-see", why: "a Python string annotation; the type is in the file, in quotes" },
  "holds/not-a-type": { kind: "not-an-arrow", why: "the far end is a routine, not a type" },

  "builds/no-body": { kind: "cannot-see", why: "declared, and the reader reads no body off it" },
  "builds/call-shaped": { kind: "cannot-see", why: "Python writes `Response(body)` for a construction and no import table was handed in, so the reader has nothing to tell it from an ordinary call (#188). Since #309 this is a caller holding one file, not the whole language" },
  "builds/not-constructed": { kind: "cannot-see", why: "the reader read the body and found no call to that name written in it at all -- the referee saw one, so this is the two call scans disagreeing (#309)" },
  "builds/unbound": { kind: "not-in-file", why: "nothing in the file binds the constructed name: a wildcard import, a builtin, a global (#189's hazard, #309's share of it)" },
  "builds/unplaced": { kind: "not-in-file", why: "the import that binds the name resolves to no file in the tree -- a package path, a build alias (#189)" },
  "builds/ambiguous": { kind: "cannot-see", why: "the file binds the constructed name more than one way" },
  "builds/elsewhere": { kind: "cannot-see", why: "the name comes to rest in a file other than the one the far box points at" },
  "builds/not-a-class": { kind: "cannot-see", why: "the name resolves to the far end and that file declares it with a parameter list -- a function, which constructs nothing. In this population that is the two readers disagreeing, not a fact about the code: the referee only asks about a name its own index calls a class in that file (#309)" },
  "builds/computed": { kind: "cannot-see", why: "the constructed name is written, through an expression the reader does not follow" },
  "builds/said:backwards": { kind: "cannot-see", why: "the reader finds the construction the other way and not this way" },
  "builds/said:cycle": { kind: "cannot-see", why: "both constructions are in the files; the reader declines a cycle" },

  "calls/no-body": { kind: "cannot-see", why: "declared, and the reader reads no body off it" },
  "calls/computed": { kind: "cannot-see", why: "the callee is an expression around a written name" },
  "calls/dynamic": { kind: "cannot-see", why: "the file reaches out at run time; the call is written" },
  "calls/receiver": { kind: "not-in-file", why: "a call on a receiver; whose method it is depends on the receiver's type, which the referee excluded -- tier 2 (#230, #257) resolves these, and it is not wired into this path" },
  "calls/unbound": { kind: "not-in-file", why: "the name comes from a wildcard import, a global or an ambient declaration -- no binding in this file names its source (#189)" },
  "calls/ambiguous": { kind: "cannot-see", why: "the file binds the name more than one way" },
  "calls/elsewhere": { kind: "cannot-see", why: "the reader resolves the name to a different file than the text scan's index" },
  "calls/unplaced": { kind: "not-in-file", why: "the import resolves to no file in the tree (a package path, a build alias) (#189)" },
  "calls/said:backwards": { kind: "cannot-see", why: "the reader sees the call the other way and not this way" },
  "calls/said:refuted": { kind: "cannot-see", why: "the closed-body check says the call is not there" },

  "accesses/no-member-named": { kind: "not-an-arrow", why: "the label names no member" },
  "accesses/no-members": { kind: "cannot-see", why: "declared, and the reader reads no member list off it" },
  "accesses/inherited": { kind: "not-in-file", why: "the type has a parent, and the member may be declared on it in another file (#255)" },
  "accesses/open": { kind: "not-in-file", why: "the member list is open: an index signature, `__getattr__`, a dynamic class -- members are not all written down" },
  "accesses/impl-elsewhere": { kind: "not-in-file", why: "a Rust trait's or type's members can be added by an `impl` in any file of the crate" },
  "accesses/not-a-type": { kind: "not-an-arrow", why: "the far end is a routine, not a type" },
  "accesses/said:not-read": { kind: "cannot-see", why: "the body reads `.member` per the text scan, and the reader found no read of that name" },
  "accesses/said:no-such-member": { kind: "cannot-see", why: "the type declares the member per the text scan, and the reader did not find it" },

  "conforms/subject-not-a-type": { kind: "not-an-arrow", why: "the near end is a routine" },
  "conforms/not-a-type": { kind: "not-an-arrow", why: "the far end is a routine" },
  "conforms/computed-base": { kind: "cannot-see", why: "a base written as an expression" },
  "conforms/region-is-the-crate": { kind: "not-in-file", why: "a Rust `impl Trait for Type` can sit in any file of the crate, so the type's own file does not carry it (#216, by design)" },

  "feeds/not-symbols": { kind: "not-an-arrow", why: "an end names a file" },
  "feeds/nowhere-to-look": { kind: "cannot-see", why: "no candidate file could be read" },
  "feeds/said:reversed": { kind: "cannot-see", why: "the reader finds the flow the other way and not this way" },

  "handles/no-grammar": { kind: "cannot-see", why: "no grammar for the file" },
  "handles/no-body": { kind: "cannot-see", why: "declared, and the reader reads no body off it" },
  "handles/no-dispatch": { kind: "cannot-see", why: "the text scan reads case labels in the routine and the reader finds no dispatch" },
  "handles/several-dispatches": { kind: "cannot-see", why: "the routine has more than one `match`/`switch` and the box does not say which -- or says a subject that is there twice (#310)" },
  "handles/no-such-dispatch": { kind: "cannot-see", why: "the subject named is not one the reader dispatches on in that routine. One case in the corpus, and it is a spelling difference: `syn` drops an inline comment out of `f(x, /* is_dir */ true)` and tree-sitter keeps it" },
  "handles/unreadable-case": { kind: "cannot-see", why: "an arm the reader cannot name" },
  "handles/catch-all": { kind: "cannot-see", why: "a `_` or `default` arm; the listed cases are all there" },
  "handles/chain-unmeasured": { kind: "cannot-see", why: "an if/elif chain, which has no referee yet so it may not be judged" },
  "handles/said:wrong": { kind: "cannot-see", why: "the reader's case list differs from the text scan's for this routine" },
};

const labelOf = (word: Word, reason: string): Label | undefined =>
  REASONS[`${word}/${reason}`] ?? REASONS[`*/${reason}`];

/* --------------------------------------------------------------- the tally */

interface Row {
  asked: number;
  confirmed: number;
  refused: number;
  saidNo: number;
  /** reason -> count, refusals and definite noes together (`said:` for the latter). */
  reasons: Map<string, number>;
  /** reason -> how many of those had the far end in another file. */
  crossFile: Map<string, number>;
  examples: Map<string, string[]>;
}
const rows = new Map<string, Row>();
const rowOf = (word: Word, language: Language): Row => {
  const key = `${word} ${language}`;
  let row = rows.get(key);
  if (!row) {
    row = { asked: 0, confirmed: 0, refused: 0, saidNo: 0, reasons: new Map(), crossFile: new Map(), examples: new Map() };
    rows.set(key, row);
  }
  return row;
};
/** Pairs the population rule left out, by word and why. */
const excluded = new Map<string, number>();
const exclude = (word: Word, why: string) => excluded.set(`${word} ${why}`, (excluded.get(`${word} ${why}`) ?? 0) + 1);
const notes: string[] = [];
const bump = <K,>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);

type Outcome = { kind: "confirmed" } | { kind: "refused"; why: string } | { kind: "no"; verdict: string };

/**
 * The one place every reader is asked, so `--refuse-all` breaks all of them at
 * once and nothing else.
 */
function ask(
  word: Word, language: Language, crossFile: boolean, where: string, run: () => Outcome,
): void {
  const outcome: Outcome = refuseAll ? { kind: "refused", why: "broken-on-purpose" } : run();
  const row = rowOf(word, language);
  row.asked += 1;
  if (outcome.kind === "confirmed") { row.confirmed += 1; return; }
  const reason = outcome.kind === "refused" ? outcome.why : `said:${outcome.verdict}`;
  if (outcome.kind === "refused") row.refused += 1;
  else row.saidNo += 1;
  bump(row.reasons, reason);
  if (crossFile) bump(row.crossFile, reason);
  if (dumpTo) dumped.push({ word, language, reason, crossFile, where });
  const list = row.examples.get(reason) ?? [];
  if (list.length < perReason) list.push(where);
  row.examples.set(reason, list);
}

/** A reader's verdict, into a bucket. `yes` names the verdict that confirms. */
const bucket = (verdict: { verdict: string; why?: string }, yes = "confirmed"): Outcome =>
  verdict.verdict === yes ? { kind: "confirmed" }
    : verdict.verdict === "withheld" ? { kind: "refused", why: verdict.why ?? "?" }
      : { kind: "no", verdict: verdict.verdict };

/* ---------------------------------------------------------------- the run */

const started = Date.now();
const timings: string[] = [];

/** What the licence harness measures a tree with, by its manifest (`measure-licence.mts`' rule). */
function needsHarness(root: string): [string, (root: string) => Promise<LicenceMeasurement>] {
  if (existsSync(path.join(root, "Cargo.toml"))) return ["rust-analyzer", measureRustLicence];
  if (["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"].some((name) => existsSync(path.join(root, name)))) {
    return ["pyright", measurePythonLicence];
  }
  return ["tsc", measureLicence];
}

/** A function-shaped node, the way `measure-signature.mts` finds one. */
function eachSignature(node: Node, visit: (name: string, parameters: string, returned: string) => void): void {
  const parameters = node.childForFieldName("parameters");
  const nameNode = node.childForFieldName("name");
  if (parameters && nameNode && nameNode.childCount === 0) {
    const returned = node.childForFieldName("return_type");
    visit(nameNode.text, parameters.text, returned ? ` -> ${returned.text.replace(/^:\s*/, "")}` : "");
  }
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child) eachSignature(child, visit);
  }
}

for (const tree of trees) {
  const began = Date.now();
  const name = path.basename(tree);
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
  const open = (rel: string) => {
    const source = read(rel);
    const language = languageOf(rel);
    if (source === undefined || !language) return undefined;
    return { source, language, imports: imports(rel, source) };
  };
  const at = (rel: string, line: number) => `${name}/${rel}:${line}`;

  /* -- @needs: the compiler's edges, asked of the dependency reader -- */
  if (only.has("needs")) {
    const [referee, harness] = needsHarness(tree);
    try {
      const measured = await harness(tree);
      for (const edge of [...measured.refereeEdges].sort()) {
        const [from, to] = edge.split(" -> ") as [string, string];
        const language = languageOf(from);
        if (!language) continue;
        ask("needs", language, true, `${name}/${from} -> ${to}`,
          () => bucket(checkNeeds(from, to, workspace, configs)));
      }
      timings.push(`${name} needs (${referee}) ${((Date.now() - began) / 1000).toFixed(0)}s`);
    } catch (error) {
      notes.push(`needs: ${name} not measured -- ${referee} failed: ${(error as Error).message.split("\n")[0]}`);
    }
  }

  const paths = sourceFiles(tree).map((file) => path.relative(tree, file));

  /*
   * The referees' own indexes, built once per tree: which files declare a type
   * of a name, which declare a routine, which types declare a member.
   */
  const typesIn = new Map<string, Set<string>>();
  const routinesIn = new Map<string, Set<string>>();
  const memberOwners = new Map<string, Set<string>>();
  const note = (map: Map<string, Set<string>>, key: string, value: string) => {
    const set = map.get(key) ?? new Set<string>();
    set.add(value);
    map.set(key, set);
  };
  for (const rel of paths) {
    const source = read(rel);
    const language = languageOf(rel);
    if (source === undefined || !language) continue;
    for (const type of holdsTypes(source, language)) note(typesIn, type.name, rel);
    for (const type of accessTypes(source, language)) {
      note(typesIn, type.name, rel);
      for (const member of new Set(type.members)) note(memberOwners, member, `${rel}#${type.name}`);
    }
    for (const routine of callRoutines(source, language)) note(routinesIn, routine.name, rel);
  }
  const onceIn = (map: Map<string, Set<string>>, key: string) => {
    const set = map.get(key);
    return set && set.size === 1 ? [...set][0]! : undefined;
  };
  /** Declared once, in a file, under this name -- or why not. */
  const typeFile = (key: string) => onceIn(typesIn, key);
  const routineFile = (key: string) => onceIn(routinesIn, key);
  const all: FeedsCandidate[] = [];
  for (const rel of paths) {
    const source = read(rel);
    const language = languageOf(rel);
    if (source !== undefined && language) all.push({ path: rel, source, language });
  }

  /*
   * Rust case labels are read per routine by the line scan and kept only where
   * `syn` also reads them somewhere in the file -- the line scan alone reads a
   * `macro_rules!` arm as a case, which is why #267 built the `syn` referee.
   * That referee has no routine bounds, so it cannot be used alone.
   */
  const rustReadings = only.has("handles")
    ? await dispatchesInRust(paths.filter((rel) => languageOf(rel) === "rust").map((rel) => path.join(tree, rel)))
    : {};
  const rustLabels = flatten(rustReadings);

  for (const rel of paths) {
    const source = read(rel);
    const language = languageOf(rel);
    if (source === undefined || !language) continue;
    const routines = callRoutines(source, language);
    const routineCount = new Map<string, number>();
    for (const routine of routines) bump(routineCount, routine.name);
    const uniqueRoutine = (key: string) => routineCount.get(key) === 1;

    /* -- @holds: a field's type, asked at the holder's file -- */
    if (only.has("holds")) {
      const declared = holdsTypes(source, language);
      const count = new Map<string, number>();
      for (const type of declared) bump(count, type.name);
      for (const type of declared) {
        for (const held of new Set(type.held)) {
          if (NOT_HELD.has(held) || held === type.name) continue;
          if (count.get(type.name) !== 1) { exclude("holds", "holder declared twice in its file"); continue; }
          const far = typeFile(held);
          if (!far) { exclude("holds", typesIn.has(held) ? "held type declared in several files" : "held type not declared in the tree"); continue; }
          const farLanguage = languageOf(far)!;
          ask("holds", language, far !== rel, at(rel, type.line), () => bucket(heldTypes(
            source, type.name, [held], language, { source: read(far)!, language: farLanguage },
          )));
        }
      }
    }

    /* -- @takes / @returns: a type in a signature, asked at the function's file -- */
    if (only.has("takes") || only.has("returns")) {
      const parsed = parseSource(source, language);
      if (parsed) {
        const found: Array<{ fn: string; parameters: string; returned: string }> = [];
        eachSignature(parsed.rootNode, (fn, parameters, returned) => found.push({ fn, parameters, returned }));
        const count = new Map<string, number>();
        for (const one of found) bump(count, one.fn);
        for (const { fn, parameters, returned } of found) {
          for (const [word, position, region] of [["takes", "parameter", parameters], ["returns", "return", returned]] as const) {
            if (!only.has(word)) continue;
            for (const type of textTypeNamesIn(region, language)) {
              const far = typeFile(type);
              if (!far) { if (/^[A-Z]/.test(type)) exclude(word, typesIn.has(type) ? "type declared in several files" : "type not declared in the tree"); continue; }
              if (count.get(fn) !== 1) { exclude(word, "function name declared twice in its file"); continue; }
              ask(word, language, far !== rel, `${name}/${rel} ${fn} ${type}`,
                () => bucket(signatureNames(source, fn, [type], position, language)));
            }
          }
        }
      }
    }

    /* -- @builds: a construction, asked at the building routine's file -- */
    if (only.has("builds")) {
      const made: Array<{ routine: string; type: string; line: number }> = [];
      if (language === "python") {
        /*
         * Python has no construction syntax, so the referee is the call scan: a
         * bare call to a name the tree declares once as a class.
         *
         * With one shape taken back out, found by building the reader (#309).
         * `CALL_TOKEN` is a name in front of a bracket and nothing more, so
         * `class E1(Exception):` reads as a bare call to `E1` -- the line that
         * *declares* the class, credited to whatever function it is nested in.
         * Not one of those is a construction, and on `pallets-flask` they were
         * 26 of 79 asks: a third of that tree's population, every one of them
         * counted against the reader for refusing to hallucinate a call.
         *
         * Filtered here rather than in `call-scan.ts`. That referee is shared
         * with `@calls`, which never sees these -- a class name is not in the
         * `routinesIn` index that word draws its population from -- so widening
         * the fix would move a number nothing is wrong with.
         */
        const lines = source.split("\n");
        const declaresItself = (name: string, line: number) =>
          new RegExp(`^\\s*class\\s+${name.replace(/[$]/g, "\\$&")}\\s*\\(`).test(lines[line - 1] ?? "");
        for (const routine of routines) {
          for (const call of routine.calls) {
            if (call.via !== "bare" || !typeFile(call.name)) continue;
            if (declaresItself(call.name, call.line)) {
              exclude("builds", "a class declaration read as a call by the referee");
              continue;
            }
            made.push({ routine: routine.name, type: call.name, line: call.line });
          }
        }
      } else {
        for (const routine of constructRoutines(source, language)) {
          for (const type of new Set(routine.makes)) made.push({ routine: routine.name, type, line: routine.line });
        }
      }
      const seen = new Set<string>();
      for (const one of made) {
        if (NOT_BUILT.has(one.type) || seen.has(`${one.routine}>${one.type}`)) continue;
        seen.add(`${one.routine}>${one.type}`);
        const far = typeFile(one.type);
        if (!far) { exclude("builds", typesIn.has(one.type) ? "type declared in several files" : "type not declared in the tree"); continue; }
        if (!uniqueRoutine(one.routine)) { exclude("builds", "routine declared twice in its file"); continue; }
        const farSource = read(far)!;
        const farLanguage = languageOf(far)!;
        ask("builds", language, far !== rel, at(rel, one.line), () => bucket(constructions(
          source, one.routine, [one.type], language,
          { source: farSource, routines: routineNamesIn(farSource, farLanguage), language: farLanguage, names: [one.routine] },
          /*
           * Python's imports (#309), the same way `drift.ts` hands them over.
           * Without this the reader has nothing to tell `Response(body)` from
           * `render(body)` with, and the column below is the 0.0% of 12,127 the
           * issue is about.
           */
          language === "python"
            ? { side: { file: rel, source, language, imports: imports(rel, source), open }, target: far }
            : undefined,
        )));
      }
    }

    /* -- @calls: `measure-calls.mts`' bare population, through `callsBetween` -- */
    if (only.has("calls")) {
      const cleaned = stripNoise(source, language);
      for (const routine of routines) {
        const wanted = new Map<string, { target: string; line: number }>();
        for (const call of routine.calls) {
          if (call.via !== "bare") continue;
          const target = routineFile(call.name);
          if (!target) { exclude("calls", routinesIn.has(call.name) ? "callee declared in several files" : "callee not declared in the tree"); continue; }
          if (target === rel && call.name === routine.name) continue;
          if (target !== rel && bindsLocally(cleaned, call.name)) { exclude("calls", "calling file binds the name itself"); continue; }
          if (!wanted.has(call.name)) wanted.set(call.name, { target, line: call.line });
        }
        for (const [callee, { target, line }] of wanted) {
          const targetSource = read(target);
          const targetLanguage = languageOf(target);
          if (targetSource === undefined || !targetLanguage) continue;
          ask("calls", language, target !== rel, `${at(rel, line)} ${routine.name} -> ${callee}`, () => bucket(callsBetween(
            { file: rel, source, language, imports: imports(rel, source), open, routine: routine.name },
            { file: target, source: targetSource, language: targetLanguage, imports: imports(target, targetSource), open, names: [callee] },
          )));
        }
      }
    }

    /* -- @accesses: a member read, owned by the one type that declares it -- */
    if (only.has("accesses")) {
      const readers = accessRoutines(source, language);
      const count = new Map<string, number>();
      for (const routine of readers) bump(count, routine.name);
      for (const routine of readers) {
        for (const { name: member, line } of distinctReads(routine)) {
          const owners = memberOwners.get(member);
          if (!owners) { exclude("accesses", "no type in the tree declares the member"); continue; }
          if (owners.size !== 1) { exclude("accesses", "member declared by several types"); continue; }
          const [far, owner] = [...owners][0]!.split("#") as [string, string];
          if (onceIn(typesIn, owner) !== far) { exclude("accesses", "owner type declared in several files"); continue; }
          if (count.get(routine.name) !== 1) { exclude("accesses", "routine declared twice in its file"); continue; }
          const farLanguage = languageOf(far)!;
          ask("accesses", language, far !== rel, `${at(rel, line)} ${routine.name} .${member} (${owner})`,
            () => bucket(memberAccesses(source, routine.name, member, language,
              { source: read(far)!, names: [owner], language: farLanguage })));
        }
      }
    }

    /* -- @conforms: asked at the file that declares the subtype -- */
    if (only.has("conforms")) {
      const lines = source.split("\n");
      for (const one of refereeHeritage(source, language)) {
        // `impl<E> Trait for E` names a type parameter, not a type anybody declared.
        const generics = /^\s*impl\s*<([^>]*)>/.exec(lines[one.line - 1] ?? "")?.[1] ?? "";
        if (new RegExp(`\\b${one.subject}\\b`).test(generics)) { exclude("conforms", "subtype is a type parameter"); continue; }
        const near = typeFile(one.subject);
        const far = typeFile(one.base);
        if (!far) { exclude("conforms", typesIn.has(one.base) ? "base declared in several files" : "base not declared in the tree"); continue; }
        if (!near) { exclude("conforms", typesIn.has(one.subject) ? "subtype declared in several files" : "subtype not declared in the tree"); continue; }
        const nearSource = read(near)!;
        const nearLanguage = languageOf(near)!;
        ask("conforms", nearLanguage, near !== rel, `${at(rel, one.line)} ${one.subject} : ${one.base} (declared in ${near})`,
          () => bucket(conformedTypes(nearSource, one.subject, [one.base], nearLanguage,
            { source: read(far)!, language: languageOf(far)! })));
      }
    }

    /* -- @feeds: a result handed on, asked of the whole tree the way `drift.ts` does -- */
    if (only.has("feeds")) {
      for (const flow of refereeFlows(source, language)) {
        const producer = routineFile(flow.producer);
        const consumer = routineFile(flow.consumer);
        if (!producer || !consumer) { exclude("feeds", "an end not declared once in the tree"); continue; }
        /*
         * `drift.ts` offers every source file in the tree. The verdict does not
         * depend on their order -- every candidate is read forwards before any
         * is read backwards -- so this file goes first and the answer is the
         * same, found sooner.
         */
        const pool = [all.find((one) => one.path === rel)!, ...all.filter((one) => one.path !== rel)];
        ask("feeds", language, producer !== rel || consumer !== rel,
          `${at(rel, flow.line)} ${flow.producer} -> ${flow.consumer}${flow.through ? ` via ${flow.through}` : ""}`,
          () => bucket(checkFeeds({ symbols: [flow.producer] }, { symbols: [flow.consumer] }, pool)));
      }
    }

    /* -- @handles: the case labels between a routine's opening and the next one -- */
    if (only.has("handles")) {
      const lines = source.split("\n");
      /*
       * The `syn` reading, grouped by `match` and by the `fn` it sits in
       * (#310). A box that names its dispatch is asking about one of them, so
       * the ask has to be one of them too -- and both the grouping and the
       * routine have to come from the referee, or the reader would be marking
       * its own partition.
       *
       * The routine matters as much as the grouping. Bounding a routine by the
       * next routine the *line* scan found put 40 routines on a 1,800-line
       * file: every `match` in a gap was attributed to whichever routine came
       * before it, and reading the real routine correctly then came back as a
       * disagreement. Measured before the fix, that alone was 49 refusals and
       * 15 definite noes, none of them about the reader.
       *
       * Rust only, because only Rust has a referee that can bound a dispatch.
       * The line scan reads a file as lines and knows nothing about where one
       * `match` stops, which is stated as its limitation in `dispatch-scan.ts`
       * rather than worked around here.
       */
      const synByRoutine = new Map<string, RustDispatch[]>();
      if (language === "rust") {
        for (const dispatch of rustReadings[path.join(tree, rel)]?.dispatches ?? []) {
          if (!dispatch.routine) continue;
          const kept = synByRoutine.get(dispatch.routine) ?? [];
          kept.push(dispatch);
          synByRoutine.set(dispatch.routine, kept);
        }
      }
      routines.forEach((routine, index) => {
        const end = routines[index + 1]?.line ?? lines.length + 1;
        const slice = lines.slice(routine.line - 1, end - 1).join("\n");
        let cases = [...new Set(labelsIn(slice, language as ScanLanguage))];
        if (language === "rust") {
          const parsed = new Set(rustLabels[path.join(tree, rel)] ?? []);
          const kept = cases.filter((one) => parsed.has(one));
          if (kept.length < cases.length) exclude("handles", "rust label the syn parse does not read");
          cases = kept;
        }
        if (cases.length === 0) return;
        if (!uniqueRoutine(routine.name)) { exclude("handles", "routine declared twice in its file"); return; }

        /*
         * A routine the referee sees several `match`es in is asked about each
         * one separately, the way a box would have to name them. One ask per
         * dispatch rather than one per routine, so the population grows -- and
         * that is reported rather than hidden: `asked` is the number of claims
         * a board could write, and a routine with two dispatches is two of
         * them.
         *
         * Routines the line scan never named are still not asked about, even
         * though `syn` now knows them. That gap is the line scan's and it
         * predates this, and closing it here would change the population under
         * the before-and-after rather than the reader.
         */
        const mine: RustDispatch[] = synByRoutine.get(routine.name) ?? [];
        if (mine.length > 1) {
          for (const dispatch of mine) {
            const own = [...new Set(dispatch.cases)];
            if (own.length === 0) continue;
            ask("handles", language, false,
              `${at(rel, dispatch.line)} ${routine.name} of ${dispatch.subject} [${own.slice(0, 4).join(", ")}${own.length > 4 ? ", .." : ""}]`,
              () => bucket(checkHandles(source, routine.name, own, language, dispatch.subject), "held"));
          }
          return;
        }

        ask("handles", language, false, `${at(rel, routine.line)} ${routine.name} [${cases.slice(0, 4).join(", ")}${cases.length > 4 ? ", .." : ""}]`,
          () => bucket(checkHandles(source, routine.name, cases, language), "held"));
      });
    }
  }
  resetEngineCache();
  timings.push(`${name} ${paths.length} files ${((Date.now() - began) / 1000).toFixed(0)}s`);
}

/* ------------------------------------------------------------------ report */

const LANGUAGES: Language[] = ["python", "ts", "tsx", "js", "rust"];
const percent = (part: number, whole: number) =>
  whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
const KIND_TEXT: Record<Kind, string> = {
  "cannot-see": "reader cannot see it",
  "not-in-file": "fact is not in the file",
  "not-an-arrow": "not an arrow a board draws",
};

console.log();
console.log("MEASURE RECALL -- when an arrow is true, how often does its word say yes?");
console.log(`  ${trees.length} trees: ${trees.map((tree) => path.basename(tree)).join(", ")}`);
for (const tree of missingTrees) console.log(`  !! not on disk, not read: ${tree}`);
if (refuseAll) console.log("  !! --refuse-all: every reader is switched off. Recall must read 0.0% everywhere.");
console.log("  Unit: one relationship the referee reads in the code, both ends declared in the tree,");
console.log("  the far end's name declared exactly once. Recall = confirmed / asked.");
console.log();
console.log("  " + "word".padEnd(10) + LANGUAGES.map((language) => language.padStart(19)).join("") + "        all");
for (const word of WORDS) {
  if (!only.has(word)) continue;
  let asked = 0;
  let confirmed = 0;
  const cells = LANGUAGES.map((language) => {
    const row = rows.get(`${word} ${language}`);
    if (!row || row.asked === 0) return "—".padStart(19);
    asked += row.asked;
    confirmed += row.confirmed;
    return `${percent(row.confirmed, row.asked)} of ${row.asked}`.padStart(19);
  });
  console.log("  " + word.padEnd(10) + cells.join("") + `   ${percent(confirmed, asked)} of ${asked}`.padStart(19));
}

console.log();
console.log("  WHY THE REST WERE NOT CONFIRMED -- per word, ranked. `said:` is a definite no;");
console.log("  the rest are refusals. `cross` is how many had the far end in another file.");
const unlabelled = new Set<string>();
for (const word of WORDS) {
  if (!only.has(word)) continue;
  const byReason = new Map<string, Map<Language, number>>();
  const cross = new Map<string, number>();
  let asked = 0;
  let missing = 0;
  for (const language of LANGUAGES) {
    const row = rows.get(`${word} ${language}`);
    if (!row) continue;
    asked += row.asked;
    missing += row.asked - row.confirmed;
    for (const [reason, count] of row.reasons) {
      const inner = byReason.get(reason) ?? new Map<Language, number>();
      inner.set(language, count);
      byReason.set(reason, inner);
      cross.set(reason, (cross.get(reason) ?? 0) + (row.crossFile.get(reason) ?? 0));
    }
  }
  console.log();
  console.log(`  @${word} -- ${missing} of ${asked} not confirmed`);
  const ranked = [...byReason.entries()]
    .map(([reason, counts]) => ({ reason, counts, total: [...counts.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total);
  for (const { reason, counts, total } of ranked) {
    const label = labelOf(word, reason);
    if (!label) unlabelled.add(`${word}/${reason}`);
    const split = [...counts.entries()].map(([language, count]) => `${language} ${count}`).join(", ");
    console.log(`    ${reason.padEnd(22)} ${String(total).padStart(7)}  ${percent(total, asked).padStart(6)}`
      + `  cross ${String(cross.get(reason) ?? 0).padStart(6)}  [${label ? KIND_TEXT[label.kind] : "UNLABELLED"}]  ${split}`);
    if (label) console.log(`      ${label.why}`);
    for (const language of LANGUAGES) {
      for (const example of rows.get(`${word} ${language}`)?.examples.get(reason) ?? []) {
        console.log(`        e.g. ${example}`);
      }
    }
  }
}

console.log();
console.log("  LEFT OUT BY THE POPULATION RULE -- counted, not asked:");
for (const word of WORDS) {
  const mine = [...excluded.entries()].filter(([key]) => key.startsWith(`${word} `));
  if (mine.length === 0) continue;
  console.log(`    @${word.padEnd(9)} ` + mine.sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key.slice(word.length + 1)} ${count}`).join(" · "));
}

if (unlabelled.size > 0) {
  console.log();
  console.log(`  !! UNLABELLED REASONS -- ${unlabelled.size}. Add each to REASONS with its evidence:`);
  for (const one of unlabelled) console.log(`    ${one}`);
}
for (const line of notes) console.log(`  !! ${line}`);
if (dumpTo) {
  writeFileSync(dumpTo, JSON.stringify(dumped, null, 1));
  console.log(`  every unconfirmed ask (${dumped.length}) written to ${dumpTo}`);
}
console.log();
console.log(`  took ${((Date.now() - started) / 1000).toFixed(0)}s`);
for (const line of timings) console.log(`    ${line}`);
console.log();
