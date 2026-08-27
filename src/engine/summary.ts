/**
 * "What was checked", in one vocabulary.
 *
 * Two surfaces answer the same question every run -- the CLI notice and the
 * live board's status chip -- and they answered it in different words. The CLI
 * counted "4 refs · 3 arrows checked"; the page said "checked 4 boxes and 3
 * arrows against the code". Same two numbers out of the same report, named
 * differently, pluralised in one place and not the other ("1 arrows"), with the
 * page having grown two honest special cases the CLI never got. A reader who
 * saw both had to work out that a ref and a box were the same thing.
 *
 * So the words live here, once, and both callers ask for them. The split
 * between the three exports is not decoration -- it is which part of the
 * sentence each surface is entitled to say:
 *
 * - `countedWords` is the tally alone, for the CLI's one-line footer, which
 *   joins segments with dots and has no room for a clause.
 * - `coverageWords` is what was read, and nothing about whether it agreed. The
 *   CLI's coverage audit prints when the board is *wrong* too, so a verdict
 *   baked into this string would be a lie there.
 * - `coverageLabel` is the same thing for somewhere narrow -- a box header that
 *   already spent cells on a filename. Identical words wherever they fit; the
 *   two explanatory branches get a short form instead of being truncated, which
 *   is what cost "a concept board — it describes something outside…" the half
 *   of the sentence that carried the point.
 * - `summaryOf` adds the verdict, and is only for a caller that already knows
 *   the board is clean.
 *
 * Deliberately dependency-free, and taking four plain numbers rather than a
 * `DriftReport`. This module is bundled into the browser (`out/viewer`), so an
 * import of the engine's report type would drag the drift checker -- and the
 * node builtins under it -- into the page. The counts are all the sentence
 * needs, and a narrow input is what keeps that true.
 */

/** The facts a "what was checked" sentence is made of. */
export interface Checked {
  /** Boxes with a ref that were compared against the code. */
  checked: number;
  /** Arrows that were compared. */
  edgesChecked: number;
  /** Boxes carrying no ref, so nothing could be read for them. */
  skipped?: number;
  /**
   * Arrows that were compared and came back unconfirmed.
   *
   * Part of `edgesChecked`, not extra to it: these were read, and nothing was
   * found either way. Here because "checked" on its own reads as "verified",
   * and on a board drawn over a language full of data types most arrows can be
   * read without being confirmed (#133). A clean verdict beside a number this
   * large is honest only if it says so.
   */
  unconfirmed?: number;
  /** The board is not about this repo, so nothing here is checkable. */
  concept?: boolean;
}

/** `1 box`, `4 boxes` -- the noun the whole tool uses for an anchored shape. */
function boxes(count: number): string {
  return `${count} ${count === 1 ? "box" : "boxes"}`;
}

/** `1 arrow`, `3 arrows`. */
function arrows(count: number): string {
  return `${count} ${count === 1 ? "arrow" : "arrows"}`;
}

/**
 * The tally alone: "4 boxes and 3 arrows".
 *
 * For the CLI's closing line, where the answer is one segment among several
 * joined by dots and a full clause would not fit the shape.
 */
export function countedWords(facts: Checked): string {
  return `${boxes(facts.checked)} and ${arrows(facts.edgesChecked)}`;
}

/**
 * What was read, with no claim about whether it agreed.
 *
 * The two branches before the tally are the reason this is a function and not
 * a template string. Both are cases where the numbers are zero and the honest
 * answer is not "checked 0 boxes" but an explanation: a board that describes
 * something outside this repo was never going to be checked, and a board whose
 * boxes carry no refs was not checked *yet*. Printing a zero for either reads
 * as a pass, which is the one thing this line exists to prevent.
 */
export function coverageWords(facts: Checked): string {
  if (facts.concept) {
    return "a concept board — it describes something outside this repo, so nothing here is checked";
  }
  if (!facts.checked && !facts.edgesChecked) {
    return "nothing on this board points at code yet, so nothing was checked";
  }
  return `checked ${countedWords(facts)} against the code`;
}

/**
 * The same answer for a narrow space: a box header, a chip, a status bar.
 *
 * Only the two explanatory branches differ, and only because they are sentences
 * rather than tallies -- a truncated explanation is worse than a short one, and
 * the clause a terminal cuts off is always the last one, which is where the
 * point lives. The counted case is left exactly as `coverageWords` says it: it
 * fits, and a second phrasing of the common case is how this drifted before.
 */
export function coverageLabel(facts: Checked): string {
  if (facts.concept) return "concept board · not about this repo";
  if (!facts.checked && !facts.edgesChecked) return "nothing here points at code yet";
  // Same nouns, same plurals, minus the trailing phrase. "against the code" is
  // the one part a header can lose without losing a fact, and dropping it is
  // what keeps the longest board name in the repo from truncating the counts.
  return `checked ${countedWords(facts)}`;
}

/**
 * The whole sentence, verdict included -- for a caller that has already
 * established the board is clean.
 *
 * "all still true" is the part only a clean report may say, and the unread tail
 * is what stops it being heard as "everything here was verified". A board can
 * be entirely in sync and mostly unread at the same time; those two facts
 * belong in one breath or the first one is misleading.
 */
export function summaryOf(facts: Checked): string {
  const coverage = coverageWords(facts);
  // Both special cases are complete sentences that already explain themselves,
  // and neither has anything a verdict could be about.
  if (facts.concept || (!facts.checked && !facts.edgesChecked)) return coverage;
  const skipped = facts.skipped ?? 0;
  const unread = skipped
    ? ` — ${skipped} more ${skipped === 1 ? "box has no ref, so it" : "boxes have no ref, so they"} went unchecked`
    : "";
  /*
   * The other half of the same honesty. An arrow read and not corroborated is
   * not a disagreement, so "all still true" holds -- and a reader who is not
   * told how many of them there were will hear "all verified", which is the one
   * thing this sentence exists to prevent.
   */
  const unconfirmed = facts.unconfirmed ?? 0;
  const unproven = unconfirmed
    ? ` — ${unconfirmed} ${unconfirmed === 1 ? "arrow was read and not" : "arrows were read and not"} confirmed`
    : "";
  return `${coverage} — all still true${unproven}${unread}`;
}
