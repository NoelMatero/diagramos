/**
 * Drift detection: does a diagram still agree with the repository?
 *
 * A committed diagram is documentation, and documentation rots. A node can
 * record what it stands for -- `ref: "src/engine/layout.ts"`, or
 * `path#symbol` -- and this compares those claims against the working tree.
 *
 * Deliberately shallow: no model, no import graph, just existence. Being cheap
 * and quiet matters more here than being thorough, because a check that is slow
 * or cries wolf gets switched off, and then it catches nothing at all.
 *
 * Two rules keep false positives near zero:
 *
 * - A node with no ref is skipped, never guessed at from its label ("Auth"
 *   could be anything). The one exception is a label that is unambiguously a
 *   path, which is reported as `inferred` so a caller can weigh it accordingly.
 * - Hand-drawn nodes are ignored entirely. A box someone sketched is an
 *   intention, not a claim about code that exists today.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { parseSymbol, routeOf, symbolEvidence, type Assertion } from "./assert";
import { chainBreak, declarationsOf, reaches, unsupportedMembers } from "./body";
import type { BoardFile } from "./board-file";
import { arrowClaimError, boxClaimError, type ArrowClaim } from "./claim";
import { checkClosed, type ClosedBreach } from "./closed";
import { connects, refIsStale, type CodeGraphOption } from "./codegraph";
import { readDependencies, readerCanPlace } from "./deps";
import { readGraph, type Provenance, type RecoveredGraph } from "./graph";
import { licenceFor } from "./licence";
import { languageOf, type Language } from "./parse";
import { ledgerAdditions, type Ledger } from "./ledger";
import { checkNeeds, type NeedsWithheld } from "./needs";
import { resolveDependency, type ConfigCache } from "./resolve";
import type { Workspace } from "./workspace";

export type DriftKind =
  | "missing-file"
  | "missing-symbol"
  | "unresolvable-ref"
  | "empty-ref"
  /** `@declared` claimed, and no declaration of that name is in the file. */
  | "missing-declaration"
  /** `@used` claimed, and every occurrence is the declaration itself. */
  | "unused-symbol"
  /** A symbol a box lists as part of a concept, whose body shows no trace of it. */
  | "unsupported-member"
  /** A route anchor whose literal is no longer served by the file or its imports. */
  | "missing-route"
  /**
   * A `closed` box that something outside reaches into.
   *
   * The only box finding whose evidence is a file the box does not name: every
   * other one is about the anchor going stale, this one is about somebody else's
   * import. So the detail names the offending file and line rather than the box.
   */
  | "open-box";

export interface DriftFinding {
  /** Node id, as edges and edit_diagram refer to it. */
  node: string;
  label: string;
  /** The ref as written, so a caller can find and fix it. */
  ref: string;
  kind: DriftKind;
  /** `recorded` refs were declared outright; `inferred` were read off a label. */
  provenance: Provenance;
  detail: string;
}

/**
 * What can be said about one arrow.
 *
 * `broken-chain` is a `via` arrow whose named route stopped holding. Still a
 * finding, and for the same reason `backwards-edge` is: somebody wrote the route
 * down, and a hop that stopped holding is that claim being contradicted.
 *
 * `backwards-edge` is the only member that means **wrong** rather than *worth a
 * look*, and it is reachable only from a `needs` claim on a `built` arrow --
 * because that is the only claim with a direction, and so the only one with an
 * opposite to find.
 *
 * `unsupported-edge` no longer appears on a `built` arrow at all (#133). On one
 * it was the check reporting that it had found nothing, which is not a fact
 * about the diagram; that is `UnconfirmedEdge` now. It survives here for
 * `planned` arrows, where absence is the news the board asked for -- the
 * connection you drew has not landed yet -- and it reaches the report as a
 * `WorkItem`, never as drift.
 */
export type EdgeFindingKind = "unsupported-edge" | "broken-chain" | "backwards-edge";

/**
 * Every verdict word this engine can put in a report, as data (#116).
 *
 * A reader of a report -- the board page above all -- grades findings by kind,
 * and it is compiled separately and shipped as a built bundle, so it can be
 * older than the engine answering it. When it is, a kind it has no branch for
 * lands in whatever bucket its arithmetic leaves over, and a red finding is
 * shown as an amber one with nothing anywhere saying so.
 *
 * So the report carries the list, and a reader can compare it against the words
 * it knows and say "I am out of date" instead of guessing. `satisfies` and the
 * exhaustiveness check below make adding a kind to either union without adding
 * it here a compile error, which is the only reason this list can be trusted.
 */
export const DRIFT_KINDS = [
  "missing-file",
  "missing-symbol",
  "unresolvable-ref",
  "empty-ref",
  "missing-declaration",
  "unused-symbol",
  "unsupported-member",
  "missing-route",
  "open-box",
] as const satisfies readonly DriftKind[];

export const EDGE_FINDING_KINDS = [
  "unsupported-edge",
  "broken-chain",
  "backwards-edge",
] as const satisfies readonly EdgeFindingKind[];

/*
 * The half `satisfies` cannot do: it proves every listed word is a real kind,
 * not that every real kind is listed. Add one to a union and forget the array,
 * and `never` stops being assignable here.
 */
const _everyKindIsListed: never =
  undefined as unknown as Exclude<
    DriftKind | EdgeFindingKind,
    (typeof DRIFT_KINDS)[number] | (typeof EDGE_FINDING_KINDS)[number]
  >;
void _everyKindIsListed;

export interface EdgeDriftFinding {
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  fromRef: string;
  toRef: string;
  /**
   * `from -> to` in node ids -- the arrow as the canvas and edit_diagram know
   * it. `from`/`to` above are file paths, which name the *evidence*; this names
   * the *element*, so a caller can reveal or edit the arrow the finding is
   * about. Same shape a WorkItem or Promotion uses for an edge.
   */
  node: string;
  kind: EdgeFindingKind;
  detail: string;
}

/**
 * A `planned` claim the code has not caught up with yet. Detected identically to
 * a regression -- the anchor does not resolve -- and reported as the opposite
 * thing, because the board said it was describing the future.
 *
 * Kept out of `findings` on purpose: `clean` and the CLI's exit code drive CI,
 * and a build must not fail because somebody sketched next week's work.
 */
export interface WorkItem {
  /** Node id, or `from -> to` when the claim is a connection rather than a box. */
  node: string;
  label: string;
  /** Absent for an edge, where the claim is the connection and not one anchor. */
  ref?: string;
  /**
   * Why it is not there yet -- the same distinctions the checks already draw.
   *
   * `backwards-edge` cannot appear here, and the reason is a rule rather than an
   * accident: the wrong verdict is gated on `built`, so a `planned` arrow never
   * reaches it. Sketching a dependency that currently runs the other way is a
   * thing people do on purpose, and being accused of it is not useful.
   */
  kind: DriftKind | EdgeFindingKind;
  detail: string;
}

/**
 * A `planned` claim that now resolves: the work landed and the board has not
 * been told. The only signal here that is good news, and the reason it is worth
 * recording state at all -- nothing else notices progress.
 */
export interface Promotion {
  node: string;
  label: string;
  /** Absent for an edge promotion, where the claim is the connection itself. */
  ref?: string;
  detail: string;
  /**
   * The claim this promotion just made checkable, when the promoted thing
   * carried one.
   *
   * A promotion and the first verdict on a claim are two runs apart, and read
   * back to back they can look like the tool changing its mind: "built now"
   * this turn, "drawn backwards" the next. They are not in conflict -- the
   * promotion established that the connection exists, never which way it runs
   * -- but only a report that says so can be read that way (#123). Carried here
   * so the sentence announcing the promotion can name what it did *not* settle.
   */
  claim?: ArrowClaim;
}

/**
 * A box that was on the committed board, is not on it now, and whose code is
 * still there. Deleting a box is how you silence every other check about it, so
 * this is the one finding that comes from what the diagram *stopped* saying.
 *
 * Uncommitted only. Committing the board is the "yes, I meant it" act, which is
 * why this needs no mute of its own -- and why CI can never trip it: a fresh
 * checkout has nothing uncommitted to find.
 */
export interface DeletedClaimFinding {
  node: string;
  label: string;
  ref: string;
  kind: "deleted-claim";
  detail: string;
}

/**
 * The same board as last committed, injected so the check is testable without
 * shelling out. `undefined` means there is nothing to compare against -- no git,
 * the board is untracked, or it has not been touched since the last commit --
 * and every one of those is silence rather than an error.
 */
export interface BoardBaseline {
  committed(): BoardFile | undefined;
}

/**
 * A generated box with no anchor at all, named so it can be fixed.
 *
 * `skippedWhy` already counts these, and a count is what the per-turn notice
 * should say: nagging about coverage every turn is how a check gets switched
 * off. But a count cannot be acted on. Nobody is going to open a 33-box board
 * and diff it against the report by eye, and the measured evidence is that
 * nobody annotates by hand at all -- every ref in this repo was written by a
 * tool.
 *
 * So the on-demand channel names them, and `/annotate-diagram` reads the list to
 * propose an anchor per box for a human to approve. The label is carried
 * because it is the only evidence of what the box meant.
 */
export interface UnannotatedFinding {
  /** Node id, as `create_diagram` and `edit_diagram` refer to it. */
  node: string;
  label: string;
}

/**
 * A code file the diagram's own boxes import, that no box covers.
 *
 * The other direction of drift: not "the board claims something false" but "the
 * board leaves something out". Only ever a suggestion -- whether a module
 * deserves a box is a judgement about what is worth showing, and a diagram that
 * drew everything would be a file listing.
 */
export interface UnrepresentedFinding {
  /** Repo-relative path of the file no box covers. */
  file: string;
  /** The board's own ref'd files that import it, which is why it is a candidate. */
  importedBy: string[];
  /**
   * The board's own ref'd files that *this* file imports, set only when nothing
   * on the board imports it back.
   *
   * An entry point -- a CLI, a hook, a test -- is imported by nothing, so the
   * `importedBy` direction can never see it however complete the board gets.
   * That is not a gap in the ranking, it is the shape of the import graph, and
   * it is why a board can be every-box-anchored and still be missing a whole
   * surface. Empty `importedBy` and a populated `imports` is that case.
   */
  imports?: string[];
}

/**
 * An arrow nothing read, named rather than only counted.
 *
 * `edgesSkippedWhy` already says how many went unread and why, and a reason
 * without a subject cannot be acted on: a board reporting "4 arrows skipped: an
 * end is marked external" gives a reader no way to learn *which* four, short of
 * opening this file. That is the same argument `unannotated` won for boxes, and
 * arrows simply never got the same treatment.
 *
 * It catches nothing on its own. Silence here had two meanings -- "this agreed
 * with the code" and "nobody looked" -- and from outside the tool they were
 * indistinguishable. This separates them, and then a human decides.
 *
 * Unlike `unannotated` and `unrepresented` this is not gated on `coverage`.
 * Those two go looking for something; this only writes down a decision the
 * check has already made, so gating it would buy nothing and would leave
 * `--details` -- the flag whose entire job is saying what was not read --
 * unable to answer its own question.
 */
export interface UnreadEdgeFinding {
  /** Node ids, as `edit_diagram` refers to them. */
  from: string;
  to: string;
  /** Box labels: what a reader recognises on the board. Falls back to the id. */
  fromLabel: string;
  toLabel: string;
  /** The arrow's own label, when it carries one. */
  label?: string;
  reason: EdgeSkipReason;
}

/**
 * Why an arrow the check *did* read came back unconfirmed.
 *
 * Three, and the difference between them is how much the silence is worth.
 *
 * - `no-call-either-way` is a question with an answer: both ends name something
 *   with a body, both bodies were read, and neither reaches the other. The
 *   sharpest "nothing found" this engine can produce.
 * - `an-end-is-data` is a question that was never the right one. A struct, a
 *   static or a field has no body that calls anything, so a call search over it
 *   answers about the wrong thing -- and the fix is on the board, not in the
 *   code: anchor that end at file level.
 * - `nothing-connects-them` is the file-level channels coming up empty: no
 *   import either way, no shared importer, no shared route, nothing in the code
 *   graph.
 */
export type EdgeUnconfirmedReason =
  | "no-call-either-way"
  | "an-end-is-data"
  | "nothing-connects-them";

/**
 * An arrow that was read and could not be corroborated.
 *
 * Deliberately not a finding (#133). Every channel here only ever *confirms*,
 * so failing to confirm is absence of evidence, and rendering absence as a
 * per-arrow verdict is how a board that claimed nothing arrived with fifteen
 * things to look at -- on the first Rust board an agent drew, 15 of 17 ambers
 * were arrows carrying a descriptive label and no claim at all. `claim.ts` only
 * admits a word once something can call it wrong; the converse now holds too,
 * and an arrow that asserts nothing checkable is counted rather than judged.
 *
 * Named and not merely counted, for the reason `unreadEdges` was: a number
 * nobody can act on is a number nobody reads. `--details` prints these; the
 * per-turn notice does not, `clean` does not include them, and no exit code
 * ever turns on one.
 */
export interface UnconfirmedEdge {
  /** Node ids, as `edit_diagram` refers to them. */
  from: string;
  to: string;
  /** Box labels: what a reader recognises on the board. Falls back to the id. */
  fromLabel: string;
  toLabel: string;
  /** The arrow's own label, when it carries one -- often the whole relationship. */
  label?: string;
  reason: EdgeUnconfirmedReason;
  /** The engine's own sentence, including what to do about `an-end-is-data`. */
  detail: string;
}

/**
 * What one arrow check came to, as the recorder is told it.
 *
 * Three words instead of "a finding, or nothing", because "nothing" was two
 * different things wearing one shape: proved connected, and looked at and not
 * proved. Spelling the third one out is what lets the report keep it as a
 * number without it having to pass through `edges` on the way.
 */
type EdgeOutcome =
  | { kind: "confirmed" }
  | { kind: "finding"; finding: Omit<EdgeDriftFinding, "node"> }
  | { kind: "unconfirmed"; reason: EdgeUnconfirmedReason; detail: string };

/**
 * Why a node was not checked. Kept apart from `excused`, which is a declaration
 * that there was nothing to check, and from `handDrawn`, which is a sketch.
 */
export type NodeSkipReason =
  | "no-ref"
  | "ref-outside-repo"
  /** A directory or glob anchor with more entries than the cap allows reading. */
  | "anchor-too-large"
  /** A route anchor on a file that writes no route literals at all. */
  | "no-route-literals";

/**
 * Why an arrow was not checked. Eleven reasons, all of which used to arrive as a
 * single number -- so a reader could see that five arrows went unchecked without
 * any way to learn that two of them simply had not been snapped to their boxes.
 */
export type EdgeSkipReason =
  | "ends-not-bound"
  | "endpoint-missing"
  | "endpoint-external"
  | "endpoint-has-no-ref"
  | "endpoint-outside-repo"
  | "endpoint-file-missing"
  | "directory-ref"
  /**
   * An end refs a glob, so it stands for a set of files rather than one.
   *
   * Its own reason rather than folded into `directory-ref`, because a glob is
   * narrower than the directory it lists and the reader who wrote `*.ts` should
   * see their own words back. Both mean the same thing to the channels: the
   * two-file questions have no single pair to ask about.
   *
   * Before this existed a glob-anchored arrow was reported as
   * `endpoint-file-missing` -- `stat` was handed a path with a `*` in it and
   * answered "missing", so the one reason that means *your code has been
   * deleted* was spent on a ref shape the README documents as legal.
   */
  | "glob-ref"
  /**
   * Neither endpoint's language has a measured licence, so no reader here has
   * earned an opinion about it. Called `not-ts-or-js` until Rust arrived: that
   * name was a description of one regex rather than of what the engine can
   * read, and it went on being printed over a language `licence.ts` had
   * measured and `deps.ts` had a reader for.
   */
  | "unlicensed-language"
  /**
   * The language has a licence and this file is not the kind of file the
   * licence was measured over. Today that means one thing: a Rust file no
   * crate declares, whose `mod` and `crate::` paths have no root to resolve
   * against. The corpus left those out rather than netting them off, so a
   * channel that read one anyway would be confirming from a reader nobody
   * measured -- see `readerCanPlace` in `deps.ts`.
   */
  | "outside-licence"
  /** Both ends named a symbol, and neither one has a body that could be read. */
  | "no-function-body";

/** Counts by reason, with zeroes omitted so a caller can print what is there. */
export type SkipBreakdown<Reason extends string> = Partial<Record<Reason, number>>;

/**
 * What became of the `@declared` / `@used` claims on this board.
 *
 * Both weakenings are silent by design -- the anchor still gets the plain
 * mention check -- so without a count there would be no way to tell a claim
 * that held from one that was never evaluated.
 */
export interface AssertionTally {
  /** Assertions actually evaluated against a parsed file. */
  checked: number;
  /** The parse hit an error somewhere in the file, so the answer is worth less. */
  downgraded: number;
  /** No grammar for that file type. */
  unsupportedLanguage: number;
}

/**
 * A word written in a claim slot that the vocabulary does not have.
 *
 * Loud, and loud the turn it is written, for the reason `parseSymbol` is loud
 * about `@exported`: a claim that is not recognised is checked by nothing, and a
 * claim checked by nothing looks exactly like a claim that passed. The whitelist
 * only means something if falling off it makes a noise.
 */
export interface GarbledClaimFinding {
  /** Arrows and boxes have different vocabularies, so the refusal differs too. */
  on: "arrow" | "box";
  /** What a reader sees on the canvas: a box's label, or `from → to` for an arrow. */
  label: string;
  /** The word as written, without the `@`. */
  written: string;
  detail: string;
}

/**
 * Claims recorded on this board, and what became of them.
 *
 * A `needs` arrow is now the one thing on a board that can be called *wrong*, so
 * the count alone stopped being enough: what matters is how many of them were
 * actually held to that standard. Every arrow that carried the claim and got no
 * verdict is counted under the reason it got none.
 */
export interface ClaimTally {
  /** Boxes asserting that nothing outside their directory reaches inside it. */
  closed: number;
  /** Of those, how many were proved rather than merely not disproved. */
  closedHeld: number;
  /**
   * Imports from a test file into a `closed` box, which do not break the claim.
   *
   * Counted and shown rather than filtered out upstream, because an exclusion
   * you cannot see is one that rots. Renaming a file to `foo.test.ts` moves a
   * breach into this number in public; it does not make it disappear.
   */
  closedTestReaches: number;
  /** Arrows asserting that the tail declares a dependency on the head. */
  needs: number;
  /** Of those, how many got a direction verdict rather than a reason to stay quiet. */
  needsChecked: number;
  /**
   * Why the rest got none, by reason.
   *
   * Shown rather than swallowed. A claim that was never checked and a claim that
   * passed look identical in a clean report, and the difference is the whole
   * question of whether the diagram is being held to anything.
   *
   * Two families of reason share this map on purpose. A `NeedsWithheld` is
   * `checkNeeds` looking at the two files and declining to answer; an
   * `EdgeSkipReason` is the arrow never getting that far -- an end not snapped
   * to its box, an end with no ref. To the person who wrote the claim they are
   * one question with one answer, "why did nobody check this", so they are one
   * line with one count and the key says which.
   *
   * With edge checking on, every non-`planned` `needs` arrow lands in exactly
   * one of these or in `needsChecked`: there is no third place for a claim to
   * fall out of the walk unremarked, which is the whole point. `needs` itself
   * counts `planned` arrows too, so it is the larger number.
   */
  needsWithheld: SkipBreakdown<NeedsWithheld | "cycle" | EdgeSkipReason>;
}

/**
 * One import into a `closed` box, named in full.
 *
 * The summary finding names the worst offender and counts the rest; this is the
 * whole list, for the caller that wants to fix them rather than be told there
 * are twenty.
 */
export interface ClosedBreachFinding extends ClosedBreach {
  /** The box whose claim this breaks. */
  node: string;
  label: string;
}

/**
 * A `closed` box with no breach found and no right to say so.
 *
 * Not a failure and not a pass. The claim covers every file in the repository,
 * and these are the files that could not answer for themselves -- half-parsed,
 * reaching out at runtime, or in a language nobody measured. Reported as a gap,
 * because a green box resting on files nothing read is the failure this whole
 * tool is built to avoid.
 */
export interface ClosedUnprovenFinding {
  node: string;
  label: string;
  ref: string;
  /** The files that could not support a statement of absence. Empty when capped. */
  unread: string[];
  /** True when the walk hit its cap, so nothing at all was proved. */
  capped: boolean;
}

/** A door a `closed` box lists that nothing came through. Quiet note, never a failure. */
export interface ClosedUnusedDoorFinding {
  node: string;
  label: string;
  doors: string[];
}

export interface DeletedEdgeFinding {
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  detail: string;
}

export interface DriftReport {
  clean: boolean;
  findings: DriftFinding[];
  /**
   * Files the board's neighbourhood imports but does not show. Empty unless
   * `coverage` was asked for: it is the one check here that suggests additions,
   * so it never runs on the per-turn path.
   */
  unrepresented: UnrepresentedFinding[];
  /**
   * Generated boxes carrying no anchor, named rather than only counted. Empty
   * unless `coverage` was asked for -- the same rule `unrepresented` follows,
   * and for the same reason: this is a suggestion, not a regression.
   */
  unannotated: UnannotatedFinding[];
  /** Boxes removed from the board while their code is still in the tree. */
  deleted: DeletedClaimFinding[];
  /** Arrows removed from the board while the code still supports them. */
  deletedEdges?: DeletedEdgeFinding[];
  /** `planned` claims the code has not reached yet. Never affects `clean`. */
  workItems: WorkItem[];
  /** `planned` claims that now hold, so the board can be advanced. Never affects `clean`. */
  promotions: Promotion[];
  /** Nodes that had something checkable. */
  checked: number;
  /** Generated nodes with no ref to check against. */
  skipped: number;
  /** The same number, split by reason, so silence can be told from coverage. */
  skippedWhy: SkipBreakdown<NodeSkipReason>;
  /** What became of any `@declared` / `@used` claims. All zeroes on a board with none. */
  assertions: AssertionTally;
  /** Claims carried by arrows and boxes. Recorded and shown; judged by nothing yet. */
  claims: ClaimTally;
  /** Claim words that are not in the vocabulary. Part of `clean`, because a typo is a defect. */
  garbledClaims: GarbledClaimFinding[];
  /** Every import into a `closed` box, in full. The summary of these is in `findings`. */
  closedBreaches: ClosedBreachFinding[];
  /** `closed` boxes nothing disproved and nothing could prove. Never affects `clean`. */
  closedUnproven: ClosedUnprovenFinding[];
  /** Doors listed on a `closed` box that nothing came through. Never affects `clean`. */
  closedUnusedDoors: ClosedUnusedDoorFinding[];
  /** Nodes not about this repo: an `external` node, or any node on a concept board. */
  excused: number;
  /** Hand-drawn nodes, ignored by design. */
  handDrawn: number;
  /** True when the board says it describes something other than this repository. */
  concept: boolean;
  edges: EdgeDriftFinding[];
  /** Edges checked for corroboration. */
  edgesChecked: number;
  /** Edges skipped (directory refs, non-TS/JS, missing files, hand-drawn, refless). */
  edgesSkipped: number;
  /** The same number, split by reason. This is the one people ask about. */
  edgesSkippedWhy: SkipBreakdown<EdgeSkipReason>;
  /**
   * The same arrows again, named. Always populated: it records a decision
   * already taken rather than going looking, so there is nothing to defer.
   */
  unreadEdges: UnreadEdgeFinding[];
  /**
   * Arrows that were read and not corroborated: counted, named, never judged.
   *
   * The honest half of what amber used to say. "How much of this board is
   * actually verified" is a real question and this is the answer to it --
   * `edgesChecked` minus these is what came back confirmed.
   */
  unconfirmedEdges: UnconfirmedEdge[];
  /**
   * Count of arrows with fewer than two bound endpoints (dangling arrows).
   * These are incomplete strokes, not checked specifications.
   */
  strayArrows?: number;
  /**
   * Every verdict word this engine could have used, whether or not it did.
   *
   * Not a finding: it is how a separately built reader tells "no finding of
   * that kind" from "I have never heard of that kind". The board page is built
   * ahead of time into `out/viewer` and nothing rebuilds it on a pull, so it
   * can be a release behind the engine it is talking to and look completely
   * normal being so (#116).
   */
  vocabulary: string[];
}

/**
 * Re-exported so every existing caller keeps importing it from here. It moved
 * to its own module when the import resolver grew big enough to need it too.
 */
export type { Workspace } from "./workspace";

/**
 * A label worth reading as a path: at least one slash and a file extension.
 * Deliberately strict -- `POST /api/file` and `Auth` both fail, which is the
 * point. It exists so diagrams drawn before `ref` are not invisible to drift.
 */
const PATH_LIKE = /^[\w@.-]+(?:\/[\w@.-]+)+\.\w{1,10}$/;

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Files a symbol may be looked for inside a directory anchor.
 *
 * All that is left of a regex that used to gate the arrow check too, and the
 * remaining two call sites are a text search rather than a parse -- so this is
 * narrower than what the engine can read, and the node-level mirror of the bug
 * the arrow check just had. Out of scope here, and named so the next reader
 * finds it rather than rediscovering it from a report.
 */
const TS_JS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Files the dependency reader has a measured licence for.
 *
 * Deliberately tied to `licence.ts` rather than to a second list: `closed` asks
 * whether *anything* in the repository reaches into a directory, and a walk
 * that only looked at TypeScript would report a green box over a Rust subsystem
 * it never opened. A file with no licence is not silence here -- `checkClosed`
 * records it as unread, which costs the claim its confirmation -- so what
 * belongs in this walk is exactly what can be read.
 */
function readableSource(name: string): boolean {
  return licenceFor(name) !== undefined;
}

/**
 * Which measured language a file is, or nothing at all.
 *
 * `readableSource` answers yes or no, and two questions here need the name:
 * which reader to hand a file's imports to, and whether the route channel --
 * measured against TypeScript routing and nothing else -- may speak about it.
 */
function licensedLanguage(name: string): string | undefined {
  return licenceFor(name)?.language;
}

/** Splits `path#symbol`. Either half may be empty; the caller decides. */
export function parseRef(ref: string): { path: string; symbol?: string } {
  const hash = ref.indexOf("#");
  if (hash < 0) return { path: ref.trim() };
  return { path: ref.slice(0, hash).trim(), symbol: ref.slice(hash + 1).trim() || undefined };
}

export function refFromLabel(label: string): string | undefined {
  const candidate = label.trim();
  return PATH_LIKE.test(candidate) ? candidate : undefined;
}

/**
 * Word-boundary match, not a parse. A rename shows up; a mention in a comment
 * counts as still present. That asymmetry is deliberate: a missed rename is
 * invisible, while a wrong "this is gone" costs trust in the whole check.
 */
function mentions(source: string, symbol: string): boolean {
  return new RegExp(`\\b${symbol.replace(REGEX_SPECIAL, "\\$&")}\\b`).test(source);
}

type Inspection = DriftFinding | "ok" | { skip: NodeSkipReason };

/**
 * How many entries a directory or glob anchor will look at.
 *
 * Past this the anchor is skipped and counted rather than guessed at: a box
 * standing for a thousand-file directory is not making a checkable claim, and
 * reading them on every turn is not a per-turn budget.
 */
const ANCHOR_ENTRY_CAP = 50;

/**
 * Directories the coverage walk never enters: dependencies, build output, VCS.
 *
 * Not a security boundary -- `workspace.resolve` is still the only way in and
 * out. This is about cost and noise. Generated code is not something a diagram
 * was ever going to draw.
 */
const NEVER_WALK = new Set([
  "node_modules", "out", "dist", "build", "coverage", "vendor", ".git",
  "test-results", "playwright-report",
]);

/**
 * A test file, by the conventions every JS project shares.
 *
 * Tests are the largest group of entry points in any repository and the least
 * drawable: `tests/engine-drift.test.ts` importing four boxes is the suite
 * doing its job, not a surface the diagram forgot. Left in, they were 12 of 20
 * rows on this repo's own board and would have buried the one row that
 * mattered -- which is how a suggestion gets switched off.
 */
const TEST_FILE = /(^|[\\/])(tests?|__tests__|spec)[\\/]|\.(test|spec)\.[^.]+$/;

/**
 * How many source files the coverage walk will visit before giving up.
 *
 * Past this it returns nothing rather than a prefix of the truth, which is the
 * same choice `filesIn` makes at its own cap: a partial answer to "what is the
 * board missing?" reads as a complete one and is worse than silence.
 */
const WALK_FILE_CAP = 2000;

/**
 * Every source file in the repository, for the one caller that needs to look
 * somewhere the board does not already point.
 *
 * This is a tree walk, which the rest of this file goes to some length to
 * avoid, so the distinction matters: a *ref* must never trigger a search,
 * because a ref is a model-authored string and a search driven by one is an
 * arbitrary read of the disk. This walk is driven by the tool, takes no input,
 * and only ever runs behind `coverage`. What it finds is still filtered by an
 * import edge to a box, so relevance stays inherited rather than invented.
 *
 * `undefined` past the cap, meaning "do not report", never "nothing found".
 */
function sourceFilesUnder(rootAbsolute: string, workspace: Workspace): string[] | undefined {
  const found: string[] = [];
  const queue = [rootAbsolute];
  while (queue.length) {
    const directory = queue.pop()!;
    for (const entry of workspace.list(directory)) {
      // A dotfile directory is either VCS, tooling, or cache; none is drawable.
      if (entry.startsWith(".") || NEVER_WALK.has(entry)) continue;
      const child = `${directory}${path.sep}${entry}`;
      const kind = workspace.stat(child);
      if (kind === "directory") queue.push(child);
      else if (kind === "file" && readableSource(entry)) {
        if (found.length >= WALK_FILE_CAP) return undefined;
        found.push(child);
      }
    }
  }
  return found;
}

/**
 * A `*` in the last segment, and only there.
 *
 * The restriction is the security design rather than a simplification: the
 * directory prefix stays literal, so expansion is one listing of one directory.
 * Allowing `**`, or a star mid-path, turns a model-authored string back into a
 * tree walk.
 */
export function globOf(target: string): { directory: string; pattern: RegExp } | undefined {
  if (!target.includes("*")) return undefined;
  const cut = target.lastIndexOf("/");
  const directory = cut < 0 ? "." : target.slice(0, cut);
  const last = target.slice(cut + 1);
  if (directory.includes("*") || last.includes("**")) return undefined;
  const body = last.split("*").map((part) => part.replace(REGEX_SPECIAL, "\\$&")).join("[^/]*");
  return { directory, pattern: new RegExp(`^${body}$`) };
}

/** Names directly inside a directory that are files. `undefined` past the cap. */
function filesIn(
  directoryAbsolute: string,
  workspace: Workspace,
  match?: RegExp,
): string[] | undefined {
  const entries = workspace.list(directoryAbsolute);
  if (entries.length > ANCHOR_ENTRY_CAP) return undefined;
  return entries.filter(
    (entry) =>
      (!match || match.test(entry))
      && workspace.stat(`${directoryAbsolute}/${entry}`) === "file",
  );
}

/** Whether any of these files mentions the symbol. Stops at the first hit. */
function mentionedIn(files: string[], symbol: string, workspace: Workspace): boolean {
  return files.some((file) => mentions(workspace.read(file), symbol));
}

/**
 * Judge one file against `@declared` / `@used`.
 *
 * `"unsupported"` is the language with no table, and `"ok"` covers both a
 * satisfied claim and a downgrade -- an unparseable file falls back to the caller's
 * mention check, which has already run. Every uncertainty here resolves quiet.
 */
function judgeAssertion(
  filePath: string,
  source: string,
  symbol: string,
  assertion: Assertion,
  tally: AssertionTally,
): "ok" | "unsupported" | { kind: "missing-declaration" | "unused-symbol" } {
  const evidence = symbolEvidence(filePath, source, symbol);
  if (!evidence) {
    tally.unsupportedLanguage += 1;
    return "unsupported";
  }
  if (evidence.downgraded) {
    tally.downgraded += 1;
    return "ok";
  }
  tally.checked += 1;
  if (assertion.declared && !evidence.declared) return { kind: "missing-declaration" };
  if (assertion.used && evidence.used < 1) return { kind: "unused-symbol" };
  return "ok";
}

/**
 * Whether any of these files satisfies the assertion. The set form of the
 * above: a directory or glob anchor claims the symbol lives somewhere inside,
 * so one file holding up the claim is enough.
 */
function assertedIn(
  files: string[],
  symbol: string,
  assertion: Assertion,
  workspace: Workspace,
  tally: AssertionTally,
): "ok" | "unsupported" | { kind: "missing-declaration" | "unused-symbol" } {
  let worst: "unsupported" | { kind: "missing-declaration" | "unused-symbol" } = "unsupported";
  for (const file of files) {
    const verdict = judgeAssertion(file, workspace.read(file), symbol, assertion, tally);
    if (verdict === "ok") return "ok";
    if (verdict !== "unsupported") worst = verdict;
  }
  return worst;
}

function inspect(
  node: { id: string; label: string },
  ref: string,
  provenance: Provenance,
  workspace: Workspace,
  tally: AssertionTally,
  importCache: ReadCache,
): Inspection {
  const { path: rawTarget, symbol: rawSymbol } = parseRef(ref);
  const base = { node: node.id, label: node.label, ref, provenance };
  if (!rawTarget) {
    return { ...base, kind: "unresolvable-ref", detail: `"${ref}" names a symbol but no file.` };
  }

  // A garbled assertion is loud immediately rather than becoming a claim that
  // silently checks nothing. It fails the turn it is written, while the author
  // is still there.
  const parsed = rawSymbol === undefined ? undefined : parseSymbol(rawSymbol);
  if (parsed && "garbled" in parsed) {
    return {
      ...base,
      kind: "unresolvable-ref",
      detail: `"@${parsed.garbled}" is not something a ref can claim. Use @declared, @used, or @declared+used.`,
    };
  }
  const symbol = parsed?.symbol;
  const assertion = parsed?.assertion;
  /** A `/`-prefixed symbol, with or without a method token, is a route claim. */
  const route = symbol === undefined ? undefined : routeOf(symbol);
  /** The finding an assertion verdict turns into, worded for where it looked. */
  const failed = (
    verdict: { kind: "missing-declaration" | "unused-symbol" },
    where: string,
  ): DriftFinding => ({
    ...base,
    kind: verdict.kind,
    detail:
      verdict.kind === "missing-declaration"
        ? `${where} no longer declares ${symbol}.`
        : `${where} mentions ${symbol} but never uses it beyond its declaration.`,
  });

  // A trailing slash says "directory" outright. That is the point of allowing
  // it: what `src/engine` means should not depend on what happens to be on disk
  // the day it is read.
  const explicitDirectory = rawTarget.endsWith("/");
  const target = explicitDirectory ? rawTarget.replace(/\/+$/, "") : rawTarget;

  if (route && (explicitDirectory || target.includes("*"))) {
    return {
      ...base,
      kind: "unresolvable-ref",
      detail: `${route.route} is a route, which one file serves. ${rawTarget} is not one file.`,
    };
  }

  const glob = globOf(target);
  if (target.includes("*") && !glob) {
    return {
      ...base,
      kind: "unresolvable-ref",
      detail: `${target} puts * outside the last path segment. One directory can be listed, never searched.`,
    };
  }

  const lookup = glob ? glob.directory : target;
  const absolute = workspace.resolve(lookup);
  if (!absolute) {
    // An inferred ref is a reading of someone's label, not a claim they made.
    // A label pointing outside the repo just is not a code reference.
    if (provenance === "inferred") return { skip: "ref-outside-repo" };
    return { ...base, kind: "unresolvable-ref", detail: `${lookup} is outside the repository.` };
  }

  const found = workspace.stat(absolute);
  if (found === "missing") {
    return { ...base, kind: "missing-file", detail: `${lookup} no longer exists.` };
  }

  if (glob) {
    if (found !== "directory") {
      return { ...base, kind: "unresolvable-ref", detail: `${glob.directory} is not a directory.` };
    }
    const matched = filesIn(absolute, workspace, glob.pattern);
    if (matched === undefined) return { skip: "anchor-too-large" };
    if (matched.length === 0) {
      return { ...base, kind: "empty-ref", detail: `${target} matches no files.` };
    }
    if (!symbol) return "ok";
    const code = matched.filter((name) => TS_JS.test(name)).map((name) => `${absolute}/${name}`);
    if (!mentionedIn(code, symbol, workspace)) {
      return { ...base, kind: "missing-symbol", detail: `no file matching ${target} mentions ${symbol}.` };
    }
    if (!assertion) return "ok";
    const verdict = assertedIn(code, symbol, assertion, workspace, tally);
    return typeof verdict === "object" ? failed(verdict, `no file matching ${target}`) : "ok";
  }

  if (found === "directory") {
    const inside = filesIn(absolute, workspace);
    if (inside === undefined) return { skip: "anchor-too-large" };
    if (workspace.list(absolute).length === 0) {
      return { ...base, kind: "empty-ref", detail: `${target} is empty.` };
    }
    if (!symbol) return "ok";
    // A symbol asked for inside a directory used to be unresolvable. It is a
    // reasonable thing to mean -- "this lives somewhere in here" -- and one
    // listing plus that directory's own files answers it.
    const code = inside.filter((name) => TS_JS.test(name)).map((name) => `${absolute}/${name}`);
    if (code.length === 0) {
      return {
        ...base,
        kind: "unresolvable-ref",
        detail: `${target} holds no TypeScript or JavaScript, so ${symbol} cannot be looked for there.`,
      };
    }
    if (!mentionedIn(code, symbol, workspace)) {
      return { ...base, kind: "missing-symbol", detail: `nothing directly in ${target} mentions ${symbol}.` };
    }
    if (!assertion) return "ok";
    const verdict = assertedIn(code, symbol, assertion, workspace, tally);
    return typeof verdict === "object" ? failed(verdict, `nothing directly in ${target}`) : "ok";
  }

  if (explicitDirectory) {
    return { ...base, kind: "unresolvable-ref", detail: `${target}/ is a file, not a directory.` };
  }
  if (route) {
    const pool = routePool(absolute, target, workspace, importCache);
    // A file writing no route literals at all is a file whose routing cannot be
    // read. Skipped and counted, never guessed at -- the same answer this gives
    // for a language it has no reader for.
    if (pool.size === 0) return { skip: "no-route-literals" };
    if (poolShows(pool, route.route)) return "ok";
    return {
      ...base,
      kind: "missing-route",
      detail: `${target} no longer serves ${route.route}.`,
    };
  }
  if (!symbol) return "ok";
  const source = workspace.read(absolute);
  if (!mentions(source, symbol)) {
    return { ...base, kind: "missing-symbol", detail: `${target} no longer mentions ${symbol}.` };
  }
  if (!assertion) return "ok";
  const verdict = judgeAssertion(target, source, symbol, assertion, tally);
  return typeof verdict === "object" ? failed(verdict, target) : "ok";
}

/**
 * What one run has already read off disk.
 *
 * Imports are cached per file, and the tsconfig a file resolves its nicknames
 * against is cached per directory. Both belong to one run and neither outlives
 * it: a config read once and remembered forever is a fact with a shelf life,
 * which is the rot this whole check exists to catch.
 */
export interface ReadCache {
  imports: Map<string, Array<{ abs: string; rel: string }>>;
  configs: ConfigCache;
}

/**
 * Every import in a file, cached per file within one check.
 *
 * Two readers behind one question, chosen by the file's licence: JavaScript and
 * TypeScript by the regex below, everything else measured by `deps.ts`. Callers
 * ask "what does this file import" and get one answer either way, which is the
 * point -- a caller that had to know the language would be a fourth place the
 * engine could disagree with itself about which languages it can read.
 *
 * The regex is over-eager and always has been, which is survivable because this
 * is a *confirming* channel: a specifier it invents either resolves to a real
 * file, and the confirmation is at worst generous, or it is dropped. It is not
 * evidence any "wrong" verdict may rest on -- `deps.ts` reads the grammar for
 * that, and refuses what this cannot tell apart. Measured over this repo the
 * difference is a single edge: `path.join(import.meta.dirname,
 * "../docs/diagrams/board-internals.excalidraw")` reads here as an import of a
 * diagram.
 *
 * Resolution itself moved to `resolve.ts` and is now shared with that reader.
 * One resolver, because two would drift apart, and the day they disagreed is
 * the day a verdict rested on a path the other channel never tried. The move
 * brought tsconfig nicknames (`@/engine/foo`) along, which this never handled;
 * on this repo that changes nothing, since it declares none.
 */
function getImports(
  fileAbsolute: string,
  fileRelative: string,
  workspace: Workspace,
  cache: ReadCache,
): Array<{ abs: string; rel: string }> {
  if (cache.imports.has(fileAbsolute)) {
    return cache.imports.get(fileAbsolute)!;
  }

  const imports: Array<{ abs: string; rel: string }> = [];
  const found = workspace.stat(fileAbsolute);
  if (found !== "file") {
    cache.imports.set(fileAbsolute, imports);
    return imports;
  }

  /*
   * A language with a licence but not this regex is read by `deps.ts` instead.
   *
   * The regex below knows the shape of a JavaScript import and nothing else, so
   * pointing it at Rust finds no dependencies at all -- and an empty answer is
   * indistinguishable here from a file that genuinely imports nothing, which is
   * how a confirming channel starts flagging true arrows. `deps.ts` returns the
   * same fields for either language, so what changes is the reader and not the
   * shape.
   *
   * `complete` and `dynamic` are deliberately not consulted. They exist so a
   * *refutation* can be withheld from a file we could not fully read; this is a
   * confirming caller, and a confirmation off a partly-read file is at worst
   * generous -- the same trade the regex has always made.
   */
  const language = licensedLanguage(fileRelative);
  if (!language) {
    cache.imports.set(fileAbsolute, imports);
    return imports;
  }

  const source = workspace.read(fileAbsolute);

  if (language !== "typescript") {
    const read = readDependencies(fileRelative, source, workspace, cache.configs);
    for (const dependency of read?.dependencies ?? []) {
      if (!dependency.file) continue;
      const absolute = workspace.resolve(dependency.file);
      if (!absolute || imports.some((existing) => existing.abs === absolute)) continue;
      imports.push({ abs: absolute, rel: dependency.file });
    }
    cache.imports.set(fileAbsolute, imports);
    return imports;
  }

  // Match relative imports: import x from "path", require("path"), import("path"), export ... from "path"
  // Patterns:
  //   - import ... from "path" / export ... from "path"
  //   - require("path")
  //   - import("path")
  //   - import "path" (rarely used but valid)
  const importRegex = /(?:import|export|require|from)\s+[^"'`]*?["'`](\.[^"'`]+)["'`]|require\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\)|import\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g;
  let match;
  while ((match = importRegex.exec(source)) !== null) {
    const spec = match[1] || match[2] || match[3];
    if (spec) {
      const resolved = resolveDependency(spec, fileRelative, workspace, cache.configs);
      if (resolved) {
        imports.push(resolved);
      }
    }
  }

  cache.imports.set(fileAbsolute, imports);
  return imports;
}

/**
 * The regex channel's imports for one file, exposed for measurement only.
 *
 * The licence step compares a parsed reader against this, and the comparison is
 * only worth anything if it runs the *actual* channel rather than a paraphrase
 * of it. Never call this as evidence: it is the over-eager one, and knowing by
 * how much is the entire point of exporting it.
 */
export function regexImports(
  fileAbsolute: string,
  fileRelative: string,
  workspace: Workspace,
): Array<{ abs: string; rel: string }> {
  return getImports(fileAbsolute, fileRelative, workspace, { imports: new Map(), configs: new Map() });
}

/**
 * Extract route literals (strings starting with "/") from a file.
 */
function getRouteLiterals(file: string, workspace: Workspace): Set<string> {
  const routes = new Set<string>();
  const found = workspace.stat(file);
  if (found !== "file") {
    return routes;
  }

  const source = workspace.read(file);
  // Match: /(\/[A-Za-z0-9_\-./:]+)/
  const routeRegex = /(['"`])(\/[A-Za-z0-9_\-./:]+)\1/g;
  let match;
  while ((match = routeRegex.exec(source)) !== null) {
    const route = match[2];
    if (route && route.length > 1) {
      routes.add(route);
    }
  }

  return routes;
}

/**
 * Route literals a file can be held to: its own, plus its direct imports'.
 *
 * One hop, the same neighbourhood the arrow check already reads, because a
 * server that registers its handlers in one file and names them in another is
 * ordinary and neither file alone tells the truth.
 */
function routePool(
  fileAbsolute: string,
  fileRelative: string,
  workspace: Workspace,
  importCache: ReadCache,
): Set<string> {
  const pool = new Set(getRouteLiterals(fileAbsolute, workspace));
  for (const imported of getImports(fileAbsolute, fileRelative, workspace, importCache)) {
    for (const literal of getRouteLiterals(imported.abs, workspace)) pool.add(literal);
  }
  return pool;
}

/**
 * Whether the pool shows this route.
 *
 * Exact match, or either string ending in the other. That second clause is for
 * composed routing: `router.use("/api")` plus `.get("/board")` serves
 * `/api/board` without writing it anywhere, and every route literal in this
 * repo happens to be whole only because this repo compares `url.pathname`
 * directly. A framework that composes is the common case elsewhere, and a
 * composed route reading as absent would be a loud wrong answer -- so partial
 * evidence resolves quiet, like every other doubt here.
 */
function poolShows(pool: Set<string>, route: string): boolean {
  if (pool.has(route)) return true;
  for (const literal of pool) {
    if (literal.length < 2) continue;
    if (route.endsWith(literal) || literal.endsWith(route)) return true;
  }
  return false;
}

/**
 * Every symbol a box names, for a language whose bodies can be read.
 *
 * A box standing for a feature lists several -- a static and the macro using
 * it -- and any one of them being reached satisfies the arrow. That is also
 * the whole of concept membership: a box's `refs` are the symbols whose
 * invocation counts as using it, and one caller naming any member is enough.
 */
function symbolsOf(node: { ref?: string; refs?: string[] }, file: string): string[] {
  if (!languageOf(file)) return [];
  const anchors = [node.ref, ...(node.refs ?? [])];
  const symbols = new Set<string>();
  for (const anchor of anchors) {
    const raw = anchor?.trim();
    if (!raw) continue;
    const { symbol } = parseRef(raw);
    if (!symbol) continue;
    const parsed = parseSymbol(symbol);
    // A garbled assertion is already reported by the node check; here it is
    // simply not a symbol worth searching for.
    // A route is not a name to search bodies for. Defensive rather than
    // load-bearing today -- a `/`-prefixed string cannot be an identifier, so
    // the search would come back empty -- but it was load-bearing when symbols
    // were matched as raw text and says outright what a route is not.
    if ("garbled" in parsed || routeOf(parsed.symbol)) continue;
    symbols.add(parsed.symbol);
  }
  return [...symbols];
}

/**
 * The symbols a box lists, grouped by the file they live in.
 *
 * Grouped because the self-support rule is a question about one file's text:
 * a box spanning `logging.rs` and `server.rs` is making two local claims, not
 * one that spans them.
 */
function membersByFile(
  node: { ref?: string; refs?: string[] },
  workspace: Workspace,
): Array<[{ path: string; absolute: string; language: Language }, string[]]> {
  const byFile = new Map<string, { file: { path: string; absolute: string; language: Language }; symbols: string[] }>();
  for (const anchor of [node.ref, ...(node.refs ?? [])]) {
    const raw = anchor?.trim();
    if (!raw) continue;
    const { path: target, symbol } = parseRef(raw);
    if (!symbol) continue;
    const parsed = parseSymbol(symbol);
    // A route is not a name to search bodies for. Defensive rather than
    // load-bearing today -- a `/`-prefixed string cannot be an identifier, so
    // the search would come back empty -- but it was load-bearing when symbols
    // were matched as raw text and says outright what a route is not.
    if ("garbled" in parsed || routeOf(parsed.symbol)) continue;
    const absolute = workspace.resolve(target);
    if (!absolute || workspace.stat(absolute) !== "file") continue;
    const language = languageOf(absolute);
    if (!language) continue;
    const entry = byFile.get(absolute)
      ?? { file: { path: target, absolute, language }, symbols: [] };
    if (!entry.symbols.includes(parsed.symbol)) entry.symbols.push(parsed.symbol);
    byFile.set(absolute, entry);
  }
  return [...byFile.values()].map((entry) => [entry.file, entry.symbols]);
}

type SymbolEdgeVerdict = "reached" | "unreached" | "unreadable";

/**
 * What the body search found, and -- when it found nothing -- whether the
 * question it asked was the right one.
 *
 * `dataEnds` is the second half, and it is the difference between "these two
 * functions do not call each other" and "one of these ends is not a function at
 * all". A name declaring a struct, a static or a field has no body that calls
 * anything, so an end anchored at one turns a call search into a question the
 * code cannot answer either way (#133). The names are carried out so the reader
 * can be told which end to re-anchor.
 */
interface SymbolEdgeResult {
  verdict: SymbolEdgeVerdict;
  dataEnds: string[];
}

/**
 * Does either end's function body reach the other, directly or in one hop?
 *
 * Both directions are tried and any evidence is enough: an arrow means these
 * two are connected, and the diagram's sense of direction is a reading of the
 * design rather than a claim about who calls whom.
 */
function checkSymbolEdge(
  from: { file: string; path: string; symbols: string[] },
  to: { file: string; path: string; symbols: string[] },
  workspace: Workspace,
): SymbolEdgeResult {
  let asked = false;
  /*
   * Ends whose every name declares data rather than something that runs.
   *
   * Per end, not per name: a box listing `LOGGER` and `log_line` is answerable
   * through the callable one, and one static among several names does not make
   * the question a bad one. An end where *nothing* runs is different -- there is
   * no body on that side to search from, and the relationship it stands in is
   * almost always a type in a signature, a field, or an enclosing impl, none of
   * which is inside any body. That is the shape this exists to name.
   *
   * Collected while the search runs, because the search reads the same
   * declarations anyway -- and only ever read on the way out, when nothing was
   * found. A reached arrow does not care what shape its ends are.
   */
  const dataEnds: string[] = [];
  for (const [start, target] of [[from, to], [to, from]] as const) {
    const language = languageOf(start.file);
    if (!language) continue;
    const source = workspace.read(start.file);
    let runs = false;
    let declared = false;
    for (const symbol of start.symbols) {
      const declarations = declarationsOf(source, symbol, language);
      if (declarations.length > 0) declared = true;
      if (declarations.some((one) => one.kind === "callable")) runs = true;
      const verdict = reaches(source, symbol, target.symbols, language);
      if (verdict === undefined) continue;
      asked = true;
      if (verdict) return { verdict: "reached", dataEnds: [] };
    }
    /*
     * Only once the whole end has been read, and only when something there was
     * actually declared. A name the file does not declare at all is not data --
     * it is a missing symbol, which the node check reports on its own, and
     * calling it data here would be the report inventing a second diagnosis for
     * one mistake.
     */
    if (declared && !runs) dataEnds.push(start.symbols.join(" / "));
  }
  return { verdict: asked ? "unreached" : "unreadable", dataEnds };
}

/**
 * Whether edge A → B is backed by one of the five corroboration channels:
 * imports either way, a shared importer, a shared route string, the code graph.
 * Assumes both files are valid TS/JS files.
 *
 * An answer rather than a finding (#133). Every channel here confirms and none
 * refutes, so the only thing this can honestly report is whether one of them
 * fired -- and, when none did, which ones were even able to run. What to *do*
 * about that belongs to the caller, which is the only place that knows whether
 * the arrow claimed anything.
 */
type Corroboration = { confirmed: true } | { confirmed: false; detail: string };

function corroborates(
  fromRef: string,
  toRef: string,
  workspace: Workspace,
  importCache: ReadCache,
  sharedImporterCandidates: Map<string, string>,
  codeGraphOption?: CodeGraphOption,
): Corroboration {
  // Parse refs: keep only path, ignore symbol
  const { path: fromPath } = parseRef(fromRef);
  const { path: toPath } = parseRef(toRef);

  // Resolve both files (already validated above)
  const fromFileAbs = workspace.resolve(fromPath)!;
  const toFileAbs = workspace.resolve(toPath)!;

  // Channel 1: A imports B
  const importsFrom = getImports(fromFileAbs, fromPath, workspace, importCache);
  if (importsFrom.some((imp) => imp.abs === toFileAbs)) {
    return { confirmed: true };
  }

  // Channel 2: B imports A
  const importsTo = getImports(toFileAbs, toPath, workspace, importCache);
  if (importsTo.some((imp) => imp.abs === fromFileAbs)) {
    return { confirmed: true };
  }

  // Channel 3: Shared importer — any file C that imports both A and B
  // C = sharedImporterCandidates (hoisted from checkDrift)
  for (const [file, fileRel] of sharedImporterCandidates) {
    const fileImports = getImports(file, fileRel, workspace, importCache);
    if (
      fileImports.some((imp) => imp.abs === fromFileAbs)
      && fileImports.some((imp) => imp.abs === toFileAbs)
    ) {
      return { confirmed: true };
    }
  }

  /*
   * Channel 4: Shared route literal, one hop out. TypeScript only, and
   * deliberately not widened with the language gate that let this function see
   * Rust at all.
   *
   * The three channels above are `deps.ts`, and `deps.ts` answers only for
   * languages `licence.ts` has a corpus for. This one is a regex over string
   * literals that begin with a slash, and the only routing it was ever tried
   * against was a TypeScript one -- a licence is per language, and a channel
   * nobody has measured on Rust has not earned Rust. It would very likely fire
   * on `Router::new().route("/users", ..)`; "very likely" is the word this
   * whole file exists to refuse.
   *
   * So the gate widened three readers and left the fourth where it was
   * measured, and the amber below names only the channels that ran.
   */
  const routesReadable = licensedLanguage(fromPath) === "typescript"
    && licensedLanguage(toPath) === "typescript";

  if (routesReadable) {
    const fromRoutes = new Set([
      ...getRouteLiterals(fromFileAbs, workspace),
    ]);
    for (const imp of importsFrom) {
      for (const route of getRouteLiterals(imp.abs, workspace)) {
        fromRoutes.add(route);
      }
    }

    const toRoutes = new Set([
      ...getRouteLiterals(toFileAbs, workspace),
    ]);
    for (const imp of importsTo) {
      for (const route of getRouteLiterals(imp.abs, workspace)) {
        toRoutes.add(route);
      }
    }

    if ([...fromRoutes].some((route) => toRoutes.has(route))) {
      return { confirmed: true };
    }
  }

  // Channel 5: the code graph — precomputed whole-repo connectivity. It only
  // ever confirms, and it is consulted last, so with it off (or stale for
  // these files) the check behaves exactly as it did before the channel.
  if (codeGraphConfirms(codeGraphOption, wholeRef(fromPath), wholeRef(toPath))) {
    return { confirmed: true };
  }

  /*
   * No channel fires. Not a verdict -- the caller counts it -- but the sentence
   * comes from here, because this is the only place that knows which channels
   * actually ran: the route channel is TypeScript-only, and a message claiming
   * it had run is the same kind of untrue as the skip reason that replaced.
   */
  return {
    confirmed: false,
    detail: `nothing in ${fromPath} ${routesReadable
      ? "imports, is imported by, shares an importer with, or shares a route string with"
      : "imports, is imported by, or shares an importer with"} ${toPath}.`,
  };
}

/**
 * The code graph may confirm an arrow only when it is loaded and both endpoint
 * refs (file or directory) are untouched since the graph's commit. Anything
 * else is a "no", never an error: staleness falls back to the live channels.
 *
 * An endpoint has two refs and they are deliberately not the same one. The
 * *anchor* is what has to be untouched, and the *evidence* is what the graph
 * may speak from. For a file or a directory they are one path. For a glob they
 * are not: it is anchored to the directory it lists, because a file appearing
 * in or vanishing from that directory changes which files the box stands for
 * and the graph would not know -- while the evidence is only the files the
 * glob actually matches, because `*.ts` did not name the `.py` beside it.
 *
 * Strict about when it may speak, exact about what it speaks from.
 */
function codeGraphConfirms(
  option: CodeGraphOption | undefined,
  from: { anchor: string; evidence: string | readonly string[] },
  to: { anchor: string; evidence: string | readonly string[] },
): boolean {
  if (!option) return false;
  if (refIsStale(from.anchor, option.modified) || refIsStale(to.anchor, option.modified)) return false;
  return connects(option.graph, from.evidence, to.evidence);
}

/** The plain case: anchor and evidence are the same path. */
function wholeRef(ref: string): { anchor: string; evidence: string } {
  return { anchor: ref, evidence: ref };
}

/**
 * What an arrow endpoint anchors to, and what the graph may speak from.
 *
 * A glob is the only shape where those differ. It lists one directory, so the
 * evidence is exactly the entries matching the pattern -- not the directory,
 * which would let `src/mcp/*.ts` be confirmed through a `.py` file in a
 * subdirectory, on evidence the box never claimed.
 *
 * Three ways to have no evidence at all, and all of them read as "the graph
 * cannot answer this" rather than as an error:
 *
 * - a `*` outside the last path segment, which `globOf` refuses to list;
 * - a directory with more entries than `filesIn` will read, the same cap a
 *   node-level anchor is held to;
 * - a pattern matching nothing, where there is nothing to speak from.
 */
function edgeEndpoint(
  refPath: string,
  absolute: string,
  workspace: Workspace,
): { anchor: string; evidence: readonly string[] } | undefined {
  const glob = globOf(refPath);
  if (!glob) return undefined;
  const matched = filesIn(absolute, workspace, glob.pattern);
  if (matched === undefined || matched.length === 0) return undefined;
  const directory = glob.directory === "." ? "" : `${glob.directory}/`;
  return { anchor: glob.directory, evidence: matched.map((name) => `${directory}${name}`) };
}

/**
 * Coverage information from a board: what files it covers and how to test coverage.
 *
 * A board covers a file if a node ref resolves to that file, or a directory/glob
 * ref covers it. This logic is reused by checkDrift and computeHonestGaps to
 * keep interpretations in sync.
 *
 * Returns an object with onBoard map and a covered function for testing.
 */
export function boardCoverage(
  graph: { nodes: Array<{ ref?: string; refs?: string[]; state?: string }> },
  workspace: Workspace,
): { onBoard: Map<string, string>; covered: (absolute: string) => boolean } {
  const onBoard = new Map<string, string>();  // absolute -> repo-relative
  const directories: string[] = [];

  for (const node of graph.nodes) {
    if (node.state === "external") continue;
    for (const ref of [node.ref, ...(node.refs ?? [])]) {
      const anchor = ref?.trim();
      if (!anchor) continue;
      const { path: target } = parseRef(anchor);
      // A glob names a directory's worth of files; treat its directory as
      // covering them, which is what the box is claiming.
      const glob = globOf(target);
      const resolved = workspace.resolve(glob ? glob.directory : target);
      if (!resolved) continue;
      const kind = workspace.stat(resolved);
      if (glob || kind === "directory") directories.push(resolved);
      else if (kind === "file") onBoard.set(resolved, target);
    }
  }

  const covered = (absolute: string) =>
    onBoard.has(absolute)
    || directories.some((directory) => absolute.startsWith(directory.replace(/[\\/]?$/, path.sep)));

  return { onBoard, covered };
}

export function checkDrift(
  board: BoardFile,
  workspace: Workspace,
  options?: {
    edges?: boolean;
    baseline?: BoardBaseline;
    coverage?: boolean;
    codeGraph?: CodeGraphOption;
    /**
     * Which files a source index has actually read. Absent means the gate is
     * off, not that nothing was read -- see `ledger.ts`.
     */
    ledger?: Ledger;
  },
): DriftReport {
  const findings: DriftFinding[] = [];
  const workItems: WorkItem[] = [];
  const promotions: Promotion[] = [];
  let checked = 0;
  let skipped = 0;
  let edgesChecked = 0;
  let edgesSkipped = 0;
  let excused = 0;
  let handDrawn = 0;
  const skippedWhy: SkipBreakdown<NodeSkipReason> = {};
  const edgesSkippedWhy: SkipBreakdown<EdgeSkipReason> = {};
  const unannotated: UnannotatedFinding[] = [];
  const unreadEdges: UnreadEdgeFinding[] = [];
  const unconfirmedEdges: UnconfirmedEdge[] = [];
  const assertions: AssertionTally = { checked: 0, downgraded: 0, unsupportedLanguage: 0 };
  const claims: ClaimTally = {
    closed: 0, closedHeld: 0, closedTestReaches: 0,
    needs: 0, needsChecked: 0, needsWithheld: {},
  };
  const closedBreaches: ClosedBreachFinding[] = [];
  const closedUnproven: ClosedUnprovenFinding[] = [];
  const closedUnusedDoors: ClosedUnusedDoorFinding[] = [];
  const garbledClaims: GarbledClaimFinding[] = [];
  const skipNode = (reason: NodeSkipReason) => {
    skipped += 1;
    skippedWhy[reason] = (skippedWhy[reason] ?? 0) + 1;
  };
  /**
   * Every exit from the arrow check goes through here, which is the point: a
   * skip that forgets to name its arrow is the bug this is fixing, and there is
   * no second place to forget it in.
   *
   * The nodes are optional because two of the reasons fire before an endpoint
   * has resolved to a box at all; the id is a worse name than the label but it
   * is never nothing.
   */
  const skipEdge = (
    reason: EdgeSkipReason,
    edge: { from: string; to: string; label?: string },
    fromNode?: { label: string },
    toNode?: { label: string },
  ) => {
    edgesSkipped += 1;
    edgesSkippedWhy[reason] = (edgesSkippedWhy[reason] ?? 0) + 1;
    unreadEdges.push({
      from: edge.from,
      to: edge.to,
      fromLabel: fromNode?.label || edge.from,
      toLabel: toNode?.label || edge.to,
      ...(edge.label ? { label: edge.label } : {}),
      reason,
    });
  };
  /** Shared by the box checks and the arrow checks: one read per file per run. */
  const importCache: ReadCache = { imports: new Map(), configs: new Map() };

  /**
   * File one verdict about one arrow.
   *
   * A `planned` arrow is the connection you want, not one you are claiming
   * exists. Absent corroboration is then the work, and corroboration is the
   * news that the work landed.
   *
   * Three outcomes rather than the old two, and the new one carries the whole
   * of #133. `confirmed` and `finding` are unchanged: something was proved, or
   * something was proved wrong. `unconfirmed` is the third thing that was
   * always happening and had nowhere to go -- the check looked and found
   * nothing -- and it is filed as a count instead of as a verdict, because
   * absence of evidence is not evidence, however amber it is painted.
   *
   * A `planned` arrow is the one place absence still speaks, and it says the
   * opposite thing: nobody is being accused, the sketch is simply ahead of the
   * code. So the work-item branch takes unconfirmed and finding alike.
   */
  const recordEdge = (
    edge: { from: string; to: string; state: string; claim?: ArrowClaim; label?: string },
    fromNode: { label: string },
    toNode: { label: string },
    outcome: EdgeOutcome,
  ) => {
    const finding = outcome.kind === "finding" ? outcome.finding : undefined;
    if (edge.state !== "planned") {
      // Stamped here rather than at each construction site: this is the one
      // place that still holds the edge itself, and the ids name the arrow on
      // the canvas while the finding's paths name the evidence.
      if (finding) edges.push({ ...finding, node: `${edge.from} -> ${edge.to}` });
      if (outcome.kind === "unconfirmed") {
        unconfirmedEdges.push({
          from: edge.from,
          to: edge.to,
          fromLabel: fromNode.label || edge.from,
          toLabel: toNode.label || edge.to,
          ...(edge.label ? { label: edge.label } : {}),
          reason: outcome.reason,
          detail: outcome.detail,
        });
      }
      return;
    }
    const claim = `${fromNode.label || edge.from} -> ${toNode.label || edge.to}`;
    if (outcome.kind !== "confirmed") {
      workItems.push({
        node: `${edge.from} -> ${edge.to}`,
        label: claim,
        /*
         * `unsupported-edge` survives here and only here. On a built arrow it
         * was an accusation and is now a count; on a `planned` one it is the
         * plan-first flow working exactly as designed -- the connection you
         * drew has not landed yet -- which is news the board asked for.
         */
        kind: outcome.kind === "finding" ? outcome.finding.kind : "unsupported-edge",
        detail: outcome.kind === "finding" ? outcome.finding.detail : outcome.detail,
      });
    } else {
      promotions.push({
        node: `${edge.from} -> ${edge.to}`,
        label: claim,
        detail: "the code now connects these, so this is no longer planned."
          + (edge.claim === "needs"
            ? " Its @needs direction is read for the first time on the next check."
            : ""),
        ...(edge.claim ? { claim: edge.claim } : {}),
      });
    }
  };

  const graph = readGraph(board);
  // A board describing a protocol or another project makes no claims about this
  // tree, so every box on it is excused rather than reported as unannotated.
  const concept = graph.describes === "concept";

  for (const node of graph.nodes) {
    if (node.provenance !== "recorded") {
      handDrawn += 1;
      continue;
    }
    if (concept || node.state === "external") {
      excused += 1;
      continue;
    }
    const declared = node.ref?.trim();
    // Every anchor the box claims, in order, with the primary first. A box that
    // stands for a feature spread across files is clean only when all of them
    // hold, and each reports on its own so the reader learns which one broke.
    const anchors = [declared || refFromLabel(node.label), ...(node.refs ?? [])]
      .map((entry) => entry?.trim())
      .filter((entry): entry is string => Boolean(entry));
    if (anchors.length === 0) {
      // Named only on request. Concept boards and `external` boxes never reach
      // here -- they were excused above -- so this list is exactly the boxes
      // that claim to be about this repo and say nothing about where.
      if (options?.coverage) unannotated.push({ node: node.id, label: node.label });
      skipNode("no-ref");
      continue;
    }

    // Counted once per box, not once per anchor: the numbers are about how much
    // of the diagram was read, and a box is one thing on the diagram.
    let anyChecked = false;
    /** Why the last anchor could not be read, for the count if none could. */
    let unread: NodeSkipReason = "ref-outside-repo";
    for (const anchor of anchors) {
      const isDeclared = anchor === declared || (node.refs ?? []).includes(anchor);
      const result = inspect(
        node,
        anchor,
        isDeclared ? "recorded" : "inferred",
        workspace,
        assertions,
        importCache,
      );
      if (typeof result === "object" && "skip" in result) {
        unread = result.skip;
        continue;
      }
      anyChecked = true;

      if (node.state === "planned") {
        if (result === "ok") {
          promotions.push({
            node: node.id,
            label: node.label,
            ref: anchor,
            detail: `${anchor} exists now, so this is no longer planned.`,
          });
        } else if (result.kind === "unresolvable-ref") {
          // Not a thing waiting to be built: the ref is malformed or escapes the
          // root, and writing the code would not make it resolve.
          findings.push(result);
        } else {
          workItems.push({
            node: node.id,
            label: node.label,
            ref: anchor,
            kind: result.kind,
            detail: result.detail,
          });
        }
        continue;
      }

      if (result !== "ok") findings.push(result);
    }
    // Every anchor was unreadable. One box, one count, and the reason is the
    // one the last anchor gave rather than a stand-in: a directory too large to
    // read and a label pointing outside the tree used to be counted as the same
    // thing, which made the breakdown say something that had not happened.
    if (anyChecked) checked += 1;
    else skipNode(unread);

    /*
     * A concept box has to hold together.
     *
     * Listing several symbols is how a box says "these are the ways to use
     * this thing", and it is what lets one arrow into the box be satisfied by
     * any one member. That generosity has a hole: cut the deepest call and
     * every caller still calls a listed member, so the arrows stay green while
     * the concept has been hollowed out.
     *
     * So a member that runs has to name another member. The claim is not
     * trusted, it is checked -- every turn, like everything else.
     */
    for (const [file, members] of membersByFile(node, workspace)) {
      for (const orphan of unsupportedMembers(workspace.read(file.absolute), members, file.language)) {
        findings.push({
          node: node.id,
          label: node.label,
          ref: `${file.path}#${orphan}`,
          kind: "unsupported-member",
          provenance: "recorded",
          detail:
            `${orphan} is listed as part of this box, and its body names none of `
            + `${members.filter((other) => other !== orphan).join(", ")}.`,
        });
      }
    }
  }

  /*
   * What the board stopped saying.
   *
   * Every other check reads the board as it is, so removing a box removes the
   * findings about it: measured on this repo, deleting one box dropped the refs
   * checked from 12 to 11 and the edges from 13 to 11, and reported nothing. The
   * quietest possible diagram is an empty one.
   *
   * Matching is on the semantic node id, not the element id: regeneration writes
   * new elements and keeps node ids, so anything keyed on elements would call
   * every redraw a deletion. A node still present with a different ref is not a
   * deletion either -- the ordinary checks own that.
   */
  const deleted: DeletedClaimFinding[] = [];
  const deletedEdges: DeletedEdgeFinding[] = [];
  const baseline = options?.baseline?.committed();
  let baselineGraph: RecoveredGraph | undefined;
  if (baseline) {
    baselineGraph = readGraph(baseline);
    const live = new Set(graph.nodes.map((node) => node.id));
    for (const was of baselineGraph.nodes) {
      if (was.provenance !== "recorded" || was.state === "external") continue;
      const ref = was.ref?.trim();
      if (!ref || live.has(was.id)) continue;
      const { path: target } = parseRef(ref);
      const absolute = workspace.resolve(target);
      // The code went with it, so the board is telling the truth. Say nothing --
      // this silence is as load-bearing as the finding.
      if (!absolute || workspace.stat(absolute) === "missing") continue;
      deleted.push({
        node: was.id,
        label: was.label,
        ref,
        kind: "deleted-claim",
        detail: `${was.label || was.id} (${target}) was removed from the diagram, but `
          + "that file still exists. Committing the diagram makes the removal final.",
      });
    }
  }

  /*
   * What the board claims, read but not judged.
   *
   * Its own pass, deliberately outside the corroboration block below, because a
   * claim is not a corroboration question. Edge checking is off on a concept
   * board and can be switched off outright; a word that means nothing is still a
   * word that means nothing, and the turn it is written is the only turn its
   * author is still there to fix it.
   */
  for (const edge of graph.edges) {
    if (edge.claim) claims[edge.claim] += 1;
    if (edge.claimGarbled !== undefined) {
      const fromNode = graph.nodes.find((node) => node.id === edge.from);
      const toNode = graph.nodes.find((node) => node.id === edge.to);
      garbledClaims.push({
        on: "arrow",
        label: `${fromNode?.label || edge.from} → ${toNode?.label || edge.to}`,
        written: edge.claimGarbled,
        detail: arrowClaimError(edge.claimGarbled),
      });
    }
  }
  for (const node of graph.nodes) {
    if (node.claimGarbled === undefined) continue;
    garbledClaims.push({
      on: "box",
      label: node.label || node.id,
      written: node.claimGarbled,
      detail: boxClaimError(node.claimGarbled),
    });
  }

  /*
   * `closed` boxes: the one check here that reads files the board never names.
   *
   * Everything else in this file is bounded by the diagram -- a box names a
   * file, an arrow names two. A `closed` box makes a claim about *every* file in
   * the repository, so proving it means walking the tree, and that walk is
   * exactly the cost this file otherwise goes out of its way to avoid.
   *
   * So it is paid only by the boards that ask for it: no `closed` box, no walk.
   * One walk covers however many closed boxes a board carries, and it is the
   * same walk the coverage suggestion already uses, cap and skip list included.
   *
   * `external` and `planned` are both excused, and not for the same reason. An
   * external box stands for code that is not ours; there is no tree to walk. A
   * `planned` box stands for a directory that does not exist yet, and its
   * `closed` is the boundary the subsystem is *meant* to hold once built -- the
   * same shape of statement `needs` makes on a planned arrow, and gated the same
   * way (#123). Grading it now would read the absent directory as "not a
   * directory" and file an `open-box` regression against work nobody has started,
   * which is the one thing `planned` exists to prevent: a build must not fail
   * because somebody sketched next week's subsystem. The gate releases itself --
   * the directory landing promotes the box to `built`, and the very next run
   * checks the claim for real.
   */
  const closedBoxes = graph.nodes.filter(
    (node) => node.claim?.closed && node.provenance === "recorded"
      && node.state !== "external" && node.state !== "planned",
  );
  if (closedBoxes.length > 0 && !concept) {
    const rootAbsolute = workspace.resolve(".");
    const walked = rootAbsolute ? sourceFilesUnder(rootAbsolute, workspace) : undefined;
    const relative = (absolute: string) =>
      rootAbsolute ? path.relative(rootAbsolute, absolute).split(path.sep).join("/") : absolute;
    /*
     * The walk plus whatever the ledger knows about the places the walk will not
     * go.
     *
     * `sourceFilesUnder` skips dotted directories and the vendored ones outright,
     * and says nothing about having done so. For every other caller that is a
     * sensible tidiness rule; for this one it is a hole, because a script in a
     * hidden directory can import straight into the box and the box would go
     * green on a walk that never opened it. The ledger is a second tool's list of
     * what is in there, so those files get read after all -- and if one of them
     * reaches in, that is a breach with a line number, not a shrug.
     *
     * Additive only. A file the ledger has never heard of is not held against
     * `closed`: we read the text ourselves and absence of an import in it is our
     * own evidence, not graphify's. See `ledgerAdditions`.
     */
    const walkedRelative = (walked ?? []).map(relative);
    const files = walked === undefined
      ? walkedRelative
      : [...walkedRelative, ...ledgerAdditions(options?.ledger, walkedRelative, workspace)];

    for (const node of closedBoxes) {
      claims.closed += 1;
      const anchor = node.ref?.trim();
      const target = anchor ? parseRef(anchor).path : undefined;
      const resolved = target ? workspace.resolve(target) : undefined;

      /*
       * A `closed` box has to stand for a directory. Anything else is a claim
       * about a set with one thing in it, which is not what anybody means by
       * closed, and it is refused rather than answered -- reading it as "nobody
       * imports this file" would quietly turn a boundary claim into a
       * dead-code claim.
       */
      if (!target || !resolved || workspace.stat(resolved) !== "directory") {
        findings.push({
          node: node.id,
          label: node.label || node.id,
          ref: anchor ?? "",
          kind: "open-box",
          provenance: "recorded",
          detail: anchor
            ? `@closed says nothing outside this directory reaches in, and ${target} is not a `
              + "directory. Point the box at a directory, or drop the claim."
            : "@closed needs a directory to be about, and this box has no ref.",
        });
        continue;
      }

      const verdict = checkClosed(
        target,
        node.claim!.through,
        files,
        workspace,
        (file) => TEST_FILE.test(file),
        importCache.configs,
        walked === undefined,
      );
      claims.closedTestReaches += verdict.fromTests.length;

      if (verdict.breaches.length > 0) {
        /*
         * One finding per box, not per breach.
         *
         * Twenty imports into a subsystem is one broken boundary, and twenty
         * rows saying so is how a report stops being read. The worst offender
         * is named in full and the rest are counted; `--details` has them all.
         */
        const [first, ...rest] = verdict.breaches;
        findings.push({
          node: node.id,
          label: node.label || node.id,
          ref: anchor ?? target,
          kind: "open-box",
          provenance: "recorded",
          detail: `${first!.file} line ${first!.line} imports "${first!.specifier}", reaching `
            + `${first!.into} inside ${target}`
            + (rest.length > 0 ? `, and ${rest.length} more ${rest.length === 1 ? "import does" : "imports do"} the same` : "")
            + ". Add it to the box's doors, or stop reaching in.",
        });
        closedBreaches.push(
          ...verdict.breaches.map((breach) => ({ node: node.id, label: node.label || node.id, ...breach })),
        );
        continue;
      }

      /*
       * No breach found is not the same sentence as closed.
       *
       * The claim is about every file there is, so it holds only if every file
       * was read to the end. A walk that quietly skipped what it could not parse
       * would paint the box green on the strength of files nothing opened, which
       * is the one thing this tool exists not to do. Unproven is reported as a
       * gap rather than as a failure: the board is not wrong, it is unchecked.
       */
      if (verdict.capped || verdict.unread.length > 0) {
        closedUnproven.push({
          node: node.id,
          label: node.label || node.id,
          ref: anchor ?? target,
          unread: verdict.capped ? [] : verdict.unread,
          capped: verdict.capped,
        });
        continue;
      }
      claims.closedHeld += 1;
      if (verdict.unusedDoors.length > 0) {
        closedUnusedDoors.push({
          node: node.id,
          label: node.label || node.id,
          doors: verdict.unusedDoors,
        });
      }
    }
  }

  // Edge checking: check each generated edge for corroboration
  const edges: EdgeDriftFinding[] = [];


  if (options?.edges !== false && !concept) {
    const nodeById = new Map<string, typeof graph.nodes[0]>();
    for (const node of graph.nodes) {
      nodeById.set(node.id, node);
    }

    // Build shared importer candidates once per board:
    // every recorded-ref code file + their direct imports (one hop out)
    const sharedImporterCandidates = new Map<string, string>();  // absolute path -> repo-relative path
    for (const node of graph.nodes) {
      const nodeRef = node.ref?.trim();
      if (!nodeRef) continue;
      const { path: nodePath } = parseRef(nodeRef);
      const resolved = workspace.resolve(nodePath);
      if (resolved && workspace.stat(resolved) === "file") {
        sharedImporterCandidates.set(resolved, nodePath);
      }
    }

    // Expand with direct imports (one hop) — for imported files, use their repo-relative path
    for (const [file, fileRel] of sharedImporterCandidates) {
      const fileImports = getImports(file, fileRel, workspace, importCache);
      for (const imp of fileImports) {
        if (!sharedImporterCandidates.has(imp.abs)) {
          sharedImporterCandidates.set(imp.abs, imp.rel);
        }
      }
    }

    for (const edge of graph.edges) {
      /*
       * Skip on how the endpoints were resolved, not on who drew the arrow.
       *
       * An arrow bound at both ends points at two shapes and keeps pointing at
       * them when either one moves, whoever drew it -- so a hand-drawn bound
       * arrow between two generated nodes is exactly as precise a claim as a
       * generated edge, and that is the diagram-driven-development case: you
       * sketch the connection you want between components that already exist.
       * Keying on authorship skipped it silently.
       *
       * `nearest` stays skipped. Those endpoints were matched to whichever shape
       * they landed close to, which is an observation about geometry rather than
       * a claim about the design.
       */
      // Resolved before the first skip rather than after it: these are two map
      // lookups with no side effects, and doing them up here is what lets every
      // exit below name the arrow by its box labels instead of its raw ids.
      const fromNode = nodeById.get(edge.from);
      const toNode = nodeById.get(edge.to);

      /*
       * An arrow carrying `@needs` is a question somebody asked on purpose, and
       * every exit from here has to answer it -- with a verdict, or with the
       * reason there is none.
       *
       * Skipping is ordinarily right and ordinarily quiet: an arrow the checker
       * cannot read is not news. A *claimed* arrow is the exception, because
       * silence in reply to a question reads as "checked, and fine". The gates
       * below all fire before `checkNeeds` is reached, so without this the claim
       * would never be counted at all -- and the very first `@needs` written by
       * hand, on an arrow that looks right on screen, would report success.
       */
      const claimed = edge.claim === "needs" && edge.state !== "planned";
      /** Skip the arrow, and if it carried a claim, say the claim went unanswered. */
      const skipClaimedEdge = (reason: EdgeSkipReason) => {
        if (claimed) claims.needsWithheld[reason] = (claims.needsWithheld[reason] ?? 0) + 1;
        skipEdge(reason, edge, fromNode, toNode);
      };

      if (edge.endpoints === "nearest") {
        skipClaimedEdge("ends-not-bound");
        continue;
      }

      // Both endpoints must exist, be recorded, have refs
      if (!fromNode || !toNode) {
        skipClaimedEdge("endpoint-missing");
        continue;
      }

      // An arrow into something deliberately outside the repo has nothing to
      // corroborate against, and saying so would be noise, not a finding.
      if (fromNode.state === "external" || toNode.state === "external") {
        skipClaimedEdge("endpoint-external");
        continue;
      }

      const fromRef = fromNode.ref?.trim();
      const toRef = toNode.ref?.trim();
      if (!fromRef || !toRef) {
        skipClaimedEdge("endpoint-has-no-ref");
        continue;
      }

      // Parse refs and check what each end actually anchors to
      const { path: fromPath } = parseRef(fromRef);
      const { path: toPath } = parseRef(toRef);

      /*
       * A glob anchors to the directory it lists.
       *
       * `boardCoverage` makes the same conversion for the box check -- a glob
       * names a directory's worth of files, so its directory is what has to be
       * looked at -- and that is why a glob-anchored *box* has never reported
       * drift while every *arrow* touching one did. This path handed `stat` a
       * path with a `*` in it, got "missing" back, and reported the end's file
       * as deleted. The board was fine and the code was fine.
       *
       * The anchor is where the *looking* happens and not what the box claims.
       * `*.ts` claims the files it matches, so the directory is a stepping
       * stone to them and never a stand-in for them -- see `edgeEndpoint`,
       * which is where that distinction is spent.
       *
       * A `*` the glob reader refuses -- one outside the last path segment --
       * anchors to nothing at all. The box already says so loudly, as an
       * `unresolvable-ref` finding; here it is enough that the end is a
       * pattern rather than a file, which is what the skip reason says.
       */
      const fromGlob = globOf(fromPath);
      const toGlob = globOf(toPath);
      const fromPattern = fromPath.includes("*");
      const toPattern = toPath.includes("*");
      const fromAnchor = fromGlob ? fromGlob.directory : fromPath;
      const toAnchor = toGlob ? toGlob.directory : toPath;
      const fromFile = workspace.resolve(fromAnchor);
      const toFile = workspace.resolve(toAnchor);

      // Skip if either anchor is outside the repo
      if (!fromFile || !toFile) {
        skipClaimedEdge("endpoint-outside-repo");
        continue;
      }
      const fromStat = workspace.stat(fromFile);
      const toStat = workspace.stat(toFile);
      /*
       * A pattern is a set of files however its directory stats, so it never
       * reaches the two-file channels below. Letting one through would hand a
       * path with a `*` in it to a reader that resolves imports.
       */
      const fromSingle = !fromPattern && fromStat === "file";
      const toSingle = !toPattern && toStat === "file";
      if (!fromSingle || !toSingle) {
        /*
         * Three things land here and they are not the same to a reader: an end
         * standing for a subsystem is a choice, an end standing for a set of
         * files is a choice, and an end pointing at a file that is gone is
         * already reported as drift by the node check.
         *
         * Only a real path can be the third one. A well-formed glob anchors to
         * a directory, so a directory that is gone is missing in the ordinary
         * way and the box says so too. A `*` the glob reader refused anchors to
         * nothing, and `stat` answering "missing" about a path with a `*` in it
         * is not news about the repository -- reading it as news is the whole
         * of this bug.
         *
         * A pattern on either end names the arrow, even when the other end is a
         * plain directory: it is the more specific of the two shapes and the
         * more surprising thing to find on a board.
         */
        const missing = (!fromPattern || Boolean(fromGlob)) && fromStat === "missing"
          || (!toPattern || Boolean(toGlob)) && toStat === "missing";
        const shape: EdgeSkipReason = fromPattern || toPattern ? "glob-ref" : "directory-ref";
        /*
         * A box standing for a directory means everything under it, and the
         * code graph can answer that: does anything in here reach the other
         * end? Confirmed is checked; not confirmed stays a skip, because the
         * graph proving nothing proves nothing.
         *
         * A glob means the files it matches, so it is expanded to them rather
         * than answered for by its directory. A pattern the lister cannot
         * expand has no evidence and so gets no confirmation -- the skip below,
         * which is the same answer it had before the graph was consulted.
         */
        const fromEvidence = fromPattern
          ? edgeEndpoint(fromPath, fromFile, workspace)
          : wholeRef(fromAnchor);
        const toEvidence = toPattern
          ? edgeEndpoint(toPath, toFile, workspace)
          : wholeRef(toAnchor);
        if (
          !missing && fromEvidence && toEvidence
          && codeGraphConfirms(options?.codeGraph, fromEvidence, toEvidence)
        ) {
          edgesChecked += 1;
          /*
           * The connection is corroborated; the *direction* is not. `checkNeeds`
           * reads two files, and one end here stands for a whole directory or a
           * set of them, so the claim still got no verdict and still has to be
           * counted as one that got none.
           */
          if (claimed) claims.needsWithheld[shape] = (claims.needsWithheld[shape] ?? 0) + 1;
          recordEdge(edge, fromNode, toNode, { kind: "confirmed" });
          continue;
        }
        skipClaimedEdge(missing ? "endpoint-file-missing" : shape);
        continue;
      }

      /*
       * The one question with an answer that can be "wrong".
       *
       * Every other check here confirms. `needs` is the exception: the tail
       * declares a dependency on the head, which is a direction, so finding the
       * dependency *only* the other way is proof rather than a hint. That makes
       * this the first thing on a board that can fail a build on an arrow, and
       * the reason `needs.ts` is written almost entirely out of reasons to say
       * nothing.
       *
       * Four gates, all required, and three of them are already above: the arrow
       * carried the claim, its state is `built`, and `checkNeeds` refuses unless
       * both files are in a measured language, both vouched for by a source
       * index, both parsed to the end, and neither reaches out at runtime.
       *
       * A verdict of anything but `backwards` falls straight through to the
       * checks below, untouched. That is deliberate and it is what keeps the
       * claim from quietly changing anything else: a confirmed `needs` is
       * confirmed again by the ordinary channels a moment later, and an absent
       * one goes amber exactly as it did before claims existed.
       */
      if (claimed) {
        const needs = checkNeeds(fromPath, toPath, workspace, importCache.configs, options?.ledger);
        if (needs.verdict === "withheld") {
          claims.needsWithheld[needs.why] = (claims.needsWithheld[needs.why] ?? 0) + 1;
        } else if (needs.verdict === "cycle") {
          /*
           * Both directions exist, so neither arrow is more correct than the
           * other. Cycles are legal in every language licensed here, and the
           * rule is *if both directions exist, say nothing* -- never *ties do
           * not happen*. This repository has none today, which is luck rather
           * than law; Rust crates have them constantly, because a module naming
           * `crate::` and a root naming `mod` is a cycle by construction.
           */
          claims.needsWithheld.cycle = (claims.needsWithheld.cycle ?? 0) + 1;
        } else {
          claims.needsChecked += 1;
          if (needs.verdict === "backwards") {
            /*
             * Counted as checked here rather than by falling through, because
             * this exit is the only one that does not reach the channels below.
             * Leaving it out read as "1 arrow drawn backwards · 0 arrows
             * checked", which invites the reader to distrust the finding.
             */
            edgesChecked += 1;
            const { evidence } = needs;
            /*
             * A claim written this turn gets its own sentence.
             *
             * The next turn's check is the first one that sees a `needs` an agent
             * wrote a moment ago, and a bare "this is wrong" then reads as the
             * tool accusing somebody of something the tool itself wrote. The
             * baseline is only present when the board is modified and
             * uncommitted, which is exactly the window where that is the case.
             */
            const wasClaimed = baselineGraph?.edges.some(
              (was) => was.from === edge.from && was.to === edge.to && was.claim === "needs",
            );
            const fresh = baselineGraph !== undefined && !wasClaimed;
            recordEdge(edge, fromNode, toNode, { kind: "finding", finding: {
              from: fromPath,
              to: toPath,
              fromLabel: fromNode.label,
              toLabel: toNode.label,
              fromRef,
              toRef,
              kind: "backwards-edge",
              detail:
                (fresh ? "a claim written this turn is already wrong: " : "")
                + `this arrow says ${fromNode.label || fromPath} needs `
                + `${toNode.label || toPath}, but the dependency runs the other way — `
                + `${evidence.file} line ${evidence.line} declares "${evidence.specifier}", `
                + `and ${fromPath} declares nothing on ${toPath}. Turn the arrow round.`,
            } });
            continue;
          }
        }
      }

      /*
       * When both ends name symbols, ask the sharper question.
       *
       * The anchors already say what a box is: a bare path is a file, a
       * `path#symbol` is a function, a `refs` list is a feature. So the check
       * takes its granularity from the claim that was written rather than from
       * a field somebody has to keep in sync -- both ends symbol-anchored in a
       * language with a table gets function granularity, anything less falls
       * through to the file-level channels below.
       *
       * This runs before the TypeScript gate on purpose: the case it was built
       * for is Rust.
       */
      const fromEnd = { file: fromFile, path: fromPath, symbols: symbolsOf(fromNode, fromFile) };
      const toEnd = { file: toFile, path: toPath, symbols: symbolsOf(toNode, toFile) };
      const bothNamed = fromEnd.symbols.length > 0 && toEnd.symbols.length > 0;

      /*
       * A named route is checked as written, and never falls back.
       *
       * `via` says the connection goes this way, through these names. Each
       * consecutive pair is one plain direct check, so depth costs nothing and
       * the report can point at the hop that stopped holding -- which is the
       * one thing no other shape here can say. Falling back to a looser channel
       * on failure would throw away exactly that.
       */
      const via = edge.via;
      if (bothNamed && via && via.length > 0) {
        const language = languageOf(fromFile)!;
        const source = workspace.read(fromFile);
        const broken = chainBreak(source, fromEnd.symbols[0]!, via, toEnd.symbols, language);
        if (broken?.unreadable) {
          skipEdge("no-function-body", edge, fromNode, toNode);
          continue;
        }
        edgesChecked += 1;
        /*
         * A broken route and an absent connection are different news.
         *
         * "these are not connected" and "these are connected, but not the way
         * you wrote it down" want different fixes -- redraw the arrow, versus
         * correct the route -- and rendering them the same way invites someone
         * to delete an arrow that was right.
         *
         * Telling them apart needs no deeper search, because the asymmetry is
         * in our favour: finding a path proves a connection, while failing to
         * find one proves nothing. So this only ever *confirms*, at exactly the
         * evidence standard used everywhere else. Searching deeper for the
         * confirmation would bless every broken route as "connected anyway",
         * which is the same whitewash measured at file level, pointed the other
         * way.
         */
        const stillConnected = broken
          && checkSymbolEdge(fromEnd, toEnd, workspace).verdict === "reached";
        recordEdge(
          edge,
          fromNode,
          toNode,
          broken
            ? { kind: "finding", finding: {
                from: fromPath,
                to: toPath,
                fromLabel: fromNode.label,
                toLabel: toNode.label,
                fromRef,
                toRef,
                kind: "broken-chain",
                detail: stillConnected
                  ? `these are still connected, but not by this route: nothing in `
                    + `${broken.at} names ${broken.next}. Correct the route or drop it.`
                  : `the route breaks at ${broken.at}: nothing in it names ${broken.next} `
                    + `— worth a look, not necessarily wrong.`,
              } }
            : { kind: "confirmed" },
        );
        continue;
      }

      const symbolResult = bothNamed
        ? checkSymbolEdge(fromEnd, toEnd, workspace)
        : { verdict: "unreadable" as const, dataEnds: [] };

      let outcome: EdgeOutcome = { kind: "confirmed" };
      if (symbolResult.verdict !== "unreadable") {
        edgesChecked += 1;
        if (symbolResult.verdict === "unreached") {
          /*
           * Nothing found -- and which of two sentences that deserves depends
           * on whether the search could have found anything at all.
           *
           * An end anchored at a struct, a static or a field has no body to
           * read, so "nothing calls anything" is a fact about the anchor rather
           * than about the design. That is by far the commonest shape in a
           * language with data types on the board: 11 of the 17 ambers this
           * came from pointed at a Rust struct, with the relationship living in
           * a signature or a field the body search never looks at. The reader
           * gets told what to change instead of what is wrong.
           */
          const data = symbolResult.dataEnds;
          outcome = data.length > 0
            ? {
                kind: "unconfirmed",
                reason: "an-end-is-data",
                detail:
                  `${data.join(" and ")} names data rather than something that runs, so a `
                  + `search through function bodies cannot see this relationship — a type in a `
                  + `signature, a field, an enclosing impl are all invisible to it. Anchor that `
                  + `end at file level and the import channels can answer instead.`,
              }
            : {
                kind: "unconfirmed",
                reason: "no-call-either-way",
                detail:
                  `nothing in ${fromEnd.symbols.join(" or ")} names ${toEnd.symbols.join(" or ")}, `
                  + `directly or through a call in the same file, and nothing the other way either.`,
              };
        }
      } else {
        /*
         * Either the ends are not both symbol-anchored, or no body could be
         * read. Fall back to the file-level channels, which need a language
         * somebody measured.
         *
         * The question is the licence's, not a regex's, and the reason is the
         * one `readableSource` gives thirty lines up: this file already routes
         * the direction check, the closure check and the ledger through
         * `licence.ts`, and this was the one call site that never got
         * converted. So a Rust board was told "not TypeScript or JavaScript"
         * about arrows whose two files `deps.ts` can read and `licence.ts` has
         * a number for -- the direction check accepting what the corroboration
         * check refused, on the same board, about the same two files.
         */
        const licensed = licenceFor(fromFile) !== undefined && licenceFor(toFile) !== undefined;
        const placeable = licensed
          && readerCanPlace(fromPath, workspace, importCache.configs)
          && readerCanPlace(toPath, workspace, importCache.configs);
        if (!placeable) {
          // The channels need a measured reader; the code graph does not.
          // graphify parses ~40 grammars, so an arrow between two Ruby or Go
          // files can still be confirmed at file level -- the same fallback a
          // licensed arrow gets from the channels below.
          if (codeGraphConfirms(options?.codeGraph, wholeRef(fromPath), wholeRef(toPath))) {
            edgesChecked += 1;
            recordEdge(edge, fromNode, toNode, { kind: "confirmed" });
            continue;
          }
          skipEdge(
            bothNamed ? "no-function-body" : licensed ? "outside-licence" : "unlicensed-language",
            edge,
            fromNode,
            toNode,
          );
          continue;
        }
        edgesChecked += 1;
        const answer = corroborates(
          fromRef,
          toRef,
          workspace,
          importCache,
          sharedImporterCandidates,
          options?.codeGraph,
        );
        outcome = answer.confirmed
          ? { kind: "confirmed" }
          : { kind: "unconfirmed", reason: "nothing-connects-them", detail: answer.detail };
      }
      recordEdge(edge, fromNode, toNode, outcome);
    }
  }

  /*
   * The other direction: what the code has that the board does not show.
   *
   * This was the open `unrepresented` idea for most of the project's life, and it
   * was stuck on one thing -- without a relevance bar, every file in the repo is
   * drift. The bar here is inherited rather than invented: a candidate has to be
   * imported by a file the board already points at, so relevance was decided by
   * whoever drew the diagram. Cost scales with the diagram, not the repository,
   * and it never searches the tree.
   *
   * A directory ref covers everything beneath it, so one box for `src/engine/`
   * excuses the whole subsystem instead of nominating all of it.
   *
   * Suggestion only, and off unless asked for. Whether a module deserves a box is
   * a judgement about what is worth showing, and a check that nagged about it
   * every turn is one that gets switched off -- taking the quiet, correct
   * missing-file check with it.
   */
  const unrepresented: UnrepresentedFinding[] = [];
  if (options?.coverage && !concept) {
    const { onBoard, covered } = boardCoverage(graph, workspace);

    const importers = new Map<string, { file: string; by: Set<string> }>();
    for (const [absolute, relative] of onBoard) {
      // Same reader, same gate: a box over a Rust module has imports worth
      // nominating for a box of their own, and the walk that finds them is the
      // one above. Left on the regex, this pass simply had nothing to say about
      // half the languages the arrow check now reads.
      //
      // The licence alone here, without `readerCanPlace`'s second half. This
      // only ever *nominates* a module for a box, so a file the reader can
      // place only partly yields a shorter list of suggestions and never a
      // claim about anybody's diagram.
      if (!licenceFor(absolute)) continue;
      for (const imported of getImports(absolute, relative, workspace, importCache)) {
        if (covered(imported.abs)) continue;
        // Test files are excluded like they are in the upstream pass. A suite
        // importing four boxes is the suite doing its job, not a module this board
        // forgot to draw. Left in they bury the modules that matter.
        if (TEST_FILE.test(imported.rel)) continue;
        // Import resolution keeps the specifier as joined, so a sibling directory
        // arrives as `src/mcp/../engine/config.ts`. Deduping is by absolute path
        // and so already correct; this is about what a reader is shown.
        const shown = path.normalize(imported.rel).split(path.sep).join("/");
        const entry = importers.get(imported.abs) ?? { file: shown, by: new Set<string>() };
        entry.by.add(relative);
        importers.set(imported.abs, entry);
      }
    }

    // Most-imported first: the module several boxes depend on is the one most
    // likely to be worth drawing, and the reader should not have to sort.
    unrepresented.push(
      ...[...importers.values()]
        .map((entry) => ({ file: entry.file, importedBy: [...entry.by].sort() }))
        .sort((a, b) => b.importedBy.length - a.importedBy.length || a.file.localeCompare(b.file)),
    );

    /*
     * The direction above cannot reach an entry point.
     *
     * It grows the board outward along imports, so it only ever finds things
     * downstream of a box. A CLI, a hook or a test is upstream: it imports the
     * boxes and nothing imports it, so no amount of drawing will make it
     * appear. That is how this repo's own board came to be twelve-for-twelve
     * anchored, clean, and missing the entire reporting half -- measured in
     * `docs/agent-context-brief.md`, which is what prompted this.
     *
     * The relevance bar is unchanged: a candidate still has to import a file a
     * box already points at. Only the search changes, from following edges to
     * enumerating files and keeping the ones with such an edge. That costs a
     * walk, which is why it stays behind `coverage` with everything else here.
     */
    const root = workspace.resolve(".");
    const candidates = root ? sourceFilesUnder(root, workspace) : undefined;
    const entryPoints: UnrepresentedFinding[] = [];
    for (const absolute of candidates ?? []) {
      if (covered(absolute) || importers.has(absolute)) continue;
      const relative = path.relative(root!, absolute).split(path.sep).join("/");
      if (TEST_FILE.test(relative)) continue;
      const reaching = getImports(absolute, relative, workspace, importCache)
        .filter((imported) => onBoard.has(imported.abs))
        .map((imported) => onBoard.get(imported.abs)!);
      if (!reaching.length) continue;
      entryPoints.push({ file: relative, importedBy: [], imports: [...new Set(reaching)].sort() });
    }

    // Ranked like the block above and appended after it: a module several boxes
    // lean on is a likelier omission than one surface that calls in.
    unrepresented.push(
      ...entryPoints.sort(
        (a, b) => b.imports!.length - a.imports!.length || a.file.localeCompare(b.file),
      ),
    );
  }

  /*
   * Deleted edges: arrows that were on the committed board and are no longer there,
   * but the code still supports the connection.
   *
   * Only reported when both endpoints still have corroboration against the code.
   * Quiet note, never affects clean or findings. Reuses baseline already read above.
   */
  if (baselineGraph && !concept) {
    const liveEdgeSet = new Set<string>();
    for (const edge of graph.edges) {
      // Key edges by their node ids, not element ids, since regeneration changes element ids
      liveEdgeSet.add(`${edge.from} -> ${edge.to}`);
    }

    const baselineNodeById = new Map<string, typeof baselineGraph.nodes[0]>();
    for (const node of baselineGraph.nodes) {
      baselineNodeById.set(node.id, node);
    }

    // Build shared importer candidates once for all deleted-edge checks
    const sharedImporterCandidates = new Map<string, string>();
    for (const node of baselineGraph.nodes) {
      const nodeRef = node.ref?.trim();
      if (!nodeRef) continue;
      const { path: nodePath } = parseRef(nodeRef);
      const resolved = workspace.resolve(nodePath);
      if (resolved && workspace.stat(resolved) === "file") {
        sharedImporterCandidates.set(resolved, nodePath);
      }
    }
    for (const [file, fileRel] of sharedImporterCandidates) {
      const fileImports = getImports(file, fileRel, workspace, importCache);
      for (const imp of fileImports) {
        if (!sharedImporterCandidates.has(imp.abs)) {
          sharedImporterCandidates.set(imp.abs, imp.rel);
        }
      }
    }

    for (const edge of baselineGraph.edges) {
      const edgeKey = `${edge.from} -> ${edge.to}`;
      // If this edge is not in the working board, check if it should be reported
      if (!liveEdgeSet.has(edgeKey)) {
        const fromNode = baselineNodeById.get(edge.from);
        const toNode = baselineNodeById.get(edge.to);

        // Only report if both endpoints exist, are recorded, and have refs
        if (
          fromNode && toNode
          && fromNode.provenance === "recorded"
          && toNode.provenance === "recorded"
          && fromNode.ref && toNode.ref
          && fromNode.state !== "external"
          && toNode.state !== "external"
        ) {
          const fromRef = fromNode.ref.trim();
          const toRef = toNode.ref.trim();
          const { path: fromPath } = parseRef(fromRef);
          const { path: toPath } = parseRef(toRef);
          const fromFile = workspace.resolve(fromPath);
          const toFile = workspace.resolve(toPath);

          // Both files must exist and be readable by a measured reader. The
          // same gate as the live pass above, because this calls the same
          // corroboration function -- two answers here would mean an arrow
          // could be checkable while drawn and unreadable once deleted.
          if (
            fromFile && toFile
            && readerCanPlace(fromPath, workspace, importCache.configs)
            && readerCanPlace(toPath, workspace, importCache.configs)
          ) {
            const fromStat = workspace.stat(fromFile);
            const toStat = workspace.stat(toFile);

            if (fromStat === "file" && toStat === "file") {
              // Check if the connection still has corroboration in the code
              const supported = corroborates(
                fromRef,
                toRef,
                workspace,
                importCache,
                sharedImporterCandidates,
                options?.codeGraph,
              );

              // Only report if the connection is still supported
              if (supported.confirmed) {
                deletedEdges.push({
                  from: fromPath,
                  to: toPath,
                  fromLabel: fromNode.label,
                  toLabel: toNode.label,
                  detail: `arrow ${fromNode.label || fromPath} → ${toNode.label || toPath} deleted — the code still connects them`,
                });
              }
            }
          }
        }
      }
    }
  }

  return {
    // `clean` means "nothing has regressed". Work items and promotions are both
    // deliberately excluded: they drive the CLI's exit code, and neither an
    // unbuilt sketch nor good news should fail a build.
    // A garbled claim counts: it is not a disagreement with the code, it is a
    // line on the board that no check can ever read, and leaving it out would
    // let it sit there quietly forever.
    clean: findings.length === 0 && edges.length === 0 && deleted.length === 0
      && garbledClaims.length === 0,
    findings,
    closedBreaches,
    closedUnproven,
    closedUnusedDoors,
    // A suggestion, never part of `clean`: a diagram that omits a module is a
    // choice about what is worth showing, not a broken claim.
    unrepresented,
    unannotated,
    deleted,
    ...(deletedEdges.length > 0 ? { deletedEdges } : {}),
    workItems,
    promotions,
    checked,
    skipped,
    skippedWhy,
    assertions,
    claims,
    garbledClaims,
    excused,
    handDrawn,
    concept,
    edges,
    edgesChecked,
    edgesSkipped,
    edgesSkippedWhy,
    unreadEdges,
    unconfirmedEdges,
    ...(graph.strayArrows > 0 ? { strayArrows: graph.strayArrows } : {}),
    // Unconditional, and unconditionally the whole list: a vocabulary sent only
    // when it is used would tell a stale reader nothing on the one board where
    // nothing is wrong, which is where it matters most.
    vocabulary: [...DRIFT_KINDS, ...EDGE_FINDING_KINDS],
  };
}

/**
 * Every board in a directory, sorted so output does not depend on readdir
 * order. A project holds any number of diagrams and none of them is "current",
 * so checking means checking all of them.
 *
 * `dir` has no default on purpose. Every caller has to say where it looked, and
 * the only honest answer comes from the project's config -- a default here is
 * how the engine and the model came to disagree about where diagrams live.
 */
export async function findBoards(root: string, dir: string): Promise<string[]> {
  try {
    const entries = await readdir(path.resolve(root, dir));
    return entries
      .filter((entry) => entry.endsWith(".excalidraw"))
      .sort()
      .map((entry) => path.resolve(root, dir, entry));
  } catch {
    return [];
  }
}

/** Never searched: build output, dependencies, and local state, none of which hold diagrams. */
const NOT_SEARCHED = new Set([
  "node_modules",
  ".git",
  "out",
  "dist",
  "build",
  "vendor",
  "coverage",
  ".diagramos",
  ".next",
  ".venv",
  "target",
]);

/**
 * Boards sitting outside the project's diagram directory.
 *
 * Answers the question a silent check cannot: "you have diagrams, just not where
 * I looked." Only worth asking when the diagram directory turned up nothing,
 * because it reads the whole repository — every directory that is not obviously
 * machinery — and that is far too much work to repeat at the end of every turn.
 *
 * Capped rather than complete. The point is to name enough of them to act on,
 * and a project with two hundred strays has a different problem than a list.
 */
export async function findStrayBoards(
  root: string,
  dir: string,
  limit = 10,
): Promise<{ boards: string[]; more: number }> {
  const skip = path.resolve(root, dir);
  const found: string[] = [];
  let more = 0;

  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // Unreadable directory: nothing to report and not worth failing over.
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (NOT_SEARCHED.has(entry.name) || absolute === skip) continue;
        await walk(absolute);
      } else if (entry.name.endsWith(".excalidraw")) {
        if (found.length < limit) found.push(path.relative(root, absolute));
        else more += 1;
      }
    }
  };

  await walk(path.resolve(root));
  return { boards: found, more };
}

function realOrResolved(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Filesystem-backed workspace rooted at a repository.
 *
 * Refs are strings a model wrote that become filesystem reads, so they are
 * confined the same way board paths are: resolved, then checked again after
 * realpath so a symlink out of the tree cannot be used to probe for files
 * elsewhere. This does not reuse the MCP resolver because the engine stays
 * independent of that layer -- the CLI check has no MCP server at all.
 */
export function createWorkspace(root: string): Workspace {
  const realRoot = realOrResolved(root);
  return {
    resolve(relativePath) {
      if (!relativePath || path.isAbsolute(relativePath)) return undefined;
      const resolved = path.resolve(realRoot, relativePath);
      if (!inside(realRoot, resolved) || !inside(realRoot, realOrResolved(resolved))) {
        return undefined;
      }
      return resolved;
    },
    stat(absolutePath) {
      try {
        return statSync(absolutePath).isDirectory() ? "directory" : "file";
      } catch {
        return "missing";
      }
    },
    read(absolutePath) {
      return readFileSync(absolutePath, "utf8");
    },
    list(absolutePath) {
      try {
        return readdirSync(absolutePath);
      } catch {
        // A directory that cannot be read is empty as far as a check is
        // concerned. Throwing here would fail a whole run over a permission bit.
        return [];
      }
    },
  };
}

/**
 * The committed version of one board, read through git.
 *
 * Git is what makes this check need no mute of its own: committing the diagram is
 * the act that says the deletion was deliberate, and it is a thing people already
 * do. Tombstones were the cheaper option and were rejected -- Excalidraw leaves
 * `isDeleted: true` elements behind, but they live forever, so an old deliberate
 * deletion and a fresh accidental one look identical, and exporting from another
 * editor prunes them.
 *
 * Every failure is silence. No git, an untracked board, a board not in HEAD, a
 * baseline that will not parse: all `undefined`. A check that errors on a
 * repository without git would be worse than one that says nothing.
 *
 * The `status` call comes first because it is the common case and the cheap one:
 * an unmodified board cannot contain an uncommitted deletion, so nothing else
 * runs.
 */
export function createGitBaseline(root: string, boardPath: string): BoardBaseline {
  return {
    committed() {
      const relative = path.relative(root, boardPath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
      // git wants forward slashes in a `HEAD:<path>` spec on every platform.
      const spec = relative.split(path.sep).join("/");
      const git = (args: string[]) =>
        execFileSync("git", args, {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 32 * 1024 * 1024,
        });
      try {
        if (!git(["status", "--porcelain", "--", spec]).trim()) return undefined;
        const parsed = JSON.parse(git(["show", `HEAD:${spec}`])) as Partial<BoardFile>;
        if (!Array.isArray(parsed.elements)) return undefined;
        return parsed as BoardFile;
      } catch {
        return undefined;
      }
    },
  };
}
