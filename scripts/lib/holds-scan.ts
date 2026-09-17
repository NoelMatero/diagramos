/**
 * The `@holds` referee: type declarations and the type names written in their
 * field lists, read off the screen with no syntax tree.
 *
 * Lifted out of `measure-holds.mts` unchanged when #302's recall measurement
 * needed the same one, for the reason `call-scan.ts` gives: a referee copied is
 * a referee that drifts, and the `holds` licence rows were measured with it.
 */
import { type Language } from "../../src/engine/parse";

/**
 * The referee: type declarations and their field types, read out of the source
 * *text* by a scanner that never touches a syntax tree.
 *
 * Crude on purpose. It only claims the cases a person would read off the screen
 * without hesitating -- a declaration header, then lines that plainly say `name:
 * Type` -- and it deliberately does not try to understand generics, unions or
 * nesting beyond taking every capitalised word it finds. Being crude is what
 * makes it independent; being independent is the entire point.
 *
 * It will miss things the reader finds, and that direction is fine and not
 * counted against anybody. The direction that matters is the reverse: a name the
 * referee can see plainly and the reader cannot.
 */
export interface RefereeType {
  name: string;
  /** Type names written in its field list, as a person would read them off. */
  held: string[];
  line: number;
}

const HEADER = new Map<Language, RegExp>([
  ["rust", /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum)\s+([A-Z]\w*)/],
  ["ts", /^\s*(?:export\s+)?(?:abstract\s+)?(?:interface|class)\s+([A-Z]\w*)/],
  ["tsx", /^\s*(?:export\s+)?(?:abstract\s+)?(?:interface|class)\s+([A-Z]\w*)/],
  ["js", /^\s*(?:export\s+)?class\s+([A-Z]\w*)/],
  ["python", /^\s*class\s+([A-Z]\w*)/],
]);

/** A line a person would read as "this field is of that type". */
const FIELD = new Map<Language, RegExp>([
  ["rust", /^\s*(?:pub(?:\([^)]*\))?\s+)?[a-z_]\w*\s*:\s*(.+?),?\s*$/],
  ["ts", /^\s*(?:readonly\s+|public\s+|private\s+|protected\s+|#)*[\w$]+\??\s*:\s*(.+?);\s*$/],
  ["tsx", /^\s*(?:readonly\s+|public\s+|private\s+|protected\s+|#)*[\w$]+\??\s*:\s*(.+?);\s*$/],
  ["js", /^$/],
  ["python", /^\s+[a-z_]\w*\s*:\s*([A-Z].*?)\s*$/],
]);

/**
 * Where a comment starts, which is not the same character in every language.
 *
 * Whitespace before the marker is required, so a Rust attribute line and a
 * Python comment are cut where they start rather than a TypeScript `#field`
 * being cut at column zero.
 */
const COMMENT: Record<Language, RegExp> = {
  rust: /\s+(#|\/\/).*$/,
  python: /\s+#.*$/,
  ts: /\s+\/\/.*$/,
  tsx: /\s+\/\/.*$/,
  js: /\s+\/\/.*$/,
};

/**
 * Type names as a person would read them off a field line.
 *
 * A qualified name is taken whole and then reduced to its last part, because
 * that is what a box is labelled: `React.ReactNode` is a ReactNode, and reading
 * `React` out of it as a second type name produced 60 disagreements that were
 * the referee inventing a type, not the reader missing one.
 */
const NAMES = /\b([A-Z]\w*(?:\.\w+)*)\b/g;
const tailOf = (name: string) => name.split(".").pop()!;

export function refereeTypes(source: string, language: Language): RefereeType[] {
  const header = HEADER.get(language);
  const field = FIELD.get(language);
  if (!header || !field) return [];

  const lines = source.split("\n");
  const found: RefereeType[] = [];
  let current: RefereeType | undefined;
  let depth = 0;
  /*
   * Parenthesis depth, so a method's parameter list is never read as a field
   * list. A multi-line `def send(self, request: httpx.Request, ...)` has
   * continuation lines indistinguishable from fields one line at a time, and
   * before this the referee claimed every parameter of every Protocol class in
   * the corpus -- 100-odd disagreements, all of them the referee's.
   */
  let parens = 0;

  for (const [index, line] of lines.entries()) {
    const start = header.exec(line);
    if (start) {
      current = { name: start[1]!, held: [], line: index + 1 };
      found.push(current);
      parens = 0;
      depth = language === "python" ? 0 : (line.match(/{/g) ?? []).length;
      continue;
    }
    if (!current) continue;

    const opened = parens;
    parens += (line.match(/[([]/g) ?? []).length - (line.match(/[)\]]/g) ?? []).length;
    if (parens < 0) parens = 0;
    if (opened > 0) continue;

    if (language === "python") {
      // A blank line does not end a class; an unindented one does.
      if (line.trim() !== "" && !/^\s/.test(line)) { current = undefined; continue; }
    } else {
      const outer = depth;
      depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
      if (depth <= 0) { current = undefined; continue; }
      /*
       * Only the declaration's own level. An interface method taking an inline
       * object -- `send(builder: { from: string | EmailAddress; ... })` -- has
       * members that look exactly like fields one line at a time, and they
       * belong to that anonymous type rather than to the interface. The reader
       * declines to descend into them; before this the referee claimed all of
       * them and reported the reader as having missed 25 types.
       */
      if (outer !== 1) continue;
    }

    /*
     * A trailing comment is prose, not a type. `model_id: Optional[str] = None
     * # HuggingFace ID e.g. "meta-llama/Llama-3.1-8B-Instruct"` has four
     * capitalised words in it and none of them is a field type; every one of the
     * last 11 disagreements was this.
     *
     * The marker is per language, and it was not. `#` is a comment in Python
     * and an attribute in Rust; in TypeScript it is the **private field
     * sigil**, so `#registry: Registry;` was cut down to the empty string and
     * the field stopped existing. Not a false accusation -- an invisible
     * question. Every private field in the corpus was one `holds` was licensed
     * without ever being asked about, and a licence measured over a population
     * with a spelling missing from it is not evidence about that spelling.
     * `measure-accesses.mts` fixed the same line for the same reason (#223).
     */
    const code = line.replace(COMMENT[language], "");
    const member = field.exec(code);
    if (!member) continue;
    // A method, not a field: the referee declines the same case the reader does.
    if (/\)\s*(?::|=>|\{)/.test(code) || /\(/.test(member[1] ?? "")) continue;
    for (const name of (member[1] ?? "").matchAll(NAMES)) current.held.push(tailOf(name[1]!));
  }
  return found;
}

/** Names nothing draws a box for, so a disagreement about them is noise. */
export const BUILT_IN = new Set([
  "String", "Vec", "Option", "Result", "Box", "Arc", "Rc", "HashMap", "HashSet", "BTreeMap",
  "Self", "Array", "Promise", "Map", "Set", "Record", "Partial", "Readonly", "Date", "RegExp",
  "Optional", "List", "Dict", "Any", "Path", "Callable", "Sequence", "Iterable", "Union", "Tuple",
  // Not a type anybody draws a box for, and Python writes it in half its unions.
  "None", "True", "False",
]);
