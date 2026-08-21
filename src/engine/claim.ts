/**
 * What an arrow is allowed to claim, and what a box is not allowed to claim yet.
 *
 * An arrow today means "these two are related, somehow". Nothing can disprove
 * "somehow": the check looks for any connection in the code, and failing to find
 * one is never proof there is none. So a negative arrow result is amber forever,
 * and an arrow drawn backwards survives every run.
 *
 * A claim is the way out. `needs` says *what kind* of relationship the arrow
 * asserts -- the tail declares a dependency on the head, in whatever way the
 * language declares dependencies -- and that has a direction. A direction has an
 * opposite, and an opposite can be shown to be the only one present. Nothing
 * here judges anything: this file is the slot the verdict will later plug into.
 *
 * The whitelist is closed, and stays closed. `assert.ts` carries exactly two
 * words and refuses everything else, which is the only reason `@declared` still
 * means one thing; a vocabulary that accepts what it does not check rots into
 * decoration. So an unrecognised word is loud the turn it is written.
 */

/** The closed whitelist for arrows. One word, and it earns its place by having an opposite. */
export const ARROW_CLAIMS = ["needs"] as const;

export type ArrowClaim = (typeof ARROW_CLAIMS)[number];

/**
 * Deliberately empty.
 *
 * The design's box claim is `closed` -- nothing outside this directory depends
 * on anything inside it -- and it is real, but its checker is not written. An
 * inert word is worse than no word: a claim that is rendered and judged by
 * nothing reads exactly like a claim that passed. So the slot on a box is read
 * and refused out loud, and `closed` arrives in the same change as the check
 * that can call it wrong.
 */
export const BOX_CLAIMS: readonly string[] = [];

export type ParsedClaim =
  | { claim: ArrowClaim }
  /** The word was not on the whitelist. Loud, so it fails the turn it is written. */
  | { garbled: string };

/** How the words read in a message, so every refusal names the whole vocabulary. */
function vocabulary(words: readonly string[]): string {
  return words.length === 0 ? "nothing yet" : words.map((word) => `@${word}`).join(", ");
}

/**
 * One word against the arrow vocabulary. Case is folded because a human typing
 * on a canvas capitalises without meaning anything by it.
 */
export function parseArrowClaim(word: string): ParsedClaim {
  const lowered = word.trim().toLowerCase();
  return (ARROW_CLAIMS as readonly string[]).includes(lowered)
    ? { claim: lowered as ArrowClaim }
    : { garbled: word.trim() };
}

/** The sentence shown when an arrow claims a word that is not a claim. */
export function arrowClaimError(written: string): string {
  return `"@${written}" is not something an arrow can claim. Use ${vocabulary(ARROW_CLAIMS)}, or drop the @.`;
}

/** The sentence shown when a box claims anything at all, which nothing checks yet. */
export function boxClaimError(written: string): string {
  return BOX_CLAIMS.length === 0
    ? `"${written}" is not something a box can claim yet: box claims arrive with the check that judges them.`
    : `"${written}" is not something a box can claim. Use ${vocabulary(BOX_CLAIMS)}.`;
}

/**
 * What an arrow label says, split into the words a reader sees and the claim it
 * carries.
 *
 * The label is the human's way in, so the syntax is the one a human already
 * meets on a box ref: an `@word` token. It is also what gets written back to the
 * canvas, which makes the claim survive on its own -- strip `customData` off a
 * board and the arrow still says what it claimed.
 *
 * A label with no `@` token is returned untouched, which is every label ever
 * written before this existed.
 */
export function readLabelClaim(label: string): { text?: string; parsed?: ParsedClaim } {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const marked = words.filter((word) => word.startsWith("@"));
  if (marked.length === 0) return { ...(label.trim() ? { text: label.trim() } : {}) };

  const rest = words.filter((word) => !word.startsWith("@")).join(" ");
  const text = rest ? { text: rest } : {};
  // Two claims is not two facts, it is one unanswered question about which was
  // meant. Refused rather than resolved by position.
  if (marked.length > 1) {
    return { ...text, parsed: { garbled: marked.map((word) => word.slice(1)).join(" ") } };
  }
  return { ...text, parsed: parseArrowClaim(marked[0]!.slice(1)) };
}

/**
 * The label to write on the canvas for an arrow with a claim.
 *
 * The claim goes last so the reader's own words come first, and it goes on in
 * the same `@word` form the label parser reads back -- one syntax, both
 * directions, so a generated arrow and a hand-typed one are indistinguishable.
 */
export function labelWithClaim(label: string | undefined, claim: ArrowClaim | undefined): string | undefined {
  const text = label?.trim();
  if (!claim) return text || undefined;
  return text ? `${text} @${claim}` : `@${claim}`;
}
