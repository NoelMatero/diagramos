/**
 * The board corpus every measurement counts, in one place.
 *
 * It lived inside `measure-vocabulary.mts` until #214, which is how
 * `measure-dataflow.mts` came to print a board count it had not computed --
 * there was nothing to import, so somebody wrote the sentence by hand and it
 * went stale silently while every number around it stayed live.
 *
 * Two commands quoting different totals for the same boards is the failure this
 * exists to make impossible. Anything that wants to say how many boards or
 * claims there are reads them from here.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const HOME = process.env.HOME ?? "/Users/noelmatero";

/**
 * Where boards are looked for.
 *
 * There are 1,902 `.excalidraw` files on the machine this was written on and
 * roughly two dozen distinct boards. The rest are copies: 1,171 live in
 * throwaway worktrees under `.claude`, several hundred are test fixtures, and
 * six sibling checkouts -- `board-ai-anchors`, `board-ai-daemon` and friends --
 * each hold an older copy of the same thirteen boards this repository has now.
 *
 * Counting those is not more data. It is the same board six times at six
 * different ages, which inflates every total by about six and makes staleness
 * look like signal. So the corpus is named rather than discovered, and a root
 * that is not on disk is skipped and said to be skipped.
 */
export const BOARD_ROOTS = [
  path.resolve(process.cwd()),
  `${HOME}/orangutan`,
  `${HOME}/Downloads`,
];

/**
 * Copies and fixtures rather than boards.
 *
 * `demo-124` and `demo-141` are the awkward ones and they are excluded for a
 * reason worth stating: they hold a *deliberately* backwards arrow, drawn to
 * demonstrate what a red looks like. Counting them puts a permanent one in the
 * failed-claim number, which is meant to be a regression signal that sits near
 * zero -- a floor nothing can ever clear reads exactly like a bug nobody fixed.
 */
export const NOT_A_BOARD = [
  "/node_modules/",
  "/.claude/",
  "/tests/",
  "/fixtures/",
  "/out/",
  "/.git/",
  "/demo-",
];

export function boardsUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return execFileSync("find", [root, "-name", "*.excalidraw", "-type", "f"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      /*
       * Matched against the path *below* the root, never the whole path. A
       * worktree of this repository lives under `.claude` itself, so filtering
       * the absolute path threw away every board in the checkout the run was
       * started from -- and reported four boards as if that were the corpus.
       */
      .filter((file) => {
        const below = `/${path.relative(root, file)}`;
        return !NOT_A_BOARD.some((fragment) => below.includes(fragment));
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * Every board in the corpus.
 *
 * `onSkip` is how a caller says a root was not on disk. Saying so matters more
 * than it looks: a missing root is the difference between "the corpus carries
 * one `@feeds` arrow" and "the corpus I could see carries one", and a reader
 * quoting the number deserves to know which they were given.
 */
export function boardCorpus(onSkip?: (root: string) => void): string[] {
  return BOARD_ROOTS.flatMap((root) => {
    const found = boardsUnder(root);
    if (found.length === 0) onSkip?.(root);
    return found;
  });
}
