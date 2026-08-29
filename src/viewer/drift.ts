/**
 * The drift report, shaped for the page.
 *
 * The engine's report already says everything; what the panel needs is the
 * same selection the CLI notice makes -- rows a person can read, a tally a
 * person can glance at -- with one addition the CLI cannot have: every row
 * that still exists on the canvas carries its node id, so clicking it can
 * reveal the box it is about.
 *
 * Pure functions, kept out of App.tsx so they are testable without a browser.
 *
 * This file is compiled into `out/viewer` and served from disk, so unlike the
 * CLI it can be *older than the engine answering it*: nothing rebuilds the
 * bundle on a pull, and nothing used to notice. That is why the two ideas below
 * exist and why they are not the same idea. A kind this file has no branch for
 * gets its own row and its own count rather than falling into whichever bucket
 * the arithmetic leaves over (#116); and the report's own vocabulary is
 * compared against the words below, so the page can say it is out of date
 * instead of quietly grading a report by last release's rules.
 */

import { summaryOf as sentenceFor } from "../engine/summary";

export type Tone = "bad" | "warn" | "good" | "dim";

/**
 * The box verdicts this page knows how to render.
 *
 * Everything here has a branch: `empty-ref` and `unused-symbol` get their own
 * count, `open-box` reads its detail, the rest are "gone". A word not on this
 * list is one this bundle predates.
 */
const KNOWN_BOX_KINDS = new Set([
  "missing-file",
  "missing-symbol",
  "unresolvable-ref",
  "empty-ref",
  "missing-declaration",
  "unused-symbol",
  "unsupported-member",
  "missing-route",
  "open-box",
]);

/** The arrow verdicts this page knows how to render. */
const KNOWN_EDGE_KINDS = new Set([
  "unsupported-edge",
  "broken-chain",
  "backwards-edge",
  "built-backwards",
]);

/**
 * The subset of the engine's DriftReport the panel reads. Structural on
 * purpose: a real report satisfies it, and the page stays honest about how
 * little of the payload it depends on.
 */
export interface DriftView {
  clean: boolean;
  findings: Array<{
    node: string; label: string; ref: string; kind: string;
    /** Read for `open-box`, and for any kind this page does not recognise. */
    detail?: string;
  }>;
  edges: Array<{
    from: string; to: string; fromLabel: string; toLabel: string; node: string;
    /** `backwards-edge` is red, the rest of `KNOWN_EDGE_KINDS` amber, anything else dim. */
    kind: string;
    /** Shown verbatim when the kind is one this page has never heard of. */
    detail?: string;
  }>;
  deleted: Array<{ node: string; label: string; ref: string }>;
  deletedEdges?: Array<{ fromLabel: string; toLabel: string }>;
  /** Claim words the vocabulary does not have. Optional: older payloads have none. */
  garbledClaims?: Array<{ on: string; label: string; written: string }>;
  /**
   * What became of the board's `@needs` arrows. Optional: older payloads have none.
   *
   * `needsWithheld` is the one that matters here. A claim nobody could answer
   * is not a finding -- nothing is wrong -- but a chip reading "all still true"
   * over the top of one is a lie of exactly the kind this panel exists to
   * avoid, so it gets counted and said (#113).
   */
  claims?: {
    needs: number;
    needsChecked: number;
    needsWithheld?: Record<string, number>;
    /**
     * The same two facts for `@feeds`. Optional: older payloads have neither.
     *
     * Only the half of `feedsWithheld` that means *nobody could look* is
     * unanswered news, which is the same split the CLI makes. A flow that was
     * searched for and not found is an answer of "no evidence", and #133 settled
     * what those are worth: a count, never a chip that reads like a defect.
     */
    feeds?: number;
    feedsConfirmed?: number;
    feedsWithheld?: Record<string, number>;
  };
  /**
   * Arrows read and not corroborated. Optional: older payloads have none.
   *
   * Counted and said, never a row and never a colour. Amber used to mean this,
   * and on a board over a language full of data types it was most of the amber
   * there was -- fifteen of seventeen, on the board that settled it, all of
   * them arrows that claimed nothing (#133). Absence of evidence gets a number.
   */
  unconfirmedEdges?: Array<{ fromLabel: string; toLabel: string; reason: string }>;
  /**
   * `kind` is read for one word only. `built-backwards` is the plan the code
   * contradicted rather than the plan the code has not reached, and the two say
   * opposite things to a reader: one means keep going, the other means somebody
   * has to decide. Optional because older payloads carry no kind at all, and a
   * missing one falls back to the ordinary "not built yet".
   */
  workItems: Array<{ node: string; label: string; ref?: string; kind?: string }>;
  promotions: Array<{ node: string; label: string }>;
  checked: number;
  skipped: number;
  edgesChecked: number;
  strayArrows?: number;
  concept: boolean;
  /**
   * Every verdict word the engine that produced this report can emit.
   *
   * Absent from a report older than #116, which is treated as "nothing to
   * compare" rather than as a mismatch: a page cannot be out of date relative
   * to a server that never said what it knows.
   */
  vocabulary?: string[];
}

/**
 * Words in the report's vocabulary that this bundle has no branch for.
 *
 * Non-empty means the page is older than the engine -- the `out/viewer` bundle
 * was built before a finding kind was added and nothing rebuilt it. Not a
 * finding about the diagram, and never folded in with them: it is a statement
 * about the page.
 */
export function unknownKindsIn(report: DriftView): string[] {
  return (report.vocabulary ?? []).filter(
    (kind) => !KNOWN_BOX_KINDS.has(kind) && !KNOWN_EDGE_KINDS.has(kind),
  );
}

/** The two `feeds` reasons that mean somebody looked, which are not unanswered. */
const SEARCHED = new Set(["absent", "reversed"]);

/** Claims this board asked about and got no answer for, both words. */
function unansweredClaims(report: DriftView): number {
  const needs = Object.values(report.claims?.needsWithheld ?? {});
  const feeds = Object.entries(report.claims?.feedsWithheld ?? {})
    .filter(([why]) => !SEARCHED.has(why))
    .map(([, count]) => count);
  return [...needs, ...feeds].reduce((sum, count) => sum + count, 0);
}

/**
 * Why a `@needs` arrow got no verdict, in the CLI's words.
 *
 * A reason with no phrasing here falls back to its own key rather than being
 * dropped: the count on the line above is the truth, and a page that shows
 * three unanswered claims and explains two of them is still telling a reader
 * something they can act on.
 */
const WITHHELD_WORDS: Record<string, string> = {
  unlicensed: "in a language with no measured reader",
  unreadable: "with an end that could not be read",
  incomplete: "with an end that could not be parsed to the end",
  dynamic: "with an end that reaches out at runtime",
  unvouched: "with an end no source index has ever read",
  "same-file": "pointing at their own file",
  cycle: "in a cycle, where neither direction is more correct",
  "ends-not-bound": "with an end not snapped to its box — drag it on until the box highlights",
  "endpoint-missing": "with an end that points at no box",
  "endpoint-external": "with an end marked external",
  "endpoint-has-no-ref": "with an end that has no ref",
  "endpoint-outside-repo": "with an end pointing outside the repo",
  "endpoint-file-missing": "with an end whose file is missing",
  "directory-ref": "with an end that refs a directory, not a file",
  "glob-ref": "with an end that refs a glob, not a file",
  // `feeds` only: an end anchored at a file has no result to follow.
  "not-symbols": "with an end anchored at a file rather than a symbol",
  "nowhere-to-look": "in a tree too large to walk",
};

function claimWithheldWords(report: DriftView): string {
  const reasons = [
    ...Object.entries(report.claims?.needsWithheld ?? {}),
    ...Object.entries(report.claims?.feedsWithheld ?? {}).filter(([why]) => !SEARCHED.has(why)),
  ];
  return reasons
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([why, count]) => `${count} ${WITHHELD_WORDS[why] ?? why}`)
    .join(", ");
}

export interface TallyPart {
  text: string;
  tone: Tone;
}

export interface StatusRow {
  text: string;
  tone: Tone;
  /** Node id to reveal on the canvas. Absent when the element is gone. */
  node?: string;
}

const name = (label: string, node: string) => (label || node).replace(/\s+/g, " ");

/** The chip's counts: the same parts as the CLI notice's tally, same words. */
export function tallyOf(report: DriftView): TallyPart[] {
  const kind = (wanted: string) => report.findings.filter((finding) => finding.kind === wanted).length;
  const empty = kind("empty-ref");
  const unused = kind("unused-symbol");
  /*
   * Counted by name, not by subtraction.
   *
   * `length - empty - unused` was the arithmetic, and it made "gone" the
   * remainder -- so every kind this bundle had never heard of quietly became a
   * box whose file is missing. A remainder cannot tell "not one of the ones I
   * separated out" from "not one of the ones I know", and those are the two
   * states the whole panel exists to keep apart.
   */
  const strangeBoxes = report.findings.filter((finding) => !KNOWN_BOX_KINDS.has(finding.kind)).length;
  const strangeEdges = report.edges.filter((finding) => !KNOWN_EDGE_KINDS.has(finding.kind)).length;
  const unrecognised = strangeBoxes + strangeEdges;
  const gone = report.findings.length - empty - unused - strangeBoxes;
  const parts: TallyPart[] = [];
  /*
   * First, and red, because it is the only part here that is about the page
   * rather than the board: the engine knows words this bundle does not, so
   * every count beside it was produced by an out-of-date set of rules. A stale
   * page showing a confident tally is the failure; showing a confident tally
   * *and* saying it may be stale is the fix.
   */
  if (unknownKindsIn(report).length) {
    parts.push({ text: "page out of date", tone: "bad" });
  }
  if (gone) parts.push({ text: `${gone} gone`, tone: "bad" });
  if (empty) parts.push({ text: `${empty} empty`, tone: "bad" });
  if (unused) parts.push({ text: `${unused} unused`, tone: "bad" });
  if (report.deleted.length) parts.push({ text: `${report.deleted.length} removed`, tone: "bad" });
  if (report.garbledClaims?.length) {
    parts.push({ text: `${report.garbledClaims.length} unreadable`, tone: "bad" });
  }
  /*
   * Backwards arrows counted apart, and first.
   *
   * "3 arrows" in amber reads as three things to look into. One of them being
   * definitely wrong is different news, and rolling it into the amber total is
   * how a red finding gets read as a maybe.
   */
  const backwards = report.edges.filter((finding) => finding.kind === "backwards-edge").length;
  const unsupported = report.edges.filter(
    (finding) => finding.kind !== "backwards-edge" && KNOWN_EDGE_KINDS.has(finding.kind),
  ).length;
  if (backwards) {
    parts.push({
      text: `${backwards} ${backwards === 1 ? "arrow" : "arrows"} backwards`,
      tone: "bad",
    });
  }
  if (unsupported) {
    parts.push({
      text: `${unsupported} ${unsupported === 1 ? "arrow" : "arrows"}`,
      tone: "warn",
    });
  }
  /*
   * Arrows read and not corroborated: a number, dim, and no row anywhere.
   *
   * This is what most of the amber above used to be, and the difference between
   * the two lines is the difference between "have a look at this" and "I could
   * not tell". Dim rather than warn because nothing is wrong: an arrow the
   * board never made a claim about cannot be contradicted, and painting the
   * absence of evidence is how fifteen descriptive labels arrived as fifteen
   * defects (#133).
   */
  const unconfirmed = report.unconfirmedEdges?.length ?? 0;
  if (unconfirmed) {
    parts.push({
      text: `${unconfirmed} unconfirmed`,
      tone: "dim",
    });
  }
  /*
   * A verdict this page cannot grade, admitted as such.
   *
   * "dim" on purpose: it is neither a defect nor an all-clear, and painting it
   * either would be the guess this replaces. The row below carries the engine's
   * own words for it, which are the only trustworthy thing left.
   */
  if (unrecognised) {
    parts.push({
      text: `${unrecognised} ${unrecognised === 1 ? "finding" : "findings"} this page cannot read`,
      tone: "dim",
    });
  }
  // A question asked on the board and not answered. Amber: nothing is wrong,
  // but "in sync" would be claiming an answer nobody got.
  const unanswered = unansweredClaims(report);
  if (unanswered) {
    parts.push({
      text: `${unanswered} unchecked ${unanswered === 1 ? "claim" : "claims"}`,
      tone: "warn",
    });
  }
  if (report.strayArrows) {
    parts.push({
      text: `${report.strayArrows} stray ${report.strayArrows === 1 ? "arrow" : "arrows"}`,
      tone: "dim",
    });
  }
  if (report.promotions.length) parts.push({ text: `${report.promotions.length} built`, tone: "good" });
  if (report.workItems.length) parts.push({ text: `${report.workItems.length} planned`, tone: "dim" });
  return parts;
}

/** One row per finding, the CLI's long form, with a node id where one still exists. */
export function rowsOf(report: DriftView): StatusRow[] {
  const unknown = unknownKindsIn(report);
  const unanswered = unansweredClaims(report);
  return [
    /*
     * Above everything, because it is about everything below it.
     *
     * The rows underneath were graded by rules this bundle was built with, and
     * the server has since learned words it does not have. Naming them is the
     * difference between "restart the board" and an afternoon spent wondering
     * why the browser and the CLI disagree -- a hard refresh does not help,
     * because the stale artefact is on disk, not in the cache.
     */
    ...(unknown.length
      ? [{
        text: `this page is out of date — it does not know: ${unknown.join(", ")}`
          + " · restart the board to rebuild it",
        tone: "bad" as Tone,
      }]
      : []),
    // A word the check cannot read comes first: everything below it is the board
    // and the code disagreeing, which is a smaller problem than a claim nothing
    // can ever evaluate.
    ...(report.garbledClaims ?? []).map((finding) => ({
      text: `${finding.on === "arrow" ? "arrow " : ""}${name(finding.label, finding.label)} · @${finding.written} is not a claim`,
      tone: "bad" as Tone,
    })),
    // The element is gone from the board, so there is nothing to reveal.
    ...report.deleted.map((finding) => ({
      text: `${name(finding.label, finding.node)} removed · ${finding.ref} still there`,
      tone: "bad" as Tone,
    })),
    ...report.findings.map((finding) => ({
      /*
       * Three shapes, and the third is the point.
       *
       * `open-box` is the one finding whose evidence is somewhere else entirely,
       * so "box → its ref" would name the directory that is fine rather than the
       * file that reached into it. A kind this page has never heard of gets the
       * engine's own sentence and a neutral tone: quoting is the only honest
       * thing left once grading is off the table, and it is what keeps a future
       * verdict visible on an old bundle instead of dressed as this one's.
       */
      text: KNOWN_BOX_KINDS.has(finding.kind)
        ? finding.kind === "open-box"
          ? `${name(finding.label, finding.node)} · ${finding.detail ?? "something outside reaches in"}`
          : `${name(finding.label, finding.node)} → ${finding.ref}`
        : `${name(finding.label, finding.node)} · ${finding.kind}`
          + `${finding.detail ? `: ${finding.detail}` : ""}`,
      tone: (KNOWN_BOX_KINDS.has(finding.kind) ? "bad" : "dim") as Tone,
      node: finding.node,
    })),
    ...report.edges.map((finding) => ({
      /*
       * Amber on this board means "we could not corroborate this, have a look".
       * A backwards arrow is not that -- it is the diagram being wrong, with the
       * line of code that proves it -- and painting the two the same colour on
       * the live view buries the only arrow verdict worth acting on at once.
       *
       * An unrecognised kind is neither, and must not borrow either colour. It
       * is quoted and left dim: this bundle was built before that word existed,
       * and "I don't know what this is" is a different thing to say than "this
       * is fine".
       */
      text: `${name(finding.fromLabel, finding.from)} → ${name(finding.toLabel, finding.to)}`
        + (finding.kind === "backwards-edge" ? " · drawn backwards" : "")
        + (KNOWN_EDGE_KINDS.has(finding.kind)
          ? ""
          : ` · ${finding.kind}${finding.detail ? `: ${finding.detail}` : ""}`),
      tone: (finding.kind === "backwards-edge"
        ? "bad"
        : KNOWN_EDGE_KINDS.has(finding.kind) ? "warn" : "dim") as Tone,
      // The finding's own from/to are file paths (the evidence); `node` is the
      // arrow in node ids, which is what the canvas can reveal.
      node: finding.node,
    })),
    /*
     * A `@needs` somebody wrote and nobody answered.
     *
     * Not a finding: no claim failed. But the chip's quiet state says "all still
     * true", and printing that over an unevaluated question is the one thing a
     * status panel must never do -- writing the claim *was* the question, and
     * silence in reply reads as the answer.
     */
    ...(unanswered
      ? [{
        text: `${unanswered} needs ${unanswered === 1 ? "arrow" : "arrows"} not checked`
          + `: ${claimWithheldWords(report)}`,
        tone: "warn" as Tone,
      }]
      : []),
    // Deleted edges: quiet notes about arrows that were removed but the code still supports
    ...(report.deletedEdges ?? []).map((finding) => ({
      text: `arrow ${name(finding.fromLabel, finding.fromLabel)} → ${name(finding.toLabel, finding.toLabel)} deleted — the code still connects them`,
      tone: "dim" as Tone,
    })),
    ...report.promotions.map((promotion) => ({
      text: `${name(promotion.label, promotion.node)} is built now`,
      tone: "good" as Tone,
      node: promotion.node,
    })),
    /*
     * The one work item that is not "still to come" (#124).
     *
     * Amber and above the rest, because it is the only row here somebody has to
     * act on: the connection exists and runs against the plan, so either the
     * arrow is drawn the wrong way round or the code is. Dim, among a list of
     * things not started yet, it read as one more thing not started yet.
     */
    ...report.workItems
      .filter((item) => item.kind === "built-backwards")
      .map((item) => ({
        text: `${name(item.label, item.node)} · built the other way round`,
        tone: "warn" as Tone,
        node: item.node,
      })),
    ...report.workItems
      .filter((item) => item.kind !== "built-backwards")
      .map((item) => ({
        text: `${name(item.label, item.node)} not built yet`,
        tone: "dim" as Tone,
        node: item.node,
      })),
  ];
}

/**
 * The `customData` key the service marks a box with when it draws a promotion
 * ahead of the record (#130). Spelled here and in `promote.ts`; the shared
 * string is the whole connection between the two.
 */
export const LIVE_PROMOTION_KEY = "livePromotion";

/**
 * How many boxes on screen are drawn as built without being recorded as built.
 *
 * Read off the scene rather than the report, and that is the only place it could
 * come from: the flip is a stroke, the record still says `planned`, so a report
 * describes these boxes as planned and is right to. The scene is the only
 * witness to the preview.
 */
export function livePromotedCount(scene: readonly { customData?: Record<string, unknown>; isDeleted?: boolean }[]): number {
  return scene.filter(
    (element) => element.isDeleted !== true && element.customData?.[LIVE_PROMOTION_KEY] === true,
  ).length;
}

/**
 * The words for a preview, or nothing when there is none.
 *
 * Requirement two of #130: whatever streams has to look unsettled, so that a
 * mid-turn screenshot is not filed as a bug. Saying "shown early" rather than
 * "promoted" is the whole job -- it names a picture running ahead of a record,
 * which is exactly what has happened, and it stops the number reading as a
 * second opinion about what is built.
 */
export function livePromotionNote(count: number): string | undefined {
  if (count <= 0) return undefined;
  return `${count} shown early — not recorded until the turn ends`;
}

/** The dot's colour: the worst news wins, and quiet is green. */
export function worstToneOf(rows: StatusRow[]): Tone {
  if (rows.some((row) => row.tone === "bad")) return "bad";
  if (rows.some((row) => row.tone === "warn")) return "warn";
  return "good";
}

/**
 * The clean chip's words: what was read, so "in sync" cannot mean "unread".
 *
 * The sentence itself lives in the engine, because the CLI says the same thing
 * every run and the two had drifted into different nouns for the same number.
 * This wrapper does no wording of its own: it counts one list -- the report
 * names its unconfirmed arrows, the sentence wants how many -- and hands the
 * rest of the report straight through. So the page still has no second opinion
 * to keep in step, only arithmetic.
 *
 * Unlike the vocabulary above, this is not something the bundle can be too old
 * for. A wording change ships inside this bundle, so a stale `out/viewer` shows
 * a stale sentence about counts that are still correct -- last release's words,
 * never a wrong number.
 */
export function summaryOf(view: DriftView): string {
  return sentenceFor({ ...view, unconfirmed: view.unconfirmedEdges?.length ?? 0 });
}
