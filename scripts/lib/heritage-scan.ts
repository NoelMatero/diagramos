/**
 * The `@conforms` referee: what a declaration header plainly says a type is one
 * of -- and, in Rust, every `impl Trait for Type` and `#[derive(..)]` -- read off
 * the screen with no syntax tree.
 *
 * Lifted out of `measure-conforms.mts` unchanged when #302's recall
 * measurement needed the same one: a referee copied is a referee that drifts.
 */
import { type Language } from "../../src/engine/parse";

/* ------------------------------------------------------------------ *
 * The referee.
 * ------------------------------------------------------------------ */

/** One thing the text plainly says a type is one of. */
export interface Heritage {
  /** The type doing the conforming. */
  subject: string;
  /** What it says it is one of, as a diagram would name it. */
  base: string;
  line: number;
}

/**
 * The source with every comment and docstring blanked, line count intact.
 *
 * A class header quoted in a comment is not a declaration, and this repository's
 * own headers quote several. Carried from `measure-accesses.mts`, where reading
 * prose as source was the largest single source of noise in the first run.
 */
function blanked(source: string, language: Language): string {
  const hollow = (block: string) => block.replace(/[^\n]/g, " ");
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, hollow)
    .split("\n")
    .map((line) => line.replace(language === "python" ? /(^|\s)#.*$/ : /(^|\s)\/\/.*$/, "$1"))
    .join("\n");
  if (language === "python") {
    return withoutComments.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, hollow);
  }
  // A template literal in this repository holds whole scripts, `class` keywords
  // included. What a browser eventually runs is not a declaration in this file.
  return withoutComments.replace(/`(?:[^`\\]|\\.)*`/g, hollow);
}

/**
 * A base as a diagram would name it: no generics, no namespace, no subscript.
 *
 * `abc.ABCMeta` is one name with a namespace on the front and nobody labels a
 * box with the namespace. `Generic[T]`, `Cache<Entry>` and `Base(object)` are
 * the outer name, which is the thing being extended.
 */
function plainName(written: string): string | undefined {
  const trimmed = written.trim();
  if (!trimmed) return undefined;
  // An expression rather than a name -- `mixin(Cache)`, `make_base()`, `*bases`.
  // The reader refuses these, so offering them would measure disagreement about
  // something both sides decline to read.
  if (/[(*]/.test(trimmed)) return undefined;
  const head = trimmed.split(/[<[]/)[0]!.trim();
  const tail = head.split(/::|\./).pop()?.trim();
  return tail && /^[A-Za-z_]\w*$/.test(tail) ? tail : undefined;
}

/** Type-argument and subscript groups removed, innermost first. */
function withoutArguments(written: string): string {
  let text = written;
  for (let round = 0; round < 8; round += 1) {
    const next = text.replace(/<[^<>]*>|\[[^[\]]*\]/g, " ");
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * A heritage list, split at the commas and plus signs that separate bases.
 *
 * The arguments come off **before** the split, and that is the third bug this
 * one run turned up in its own referee. `class MoodMiddleware(AgentMiddleware[
 * AgentState, ContextT, ResponseT])` splits into four things at the commas, and
 * three of them are type arguments of the first -- so the referee offered
 * `MoodMiddleware -> ContextT` as a base and accused the reader of missing it.
 * The reader was right: a type argument is not something a class is one of, and
 * `conforms.ts` had just been changed to stop reading through them.
 */
function basesOf(written: string): string[] {
  return withoutArguments(written)
    .split(/[,+]/)
    // `metaclass=ABCMeta` is not a base. Reading its value as one would confirm
    // an arrow drawn at the metaclass, which is a green nothing could refute.
    .filter((entry) => !entry.includes("="))
    .map(plainName)
    .filter((name): name is string => name !== undefined);
}

/** Type-argument lists removed, so a constraint's `extends` is not a heritage. */
function withoutGenerics(header: string): string {
  let text = header;
  for (let round = 0; round < 6; round += 1) {
    const next = text.replace(/<[^<>]*>/g, " ");
    if (next === text) break;
    text = next;
  }
  return text;
}

const PYTHON_CLASS = /^[ \t]*class[ \t]+(\w+)[ \t]*\(([^)]*)\)[ \t]*:/;
const TS_DECLARATION = /\b(?:class|interface)\s+([A-Za-z_$][\w$]*)/;
const RUST_IMPL = /^\s*impl(?:\s*<[^>]*>)?\s+([\w:]+(?:\s*<[^>]*>)?)\s+for\s+([A-Za-z_]\w*)/;
const RUST_TRAIT = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)(?:\s*<[^>]*>)?\s*:\s*([^{]+)/;
/** `#[derive(..)]`, which is where most Rust conformance is actually written. */
const RUST_DERIVE = /^\s*#\[derive\(/;
/** The declaration a derive list is attached to. */
const RUST_TYPE = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|union)\s+([A-Za-z_]\w*)/;

export function refereeHeritage(source: string, language: Language): Heritage[] {
  const lines = blanked(source, language).split("\n");
  const found: Heritage[] = [];
  const add = (subject: string, written: string, line: number) => {
    for (const base of basesOf(written)) {
      if (base !== subject) found.push({ subject, base, line });
    }
  };

  for (const [index, line] of lines.entries()) {
    if (language === "python") {
      const hit = PYTHON_CLASS.exec(line);
      if (hit) add(hit[1]!, hit[2]!, index + 1);
      continue;
    }
    if (language === "rust") {
      const impl = RUST_IMPL.exec(line);
      if (impl) add(impl[2]!, impl[1]!, index + 1);
      const trait = RUST_TRAIT.exec(line);
      // A lifetime and a `?Sized` are bounds rather than supertraits, and
      // `plainName` drops them: neither is a type anybody draws a box for.
      if (trait) add(trait[1]!, trait[2]!.replace(/'\w+/g, ""), index + 1);
      /*
       * A derive list, and the declaration it is attached to.
       *
       * Two and a half times the written-impl population -- 3,741 against 1,401
       * over the five pinned clones -- and the reader could see none of it until
       * this block existed to ask about it. That is what widening the Rust
       * corpus was for: the default corpus holds 21 of these facts, and a
       * measurement over 21 asks cannot tell you which half of a relation you
       * are missing.
       */
      if (RUST_DERIVE.test(line)) {
        let attribute = line;
        for (let ahead = 1; ahead < 12; ahead += 1) {
          const opens = (attribute.match(/\(/g) ?? []).length;
          const closes = (attribute.match(/\)/g) ?? []).length;
          if (opens <= closes) break;
          attribute += ` ${lines[index + ahead] ?? ""}`;
        }
        const traits = attribute.slice(attribute.indexOf("(") + 1, attribute.lastIndexOf(")"));
        // The declaration underneath, past any other attributes on the way.
        for (let ahead = 1; ahead < 12; ahead += 1) {
          const next = lines[index + ahead];
          if (next === undefined) break;
          const declaration = RUST_TYPE.exec(next);
          if (declaration) { add(declaration[1]!, traits, index + 1); break; }
          // A blank line or anything that is not another attribute ends the run.
          if (next.trim() !== "" && !next.trimStart().startsWith("#[")) break;
        }
      }
      continue;
    }

    const declaration = TS_DECLARATION.exec(line);
    if (!declaration) continue;
    /*
     * A header can wrap. `export class Store\n  extends Cache\n  implements
     * Reader {` is three lines and one declaration, so the header is read up to
     * the brace or the semicolon that ends it -- with a bound, because a line
     * that opens no body is a header the referee should give up on rather than
     * follow to the end of the file.
     */
    let header = line;
    /*
     * Angle brackets as well as braces, and that is the second half of the
     * type-argument bug in `conforms.ts`. `class ListboxStore extends
     * ReactStore<\n  ListboxState,\n  ListboxContext,\n  typeof selectors\n> {`
     * is five lines: stopping at three left the referee holding an unbalanced
     * `<`, so `withoutGenerics` could not strip it and the commas inside the
     * type arguments read as three separate bases. It then blamed the reader for
     * not finding two of them.
     *
     * Both halves were one run's output and neither was visible without the
     * other, which is the sixth entry in `docs/claim-vocabulary.md` happening
     * again: a referee is a program somebody wrote and it can be read wrongly.
     */
    const balanced = (text: string) =>
      /[{;]/.test(text) && (text.match(/</g) ?? []).length <= (text.match(/>/g) ?? []).length;
    for (let ahead = 1; ahead < 10 && !balanced(header); ahead += 1) {
      header += ` ${lines[index + ahead] ?? ""}`;
    }
    const clean = withoutGenerics(header.split(/[{;]/)[0]!);
    /*
     * `[^]]*?` was the first spelling of "anything up to the implements", and in
     * JavaScript `[^]` means *any character* -- so `[^]]` is any character
     * followed by a literal `]`, and the pattern could never match a heritage
     * clause at all. TypeScript read 13 pairs against the census's 296 and tsx
     * read 0 against 313, which is the whole reason this run reports its sample
     * size next to a number the census can be compared to.
     */
    const extend = /\bextends\s+(.*?)(?:\bimplements\b|$)/.exec(clean);
    if (extend) add(declaration[1]!, extend[1]!, index + 1);
    const implement = /\bimplements\s+(.*)$/.exec(clean);
    if (implement) add(declaration[1]!, implement[1]!, index + 1);
  }
  return found;
}
