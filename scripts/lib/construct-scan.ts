/**
 * The `@builds` referee: routines and the constructions written in them, read
 * off the screen with no syntax tree.
 *
 * Lifted out of `measure-constructs.mts` unchanged when #302's recall
 * measurement needed the same one: a referee copied is a referee that drifts.
 */
import { type Language } from "../../src/engine/parse";

/**
 * The referee: routines and what they construct, read out of the source *text*.
 *
 * Crude on purpose, and it claims only what a person would read off the screen
 * without hesitating: a line that opens a named routine, then the `new X`, `X {`
 * and `<X` tokens that follow it before the next one opens.
 *
 * It does not understand scope, so a construction inside a nested closure is
 * credited to the enclosing routine -- which is the same answer the reader gives
 * and the same answer a person would. It does not understand Rust's `X::new`, or
 * Python at all, because neither does the reader.
 *
 * It will miss things the reader finds, and that direction is fine. The
 * direction that matters is the reverse: a construction the referee reads
 * straight off the screen and the reader cannot see.
 */
const TS_OPENS =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)|^\s*(?:export\s+)?const\s+(\w+)\s*(?::[^=]*)?=\s*(?:async\s*)?\(/;

const OPENS = new Map<Language, RegExp>([
  ["rust", /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/],
  // `export default function` is one of the two ways React writes a component,
  // and leaving it out meant the routine before it never closed -- so a
  // component's JSX was credited to the helper above it.
  ["ts", TS_OPENS],
  ["tsx", TS_OPENS],
  ["js", TS_OPENS],
]);

/** `new X`, which is the one spelling every C-family language shares. */
const NEW_MADE = /\bnew\s+([A-Z]\w*(?:\.\w+)*)\s*[(<]/g;

/**
 * A JSX element -- **only** in a language that has JSX.
 *
 * Applied everywhere at first, and the cost was immediate: `Promise<BoardHistory>`
 * matches it, so every generic type argument in every `.ts` file was read as a
 * component being constructed. 613 questions in TypeScript, 78 of which the
 * reader agreed with, and the other 535 were the referee inventing constructions
 * out of type annotations.
 *
 * The leading character matters for the same reason inside a `.tsx` file, where
 * both forms are legal: `useRef<HTMLInputElement>` is a generic call and
 * `<MenuContent />` is an element, and what separates them is whether a name
 * comes immediately before the `<`.
 */
const JSX_MADE = /(^|[^\w$])<([A-Z]\w*)[\s/>]/g;
/**
 * Rust's struct literal.
 *
 * The brace is what separates `RouteInfo { .. }` from a bare mention, and the
 * lookbehinds separate it from the three things that also put a capitalised name
 * in front of a brace and construct nothing: `impl Foo {`, `struct Foo {`, and
 * -- the one that cost the most -- `fn make() -> Response {`, where the brace
 * belongs to the function body and the name is the return type. Without that
 * last one, every constructor-shaped function in orangutan read as constructing
 * its own return type and the reader was blamed for not seeing it.
 */
const RUST_MADE = /(?<!\b(?:impl|struct|enum|union|trait|mod|for)\s)(?<!->\s)(?<!->)\b([A-Z]\w*)\s*\{/g;

const tailOf = (name: string) => name.split(".").pop()!;

export interface RefereeRoutine {
  name: string;
  makes: string[];
  line: number;
}

export function refereeRoutines(source: string, language: Language): RefereeRoutine[] {
  const opens = OPENS.get(language);
  if (!opens) return [];

  /*
   * Block comments removed before anything else. This file's own header
   * contains `new Foo(new Bar())` as an example, and the referee read it as
   * `madeBy` constructing a Foo -- a disagreement invented entirely out of
   * documentation.
   */
  const lines = source.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, " ")).split("\n");
  const found: RefereeRoutine[] = [];
  let current: RefereeRoutine | undefined;
  /*
   * Where the routine ends, by brace depth.
   *
   * Without this the referee had no notion of an ending at all: it credited
   * everything up to the next routine it recognised, so in a React file the
   * component's JSX was attributed to whichever inner arrow function happened to
   * be declared above it -- `changeMaxNumber makes TabsList`, and 40-odd more of
   * the same shape. The reader scopes correctly and was being blamed for it.
   */
  let depth = 0;
  let opened = 0;

  for (const [index, line] of lines.entries()) {
    const start = opens.exec(line);
    if (start) {
      current = { name: start[1] ?? start[2]!, makes: [], line: index + 1 };
      found.push(current);
      opened = depth;
    }
    if (!current) continue;
    // A trailing comment is prose. Neither it nor a type annotation constructs.
    let code = line.replace(/(\/\/|#).*$/, "");
    if (language === "rust") {
      /*
       * Two things in Rust text look exactly like a struct literal and make
       * nothing, and both cost a disagreement here.
       *
       * A return type: `fn get_client(..) -> &mut Client {` puts a capitalised
       * name immediately before the body's brace. The `->` lookbehind alone did
       * not catch it, because `&mut ` sits in between.
       *
       * A match pattern: `ScorerError::Timeout { ms } => ..` destructures a
       * variant rather than building one. Everything left of `=>` on a match arm
       * is a pattern, so only the right-hand side is read.
       */
      code = code.replace(/->[^{]*(?=\{)/, " ");
      const arm = code.indexOf("=>");
      if (arm !== -1) code = code.slice(arm + 2);
    }
    for (const hit of code.matchAll(NEW_MADE)) current.makes.push(tailOf(hit[1]!));
    if (language === "tsx") {
      for (const hit of code.matchAll(JSX_MADE)) current.makes.push(hit[2]!);
    }
    if (language === "rust") {
      for (const hit of code.matchAll(RUST_MADE)) current.makes.push(hit[1]!);
    }
    depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
    if (depth <= opened && !start) current = undefined;
  }
  return found;
}

/** Names nothing draws a box for, so a disagreement about them is noise. */
export const BUILT_IN = new Set([
  "Error", "String", "Map", "Set", "Date", "RegExp", "Promise", "Array", "Object",
  "Vec", "HashMap", "HashSet", "BTreeMap", "Box", "Some", "None", "Ok", "Err",
  "Self", "Number", "Boolean", "Symbol", "WeakMap", "TextEncoder", "TextDecoder",
  "URL", "URLSearchParams", "AbortController", "Intl", "JSON", "Math",
]);
