/**
 * Where a stale anchor's code went, when the repository can say without guessing.
 *
 * A ref goes stale most often for the dullest reason there is: a file or a symbol
 * moved and the design did not change. Today the report says "this points at
 * nothing" and stops, so somebody -- usually a model, at cost, non-reproducibly --
 * goes searching the tree for an address git already wrote down. This module is
 * the other half of that sentence.
 *
 * It follows and it does not fix. Nothing here edits a board. The measurement
 * behind that restraint is `docs/rebind-measurement.md` (#140): a wrong rebind is
 * silent, and a board that quietly re-aims itself at the wrong function is worse
 * than one that says "come and look". So the destination is *shown*, next to the
 * finding, and a person or a command decides.
 *
 * ## Only the two channels that were never wrong
 *
 * That measurement replayed 281 broken anchors across two histories and sorted
 * every answer by where it came from:
 *
 * - **rename** -- git recorded the move. A fact about what a human did, and the
 *   strongest thing available. 119 answers, no wrong ones found.
 * - **symbol** -- the name is *declared* in exactly one file in the tree now.
 *   Declared, not mentioned: a call site is not a place to re-aim a box. 18
 *   answers, no wrong ones found.
 * - **filename** -- a file somewhere else has the same basename. Deliberately
 *   absent here. It produced every wrong answer in both histories, all three of
 *   them on a file called `index.ts` or `__init__.py`, and its wrong answers look
 *   exactly like its right ones: one candidate, stated confidently. A name every
 *   directory has identifies nothing, so it is not asked.
 *
 * The `exactly one candidate` guard holds on both channels that remain. More than
 * one and the finding stands, saying what the alternatives were -- which is a
 * better report than silence and still not an instruction.
 *
 * ## Every failure is silence
 *
 * No git, an untracked tree, a shallow clone, a grammar that will not load: all
 * of it comes back as "no suggestion", never as an error. This runs on the end of
 * every turn behind a check people already rely on. A drift report that starts
 * throwing because a repository has no history would cost more trust than every
 * suggestion in here is worth.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { symbolCounts } from "./body";
import { inNeverWalk } from "./generated";
import { languageOf } from "./parse";

/** Which channel answered. Recorded so a reader can distrust one and not the other. */
export type FollowChannel = "rename" | "symbol";

/**
 * The repository's memory, narrowed to the two questions that can be answered
 * without guessing, and injected so the following is testable without a real
 * history. Same shape of port as `Workspace` and `BoardBaseline`.
 */
export interface Trail {
  /**
   * Where git recorded this path moving to, or undefined.
   *
   * Chains are the implementation's problem, not the caller's: a file moved
   * twice answers with its final address.
   */
  renamedTo(file: string): string | undefined;
  /**
   * Every file that *declares* this symbol now, in repo-relative form.
   *
   * Declaration, not mention, and the asymmetry is the whole guard. Staleness is
   * judged leniently -- a word-boundary mention counts as still present, because
   * a wrong "this is gone" costs trust -- but a *destination* has to be somewhere
   * the thing actually lives.
   */
  declaring(symbol: string): string[];
}

/** A stale anchor, in the little of it this needs. Structural on purpose: no import back into `drift.ts`. */
export interface StaleAnchor {
  node: string;
  label: string;
  /** The ref as the board writes it. */
  ref: string;
  /** The ref already split, because whoever found it stale had to split it anyway. */
  path: string;
  /**
   * The symbol exactly as the board writes it, assertion words and all. What a
   * rewritten ref is rebuilt from, so a suggestion never quietly drops a claim
   * the box was making.
   */
  symbol?: string;
  /**
   * The bare identifier inside that symbol -- what there is to go looking for.
   *
   * Absent where the symbol is not a name that can move: a route literal is a
   * claim about what a file serves, and a garbled one was never a claim at all.
   * Those can still ride along with a recorded rename; they cannot be searched
   * for.
   */
  name?: string;
  /** The only two kinds that are an *address* problem. Anything else is not asked about. */
  kind: "missing-file" | "missing-symbol";
}

export interface FollowedRef {
  node: string;
  label: string;
  /** The ref as it stands, so a caller can find the box and a fix can match on it. */
  ref: string;
  /** The one address that fits. Absent when more than one did. */
  becomes?: string;
  /** Present exactly when `becomes` is. */
  via?: FollowChannel;
  /** Every address that fitted, capped. Present only when there was more than one. */
  candidates?: string[];
  /**
   * The sentence a report prints, written here so the CLI and the MCP server
   * cannot word it differently.
   *
   * Says what happened and not what the box is, because every reader of it
   * already has `ref` beside it -- the terminal prints this under the row naming
   * the box, and a caller reading the list has the field. Short enough to fit
   * that row without being cut, which is the whole reason the destination comes
   * first: truncation eats the end, and the end is the answer.
   */
  detail: string;
}

/** More than this many alternatives and listing them stops being an argument and becomes noise. */
const CANDIDATE_CAP = 4;

/** Enough hops for a file moved and moved again; short enough that a rename cycle cannot spin. */
const MAX_HOPS = 8;

/**
 * Files that may mention a name before the search gives up on it.
 *
 * Generous: a symbol worth putting on a board is imported by a handful of
 * modules, and this is a ceiling on pathology rather than a budget.
 */
const MENTION_CAP = 60;

/** Enough alternatives to show the reader it is a real choice, few enough to fit a row. */
function listed(files: readonly string[]): string {
  if (files.length <= 2) return files.join(", ");
  return `${files.slice(0, 2).join(", ")}, +${files.length - 2} more`;
}

function refOf(file: string, symbol?: string): string {
  return symbol ? `${file}#${symbol}` : file;
}

/**
 * What one stale anchor's address should read instead, or nothing.
 *
 * The channels are tried in the order of how much they know, and a rename is
 * only allowed to answer for a symbol when the symbol demonstrably made the trip.
 * A file that moved while the symbol it carried stayed behind is a split, and a
 * split is exactly the shape that should stay a finding.
 */
function followOne(anchor: StaleAnchor, trail: Trail): FollowedRef | undefined {
  const { node, label, ref, symbol, name } = anchor;
  const base = { node, label, ref };

  const declaring = name ? trail.declaring(name) : [];

  if (anchor.kind === "missing-file") {
    const moved = trail.renamedTo(anchor.path);
    if (moved && !name) {
      // Either there is no symbol at all, or the symbol is a route literal that
      // cannot be searched for. Both ride along with the file: what git recorded
      // is the whole file arriving somewhere else, claim and all.
      return {
        ...base,
        becomes: refOf(moved, symbol),
        via: "rename",
        detail: `moved to ${moved} \u2014 git recorded the rename.`,
      };
    }
    if (moved && name && declaring.length === 1 && declaring[0] === moved) {
      return {
        ...base,
        becomes: refOf(moved, symbol),
        via: "rename",
        detail: `moved to ${moved}, where ${name} is declared \u2014 git recorded the rename.`,
      };
    }
    // No rename, or the rename left the symbol behind. The tree itself may still
    // know where the name lives, and one place is an answer.
    if (name && declaring.length === 1) {
      return {
        ...base,
        becomes: refOf(declaring[0], symbol),
        via: "symbol",
        detail: `${name} is now declared in ${declaring[0]}, and nowhere else.`,
      };
    }
    if (name && declaring.length > 1) {
      return {
        ...base,
        candidates: declaring.slice(0, CANDIDATE_CAP).map((file) => refOf(file, symbol)),
        detail: `${name} is declared in ${declaring.length} places now (${listed(declaring)}) \u2014 nothing here can pick one.`,
      };
    }
    if (moved && name) {
      // The file's move is recorded and the symbol did not come with it. Worth
      // saying -- it names the refactor -- but it is not an address to write.
      return {
        ...base,
        detail: `moved to ${moved} without ${name} \u2014 the file was split, so this one needs a person.`,
      };
    }
    return undefined;
  }

  // missing-symbol: the file is still there, the name is not in it. Only the
  // tree can answer, and only when it answers once.
  if (!name) return undefined;
  if (declaring.length === 1 && declaring[0] !== anchor.path) {
    return {
      ...base,
      becomes: refOf(declaring[0], symbol),
      via: "symbol",
      detail: `${name} is declared in ${declaring[0]} now, and nowhere else.`,
    };
  }
  if (declaring.length > 1) {
    return {
      ...base,
      candidates: declaring.slice(0, CANDIDATE_CAP).map((file) => refOf(file, symbol)),
      detail: `${name} is declared in ${declaring.length} places now (${listed(declaring)}) \u2014 nothing here can pick one.`,
    };
  }
  return undefined;
}

/**
 * Every stale anchor that the repository can place, in the order it was given.
 *
 * Anchors that nothing could answer for are simply absent: a suggestion list is
 * read as things to act on, and a row saying "no idea" is a finding the caller
 * already has.
 */
export function followAnchors(
  anchors: readonly StaleAnchor[],
  trail: Trail,
): FollowedRef[] {
  const followed: FollowedRef[] = [];
  for (const anchor of anchors) {
    try {
      const answer = followOne(anchor, trail);
      if (answer) followed.push(answer);
    } catch {
      // One unanswerable anchor never costs the rest of the list.
    }
  }
  return followed;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * The real repository, read through git.
 *
 * Caches everything, because a board with six broken boxes asks about the same
 * few files and the same few names over and over, and because the two questions
 * cost a subprocess each.
 */
export function createGitTrail(root: string): Trail {
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    }).trimEnd();

  const renames = new Map<string, string | undefined>();
  const declarations = new Map<string, string[]>();

  /**
   * Renames git has been told about but has not committed.
   *
   * Read once, because it is the state of the whole index rather than a question
   * about one file. Only staged moves appear: an unstaged move is a delete and an
   * untracked file, and git will not call that a rename until it is added. That
   * is a real gap and the honest one -- inferring it would mean matching on a
   * filename, which is the channel this module refuses.
   */
  let staged: Map<string, string> | undefined;
  const stagedRenames = (): Map<string, string> => {
    if (staged) return staged;
    staged = new Map();
    try {
      const fields = git(["status", "--porcelain", "-z"]).split("\u0000");
      for (let index = 0; index < fields.length;) {
        const entry = fields[index++];
        if (!entry) continue;
        // "XY <path>" and, for a rename or copy, the original path in the field
        // after it -- destination first, source second.
        const status = entry.slice(0, 2);
        const to = entry.slice(3);
        if (status[0] === "R" || status[1] === "R") {
          const from = fields[index++];
          if (from) staged.set(from, to);
        }
      }
    } catch {
      // No git, or a repository with no HEAD yet. Nothing staged to read.
    }
    return staged;
  };

  /** One hop: where this exact path went, according to the commit that last touched it. */
  const hop = (file: string): string | undefined => {
    const stagedMove = stagedRenames().get(file);
    if (stagedMove) return stagedMove;
    try {
      const commit = git(["log", "-n", "1", "--format=%H", "--", file]);
      if (!commit) return undefined;
      const fields = git(["diff", "--find-renames", "--name-status", "-z", `${commit}^`, commit])
        .split("\u0000")
        .filter((field) => field.length > 0);
      for (let index = 0; index < fields.length;) {
        const status = fields[index++];
        if (status.startsWith("R") || status.startsWith("C")) {
          const from = fields[index++];
          const to = fields[index++];
          if (status.startsWith("R") && from === file) return to;
        } else {
          index += 1;
        }
      }
    } catch {
      // A root commit has no `^`, a shallow clone has no history, an untracked
      // path has no log. All of them mean the same thing here.
    }
    return undefined;
  };

  /** On disk, not in the index: a rename that has been made but not staged still lands somewhere real. */
  const exists = (file: string): boolean => {
    try {
      return existsSync(path.join(root, file));
    } catch {
      return false;
    }
  };

  return {
    renamedTo(file) {
      if (renames.has(file)) return renames.get(file);
      let at = file;
      let answer: string | undefined;
      for (let step = 0; step < MAX_HOPS; step += 1) {
        const next = hop(at);
        if (!next || next === at) break;
        answer = next;
        at = next;
        // A move whose destination is present is the end of the trail. Asking
        // further would follow whatever else that path has ever been called.
        if (exists(at)) break;
      }
      renames.set(file, answer);
      return answer;
    },

    declaring(symbol) {
      const cached = declarations.get(symbol);
      if (cached) return cached;
      const found: string[] = [];
      try {
        // `git grep` narrows the tree to files that contain the word at all,
        // which is the difference between parsing four files and parsing four
        // thousand. Tracked files only, so build output and dependencies are
        // excluded before the filter below is even asked.
        const files = git(["grep", "-l", "-w", "-F", "-e", symbol, "--"])
          .split("\n")
          .filter((file) => file.length > 0 && !inNeverWalk(file));
        /*
         * A name the whole tree says is a name it cannot place.
         *
         * `handle`, `get`, `run`: parsing every file that mentions one of those
         * would cost seconds on a path that runs at the end of every turn, and
         * would spend them arriving at "more than one candidate" -- the answer
         * that was already the overwhelming likelihood before the first file was
         * read. Giving up here is the same silence as finding nothing, which is
         * what the caller does with either.
         */
        if (files.length > MENTION_CAP) {
          declarations.set(symbol, found);
          return found;
        }
        const word = new RegExp(`\\b${symbol.replace(REGEX_SPECIAL, "\\$&")}\\b`);
        for (const file of files) {
          const language = languageOf(file);
          if (!language) continue;
          // From disk rather than from the index, because `git grep` searched the
          // working tree and reading the other one would answer about a
          // different tree than the one that was matched.
          let source: string;
          try {
            source = readFileSync(path.join(root, file), "utf8");
          } catch {
            continue;
          }
          if (!word.test(source)) continue;
          // No grammar loaded is `undefined`, which is neither a declaration nor
          // an error. The name simply cannot be placed.
          if (symbolCounts(source, symbol, language)?.declared) found.push(file);
        }
      } catch {
        // `git grep` exits non-zero when nothing matched, which is the same
        // answer as an empty list, and so is a repository with no git at all.
      }
      declarations.set(symbol, found);
      return found;
    },
  };
}

/** Repo-relative, forward-slashed: the form every ref on a board is written in. */
export function relativeTo(root: string, file: string): string | undefined {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}
