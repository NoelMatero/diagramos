/**
 * How often a stale ref could have been followed without asking anyone.
 *
 * A ref goes stale most often for the dullest reason there is: the file or the
 * symbol moved and the design did not change. Git records renames, and a symbol
 * declared in exactly one place is not a judgement call, so an engine that sends
 * the author searching for what the repository can already state is spending a
 * person's attention on an answer that was written down.
 *
 * Whether the engine may *act* on that is a different question, and it turns on
 * one number: how often the answer is unambiguous. A wrong rebind is silent. A
 * board that quietly re-aims itself at the wrong function is worse than a board
 * that says "this is stale, come and look" -- so the case for following a ref
 * has to be made in measurement before it is made in code.
 *
 * `scripts/measure-rebind.mts` reproduces everything below. Nothing here decides
 * anything yet: this records what was measured, and whatever consults it is a
 * separate change. `docs/rebind-measurement.md` reads the numbers out.
 *
 * They are not a claim about all repositories. They are a measurement over two
 * named histories, and the way to disagree is to point `--repo` at a third.
 */

/** One population of anchors, counted the same way. */
export interface RebindSample {
  /** Distinct anchors observed. The denominator. */
  anchors: number;
  /**
   * Times a commit changed the file an anchor pointed at.
   *
   * The number that makes a zero readable: without it, "nothing broke" cannot
   * be told apart from "nothing was looked at".
   */
  chances: number;
  /** Commits that broke at least one anchor. */
  breakingCommits: number;

  /** Exactly one candidate: git recorded the rename, or the symbol is declared in one place. */
  followable: number;
  /**
   * The followable ones split by which channel answered, because they are not
   * equally trustworthy and one number hides that.
   *
   * `rename` is a fact about what a human did. `symbol` is a fact about the tree
   * as it stands. `path` is a filename coincidence, and it is the only channel
   * that has produced a wrong answer in either history measured.
   */
  byRename: number;
  bySymbol: number;
  byPath: number;
  byDirectory: number;
  /** More than one candidate. Stays a finding, and says why. */
  ambiguous: number;
  /** No candidate at all. Correctly a finding, not a rebind. */
  gone: number;

  /**
   * Of the followable ones, what a human later wrote in that box by hand.
   *
   * `followable` says a machine could have picked an answer; these say whether
   * the answer was right. `unfixed` is the honest large bucket -- a box nobody
   * ever corrected leaves nothing to check the candidate against, and the
   * hypothetical samples have no boxes at all, so all of those are unfixed.
   */
  agreed: number;
  disagreed: number;
  unfixed: number;
}

/** Another repository's history, replayed the same way. Pinned, because a moving corpus is unreproducible. */
export interface ForeignHistory {
  name: string;
  url: string;
  commit: string;
  commits: number;
  sample: RebindSample;
}

export interface RebindRecord {
  /** ISO date the histories were last replayed. */
  measured: string;
  /** The first-parent range walked in this repository, oldest end first. */
  from: string;
  to: string;
  commits: number;

  /**
   * Refs that were actually on a board when the code moved under them.
   *
   * The sample that counts, and here it is empty. The boards were drawn after
   * the code they describe had stopped moving: 407 times a commit changed a file
   * a live ref pointed at, and not one of those refs broke. An empty sample
   * decides nothing, which is why the others exist.
   */
  boards: RebindSample;

  /**
   * Every source file that left this tree, treated as though a board had pointed
   * at it, plus every symbol it exported treated as though a box had named it.
   *
   * Weaker on purpose and labelled as such: real boards point at load-bearing
   * files, and those move differently from the average file. It is also almost
   * entirely one commit -- 148 of the 152 anchors come from the day the Electron
   * app was deleted -- so it says more about deletion than about movement.
   */
  everyFile: RebindSample;

  /**
   * The same hypothetical walk over somebody else's history, for size.
   *
   * Re-derive with `npm run measure:rebind -- --repo=<clone>`. `--check` does
   * not verify these: they need a clone, and a check that needs the network is
   * a check that gets skipped.
   */
  elsewhere: readonly ForeignHistory[];
}

export const REBIND: RebindRecord = {
  measured: "2026-08-28",
  from: "c827cee704f6",
  to: "245aad658064",
  commits: 99,
  boards: {
    anchors: 75, chances: 407, breakingCommits: 0,
    followable: 0, byRename: 0, bySymbol: 0, byPath: 0, byDirectory: 0,
    ambiguous: 0, gone: 0,
    agreed: 0, disagreed: 0, unfixed: 0,
  },
  everyFile: {
    anchors: 152, chances: 152, breakingCommits: 2,
    followable: 31, byRename: 24, bySymbol: 3, byPath: 4, byDirectory: 0,
    ambiguous: 0, gone: 121,
    agreed: 0, disagreed: 0, unfixed: 31,
  },
  elsewhere: [
    {
      name: "Graphify-Labs/graphify",
      url: "https://github.com/Graphify-Labs/graphify.git",
      commit: "b2cd36267456c166788c95be6e68574064a92a42",
      commits: 1431,
      sample: {
        anchors: 129, chances: 129, breakingCommits: 3,
        followable: 110, byRename: 95, bySymbol: 15, byPath: 0, byDirectory: 0,
        ambiguous: 1, gone: 18,
        agreed: 0, disagreed: 0, unfixed: 110,
      },
    },
  ],
};
