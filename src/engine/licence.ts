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
export type AccusingRelation = Exclude<ArrowClaim, "feeds"> | AccusingBoxClaim;

/**
 * A **box** word that may say wrong on its own reader, which is one of the two.
 *
 * `closed` is not here and that is not an omission. It reads the imports -- the
 * same reader `@needs` uses, measured by the same corpus -- so it asks
 * `licenceFor` about a *path*, which is that question in the form it can put
 * it. `handles` reads a dispatch, which nothing else here reads, so it needs a
 * row of its own or it would be accusing on a measurement of something else.
 * That is #195's mistake exactly: a reader shipping an accusation it inherited.
 *
 * Written as a list of one rather than derived from `BOX_CLAIMS`, because the
 * decision about `closed` is a decision and the next box word deserves the same
 * one rather than a default. Adding a third box word does not silently grant it
 * anything; forgetting to decide about it is what this shape prevents.
 */
export type AccusingBoxClaim = "handles";

/**
 * The same list at runtime, filtered from `ARROW_CLAIMS` rather than typed out.
 *
 * Complete by construction, so a report that walks it cannot quietly stop
 * mentioning a word.
 */
export const ACCUSING_RELATIONS: readonly AccusingRelation[] = [
  ...ARROW_CLAIMS.filter((word): word is Exclude<ArrowClaim, "feeds"> => word !== "feeds"),
  "handles",
];

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

/**
 * A word this language may not accuse with, and why.
 *
 * Usually because nobody has run the numbers. Not always: `conforms` in Rust is
 * measured at 4,975 asks and still sits here, because what a Rust type
 * implements is not written on the type and no measurement of any reader changes
 * that. So the reason may cite a measurement -- what it may not do is leave the
 * `no` unexplained, which is the whole point of the field.
 */
export interface RelationUnmeasured {
  /** Printed where a number would be, because "no" without a reason is a shrug. */
  unmeasured: string;
}

export type RelationLicence = RelationMeasured | RelationUnmeasured;

/** Whether a row is a measurement rather than a stated absence of one. */
export function isMeasured(row: RelationLicence): row is RelationMeasured {
  return !("unmeasured" in row);
}

/**
 * Which kind of absence a word's accusation rests on (#231).
 *
 * `presence` is every accusation this grid answered before #231: the reader
 * found something -- a name, a call running the other way -- and drew a
 * verdict from what it found. `absence` is a newly-possible second kind,
 * where a reader can enumerate everything a piece of code could mean and
 * say "not among them" as a fact rather than a guess.
 *
 * They are measured separately because they rest on different readers
 * earning different rights. `@calls`' presence licence rests on a text scan
 * finding a call running the other way (`calls.ts`'s `backwards` verdict);
 * its absence licence rests on a real compiler closing a body's entire call
 * set (docs/claim-vocabulary.md items 12-14, `measure:closed-bodies`). A
 * licence for one says nothing about the other, which is why this is an
 * axis rather than a flag beside the existing one.
 */
export type AccusalAxis = "presence" | "absence";

/**
 * What one word may accuse with, on one axis, in one language.
 *
 * Exhaustive over both fields for the same reason `relations` below is
 * exhaustive over every word: a hole here is the hole #207 already closed,
 * reopened one axis over. Most words have no absence-based reader yet, and
 * `absence` says so with `NOT_DESIGNED_YET` rather than by being missing --
 * "unmeasured is an answer, blank is not" is `RelationUnmeasured`'s rule,
 * carried up one level.
 */
export interface AccusalLicence {
  presence: RelationLicence;
  absence: RelationLicence;
}

/**
 * The answer for every word that has no absence-based reader yet.
 *
 * `@calls` is the only word #231 gave one to: a tier-2 receiver resolver
 * that can close a whole body's call set (docs/claim-vocabulary.md items
 * 12-14). No other word has an analogous closed-region reader, so this is
 * the honest answer until one is built -- not a placeholder standing in for
 * a "yes" nobody has checked.
 */
/**
 * The referee for `handles`, which is a text scan but not one of the others.
 *
 * It reads case labels, which means it is the one scan here that must **not**
 * blank strings -- `case "GET":` is the thing being read. Named separately for
 * that reason rather than folded into `TEXT_SCAN`: a square that says yes has
 * to name the thing that earned it, and this earned a different thing.
 */
const DISPATCH_SCAN =
  "a line-based text scan of the same files that reads `case X:` and `X =>` " +
  "with no grammar at all (scripts/lib/dispatch-scan.ts). It shares no " +
  "tree-sitter query with the reader, and unlike every other scan here it " +
  "keeps string literals, because a case label is one.";

/**
 * Why `handles` says no outside TypeScript, and it is the referee rather than
 * the reader.
 *
 * Stated once and shared, because the reason is the same in all four and it is
 * a reason about the *measurement*: the scan is line-based, so it cannot see a
 * Rust arm `rustfmt` broke across lines, it counts a `macro_rules!` arm as a
 * case, and it reads a `switch` written inside a template literal in a test
 * fixture as code. Every disagreement was read and almost all of them are
 * those three shapes -- but item 18 settled that this is not enough: agreement
 * is not evidence once a check is known not to discriminate, so the squares
 * stay no until a referee that can tell them apart exists.
 *
 * For Rust the thing that would change it is named: `rustc`'s own
 * non-exhaustive-match error lists the missing variants, which is a genuinely
 * independent oracle for a case set. #237 found this machine's rustc too old
 * for ripgrep's crates, so it is a real piece of work rather than a flag.
 */
const DISPATCH_SCAN_TOO_CRUDE = (detail: string): RelationUnmeasured => ({
  unmeasured:
    "Measured and not licensed. " + detail + " The referee " +
    "(scripts/lib/dispatch-scan.ts) is line-based and has three known blind " +
    "spots -- a Rust arm broken across lines, a `macro_rules!` arm, and a " +
    "`switch` inside a template literal in a test fixture -- so a disagreement " +
    "here is at least as likely to be the referee's. Reading them one by one " +
    "says exactly that, and item 18 settled that reading the flagged cases is " +
    "not enough to license on. rustc's own non-exhaustive-match error is the " +
    "independent oracle that would settle Rust; nothing equivalent is wired in " +
    "for Python. `npm run measure:handles` reproduces every number.",
});

const NOT_DESIGNED_YET: RelationUnmeasured = {
  unmeasured:
    "No absence-based accusation is designed for this word yet. #231 gave " +
    "the licence grid a second axis for @calls, whose tier-2 receiver " +
    "resolver can close a body's entire call set (docs/claim-vocabulary.md " +
    "items 12-14); no other word has an analogous closed-region reader.",
};

/**
 * `@calls`' absence licence outside TypeScript/TSX, and now Python (#242).
 *
 * #230 built the closed-body resolver against `tsc` alone; rust has no
 * compiler-backed receiver resolver wired in for this, so this axis stays
 * unmeasured for it by an explicit scope decision (#231), not oversight.
 * Python had the same gap until #235 measured pyright over its own
 * language-server protocol (docs/claim-vocabulary.md item 17) and #242 gave
 * it a real entry below.
 */
const NO_CLOSED_BODY_RESOLVER: RelationUnmeasured = {
  unmeasured:
    "#230 measured the closed-body resolver for ts/tsx/js only, using " +
    "`tsc` as the receiver resolver. Rust has no compiler-backed resolver " +
    "wired in for this, so this axis is unmeasured for it by scope decision, " +
    "not oversight (#231, docs/claim-vocabulary.md items 12-14).",
};

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
   * see the header of `mayAccuse`. #231 added `AccusalLicence`'s second axis
   * on top of the same guarantee: a word with no absence-based reader still
   * needs an explicit `unmeasured` rather than a missing field.
   */
  relations: Record<AccusingRelation, AccusalLicence>;
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
/**
 * The referee for `conforms`, which reads headers and never a body.
 *
 * Its own name rather than `TEXT_SCAN("base list")` because it is a different
 * shape of referee, and a reader comparing squares should be able to see that: a
 * declaration header is one line of text, so there is no class body to scope, no
 * indentation to track and no docstring to blank out -- which is where every
 * other scan in this file spends its complexity and where two of them found
 * their own bugs.
 */
const HEADER_SCAN =
  "a text scan of the declaration headers in the same source, run over the same "
  + "trees. It shares no tree-sitter query with the reader, so agreeing means two "
  + "unrelated readings agree rather than one reading agreeing with itself. It "
  + "reads headers only: a base list written on one line, or the referee does not "
  + "offer the pair at all -- a smaller sample, never a wrong one.";

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
 * The referee for `accesses`, which is a text scan like the three above and asks
 * a different question of it: not what a member's type is but what the member is
 * called, and separately what a body reads. Named apart for the reason
 * `CALL_SCAN` is -- a square that says yes has to name the thing that earned it,
 * and these are not the same thing.
 */
const MEMBER_SCAN =
  "a text scan of the same source that reads a type's declared member names off "
  + "its header and the lines under it, and separately reads the `.name` tokens "
  + "inside each routine. It shares no tree-sitter query with the reader. Only "
  + "the type end is counted here, because only the type end can accuse.";

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

/**
 * The referee for `@accesses`' routine-end absence (#255).
 *
 * The same text scan as `MEMBER_SCAN`, asked a different question: for every
 * member read somewhere in a file, and every named routine in it with no read
 * lacking a `.name` that reads nothing by that name, does a `.member` appear
 * inside the routine's lines anyway? It cannot say what `.member` is read off,
 * so it disputes more than it should -- and every dispute is read.
 */
const ACCESS_ABSENCE_SCAN =
  "a text scan (`scripts/lib/access-scan.ts`) sharing no tree-sitter query and no " +
  "type checker with the reader, looking for `.member` inside the routine's own " +
  "lines. It cannot tell whose `.member` it is, so it over-disputes, and every " +
  "dispute is read by hand before a row may carry it.";

const ACCESS_ABSENCE_UNIT =
  "asks: a member read somewhere in the same file, against a named routine with " +
  "no unnamed read that reads nothing by that name";

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
        presence: {
          reproduce: "npm run measure:licence -- --only=typescript",
          measured: "2026-08-21",
          referee: "the corpus above, and the referee named beside it",
          unit: "dependency edges",
          counts: "corpus",
        },
        absence: NOT_DESIGNED_YET,
      },
      takes: { presence: TYPESCRIPT_SIGNATURE, absence: NOT_DESIGNED_YET },
      returns: { presence: TYPESCRIPT_SIGNATURE, absence: NOT_DESIGNED_YET },
      holds: {
        presence: {
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
        absence: NOT_DESIGNED_YET,
      },
      builds: {
        presence: {
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
        absence: NOT_DESIGNED_YET,
      },
      calls: {
        presence: {
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
            "JavaScript `holds`, so this `covers` is the only thing withholding it. " +
            "**#254 widened the population this speaks for**: the receiver calls " +
            "the text scan above cannot place are now put to `tsc` and scored, " +
            "463 in ts/tsx -- 34 of them real calls to the target, 426 " +
            "provably landing elsewhere -- at 0 missed and 0 accused. What it " +
            "found was a " +
            "reader bug on the other side of the ledger: `resolves` read a " +
            "receiver call as this file's own whenever the file declared the " +
            "method's name itself -- `seen.add(file)` on a `Set` credited to a " +
            "local `add` -- which two boxes anchored at one file turned into a " +
            "`calls-backwards` red on correct code. Fixed by asking `through` " +
            "before same-file, the order `placeOf` already used; found by a " +
            "real compiler rather than by review " +
            "(docs/claim-vocabulary.md item 24).",
        },
        /*
         * The new axis (#231). `presence` above rests on finding a call
         * running the other way; this rests on a tier-2 compiler resolver
         * closing a body's entire call set, so "not among them" is a fact
         * rather than a blind spot (docs/claim-vocabulary.md items 12-14).
         */
        absence: {
          reproduce: "npm run measure:closed-bodies",
          measured: "2026-09-08",
          referee:
            "a second question put to the same compiler, at the call's own " +
            "method position rather than its receiver's -- `getSymbolAtLocation` " +
            "on `foo` in `x.foo()`, the question a real \"go to definition\" " +
            "asks -- compared against where `placeOf` already said the call " +
            "landed. It shares the compiler with the reader, so agreeing does " +
            "not mean two unrelated readings agree; it means a more specific " +
            "question of the same source of truth did not disagree with the " +
            "reader's plumbing.",
          unit: "placed calls checked against the method's own declaration",
          counts: { asked: 8964, missed: 62 },
          covers: ["ts", "tsx"],
          note:
            "0.7% wrong (62 of 8,964) -- ts alone 0.1% (8 of 7,423), tsx 3.5% " +
            "(54 of 1,541) -- below the 1.1-2.0% this repo already shipped a " +
            "word on (item 12's tier-1 resolver). Item 13's closed share, once " +
            "both fixes this check found were applied, is 49.6% of ts/tsx/js " +
            "bodies that call anything (10.3% at tier 1 alone) -- a more honest " +
            "number than item 13's headline 50.3%, not a different finding. " +
            "`js` is excluded from `covers`: `checkJs` is off, so tier 2 " +
            "resolves almost nothing there, and it is out of scope by decision " +
            "rather than left for later (#231).",
          known: [
            "A receiver whose declared type is an interface or a generic " +
              "wrapper, where the concrete implementation is decided by " +
              "something the type system itself cannot see, agrees with the " +
              "reader's mistake rather than catching it -- this referee asks " +
              "the same compiler the reader does, so the two share the one " +
              "limitation neither can see past. Concentrated almost entirely " +
              "in one third-party menu library's generic store pattern in one " +
              "test tree, not spread across the corpus. A floor on how wrong " +
              "this is, not a ceiling on how right.",
          ],
        },
      },
      accesses: {
        presence: {
          reproduce: "npm run measure:accesses",
          measured: "2026-09-11",
          referee: MEMBER_SCAN,
          unit: "member asks at the type end",
          counts: { asked: 5460, missed: 0, invented: 0 },
          covers: ["ts", "tsx"],
          note:
            "5,102 of them TypeScript and 358 TSX, and the count is of the **type** " +
            "end only -- the end that can accuse. TypeScript refuses 1.8% of its " +
            "asks, every one of them a type with an index signature, which is a " +
            "member list that answers to any name at all. TSX refuses none. " +
            "JavaScript is inside this licence and was asked **0 questions**: it " +
            "writes no member list a text scan can find, so `covers` withholds it " +
            "-- the same square #211 shipped a `yes` in. " +
            "Re-measured at #222. Two of the seven trees had silently stopped " +
            "being read -- `find` overflowed its buffer and a blanket `catch` " +
            "reported no files -- so the row above had been measured on a corpus " +
            "the command could no longer reach: 1,232 asks where this row says " +
            "5,833. With the walk fixed the referee change itself is worth +30 " +
            "TypeScript asks; the rest of the movement from 4,823 is the trees. " +
            "The two accusations that had appeared since -- both an inline object " +
            "type in a one-line `interface` -- are back to zero. " +
            "Re-run on today's main when #222's commit was recovered (#264): TSX, " +
            "Rust and Python reproduce to the ask, and TypeScript is 5,004 -> " +
            "5,102. This repository's own `src` and `scripts` are two of the seven " +
            "trees and grew by 5 files across #261, #262 and #263, worth +102 on " +
            "their own; the corpus is 4 asks lower elsewhere because three of the " +
            "remaining trees are live checkouts rather than pinned clones.",
        },
        absence: {
          reproduce: "npm run measure:accesses-absence -- --no-tier2 .corpus/*",
          measured: "2026-09-11",
          referee: ACCESS_ABSENCE_SCAN,
          unit: ACCESS_ABSENCE_UNIT,
          counts: { asked: 464730, missed: 0 },
          covers: ["ts", "tsx", "js"],
          note:
            "293,709 TypeScript, 164,956 TSX and 6,065 JavaScript asks over " +
            "excalidraw, TanStack Query, nest, vite and vue at their pinned " +
            "commits, none disputed. Over this repository and #255's local " +
            "trees, 55,543 more and one dispute, which was the referee: " +
            "`dash: ReturnType<typeof useDesktopStore.getState>` is a type " +
            "annotation it read as a member read. Made by name rather than by " +
            "type, and the typed alternative is recorded as not licensed: in " +
            "TypeScript a read off `Partial<Config>` is placed in `lib.es5.d.ts`, " +
            "and there is no second checker to measure placement against (#260). " +
            "docs/claim-vocabulary.md item 25.",
        },
      },
      handles: {
        presence: {
          reproduce: "npm run measure:handles",
          measured: "2026-09-11",
          referee: DISPATCH_SCAN,
          unit: "case labels in a dispatch",
          counts: { asked: 1099, missed: 7, invented: 0 },
          covers: ["ts"],
          note:
            "176 dispatches and 1,099 case labels over 3,918 TypeScript files, " +
            "against 1,106 from the scan: **0 invented and 7 missed (0.64%)**. " +
            "Zero in the invented column is the half that matters here, because " +
            "an invented case is the one that tells somebody their picture is " +
            "short of a case their code does not have -- a false red. Both " +
            "halves of @handles accuse, so unlike @calls there is no direction " +
            "that is merely quiet, and the missed column is the other false " +
            "red: it would say a routine has no arm for something it handles. " +
            "Every one of the 7 is named in `known` and every one is the " +
            "referee's. " +
            "`covers` withholds **tsx** and **js** rather than letting them " +
            "inherit this row, which is #207's whole lesson: tsx disagrees on 5 " +
            "of 40 labels, and js agrees on all 27 but 27 asks over 1,119 files " +
            "is the same thin evidence Rust's @calls square was refused for. " +
            "The chain half of the word -- an if/elif ladder -- is refused by " +
            "`checkHandles` in every language including this one, because a " +
            "single `if (x === undefined)` is indistinguishable from a chain " +
            "link to any referee that does not redo the reader's own work.",
          known: [
            "A `switch` written inside a template literal in a test fixture. " +
              "The referee has to keep string literals -- a case label is one " +
              "-- so it reads code-in-a-string as code, and the reader " +
              "correctly does not. All 7 misses are this: six `case 1:` inside " +
              "an inline snapshot in vite's ssrTransform.spec.ts, and one " +
              "`case true:` inside a compile fixture in vue's " +
              "transformExpressions.spec.ts. Both are the referee counting a " +
              "dispatch that is not code in that file.",
          ],
        },
        absence: NOT_DESIGNED_YET,
      },
      conforms: {
        presence: {
          reproduce: "npm run measure:conforms",
          measured: "2026-09-06",
          referee: HEADER_SCAN,
          unit: "base asks",
          counts: { asked: 376, missed: 0, invented: 0 },
          covers: ["ts", "tsx"],
          note:
            "213 TypeScript and 163 TSX, refusing none of them, and every one of " +
            "the 163 is `interface X extends Y` -- there is not one class heritage " +
            "clause in any .tsx file in the corpus. JavaScript is inside this " +
            "licence and was asked **0 questions**, so `covers` withholds it, the " +
            "same square #211 shipped a `yes` in. Asked the 122 readable pairs " +
            "backwards, it confirmed **0**, which is the number the word exists " +
            "for. The run found one reader bug before it could report any of this: " +
            "TypeScript hangs a class's type arguments off the clause as a sibling " +
            "of the base name, and with no rule for that node every declaration " +
            "carrying them held a doubt that silences absences -- a word that " +
            "would have shipped and never fired on `class A extends B<C>`, " +
            "invisible from the confirming side.",
        },
        absence: NOT_DESIGNED_YET,
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
        presence: {
          reproduce: "npm run measure:licence -- --only=rust",
          measured: "2026-08-22",
          referee: "the corpus above, and the referee named beside it",
          unit: "dependency edges",
          counts: "corpus",
        },
        absence: NOT_DESIGNED_YET,
      },
      takes: { presence: RUST_SIGNATURE, absence: NOT_DESIGNED_YET },
      returns: { presence: RUST_SIGNATURE, absence: NOT_DESIGNED_YET },
      holds: {
        presence: {
          reproduce: "npm run measure:holds",
          measured: "2026-09-02",
          referee: TEXT_SCAN("field list"),
          unit: "field asks",
          counts: { asked: 47, missed: 0, invented: 0 },
        },
        absence: NOT_DESIGNED_YET,
      },
      builds: {
        presence: {
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
        absence: NOT_DESIGNED_YET,
      },
      calls: {
        presence: {
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
            "it needs the clones, which `measure:licence` makes in `.corpus/`. " +
            "**#254 adds the receiver calls this corpus left out, and they are " +
            "the bulk of it**: 2,221 more, 1,381 of which rust-analyzer says are " +
            "genuinely to the target, at 0 missed, 0 accused and 0 invented. The " +
            "reader confirms 25.3% of them -- `receiver` is nearly all of what it " +
            "withholds -- so the population grows from 574 to 1,955 and the " +
            "recall over it falls to 37.3%. A refusal is silence, not a red " +
            "(docs/claim-vocabulary.md item 24).",
        },
        absence: NO_CLOSED_BODY_RESOLVER,
      },
      accesses: {
        presence: {
          reproduce: "npm run measure:accesses",
          measured: "2026-09-11",
          referee: MEMBER_SCAN,
          unit: "member asks at the type end",
          counts: { asked: 350, missed: 0, invented: 0 },
          note:
            "Refuses none of them, which is the one language where the member list " +
            "really is a declaration: a struct has no parent to inherit from and no " +
            "index signature. What Rust costs instead is at the other end, which " +
            "never accuses -- the confirming half reads 89.3% of the accesses the " +
            "referee sees, the lowest of the five by a distance, because " +
            "`format!(\"{}\", self.status)` and `log_line!(.., sock.peer_addr())` " +
            "put the access inside a macro and a macro's arguments are an unparsed " +
            "token tree. That is a confirmation nobody gets, never a red. " +
            "#222 cleared the referee's own bugs out of all five languages and this " +
            "figure barely moved -- 89.2% to 89.3% on one corpus, against 87.3% " +
            "recorded here on another -- which is the finding rather than a " +
            "disappointment: every other language went to 99.8% or better, and 110 " +
            "of the 116 misses left in the whole corpus are Rust, 83 of them one " +
            "generated file whose every body reads its fields inside a macro.",
        },
        absence: {
          reproduce: "npm run measure:accesses-absence -- --no-tier2 .corpus/*",
          measured: "2026-09-11",
          referee: ACCESS_ABSENCE_SCAN,
          unit: ACCESS_ABSENCE_UNIT,
          counts: { asked: 114273, missed: 0 },
          note:
            "Over ripgrep and anyhow at their pinned commits, none disputed; " +
            "1,372 more over rust-test, orangutan, infrarouter and mundane's " +
            "graph app, none disputed -- a zero over the local trees alone would " +
            "be the too-small zero #209 warns about, which is why the clones. A " +
            "body with a macro in it is never asked: a macro's arguments are an " +
            "unparsed token tree, and 23 of the first 24 reads this reader could " +
            "not see were inside `log_line!`, `assert_eq!` and `json!`.",
        },
      },
      handles: {
        presence: DISPATCH_SCAN_TOO_CRUDE(
          "1,042 dispatches and 2,959 case labels over 290 Rust files -- the " +
          "largest population of any language here by a factor of three -- " +
          "against 3,021 from the scan: 105 invented (3.55%) and 167 missed " +
          "(5.56%), both outside the band. Rust is where #206 expected this " +
          "word to be strongest and it is the square that fails, which is the " +
          "opposite of the issue's prediction -- and the reason is the referee " +
          "rather than the reader, which is exactly why it cannot be licensed " +
          "on a reading of the disagreements.",
        ),
        absence: NOT_DESIGNED_YET,
      },
      conforms: {
        /*
         * Measured, and still a no. The only row in this file where those two
         * things are compatible, and the reason the grid needs a language axis
         * at all rather than just a word axis.
         *
         * `npm run measure:conforms -- <the five pinned clones>` asks this
         * reader **4,975** questions over 775 Rust files: 92.9% recall, 0
         * wrongly accused, 0 invented, and 0 confirmations when the same pairs
         * are asked backwards. On any other row those numbers would be a
         * licence.
         */
        presence: {
          unmeasured:
            "Not a licence question, and the measurement says so rather than " +
            "being absent. 4,975 asks over the five pinned Rust clones, 92.9% " +
            "recall, 0 accused and 0 invented -- and Rust still may not accuse, " +
            "because a Rust type does not carry what it implements. Three " +
            "separate places do: `impl Trait for Type`, which is a free-standing " +
            "item that may sit in any file in the crate; `#[derive(..)]`, which " +
            "is on the declaration; and a `macro_rules!` body, which is an " +
            "unparsed token tree and is where anyhow keeps some of its own. " +
            "Refuting needs all three to be complete and the third cannot be " +
            "read, so an absence is a fact about where somebody looked. " +
            "`conforms.ts` says that as `region-is-the-crate` rather than " +
            "leaving it to this row, because \"nobody measured it\" and \"the " +
            "fact is not in front of us\" are different sentences. " +
            "The derive half is the finding that widening the corpus bought: " +
            "3,741 derived conformances against 1,401 written trait impls, so " +
            "**most of this relation in Rust is a derive list**, and the first " +
            "reader could see none of it. Reading it took Rust's recall from " +
            "86.8% to 92.9%, all of it confirmations. What is left is 3.5% an " +
            "impl in a file that does not declare the type, 3.3% a file the " +
            "grammar cannot finish -- 164 of those 165 are three clap test files " +
            "using `str![[r#\"..\"#]]` -- and 13 types with no impl and no derive " +
            "beside them. A `trait Foo: Bar` does write its supertraits on the " +
            "declaration and that one shape is closed, which is a measurement " +
            "away rather than a reader away; it is 42 facts in the whole census " +
            "against 2,877 that are not, and a per-shape axis is not worth " +
            "buying for that.",
        },
        absence: NOT_DESIGNED_YET,
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
      handles: {
        presence: DISPATCH_SCAN_TOO_CRUDE(
          "9 dispatches and 26 case labels over 3,957 Python files, against 26 "
          + "from the scan: 6 invented and 6 missed. The sample is the finding "
          + "rather than the percentage -- `match` arrived in 3.10 and this "
          + "corpus barely uses it, so 26 asks is the same thin evidence Rust's "
          + "@calls square was refused for, and four of the disagreements are "
          + "one test file that writes a `match` inside a string.",
        ),
        absence: NOT_DESIGNED_YET,
      },
      needs: {
        presence: {
          reproduce: "npm run measure:licence -- --only=python",
          measured: "2026-09-02",
          referee: "the corpus above, and the referee named beside it",
          unit: "dependency edges",
          counts: "corpus",
        },
        absence: NOT_DESIGNED_YET,
      },
      takes: { presence: PYTHON_SIGNATURE, absence: NOT_DESIGNED_YET },
      returns: { presence: PYTHON_SIGNATURE, absence: NOT_DESIGNED_YET },
      holds: {
        presence: {
          reproduce: "npm run measure:holds",
          measured: "2026-09-02",
          referee: TEXT_SCAN("field list"),
          unit: "field asks",
          counts: { asked: 2177, missed: 0, invented: 0 },
          note:
            "It refuses 25.4% of them, every one a quoted annotation. A refusal " +
            "is not a miss, and the bar this row is about is the zero misses.",
        },
        absence: NOT_DESIGNED_YET,
      },
      builds: {
        presence: {
          unmeasured:
            "Python spells making one of something as an ordinary call, so the " +
            "referee has no pattern to count and the reader has no verdict to " +
            "give: `measure:constructs` asks it 0 times over 442 files. " +
            "`constructs.ts` withholds Python before any licence is consulted, so " +
            "nothing changes by saying so here -- but until #207 this square read " +
            "`yes`, on the strength of three measurements of other words.",
        },
        absence: NOT_DESIGNED_YET,
      },
      calls: {
        presence: {
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
            "module resolving to no file brought in -- and neither is a reader bug. " +
            "**#254 put a real checker behind that sentence and it is stronger " +
            "than it reads**: 374 of the 391 refusals are the referee asking " +
            "about a builtin the corpus happens to declare too (`set()`, " +
            "`patch(..)`), so over bare calls pyright says are genuinely to the " +
            "target the recall is 99.9% (5,075 of 5,082). The same run scores " +
            "the 1,494 receiver calls this population left out: 876 real, 0 " +
            "missed, 0 accused, 0 invented (docs/claim-vocabulary.md item 24).",
        },
        /*
         * The new axis (#231), Python's version. #235 measured whether
         * pyright can answer the same two questions `resolution-ts.ts` asks
         * `tsc` -- where a receiver's type is declared, and where the method
         * actually called is declared -- over its own language-server
         * protocol rather than its compiler API. The first reading, 89.6%
         * answered / 2.8% wrong, did not clear the bar and #236 closed on it;
         * a real anchoring bug (`typeDeclarationAt` was asking about the
         * first token of `self.cache` or `self._make().step()`, i.e. `self`,
         * not the field or the chain) turned out to be findable and fixable,
         * and the corrected reading below is the one #236 reopened on
         * (docs/claim-vocabulary.md item 17).
         */
        absence: {
          reproduce: "npm run measure:resolution -- ~/board-ai/graphify ~/infrarouter",
          measured: "2026-09-10",
          referee:
            "pyright, asked over its own language-server protocol rather than " +
            "its compiler API: `textDocument/typeDefinition` on a receiver's " +
            "own anchor for where its declared type lives, and " +
            "`textDocument/definition` on the method name for where the " +
            "method actually called is declared -- confirmed against a live " +
            "server before either was trusted, not assumed from pyright's " +
            "docs. It shares nothing with the reader's own tree-sitter walk, " +
            "so agreeing means two unrelated readings agree rather than one " +
            "reading agreeing with itself.",
          unit: "receivers checked two ways: the receiver's declared type against the method actually called",
          counts: { asked: 12906, missed: 45 },
          note:
            "0.35% disagreeing (45 of 12,906), restated at #259 from 1.76% " +
            "(249 of 14,134): 204 of those disagreements were the client " +
            "recording a line that declares no type -- where pyright's type " +
            "was Unknown it answered with the receiver's own binding, and " +
            "where the anchor was a callee's name, with the callee's `def`. " +
            "Those answers are withheld now, so 55.5% of every receiver gets " +
            "a declaring file (13,113 of 23,621), down from 84.9%. An earlier " +
            "anchoring bug (#235) had pushed the first reading to 2.8% by " +
            "asking about `self` instead of the field or chained call. " +
            "Measured across `graphify` (22,449 receiver sites) and " +
            "`infrarouter` (1,172); `~/mundane` is left out because its own " +
            "TypeScript analysis makes a same-session run impractical, not " +
            "because of anything in this check (docs/claim-vocabulary.md " +
            "items 17 and 22).",
          known: [
            "A module used as a receiver whose module re-exports the function " +
              "from another file -- `graphify/__main__.py` against " +
              "`install.py` -- so the type answer names the module and the " +
              "method answer names where the function is written. All 45 " +
              "remaining disagreements are module receivers by mypy's reading, " +
              "and both answers are right.",
            "A receiver ending in a call -- a factory, a fluent builder -- " +
              "where `typeAnchorFor` anchors on the callee's name and pyright " +
              "answers with the callee's own `def` rather than the type it " +
              "returns. Withheld since #259, so these are unanswered rather " +
              "than wrong; what a call returns is a separate question no " +
              "request here asks.",
          ],
        },
      },
      accesses: {
        presence: {
          reproduce: "npm run measure:accesses",
          measured: "2026-09-11",
          referee: MEMBER_SCAN,
          unit: "member asks at the type end",
          counts: { asked: 356, missed: 0, invented: 0 },
          note:
            "The smallest population on this row and the reason is the design " +
            "working: a Python class with a base class has no closed member list, " +
            "so the reader withholds and the referee does not offer it. Nearly " +
            "every Python class in the corpus has one. What is left is the classes " +
            "that declare their own members outright, and the reader reads 100% of " +
            "them -- including the attributes `__init__` assigns to `self`, which " +
            "is where most Python attributes are and which a reader stopping at " +
            "the class body would refute every one of.",
        },
        absence: {
          reproduce: "npm run measure:accesses-absence -- --no-tier2 .corpus/*",
          measured: "2026-09-11",
          referee: ACCESS_ABSENCE_SCAN,
          unit: ACCESS_ABSENCE_UNIT,
          counts: { asked: 1932538, missed: 14 },
          note:
            "Over django, flask, httpx, pydantic and poetry at their pinned " +
            "commits; 48,311 more over graphify, infrarouter and mundane's Python " +
            "package, none disputed once a keyword argument stopped naming the " +
            "lambda passed by it (`rows.sort(key=lambda r: ..)` had been a " +
            "routine called `key`). `getattr` and `vars` count as a read without " +
            "a name, like `c[k]`.",
          known: [
            "A parameter annotation on a signature spread over several lines -- " +
              "`schema: core_schema.CoreSchema`, `tz: datetime.tzinfo`, " +
              "`list[metadata.PathDistribution]` -- which the text scan reads as a " +
              "member read inside the routine and the reader rightly does not: " +
              "an annotation reads nothing. All 14, in pydantic and poetry, each " +
              "read against the source.",
          ],
        },
      },
      conforms: {
        presence: {
          reproduce: "npm run measure:conforms",
          measured: "2026-09-06",
          referee: HEADER_SCAN,
          unit: "base asks",
          counts: { asked: 2276, missed: 0, invented: 0 },
          note:
            "The largest population of this relation anywhere -- 2,276 asks over " +
            "442 files, 78% of every `conforms` fact in the corpus -- and it " +
            "refuses none of them. A base list sits in the declaration in the one " +
            "language `holds` and `accesses` both had to withhold most of, which " +
            "is worth saying plainly: what stops those two is a class body, and " +
            "this word never reads one. Asked its 7 readable pairs backwards it " +
            "confirmed 0. Only 7 because a Python base is nearly always imported, " +
            "so the far end is not in the same file -- the reverse question is " +
            "answered from the board's other end instead, which `drift.ts` has and " +
            "a single-file run does not.",
        },
        absence: NOT_DESIGNED_YET,
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

/**
 * What a word's reader was measured at in a language, on one axis, if it was.
 *
 * `axis` defaults to `"presence"`, which is every call site this function had
 * before #231 -- adding the parameter rather than a second function keeps
 * every one of them unchanged while `mayAccuse("calls", "ts", "absence")`
 * reaches the new row.
 */
export function relationLicence(
  relation: AccusingRelation,
  language: Language,
  axis: AccusalAxis = "presence",
): RelationLicence | undefined {
  return licenceOf(language)?.relations[relation]?.[axis];
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
  axis: AccusalAxis = "presence",
): { asked: number; missed: number; invented?: number } | undefined {
  const licence = licenceOf(language);
  const row = licence?.relations[relation]?.[axis];
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
 *
 * ## Two words for "absence", and they are not the same one (#231)
 *
 * Everything above uses "absence" the way it always has: the claim a
 * `wrong` verdict rests on, whichever evidence grounds it. `axis` below is
 * narrower -- it names *which* evidence grounds that claim, and only
 * `@calls` has earned a second one. `axis: "presence"` (the default, and
 * every call site before #231) is a `wrong` resting on something *found*: a
 * name, a call running the other way. `axis: "absence"` is a `wrong`
 * resting on a reader that closed off every alternative and found none --
 * `@calls`' tier-2 receiver resolver, measured in docs/claim-vocabulary.md
 * items 12-14. Asking for an axis no word has is not a special case: an
 * unmeasured `NOT_DESIGNED_YET` row answers `false` the same way an
 * unlisted word does.
 */
export function mayAccuse(
  relation: AccusingRelation,
  language: Language,
  axis: AccusalAxis = "presence",
): boolean {
  const row = relationLicence(relation, language, axis);
  if (row === undefined || !isMeasured(row)) return false;
  return row.covers === undefined || row.covers.includes(language);
}
