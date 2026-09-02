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
 *
 * ## What a change to this list does to boards already drawn
 *
 * A board outlives the release that drew it, so every change here has to answer
 * for the boards already in people's repositories. They divide three ways, and
 * only the last one can hurt:
 *
 * - **Additive** -- a new word arrives (`closed`, `feeds`, `complete`). A board
 *   drawn before the word does not use it, so nothing about it changes.
 * - **Quieting** -- something judged stops being judged (#133). Every board gets
 *   quieter, which is safe unconditionally: the report loses a row nobody could
 *   act on and never gains one. #133 shipped to all boards at once for exactly
 *   this reason, and the seventeen boards in this repository reported
 *   identically across it.
 * - **Loudening** -- something unjudged starts being judged. This is the only
 *   kind that fails work nobody touched, and so the only kind that has to know
 *   how old a board is before it speaks.
 *
 * Boards now carry that age themselves: `version.ts` writes a schema number at
 * generation, and `schemaOf` reads an unstamped board as schema 1 -- the meaning
 * in force the day stamping began, which is the correct reading for every board
 * drawn before it and the only one available for a hand-drawn file.
 *
 * So the rule is about when to *bump* it, not whether to have it. Additive and
 * quieting changes leave `BOARD_SCHEMA` alone and apply to every board at once,
 * because a board that gets quieter or gains a word it does not use has nothing
 * to be grandfathered from. A loudening change bumps it and gates on it. A bump
 * that nothing reads differently is a number for its own sake, and this file's
 * whole argument is that a thing nobody checks becomes decoration.
 */

/**
 * The closed whitelist for arrows.
 *
 * `needs` is refutable and can fail a build. `feeds` confirms only. Both say
 * something the code can answer about the direction they were drawn in, which
 * is what admission turns on -- see the rule above.
 *
 * `takes` and `returns` say the most ordinary thing a typed language writes
 * down: *this function's signature names that type* (#169). Both are refutable,
 * for the reason `needs` is -- a signature is a closed region, so a type absent
 * from it is genuinely absent -- and `signature.ts` is written almost entirely
 * out of the reasons that stops being true.
 *
 * Two words rather than one, and this is the one place the split is visible:
 * collapsing them would make an arrow's orientation carry no information
 * exactly where a diagram is trying to show flow. `Request -> handler` and
 * `handler -> Response` are different statements, and one word would confirm
 * either no matter which way it was drawn.
 */
/*
 * `holds` says the ordinary thing a data type does: one of its fields is of the
 * other end's type (#188). Refutable for the reason `takes` is -- a field list
 * is a closed region, so a type absent from it is genuinely absent -- and
 * `holds.ts` is written almost entirely out of the reasons that stops being
 * true, the same way `signature.ts` is.
 *
 * It is the only word here drawn holder-first rather than declaration-last, and
 * that is a decision rather than an oversight: the one hand-drawn claim in this
 * project's corpus was somebody drawing exactly this arrow that way round, and
 * UML has pointed whole to part for thirty years. `holds.ts` carries the
 * argument in full.
 */
/*
 * `builds` says a routine makes one of a type: `new QueryCache()`, `RouteInfo {
 * .. }`, `<MenuContent />` (#199). It is the only way a component tree can be
 * described at all, and the relation nearly did not make the vocabulary because
 * the census counted it at 0.3% -- twenty times short, because JSX was not being
 * counted (#197).
 *
 * Admitted on the third footing this list has, and it is worth naming because it
 * is neither of the other two. `needs`, `takes`, `returns` and `holds` refute
 * from an **absence**, and each has a closed region to justify it: a file's
 * imports, a signature, a field list. `feeds` refutes never. This one refutes
 * from a **presence** -- the construction found running the other way, which is
 * `needs.ts`'s backwards verdict and the strongest thing here.
 *
 * The reason it cannot do what `holds` does is that a body is not a declaration.
 * A routine that never writes `new T` can still hand you a `T` from a factory,
 * so an absence here proves nothing and never becomes a finding.
 */
export const ARROW_CLAIMS = ["needs", "feeds", "takes", "returns", "holds", "builds"] as const;

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
 * The one claim a whole board can make, rather than a box or an arrow.
 *
 * Every other word here is **local**: it is about one arrow, or one directory,
 * and it is refuted by reading that one thing. `needs` says this dependency
 * runs this way. `closed` says this boundary holds. None of them can say *"and
 * that is all of them"*, which is why a board cannot be wrong by omission --
 * delete an arrow and nothing notices, grow a subsystem past its picture and
 * the report stays clean (#135).
 *
 * `complete` is the second kind. It takes a directory and asserts that within
 * it, the board shows everything it reaches: every module under that directory
 * that a box already imports, or that imports a box, has a box of its own. The
 * refutation is a module that does not.
 *
 * ## Why this one is admissible where "draw more boxes" is not
 *
 * The same computation has existed for most of this project's life as
 * `unrepresented`, and it has always been a suggestion, off unless asked for.
 * Not because it was wrong -- it is the same walk either way -- but because
 * nobody asked it. Whether a module deserves a box is a judgement about what is
 * worth showing, and an engine that volunteers that judgement every turn is one
 * that gets switched off, taking the quiet correct checks with it.
 *
 * A claim changes who is speaking. The author says the picture is complete
 * here, the engine reads it, and a module nobody drew is that person's own
 * assertion coming back wrong rather than the tool having an opinion. Silence
 * means it held.
 *
 * ## The bound, which is the part that usually sinks a completeness claim
 *
 * "Everything that touches `Orangutan`" is checkable. "Everything that touches
 * `parse`" is not -- the name is everywhere and the walk returns the
 * repository. This claim never faces that, because its target is a directory
 * rather than a symbol and its candidates are the ones `unrepresented` already
 * bounds: a module has to be connected to something already drawn before it can
 * count as missing, so relevance was decided by whoever drew the diagram. Cost
 * scales with the diagram, not the tree.
 *
 * What it does face is the opposite failure, and `checkDrift` refuses rather
 * than answers in all three cases: a scope that is not a directory, a scope
 * some box already covers whole -- which would make the claim unfalsifiable,
 * the exact rot the admission rule above exists to keep out -- and a scope
 * holding nothing the licence can read, which is reported unproven rather than
 * held, because "found no missing module" and "could not look" are not the same
 * sentence.
 */
export const BOARD_CLAIMS = ["complete"] as const;

/**
 * What a board claims, once parsed. `about` is the directory the completeness
 * is scoped to; there is no unscoped form, because "this board is complete"
 * with no target is a claim about the whole repository and nothing could bound
 * it.
 */
export interface BoardClaim {
  complete: true;
  about: string;
}

export type ParsedBoardClaim = { claim: BoardClaim } | { garbled: string };

/**
 * A board claim from whatever was written in the title element's
 * `customData.complete`.
 *
 * The value is the directory, so `complete: "src/engine"` is the whole claim --
 * there is no separate word to spell, and so no vocabulary to get wrong. What
 * can still be wrong is the shape, and a shape that is not a non-empty string
 * is garbled and loud rather than ignored: a board that looks like it claims
 * completeness and is read by nothing is worse than one that claims nothing.
 */
export function parseBoardClaim(value: unknown): ParsedBoardClaim | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return { garbled: typeof value };
  const about = value.trim().replace(/^@/, "").replace(/\/+$/, "");
  if (!about) return { garbled: '""' };
  return { claim: { complete: true, about } };
}

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
 * A number a box label states about the code it is anchored to.
 *
 * `name` is for the person -- `cap`, `port`, `workers` -- and nothing checks
 * it, because what a number *means* is not something the code can be asked.
 * `value` is the whole of the claim: this number is one the anchored code
 * actually uses.
 *
 * `written` is the number exactly as typed, kept for the report. Being told
 * `0x800 is no longer in src/lib.rs` when you wrote `0x800` is worth the field.
 */
export interface ValueClaim {
  name: string;
  value: number;
  written: string;
}

export type ParsedValueClaim = { claim: ValueClaim } | { garbled: string };

/**
 * Why this needs the `=`, and why bare `@2048` was measured and rejected.
 *
 * A box label is prose that has never been read for anything, so switching it
 * on is the one change `claim.ts` calls loudening: it can fail a board nobody
 * touched. Measured across the seventeen boards in this repository, sixteen
 * text elements carry an `@` token and every one of them is a vocabulary word
 * -- `@needs`, `@declared`, `@used`. One is a *box* label, on the board that
 * documents this very feature: `what a ref claims · @declared · @used`. Read
 * bare `@word` in box labels as a claim and that box reports two garbled claims
 * the day this ships, on our own diagram, about the syntax it is explaining.
 *
 * Not one `@` token anywhere contains an `=`. So the `=` is what keeps the two
 * grammars apart -- `@word` is vocabulary and stays prose in a box label,
 * `@name=value` is a value and is new -- and it is why this is additive rather
 * than loudening: an old board cannot hold this claim without somebody having
 * typed it, which is the same argument that let `feeds` and `closed` in without
 * a schema bump.
 */
const VALUE_CLAIM = /^@([A-Za-z_][\w.-]*)=(.+)$/;

/**
 * One `@name=value` token, or why it cannot be read.
 *
 * A value that is not a number is garbled and loud, not ignored. Numbers are
 * the only kind admitted so far, and the rule this file exists to state is that
 * a claim nothing judges reads exactly like a claim that passed -- so a board
 * saying `@default=utf-8` has to be told that nothing is checking it, rather
 * than being left to look green. The other kinds the issue lists (string
 * literals, variant sets) each arrive with their own checker or not at all.
 */
export function parseValueClaim(token: string): ParsedValueClaim | undefined {
  const match = VALUE_CLAIM.exec(token.trim());
  if (!match) return undefined;
  const [, name, raw] = match as unknown as [string, string, string];
  const cleaned = raw.replace(/_/g, "");
  const value = /^[0-9]/.test(cleaned) ? Number(cleaned) : Number.NaN;
  if (!Number.isFinite(value)) return { garbled: `${name}=${raw}` };
  return { claim: { name, value, written: raw } };
}

/**
 * The numbers a box label claims, and the prose left over.
 *
 * Several are allowed here where an arrow allows one claim, and the difference
 * is real rather than a relaxation. Two words on an arrow are one unanswered
 * question about which was meant; two numbers on a box are two independent
 * facts, each with its own answer. The board this came from needs exactly that
 * -- one box reads `TcpListener::bind · Slab(2048) · ThreadPool(255)`, which is
 * two numbers about one constructor.
 *
 * Vocabulary tokens are left alone. `@declared` in a box label is prose here
 * and always was, for the reason `VALUE_CLAIM` gives.
 */
export function readLabelValues(
  label: string,
): { text?: string; values: ValueClaim[]; garbled: string[] } {
  const values: ValueClaim[] = [];
  const garbled: string[] = [];
  /*
   * A label with no claim in it comes back byte-identical, and that is a rule
   * rather than an optimisation.
   *
   * A box label is hand-written text that wraps -- `board server\nHTTP · SSE ·
   * watch` is one label with a newline in it -- and an earlier version of this
   * split on whitespace and rejoined with single spaces, which quietly flattened
   * every label on every board whether it claimed anything or not. Nothing here
   * is allowed to rewrite somebody's own words as a side effect of looking for
   * a number in them.
   */
  const marked = label.match(/(?:^|\s)@[A-Za-z_][\w.-]*=\S+/g);
  if (!marked) return { ...(label ? { text: label } : {}), values, garbled };

  for (const token of marked) {
    const parsed = parseValueClaim(token.trim());
    if (!parsed) continue;
    if ("garbled" in parsed) garbled.push(parsed.garbled);
    else values.push(parsed.claim);
  }
  // Only the claims come out. What is left keeps its line breaks; the gap each
  // token leaves behind is closed, and a line that held nothing else goes.
  const text = label
    .replace(/(?:^|[ \t])@[A-Za-z_][\w.-]*=\S+/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .filter((line, index, lines) => line.trim() !== "" || (index > 0 && index < lines.length - 1))
    .join("\n")
    .trim();
  return { ...(text ? { text } : {}), values, garbled };
}

/** The sentence shown when a box marks a value nothing can check. */
export function valueClaimError(written: string): string {
  return `"@${written}" is not something a box can claim. Only a number can be checked `
    + `against the code — write @${written.split("=")[0]}=<number>, or drop the @.`;
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
