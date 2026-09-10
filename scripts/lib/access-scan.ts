/**
 * The referee for `@accesses`: what a person reads off the screen.
 *
 * A text scan of the source that shares **no tree-sitter query** with the
 * reader in `src/engine/accesses.ts`, so agreeing means two unrelated
 * readings agree rather than one reading agreeing with itself -- the mistake
 * that got two orders of magnitude into #190.
 *
 * Crude on purpose. It claims only what a person would read off the screen
 * without hesitating: a declaration header, then the lines under it that
 * plainly name a member; a routine opening, then the `.name` tokens inside
 * it. Being crude is what makes it independent, and being independent is the
 * point.
 *
 * Lifted out of `scripts/measure-accesses.mts` unchanged for #255, which
 * needs the same second opinion for a different question -- whether a body's
 * *whole* read set was seen. Two copies of a referee is two things to fix
 * when one of them is wrong, and this one has been wrong: #222 found seven
 * separate ways it invented reads that were not there, including a docstring
 * that deleted the next eighty lines of a Python file. `call-scan.ts` exists
 * for the same reason on the `@calls` side.
 */
import type { Language } from "../../src/engine/parse";

/* ------------------------------------------------------------------ *
 * The referee, part one: what a type declares.
 * ------------------------------------------------------------------ */

export interface RefereeType {
  name: string;
  /** Member names written in its declaration, as a person would read them off. */
  members: string[];
  line: number;
}

/**
 * A declaration header, and the parent clause if it has one.
 *
 * The parent is captured rather than skipped, because the reader withholds on
 * an inherited member list and a referee that never offered it one would be
 * unable to say how often that refusal fires.
 */
const HEADER = new Map<Language, RegExp>([
  ["rust", /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Z]\w*)/],
  ["ts", /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:interface|class)\s+([A-Z]\w*)/],
  ["tsx", /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:interface|class)\s+([A-Z]\w*)/],
  ["js", /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Z]\w*)/],
  ["python", /^\s*class\s+([A-Z]\w*)/],
]);

/** A line a person would read as "this type has a member of this name". */
const MEMBER = new Map<Language, RegExp>([
  ["rust", /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|const|unsafe)\s+)*(?:fn\s+)?([a-z_]\w*)\s*[:(]/],
  ["ts", /^\s*(?:(?:readonly|public|private|protected|static|abstract|declare|get|set|async)\s+)*#?([A-Za-z_$][\w$]*)\??\s*[:(<]/],
  ["tsx", /^\s*(?:(?:readonly|public|private|protected|static|abstract|declare|get|set|async)\s+)*#?([A-Za-z_$][\w$]*)\??\s*[:(<]/],
  ["js", /^\s*(?:(?:static|get|set|async)\s+)*#?([A-Za-z_$][\w$]*)\s*[(=]/],
  ["python", /^\s+(?:def\s+)?([a-z_]\w*)\s*[:(=]/],
]);

/** An attribute a Python method sets on the instance. Most of them are here. */
const SELF_SET = /\bself\.([a-z_]\w*)\s*(?:[:+\-*/|&^]?=[^=]|$)/g;

/** A Rust `impl` block, which is where a struct's methods actually live. */
const RUST_IMPL = /^\s*impl(?:\s*<[^>]*>)?\s+(?:([A-Za-z_]\w*(?:<[^>]*>)?)\s+for\s+)?([A-Z]\w*)/;

/**
 * Words a header line carries that mean the member list is not closed.
 *
 * The reader withholds on these and the referee has to know which lines they
 * are, or every inherited member reads as one the reader lost.
 */
function headerHasParent(line: string, language: Language): boolean {
  if (language === "python") return /^\s*class\s+[A-Z]\w*\s*\(\s*[^)\s]/.test(line);
  if (language === "rust") return /:\s*[A-Z]/.test(line.split("{")[0] ?? "");
  return /\b(extends|implements)\b/.test(line);
}

/**
 * The source with every block comment and docstring blanked, line count intact.
 *
 * A Python docstring is a string literal spanning lines, and it sits at exactly
 * the indent a member sits at. `run_scenario() which patches the four boundary
 * dependencies` in a class docstring read as a member called `run_scenario`,
 * and the reader was blamed for not finding it -- one of the three shapes left
 * in the second run's accusation column, all three of them the referee's.
 */
function blanked(source: string, language: Language): string {
  const hollow = (block: string) => block.replace(/[^\n]/g, " ");
  /*
   * Python first, and it never sees the block-comment pass. A slash-star pair
   * is not a comment in Python, and running that pass there cost this
   * measurement its worst single site.
   * `graphify/extractors/_strip_jsonc` has a docstring that *describes*
   * stripping them: the unclosed slash-star on its third line paired with the
   * one in the regex ten lines below, blanking the docstring's own closing
   * quotes on the way. The next docstring in the file then paired with the
   * opening one, two `def` lines went out with it, and `_strip_jsonc` stayed
   * open for the rest of the file -- 24 member reads on one line, none of them
   * in that function. Every other Python routine below it stopped existing.
   */
  if (language === "python") {
    /*
     * Walked, for the same reason the other languages are. A triple quote
     * inside an ordinary string opens nothing, and matching on the text alone
     * cannot tell: `text.strip('"""').strip("\'\'\'")` in graphify's
     * `extract.py` paired its inner triple quote with a docstring 80 lines
     * below, blanked every `def` in between, and handed six reads from a
     * docstring to a routine that had ended long before.
     */
    let out = "";
    let at = 0;
    while (at < source.length) {
      const triple = source.startsWith('"""', at) ? '"""' : source.startsWith("'''", at) ? "'''" : "";
      if (triple !== "") {
        const found = source.indexOf(triple, at + 3);
        const end = found === -1 ? source.length : found + 3;
        out += hollow(source.slice(at, end));
        at = end;
        continue;
      }
      const here = source[at]!;
      if (here === "#") {
        const line = source.indexOf("\n", at);
        const end = line === -1 ? source.length : line;
        out += hollow(source.slice(at, end));
        at = end;
        continue;
      }
      if (here === '"' || here === "'") {
        let end = at + 1;
        while (end < source.length && source[end] !== here && source[end] !== "\n") {
          end += source[end] === "\\" ? 2 : 1;
        }
        end = Math.min(end + 1, source.length);
        out += source.slice(at, end);
        at = end;
        continue;
      }
      out += here;
      at += 1;
    }
    return out;
  }
  /*
   * A template literal is a string, and this repository keeps whole scripts
   * and stylesheets inside them. `const SCRIPT = \`const fmt = (iso) => { .. }\``
   * in `boards-page.ts` read as fourteen routines the reader could not find,
   * because in the tree they are one string. Blanked, not parsed: what a
   * browser eventually runs is not a declaration in this file.
   *
   * Walked rather than matched, and that is not tidiness. Two regexes doing
   * this found their opening marks inside other literals: `const routeRegex =
   * /([\'"`])(\/[\w]+)\1/g` in `drift.ts` has a backtick inside a character
   * class, and the template-literal pass read it as the start of one -- so it
   * blanked from there to the next backtick in the file, 1,000 lines away, and
   * `getRouteLiterals` never closed. Eleven of the misses left after the
   * literal fixes were that one line. A scanner that consumes a comment, a
   * string and a regular expression in the order it meets them cannot be
   * fooled that way, because it is never inside one without knowing.
   */
  let out = "";
  let at = 0;
  while (at < source.length) {
    const here = source[at]!;

    if (here === "/" && source[at + 1] === "*") {
      // Rust nests block comments; the others do not, and `indexOf` is right
      // for them.
      let end = at + 2;
      let open = 1;
      while (end < source.length && open > 0) {
        if (language === "rust" && source.startsWith("/*", end)) { open += 1; end += 2; continue; }
        if (source.startsWith("*/", end)) { open -= 1; end += 2; continue; }
        end += 1;
      }
      out += hollow(source.slice(at, end));
      at = end;
      continue;
    }

    if (here === "/" && source[at + 1] === "/") {
      const line = source.indexOf("\n", at);
      const end = line === -1 ? source.length : line;
      out += hollow(source.slice(at, end));
      at = end;
      continue;
    }

    if (here === "`") {
      let end = at + 1;
      while (end < source.length && source[end] !== "`") end += source[end] === "\\" ? 2 : 1;
      end = Math.min(end + 1, source.length);
      out += hollow(source.slice(at, end));
      at = end;
      continue;
    }

    /*
     * A Rust raw string, kept whole. Its hashes are not attributes and its
     * quotes do not pair with anything outside it.
     */
    if (language === "rust") {
      const raw = /^b?r(#*)"/.exec(source.slice(at, at + 16));
      if (raw) {
        const closing = `"${raw[1]!}`;
        const found = source.indexOf(closing, at + raw[0]!.length);
        const end = found === -1 ? source.length : found + closing.length;
        out += hollow(source.slice(at, end));
        at = end;
        continue;
      }
    }

    /*
     * A string, kept as written: `strip` empties it line by line, and the
     * declaration scan needs the line it sits on to keep its shape. It is
     * consumed here only so a quote inside it cannot open something else.
     */
    if (here === '"' || (here === "'" && charLiteralHere(source, at, language))) {
      let end = at + 1;
      while (end < source.length && source[end] !== here && source[end] !== "\n") {
        end += source[end] === "\\" ? 2 : 1;
      }
      end = Math.min(end + 1, source.length);
      out += source.slice(at, end);
      at = end;
      continue;
    }

    if (language !== "rust" && here === "/" && regexMayStart(out)) {
      const line = source.indexOf("\n", at);
      const to = line === -1 ? source.length : line;
      const end = endOfRegex(source.slice(at, to), 0);
      if (end !== -1) {
        out += source.slice(at, at + end);
        at += end;
        continue;
      }
    }

    out += here;
    at += 1;
  }
  return out;
}

/**
 * A line with its comments and string literals taken out.
 *
 * The comment marker is per language, and getting that wrong cost the first
 * run more accusations than anything else. `#` is a comment in Python and a
 * **private field sigil** in TypeScript, so stripping it everywhere turned
 * `async #flush(): Promise<void> {` into `async` -- the brace went with it, the
 * method never opened, and every line of its body was read as a member of the
 * enclosing class. `BoardSync has no if` is what that looks like from the far
 * end, and `measure-holds.mts`'s referee carries the same line today.
 */
function strip(line: string, language: Language): string {
  const hash = language === "python" || language === "rust";
  const doubleSlash = language !== "python";
  const regexes = language === "ts" || language === "tsx" || language === "js";

  let out = "";
  let at = 0;

  while (at < line.length) {
    const here = line[at]!;

    /*
     * A Rust raw string, whose hashes are part of the literal. Read as an
     * attribute they take the rest of the line with them, and the closing
     * bracket of whatever call the string sits in goes too.
     */
    if (language === "rust") {
      const raw = /^b?r(#*)"/.exec(line.slice(at));
      if (raw) {
        const closing = `"${raw[1]!}`;
        const end = line.indexOf(closing, at + raw[0]!.length);
        out += '""';
        at = end === -1 ? line.length : end + closing.length;
        continue;
      }
    }

    if (here === '"' || (here === "'" && charLiteralHere(line, at, language))) {
      out += `${here}${here}`;
      at = endOfQuoted(line, at);
      continue;
    }

    if (hash && here === "#") break;
    if (doubleSlash && here === "/" && line[at + 1] === "/") break;

    /*
     * A regular expression literal, which is neither a member read nor a
     * brace. Both halves of that mattered: `/\.(py|lua|cpp)/` handed the
     * referee three member reads called `py`, `lua` and `cpp`, and a `\{`
     * inside one counted as an opening brace that nothing ever closed --
     * which is how `refereeTypes` in `measure-holds.mts` stayed open for 130
     * lines and collected every member read below it.
     */
    if (regexes && here === "/" && regexMayStart(out)) {
      const end = endOfRegex(line, at);
      if (end !== -1) { out += " "; at = end; continue; }
    }

    out += here;
    at += 1;
  }
  return out;
}

/**
 * Whether a `/` here opens a regular expression rather than dividing.
 *
 * The last thing written decides it: a value can be divided, a keyword or an
 * operator cannot. `return /\)\s*\{/.test(code)` is the case the last-character
 * rule alone gets wrong -- `return` ends in a word character and reads exactly
 * like a variable being divided.
 */
function regexMayStart(before: string): boolean {
  const trimmed = before.replace(/\s+$/, "");
  if (trimmed === "") return true;
  if (/\b(return|typeof|instanceof|case|in|of|new|delete|void|do|else|yield|await)$/.test(trimmed)) {
    return true;
  }
  return !/[\w$)\]]/.test(trimmed.slice(-1));
}

/** One past the closing quote, or the end of the line if it never closes. */
function endOfQuoted(line: string, at: number): number {
  const quote = line[at]!;
  let i = at + 1;
  while (i < line.length) {
    if (line[i] === "\\") { i += 2; continue; }
    if (line[i] === quote) return i + 1;
    i += 1;
  }
  return line.length;
}

/**
 * One past a regular expression literal and its flags, or -1 if it never
 * closes -- in which case the `/` was something else and is kept.
 */
function endOfRegex(line: string, at: number): number {
  let i = at + 1;
  let inClass = false;
  while (i < line.length) {
    const here = line[i]!;
    if (here === "\\") { i += 2; continue; }
    if (here === "[") inClass = true;
    else if (here === "]") inClass = false;
    else if (here === "/" && !inClass) {
      return i + 1 + (/^[dgimsuvy]*/.exec(line.slice(i + 1))?.[0].length ?? 0);
    }
    i += 1;
  }
  return -1;
}

/**
 * Whether a `'` here opens a literal rather than naming a Rust lifetime.
 *
 * `&'a str` and `'x'` start the same way and only one of them is a literal.
 * Reading a lifetime as a quote swallows the rest of the line up to the next
 * apostrophe, which in Rust is usually the next lifetime.
 */
function charLiteralHere(line: string, at: number, language: Language): boolean {
  if (language !== "rust") return true;
  return /^'(?:\\.|[^'\\])'/.test(line.slice(at));
}

/**
 * The pieces of a one-line declaration body that belong to *that* declaration.
 *
 * Splitting the whole body on semicolons reaches into any type nested in it.
 * `interface LspRange { start: { line: number; character: number } }` handed
 * `character` to LspRange, and the reader -- correctly -- said LspRange has no
 * member of that name. Two of those were the whole ACCUSED column, whose bar
 * is zero, and the multi-line path had guarded against exactly this since it
 * was written.
 */
function ownParts(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let piece = "";
  for (const character of body) {
    if (character === "{" || character === "(" || character === "[") depth += 1;
    else if (character === "}" || character === ")" || character === "]") depth -= 1;
    // The declaration's own closing brace. Everything after it is somebody else.
    if (depth < 0) break;
    if (depth === 0 && (character === ";" || character === ",")) {
      parts.push(piece);
      piece = "";
      continue;
    }
    piece += character;
  }
  parts.push(piece);
  return parts;
}

export function refereeTypes(source: string, language: Language): RefereeType[] {
  const header = HEADER.get(language);
  const member = MEMBER.get(language);
  if (!header || !member) return [];

  /*
   * Block comments blanked before anything else. This file's own header names
   * members in prose, and so does every well-commented declaration in the
   * corpus; reading them produced disagreements invented entirely out of
   * documentation, which is the trap `measure-constructs.mts` records.
   */
  const lines = blanked(source, language).split("\n");

  const found: RefereeType[] = [];
  const byName = new Map<string, RefereeType>();
  let current: RefereeType | undefined;
  let depth = 0;
  let parens = 0;
  /** The indent a member of the current class sits at. Python has no braces. */
  let bodyIndent = -1;
  /** The indent the class header itself sits at. A nested class is not at 0. */
  let headerIndent = 0;

  for (const [index, line] of lines.entries()) {
    const code = strip(line, language);

    const start = header.exec(line);
    if (start) {
      // An inherited member list is not closed, and the reader says so. The
      // referee drops the declaration rather than offering members it knows the
      // reader will refuse: a refusal counted as a miss is a lie about recall.
      if (headerHasParent(line, language)) { current = undefined; continue; }
      current = { name: start[1]!, members: [], line: index + 1 };
      found.push(current);
      byName.set(current.name, current);
      parens = 0;
      bodyIndent = -1;
      headerIndent = line.length - line.trimStart().length;
      depth = language === "python"
        ? 0
        : (code.match(/{/g) ?? []).length - (code.match(/}/g) ?? []).length;
      /*
       * A declaration written on one line -- `interface Row { rel: string; }` --
       * left `depth` at 1 with nothing after it to close it, so every line of
       * the rest of the file read as one of its members: `Row has no for`,
       * `Fn has no for`. Its own members are on that line, so they are taken
       * off it here and the declaration closes where it was written.
       */
      if (depth <= 0 && language !== "python") {
        for (const one of ownParts(code.slice(code.indexOf("{") + 1))) {
          const hit = member.exec(` ${one.trim()}`);
          if (hit) current.members.push(hit[1]!);
        }
        current = undefined;
      }
      continue;
    }

    /*
     * Rust keeps the methods somewhere else, so an `impl` block is folded back
     * onto the struct it belongs to. Without this every Rust method read as a
     * member the reader had invented -- the reader looks in the impl blocks and
     * the referee, reading top to bottom, had already closed the struct.
     */
    if (language === "rust") {
      const impl = RUST_IMPL.exec(line);
      if (impl) {
        // A trait impl brings the trait's names, not the type's own. Skipped:
        // the reader counts them and a disagreement about them is not about
        // whether either side can read a declaration.
        current = impl[1] ? undefined : byName.get(impl[2]!);
        depth = (line.match(/{/g) ?? []).length;
        continue;
      }
    }

    if (!current) continue;

    if (language === "python") {
      for (const hit of code.matchAll(SELF_SET)) current.members.push(hit[1]!);
      /*
       * A blank line does not end a class. A line back at or left of the
       * header's own indent does -- **not** a line at column 0, which was the
       * first rule and the last eleven accusations in the corpus. `class
       * FakeDB:` declared inside a test method sits at indent 8, so `with
       * patch(` at indent 8 never closed it and every keyword argument
       * underneath read as one of its members.
       */
      if (line.trim() === "") continue;
      const here = line.length - line.trimStart().length;
      if (here <= headerIndent) { current = undefined; continue; }
      /*
       * Only the class's own indent level, which is the brace check one
       * language over.
       *
       * Without it the referee read every local variable in every method as a
       * member of the enclosing class -- `hv = ..` inside `MinHash.update`,
       * `base_url = ..` inside `BaseSDK._get_url`, and `return` and `assert`
       * lines besides. It then blamed the reader for not finding them, which
       * was 180-odd of the first run's 321 accusations and every one of them
       * the referee's.
       */
      if (bodyIndent === -1) bodyIndent = here;
      if (here !== bodyIndent) continue;
    } else {
      const outer = depth;
      depth += (code.match(/{/g) ?? []).length - (code.match(/}/g) ?? []).length;
      if (depth <= 0) { current = undefined; continue; }
      // Only the declaration's own level. An inline object type's members look
      // exactly like members one line at a time and belong to that type.
      if (outer !== 1) continue;
    }

    const opened = parens;
    parens += (code.match(/[([]/g) ?? []).length - (code.match(/[)\]]/g) ?? []).length;
    if (parens < 0) parens = 0;
    // A continuation line of a multi-line parameter list is not a member.
    if (opened > 0) continue;

    const hit = member.exec(code);
    if (hit) current.members.push(hit[1]!);
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * The referee, part two: what a routine reads.
 * ------------------------------------------------------------------ */

/*
 * The `const` half wants an arrow, not just a parenthesis. `const raced =
 * (await findServing(root)) ?? ..` opens a paren and declares no routine, so
 * every `.name` for the rest of the enclosing function was credited to a
 * variable -- and `measure-constructs.mts` carries this regex unchanged.
 */
const TS_OPENS =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)|^\s*(?:export\s+)?const\s+(\w+)\s*(?::[^=]*)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]*)?=>/;

const OPENS = new Map<Language, RegExp>([
  ["rust", /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/],
  ["ts", TS_OPENS],
  ["tsx", TS_OPENS],
  ["js", TS_OPENS],
  ["python", /^\s*(?:async\s+)?def\s+(\w+)/],
]);

/**
 * A member read off a value. The one spelling all four languages share.
 *
 * The lookbehind is spread syntax, which is three dots and no member: `{
 * ...raced, started: false }` read as `raced` reading a member called `raced`,
 * and JavaScript object literals are full of it.
 *
 * `.await` is excluded because it is not one either: Rust puts its await after
 * the value, and a postfix keyword written with a dot reads exactly like a
 * field. Nothing declares a member called `await` for the reader to find.
 */
const READ = /(?<!\.)\.(?!await\b)([A-Za-z_$][\w$]*)/g;

/**
 * A line that says where a name comes from rather than reading one off a value.
 *
 * `from graphify.paths import out_path` is not a routine reading a member
 * called `paths` off something called `graphify`. This was the single largest
 * cluster in the 450: `cli.py` alone contributed 30, every one of them a module
 * path in an import written inside a function body.
 *
 * Only Python needs it. TypeScript and JavaScript write the module as a string,
 * which is blanked already, and Rust separates a path with colons.
 */
const IMPORT = new Map<Language, RegExp>([
  ["python", /^\s*(?:from\s+[.\w]+\s+import\b|import\s+[.\w]+)/],
]);

/**
 * A dotted name standing where a type goes, which names a type and reads no
 * member.
 *
 * `ts.Program`, `React.ComponentProps<"div">`, `TabsPrimitive.Root.Props`,
 * `NodeJS.ErrnoException`. 86 of the 450 were this, and none of them is a
 * member read: nothing is being read off anything at runtime.
 *
 * Two conditions, and both are needed. The name has to follow something that
 * introduces a type -- an annotation colon, `as`, `satisfies`, `extends`,
 * `implements`, an opening angle bracket, or Python's arrow -- **and** the part
 * after the last dot has to be capitalised. The colon alone is not enough,
 * because an object literal writes one too: `{ routine: routine.name }` reads
 * `name` off a value and the recall would lose every such read in the corpus.
 *
 * The cost is written down rather than hidden: a genuinely capitalised member
 * in a type position -- an enum case in `{ mode: Mode.Fast }` -- stops being
 * counted. Members are lowercase in all four languages by convention, and this
 * word is for ordinary ones.
 *
 * A comma is deliberately **not** a marker, though adding one is the obvious
 * way to catch the second argument of a generic -- `Map<string,
 * ts.CompilerOptions>`. Measured: it removes 2 invented reads and 67 real
 * ones, 54 of them Python, because a comma separates ordinary arguments far
 * more often than it separates type arguments. The four that survive it are
 * named in the pull request rather than paid for at that rate.
 */
const DOTTED_TYPE =
  /(?<=[:<]|\bas\b|\bsatisfies\b|\bextends\b|\bimplements\b|->|=>)\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.[A-Z][\w$]*/g;

/** `import.meta` is a language construct, not an object with a member. */
const IMPORT_META = /\bimport\.meta\b/g;

export interface RefereeRoutine {
  name: string;
  /** Each member read, with the line it was read on rather than the routine's. */
  reads: Array<{ name: string; line: number }>;
  line: number;
}

export function refereeRoutines(source: string, language: Language): RefereeRoutine[] {
  const opens = OPENS.get(language);
  if (!opens) return [];

  const lines = blanked(source, language).split("\n");

  const found: RefereeRoutine[] = [];
  let current: RefereeRoutine | undefined;
  let depth = 0;
  let opened = 0;
  let indent = 0;
  /*
   * Parenthesis depth, so a routine whose parameter list runs over several
   * lines is not closed by its own `): void {`, which sits back at the
   * declaration's indent and looks exactly like the next declaration.
   */
  let parens = 0;
  /** Whether this routine opened a brace, which decides how it can be closed. */
  let braced = false;

  for (const [index, line] of lines.entries()) {
    const start = opens.exec(line);
    if (start) {
      current = { name: start[1] ?? start[2]!, reads: [], line: index + 1 };
      found.push(current);
      opened = depth;
      parens = 0;
      braced = false;
      indent = line.length - line.trimStart().length;
      if (language === "python") continue;
    }
    if (!current) continue;

    /*
     * A routine that never opened a brace cannot be closed by one, and until
     * now nothing closed it at all. `const cell = (count, whole) => \`..\`` is
     * a whole routine on one line: its depth never rises above where it
     * started, so the `for` loop underneath raised the depth instead and read
     * as this routine's body. `cell` in `measure-resolution.mts` collected six
     * reads that way, and `pct`, `pc` and `total` did the same in three other
     * scripts.
     *
     * Indentation ends those, and **only** those. Applying it to every routine
     * looked tidier and was wrong: generated code is not indented, and
     * `mundane/apps/graph/db/queries.rs` writes 31 handler bodies flat against
     * the margin. The indent rule closed each one on its own first line and
     * took 616 real member reads out of the corpus -- so a rule meant to stop
     * the referee inventing reads would have stopped it seeing them.
     */
    const here = line.length - line.trimStart().length;
    if (!start && !braced && line.trim() !== "" && here <= indent && parens === 0) {
      current = undefined;
      continue;
    }

    /*
     * The same scanner the declaration half uses. It had its own stripper, and
     * that one cut at the first `#` or `//` in *any* language and did it before
     * the strings came out -- so a `#` inside a TypeScript string took the rest
     * of the line, braces included, and the routine never closed.
     */
    const code = strip(line, language);

    const importing = IMPORT.get(language);
    if (importing?.test(line)) continue;

    const readable = code.replace(DOTTED_TYPE, " ").replace(IMPORT_META, " ");
    for (const hit of readable.matchAll(READ)) {
      current.reads.push({ name: hit[1]!, line: index + 1 });
    }

    parens += (code.match(/[([]/g) ?? []).length - (code.match(/[)\]]/g) ?? []).length;
    if (parens < 0) parens = 0;

    if (language !== "python") {
      depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
      if (depth > opened) braced = true;
      if (depth <= opened && !start) current = undefined;
    }
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * The run.
 * ------------------------------------------------------------------ */

/**
 * Names nothing draws a box for, so a disagreement about them is noise.
 *
 * Deliberately short. The point of this word is ordinary members with ordinary
 * names, and a long exclusion list is a way of not measuring the population.
 */
export const BUILT_IN = new Set([
  "length", "prototype", "constructor", "toString", "valueOf", "name",
  "then", "catch", "finally", "map", "filter", "forEach", "push", "pop", "slice",
  "join", "split", "trim", "replace", "test", "exec", "match", "keys", "values",
  "entries", "has", "get", "set", "add", "delete", "size", "clone", "unwrap",
  "iter", "collect", "into", "to_string", "append", "extend", "items", "format",
]);

/**
 * The distinct members a routine reads, each with the line it was read on.
 *
 * The line is the read's own, not the routine's opening line. Every one of the
 * 23 reads at `resolution.py:63` pointed at a `def` that read none of them, and
 * a list that all says `:63` is a list nobody can check.
 */
export function distinctReads(routine: RefereeRoutine): Array<{ name: string; line: number }> {
  const seen = new Map<string, number>();
  for (const read of routine.reads) {
    if (!BUILT_IN.has(read.name) && !seen.has(read.name)) seen.set(read.name, read.line);
  }
  return [...seen].map(([name, line]) => ({ name, line }));
}
