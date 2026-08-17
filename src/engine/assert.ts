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

import { symbolCounts } from "./body";
import { languageOf } from "./parse";

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
 * HTTP methods a route anchor may carry. Read by people, ignored by the check.
 *
 * Verifying that `POST /api/file` really is a POST needs framework parsing that
 * is different per framework and wrong per framework, so the method is
 * documented as decoration rather than quietly half-checked.
 */
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export interface Route {
  /** Present only when the author wrote one. Never verified. */
  method?: string;
  /** The path as written, starting with `/`. This is what gets looked for. */
  route: string;
}

/**
 * Whether this symbol is a route claim rather than a name.
 *
 * `/api/board` and `POST /api/board` both are; `logLine` is not. A bare word
 * followed by a slash-path is only a route when the word is a real method, so
 * a symbol that happens to contain a space cannot accidentally become one.
 */
export function routeOf(symbol: string): Route | undefined {
  const trimmed = symbol.trim();
  if (trimmed.startsWith("/")) return { route: trimmed };

  const space = trimmed.indexOf(" ");
  if (space < 0) return undefined;
  const method = trimmed.slice(0, space).toUpperCase();
  const rest = trimmed.slice(space + 1).trim();
  if (!METHODS.has(method) || !rest.startsWith("/")) return undefined;
  return { method, route: rest };
}

/**
 * Splits `log_line@declared+used` into a symbol and what is claimed about it.
 *
 * A route is never an assertion, so `#/api/users/@me` stays the literal route
 * it looks like -- and so does `#GET /api/users/@me`, which is why this asks
 * `routeOf` rather than testing for a leading slash.
 */
export function parseSymbol(symbol: string): ParsedSymbol {
  if (routeOf(symbol)) return { symbol };
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
  /**
   * True when the parse hit an error somewhere in the file.
   *
   * This used to mean the lexer had given up on the whole file and the answer
   * came from raw text. It now means tree-sitter recovered from something it
   * could not read -- locally, so the rest of the file was parsed properly. A
   * weaker signal than it was, still counted rather than hidden, because a
   * claim judged against a file we could not fully read should be visible as
   * such in the tally.
   */
  downgraded: boolean;
}

/**
 * `undefined` when there is no grammar for this file -- silence, the house
 * default, counted by the caller so coverage stays honest.
 */
export function symbolEvidence(
  filePath: string,
  source: string,
  symbol: string,
): SymbolEvidence | undefined {
  const language = languageOf(filePath);
  if (!language) return undefined;

  const counts = symbolCounts(source, symbol, language);
  if (!counts) return undefined;
  return { declared: counts.declared, used: counts.used, downgraded: counts.unreadable };
}
