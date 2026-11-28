/**
 * TypeScript the bundled grammar misreads, rewritten so it reads as written
 * (#462).
 *
 * tree-sitter-typescript 0.23.2, the latest release, fails on three pieces of
 * ordinary TypeScript. Each made the parser skip a stretch of the file, and
 * `recover.ts` then blanked that stretch as unread -- so every question about
 * the file as a whole ("nothing in it imports that", "no field names that")
 * was withheld, on files where nothing was hidden at all. Across the TypeScript
 * corpus they were most of the files that did not parse:
 *
 *   variance markers      `interface ZodType<out Output>`, `class Elysia<const in out P>`
 *   a call signature on   `(pieces: TemplateStringsArray): R` followed by a line
 *     a line of its own     `<O extends Options>(opts: O): R` -- zx, hono, MobX, immer
 *   a type-only star      `export type * from './types'` -- TanStack, vite, hono, tRPC
 *     export
 *
 * Each rewrite is TypeScript's own rule, applied where the grammar does not:
 *
 * - `in` and `out` on a type parameter say how the type varies and nothing
 *   else. TypeScript allows them only on the type parameters of a class, an
 *   interface or a type alias, which is the only place they are blanked here.
 * - TypeScript never reads `<` after a line break as the start of a type's
 *   arguments (`parseTypeArgumentsOfTypeReference` checks for the break), so a
 *   line that opens with `<` inside an interface or a type alias starts a new
 *   member. The grammar reads it as arguments of the type that ended the line
 *   before; a `;` in the indentation in front of it says what TypeScript reads.
 * - `export type * from` re-exports what `export * from` does, for types only.
 *
 * All three are in declarations of types, which hold no code: no call, no
 * routine and no name a body uses can be in what is rewritten, so nothing a
 * reader asks about a routine can change. The `type` of a star export is
 * blanked so the dependency it states is read, as it is with `export *`.
 *
 * Every rewrite keeps every character where it was -- a word becomes spaces,
 * one space of indentation becomes a `;` -- so every offset and line number in
 * the tree is the file's own. It runs only on a file that does not parse as
 * written; what still does not parse after it goes to `recover.ts` as before,
 * and stays unread.
 */

/**
 * The source with comments and the insides of strings and templates turned to
 * spaces (newlines and the quotes kept), so a pattern below never matches text
 * that is not code. Undefined when a comment or a template never ends.
 */
function codeOnly(source: string): string | undefined {
  const out = source.split("");
  const length = source.length;
  const blankTo = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  let index = 0;
  while (index < length) {
    const char = source[index]!;
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      const stop = end < 0 ? length : end;
      blankTo(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return undefined;
      blankTo(index, end + 2);
      index = end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      let at = index + 1;
      while (at < length && source[at] !== char) {
        if (source[at] === "\\") at += 1;
        else if (source[at] === "\n" && char !== "`") break;
        at += 1;
      }
      if (at >= length && char === "`") return undefined;
      blankTo(index + 1, Math.min(at, length));
      index = at + 1;
      continue;
    }
    index += 1;
  }
  return out.join("");
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/y;

function wordAt(code: string, at: number): string | undefined {
  IDENTIFIER.lastIndex = at;
  return IDENTIFIER.exec(code)?.[0];
}

function skipSpace(code: string, at: number): number {
  while (at < code.length && /\s/.test(code[at]!)) at += 1;
  return at;
}

/** Whether `code[at]` is the `>` of an `=>`, which closes no angle bracket. */
function arrow(code: string, at: number): boolean {
  return code[at] === ">" && code[at - 1] === "=";
}

/** Whether a keyword at `at` stands as a word: not part of a longer name, not a property after a dot. */
function standsAlone(code: string, at: number, word: string): boolean {
  const before = code[at - 1];
  const after = code[at + word.length];
  return (before === undefined || !/[\w$.]/.test(before)) && (after === undefined || !/[\w$]/.test(after));
}

/** A class, interface or type alias with type parameters: the offset of its `<`. */
const DECLARES_PARAMETERS = /(?<![\w$.])(?:class|interface|type)\s+[A-Za-z_$][\w$]*\s*</g;

/**
 * The `in` and `out` words on the type parameters of classes, interfaces and
 * type aliases, as `[start, end)` spans.
 */
function varianceMarkers(code: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of code.matchAll(DECLARES_PARAMETERS)) {
    let at = match.index! + match[0].length;
    let angle = 1;
    let brackets = 0;
    let parameterStart = true;
    while (at < code.length && angle > 0) {
      if (parameterStart) {
        parameterStart = false;
        at = skipSpace(code, at);
        if (wordAt(code, at) === "const") at = skipSpace(code, at + 5);
        const words: Array<[number, number]> = [];
        for (;;) {
          const word = wordAt(code, at);
          if (word !== "in" && word !== "out") break;
          const next = skipSpace(code, at + word.length);
          if (next === at + word.length) break; // `inner`, or `in` with nothing after it
          words.push([at, at + word.length]);
          at = next;
        }
        // The last word is the parameter's own name when no name follows it: `<out>`, `<out extends T>`.
        const name = wordAt(code, at);
        if (words.length && (name === undefined || name === "extends")) words.pop();
        spans.push(...words);
        continue;
      }
      const char = code[at]!;
      if (char === "(" || char === "[" || char === "{") brackets += 1;
      else if (char === ")" || char === "]" || char === "}") brackets -= 1;
      else if (char === "<") angle += 1;
      else if (char === ">" && !arrow(code, at)) angle -= 1;
      else if (char === "," && angle === 1 && brackets === 0) parameterStart = true;
      if (brackets < 0) break;
      at += 1;
    }
  }
  return spans;
}

/** How far back to look for the end of the line before: enough for any line of code, never the whole file. */
const LOOKBACK = 400;

/** Words that leave a type unfinished at the end of a line: what follows them is part of it. */
const OPEN_WORDS = new Set(["extends", "keyof", "typeof", "infer", "is", "as", "new", "readonly", "unique", "asserts", "in", "of"]);

/**
 * For every `{` in the code, whether it opens a list of type members: an
 * interface's body, or a type literal -- a `{` written where a type goes,
 * after `:`, `&`, `|`, `<`, `,`, `=`, `(` or `[`.
 *
 * Those last openers also start object literals, and that is harmless here:
 * in an object literal a line opening with `<` right after a value, with no
 * comma between, is not code TypeScript compiles, with or without a `;`. What
 * must never count is a block, where a statement may run on into a line that
 * opens with `<`; a block's `{` follows `)`, `=>`, a name or a keyword, none
 * of which is in the list. An interface's body follows a name or a `>`, so it
 * is found from the `interface` keyword instead.
 */
function memberLists(code: string): Set<number> {
  const lists = new Set<number>();
  const interfaceBodies = new Set<number>();
  for (const match of code.matchAll(/(?<![\w$.])interface\s+[A-Za-z_$][\w$]*/g)) {
    // Its body is the first `{` outside the header's own brackets: `interface A<T = { a: 1 }> extends B<C> {`.
    let angle = 0;
    let depth = 0;
    for (let at = match.index! + match[0].length; at < code.length; at += 1) {
      const char = code[at]!;
      if (char === "{" && depth === 0 && angle === 0) { interfaceBodies.add(at); break; }
      if (char === "(" || char === "[" || char === "{") depth += 1;
      else if (char === ")" || char === "]" || char === "}") { depth -= 1; if (depth < 0) break; }
      else if (char === "<") angle += 1;
      else if (char === ">" && !arrow(code, at)) angle -= 1;
      else if (char === ";" && depth === 0) break;
    }
  }
  for (let at = code.indexOf("{"); at >= 0; at = code.indexOf("{", at + 1)) {
    if (interfaceBodies.has(at)) { lists.add(at); continue; }
    let before = at - 1;
    while (before >= 0 && /\s/.test(code[before]!)) before -= 1;
    if (before >= 0 && /[:&|<,=([]/.test(code[before]!)) lists.add(at);
  }
  return lists;
}

/**
 * The spaces where a `;` ends the member before a call signature on a line of
 * its own -- `<T>(fn: T): T` -- inside a list of type members: one offset each.
 */
function signatureBreaks(code: string): number[] {
  const out: number[] = [];
  const candidates = [...code.matchAll(/\n([ \t]+)<\s*[A-Za-z_$]/g)];
  if (!candidates.length) return out;
  const lists = memberLists(code);
  if (!lists.size) return out;
  // The innermost open bracket at every candidate, in one pass.
  const stack: number[] = [];
  let next = 0;
  for (let at = 0; at < code.length && next < candidates.length; at += 1) {
    const candidate = candidates[next]!;
    const less = candidate.index! + 1 + candidate[1]!.length;
    if (at === less) {
      next += 1;
      const open = stack[stack.length - 1];
      if (open !== undefined && code[open] === "{" && lists.has(open) && endsMember(code, candidate.index!) && signatureShape(code, less)) out.push(less - 1);
    }
    const char = code[at]!;
    if (char === "(" || char === "[" || char === "{") stack.push(at);
    else if (char === ")" || char === "]" || char === "}") stack.pop();
  }
  return out;
}

/** Whether the code before the line break at `at` ends a type: a name, a bracket, a quote or a `>`, never an operator or `=>`. */
function endsMember(code: string, at: number): boolean {
  const before = code.slice(Math.max(0, at - LOOKBACK), at).trimEnd();
  if (!/[\w$)\]}>"'`]$/.test(before) || before.endsWith("=>")) return false;
  const last = /([A-Za-z_$][\w$]*)$/.exec(before)?.[1];
  return !(last && OPEN_WORDS.has(last));
}

/** Whether a call signature starts at `at`: `<...>`, then `(...)`, then `:`. */
function signatureShape(code: string, at: number): boolean {
  let angle = 0;
  for (; at < code.length; at += 1) {
    if (code[at] === "<") angle += 1;
    else if (code[at] === ">" && !arrow(code, at)) { angle -= 1; if (angle === 0) break; }
  }
  at = skipSpace(code, at + 1);
  if (code[at] !== "(") return false;
  let depth = 0;
  for (; at < code.length; at += 1) {
    if (code[at] === "(") depth += 1;
    else if (code[at] === ")") { depth -= 1; if (depth === 0) break; }
  }
  return code[skipSpace(code, at + 1)] === ":";
}

/** The `type` of `export type * from` / `export type * as X from`. */
function typeOnlyStarExports(code: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const match of code.matchAll(/(?<![\w$.])export\s+(type)\s+\*/g)) {
    const at = match.index! + match[0].indexOf("type", 6);
    if (standsAlone(code, at, "type")) out.push([at, at + 4]);
  }
  return out;
}

/**
 * The source with the three rewrites above applied, or undefined when none
 * applies. Same length, same line breaks, as the source.
 */
export function rewriteKnownSyntax(source: string): string | undefined {
  const code = codeOnly(source);
  if (!code) return undefined;
  const chars = source.split("");
  let changed = false;
  for (const [start, end] of [...varianceMarkers(code), ...typeOnlyStarExports(code)]) {
    for (let i = start; i < end; i += 1) chars[i] = " ";
    changed = true;
  }
  for (const at of signatureBreaks(code)) {
    chars[at] = ";";
    changed = true;
  }
  return changed ? chars.join("") : undefined;
}
