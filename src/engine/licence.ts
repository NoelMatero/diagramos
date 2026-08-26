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
 * Hence a licence, per language, with the number in the repo where it can be
 * argued with. `scripts/measure-licence.mts` reproduces it. Nothing here decides
 * anything yet: this records what was measured, and the verdict that consults it
 * is a separate change.
 *
 * The number is not a promise about all TypeScript. It is a measurement over
 * named repositories at named commits, and the way to disagree with it is to add
 * a repository and re-run.
 */

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
}

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
