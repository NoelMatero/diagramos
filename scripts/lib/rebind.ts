/**
 * Could a stale ref have been followed without asking anyone?
 *
 * A refactor that changed no architecture still makes you hand-edit the board,
 * and that is the whole reason a diagram gets abandoned. Most of that burden is
 * one narrow case: a file or a symbol moved, the design did not change, only the
 * address did. Git records renames. A symbol that now exists in exactly one
 * place is not a judgement call.
 *
 * So before building anything that writes a new ref into a board file, this
 * replays this repository's own history and counts how often the answer was
 * actually unambiguous. Three buckets, and the middle one is the one that
 * decides the feature:
 *
 * - **followable** -- git recorded the rename, or the symbol now exists in
 *   exactly one place. One candidate, no judgement.
 * - **ambiguous** -- more than one candidate. One function became three, or the
 *   name is shared. A rebind here would be a guess, and a wrong rebind is
 *   silent: a board that quietly re-aims itself at the wrong function is worse
 *   than a board that says "this is stale, come and look".
 * - **gone** -- nothing to follow. Correctly a finding, not a rebind.
 *
 * A fourth number is measured that the issue did not ask for, because
 * "followable" only says a machine could pick an answer, not that the answer
 * was right. Where a human later edited that same box's ref by hand, what they
 * wrote is ground truth, and the candidate is compared against it. That is the
 * number that says whether following a ref is safe, as opposed to possible.
 *
 * ## What counts as a ref worth measuring
 *
 * The same exclusions the drift check already makes, for the same reasons: a
 * hand-drawn box is an intention rather than a claim, a `planned` box points at
 * code that is deliberately not there yet, an `external` box is not ours, and a
 * concept board describes a protocol rather than this repository. None of them
 * can go stale, so none of them can be rebound.
 *
 * ## What history is being replayed
 *
 * First-parent only. A merge commit carries the net effect of its branch, which
 * is the thing a board would actually have had to survive; walking into the
 * branch as well would count the same move twice, and would count moves that
 * were undone before they landed.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

import { parseSymbol, routeOf } from "../../src/engine/assert";
import { symbolCounts } from "../../src/engine/body";
import type { BoardFile } from "../../src/engine/board-file";
import { parseRef } from "../../src/engine/drift";
import { readGraph, type RecoveredGraph } from "../../src/engine/graph";
import { languageOf } from "../../src/engine/parse";

/** Where a followable answer came from. Recorded so a reader can distrust one channel and not the others. */
export type Channel =
  /** Git recorded the file as renamed, and the symbol -- if any -- came with it. */
  | "rename"
  /** The symbol is declared in exactly one file in the tree now. */
  | "symbol"
  /** No symbol to search for; exactly one file in the tree could be the old one. */
  | "path"
  /** A directory ref, and every file that left it landed under one new directory. */
  | "directory";

export type Bucket = "followable" | "ambiguous" | "gone";

/** What a human did about it afterwards, which is the only ground truth available. */
export type Verdict =
  /** A later commit edited this box's ref, and it matches what we would have written. */
  | "agreed"
  /** A later commit edited this box's ref to something else. A silent rebind would have been wrong. */
  | "disagreed"
  /** Nobody ever fixed it, or the box or board went away. Nothing to compare against. */
  | "unfixed";

export interface StaleRef {
  /** The commit that broke it, and what it said it was doing. */
  commit: string;
  subject: string;
  board: string;
  node: string;
  label: string;
  /** The ref as it stood in the board before that commit. */
  ref: string;
  bucket: Bucket;
  /** Present only when `followable`. */
  channel?: Channel;
  /** What a rebind would have written. Present only when `followable`. */
  candidate?: string;
  /** Every candidate found, capped. The argument for calling something ambiguous. */
  candidates: string[];
  verdict: Verdict;
  /** What the human wrote instead, when they wrote anything. */
  humanWrote?: string;
}

export interface RebindMeasurement {
  /** The first-parent range walked, oldest first. */
  from: string;
  to: string;
  commits: number;
  /** Distinct board anchors seen alive at any point in the range. The denominator. */
  anchors: number;
  /**
   * Times a commit touched the file a live ref pointed at.
   *
   * The honest denominator for "how often did a board survive a change to the
   * code it describes". Without it, a zero in every bucket is unreadable: it
   * could mean refs never break, or it could mean the walk never looked.
   */
  chances: number;
  /** Commits that broke at least one ref. */
  breakingCommits: number;
  rows: StaleRef[];
}

/** Directories no candidate ever comes from: dependencies, build output, VCS. The list the drift walk uses. */
const NEVER_WALK = new Set([
  "node_modules", "out", "dist", "build", "coverage", "vendor", ".git",
  "test-results", "playwright-report", ".corpus", "graphify-out",
]);

const CANDIDATE_CAP = 8;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * The repository being replayed.
 *
 * Module-level because every `git` call in here wants it and threading it
 * through would say nothing extra. Each measure function sets it before it
 * walks, so the two never disagree about which repository they are reading.
 */
let root: string | undefined;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 }).trimEnd();
}

function inNeverWalk(file: string): boolean {
  return file.split("/").some((segment) => NEVER_WALK.has(segment));
}

/** Word-boundary match, the same leniency `drift.ts` uses to decide a symbol is still there. */
function mentions(source: string, symbol: string): boolean {
  return new RegExp(`\\b${symbol.replace(REGEX_SPECIAL, "\\$&")}\\b`).test(source);
}

/**
 * The repository as it was, per commit.
 *
 * Every existence question in here is answered from a commit's own tree rather
 * than from the working tree: the point is to ask what was true then, not what
 * is true now. Everything is cached because the walk asks the same questions of
 * the same commits many times over.
 */
class Repository {
  private readonly trees = new Map<string, string[]>();
  private readonly blobs = new Map<string, string | undefined>();
  private readonly declarations = new Map<string, string[]>();
  private readonly graphs = new Map<string, RecoveredGraph | undefined>();
  private readonly subjects = new Map<string, string>();

  files(commit: string): string[] {
    let listed = this.trees.get(commit);
    if (!listed) {
      listed = git(["ls-tree", "-r", "--name-only", commit])
        .split("\n")
        .filter((name) => name && !inNeverWalk(name));
      this.trees.set(commit, listed);
    }
    return listed;
  }

  has(commit: string, file: string): boolean {
    return this.files(commit).includes(file);
  }

  hasDirectory(commit: string, directory: string): boolean {
    const prefix = directory.endsWith("/") ? directory : `${directory}/`;
    return this.files(commit).some((file) => file.startsWith(prefix));
  }

  /** File contents, or undefined where the path is not a file at that commit. */
  read(commit: string, file: string): string | undefined {
    const key = `${commit}:${file}`;
    if (!this.blobs.has(key)) {
      let content: string | undefined;
      try {
        content = git(["show", key]);
      } catch {
        content = undefined;
      }
      this.blobs.set(key, content);
    }
    return this.blobs.get(key);
  }

  /**
   * Files at this commit that *declare* the symbol.
   *
   * Declaration rather than mention, and that asymmetry is where the guard
   * lives. Staleness is judged the way the drift check judges it -- a
   * word-boundary mention counts as still present, because a wrong "this is
   * gone" costs trust -- but a *destination* has to be somewhere the thing
   * actually lives. A call site is not a place to re-aim a box.
   */
  declaring(commit: string, symbol: string): string[] {
    const key = `${commit} ${symbol}`;
    let found = this.declarations.get(key);
    if (!found) {
      found = [];
      for (const file of this.files(commit)) {
        const language = languageOf(file);
        if (!language) continue;
        const source = this.read(commit, file);
        if (!source || !mentions(source, symbol)) continue;
        if (symbolCounts(source, symbol, language)?.declared) found.push(file);
      }
      this.declarations.set(key, found);
    }
    return found;
  }

  /** The board's graph at a commit, or undefined where it is not a readable board. */
  graph(commit: string, board: string): RecoveredGraph | undefined {
    const key = `${commit}:${board}`;
    if (!this.graphs.has(key)) {
      let recovered: RecoveredGraph | undefined;
      const source = this.read(commit, board);
      if (source) {
        try {
          recovered = readGraph(JSON.parse(source) as BoardFile);
        } catch {
          recovered = undefined;
        }
      }
      this.graphs.set(key, recovered);
    }
    return this.graphs.get(key);
  }

  boards(commit: string): string[] {
    return this.files(commit).filter((file) => file.endsWith(".excalidraw"));
  }

  subject(commit: string): string {
    let line = this.subjects.get(commit);
    if (line === undefined) {
      line = git(["log", "-1", "--format=%s", commit]);
      this.subjects.set(commit, line);
    }
    return line;
  }
}

interface Anchor {
  board: string;
  node: string;
  label: string;
  ref: string;
}

/**
 * Every ref on a board that is making a checkable claim about this repository.
 *
 * Hand-drawn, `planned`, `external` and concept boards are dropped here rather
 * than filtered later, because each of them is a box that *cannot* be stale,
 * and counting them would flatter every bucket at once.
 */
function anchorsOf(repository: Repository, commit: string, board: string): Anchor[] {
  const graph = repository.graph(commit, board);
  if (!graph || graph.describes === "concept") return [];
  const anchors: Anchor[] = [];
  for (const node of graph.nodes) {
    if (node.provenance !== "recorded") continue;
    if (node.state === "planned" || node.state === "external") continue;
    for (const ref of [node.ref, ...(node.refs ?? [])]) {
      if (ref) anchors.push({ board, node: node.id, label: node.label, ref });
    }
  }
  return anchors;
}

/** Whether a ref still points at something, judged as the drift check judges it. */
function resolves(repository: Repository, commit: string, ref: string): boolean {
  const { path: target, symbol } = parseRef(ref);
  if (!target) return false;
  if (target.endsWith("/")) return repository.hasDirectory(commit, target);
  if (!repository.has(commit, target)) return false;
  if (!symbol) return true;

  // A route anchor is a claim about a literal, not about a name that can move,
  // and a garbled one was never a claim at all. Both are resolved as far as
  // their file, which is the only part of them a rebind could follow.
  if (routeOf(symbol)) return true;
  const parsed = parseSymbol(symbol);
  if ("garbled" in parsed) return true;
  const source = repository.read(commit, target);
  return source !== undefined && mentions(source, parsed.symbol);
}

interface Changes {
  /** Old path to new path, as git recorded it. */
  renames: Map<string, string>;
  /** Every path touched on the old side: modified, deleted, or renamed away. */
  touched: Set<string>;
}

function changesBetween(before: string, after: string): Changes {
  const renames = new Map<string, string>();
  const touched = new Set<string>();
  const fields = git(["diff", "--find-renames", "--name-status", "-z", before, after])
    .split("\u0000")
    .filter((field) => field.length > 0);
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[index++];
      const to = fields[index++];
      if (status.startsWith("R")) {
        renames.set(from, to);
        touched.add(from);
      }
    } else {
      const file = fields[index++];
      if (status !== "A") touched.add(file);
    }
  }
  return { renames, touched };
}

/** Whether this commit could plausibly have broken this ref at all. Keeps the walk cheap. */
function couldHaveBroken(ref: string, changes: Changes): boolean {
  const { path: target } = parseRef(ref);
  if (!target) return false;
  if (target.endsWith("/")) {
    return [...changes.touched].some((file) => file.startsWith(target));
  }
  return changes.touched.has(target);
}

function refOf(file: string, symbol?: string): string {
  return symbol ? `${file}#${symbol}` : file;
}

/**
 * Files that could be the old one under a different address.
 *
 * Two shapes, and the second is the one the issue names outright: a file that
 * became a directory with an index in it, `src/engine/layout.ts` turning into
 * `src/engine/layout/index.ts`. Both directions count, because a directory
 * collapsing back into one file is the same refactor run backwards.
 */
function pathCandidates(repository: Repository, commit: string, target: string): string[] {
  const base = path.basename(target);
  const stem = base.replace(/\.[^.]+$/, "");
  const parentName = path.basename(path.dirname(target));
  return repository.files(commit).filter((file) => {
    if (path.basename(file) === base) return true;
    const fileStem = path.basename(file).replace(/\.[^.]+$/, "");
    // `x.ts` becoming `x/index.ts`
    if (fileStem === "index" && path.basename(path.dirname(file)) === stem) return true;
    // `x/index.ts` becoming `x.ts`
    if (stem === "index" && fileStem === parentName) return true;
    return false;
  });
}

/**
 * Where a whole directory went.
 *
 * Answerable only from renames: a directory leaves no trace of its own in git.
 * Every file that moved out of it is asked which directory it landed in, and
 * the answer counts only when they all agree -- a directory split in two is
 * precisely the ambiguity this measurement exists to count.
 */
function directoryCandidates(changes: Changes, directory: string): string[] {
  const landed = new Set<string>();
  for (const [from, to] of changes.renames) {
    if (!from.startsWith(directory)) continue;
    const tail = from.slice(directory.length);
    if (to.endsWith(tail)) landed.add(to.slice(0, to.length - tail.length));
    else landed.add(`${path.dirname(to)}/`);
  }
  return [...landed];
}

interface Followed {
  bucket: Bucket;
  channel?: Channel;
  candidate?: string;
  candidates: string[];
}

/** The guard, stated once: exactly one candidate, or it stays a finding. */
function decide(candidates: string[], channel: Channel): Followed {
  if (candidates.length === 1) {
    return { bucket: "followable", channel, candidate: candidates[0], candidates };
  }
  return {
    bucket: candidates.length === 0 ? "gone" : "ambiguous",
    candidates: candidates.slice(0, CANDIDATE_CAP),
  };
}

/**
 * What a rebind would have written, and whether it was entitled to write it.
 *
 * The channels are tried in order of how much they know. Git recording a rename
 * is a fact about what a human did; a symbol declared in exactly one place is a
 * fact about the tree as it is now; a filename matching is the weakest of the
 * three and is reached only when there is no symbol to search for.
 */
function follow(repository: Repository, after: string, changes: Changes, ref: string): Followed {
  const { path: target, symbol: rawSymbol } = parseRef(ref);
  const parsed = rawSymbol && !routeOf(rawSymbol) ? parseSymbol(rawSymbol) : undefined;
  const symbol = parsed && !("garbled" in parsed) ? parsed.symbol : undefined;

  if (target.endsWith("/")) {
    return decide(directoryCandidates(changes, target), "directory");
  }

  const fileGone = !repository.has(after, target);
  const renamed = changes.renames.get(target);
  if (fileGone && renamed) {
    // The file moved as a unit. Where a symbol was named it has to have made the
    // trip too: a rename that left the symbol behind is a split, and a split is
    // not something to follow silently.
    if (!symbol) {
      return { bucket: "followable", channel: "rename", candidate: renamed, candidates: [renamed] };
    }
    const source = repository.read(after, renamed);
    if (source && mentions(source, symbol)) {
      const candidate = refOf(renamed, rawSymbol);
      return { bucket: "followable", channel: "rename", candidate, candidates: [candidate] };
    }
  }

  if (symbol) {
    return decide(repository.declaring(after, symbol).map((file) => refOf(file, rawSymbol)), "symbol");
  }
  if (fileGone) {
    return decide(pathCandidates(repository, after, target), "path");
  }
  // The file is still there and the ref still failed: a route literal that
  // stopped being served, or a name that only ever appeared in a comment.
  // Nothing about an address to follow.
  return { bucket: "gone", candidates: [] };
}

/**
 * What a human did about this box afterwards.
 *
 * Walks forward through the same first-parent history looking for the first
 * commit in which that box's ref reads differently. Their edit is the ground
 * truth available: where it is not what a rebind would have written, the rebind
 * would have been silently wrong.
 */
function humanFix(repository: Repository, commits: string[], from: number, anchor: Anchor): string | undefined {
  for (let index = from; index < commits.length; index += 1) {
    const still = anchorsOf(repository, commits[index], anchor.board)
      .filter((one) => one.node === anchor.node);
    if (still.length === 0) continue;
    if (still.some((one) => one.ref === anchor.ref)) continue;
    return still[0].ref;
  }
  return undefined;
}

export interface MeasureOptions {
  /**
   * Which repository to replay. Defaults to the one the script is run in.
   *
   * This history is small enough that its own numbers decide nothing, and the
   * hypothetical sample below needs no boards, so it runs against any checkout.
   * Pointing it at a larger repository is how to disagree with the number.
   */
  repo?: string;
  /** Revision to start after, oldest end. Defaults to the whole history of `head`. */
  since?: string;
  head?: string;
  /** Called once per commit walked, for a progress line on a slow run. */
  onCommit?: (index: number, total: number, commit: string) => void;
}

export async function measureRebind(options: MeasureOptions = {}): Promise<RebindMeasurement> {
  root = options.repo;
  const head = options.head ?? "HEAD";
  const range = options.since ? `${options.since}..${head}` : head;
  const commits = git(["rev-list", "--first-parent", "--reverse", range]).split("\n").filter(Boolean);
  const repository = new Repository();
  const rows: StaleRef[] = [];
  const seen = new Set<string>();
  const breaking = new Set<string>();
  let chances = 0;

  for (let index = 1; index < commits.length; index += 1) {
    const before = commits[index - 1];
    const after = commits[index];
    options.onCommit?.(index, commits.length - 1, after);

    const boards = repository.boards(before);
    if (boards.length === 0) continue;
    const changes = changesBetween(before, after);

    for (const board of boards) {
      for (const anchor of anchorsOf(repository, before, board)) {
        seen.add(`${anchor.board} ${anchor.node} ${anchor.ref}`);
        if (!couldHaveBroken(anchor.ref, changes)) continue;
        if (!resolves(repository, before, anchor.ref)) continue;
        chances += 1;
        if (resolves(repository, after, anchor.ref)) continue;

        const followed = follow(repository, after, changes, anchor.ref);
        const humanWrote = humanFix(repository, commits, index, anchor);
        const verdict: Verdict = humanWrote === undefined
          ? "unfixed"
          : humanWrote === followed.candidate ? "agreed" : "disagreed";
        breaking.add(after);
        rows.push({
          commit: after.slice(0, 12),
          subject: repository.subject(after),
          board: anchor.board,
          node: anchor.node,
          label: anchor.label,
          ref: anchor.ref,
          bucket: followed.bucket,
          channel: followed.channel,
          candidate: followed.candidate,
          candidates: followed.candidates,
          verdict,
          humanWrote,
        });
      }
    }
  }

  return {
    from: commits[0]?.slice(0, 12) ?? "",
    to: commits[commits.length - 1]?.slice(0, 12) ?? "",
    commits: Math.max(0, commits.length - 1),
    anchors: seen.size,
    chances,
    breakingCommits: breaking.size,
    rows,
  };
}

/**
 * The same question asked of every file, not only the ones a board happened to
 * point at.
 *
 * This repository's boards are younger than its code, so the sample above is
 * thin to the point of deciding nothing. A move is a move whether or not anyone
 * had drawn a box on it yet, so this treats every source file that left the tree
 * as though a board had pointed at it, and every symbol that file exported as
 * though a box had named it.
 *
 * It is a weaker sample and it is labelled as one everywhere it is reported.
 * Real boards point at the load-bearing files, and load-bearing files move
 * differently from the average file. But it is a sample of real moves in a real
 * history, and it is the only one large enough to argue with.
 *
 * Only files that *left* the tree are asked. A symbol deleted out of a file that
 * survived is nearly always deleted code rather than moved code, and counting it
 * would inflate `gone` with cases nobody wanted rebound.
 */
export async function measureHypothetical(options: MeasureOptions = {}): Promise<RebindMeasurement> {
  root = options.repo;
  const head = options.head ?? "HEAD";
  const range = options.since ? `${options.since}..${head}` : head;
  const commits = git(["rev-list", "--first-parent", "--reverse", range]).split("\n").filter(Boolean);
  const repository = new Repository();
  const rows: StaleRef[] = [];
  const breaking = new Set<string>();
  let anchors = 0;

  for (let index = 1; index < commits.length; index += 1) {
    const before = commits[index - 1];
    const after = commits[index];
    options.onCommit?.(index, commits.length - 1, after);
    const changes = changesBetween(before, after);

    for (const gone of changes.touched) {
      if (!languageOf(gone) || repository.has(after, gone)) continue;
      const source = repository.read(before, gone);
      if (source === undefined) continue;

      const refs = [gone, ...exportsOf(source, gone).map((symbol) => refOf(gone, symbol))];
      anchors += refs.length;
      for (const ref of refs) {
        const followed = follow(repository, after, changes, ref);
        breaking.add(after);
        rows.push({
          commit: after.slice(0, 12),
          subject: repository.subject(after),
          board: "(hypothetical)",
          node: "",
          label: "",
          ref,
          bucket: followed.bucket,
          channel: followed.channel,
          candidate: followed.candidate,
          candidates: followed.candidates,
          // No box, so no human ever corrected one. Nothing to check against.
          verdict: "unfixed",
        });
      }
    }
  }

  return {
    from: commits[0]?.slice(0, 12) ?? "",
    to: commits[commits.length - 1]?.slice(0, 12) ?? "",
    commits: Math.max(0, commits.length - 1),
    anchors,
    chances: anchors,
    breakingCommits: breaking.size,
    rows,
  };
}

/**
 * Names a file exported, near enough.
 *
 * A regex proposes and the parser disposes: every name this finds is confirmed
 * as an actual declaration before it becomes an anchor, so a match inside a
 * string or a comment cannot invent one. What the regex can still do is *miss*
 * an export, which costs sample size and biases nothing -- the alternative was
 * an exported "list every declaration in this file" the engine does not have.
 */
const EXPORTED = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+([A-Za-z_][\w]*)/gm,
  // Python has no export keyword, so "at the left margin, and not underscored"
  // is the nearest thing to one. Missing the rest costs sample size only.
  /^(?:async\s+)?(?:def|class)\s+([A-Za-z][\w]*)/gm,
];

function exportsOf(source: string, file: string): string[] {
  const language = languageOf(file);
  if (!language) return [];
  const names = new Set<string>();
  for (const pattern of EXPORTED) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return [...names].filter((name) => symbolCounts(source, name, language)?.declared);
}

export function tally(rows: readonly StaleRef[]): Record<Bucket, number> {
  return {
    followable: rows.filter((row) => row.bucket === "followable").length,
    ambiguous: rows.filter((row) => row.bucket === "ambiguous").length,
    gone: rows.filter((row) => row.bucket === "gone").length,
  };
}

/**
 * Followable answers split by which channel produced them.
 *
 * Kept apart because they are not equally trustworthy, and a single
 * "followable" number hides that. A rename is a fact about what a human did; a
 * symbol declared in one place is a fact about the tree. A filename matching is
 * a coincidence that is often right, and this history contains at least one
 * where it is not.
 */
export function channels(rows: readonly StaleRef[]): Record<Channel, number> {
  const count = (channel: Channel) => rows.filter((row) => row.channel === channel).length;
  return {
    rename: count("rename"),
    symbol: count("symbol"),
    path: count("path"),
    directory: count("directory"),
  };
}

export function verdicts(rows: readonly StaleRef[]): Record<Verdict, number> {
  return {
    agreed: rows.filter((row) => row.verdict === "agreed").length,
    disagreed: rows.filter((row) => row.verdict === "disagreed").length,
    unfixed: rows.filter((row) => row.verdict === "unfixed").length,
  };
}
