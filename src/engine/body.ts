/**
 * Arrows at function granularity: does *this* function actually reach that one?
 *
 * The file-level channels cannot answer the sharpest question a diagram asks.
 * Draw `handle_request -> log` when the logging call is in `reset_connection`
 * and every one of them is satisfied -- same file, shared importers, the lot --
 * so the arrow is wrong and nothing says a word.
 *
 * Scoping the search to one function's body answers it, and does so
 * deterministically: find the declaration, take the balanced extent of its
 * body on stripped text (where strings and comments are already blanked, so
 * brace counting cannot be fooled), and look only in there.
 *
 * Two channels, and the second one is the interesting one. A direct hit is the
 * caller's body naming the target. One hop is the caller's body calling a
 * same-file function whose body names the target -- which is what keeps a
 * healthy refactor quiet when someone extracts the logging into a helper.
 *
 * The hop stops at one, same-file, and always will. Walking further blesses
 * everything, which was measured at file level and is the reason this exists.
 * A shared-caller channel is refused for the same reason: at function level it
 * would bless the very arrow this granularity was built to catch.
 */

import { declarationPatterns, escapeSymbol } from "./assert";
import { stripCode, type Language } from "./strip";

/**
 * The body of a named declaration, as text.
 *
 * `undefined` when there is no declaration, or when there is one with no body
 * at all -- a trait method, an overload signature. The caller counts those and
 * falls back rather than guessing.
 */
export function bodyOf(stripped: string, symbol: string, language: Language): string | undefined {
  return declarationOf(stripped, symbol, language)?.body;
}

/**
 * Whether a name was introduced as something that runs or something that sits.
 *
 * The difference matters in exactly one place: a member of a concept box that
 * runs is expected to reach the rest of the concept, and one that merely holds
 * data is the ground the rest reaches *to*. Reading the keyword the declaration
 * table already matched costs nothing, and without it the self-support rule
 * flags every `static` and `struct` a box lists.
 */
export type DeclarationKind = "callable" | "data";

const CALLABLE = /\b(?:fn|function|macro_rules)\b|^\s*[\w$]+\s*(?:<[^\n>]*>)?\s*\(/;

export function declarationOf(
  stripped: string,
  symbol: string,
  language: Language,
): { kind: DeclarationKind; body: string | undefined } | undefined {
  for (const pattern of declarationPatterns(language, symbol)) {
    pattern.lastIndex = 0;
    const match = pattern.exec(stripped);
    if (!match) continue;
    const kind: DeclarationKind = CALLABLE.test(match[0]) ? "callable" : "data";
    const body = extentFrom(stripped, match.index + match[0].length);
    if (body !== undefined) return { kind, body };
  }
  return undefined;
}

/**
 * From just past a declaration, the balanced `{...}` that follows.
 *
 * A `{` inside the parameter list is skipped, so a TypeScript default of
 * `{ a: 1 }` does not get mistaken for the body. An expression statement --
 * `const f = (x) => x + 1;` -- has no braces and runs to its semicolon
 * instead, which is why the `=` test is there: a semicolon with no `=` before
 * it is a signature with no body.
 */
function extentFrom(text: string, start: number): string | undefined {
  let parens = 0;
  let sawAssign = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(" || character === "[") parens += 1;
    else if (character === ")" || character === "]") parens -= 1;
    else if (parens > 0) continue;
    else if (character === "=" && text[index + 1] !== "=") sawAssign = true;
    else if (character === "{") return balanced(text, index);
    else if (character === ";") {
      return sawAssign ? text.slice(start, index) : undefined;
    }
  }
  return undefined;
}

/** The text between a `{` and its match, or everything left if it never closes. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1);
}

/**
 * Calls made *by* this body, to functions that could be in the same file.
 *
 * Bare `foo(...)` and `foo!(...)`, plus an explicit `self.foo(...)` or
 * `this.foo(...)`. Deliberately not `Type::foo(...)` or `other.foo(...)`: those
 * are somebody else's `foo`, and following them is how an earlier version of
 * this blessed two arrows that were plainly false -- a body calling mio's
 * `EventSet::readable()` was read as calling the local `readable`, which does
 * log.
 */
const BARE_CALL = /(?<![.:\w$])([A-Za-z_$][\w$]*)\s*!?\s*\(/g;
const RECEIVER_CALL = /\b(?:self|this)\.([A-Za-z_$][\w$]*)\s*\(/g;

/** Control flow that looks like a call and is not one. */
const NOT_A_CALL = new Set([
  "if", "while", "for", "switch", "match", "return", "catch", "with",
  "fn", "function", "await", "typeof", "in", "of", "loop", "unsafe", "move",
]);

export function callsIn(body: string): Set<string> {
  const names = new Set<string>();
  for (const pattern of [BARE_CALL, RECEIVER_CALL]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
      const name = match[1]!;
      if (!NOT_A_CALL.has(name)) names.add(name);
    }
  }
  return names;
}

function names(body: string, symbol: string): boolean {
  return new RegExp(`\\b${escapeSymbol(symbol)}\\b`).test(body);
}

/**
 * Walk a route the author named, and say where it stops holding.
 *
 * Every link is a plain direct check -- does this body name the next name --
 * because the path is written down and there is nothing left to infer. That is
 * the whole trade: naming the hops buys a chain of arbitrary depth out of the
 * one-hop machinery, and buys a report that can point at the broken link
 * instead of shrugging at the arrow.
 *
 * Returns the hop that failed, or `undefined` when the whole chain holds.
 * `unreadable` is a link whose body could not be found at all, which is not
 * evidence of a break.
 */
export function chainBreak(
  source: string,
  from: string,
  via: string[],
  targets: string[],
  language: Language,
): { at: string; next: string; unreadable: boolean } | undefined {
  const stripped = stripCode(source, language);
  const links = [from, ...via];

  for (let index = 0; index < links.length; index += 1) {
    const here = links[index]!;
    // The last hop has to land on the box itself, and any one of its symbols
    // will do -- the same any-of-the-members rule the direct check uses.
    const wanted = index + 1 < links.length ? [links[index + 1]!] : targets;
    const body = stripped === undefined ? undefined : bodyOf(stripped, here, language);
    if (body === undefined) {
      return { at: here, next: wanted.join(" or "), unreadable: true };
    }
    if (!wanted.some((target) => names(body, target))) {
      return { at: here, next: wanted.join(" or "), unreadable: false };
    }
  }
  return undefined;
}

/**
 * Members of a concept box that show no trace of the concept.
 *
 * Membership has a hole: cut the deepest call and every caller still calls a
 * listed member, so the arrows stay green while the concept is hollow. The rule
 * that closes it is that a member which *runs* has to name another member --
 * so a claim is not trusted, it is checked, like everything else here.
 *
 * Data members are the ground and are exempt: a `static` holding a file handle
 * is what the rest of the concept reaches, and asking it to reach back would
 * flag every well-formed box. A single-member box is exempt too, having
 * nothing to connect to.
 */
export function unsupportedMembers(
  source: string,
  members: string[],
  language: Language,
): string[] {
  if (members.length < 2) return [];
  const stripped = stripCode(source, language);
  if (stripped === undefined) return [];

  const orphans: string[] = [];
  for (const member of members) {
    const declaration = declarationOf(stripped, member, language);
    if (!declaration || declaration.kind !== "callable" || declaration.body === undefined) continue;
    const others = members.filter((other) => other !== member);
    if (!others.some((other) => names(declaration.body!, other))) orphans.push(member);
  }
  return orphans;
}

/** How many same-file callees one body will be followed into. */
const HOP_FAN_OUT = 40;

/**
 * Whether a function in `source` reaches any of `targets`, directly or through
 * one same-file call.
 *
 * `undefined` means the question could not be asked -- no readable body for the
 * starting symbol -- which the caller counts rather than treating as a no.
 */
export function reaches(
  source: string,
  from: string,
  targets: string[],
  language: Language,
): boolean | undefined {
  const stripped = stripCode(source, language);
  // A bailed lexer would make brace counting unreliable, and an unreliable span
  // is a loud wrong answer rather than a quiet one. Refuse the question.
  if (stripped === undefined) return undefined;

  const body = bodyOf(stripped, from, language);
  if (body === undefined) return undefined;

  if (targets.some((target) => names(body, target))) return true;

  let followed = 0;
  for (const callee of callsIn(body)) {
    if (callee === from) continue;
    if (followed >= HOP_FAN_OUT) break;
    const inner = bodyOf(stripped, callee, language);
    if (inner === undefined) continue;
    followed += 1;
    if (targets.some((target) => names(inner, target))) return true;
  }
  return false;
}
