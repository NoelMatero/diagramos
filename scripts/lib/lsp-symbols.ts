/**
 * What a language server says a declaration *is*, as the parts `parts.ts` asks
 * about (#297).
 *
 * The referee for `measure-parts.mts`. It shares no machinery with the reader:
 * the reader looks at tree-sitter fields, this looks at the kind rust-analyzer
 * or pyright assigns in `textDocument/documentSymbol`, which comes out of each
 * server's own parser and name resolution.
 *
 * A kind answers some parts and not others, and "unknown" is an answer: a
 * `Variable` may hold a function, so the server's kind says nothing about
 * whether it has a signature.
 */
import type { Part } from "../../src/engine/parts";

export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }

export interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
  /** The flat shape, which a server may answer with instead. */
  location?: { range: LspRange };
}

export type RefereeReading = "has" | "lacks" | "unknown";

/** LSP `SymbolKind` numbers, the ones read here. */
const KIND = {
  Module: 2, Namespace: 3, Class: 5, Method: 6, Constructor: 9, Enum: 10,
  Interface: 11, Function: 12, EnumMember: 22, Struct: 23,
} as const;

const ROUTINES = new Set<number>([KIND.Method, KIND.Constructor, KIND.Function]);
const CONTAINERS = new Set<number>([
  KIND.Module, KIND.Namespace, KIND.Class, KIND.Enum, KIND.Interface, KIND.EnumMember, KIND.Struct,
]);

/** Every symbol, nested ones included, with the line its name is on. */
export function flatten(symbols: LspDocumentSymbol[]): Array<{ name: string; kind: number; line: number; range: LspRange }> {
  const out: Array<{ name: string; kind: number; line: number; range: LspRange }> = [];
  const visit = (symbol: LspDocumentSymbol) => {
    const range = symbol.range ?? symbol.location?.range;
    const at = symbol.selectionRange ?? range;
    if (range && at) out.push({ name: symbol.name, kind: symbol.kind, line: at.start.line, range });
    for (const child of symbol.children ?? []) visit(child);
  };
  for (const symbol of symbols) visit(symbol);
  return out;
}

/**
 * What one symbol's kind says about each part.
 *
 * `bodyText` is the text the server's own range covers. A routine with no body
 * -- a trait method, a declaration -- ends at `;` rather than `}`, which is the
 * server's parser saying where the item stops, read without tree-sitter.
 * Python has no bodiless `def`.
 */
export function refereeParts(
  kind: number,
  bodyText: string,
  python: boolean,
  rust = false,
): Record<Part, RefereeReading> {
  if (ROUTINES.has(kind)) {
    const end = bodyText.trimEnd().slice(-1);
    return {
      body: python ? "has" : end === "}" ? "has" : end === ";" ? "lacks" : "unknown",
      signature: "has",
      result: "has",
      fields: "lacks",
      bases: "lacks",
      type: "lacks",
      callable: "has",
    };
  }
  if (CONTAINERS.has(kind)) {
    return {
      body: "lacks", signature: "lacks", result: "lacks", fields: "unknown", bases: "unknown",
      type: "has", callable: "unknown",
    };
  }
  /*
   * A name the server files as a value -- a constant, a variable, a field.
   *
   * **It is not a type**, and that is the server's own answer rather than a
   * reading of anything: `Variable`, `Constant`, `Field` and `Property` are
   * what its name resolution came back with, and a type would have come back
   * as one of the kinds above (#337). The one shape this cannot see is a name
   * bound to a class -- `Model = import_model()` -- which pyright files as a
   * variable and which is a type; the reader refuses those on its own side,
   * because a value it cannot read the shape of is never judged.
   *
   * **Whether anything can call it** is answered from the declaration's own
   * text, which is the same footing `literalValue` has stood on since #307: a
   * value written out in full cannot be called, and neither can one whose
   * written type is spelled out plainly enough that no name resolution could
   * change the answer.
   */
  const literal = literalValue(bodyText, rust);
  /*
   * Only where the server actually said "value". What is left down here
   * otherwise is a kind that answers none of this -- a type parameter, a file,
   * an operator -- and a type parameter is a type, so the line above would be
   * a wrong answer rather than a missing one.
   */
  if (!VALUES.has(kind)) {
    return {
      body: literal, signature: literal, result: "unknown", fields: "unknown", bases: "unknown",
      type: literal, callable: literal,
    };
  }
  const callable = literal === "lacks" ? "lacks" : writtenTypeCallable(bodyText, python, rust);
  return {
    body: callable, signature: callable, result: "unknown", fields: "unknown", bases: "unknown",
    type: "lacks", callable,
  };
}

/**
 * What a value's written type says about calling it, read off the text the
 * server's own range covers.
 *
 * The referee's half of #337, and a text reading on purpose: it starts from
 * the server's range and the server's kind, where the reader starts from a
 * tree-sitter `type` field, so the two agree by accident or not at all.
 *
 * Rust is read in full -- a value is callable there only where its type says
 * `fn`, `Fn`, `dyn` or `impl`, or is a bare parameter whose bound is written
 * elsewhere. Python and TypeScript are read only where the type is spelled out
 * of words that no `type` statement can rebind, because in those two a name
 * can be a function type and this has no more idea than the reader does.
 *
 * `unknown` for everything else, including a declaration with no type written
 * on it at all.
 */
export function writtenTypeCallable(declaration: string, python: boolean, rust: boolean): RefereeReading {
  const at = annotatedAt(declaration, rust);
  if (at === -1) return "unknown";
  const assigned = assignedAt(declaration, rust);
  const written = declaration.slice(at + 1, assigned === -1 ? undefined : assigned).trim()
    .replace(/[,;]\s*$/, "");
  if (written === "") return "unknown";
  if (rust) {
    if (/^[A-Z]\w?$/.test(written)) return "unknown";
    return /\b(fn|Fn|FnMut|FnOnce|dyn|impl)\b/.test(written) ? "unknown" : "lacks";
  }
  // `() => void` and `{ (): void }` are functions written out of punctuation,
  // and a reading that counts only words would call them plain values.
  if (/=>|\(/.test(written)) return "unknown";
  const plain = python
    ? /^(int|str|bool|float|complex|bytes|bytearray|list|dict|set|frozenset|tuple|None)$/
    : /^(string|number|boolean|void|null|undefined|symbol|bigint|never|object|true|false|readonly|unique)$/;
  const words = written.replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, "").match(/[A-Za-z_]\w*/g) ?? [];
  return words.every((word) => plain.test(word)) ? "lacks" : "unknown";
}

/**
 * Where a declaration writes its type, which is a `:` **outside every
 * bracket** and before any `=`.
 *
 * The same scan `assignedAt` does for the other half of a declaration, and it
 * has to be the same scan: `on_done: Callable[[int], None]` has two colons
 * inside brackets, and a Rust path writes `::` with no type after it at all.
 */
function annotatedAt(declaration: string, rust: boolean): number {
  let depth = 0;
  let quote = "";
  for (let index = 0; index < declaration.length; index += 1) {
    const character = declaration[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (rust && character === "'" && /^'\w+\b(?!')/.test(declaration.slice(index))) continue;
    if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
    if ("([{<".includes(character)) { depth += 1; continue; }
    if (")]}>".includes(character)) { depth -= 1; continue; }
    if (depth !== 0) continue;
    if (character === "=") return -1;
    if (character === ":") {
      // `std::io::Error` and TypeScript's `a ? b : c` are not annotations.
      if (declaration[index + 1] === ":") { index += 1; continue; }
      if (declaration[index - 1] === ":") continue;
      return index;
    }
  }
  return -1;
}

/** The value kinds a server files under Variable, Constant, Field or Property. */
const VALUES = new Set<number>([7, 8, 13, 14, 22]);

/**
 * Whether a declaration's own text writes its value out in full.
 *
 * The referee's half of #307, and deliberately a text reading: it shares
 * nothing with the tree the reader walks. Everything after the first `=` has to
 * be a number, a quoted string, a bracketed list of those, or one of the four
 * words a language writes for nothing -- and no letters otherwise, so a name, a
 * call and a lambda all fall out.
 *
 * `unknown` for anything else, including a declaration with no `=` at all: a
 * field annotated and never assigned says nothing about what it will hold.
 */
/**
 * Where a declaration assigns, which is an `=` **outside every bracket**.
 *
 * `def save(self, name, save=True)` has an `=` in it and assigns nothing: that
 * one is a parameter's default, inside the parentheses, and reading it as an
 * assignment called a Django method a plain value. A `==` is not an assignment
 * either.
 */
function assignedAt(declaration: string, rust: boolean): number {
  let depth = 0;
  let quote = "";
  for (let index = 0; index < declaration.length; index += 1) {
    const character = declaration[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    // A Rust lifetime opens with `'` and closes with nothing: `&'static str`.
    // Only in Rust: Python writes `# '2006-10-25'` in a comment, and reading
    // that as a lifetime loses track of where the string ends.
    if (rust && character === "'" && /^'\w+\b(?!')/.test(declaration.slice(index))) continue;
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth -= 1;
    else if (character === "=" && depth === 0) {
      const next = declaration[index + 1];
      const previous = declaration[index - 1];
      if (next === "=" || previous === "=" || previous === "!" || previous === "<" || previous === ">") {
        index += 1;
        continue;
      }
      return index;
    }
  }
  return -1;
}

export function literalValue(declaration: string, rust = false): RefereeReading {
  const at = assignedAt(declaration, rust);
  if (at === -1) return "unknown";
  const value = declaration.slice(at + 1).trim();
  if (value === "") return "unknown";
  const emptied = value
    // Strings first, with their escapes and their prefixes -- `b"HTTP/2"`,
    // `r'\\d+'` -- so that a `#` or a `//` inside one is not read as a comment.
    // `[\s\S]` rather than `.`, or a Rust string continued with a trailing
    // backslash ends the match at the newline and the rest reads as code.
    .replace(/(?:\b(?:br|rb|b|r|u))?("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`)/g, '""')
    // Then what the line says about itself: `2621440  # i.e. 2.5 MB`.
    .replace(/#.*$|\/\/.*$/gm, "")
    .replace(/\b(true|false|True|False|None|null|undefined|nil)\b/g, "")
    // Numbers in every base a language writes, with underscores and Rust's
    // suffixes: `65_536`, `0o644`, `0xff`, `4u32`, `1.5e3`.
    .replace(/\b0[xob][\da-fA-F_]+(u|i|f)?(8|16|32|64|size)?\b/g, "")
    .replace(/\b\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?(u|i|f)?(8|16|32|64|size)?\b/g, "")
    .replace(/[;,\s]+$/, "");
  // Letters left over mean a name, a call or a lambda -- none of them a value
  // written out in full.
  if (/[A-Za-z]/.test(emptied)) return "unknown";
  // Brackets are a list, a tuple or a map written out; arithmetic on numbers is
  // still a number. Anything else -- a `?`, a `:` outside a map, a macro's `!`
  // -- is a shape this has not been taught to read, and says so.
  // `=` is here for a Rust range, `1..=65535`, which is a number written out.
  if (/[^\s,.:=\[\]{}()\-+*/%<>|&^~"']/.test(emptied)) return "unknown";
  return "lacks";
}
