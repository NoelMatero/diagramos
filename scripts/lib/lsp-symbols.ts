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
  void VALUES;
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
   * A name the server files as a value -- a constant, a variable, a field. Its
   * kind says nothing about whether it can be called, and `literalValue` below
   * is what answers that from the declaration's own text.
   */
  const literal = literalValue(bodyText, rust);
  return {
    body: literal, signature: literal, result: "unknown", fields: "unknown", bases: "unknown",
    type: literal, callable: literal,
  };
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
