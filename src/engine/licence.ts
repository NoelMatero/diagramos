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
 * Nothing consults this yet. A file whose extension no licence names is a file
 * no verdict may be built on, which is the same silence an unsupported language
 * already gets everywhere else in the engine.
 */
export function licenceFor(filePath: string): Licence | undefined {
  return LICENCES.find((licence) =>
    licence.extensions.some((extension) => filePath.endsWith(extension)),
  );
}
