/**
 * The questions a red is put to a compiler before it is shown (#393).
 *
 * #373 drew 448 correct arrows and 58 went red, from thirteen bugs that were
 * one mistake: every reader that can say "doesn't" read what is *written*,
 * and took "not written" for "not there". A field with no written type, a
 * parameter typed by the variable it is assigned to, a generic bound, a class
 * that fits an interface without naming it, an import whose path is a package
 * name, an operator that runs a method. The compiler knows each answer; the
 * text does not.
 *
 * So there are four questions, asked the same way in every language that has
 * a red resting on them, and shared by every word rather than grown one per
 * reader -- which is how the one mistake became thirteen:
 *
 * - `typePartsAt` -- what the type of the value or declaration here is made
 *   of: the type, its arguments, the members of a union, and the bound of a
 *   type parameter.
 * - `fitsAt` -- whether the type declared here can be used where another is
 *   expected (structural conformance, a Protocol, an interface nobody wrote
 *   `implements` for).
 * - `importTargetAt` -- which file an import's module path, or a macro's path,
 *   resolves to.
 * - `memberAt` -- which routine a member name lands on for the value here: the
 *   method an operator or a builtin runs (`==` is `__eq__`, a template string
 *   is `toString`).
 *
 * This file holds only their answers' shapes and how an answer is read. The
 * compilers are asked in `referee-ts.ts` (in process), `referee-python-lsp.ts`
 * and `referee-rust-lsp.ts` (over a pipe, batched by `referee-pool.ts` and
 * recorded by `referee-live.ts`).
 *
 * ## Which languages answer which
 *
 * | question         | TypeScript | Python | Rust |
 * |------------------|------------|--------|------|
 * | `typePartsAt`    | yes        | yes    | yes  |
 * | `fitsAt`         | yes        | yes    | --   |
 * | `importTargetAt` | yes        | yes    | yes  |
 * | `memberAt`       | yes        | yes    | --   |
 *
 * The two empty squares are not owed. `conforms` may not accuse in Rust at all
 * (`licence.ts`: what a Rust type implements is not written on the type), and
 * Rust's `@calls` already treats a method the language calls for you as
 * unknown (#357's `calledImplicitly`), which is why #373 found no red there.
 * A question nothing would ask is not built.
 *
 * ## Every answer has three values
 *
 * Yes, no, and `undefined` -- the compiler could not say, or was not running.
 * `undefined` is never a no. Only a no may let a red stand on the compiler's
 * word; everything else falls back to what the reader found *written*.
 */

/** A declaration in the repository: repo-relative file, 1-based line of its name. */
export interface DeclaredAt {
  file: string;
  line: number;
}

/**
 * One type a type is made of.
 *
 * `at` is where it is declared when the compiler said: a place in the
 * repository, or `"outside"` for a library's or the language's own type.
 * Absent when the compiler printed the name and did not place it -- pyright's
 * hover names a union's members and a list's element type in text only, and
 * nothing in its protocol points at them.
 */
export interface TypePart {
  name: string;
  at?: DeclaredAt | "outside";
  /**
   * An alias the compiler also said the parts of, which are listed beside it
   * (#416). pyright prints an alias by its name and stops; a part without
   * this is one nobody looked inside.
   */
  expanded?: true;
}

/** `typePartsAt`'s answer. */
export interface TypeParts {
  parts: TypePart[];
  /**
   * Whether the compiler saw all of the type. `false` when any part of it is
   * `any`, `unknown`, an error, or a type parameter with no bound: something
   * is there that nobody can name, so "not among the parts" is not a no.
   */
  whole: boolean;
}

/** `importTargetAt`'s answer: a repo-relative file, or a library's. */
export type ImportTarget = { file: string } | "outside";

/** `memberAt`'s answer: each routine the member lands on, or `"outside"` for a library's. */
export type MemberTarget = DeclaredAt | "outside";

/**
 * Whether a type is made of the declaration `target` names, on the compiler's
 * word: `true`, `false`, or `undefined` when it cannot say.
 *
 * A part the compiler placed matches on its place, so a same-named type from
 * elsewhere is not it. A part it only named matches on the name -- a "yes"
 * that can be wrong about two classes sharing a name, and only ever in the
 * direction that withdraws a red. A "no" needs the whole type seen.
 */
export function partsInclude(
  answer: TypeParts | undefined,
  target: { name: string; at: DeclaredAt },
): boolean | undefined {
  if (!answer) return undefined;
  const found = answer.parts.some((part) => {
    if (part.at === "outside") return false;
    if (part.at) return part.at.file === target.at.file && part.at.line === target.at.line;
    return part.name === target.name;
  });
  if (found) return true;
  return answer.whole ? false : undefined;
}
