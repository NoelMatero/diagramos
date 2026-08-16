/**
 * Blanking comments and string bodies, so a symbol search can tell a use from
 * a mention.
 *
 * The check this feeds asks whether a symbol is declared and used. Without
 * stripping, a file holding nothing but `/// Logs via log_line! and LOGGER.`
 * satisfies both anchors -- measured, and the worst row in `docs/usage-brief.md`.
 *
 * This is also the one component here whose bugs point the wrong way: eating
 * real code makes the check *louder*, and a false alarm costs more than a miss.
 * Hence the bail rule. Anything unterminated or unclassifiable abandons
 * stripping for the whole file, the caller falls back to raw-mention semantics,
 * and the downgrade is counted rather than hidden. A lexer bug can cost
 * precision; it cannot invent a finding.
 *
 * Blanked spans keep their length and their newlines, so offsets and line
 * numbers still line up with the original.
 */

export type Language = "ts" | "rust";

const BY_EXTENSION: Array<[RegExp, Language]> = [
  [/\.(ts|tsx|js|jsx|mjs|cjs)$/, "ts"],
  [/\.rs$/, "rust"],
];

/** The languages with a lexer and a declaration table. Everything else: silence. */
export function languageOf(filePath: string): Language | undefined {
  return BY_EXTENSION.find(([pattern]) => pattern.test(filePath))?.[1];
}

/** Same length, same lines, no content. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/**
 * `undefined` means bail: the caller must fall back to the unstripped source.
 */
export function stripCode(source: string, language: Language): string | undefined {
  return language === "rust" ? stripRust(source) : stripTs(source);
}

/**
 * Whether a `/` here opens a regex literal rather than dividing.
 *
 * The usual heuristic: look back at the last thing that mattered. After a value
 * -- identifier, literal, `)`, `]` -- a slash divides. After an operator, a
 * comma, or a keyword, it opens a regex. `drift.ts` itself is full of regexes
 * containing quotes, so getting this wrong is not hypothetical.
 */
const VALUE_BEFORE_SLASH = /[\w$)\]"'`]$/;
const KEYWORD_BEFORE_SLASH =
  /\b(return|typeof|instanceof|in|of|new|delete|void|do|else|yield|await|case|throw)$/;

function opensRegex(before: string): boolean {
  if (before === "") return true;
  if (KEYWORD_BEFORE_SLASH.test(before)) return true;
  return !VALUE_BEFORE_SLASH.test(before);
}

/**
 * The tail of emitted code, ignoring whitespace, capped so the lookback stays
 * O(1). Scanning the whole output for every `/` made stripping this repo's own
 * `src/` quadratic -- 89 ms, against 3 ms for the same work bounded.
 */
const LOOKBACK = 24;

function pushTail(tail: string, text: string): string {
  // Hot path: one character, once per character of source. A regex here costs
  // more than the rest of the lexer put together.
  if (text.length === 1) {
    const code = text.charCodeAt(0);
    const space = code === 32 || code === 9 || code === 10 || code === 13;
    return space ? tail : (tail + text).slice(-LOOKBACK);
  }
  const solid = text.replace(/\s+$/, "");
  return solid === "" ? tail : (tail + solid).slice(-LOOKBACK);
}

function stripTs(source: string): string | undefined {
  const out: string[] = [];
  let tail = "";
  let index = 0;
  // Each entry is a template literal we are inside; the number is the brace
  // depth of the `${...}` we are currently in, so `}` knows when to go back to
  // literal text. Nested templates inside expressions just push another entry.
  const templates: number[] = [];

  const emit = (text: string, significant?: string): void => {
    out.push(text);
    if (significant !== undefined) tail = pushTail(tail, significant);
  };
  const literalText = (): boolean => templates.length > 0 && templates[templates.length - 1] === 0;

  while (index < source.length) {
    const character = source[index];

    if (literalText()) {
      if (character === "\\") {
        emit(blank(source.slice(index, index + 2)));
        index += 2;
        continue;
      }
      if (character === "`") {
        templates.pop();
        emit("`", "`");
        index += 1;
        continue;
      }
      if (character === "$" && source[index + 1] === "{") {
        // Expressions inside a template are real code: a symbol used there is
        // used. Only the surrounding text is blanked.
        templates[templates.length - 1] = 1;
        emit("${", "{");
        index += 2;
        continue;
      }
      emit(character === "\n" ? "\n" : " ");
      index += 1;
      continue;
    }

    if (character === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      const stop = end < 0 ? source.length : end;
      emit(blank(source.slice(index, stop)));
      index = stop;
      continue;
    }

    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return undefined;
      emit(blank(source.slice(index, end + 2)));
      index = end + 2;
      continue;
    }

    if (character === '"' || character === "'") {
      const end = scanQuoted(source, index, character, false);
      // No closing quote before the line ends. In TypeScript that is a syntax
      // error, so the likelier reading is that this was never a string at all
      // -- an apostrophe in JSX text. Keep it as code and carry on: treating
      // text as code can only make the check quieter, and bailing the whole
      // file over one apostrophe throws away every other line.
      if (end === undefined) {
        emit(character, character);
        index += 1;
        continue;
      }
      emit(character + blank(source.slice(index + 1, end)) + source[end], character);
      index = end + 1;
      continue;
    }

    if (character === "`") {
      templates.push(0);
      emit("`", "`");
      index += 1;
      continue;
    }

    if (character === "/" && opensRegex(tail)) {
      const end = scanRegex(source, index);
      // Same recovery as the quote above, and the reason `.tsx` survives at
      // all: `</div>` and `/>` look exactly like an unterminated regex.
      if (end !== undefined) {
        // A completed regex is a value, so a `/` after it divides.
        emit(blank(source.slice(index, end + 1)), ")");
        index = end + 1;
        continue;
      }
    }

    if (templates.length > 0) {
      if (character === "{") templates[templates.length - 1] += 1;
      if (character === "}") {
        templates[templates.length - 1] -= 1;
        if (templates[templates.length - 1] < 0) return undefined;
      }
    }

    emit(character, character);
    index += 1;
  }

  return templates.length === 0 ? out.join("") : undefined;
}

/**
 * Index of the closing quote, or `undefined` if the string never closes.
 *
 * `multiline` is the difference between the two languages: a Rust `"..."` may
 * legally contain a raw newline, a TypeScript one may not.
 */
function scanQuoted(
  source: string,
  start: number,
  quote: string,
  multiline: boolean,
): number | undefined {
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "\n" && !multiline) return undefined;
    if (character === quote) return index;
  }
  return undefined;
}

/** Index of the closing `/`, honouring `[...]` where a slash is literal. */
function scanRegex(source: string, start: number): number | undefined {
  let inClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "\n") return undefined;
    if (character === "[") inClass = true;
    else if (character === "]") inClass = false;
    else if (character === "/" && !inClass) return index;
  }
  return undefined;
}

const IDENTIFIER_START = /[A-Za-z_]/;

function stripRust(source: string): string | undefined {
  let out = "";
  let index = 0;

  while (index < source.length) {
    const character = source[index];

    if (character === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      const stop = end < 0 ? source.length : end;
      out += blank(source.slice(index, stop));
      index = stop;
      continue;
    }

    // Rust block comments nest, which is why this counts rather than searching
    // for the first `*/`.
    if (character === "/" && source[index + 1] === "*") {
      let depth = 0;
      let scan = index;
      while (scan < source.length) {
        if (source[scan] === "/" && source[scan + 1] === "*") {
          depth += 1;
          scan += 2;
        } else if (source[scan] === "*" && source[scan + 1] === "/") {
          depth -= 1;
          scan += 2;
          if (depth === 0) break;
        } else {
          scan += 1;
        }
      }
      if (depth !== 0) return undefined;
      out += blank(source.slice(index, scan));
      index = scan;
      continue;
    }

    const raw = rawStringAt(source, index);
    if (raw) {
      out += blank(source.slice(index, raw.end));
      index = raw.end;
      continue;
    }

    if (character === '"' || (character === "b" && source[index + 1] === '"')) {
      const quote = character === '"' ? index : index + 1;
      const end = scanQuoted(source, quote, '"', true);
      if (end === undefined) return undefined;
      out += blank(source.slice(index, end + 1));
      index = end + 1;
      continue;
    }

    if (character === "'" || (character === "b" && source[index + 1] === "'")) {
      const tick = character === "'" ? index : index + 1;
      const after = source[tick + 1];
      // `'a'` is a char and `'static` is a lifetime. They differ only in what
      // comes two characters along, except for an escape, which is always a
      // char, and a non-identifier body like `'"'`, which cannot be a lifetime.
      const isChar =
        after === "\\" || !IDENTIFIER_START.test(after ?? "") || source[tick + 2] === "'";
      if (!isChar) {
        out += character;
        index += 1;
        continue;
      }
      const end = scanChar(source, tick);
      if (end === undefined) return undefined;
      out += blank(source.slice(index, end + 1));
      index = end + 1;
      continue;
    }

    out += character;
    index += 1;
  }

  return out;
}

/** `r"..."`, `r#"..."#`, `br##"..."##`. Returns the index just past the close. */
function rawStringAt(source: string, start: number): { end: number } | undefined {
  let index = start;
  if (source[index] === "b") index += 1;
  if (source[index] !== "r") return undefined;
  index += 1;
  let hashes = 0;
  while (source[index] === "#") {
    hashes += 1;
    index += 1;
  }
  if (source[index] !== '"') return undefined;
  const terminator = `"${"#".repeat(hashes)}`;
  const close = source.indexOf(terminator, index + 1);
  if (close < 0) return undefined;
  return { end: close + terminator.length };
}

/** Index of the closing `'` of a char literal. */
function scanChar(source: string, start: number): number | undefined {
  let index = start + 1;
  if (source[index] === "\\") index += 2;
  else index += 1;
  return source[index] === "'" ? index : undefined;
}
