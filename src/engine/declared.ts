/**
 * How a name a board writes finds the declaration it means (#464, #451).
 *
 * Every reader that looks up a box goes through here, so they agree on two
 * things the languages decide and a board cannot spell:
 *
 * - **Which characters are part of a name.** A word boundary, `\b`, needs a
 *   letter, digit or `_` on one side. `$` is none of those, so `$ZodIssue`
 *   and `click$` were never found, and neither was a Python `café`, whose `é`
 *   `\b` does not count as a letter. A name here runs on Unicode's identifier
 *   characters plus `$`, which is what TypeScript, Python and Rust allow.
 * - **Which declaration a written name means.** A ref is `path#symbol`, so a
 *   TypeScript private `#dispatch` is written `dispatch` -- `hono-base.ts##dispatch`
 *   is not something anybody writes -- and a Rust raw identifier `r#match` is
 *   written `match`. The written name means the private or raw one only when
 *   the file declares no plain name like it. When it does, the plain one owns
 *   the name, and a call that lands on the other is still a different routine.
 *
 * `spelledHere` turns the written name into the file's own spelling once, at
 * the door, and every reader past it compares names exactly as before.
 *
 * And one rule for which leaf names a declaration, `declarationName`, for the
 * lookups that walk a tree for the box's name. Each kept its own, and the box
 * lookup measure found two of them naming things that declare nothing: an
 * operator's left operand (`addFn ?? (() => ..)` read as a routine named
 * `addFn`, five times in Elysia and zod) and a tuple label
 * (`[trackResult: () => T]`, read as TanStack's `#trackResult`).
 */
import { declaredShapes, indexedName } from "./body";
import type { Language, Node } from "./parse";

/** A character that continues a name in any language read here. */
const NAME_CHARACTER = "[\\p{ID_Continue}$\\u200c\\u200d]";

/** Put before a name in a pattern built with the `u` flag: nothing name-like precedes it. */
export const NAME_START = `(?<!${NAME_CHARACTER})`;
/** Put after a name in a pattern built with the `u` flag: nothing name-like follows it. */
export const NAME_END = `(?!${NAME_CHARACTER})`;

/** A name as literal text inside a pattern. */
export function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The name written as a whole word, and nowhere as part of a longer one:
 * `Foo` is not in `$Foo`, `FooBar` or `fooé`. `#` and `.` are not name
 * characters, so `dispatch` is still written in `this.#dispatch`.
 */
export function wholeName(name: string): RegExp {
  return new RegExp(`${NAME_START}${escapeName(name)}${NAME_END}`, "u");
}

/** The spellings a file may declare for a written name, past the name itself. */
function otherSpellings(written: string, language: Language): string[] {
  if (written.startsWith("#") || written.startsWith("r#")) return [];
  if (language === "rust") return [`r#${written}`];
  if (language === "python") return [];
  return [`#${written}`];
}

/**
 * The spelling this source declares for a name a board wrote: the name
 * itself when the file declares it, or the one private or raw declaration
 * that stands in for it. Unchanged when the file declares neither, so a
 * reader still answers "not declared" in its own words.
 */
export function spelledHere(source: string, written: string, language: Language): string {
  const declared = declaredShapes(source, language);
  if (!declared || declared.has(written)) return written;
  return otherSpellings(written, language).find((spelling) => declared.has(spelling)) ?? written;
}

/** Assignment nodes, whose `left` is the name they bind: `f = lambda: ..`, `f = function () {}`. */
const ASSIGNS = /^(assignment|assignment_expression|augmented_assignment|augmented_assignment_expression)$/;

/**
 * The leaf that names this declaration, or nothing when the node declares no
 * name a box could mean. A Rust `impl` names its type on `type`; anything
 * else on `name`, or on `left` when it is an assignment -- `left` is also an
 * operator's operand. A parameter's name, a tuple label among them, is not a
 * box.
 *
 * A key in an object literal names the function stored under it only where
 * the declaration index counted it (#477): the literal is the whole value of
 * a name, and nothing else in the file has that name. `body.ts` holds that
 * rule, beside the rest of what counts as a declaration, so every lookup
 * reads the same answer.
 */
export function declarationName(node: Node): Node | undefined {
  if (node.childForFieldName("key")) return indexedName(node);
  const name = node.type === "impl_item"
    ? node.childForFieldName("type")
    : /parameter$/.test(node.type)
      ? null
      : node.childForFieldName("name") ?? (ASSIGNS.test(node.type) ? node.childForFieldName("left") : null);
  return name && name.childCount === 0 ? name : undefined;
}
