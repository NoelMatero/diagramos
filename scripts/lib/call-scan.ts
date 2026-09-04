/**
 * The call referee: routines and their call sites, read off the screen.
 *
 * Lifted out of `measure-calls.mts` unchanged when a second measurement needed
 * the same independence (#217). It exists to disagree with `calls.ts`, so the
 * one property that matters is what it does *not* share: no tree-sitter query,
 * no grammar, no import resolution. It finds a routine by the shape of its
 * opening line, a call by the shape of `name(`, and it resolves nothing.
 *
 * `licence.ts` cites it by name as the referee behind every `calls` square in
 * the grid, so it is a measured instrument rather than a helper -- changing what
 * it counts invalidates a licence, and that is the reason it lives in one file
 * instead of two copies.
 */
import { type Language } from "../../src/engine/parse";


const TS_OPENS =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)|^\s*(?:export\s+)?const\s+(\w+)\s*(?::[^=]*)?=\s*(?:async\s*)?\(/;

const OPENS = new Map<Language, RegExp>([
  ["rust", /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/],
  ["ts", TS_OPENS],
  ["tsx", TS_OPENS],
  ["js", TS_OPENS],
  ["python", /^\s*(?:async\s+)?def\s+(\w+)/],
]);

/**
 * Words that put a name in front of a bracket and call nothing.
 *
 * Control flow is most of it. `new` is the one that matters beyond that: a
 * construction is not a call node in any of these grammars, so counting `new
 * Foo(` as a call to `Foo` would blame the reader for a distinction the
 * language makes.
 */
export const NOT_CALLS = new Set([
  "if", "for", "while", "switch", "catch", "return", "match", "with", "elif",
  "else", "and", "or", "not", "in", "is", "await", "yield", "typeof", "instanceof",
  "fn", "def", "class", "struct", "enum", "impl", "trait", "let", "const", "var",
  "function", "lambda", "assert", "del", "raise", "throw", "new", "print", "loop",
  "unsafe", "move", "as", "type", "interface", "mod", "use", "pub", "static",
  "do", "try", "except", "finally", "case", "default", "break", "continue",
]);

/**
 * Strings and comments, blanked so a mention in prose is not a call.
 *
 * Per language, and that is not fussiness. Blanking C block comments in Python
 * cost 38 of the 45 disagreements left in one run: a `.graphifyignore` test
 * writes the pattern `/*` into a file, which opens a comment that has no end
 * for two thousand lines. Every `def` in between vanished, one routine appeared
 * to span the rest of the file, and the calls in it were credited to the wrong
 * routine -- which the reader was then blamed for not seeing.
 *
 * Strings go before line comments so a `//` inside a URL survives, and Rust's
 * single quotes are left alone: `&'a str` is a lifetime, and reading it as a
 * character literal eats the rest of the line.
 *
 * Rust's raw strings are the same lesson as the template literal, found the same
 * way. `r#".."#` spans lines and honours no escape, so the per-line rule below
 * never closes one: ripgrep writes every flag's help text as a multi-line raw
 * string, and the prose in them read as code. `enabled`, `files` and `dot` are
 * ordinary English words and each is also a routine ripgrep declares exactly
 * once, so five calls were credited to `doc_long` and counted as the reader
 * missing them. Blanked with the block forms, before the line split.
 */
export function stripNoise(source: string, language: Language): string {
  const blank = (block: string) => block.replace(/[^\n]/g, " ");
  const text = language === "python"
    ? source.replace(/"""[\s\S]*?"""/g, blank).replace(/'''[\s\S]*?'''/g, blank)
    : source.replace(/\/\*[\s\S]*?\*\//g, blank);
  /*
   * A template literal spans lines, so it is blanked with the block forms
   * rather than per line. A spinner's CSS keyframes live in one, and
   * `transform: rotate(45deg)` in there read as a call to a `rotate` declared
   * on the other side of the monorepo.
   */
  const spanned = language === "python" ? text : text.replace(/`(?:[^`\\]|\\.)*`/g, blank);
  /*
   * Most hashes first, because `r#"` is a prefix of `r##"` and the shorter
   * pattern would close on the longer one's opening quote. Three is past what
   * any of this corpus writes; a fourth would read as an ordinary string and
   * fail the way it does today rather than a new way.
   */
  const spanning = language === "rust"
    ? spanned.replace(
        /\bb?r###"[\s\S]*?"###|\bb?r##"[\s\S]*?"##|\bb?r#"[\s\S]*?"#|\bb?r"[^"]*"/g,
        blank,
      )
    : spanned;
  const quoted = language === "rust"
    ? /"(?:[^"\\\n]|\\.)*"/g
    : /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
  const comment = language === "python" ? /#.*$/ : /\/\/.*$/;
  return spanning.split("\n")
    .map((line) => line.replace(quoted, '""').replace(comment, ""))
    .join("\n");
}

export interface RefereeRoutine {
  name: string;
  line: number;
  /** Names it calls, each with the line the call is on. */
  calls: Array<{
    name: string;
    line: number;
    via: "bare" | "receiver";
    /**
     * `new Foo(..)` rather than `foo(..)`.
     *
     * Recorded, not filtered, so `measure:calls` keeps the exact population it
     * was licensed on -- its own filter to names the tree declares once already
     * drops `new Set(..)` and friends. A caller that compares raw call-site
     * counts has no such filter and needs this: a construction is not a call
     * node in any of these grammars, and `NOT_CALLS` above says so, but it can
     * only skip the word `new` itself and not the name after it. (#217)
     */
    construction: boolean;
  }>;
}

/**
 * A name in front of a bracket.
 *
 * `$` counts as part of an identifier, which is what keeps `db.$count(..)` from
 * reading as a bare call to a `count` declared elsewhere: without it the word
 * boundary falls between the `$` and the name, and the receiver disappears.
 */
export const CALL_TOKEN = /([A-Za-z_$][\w$]*)\s*\(/g;

/**
 * Whether the calling file binds this name itself.
 *
 * The referee's own blind spot, stated rather than worked around. Its index
 * knows which files *declare a routine* of a name, and it recognises a routine
 * by the shape of its opening line -- so `const applyVar = React.useCallback(`
 * and `const provider = registry.get(elementId)` are invisible to it. When one
 * of those shares a name with a routine somewhere else in the tree, the referee
 * reads the local call as a call across the repository, and the reader
 * correctly disagrees.
 *
 * Five of the last five disagreements were exactly that. A referee that cannot
 * tell which of two same-named things is meant has no business asking, so it
 * does not ask.
 */
export function bindsLocally(source: string, name: string): boolean {
  return new RegExp(`\\b(?:const|let|var|function|def|fn|class|struct)\\s+${name}\\b`).test(source);
}

/**
 * A method written in an object literal: `dispose() { .. }`, `play(name) { .. }`.
 *
 * A definition, not a call, and it looks exactly like one to a text scan. Six
 * of the disagreements in one run were an audio patch's `play`, `get` and
 * `dispose` shorthand methods being read as calls to same-named routines
 * elsewhere in the monorepo.
 *
 * The shape is the name at the head of the line and a brace at the end of it,
 * with no arrow in between -- `describe("x", () => {` is a call and keeps its
 * arrow, which is what separates the two.
 */
function isMethodShorthand(line: string, at: number): boolean {
  return line.slice(0, at).trim() === "" && /\{\s*$/.test(line) && !line.includes("=>");
}

/**
 * Whether a call token was written on a receiver: `path.resolve(..)`,
 * `Type::make(..)`, `obj?.run(..)`.
 *
 * This is the referee's own limit, and it decides the population. A text scan
 * can say with certainty that `foo()` is a call to whatever `foo` is; it cannot
 * say the first thing about whose `resolve` is being called in `path.resolve()`.
 * Counting those as calls to a same-named routine in the repository is how the
 * referee accused the reader of missing 137 calls to `_file_stem` and one to
 * `resolve` in `apps/server/src/lib/slack/config-token.ts`, which is Node's
 * `path.resolve` and nothing to do with that file at all.
 *
 * So the two populations are reported apart. A receiver call is a call the
 * referee cannot place either, and the reader refusing it is the right answer
 * rather than a refusal held against it.
 */
function viaReceiver(code: string, at: number): boolean {
  if (code[at - 1] === ".") return true;
  return code.slice(at - 2, at) === "::";
}
const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * Routines and the calls inside them, read off the screen.
 *
 * Braces bound a routine in three of the four languages and indentation bounds
 * it in the fourth, which is the only place this has to know a language apart.
 * Nested closures are credited to the routine that encloses them -- the same
 * answer the reader gives, and the same answer a person would.
 */
export function refereeRoutines(source: string, language: Language): RefereeRoutine[] {
  const opens = OPENS.get(language);
  if (!opens) return [];
  const lines = stripNoise(source, language).split("\n");
  const found: RefereeRoutine[] = [];
  let current: RefereeRoutine | undefined;
  let depth = 0;
  let opened = 0;
  let indent = 0;
  /** Whether a brace body has actually opened, for the arrow-function case. */
  let started = false;

  for (const [index, raw] of lines.entries()) {
    const start = opens.exec(raw);
    if (start) {
      current = { name: start[1] ?? start[2]!, line: index + 1, calls: [] };
      found.push(current);
      opened = depth;
      indent = indentOf(raw);
      started = false;
    } else if (current && language === "python" && raw.trim() !== "" && indentOf(raw) <= indent) {
      current = undefined;
    }
    if (!current) continue;
    // The declaration's own name sits in front of its parameter list and is not
    // a call. Everything after the opening bracket is.
    const code = start ? raw.slice(raw.indexOf("(", start.index) + 1) : raw;
    for (const hit of code.matchAll(CALL_TOKEN)) {
      const name = hit[1]!;
      if (NOT_CALLS.has(name)) continue;
      if (isMethodShorthand(code, hit.index)) continue;
      current.calls.push({
        name,
        line: index + 1,
        via: viaReceiver(code, hit.index) ? "receiver" : "bare",
        construction: /\bnew\s+$/.test(code.slice(0, hit.index)),
      });
    }
    if (language !== "python") {
      depth += (raw.match(/\{/g) ?? []).length - (raw.match(/\}/g) ?? []).length;
      if (depth > opened) started = true;
      /*
       * An arrow function with an expression body never opens a brace, so brace
       * depth alone kept it open until the next routine and credited it with
       * everything in between. `const customComparer = () => true;` in a test
       * file was read as making the five calls written after it.
       *
       * A statement that ends before a body opens is one of those, and it ends
       * where its semicolon is.
       */
      if (started && depth <= opened) current = undefined;
      else if (!started && depth <= opened && /;\s*$/.test(raw)) current = undefined;
    }
  }
  return found;
}
