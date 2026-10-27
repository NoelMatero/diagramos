/**
 * A Rust macro's arguments, read as the code they are written as (#471).
 *
 * tree-sitter keeps everything between a macro's brackets as loose tokens,
 * because what they mean is the macro's business: `format!("{}", f(x))`,
 * `assert!(a.ok())` and `vec![b.len(); n]` hold ordinary calls, and the
 * reader saw none of them. The #467 census counted 3,849 such calls the
 * compiler places and the checker could not.
 *
 * Here the tokens are parsed again as Rust, in place: the parser reads only
 * the stretch between the brackets, behind a few characters that make it an
 * argument list (`m(..)`), an array (`[..]`) or, for `matches!`, a `match`.
 * Every node keeps the offset and line it has in the file, so a call read
 * here is placed, asked about and reported exactly like one written outside a
 * macro. The tree read is hung under the invocation (`names.ts`'s `graft`),
 * so a name inside it is looked up in the scopes around the macro.
 *
 * Tokens that do not parse that way -- a pattern, `$x`, `=>`, a DSL -- are not
 * read at all: the caller keeps the doubt it always had.
 *
 * Which macros get read is the caller's question (`calls.ts`): what a macro
 * does with its arguments depends on which macro it is.
 */

import { graft } from "./names";
import { parseIncluded, type IncludedRange, type Node, type Tree } from "./parse";

/** How the arguments are written: a list, or `matches!`'s value-then-pattern. */
export type MacroForm = "list" | "match";

type Point = { row: number; column: number };
const pointOf = (node: Node, end: boolean): Point =>
  (node as Node & { startPosition: Point; endPosition: Point })[end ? "endPosition" : "startPosition"];

const read = new WeakMap<Tree, Map<string, Node[] | null>>();

/**
 * The expressions written inside `tokens` (a macro invocation's bracketed
 * argument), read as Rust and grafted under `invocation`, or `undefined` when
 * they do not parse as `form` says they should.
 *
 * `source` is the file's text; `tokens` may itself sit inside arguments read
 * this way (`assert!(matches!(x, A))`), since offsets are the file's own.
 */
export function macroArguments(invocation: Node, tokens: Node, source: string, form: MacroForm): Node[] | undefined {
  const cache = read.get(tokens.tree) ?? read.set(tokens.tree, new Map()).get(tokens.tree)!;
  const key = `${tokens.startIndex}:${form}`;
  const known = cache.get(key);
  if (known !== undefined) return known ?? undefined;
  const tops = parseArguments(invocation, tokens, source, form);
  cache.set(key, tops ?? null);
  return tops;
}

function parseArguments(invocation: Node, tokens: Node, source: string, form: MacroForm): Node[] | undefined {
  const open = tokens.text[0];
  if (open !== "(" && open !== "[" && open !== "{") return undefined;
  const start = tokens.startIndex + 1;
  const end = tokens.endIndex - 1;
  let inside = source.slice(start, end);
  let head: string;
  let tail: string;
  if (form === "match") {
    // `matches!(value, Pattern if guard)`: the first top-level comma ends the value.
    let comma: Node | undefined;
    for (let at = 0; at < tokens.childCount; at += 1) {
      const child = tokens.child(at);
      if (child?.type === ",") { comma = child; break; }
    }
    if (!comma) return undefined;
    const cut = comma.startIndex - start;
    inside = `${inside.slice(0, cut)}{${inside.slice(cut + 1)}`;
    head = "fn m(){match ";
    tail = "=>0}}";
  } else if (open === "[") {
    head = "fn m(){[";
    tail = "];}";
  } else {
    head = "fn m(){m(";
    tail = ");}";
  }
  // The few characters that make it parse stand at the very start of the
  // document, which a macro inside a routine is always well past.
  if (start < head.length) return undefined;
  const text = head + source.slice(head.length, start) + inside + tail;
  const from = pointOf(tokens, false);
  const to = pointOf(tokens, true);
  const ranges: IncludedRange[] = [
    { startIndex: 0, endIndex: head.length, startPosition: { row: 0, column: 0 }, endPosition: { row: 0, column: head.length } },
    {
      startIndex: start,
      endIndex: end + tail.length,
      startPosition: { row: from.row, column: from.column + 1 },
      endPosition: { row: to.row, column: to.column - 1 + tail.length },
    },
  ];
  const tree = parseIncluded(text, "rust", ranges);
  if (!tree || tree.rootNode.hasError) return undefined;

  const wrapped = wrapperOf(tree.rootNode, form, open);
  if (!wrapped) return undefined;
  const tops: Node[] = [];
  for (let at = 0; at < wrapped.childCount; at += 1) {
    const child = wrapped.child(at);
    if (!child?.isNamed || /comment/.test(child.type)) continue;
    // A `match`'s own brace block is the arms; everything else is one argument.
    if (child.type === "match_block") {
      for (let arm = 0; arm < child.childCount; arm += 1) {
        const one = child.child(arm);
        if (one?.isNamed && !/comment/.test(one.type)) tops.push(one);
      }
      continue;
    }
    tops.push(child);
  }
  // A `match` arm runs on into the `=>0` written after it; nothing else may.
  if (tops.some((top) => top.startIndex < start || (top.type !== "match_arm" && top.endIndex > end))) return undefined;
  graft(tree, invocation, tops);
  return tops;
}

/** The node holding what was read: the call's argument list, the array, or the `match`. */
function wrapperOf(root: Node, form: MacroForm, open: string): Node | undefined {
  const fn = root.childCount === 1 ? root.child(0) : null;
  const block = fn?.type === "function_item" ? fn.childForFieldName("body") : null;
  if (!block) return undefined;
  let only: Node | undefined;
  for (let at = 0; at < block.childCount; at += 1) {
    const child = block.child(at);
    if (!child?.isNamed) continue;
    if (only) return undefined;
    only = child;
  }
  const expression = only?.type === "expression_statement" ? only.child(0) ?? undefined : only;
  if (!expression) return undefined;
  if (form === "match") return expression.type === "match_expression" ? expression : undefined;
  if (open === "[") return expression.type === "array_expression" ? expression : undefined;
  if (expression.type !== "call_expression") return undefined;
  return expression.childForFieldName("arguments") ?? undefined;
}
