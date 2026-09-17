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
    };
  }
  if (CONTAINERS.has(kind)) {
    return { body: "lacks", signature: "lacks", result: "lacks", fields: "unknown", bases: "unknown", type: "has" };
  }
  return { body: "unknown", signature: "unknown", result: "unknown", fields: "unknown", bases: "unknown", type: "unknown" };
}
