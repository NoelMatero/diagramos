/**
 * Every reason a planted-bench arrow came back neither red nor green, and
 * whether anybody could do anything about it (#320).
 *
 * Half of every claim on that bench ends undecided, and until this file existed
 * that was one number covering three completely different situations. A call
 * whose target is chosen at run time is not the same problem as a call the
 * reader placed in the right file and then gave up on: one of those is a
 * morning's work and the other is not work at all. The split is what says
 * which of the two a number is, and therefore what the score can ever reach.
 *
 * - `now` -- the fact is in the code and a reader stopped short of it: an
 *   unread file, a re-export, a `const` holding a function, an end that is a
 *   type where the word needs a routine.
 * - `work` -- the fact is in the code and out of reach of reading one file:
 *   it needs a type, a language server, a crate-wide index, or a measurement
 *   before the word is allowed to accuse at all.
 * - `never` -- nothing in the text settles it. A callback, a macro, a name
 *   built at run time, an end the board placed outside the repository. These
 *   are to be judged on the sentence they produce, not on being caught.
 *
 * `cost` is a guess at the size of the job, and it is here so the ranking can
 * be argued with instead of re-derived: **1** one reader changed, **2** a
 * reader plus the measurement that licenses it to accuse, **3** a new index or
 * a resolver wired in. Nothing else in the repo depends on these numbers.
 *
 * The keys are the slugs `bench-planted.mts` groups by. A reason with no entry
 * here is printed as unlabelled and counted against the ceiling as if nothing
 * could be done about it, which is the safe direction to be wrong in.
 */
export type Bucket = "now" | "work" | "never";

export interface BucketLabel {
  bucket: Bucket;
  cost: 1 | 2 | 3;
  /** One line: what would have to change for this reason to become a verdict. */
  why: string;
}

export const UNDECIDED_BUCKETS: Record<string, BucketLabel> = {
  // ---- decidable now -------------------------------------------------------
  "declined: not-closed reaches-the-file": { bucket: "now", cost: 1,
    why: "the call list is closed and one call lands in the head's own file at another routine (#329)" },
  "declined: not-closed routine-not-found": { bucket: "now", cost: 2,
    why: "the tail is a type and a type calls nothing -- in TypeScript and Python that is readable off the declaration, and #297's red does not fire because a class body counts as a body" },
  "declined: no-signature": { bucket: "now", cost: 1,
    why: "the end is not a function the reader recognises: a const holding an arrow function, or a #private method" },
  "declined: not-declared": { bucket: "now", cost: 1,
    why: "the file the ref names does not declare it, and the declaration is one re-export away" },

  "declined: no-fields": { bucket: "now", cost: 1,
    why: "a Rust struct with no fields at all holds nothing, and that absence is as closed as any other" },
  "declined: aliased": { bucket: "now", cost: 1,
    why: "a renamed import hides the name the arrow asks about; the rename is in the importing file" },

  "unconfirmed: an-end-is-data": { bucket: "now", cost: 1,
    why: "an end names data rather than something that runs, so the anchor is wrong and the author can be told which end" },
  "declined: not-closed elsewhere": { bucket: "now", cost: 1,
    why: "the name leads through a re-export that runs out, and the next file is there to be read" },

  // ---- decidable with work -------------------------------------------------
  "declined: not-closed receiver": { bucket: "work", cost: 3,
    why: "the call is on a value whose type the text does not give -- the tier-2 resolver (#328) is what answers it" },
  "declined: receiver": { bucket: "work", cost: 3,
    why: "same call on an untyped receiver, reported by the forward read rather than by the closing one" },
  "declined: dynamic": { bucket: "work", cost: 2,
    why: "one file imports at run time, so its whole import list stops being closed -- narrowing that to the dynamic specifier needs a fresh licence measurement, and the computed ones stay silent" },
  "declined: not-closed unbound": { bucket: "work", cost: 2,
    why: "the call is on a name the file never binds: a built-in or a wildcard import, both readable from a table or the exporting file" },
  "declined: unbound": { bucket: "work", cost: 2,
    why: "same unbound name, reported by the forward read" },
  "declined: not-constructed": { bucket: "work", cost: 2,
    why: "a Python body writes no call to that name, and @builds may not call that an absence until a measurement licenses it" },
  "declined: nothing recorded": { bucket: "work", cost: 2,
    why: "@builds read the body, found no construction and has no absence footing -- and the reason is not even tallied, so the bench cannot name it" },
  "declined: no-body": { bucket: "work", cost: 3,
    why: "the tail is a Rust type, and whether a Rust type has code is a fact about its impl blocks, which may sit in any file in the crate (PART_LICENCE rust/body)" },
  "declined: region-is-the-crate": { bucket: "work", cost: 3,
    why: "a Rust impl may sit in any file in the crate, so @conforms needs a crate-wide impl index before an absence means anything" },
  "declined: inherited": { bucket: "work", cost: 3,
    why: "the member may come from a base class, which needs the base chain resolved across files" },
  "unconfirmed: signature-other-half": { bucket: "work", cost: 2,
    why: "the type is in the other half of the signature, which is evidence the arrow is reversed -- and may not accuse until measured (#169)" },
  "declined: unlicensed": { bucket: "work", cost: 2,
    why: "this language has never been measured for this word, so the reader has no right to refute" },
  "declined: quoted": { bucket: "work", cost: 2,
    why: "the field's type sits inside a string, so the reader saw no names -- a Python forward reference can be followed, a TypeScript literal type cannot" },

  "unconfirmed: no-call-either-way": { bucket: "work", cost: 2,
    why: "no call was found in either direction, and closing the tail's whole call list is what turns that into a verdict" },
  "unconfirmed: nothing-connects-them": { bucket: "work", cost: 2,
    why: "no import, shared importer or shared route connects the ends; saying so as an accusation needs a measurement per language" },
  "declined: not-closed unlicensed": { bucket: "work", cost: 2,
    why: "this language has never been measured for what a missing call proves" },
  "declined: not-closed unreadable": { bucket: "work", cost: 2,
    why: "the calling file could not be read -- a language with no grammar, or a file the workspace would not open" },

  // ---- not decidable -------------------------------------------------------
  "declined: computed": { bucket: "never", cost: 1,
    why: "the callee is picked at run time; the text does not say what it is" },
  "unread: endpoint-external": { bucket: "never", cost: 1,
    why: "the board put that end outside the repository, so there is no source to read" },
  "declined: macro": { bucket: "never", cost: 1,
    why: "the declaration and the call site both come out of macro expansion" },
  "declined: not-closed macro": { bucket: "never", cost: 1,
    why: "same, reached while closing the call list" },
  "declined: ambiguous": { bucket: "never", cost: 1,
    why: "the name is bound two ways at once and the text does not say which wins" },
  "declined: absent": { bucket: "never", cost: 1,
    why: "@feeds found no journey, and not finding one is never evidence there is none" },
  "declined: not-closed unplaced": { bucket: "never", cost: 1,
    why: "the import resolves to no file in the repository -- usually a package" },
  "declined: not-closed abstract-receiver": { bucket: "never", cost: 1,
    why: "the call goes through an interface, so what it reaches is not fixed" },
  "unconfirmed: feeds-runs-the-other-way": { bucket: "never", cost: 1,
    why: "@feeds never refutes: a value can reach the far end through a callback, a field or a queue no reader follows" },
  "declined: not-closed computed": { bucket: "never", cost: 1,
    why: "one call picks its target at run time" },
  "declined: not-closed dynamic": { bucket: "never", cost: 1,
    why: "the caller can reach a name that is nowhere in its text" },
  "declined: not-closed ambiguous": { bucket: "never", cost: 1,
    why: "one call is on a name bound in two places at once" },
  "garbled claim": { bucket: "never", cost: 1,
    why: "the claim itself could not be read; the board says it, and no reading of the code settles it" },
  "advisory needs-one-level-up": { bucket: "never", cost: 1,
    why: "decidable and deliberately not decided: an arrow whose ends connect through other files is told the route rather than accused (#323)" },
  "advisory calls-one-level-up": { bucket: "never", cost: 1,
    why: "same, for a call that reaches the far end through another file" },
};
