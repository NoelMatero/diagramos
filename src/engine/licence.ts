/**
 * What a language has earned the right to say.
 *
 * A "wrong" verdict is an accusation -- your arrow points one way and your code
 * points the other -- and it rests on two claims at once: that the dependency
 * exists in the direction the code has it, and that it does *not* exist in the
 * direction the board drew. So both kinds of error turn into a false accusation.
 * An edge the reader invents makes it accuse on evidence that was never there;
 * an edge the reader misses makes it accuse because it mistook its own blindness
 * for an absence. Neither is recoverable once someone has stopped believing the
 * tool.
 *
 * Hence a licence, with the number in the repo where it can be argued with.
 * `scripts/measure-licence.mts` reproduces it.
 *
 * The number is not a promise about all TypeScript. It is a measurement over
 * named repositories at named commits, and the way to disagree with it is to add
 * a repository and re-run.
 *
 * ## Two axes, not one (#207)
 *
 * A licence is per language **and per word**, and for most of this file's life
 * only the first half was true -- because only one reader could accuse. That
 * stopped being true at #198: one Python entry came to speak for four words on
 * the strength of three unrelated measurements, and nothing in the type said
 * which measurement had earned which word. Nothing was accusing wrongly. The
 * hole was the *next* word, which would have inherited Python's permission from
 * a measurement of something else, silently -- which is #195 with a different
 * reader, and #195 is why this file exists.
 *
 * So the corpus below measures the **dependency** reader and says so, and
 * `relations` on each licence records what measured `holds`, `takes`, `returns`
 * and `builds` -- three other referees, three other commands, three other
 * corpora. `mayAccuse` takes both.
 */

import { languageOf, type Language } from "./parse";
import { ARROW_CLAIMS, type ArrowClaim } from "./claim";

/**
 * A word that may say **wrong**, which is every arrow word but `feeds`.
 *
 * Written as an exclusion rather than a list of five strings, and that is the
 * whole mechanism of the grid below. Add a seventh word to `ARROW_CLAIMS` and
 * this type grows a member, every licence's `relations` record stops being
 * exhaustive, and the build fails until somebody writes down what measured it.
 * A list would have gone stale in silence, which is #195 and #207 both: a
 * reader shipping an accusation because it inherited permission.
 *
 * A confirm-only word breaks the build too, and that is intended -- `feeds` is
 * excluded here because somebody decided it, and the next one deserves the same
 * decision rather than a default.
 */
export type AccusingRelation = Exclude<ArrowClaim, "feeds">;

/**
 * The same list at runtime, filtered from `ARROW_CLAIMS` rather than typed out.
 *
 * Complete by construction, so a report that walks it cannot quietly stop
 * mentioning a word.
 */
export const ACCUSING_RELATIONS: readonly AccusingRelation[] =
  ARROW_CLAIMS.filter((word): word is AccusingRelation => word !== "feeds");

/** One repository, at the commit it was measured at. */
export interface CorpusEntry {
  name: string;
  url: string;
  /** Pinned, because a moving corpus makes the number unreproducible. */
  commit: string;
  files: number;
  /** Intra-repository dependency edges the referee found. */
  edges: number;
  /** Referee had it, the reader did not. */
  missed: number;
  /** Reader had it, the referee did not. */
  invented: number;
  /**
   * Source files present in the tree that the measurement left out entirely,
   * because the referee never opened them.
   *
   * Recorded rather than netted off, and the reason is the point of this whole
   * file. A file no crate declares is a file rustc never compiles, so
   * rust-analyzer has no opinion about it and neither may we -- the exclusion is
   * symmetric, and `files` above already counts only what was compared, so the
   * recall and precision are honest about the sample they describe. What they
   * cannot tell you is how big that sample was as a fraction of the tree, and a
   * reader who cannot see the denominator cannot argue with the number. Rust
   * leaves out 15% of the corpus this way, and the files a referee fails to load
   * are not a random 15%: they are the awkward ones.
   */
  unmeasured?: number;
}

/**
 * What one word's reader was measured at, in one language.
 *
 * The licence above is a measurement of the *dependency* reader, and for most
 * of this project's life that was the only reader that could accuse. It is not
 * any more: `holds.ts`, `signature.ts` and `constructs.ts` each read something
 * else, against a referee of their own, on a corpus of their own. One licence
 * entry saying "yes" for all four is the same mistake as one language entry
 * saying "yes" for all languages, one axis over.
 */
export interface RelationMeasured {
  /** The command that reproduces it. */
  reproduce: string;
  /** ISO date this reader was last measured for this word in this language. */
  measured: string;
  /** What produced the ground truth, and why it is not this reader. */
  referee: string;
  /** What the referee counted, in its own units. */
  unit: string;
  /*
   * A note on reproducing these. The dependency corpus is five repositories at
   * pinned commits, so its numbers are exact. The other three commands read
   * trees as they sit on disk -- this repository among them -- so their counts
   * move by a handful with every commit, this one included. What has to hold is
   * the miss column, which is the number an accusation rests on.
   */
  /**
   * The counts, or `"corpus"` for the table above.
   *
   * `needs` is what that corpus measures, and writing 12,693 out a second time
   * beside it is exactly the two-lists-of-one-fact drift this file warns about
   * thirty lines down. `relationTotals` resolves it.
   *
   * `invented` is left out where the run does not count it -- `measure:signature`
   * counts misses and refusals and nothing else -- and an absent number is not a
   * zero. A miss is the one that turns into a false red, which is why the bar
   * every one of these rows is held to is the miss column.
   */
  counts: "corpus" | { asked: number; missed: number; invented?: number };
  /**
   * The languages inside this licence that the run actually asked about.
   *
   * Omitted means all of them, which is the honest answer for `needs`: its
   * corpus is five whole repositories and the referee compiles every extension
   * the licence names.
   *
   * It is not the honest answer for the other three. One licence entry covers
   * TypeScript, TSX **and JavaScript**, and `measure:holds`, `measure:signature`
   * and `measure:constructs` between them ask JavaScript 0 questions -- 21
   * files, 51 functions, not one type name and not one construction. So the
   * entry is right that its extensions were measured for imports and wrong that
   * they were measured for field lists, and saying "yes" on JavaScript's behalf
   * is #207 one axis over: permission inherited from a measurement of something
   * else. Found while filling this grid in, which is what the grid is for.
   */
  covers?: readonly Language[];
  /** Anything true about the sample that the counts alone would hide. */
  note?: string;
  /**
   * Disagreements that are understood, one line each, and the only thing that
   * lets `missed` be anything but zero.
   *
   * The same field `Licence.known` is, for the same reason and with the same
   * rule behind it. A word measured over trees **as they sit on disk** is held
   * to a miss of zero: the corpus is whatever happened to be checked out, so a
   * miss there is a reader that cannot read something rather than a fact about
   * the world. A word measured over **pinned repositories** is not, and a zero
   * there would mean the corpus was too small -- which is exactly what `needs`
   * records, and why `rust`'s `calls` row grew this field the moment it stopped
   * being measured on two toy projects.
   *
   * What may go in here is a disagreement somebody has read and understood. It
   * is not a place to park a miss nobody has looked at, and the test that reads
   * it checks the count rather than the prose, so a fifth miss cannot hide
   * behind four explanations.
   */
  known?: readonly string[];
}

/** A word this language has no number for. It may not accuse, and this says why. */
export interface RelationUnmeasured {
  /** Printed where a number would be, because "no" without a reason is a shrug. */
  unmeasured: string;
}

export type RelationLicence = RelationMeasured | RelationUnmeasured;

/** Whether a row is a measurement rather than a stated absence of one. */
export function isMeasured(row: RelationLicence): row is RelationMeasured {
  return !("unmeasured" in row);
}

export interface Licence {
  language: string;
  /** File extensions this licence covers. */
  extensions: readonly string[];
  /** ISO date the corpus was last measured. */
  measured: string;
  /** What produced the ground truth, and why it is not us. */
  referee: string;
  corpus: readonly CorpusEntry[];
  /** Disagreements that are understood and not expected to close. */
  known: readonly string[];
  /**
   * Which words this language may accuse with, and what earned each one.
   *
   * Exhaustive by type, so the hole is impossible rather than merely visible:
   * a new accusing word does not compile until every licence has an answer for
   * it, and the answer can be `unmeasured`. That was the decision at #207 --
   * see the header of `mayAccuse`.
   */
  relations: Record<AccusingRelation, RelationLicence>;
}

/**
 * The referee for the three words the dependency corpus does not cover.
 *
 * A text scan of the same source, sharing no tree-sitter query with the reader
 * -- so agreeing means two unrelated readings agree rather than one reading
 * agreeing with itself, which is the mistake that got two orders of magnitude
 * into #190. Named once because it is one referee wearing three hats, and a
 * reader comparing squares should be able to see that.
 */
const TEXT_SCAN = (what: string): string =>
  `a text scan of the ${what} source, run over the same trees. It shares no `
  + "tree-sitter query with the reader, so agreeing means two unrelated readings "
  + "agree rather than one reading agreeing with itself.";

/**
 * The referee for `calls`, which is a text scan like the three above but not the
 * same one: it has to find where a routine ends before it can say whose call a
 * call is, and the other three never need to. Named separately for that reason
 * rather than folded into `TEXT_SCAN`, because a square that says yes has to
 * name the thing that earned it and these are two different things.
 */
const CALL_SCAN =
  "a text scan of the same source that bounds each routine by braces, or by "
  + "indentation in Python, and reads the calls inside it. It shares no "
  + "tree-sitter query and no import resolution with the reader.";

/**
 * One run of `measure:signature` covers `takes` and `returns` together, and the
 * grid records that as two rows citing one measurement rather than one row that
 * both words read. The difference is what #207 is about: a square that says yes
 * has to name the thing that earned it, and two squares may name the same thing.
 */
const TYPESCRIPT_SIGNATURE: RelationMeasured = {
  reproduce: "npm run measure:signature",
  measured: "2026-09-02",
  referee: TEXT_SCAN("signature"),
  unit: "type names in function signatures",
  counts: { asked: 1842, missed: 0 },
  covers: ["ts", "tsx"],
  note:
    "1,801 of them TypeScript and 41 TSX. JavaScript is inside this licence and " +
    "outside this number, and it is the one square here that was costing " +
    "something: its 51 functions declare no type at all, so every parameter " +
    "claim on one read as an absence and was refutable -- 51 of 51 -- by a " +
    "reader no referee has ever checked in JavaScript. They are withheld now.",
};

const RUST_SIGNATURE: RelationMeasured = {
  reproduce: "npm run measure:signature",
  measured: "2026-09-02",
  referee: TEXT_SCAN("signature"),
  unit: "type names in function signatures",
  counts: { asked: 154, missed: 0 },
  note:
    "Across 63 functions, withholding 5 of them for `Self` (#193). A " +
    "small sample beside TypeScript's and Python's, and the smallest " +
    "number on this grid.",
};

const PYTHON_SIGNATURE: RelationMeasured = {
  reproduce: "npm run measure:signature",
  measured: "2026-09-02",
  referee: TEXT_SCAN("signature"),
  unit: "type names in function signatures",
  counts: { asked: 4002, missed: 0 },
  note:
    "Across 1,543 functions, of which it would refute 1,404 and withhold " +
    "139 -- 71 aliased, 68 quoted. Before #198 it withheld all 1,543, " +
    "1,404 of them for no reason but a missing licence.",
};

export const LICENCES: readonly Licence[] = [
  {
    language: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    measured: "2026-08-21",
    referee:
      "the TypeScript compiler: ts.createSourceFile for the specifiers, " +
      "ts.resolveModuleName for the files. Chosen because the reader and the " +
      "regex channel share src/engine/resolve.ts, so agreeing with each other " +
      "says nothing about the step they have in common.",
    /*
     * This repository is not in the corpus, and that is not an oversight: its
     * file count moves with every commit, so a pinned row would be wrong by the
     * next one. It is measured continuously instead -- `tests/engine-licence.test.ts`
     * runs the same harness over the working tree and fails on any disagreement
     * at all, which is a stricter guard than a number in a table.
     */
    corpus: [
      { name: "vuejs/core", url: "https://github.com/vuejs/core.git", commit: "e2bede96134f757aad5c5b33ac9be055022dbfc8", files: 527, edges: 1795, missed: 0, invented: 0 },
      { name: "vitejs/vite", url: "https://github.com/vitejs/vite.git", commit: "92bd2a7f325ed102349cdc6c1ad4b5cd25e1d72f", files: 1553, edges: 1900, missed: 1, invented: 1 },
      { name: "TanStack/query", url: "https://github.com/TanStack/query.git", commit: "6796c512752ac95b1b593df91b20d5d416c1b69f", files: 1109, edges: 1410, missed: 1, invented: 0 },
      { name: "excalidraw/excalidraw", url: "https://github.com/excalidraw/excalidraw.git", commit: "e160ff7ba0641fba729c528482de5277ffb19c58", files: 666, edges: 3320, missed: 0, invented: 0 },
      { name: "nestjs/nest", url: "https://github.com/nestjs/nest.git", commit: "dd75d7bd8c5e88048587e6768d36eb695f3e7a25", files: 1904, edges: 4399, missed: 0, invented: 0 },
    ],
    known: [
      "A package importing itself by its published name through a condition only " +
        "its own build defines. TanStack/query routes '.' through a custom " +
        "tsconfig condition to src/index.ts; every condition a reader can know " +
        "about points at build output that does not exist in a fresh clone.",
      "A specifier written './x.js' where both x.js and x.ts exist. The compiler " +
        "takes the TypeScript file, the reader takes the one actually named, and " +
        "there is no third answer in the text. One vite test fixture does this, " +
        "which is both the miss and the invention in that row.",
    ],
    relations: {
      needs: {
        reproduce: "npm run measure:licence -- --only=typescript",
        measured: "2026-08-21",
        referee: "the corpus above, and the referee named beside it",
        unit: "dependency edges",
        counts: "corpus",
      },
      takes: TYPESCRIPT_SIGNATURE,
      returns: TYPESCRIPT_SIGNATURE,
      holds: {
        reproduce: "npm run measure:holds",
        measured: "2026-09-02",
        referee: TEXT_SCAN("field list"),
        unit: "field asks",
        counts: { asked: 1195, missed: 0, invented: 0 },
        covers: ["ts", "tsx"],
        note:
          "1,018 of them TypeScript and 177 TSX. JavaScript writes no type on a " +
          "field, so its 21 files in the corpus ask nothing -- and `holds` " +
          "refuses them as `no-fields` well before the licence is read, which " +
          "is why saying no here costs nothing and says something true.",
      },
      builds: {
        reproduce: "npm run measure:constructs",
        measured: "2026-09-02",
        referee: TEXT_SCAN("routine body"),
        unit: "construction asks",
        counts: { asked: 225, missed: 0, invented: 0 },
        covers: ["ts", "tsx"],
        note:
          "55 of them TypeScript and 170 TSX. JavaScript is the real gap on this " +
          "grid: `new Foo()` is a construction this reader could read there, and " +
          "the corpus simply has none to ask about. Unlike `holds`, nothing else " +
          "stops a JavaScript `@builds` arrow, so the empty square is the only " +
          "thing standing between an unmeasured reader and a red.",
      },
      calls: {
        reproduce: "npm run measure:calls",
        measured: "2026-09-03",
        referee: CALL_SCAN,
        unit: "calls between routines the corpus declares exactly once",
        counts: { asked: 1091, missed: 0, invented: 0 },
        covers: ["ts", "tsx"],
        note:
          "780 TypeScript at 97.9% recall and 311 TSX at 87.5%. JavaScript is " +
          "inside this licence and was asked **2 questions** over 7 files, which " +
          "is the square #207 was written for and #211 landed on: `calls` shipped " +
          "reading the old per-language gate, so a JavaScript arrow could be told " +
          "to turn round on a reader nothing had measured in JavaScript. Nothing " +
          "structural stops a JavaScript call the way `no-fields` stops a " +
          "JavaScript `holds`, so this `covers` is the only thing withholding it.",
      },
    },
  },
  {
    language: "rust",
    extensions: [".rs"],
    measured: "2026-08-22",
    referee:
      "rust-analyzer, asked for an LSIF dump: the same name resolution an " +
      "editor does, written by people who were not us. A path is counted as " +
      "naming a file when the thing it resolves to is a *module* -- which " +
      "rust-analyzer states itself, in the hover text on every result -- so " +
      "the two sides mean the same thing by an edge. Neither a nightly " +
      "toolchain nor a successful build is needed, which is what makes " +
      "measuring five repositories practical.",
    /*
     * Rust is here to prove the licence is a mechanism rather than a story told
     * about TypeScript, and it did not go through unchanged: the reader lost
     * and regained recall six times against these five repositories, and every
     * recovery was a rule of the language nobody would have guessed at from
     * inside a repository with no Rust in it -- `[[bin]] path`, `autotests =
     * false`, uniform paths, `pub extern crate .. as ..`, `super` inside an
     * inline module, `#[path]` sharing a module between two crates.
     */
    corpus: [
      { name: "dtolnay/anyhow", url: "https://github.com/dtolnay/anyhow.git", commit: "bf3ed9149f4334c984c1ad252b534107b307078c", files: 28, edges: 48, missed: 0, invented: 1, unmeasured: 9 },
      { name: "BurntSushi/ripgrep", url: "https://github.com/BurntSushi/ripgrep.git", commit: "3fce3b5bb0236da2df6d99672afb8a719642eca7", files: 104, edges: 357, missed: 0, invented: 8, unmeasured: 6 },
      { name: "serde-rs/json", url: "https://github.com/serde-rs/json.git", commit: "afdf6fc67247dd7fa4fcde1381e6ecc6bcc7a30e", files: 55, edges: 187, missed: 0, invented: 18, unmeasured: 16 },
      { name: "rust-lang/regex", url: "https://github.com/rust-lang/regex.git", commit: "72d650cb0a880a01ab6dc2137c0888e8f89740f7", files: 214, edges: 1304, missed: 0, invented: 1, unmeasured: 13 },
      { name: "clap-rs/clap", url: "https://github.com/clap-rs/clap.git", commit: "6982fb1c98c7247e38a6d4f04191b94e30497e7b", files: 261, edges: 643, missed: 5, invented: 1, unmeasured: 69 },
    ],
    known: [
      "A file compiled into two crates at once, where `crate::` has a different " +
        "answer in each. serde_json's tests/lexical.rs says `#[path = " +
        "\"../src/lexical/mod.rs\"] mod lexical;`, so src/lexical/*.rs belongs to " +
        "the library and to that test; clap_complete_nushell's tests/common.rs is " +
        "both a module of another test and a test target of its own. Both answers " +
        "are true, in different builds, and the reader gives both. rust-analyzer " +
        "files each source file under one crate and gives that one -- which is " +
        "also why it has no edge for src/lib.rs's own `mod lexical;`, a line " +
        "plainly there in the text. Nineteen of the twenty-nine inventions.",
      "`super` written inside an inline `#[cfg(test)] mod tests`. The reader takes " +
        "the language's rule: the enclosing module, which is that same file. The " +
        "referee reports it as the file in two places in this corpus and as the " +
        "file's parent in five others, so both signs of this disagreement are " +
        "present -- clap's five misses, and two of the inventions.",
      "Code behind a feature flag. `#[cfg(feature = \"pcre2\")] pub extern crate " +
        "grep_pcre2 as pcre2;` is a dependency under that feature and nothing " +
        "under the default build the referee indexes. Five of ripgrep's eight.",
      "A path inside a `macro_rules!` body. `$crate::util::setup(..)` is a real " +
        "dependency of the crate the macro is written in; the referee does not " +
        "resolve paths in a definition nobody has expanded. anyhow's one and two " +
        "of ripgrep's.",
    ],
    relations: {
      needs: {
        reproduce: "npm run measure:licence -- --only=rust",
        measured: "2026-08-22",
        referee: "the corpus above, and the referee named beside it",
        unit: "dependency edges",
        counts: "corpus",
      },
      takes: RUST_SIGNATURE,
      returns: RUST_SIGNATURE,
      holds: {
        reproduce: "npm run measure:holds",
        measured: "2026-09-02",
        referee: TEXT_SCAN("field list"),
        unit: "field asks",
        counts: { asked: 47, missed: 0, invented: 0 },
      },
      builds: {
        reproduce: "npm run measure:constructs",
        measured: "2026-09-02",
        referee: TEXT_SCAN("routine body"),
        unit: "construction asks",
        counts: { asked: 66, missed: 0, invented: 0 },
        note:
          "It refuses 81.8% of them, and 96% of the refusals are one generated " +
          "query module whose every routine is a macro. Safe and nearly useless " +
          "in that file; the bar this row is about is the zero misses.",
      },
      calls: {
        reproduce:
          "npm run measure:calls -- .corpus/ripgrep .corpus/anyhow rust-test ~/orangutan",
        measured: "2026-09-03",
        referee: CALL_SCAN,
        unit: "calls between routines the corpus declares exactly once",
        counts: { asked: 574, missed: 4, invented: 0 },
        known: [
          "anyhow declares `pub fn Ok`, and `Ok` is also the prelude variant. " +
          "`tests/test_ensure.rs` imports the variant and not the function, so " +
          "its three `Ok(..)` calls are the variant -- which the reader says, " +
          "and the referee, seeing one declaration of the name in the corpus, " +
          "asks about anyway.",
          "`trim_line_terminator` is declared twice in ripgrep's printer, once " +
          "as a free function and once as a method, and the referee credited " +
          "`util.rs`'s call to the method in `standard.rs`. The reader is right " +
          "that the call it can see is the local one.",
        ],
        note:
          "The default corpus asks Rust 36 questions, which is thin enough that " +
          "a zero in the miss column says very little. So this row is measured " +
          "over the two repositories the `needs` corpus above already pins -- " +
          "ripgrep and anyhow at their recorded commits -- and Rust is a " +
          "different language there: recall falls from 94.4% to 66.0%, and two " +
          "thirds of the refusals are `macro`. A refusal is not a miss. The four " +
          "misses were each read and the reader is right about all four -- they " +
          "are the referee asking about a name it cannot place, which is the " +
          "class #189 already recorded five of. `Ok` is anyhow\'s own " +
          "`pub fn Ok` and also the prelude variant, and `test_ensure.rs` " +
          "imports the one it does not mean; `trim_line_terminator` is declared " +
          "both as a free function and as a method, and the referee credited the " +
          "call to the wrong one. What the accusation rests on is the ACCUSED " +
          "and INVENTED columns, and both are zero across all 574. Reproducing " +
          "it needs the clones, which `measure:licence` makes in `.corpus/`.",
      },
    },
  },
  {
    language: "python",
    extensions: [".py"],
    measured: "2026-09-02",
    referee:
      "pyright, asked for `--dependencies --verbose`: the import graph a real " +
      "type checker resolved, printed file by file. It shares nothing with a " +
      "tree-sitter walk, needs no virtualenv, no installed dependencies and no " +
      "successful run of the code, and it answers the same way for a bare clone " +
      "as for a configured one -- which is what mypy could not promise, its " +
      "import resolution being sensitive to a config somebody wrote for their " +
      "own CI. A referee that has to be configured per repository is a second " +
      "opinion rather than a ground truth.",
    /*
     * Python is the language with the most to say here and, until this was
     * measured, the least right to say it: no reader at all, so `@needs` was
     * silent, `surveyScope` refused a Python scope outright, and #195 had just
     * had to mute an accusation `signature.ts` was making unmeasured.
     *
     * The corpus is chosen for the shapes that break readers rather than the
     * ones that flatter them, which #198 asked for and which the numbers then
     * justified: flask holds six small projects rooted below its own root,
     * httpx writes `from __future__ import annotations` throughout and
     * re-exports through wildcards, pydantic excludes 134 of its own files from
     * pyright and symlinks a test package into a sibling checkout, poetry is
     * src-layout, and django is 2,928 files with no `src` at all.
     *
     * Four reader bugs and two referee bugs came out of it, and not one was
     * reachable by thinking about it. The reader looked up an absolute import
     * only at the repository root, so every one of flask's example projects
     * lost its arrows; fixing that made it shadow the standard library, and
     * `import typing as t` beside `src/flask/typing.py` invented sixteen edges
     * in one line. The harness put the referee's paths through `realpath`,
     * which renamed a symlinked directory and manufactured 95 disagreements out
     * of edges the reader had right. And it read a file pyright had never bound
     * as a file with no imports, which turns a referee's silence into the
     * reader inventing everything.
     */
    corpus: [
      { name: "pallets/flask", url: "https://github.com/pallets/flask.git", commit: "d318b683471101618febed18996405ad26462110", files: 83, edges: 196, missed: 0, invented: 0 },
      { name: "encode/httpx", url: "https://github.com/encode/httpx.git", commit: "b5addb64f0161ff6bfe94c124ef76f6a1fba5254", files: 60, edges: 128, missed: 5, invented: 0 },
      { name: "python-poetry/poetry", url: "https://github.com/python-poetry/poetry.git", commit: "e33ce99067f6a28537aebd23caabc2c49aae5ed8", files: 445, edges: 1136, missed: 0, invented: 0 },
      { name: "pydantic/pydantic", url: "https://github.com/pydantic/pydantic.git", commit: "27f473c24ed63a475903d8289c84fb81987f04e9", files: 423, edges: 957, missed: 0, invented: 0, unmeasured: 134 },
      { name: "django/django", url: "https://github.com/django/django.git", commit: "05aec0a4aa111b54b50daec64059fd18ac70b437", files: 2928, edges: 10276, missed: 36, invented: 0 },
    ],
    known: [
      "A wildcard import from a package, followed through to the modules that " +
        "package re-exports from. `from django.db.models import *` sends pyright " +
        "to the twenty files `django/db/models/__init__.py` pulls its own names " +
        "out of; the reader stops at the package the text spells. Same call as " +
        "Rust's `pub use`, and for the same reason -- a board is drawn about the " +
        "text, and `django/contrib/gis/db/models/__init__.py` does not name " +
        "`aggregates` anywhere. All 41 misses in the corpus are this one shape, " +
        "36 of them django's and 5 httpx's.",
      "A file the project's own `[tool.pyright]` excludes. pydantic excludes " +
        "`pydantic/v1`, and those files still appear in the report listed as " +
        "importing nothing at all -- not zero imports, but never bound. They are " +
        "counted as unmeasured rather than netted off, which is 134 of pydantic's " +
        "557 files. The referee is deliberately left running under each " +
        "project's own configuration: overriding it would make this repository " +
        "the thing deciding what the referee looks at.",
      "The standard library list moves between Python versions. It is " +
        "`sys.stdlib_module_names` for one interpreter plus `__main__`, so a " +
        "repository vendoring a module some later Python deleted -- `distutils`, " +
        "`imp` -- would be read as the standard library's and lose the edge. " +
        "Nothing in this corpus does it, and pyright's typeshed has the same " +
        "shape of exposure.",
    ],
    relations: {
      needs: {
        reproduce: "npm run measure:licence -- --only=python",
        measured: "2026-09-02",
        referee: "the corpus above, and the referee named beside it",
        unit: "dependency edges",
        counts: "corpus",
      },
      takes: PYTHON_SIGNATURE,
      returns: PYTHON_SIGNATURE,
      holds: {
        reproduce: "npm run measure:holds",
        measured: "2026-09-02",
        referee: TEXT_SCAN("field list"),
        unit: "field asks",
        counts: { asked: 2177, missed: 0, invented: 0 },
        note:
          "It refuses 25.4% of them, every one a quoted annotation. A refusal " +
          "is not a miss, and the bar this row is about is the zero misses.",
      },
      builds: {
        unmeasured:
          "Python spells making one of something as an ordinary call, so the " +
          "referee has no pattern to count and the reader has no verdict to " +
          "give: `measure:constructs` asks it 0 times over 442 files. " +
          "`constructs.ts` withholds Python before any licence is consulted, so " +
          "nothing changes by saying so here -- but until #207 this square read " +
          "`yes`, on the strength of three measurements of other words.",
      },
      calls: {
        reproduce: "npm run measure:calls",
        measured: "2026-09-03",
        referee: CALL_SCAN,
        unit: "calls between routines the corpus declares exactly once",
        counts: { asked: 5525, missed: 0, invented: 0 },
        note:
          "83% of the whole population, at 92.9% recall over 683 files, which is " +
          "the right shape: Python is where the census says most calls are and " +
          "where a call is hardest to place statically. Two thirds of the 7.1% " +
          "refused are `unbound` and `unplaced` -- a name a wildcard import or a " +
          "module resolving to no file brought in -- and neither is a reader bug.",
      },
    },
  },
];

/** Totals across a licence's corpus. */
export function licenceTotals(licence: Licence): {
  files: number; edges: number; missed: number; invented: number; recall: number; precision: number;
} {
  let files = 0, edges = 0, missed = 0, invented = 0;
  for (const entry of licence.corpus) {
    files += entry.files;
    edges += entry.edges;
    missed += entry.missed;
    invented += entry.invented;
  }
  const agreed = edges - missed;
  return {
    files, edges, missed, invented,
    recall: edges === 0 ? 0 : agreed / edges,
    precision: agreed + invented === 0 ? 0 : agreed / (agreed + invented),
  };
}

/**
 * The licence covering a file, if any.
 *
 * A file whose extension no licence names is a file no verdict may be built on,
 * which is the same silence an unsupported language already gets everywhere
 * else in the engine. The direction check, the closure check, the ledger and
 * the arrow check all ask this rather than keeping a list of their own -- the
 * arrow check being the last to convert, which took until issue #131 and cost
 * a Rust board 14 of its 50 arrows in the meantime.
 *
 * It answers about the extension, which for Rust is only half the question:
 * `readerCanPlace` in `deps.ts` asks the other half.
 */
export function licenceFor(filePath: string): Licence | undefined {
  return LICENCES.find((licence) =>
    licence.extensions.some((extension) => filePath.endsWith(extension)),
  );
}

/** The licence covering a language, if any. */
function licenceOf(language: Language): Licence | undefined {
  /*
   * Answered by running the licence's own extensions back through `languageOf`
   * rather than by a second table of language-to-extension. That table is the
   * specialization layer #190 warns about -- two lists of the same fact drift,
   * and the one that drifts silently is the one nothing reads.
   */
  return LICENCES.find((licence) =>
    licence.extensions.some((extension) => languageOf(`x${extension}`) === language),
  );
}

/** What a word's reader was measured at in a language, if it was. */
export function relationLicence(
  relation: AccusingRelation,
  language: Language,
): RelationLicence | undefined {
  return licenceOf(language)?.relations[relation];
}

/**
 * The counts behind one row, with `needs` resolved to the corpus above.
 *
 * Undefined for a word with no measurement, which is the same answer
 * `mayAccuse` gives and for the same reason.
 */
export function relationTotals(
  relation: AccusingRelation,
  language: Language,
): { asked: number; missed: number; invented?: number } | undefined {
  const licence = licenceOf(language);
  const row = licence?.relations[relation];
  if (!licence || !row || !isMeasured(row)) return undefined;
  if (row.counts !== "corpus") return row.counts;
  const totals = licenceTotals(licence);
  return { asked: totals.edges, missed: totals.missed, invented: totals.invented };
}

/**
 * Whether **this word's reader** has earned the right to say **wrong** in this
 * language.
 *
 * The question used to be asked of the language alone, and for two words and
 * two languages that was the same question. It stopped being one at #198: a
 * single Python entry came to speak for four words on the strength of three
 * unrelated measurements -- pyright for the imports, a text scan for the field
 * lists, another for the signatures -- and nothing in the type said which. The
 * fifth word would have accused in Python on the strength of somebody else's
 * measurement of something else, silently. That is #195 again with a different
 * reader, and #195 is the reason this file exists.
 *
 * ## An unlisted pair is a compile error, and also a silent no
 *
 * Decided at #207, and it is both rather than either. `relations` is an
 * exhaustive `Record`, so a word that no licence has an answer for does not
 * build -- the hole cannot be left, only filled in with `unmeasured`. And this
 * function still answers `false` for anything it does not find, because a
 * compile error only catches the person adding the word. The type is the part
 * that makes the hole impossible; the `false` is the part that makes it safe if
 * the type is ever routed around.
 *
 * The alternative -- default to `true` and list the exceptions -- was never
 * live. A grid whose blank square means "may accuse" is the bug it is meant to
 * prevent, wearing a table.
 *
 * `covers` is the same rule inside an entry. A licence names several extensions
 * and a run may not have asked about all of them, so a row that was measured on
 * TypeScript and TSX says so, and JavaScript gets the same `false` an unlisted
 * word gets. Found while filling this grid in: JavaScript had three squares
 * saying yes on TypeScript's numbers.
 *
 * ## What it gates, which has not changed
 *
 * The answer only ever gates an **absence**. Confirming needs no licence:
 * finding a name is evidence the name is there whoever does the reading, and it
 * is the same evidence a measured reader would have found. Absence is the claim
 * about the whole of something, and it is the one that turns a reader's
 * blindness into somebody else's wrong diagram. Every caller asks at its last
 * gate, so losing a licence costs the accusation and nothing else.
 *
 * `closed` and `complete` are not here. They accuse from an absence too, and
 * they read the imports -- the same reader `needs` uses and the corpus above
 * measures -- so they ask `licenceFor` about a path, which is that same
 * question in the form they can put it.
 */
export function mayAccuse(relation: AccusingRelation, language: Language): boolean {
  const row = relationLicence(relation, language);
  if (row === undefined || !isMeasured(row)) return false;
  return row.covers === undefined || row.covers.includes(language);
}
