/**
 * Reading past a line the parser cannot read (#462).
 *
 * The bundled TypeScript grammar fails on two pieces of ordinary syntax --
 * variance markers, `type P<in out T>`, and a generic call signature in an
 * interface, `<T>(fn: T): T` -- and tree-sitter's recovery does not always
 * stay local. In MobX's `api/action.ts` one such interface near the top
 * turned the whole file into a single `ERROR` node, and every function below
 * it was lost: `runInAction` could not be found, so no arrow at it was read.
 *
 * So what the parser could not read is blanked and the file parsed again,
 * until it parses. Blanking keeps every other character where it was: spaces
 * for text, newlines kept, so every offset and line number in the new tree is
 * the original file's, and `node.text` outside the blanked text is what is
 * written there.
 *
 * First the text the parser flagged, when it is on one line with matching
 * brackets and blanking it gets the parse past it: zod's `interface
 * ZodType<out Output>` fails on the word `out` alone. Otherwise a statement
 * or a member, never a stray line: it starts where a statement starts at its
 * bracket depth and runs until the depth comes back, so its brackets always
 * match and blanking it cannot re-nest the code around it. The smallest one
 * holding the error goes first -- one member of an interface -- and a wider
 * one only when the error is still there.
 *
 * Blanked text is unread, not absent. `parse.ts` keeps it next to the tree, and every reader that asks whether what it read is whole asks them as
 * well: a routine overlapping one is as incomplete as a routine holding an
 * `ERROR`, and a question about the whole file stays withheld as it always
 * was. What changes is the rest of the file, which now reads as written.
 *
 * Measured over the 42 census projects: 47 TypeScript files did not parse
 * and 44 now do, most for a word (`out`) or one interface; 2 of 3 Rust files.
 * The slowest took 1.5 s, once per file per run. A file that still does not
 * parse after `ROUNDS` keeps the parser's own tree, as before.
 */
import type { Language } from "./parse";

/** Blanked stretches before giving up on a file and keeping the parser's own tree. */
export const ROUNDS = 48;

/** Good top-level statements passed over looking for the one that does not parse, per round. */
const SKIPS = 8;

/** Lines `[first, last]`, 0-based. */
type UnreadRows = Array<[number, number]>;

/**
 * Bracket depth at the start of every line, strings and comments skipped,
 * and one more entry for the depth at the end of the file. Undefined when a
 * comment, a template or a triple-quoted string never ends: blanking a line
 * of such a file can turn text that was never code into code.
 */
export function depthAtLines(source: string, language: Language): number[] | undefined {
  const out: number[] = [0];
  const python = language === "python";
  const rust = language === "rust";
  let depth = 0;
  let index = 0;
  const length = source.length;
  const newline = () => out.push(depth);
  while (index < length) {
    const char = source[index]!;
    if (char === "\n") { newline(); index += 1; continue; }
    if ((!python && char === "/" && source[index + 1] === "/") || (python && char === "#")) {
      while (index < length && source[index] !== "\n") index += 1;
      continue;
    }
    if (!python && char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") newline();
        index += 1;
      }
      if (index >= length) return undefined;
      index += 2;
      continue;
    }
    if (python && (source.startsWith('"""', index) || source.startsWith("'''", index))) {
      const quote = source.slice(index, index + 3);
      index += 3;
      while (index < length && !source.startsWith(quote, index)) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === "\n") newline();
        index += 1;
      }
      if (index >= length) return undefined;
      index += 3;
      continue;
    }
    if (char === '"' || char === "`" || (char === "'" && !rust)) {
      index += 1;
      while (index < length && source[index] !== char) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === "\n") {
          // Only a template literal runs on past the end of its line.
          if (char !== "`") break;
          newline();
        }
        index += 1;
      }
      if (index >= length && char === "`") return undefined;
      index += 1;
      continue;
    }
    if (rust && char === "'") {
      // `'x'` and `'\n'` are characters; `'a` is a lifetime and has no closing quote.
      const literal = /^'(\\.|[^\\'\n])'/.exec(source.slice(index, index + 12));
      index += literal ? literal[0].length : 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    index += 1;
  }
  out.push(depth);
  return out;
}

/**
 * The statement at bracket depth `level` that holds line `row`: from the line
 * where it starts to the line before the next statement at that depth, or
 * before the bracket that closes the depth. Undefined where `row` is not
 * inside one.
 */
export function statementAt(lines: readonly string[], depth: readonly number[], row: number, level: number): [number, number] | undefined {
  const closes = (line: number) => /^\s*[)\]}]/.test(lines[line]!);
  const starts = (line: number) => depth[line] === level && /\S/.test(lines[line]!) && !closes(line);
  let first = row;
  while (first >= 0 && depth[first]! >= level && !starts(first)) first -= 1;
  if (first < 0 || !starts(first)) return undefined;
  let next = first + 1;
  while (next < lines.length && !(depth[next]! < level || (depth[next] === level && (starts(next) || closes(next))))) next += 1;
  // Running off the end with a bracket still open is not a statement that ends.
  if (next === lines.length && depth[next] !== level) return undefined;
  return [first, next - 1];
}

/** Where a parse first went wrong: its 0-based line, and the offsets of what the parser could not read there. */
export interface ParseError { row: number; start: number; end: number }

/** Offsets `[start, end)` of the source that were blanked. */
export type UnreadSpans = Array<[number, number]>;

/**
 * Blank what the parser cannot read until `errorAt` says the text parses.
 * `undefined` back means the file could not be read whole in `ROUNDS`.
 *
 * Each round tries the least first. The text the parser flagged, when it is
 * on one line and its brackets match: zod's `interface ZodType<out Output>`
 * fails on the word `out` alone, and blanking the word keeps the interface.
 * Kept only when the parse then gets past it; otherwise the statement around
 * it, as above.
 */
export function blankUnreadable(
  source: string,
  language: Language,
  errorAt: (text: string) => ParseError | undefined,
): { text: string; unread: UnreadSpans } | undefined {
  const lines = source.split("\n");
  const depth = depthAtLines(source, language);
  if (!depth) return undefined;
  const starts = [0];
  for (const line of lines) starts.push(starts[starts.length - 1]! + line.length + 1);
  const statements: UnreadRows = [];
  const covered = (first: number, last: number) => statements.some(([a, b]) => a <= first && last <= b);
  const unread: UnreadSpans = [];
  let text = source;
  for (let round = 0; round <= ROUNDS; round += 1) {
    const error = errorAt(text);
    if (!error) return unread.length ? { text, unread: mergedSpans(unread) } : undefined;
    if (round === ROUNDS) return undefined;

    const flagged = text.slice(error.start, error.end);
    if (flagged.trim() && !flagged.includes("\n") && matched(flagged)) {
      const trial = blank(text, error.start, error.end);
      const after = errorAt(trial);
      if (!after || after.start >= error.end) {
        unread.push([error.start, error.end]);
        text = trial;
        continue;
      }
    }

    const row = error.row;
    // The smallest statement around the error not blanked yet: the same spot failing again widens it.
    let chosen: [number, number] | undefined;
    for (let level = depth[row] ?? 0; level >= 0 && !chosen; level -= 1) {
      const statement = statementAt(lines, depth, row, level);
      if (statement && !covered(statement[0], statement[1])) chosen = statement;
    }
    /*
     * A parser's error can be reported on the last line of a good statement,
     * when what follows it is what it could not read. A top-level statement
     * that parses on its own is not the trouble: the next one is.
     */
    for (let skipped = 0; chosen && depth[chosen[0]] === 0 && errorAt(alone(lines, chosen)) === undefined; skipped += 1) {
      chosen = skipped < SKIPS ? nextStatement(lines, depth, chosen[1] + 1, covered) : undefined;
    }
    if (!chosen) return undefined;
    statements.push(chosen);
    const span: [number, number] = [starts[chosen[0]]!, starts[chosen[1] + 1]! - 1];
    unread.push(span);
    text = blank(text, span[0], span[1]);
  }
  return undefined;
}

/** Every character in `[start, end)` a space, newlines kept: every offset stays where it was. */
function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, " ") + text.slice(end);
}

/** Whether every bracket opened in this text closes in it. */
function matched(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** The first top-level statement from line `from` on that is not blanked yet. */
function nextStatement(
  lines: readonly string[],
  depth: readonly number[],
  from: number,
  covered: (first: number, last: number) => boolean,
): [number, number] | undefined {
  for (let line = from; line < lines.length; line += 1) {
    if (depth[line] !== 0 || !/\S/.test(lines[line]!)) continue;
    const statement = statementAt(lines, depth, line, 0);
    if (statement && !covered(statement[0], statement[1])) return statement;
    if (statement) line = statement[1];
  }
  return undefined;
}

/** One statement's own lines, to parse on their own. */
function alone(lines: readonly string[], [first, last]: [number, number]): string {
  return lines.slice(first, last + 1).join("\n");
}

function mergedSpans(spans: UnreadSpans): UnreadSpans {
  const out: UnreadSpans = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const previous = out[out.length - 1];
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else out.push([start, end]);
  }
  return out;
}
