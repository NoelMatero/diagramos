/**
 * A referee for `@handles`: the case labels in a file, read with no grammar.
 *
 * `AGENTS.md`'s gate is that nothing new may say *wrong* until a script has
 * measured how often its reader is mistaken **against a referee that shares no
 * machinery with it**. `handles.ts` walks a tree-sitter tree and reads fields.
 * This reads lines of text with four regexes and knows nothing about node
 * types, so agreeing means two unrelated readings agree rather than one reading
 * agreeing with itself.
 *
 * ## What it deliberately does not do
 *
 * It does not bound a dispatch. Finding where a `match` block starts and ends
 * is the expensive half and it is exactly the half the reader is good at, so a
 * referee that did it would be a second implementation of the same idea and
 * would fail in the same places. Instead it collects every case label in the
 * **file** and the comparison is per file, set against set. A reader that loses
 * a whole dispatch, misreads a label, or invents one shows up; a reader that
 * attributes a label to the wrong routine in the same file does not, and that
 * limit is stated in the report rather than hidden.
 *
 * ## Strings are not blanked, which is unusual here
 *
 * Every other scan in this directory blanks strings before reading, because a
 * name inside a string is not a use. Here a string *is* the thing being read --
 * `case "GET":` -- so they stay. Comments are still stripped, and that is the
 * one approximation: a line comment reading `// case "GET": is handled above`
 * would be counted. Those show up as referee-side disagreements, which is the
 * right way round for a referee to be wrong.
 */

export type ScanLanguage = "ts" | "tsx" | "js" | "rust" | "python";

/**
 * The four patterns, and every one of them is anchored at a line start so a
 * label has to be written the way a person writes one.
 *
 * `case X:` covers TypeScript's and JavaScript's `switch` and Python's `match`,
 * which spell the arm identically. Rust's `X =>` is the one that needs care:
 * `=>` also opens a `macro_rules!` arm, so those are reported rather than
 * filtered.
 *
 * **It is deliberately still line-based**, which means it cannot see an arm
 * `rustfmt` has broken across lines -- and that is a tried-and-rejected change
 * rather than an oversight. Joining a run of lines up to the one holding `=>`
 * was built and measured: it took the disagreement from 3.76%/2.85% to
 * 5.39%/5.02%, because deciding which lines are a continuation is itself a
 * judgement and it joined unrelated ones. A referee tuned until it flatters
 * the reader has stopped being a referee, so the multi-line arms stay a stated
 * limitation of the *referee* and are read one by one instead.
 *
 * **There is deliberately no pattern for an if/elif chain**, and the first
 * version of this file had two. They read an equality against a literal, which
 * is what a chain link looks like -- and also what every ordinary
 * `if (x === undefined)` looks like. The measurement came back with 1,409
 * disagreeing files, almost every one the referee counting a condition the
 * reader had correctly refused. Telling a chain from an `if` needs the links
 * collected and their subjects compared, which is the reader's own judgement
 * written a second time, and a second copy of the reader is not a referee.
 *
 * So the chain half of `@handles` has no referee, and `checkHandles` refuses
 * to accuse on it. That is the gate working rather than a gap: what cannot be
 * measured does not get to say *wrong*.
 */
const CASE_OPENS = /^[ \t]*case[ \t]+(.*)$/;
const RUST_ARM = /^[ \t]*(.+?)[ \t]*=>/;

/**
 * A `case` label ends at its first colon that is not inside a string.
 *
 * A regex cannot do this and the first version tried: it required the line to
 * *end* after the colon, which is true of hand-written TypeScript and false of
 * `case 2: return x;` and of every minified file. django's vendored
 * `xregexp.min.js` alone hid twelve cases that way, and they came out of the
 * measurement as the reader inventing twelve.
 */
function labelBeforeColon(rest: string): string | undefined {
  let quote: string | undefined;
  for (let at = 0; at < rest.length; at += 1) {
    const character = rest[at];
    if (quote) {
      if (character === "\\") at += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === ":") return rest.slice(0, at);
  }
  return undefined;
}

/** A label reduced to the name the reader would report, or nothing. */
function nameOf(raw: string): string | undefined {
  let text = raw.trim().replace(/[,;{]+$/, "").trim();
  if (!text || text === "_") return undefined;

  // A trailing Rust guard is not part of the name, and neither is a block.
  text = text.replace(/\s+if\s+.*$/, "").trim();

  /*
   * Quoting before anything else, because a quoted label can *be* a bracket.
   * `case '(':` in vite's `importMetaGlob.ts` went through the payload rule
   * below and came back as the single character `'`, which then failed every
   * name test -- so the referee reported nothing and the reader looked like it
   * had invented a case. Inside quotes there is no payload, only text.
   */
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(text);
  if (quoted) {
    if (quoted[2].includes(quoted[1]) || quoted[2].includes("${")) return undefined;
    return quoted[2];
  }

  /*
   * A variant's payload is not part of its name: `Ok(v)`, `Err(e)`,
   * `Event::Click { x, .. }` all name the variant before the delimiter. Rust
   * writes patterns this way constantly -- `Ok`, `Err` and `Some` alone
   * accounted for most of a 52% disagreement on the first run, every one of
   * them the referee refusing a variant the reader read correctly.
   */
  const payload = /^([^\s({]+)\s*[({]/.exec(text);
  if (payload) text = payload[1];

  // An alternation is several names; the caller flattens, so only the first is
  // returned here and `labelsIn` handles the split before calling.
  if (text.includes("|")) return undefined;
  // A byte literal is Rust's `b'x'`, which is a character class rather than a
  // case anybody draws; the reader refuses it too.
  if (/^b['"]/.test(text)) return undefined;
  if (/^[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)+$/.test(text)) {
    return text.split(/\.|::/).pop();
  }
  if (/^[A-Za-z_$][\w$]*$/.test(text) || /^-?\d[\w.]*$/.test(text)) return text;
  return undefined;
}

/**
 * Comments out, strings kept -- and it has to track quotes to do either.
 *
 * The first version worked line by line: strip after `//`, and set a flag on a
 * `/*` with no `*\/` after it. That flag is the bug. A `/*` inside a *string*
 * -- which is ordinary in a file that handles CSS, or globs, or a regex --
 * turned the flag on and **blanked the rest of the file**, so the scan read 0
 * of 2 case labels in vite's `importMetaGlob.ts`, 2 of 6 in `create-vite`, and
 * 10 of 12 in `css.ts`. Every one of those came out of the measurement as the
 * reader inventing a case.
 *
 * So this is a one-pass character scanner over the whole file with three
 * states: in a string, in a line comment, in a block comment. A backslash
 * escapes the next character. It is still a text scan -- it asks nothing about
 * what any of it means -- it just gets the lexical states right, which is the
 * minimum a referee has to do before its disagreements are worth reading.
 */
function withoutComments(source: string, language: ScanLanguage): string {
  const lineComment = language === "python" ? "#" : "//";
  const blocks = language !== "python";
  let out = "";
  let quote: string | undefined;
  let at = 0;
  while (at < source.length) {
    const here = source[at];
    if (quote) {
      if (here === "\\") {
        out += "  ";
        at += 2;
        continue;
      }
      if (here === quote) quote = undefined;
      out += here;
      at += 1;
      continue;
    }
    if (here === '"' || here === "'" || (language !== "python" && here === "`")) {
      quote = here;
      out += here;
      at += 1;
      continue;
    }
    if (source.startsWith(lineComment, at)) {
      // Keep the newline, so line structure -- which every pattern here is
      // anchored to -- survives.
      const end = source.indexOf("\n", at);
      if (end < 0) break;
      at = end;
      continue;
    }
    if (blocks && source.startsWith("/*", at)) {
      const end = source.indexOf("*/", at + 2);
      if (end < 0) break;
      // Newlines inside the comment are kept for the same reason.
      out += source.slice(at, end + 2).replace(/[^\n]/g, " ");
      at = end + 2;
      continue;
    }
    out += here;
    at += 1;
  }
  return out;
}

/** Every case label this file writes, as the names the reader would report. */
export function labelsIn(source: string, language: ScanLanguage): string[] {
  const text = withoutComments(source, language);
  const found: string[] = [];
  const take = (raw: string) => {
    for (const part of raw.split("|")) {
      const name = nameOf(part);
      if (name !== undefined) found.push(name);
    }
  };
  for (const line of text.split("\n")) {
    /*
     * Every `case` on the line, not the first. A minified file writes
     * `case 2:case 3:case 4:` on one line, and reading one of them reported
     * the other two as the reader inventing cases -- 28 of JavaScript's 72,
     * all in django's vendored `xregexp.min.js` and `select2`.
     */
    let rest: string | undefined = line;
    let matched = false;
    while (rest !== undefined) {
      const opens: RegExpExecArray | null = CASE_OPENS.exec(rest);
      if (!opens) break;
      const label = labelBeforeColon(opens[1]);
      if (label === undefined) break;
      take(label);
      matched = true;
      const after = opens[1].indexOf(`${label}:`);
      rest = after < 0 ? undefined : opens[1].slice(after + label.length + 1);
    }
    if (matched) continue;
    if (language === "rust") {
      const arm = RUST_ARM.exec(line);
      if (arm) {
        take(arm[1]);
        continue;
      }
    }
  }
  return found;
}
