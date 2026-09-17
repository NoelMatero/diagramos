/**
 * The `@takes` / `@returns` referee: type names read out of a signature's text,
 * by a scanner that knows nothing about syntax trees.
 *
 * Lifted out of `measure-signature.mts` unchanged when #302's recall
 * measurement needed the same one, and split by position so a parameter type
 * and a return type can be asked about separately.
 */
import { type Language } from "../../src/engine/parse";

/**
 * The referee: type names read out of the signature *text*, by a scanner that
 * knows nothing about syntax trees.
 *
 * A parameter's binding name is dropped by taking only what follows a `:` or a
 * `->` up to the next comma at depth zero, which is how a person reads a
 * signature. Crude on purpose -- a referee that shared the reader's machinery
 * would agree with it for the wrong reason.
 */
export function textTypeNames(signature: string, language: Language): Set<string> {
  const parameters = signature.slice(signature.indexOf("("), signature.lastIndexOf(")") + 1);
  const returned = signature.slice(signature.lastIndexOf(")") + 1);
  return new Set([...textTypeNamesIn(parameters, language), ...textTypeNamesIn(returned, language)]);
}

/**
 * The same scan over one region -- a parameter list, or `-> T` -- so a caller
 * holding the two halves apart (#302) need not rejoin them and split them
 * again. Splitting at the last `)` puts `&(dyn Error + 'static)` in the
 * parameters, which `textTypeNames` does not care about and a per-half
 * question does.
 */
export function textTypeNamesIn(region: string, language: Language): Set<string> {
  const names = new Set<string>();
  const typePart = /[:\->]\s*([^,)]*)/g;
  /*
   * Three things in a signature that are not types, removed before the scan.
   *
   * Not the referee being tuned to agree -- each one was checked against the
   * reader and the reader was right. A word in a doc comment inside an inline
   * object return type is prose; a word in a default value (`now: Date = new
   * Date()`) is an expression, and `new` is a keyword; a word in a string
   * literal (`foot = "/update-diagram"`) is text. A referee that counted any of
   * them would report a miss for a name that is not a type at all, and the
   * whole point of this number is that a miss means something.
   */
  const withoutProse = (text: string) => text
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""')
    .replace(/=\s*[^,)]*/g, "");
  /*
   * Python is the exception, and #195 is why.
   *
   * A quoted annotation -- `def unit_path(unit: "Path | FileSlice")` -- is how
   * Python writes a forward reference, and how a type imported only under `if
   * TYPE_CHECKING:` has to be written. The names in it are types, in the source,
   * in the signature, where anybody reading the file can see them. A referee
   * that blanks them the way it blanks a string in a default value cannot report
   * a miss for a name it never looked at, so it agreed with a reader that was
   * calling correct arrows wrong -- 49 of graphify's `def`s write one. Here the
   * quotes come off and the words inside are counted, after the default values
   * have already been removed, so what is left in a type position is a type.
   */
  const unquoted = (text: string) => text
    .replace(/#[^\n]*/g, " ")
    .replace(/=\s*[^,)]*/g, "")
    .replace(/["'`]/g, " ");
  const readable = language === "python" ? unquoted : withoutProse;
  for (const match of readable(region).matchAll(typePart)) {
    for (const word of (match[1] ?? "").matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      names.add(word[0]);
    }
  }
  /*
   * A fourth, and the one that came out of #193: `Self` is not a name, it is a
   * stand-in for one. Nothing declares a type called `Self` and no box is ever
   * drawn for it, so asking "did the reader find the token `Self`" measures a
   * question production never asks -- the reader resolves it to the type the
   * `impl` names, which is the fix that issue asked for. Left in, the referee
   * reported 43 misses on the Rust corpus, every one of them the reader doing
   * exactly the right thing.
   */
  names.delete("Self");
  return names;
}
