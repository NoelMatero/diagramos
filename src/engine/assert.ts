/**
 * `@declared` and `@used`: what a box is allowed to claim about a symbol.
 *
 * A plain `path#symbol` asks only whether the file mentions the name, which
 * cannot tell a declaration from a call site from a comment. Measured on a real
 * 640-line Rust file, that catches one of five realistic ways a feature can be
 * removed. Asking whether the symbol is *declared here* and *used beyond its
 * declaration* catches all five.
 *
 * The reason this is opt-in syntax rather than the new default is a number:
 * applied blindly to all 121 exports in this repo's own `src/`, the predicate
 * flags 35 of them -- 29% noise, because an export used only by its importers
 * looks unused where it is written. Applied where an author wrote the claim, it
 * was measured at zero false alarms. That gap is the entire justification for
 * making people type it.
 */

import { languageOf, stripCode, type Language } from "./strip";

/** The closed whitelist. Anything else after `@` is a broken ref, loudly. */
const WORDS = ["declared", "used"] as const;

export interface Assertion {
  declared: boolean;
  used: boolean;
}

export type ParsedSymbol =
  | { symbol: string; assertion?: Assertion }
  /** The `@` suffix was not a whitelisted word. Loud, so it fails the turn it is written. */
  | { garbled: string };

/**
 * Splits `log_line@declared+used` into a symbol and what is claimed about it.
 *
 * A symbol starting with `/` is a route, never an assertion, so
 * `#/api/users/@me` stays the literal route it looks like.
 */
export function parseSymbol(symbol: string): ParsedSymbol {
  if (symbol.startsWith("/")) return { symbol };
  const at = symbol.indexOf("@");
  if (at < 0) return { symbol };

  const name = symbol.slice(0, at).trim();
  const suffix = symbol.slice(at + 1).trim();
  if (!name || !suffix) return { garbled: suffix };

  const words = suffix.split("+").map((word) => word.trim().toLowerCase());
  if (words.some((word) => !(WORDS as readonly string[]).includes(word))) {
    return { garbled: suffix };
  }
  return {
    symbol: name,
    assertion: { declared: words.includes("declared"), used: words.includes("used") },
  };
}

/**
 * How a symbol is introduced, per language.
 *
 * Deliberately a table of regexes and not a parser: a parser is a dependency, a
 * build step, or both, and the per-turn budget is milliseconds. Missing a
 * declaration form makes `@declared` flag when it should not, which is the
 * loud direction -- so the tables are measured against real files rather than
 * reasoned about, and a language with no table is skipped rather than guessed.
 */
const DECLARATIONS: Record<Language, (name: string) => RegExp[]> = {
  ts: (name) => [
    new RegExp(
      `\\b(?:function\\s*\\*?|class|interface|type|enum|namespace|const|let|var)\\s+${name}\\b`,
      "g",
    ),
    // Class and object methods: `name(` opening a body, with only modifiers in
    // front of it on the line. `foo(bar)` as a call never starts a line and
    // ends its signature with `{`.
    //
    // Every gap here is `[ \t]` and never `\s`. `\s` crosses newlines, and
    // letting this pattern wander between lines cost six milliseconds on a
    // 1200-line file, against microseconds bounded to one line.
    new RegExp(
      "^[ \\t]*(?:(?:public|private|protected|static|readonly|async|get|set|abstract|override)[ \\t]+)*"
        + `\\*?[ \\t]*${name}[ \\t]*(?:<[^\\n>]*>)?[ \\t]*\\([^\\n]*\\)[^\\n]*\\{[ \\t]*$`,
      "gm",
    ),
  ],
  rust: (name) => [
    new RegExp(
      "(?:macro_rules!\\s*"
        + "|static\\s+ref\\s+"
        + "|\\b(?:fn|struct|enum|trait|union|type|const|static(?:\\s+mut)?|mod)\\s+)"
        + `${name}\\b`,
      "g",
    ),
  ],
};

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function escape(symbol: string): string {
  return symbol.replace(REGEX_SPECIAL, "\\$&");
}

function count(source: string, pattern: RegExp): number {
  return (source.match(pattern) ?? []).length;
}

/**
 * What a file has to say about one symbol.
 *
 * `used` subtracts the occurrences the declarations themselves consumed, rather
 * than requiring a total above one. That is what lets `@used` stand alone on a
 * consumer file, where nothing is declared and a single clean mention is the
 * evidence.
 *
 * There is no count floor, and there will not be one: 28 call sites folded into
 * three wrappers is a healthy refactor, and a floor would flag it forever.
 */
export interface SymbolEvidence {
  declared: boolean;
  used: number;
  /** True when the lexer bailed and this was judged on raw text instead. */
  downgraded: boolean;
}

/**
 * Stripped text, reused across the anchors of one run.
 *
 * A box that names a static and the macro using it reads the same file twice,
 * and stripping is the expensive half. Never persisted between runs: a stored
 * observation is a fact with a shelf life, which is the rot this tool exists to
 * catch. `null` records a bail, so a bailed file is not re-lexed either.
 */
export type StripCache = Map<string, string | null>;

/**
 * `undefined` when there is no lexer or declaration table for this file --
 * silence, the house default, counted by the caller so coverage stays honest.
 */
export function symbolEvidence(
  filePath: string,
  source: string,
  symbol: string,
  cache?: StripCache,
): SymbolEvidence | undefined {
  const language = languageOf(filePath);
  if (!language) return undefined;

  const cached = cache?.get(filePath);
  const stripped =
    cached !== undefined ? (cached ?? undefined) : stripCode(source, language);
  if (cache && cached === undefined) cache.set(filePath, stripped ?? null);
  const text = stripped ?? source;
  const name = escape(symbol);
  const downgraded = stripped === undefined;

  // Counting bare occurrences is two orders of magnitude cheaper than the
  // declaration table, and a name that is not in the file cannot be declared
  // in it. Worth checking first on the per-turn path.
  const total = count(text, new RegExp(`\\b${name}\\b`, "g"));
  if (total === 0) return { declared: false, used: 0, downgraded };

  // Patterns in cost order, stopping at the first that finds anything. A symbol
  // declared twice in one file in two different ways would be undercounted
  // here, which overstates its uses -- the quiet direction, and the only one a
  // shortcut is allowed to take.
  let declarations = 0;
  for (const pattern of DECLARATIONS[language](name)) {
    declarations = count(text, pattern);
    if (declarations > 0) break;
  }
  return { declared: declarations > 0, used: Math.max(0, total - declarations), downgraded };
}
