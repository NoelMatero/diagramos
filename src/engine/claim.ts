/**
 * What an arrow and a box are allowed to claim.
 *
 * An unclaimed arrow means "these two are related, somehow". Nothing can
 * disprove "somehow": the check looks for any connection in the code, and
 * failing to find one is never proof there is none -- which is why an arrow
 * that claims nothing is now counted rather than judged (#133).
 *
 * A claim is the way to say something the code can actually answer. `needs`
 * says the tail declares a dependency on the head, in whatever way the language
 * declares dependencies. `feeds` says the tail's result goes into the head --
 * the pipeline arrow, which is a different fact and frequently points the
 * opposite way. `closed` does the same for a box: nothing outside this
 * directory reaches inside it.
 *
 * ## What earns a word its place
 *
 * The rule used to be refutability: a word goes in on the day something can
 * call it wrong. That was the right instinct read one notch too strictly, and
 * `feeds` is what showed the difference. What the rule is really guarding
 * against is a claim whose **green is guaranteed** -- one where confirmation
 * carries no information. "Some function calls both of these" is that: it is
 * symmetric, so it comes back green whichever way the arrow was drawn, and a
 * verdict that cannot depend on what you asserted is decoration in a verdict's
 * clothes.
 *
 * A word is admissible when confirming it is evidence of **the specific thing
 * it asserts**. That gives two kinds, and both are honest:
 *
 * - **Refutable** -- `needs`, `closed`. The absence is enumerable (a file's
 *   dependency declarations; every import into a directory), so finding only
 *   the opposite is proof, and the report may say *wrong*, in red, with a line.
 * - **Confirm-only** -- `feeds`. Absence proves nothing, because a value can
 *   reach the other end through a callback or a field no reader follows. So it
 *   confirms and otherwise stays quiet, which is the same stance the code-graph
 *   channel has always taken.
 *
 * Confirm-only became affordable when unconfirmed stopped being a colour
 * (#133). Before that, a word that could not go red would still have painted
 * every arrow it failed to confirm, which is the rot the old rule was written
 * to prevent.
 *
 * The whitelist stays closed either way. `assert.ts` carries exactly two words
 * and refuses everything else, which is the only reason `@declared` still means
 * one thing; a vocabulary that accepts what it does not check rots into
 * decoration. So an unrecognised word is loud the turn it is written.
 */

/**
 * The closed whitelist for arrows.
 *
 * `needs` is refutable and can fail a build. `feeds` confirms only. Both say
 * something the code can answer about the direction they were drawn in, which
 * is what admission turns on -- see the rule above.
 */
export const ARROW_CLAIMS = ["needs", "feeds"] as const;

export type ArrowClaim = (typeof ARROW_CLAIMS)[number];

/**
 * One word, and it arrived with its checker rather than before it.
 *
 * `closed` says nothing outside this directory depends on anything inside it,
 * except through the doors the box lists. Like `needs` it is refutable: one
 * import from outside, read out of the source text, and the claim is false with
 * a file and a line to show for it.
 *
 * The rule this list follows is the one `assert.ts` established and the reason
 * `@declared` still means one thing: a word arrives with the thing that reads
 * it, never before. A claim that is rendered and judged by nothing reads
 * exactly like a claim that passed.
 */
export const BOX_CLAIMS = ["closed"] as const;

/**
 * What a box claims, once parsed.
 *
 * `through` is the front doors: files inside the directory that outside code is
 * allowed to reach. An empty list is a real claim rather than a malformed one --
 * total isolation is unusual but it happens, and this repository's own
 * `src/viewer` is exactly that shape.
 */
export interface BoxClaim {
  closed: true;
  through: string[];
}

export type ParsedBoxClaim = { claim: BoxClaim } | { garbled: string };

/**
 * A box claim from whatever was written in `customData.claim`.
 *
 * Two shapes are accepted because two things write them: `"closed"` is what a
 * person types, and `{ closed: true, through: [...] }` is what a tool records.
 * Anything else is garbled and loud -- including `{ closed: false }`, which is
 * not "no claim" but a claim spelled wrong, and silently ignoring it would let a
 * box look checked when nothing read it.
 */
export function parseBoxClaim(value: unknown): ParsedBoxClaim | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "string") {
    const word = value.trim().toLowerCase().replace(/^@/, "");
    if (!word) return undefined;
    return word === "closed" ? { claim: { closed: true, through: [] } } : { garbled: value.trim() };
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    /*
     * `through` is not a claim word, it is the claim's argument, so it is taken
     * out before the vocabulary is checked. Leaving it in made a box with doors
     * read as claiming "closed+through", which is a word nobody wrote and a
     * refusal nobody could act on.
     */
    const { through: listed, ...words } = record;
    const set = Object.keys(words).filter((key) => words[key]);
    if (set.length === 0) return { garbled: Object.keys(words).join("+") || "{}" };
    if (set.length !== 1 || set[0] !== "closed") return { garbled: set.join("+") };
    const through = Array.isArray(listed)
      ? listed
        .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
        .map((entry) => entry.trim())
      : [];
    return { claim: { closed: true, through } };
  }

  return { garbled: String(value) };
}

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

/** The sentence shown when a box claims a word that is not a claim. */
export function boxClaimError(written: string): string {
  return `"${written}" is not something a box can claim. Use ${vocabulary(BOX_CLAIMS)}, or drop it.`;
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
