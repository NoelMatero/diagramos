/**
 * The cases a routine dispatches on.
 *
 * A box can say `handles: ["Get", "Post", "Delete"]` about a routine, and the
 * question this answers is what the code actually dispatches on, so the two can
 * be compared. The failure it exists to catch: the code grows a case, the
 * routine does not handle it, and every check stays green.
 *
 * ## One list, and everything else is the grammar talking
 *
 * `docs/reading-a-grammar.md` records a reader that made the same mistake four
 * times in one sitting, every instance a hand-written list of node names one
 * language spelled differently. So there is exactly one list here -- which
 * nodes *are* a dispatch -- and every other question is answered by reading a
 * field or the structure. The list is tested for completeness rather than for
 * its contents, so the two halves cannot drift.
 *
 * What the four grammars share, probed rather than assumed:
 *
 *     a dispatch over cases  is a node with a `body` field whose named
 *                            children are the cases
 *     the subject            is the first named child before that body
 *     a case's label         is its first named child, unless that child is
 *                            the case's own consequence
 *     a catch-all            is a case with no label, or a label that has no
 *                            named children and whose text is `_`
 *
 * Those hold for Rust's `match`, TypeScript's and JavaScript's `switch`, and
 * Python's `match`, which spell almost none of it the same way: the matched
 * expression is `value` in Rust and TypeScript and `subject` in Python, the
 * cases are `match_arm`, `switch_case` and `case_clause`, and the body is
 * `match_block`, `switch_body` and a plain `block`.
 *
 * ## The field that means two opposite things
 *
 * `value` on a Rust `match_arm` is the arm's *result*; `value` on a TypeScript
 * `switch_case` is the case's *label*. Reading `value` generically would take
 * `200` out of `Method::Get => 200` and call it a case. That is the trap
 * `reading-a-grammar.md` names, arriving in a new reader, so nothing here
 * reads `value` at all -- a label is found by position and excluded by the
 * consequence fields, which mean the same thing everywhere.
 *
 * ## An unknown is loud
 *
 * A shape inside a dispatch that this cannot name is collected in
 * `unreadable`, by node type, and counts against the claim rather than for it.
 * A reader that quietly skips what it does not recognise reports a case set
 * that is short by however much it could not read, which reads as a finding
 * about the code.
 */

import { each, type Language, type Node, type Tree } from "./parse";

/** One case a dispatch names. */
export interface DispatchCase {
  /** The name a reader would recognise: `Get`, `GET`, `0`. */
  name: string;
  /** 1-based, for naming the line the evidence sits on. */
  line: number;
}

export interface Dispatch {
  /** What is being dispatched on, as written: `m`, `a.kind`, `self.state`. */
  subject: string;
  /** The cases, in source order, with `|` alternatives flattened. */
  cases: DispatchCase[];
  /** A `_` arm or a `default:` -- everything unlisted falls in here. */
  catchAll: boolean;
  /** Node types inside this dispatch the reader could not name. */
  unreadable: string[];
  /** 1-based line the dispatch starts on. */
  line: number;
}

/**
 * The one list: which nodes are a dispatch over a list of cases.
 *
 * Three entries for five languages, and it is a list rather than a shape rule
 * for a measured reason. The obvious rule -- a node with a `body` field and no
 * `name` field -- also matches every loop in every one of these grammars, and
 * Python's `match` body is a plain `block` exactly like a `for` body, so no
 * property of the body separates them either. `reading-a-grammar.md` permits a
 * list on two conditions and both are met here: nothing else is a second list
 * that has to agree with this one, and `tests/engine-handles.test.ts` asserts
 * every entry yields a dispatch from real source, so an entry cannot rot into
 * a language that silently reads zero.
 */
const DISPATCH_OVER_CASES = /^(match_expression|switch_statement|match_statement)$/;

/**
 * The second entry in that list: a chain of equality tests.
 *
 * `if`/`elif`/`else` is the other way a routine dispatches on a closed set,
 * and #206 names it as a shape to cover. It is structurally unlike a `match`
 * -- there is no body of cases and nothing states the subject -- so it is read
 * separately and gated much harder, below.
 */
const DISPATCH_OVER_A_CHAIN = /^(if_statement|if_expression)$/;

/**
 * The operators that make a test a case rather than a condition.
 *
 * Equality only, and read as a symbol rather than as a node type for
 * `reading-a-grammar.md`'s reason: TypeScript and Rust call the comparison
 * `binary_expression` and put the operator on a field, Python calls it
 * `comparison_operator` and leaves the operator an anonymous token. The symbol
 * is the same in all three, and a new grammar cannot invent a new spelling of
 * equality -- only a new symbol, which is a much smaller problem.
 */
const EQUALITY = new Set(["==", "==="]);

/**
 * The fields a case puts its *result* behind, in any of these grammars.
 *
 * This is the exclusion that lets a label be found by position. It has to
 * exist because `value` means the label on a TypeScript `switch_case` and the
 * result on a Rust `match_arm`, so the one field name that looks generic is
 * the one that cannot be trusted.
 */
const CONSEQUENCE = ["body", "consequence"] as const;

/** Named children a field does not already account for, in source order. */
function looseChildren(node: Node, exclude: readonly string[]): Node[] {
  const claimed = new Set<number>();
  for (const field of exclude) {
    const child = node.childForFieldName(field);
    if (child) claimed.add(child.id);
  }
  const found: Node[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child?.isNamed && !claimed.has(child.id)) found.push(child);
  }
  return found;
}

/** 1-based line of a byte offset, which is what a report quotes. */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

/** A name with a language's quoting taken off: `"GET"` and `\'GET\'` are `GET`. */
const unquote = (text: string) => text.replace(/^(["\'`])([\s\S]*)\1$/, "$2");

/**
 * A case a person would recognise as one, or nothing.
 *
 * Only three things reach the bottom of this and they are the same three in
 * every grammar: a name, a literal, and a path whose last segment is the name.
 * Anything else -- a subscript, a call, a computed key -- returns nothing and
 * the caller records the node type, because a case the reader cannot name is
 * a case it must not claim to have read.
 */
const READABLE_NAME = /^[A-Za-z_$][\w$]*$|^-?\d[\w.]*$/;

/**
 * Flatten one label into the cases it names.
 *
 * Four rules, applied in this order, and the order is the whole of it:
 *
 *   a `name` field      the grammar has already picked the name out
 *                       (`Event::Key` -> `Key`)
 *   a `type` field      a payload pattern names its variant in its type
 *                       (`Event::Scroll(_)` -> the type -> `Scroll`)
 *   an anonymous `|`    an alternation: `A | B` is two cases, not one
 *   one loose child     a wrapper: `match_pattern`, a quoted string
 *   otherwise           its own text, with any quoting taken off
 *
 * `name` and `type` come first because a struct pattern has both a `type` and
 * a pile of loose field patterns, and reading the fields would report `x` as a
 * case of `Event::Click { x, .. }`.
 *
 * **The alternation test reads the separator, not the child count**, and that
 * is a fix rather than a first draft. Counting children says "more than one
 * loose child is an alternation", which is true of Rust's `or_pattern` and of
 * Python's `union_pattern` and also of a Python *string*: Python names
 * `string_start`, `string_content` and `string_end`, where TypeScript's
 * `string` has one `string_fragment` and Rust's `string_literal` keeps its
 * quotes anonymous. So one `case "GET"` came back as four unreadable shapes in
 * Python and as one clean case everywhere else -- `reading-a-grammar.md`'s
 * exact failure, a list-free rule that one grammar's shape did not satisfy,
 * and it was found by the completeness test rather than by reasoning.
 *
 * A tree-sitter operator token is anonymous, so its type is its own text. That
 * is a property of the parser rather than of any grammar, which is why `|`
 * works as the separator test in both languages that have one and costs
 * nothing in the three that do not.
 */
function namesIn(label: Node, out: string[], unreadable: string[]): void {
  const named = label.childForFieldName("name");
  if (named) return namesIn(named, out, unreadable);

  const typed = label.childForFieldName("type");
  if (typed) return namesIn(typed, out, unreadable);

  const loose = looseChildren(label, ["condition", "consequence", "body"]);
  if (hasAlternation(label)) {
    for (const child of loose) namesIn(child, out, unreadable);
    return;
  }
  if (loose.length === 1) return namesIn(loose[0], out, unreadable);

  const text = unquote(label.text.trim());
  if (READABLE_NAME.test(text)) out.push(text);
  else unreadable.push(label.type);
}

/**
 * `A | B`, by its separator.
 *
 * The `|` is an anonymous token, so its node type is the character itself.
 */
function hasAlternation(label: Node): boolean {
  for (let index = 0; index < label.childCount; index += 1) {
    const child = label.child(index);
    if (child && !child.isNamed && child.type === "|") return true;
  }
  return false;
}

/** A label that swallows everything unlisted: Rust and Python `_`. */
const isWildcard = (label: Node) =>
  looseChildren(label, []).length === 0 && label.text.trim() === "_";

/**
 * The subject as written, with one wrapping pair of parentheses taken off.
 *
 * Textual on purpose: `switch (a.kind)` and `match self.state` have to compare
 * equal to what somebody typed on a box, and TypeScript wraps its discriminant
 * in a `parenthesized_expression` while Rust and Python do not.
 */
const subjectOf = (node: Node) => {
  const text = node.text.trim();
  return /^\(.*\)$/.test(text) ? text.slice(1, -1).trim() : text;
};

/** One side of a comparison, by field where there is one and by position where there is not. */
function sideOf(condition: Node, field: "left" | "right"): Node | undefined {
  const named = condition.childForFieldName(field);
  if (named) return named;
  const loose = looseChildren(condition, []);
  return field === "left" ? loose[0] : loose[loose.length - 1];
}

/**
 * Past whatever a grammar wraps its condition in.
 *
 * TypeScript and JavaScript put the test inside a `parenthesized_expression`
 * because the parentheses are part of the syntax; Rust and Python hand over
 * the comparison directly. Structural rather than a node-type check: a
 * wrapper is a node with exactly one loose child and no operator of its own,
 * which is true of parentheses in every grammar that has them.
 */
function unwrapCondition(node: Node): Node {
  let at = node;
  for (let depth = 0; depth < 4; depth += 1) {
    if (at.childForFieldName("operator")) return at;
    const loose = looseChildren(at, []);
    if (loose.length !== 1) return at;
    at = loose[0];
  }
  return at;
}

/** The comparison's operator, from the field or from the anonymous token. */
function operatorOf(condition: Node): string | undefined {
  const field = condition.childForFieldName("operator");
  if (field) return field.type;
  for (let index = 0; index < condition.childCount; index += 1) {
    const child = condition.child(index);
    if (child && !child.isNamed && EQUALITY.has(child.type)) return child.type;
  }
  return undefined;
}

/** `(m)` is `m`; a member read stays whole. */
const bare = (text: string) => {
  const trimmed = text.trim();
  return /^\(.*\)$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
};

/**
 * An `if`/`elif` chain, or nothing.
 *
 * **The gate is the design.** A chain counts as a dispatch only when *every*
 * test is an equality against a readable literal and every one of them tests
 * the *same* left-hand expression. `if (ready) .. else if (count > 3) ..` is
 * ordinary control flow, and reading it as a two-case dispatch would put a
 * case set on a box that never had one.
 *
 * So this returns nothing rather than a partial answer, which is the same
 * stance `needs.ts` takes: a claim it cannot fully read is a claim it declines
 * to have read at all.
 */
function readChain(head: Node, source: string, consumed: Set<number>): Dispatch | undefined {
  const cases: DispatchCase[] = [];
  const unreadable: string[] = [];
  let subject: string | undefined;
  let catchAll = false;
  /*
   * A work-list rather than a single `next`, because the two grammars disagree
   * about the shape of a chain and a first draft that chased one pointer lost
   * the middle of every Python one.
   *
   *   Python    flat: the `if` holds every `elif_clause` and the `else_clause`
   *             as its own siblings
   *   TS, Rust  nested: `else if` is an `if` inside an `else_clause`, so each
   *             link holds the next one
   *
   * Taking the last branch with a condition works for the nested shape and
   * reads `if A elif B elif C` as two cases in Python -- A and C -- which is a
   * case list short by the middle of the chain. Found by the Python test; the
   * TypeScript one passed throughout.
   */
  const pending: Node[] = [head];

  while (pending.length > 0) {
    const link = pending.shift()!;
    consumed.add(link.id);
    const wrapped = link.childForFieldName("condition");
    if (!wrapped) return undefined;
    const condition = unwrapCondition(wrapped);
    if (!EQUALITY.has(operatorOf(condition) ?? "")) return undefined;

    const left = sideOf(condition, "left");
    const right = sideOf(condition, "right");
    if (!left || !right || left.id === right.id) return undefined;

    const here = bare(left.text);
    // Every link has to be asking about the same thing, or this is not a set
    // of cases -- it is a sequence of unrelated questions.
    subject ??= here;
    if (subject !== here) return undefined;

    const names: string[] = [];
    namesIn(right, names, unreadable);
    if (names.length === 0) return undefined;
    const line = lineOf(source, condition.startIndex);
    for (const name of names) cases.push({ name, line });

    // Every branch beyond the condition and its consequence is a continuation
    // of the chain, in source order: an `elif_clause`, an `else_clause` with
    // the next `if` inside it, or an `else_clause` with a plain block.
    for (const branch of looseChildren(link, ["condition", "consequence"])) {
      if (branch.childForFieldName("condition")) {
        pending.push(branch); // an `elif_clause`, which is another link
        continue;
      }
      const nested = looseChildren(branch, []).find((child) =>
        DISPATCH_OVER_A_CHAIN.test(child.type));
      if (nested) {
        pending.push(nested); // `else if`, spelled as an `if` inside an `else`
        continue;
      }
      catchAll = true; // a bare `else`
    }
  }

  if (subject === undefined || cases.length < 2) return undefined;
  return { subject, cases, catchAll, unreadable, line: lineOf(source, head.startIndex) };
}

export function findDispatches(tree: Tree, source: string, _language: Language): Dispatch[] {
  const found: Dispatch[] = [];
  /*
   * Links already read as part of a chain. An `else if` is an `if` inside an
   * `else`, so a depth-first walk meets it again on its own and would report
   * the same chain once per link, each time one case shorter.
   */
  const consumed = new Set<number>();
  each(tree.rootNode, (node) => {
    if (DISPATCH_OVER_A_CHAIN.test(node.type)) {
      if (consumed.has(node.id)) return;
      const chain = readChain(node, source, consumed);
      if (chain) found.push(chain);
      return;
    }
    if (!DISPATCH_OVER_CASES.test(node.type)) return;
    const body = node.childForFieldName("body");
    if (!body) return;

    // The subject is the first named child standing before the body. Read by
    // position rather than by field name, which is `value` in Rust and
    // TypeScript and `subject` in Python.
    const before = looseChildren(node, ["body"]);
    if (before.length === 0) return;

    const cases: DispatchCase[] = [];
    const unreadable: string[] = [];
    let catchAll = false;

    for (const branch of looseChildren(body, [])) {
      const label = looseChildren(branch, CONSEQUENCE)[0];
      // No label at all is a `default:`, which is TypeScript's spelling of the
      // wildcard: the grammar gives `switch_default` its consequence and
      // nothing else.
      if (!label) {
        catchAll = true;
        continue;
      }
      if (isWildcard(label)) {
        catchAll = true;
        continue;
      }
      const names: string[] = [];
      namesIn(label, names, unreadable);
      const line = lineOf(source, label.startIndex);
      for (const name of names) cases.push({ name, line });
    }

    found.push({
      subject: subjectOf(before[0]),
      cases,
      catchAll,
      unreadable,
      line: lineOf(source, node.startIndex),
    });
  });
  return found;
}
