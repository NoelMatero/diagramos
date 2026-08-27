/**
 * Whether one function's result actually goes into another.
 *
 * The gap this closes (#127): a great many arrows on a diagram do not mean "A
 * imports B", they mean **"A's output goes into B"** -- a pipeline. Those two
 * facts are different and frequently point opposite ways, and there was no word
 * for the second one. On the first board an agent drew here unprompted, every
 * single arrow that could never be confirmed was this shape:
 *
 *     const sibling = await readBoard(siblingPath);   // readBoard's result...
 *     const siblingGraph = readGraph(sibling);        // ...goes into readGraph
 *
 * Neither function calls the other, so every existing channel shrugs. The
 * wiring lives in a *third* function, which is the one place a body-scoped
 * search never looks.
 *
 * ## Confirm-only, on purpose
 *
 * `needs` earns the right to say **wrong** because a file's dependency
 * declarations are enumerable: read the file, and "it does not declare that"
 * is a fact about all of it. Dataflow is not like that. A value can reach B
 * through a struct field, a callback, a map, a builder chain, an await inside a
 * loop -- so *not finding* a flow says close to nothing, and a verdict built on
 * that absence would be a false accusation waiting for its first callback.
 *
 * So this only ever confirms. Finding the flow is real evidence of the exact
 * thing the arrow asserts, quotable to a file and a line; not finding it is
 * silence, and #133 made silence a count rather than a colour, which is what
 * makes a confirm-only word affordable at all. Finding the flow *only in the
 * other direction* is reported as what it is -- something specific that was
 * found, named with its evidence, and still not an accusation.
 *
 * ## What counts as a flow, and why so little does
 *
 * Two shapes, and deliberately no more:
 *
 *     B(A(x))                  A's result is handed straight to B
 *     const v = A(x); B(v)     A's result is bound, and the binding is passed
 *
 * The binding form requires the name to be passed as a direct argument, in a
 * scope that can see the binding, after it. `B(v.field)`, `B({ v })`,
 * `B(list.map(...))`, a reassignment, a value pulled out of a destructure --
 * none of them count. Every one of those is a judgement call, and every wrong
 * judgement here is the tool telling somebody their correct diagram is wrong.
 * The conservative version covers the whole population that motivated the
 * word; a miss costs one uncounted arrow.
 *
 * There is no licence gate (`licence.ts`) because there is nothing here for a
 * corpus to be measured against: this makes no claim about a whole file, only
 * that these two lines are in it. What stands in for that is the evidence --
 * every confirmation names the file and the line, so the reader can check it in
 * one glance, which is the same standard `via` routes are held to.
 */

import { parseSource, type Language, type Node } from "./parse";

/** Why no verdict could be reached. Each is a reason to stay quiet. */
export type FeedsWithheld =
  /** One end anchors a file rather than a symbol, so there is no call to look for. */
  | "not-symbols"
  /** No file that can see both ends could be read, so nowhere to look. */
  | "nowhere-to-look";

/** Where the flow was written down, so the report can quote it. */
export interface FeedsEvidence {
  /** Repo-relative file holding the wiring. */
  file: string;
  /** 1-based line the receiving call is on. */
  line: number;
  /** The symbol whose result flows. */
  producer: string;
  /** The symbol it flows into. */
  consumer: string;
  /** The name that held the result on the way, when it was bound to one. */
  through?: string;
}

export type FeedsVerdict =
  /** A's result reaches B, the way the arrow says. */
  | { verdict: "confirmed"; evidence: FeedsEvidence }
  /** A flow was found, and only the other way round. Not a verdict about the arrow. */
  | { verdict: "reversed"; evidence: FeedsEvidence }
  /** Nothing found either way, which is no evidence of anything. */
  | { verdict: "absent" }
  | { verdict: "withheld"; why: FeedsWithheld };

/** A file the wiring could be in: one that can see both ends. */
export interface FeedsCandidate {
  /** Repo-relative, for the evidence. */
  path: string;
  source: string;
  language: Language;
}

/**
 * Node types that open a scope a binding belongs to.
 *
 * By suffix and by field, like the rest of the engine, so five languages need
 * no branches: a function, a method, a closure, a lambda all have a `body`, and
 * the ones that do not -- a Rust `impl`, a class -- do not bind locals anyway.
 * Scope matters for one reason, and it is a real false positive: two functions
 * in one file can each hold `const result = ...`, and reading a binding in the
 * first as the value passed in the second would confirm an arrow from two
 * unrelated lines.
 */
const OPENS_SCOPE = /function|method|arrow|lambda|closure|constructor/;

/** The name a call calls, under the same rule `body.ts` follows for callees. */
function calleeName(node: Node): string | undefined {
  const callee = node.childForFieldName("function") ?? node.childForFieldName("macro");
  if (!callee) return undefined;
  if (callee.childCount === 0) return callee.text;
  /*
   * `self.parse(x)` and `this.parse(x)` are the same `parse` a box anchors; a
   * qualified `Other::parse(x)` or `other.parse(x)` is somebody else's, and
   * following it is how a search starts confirming arrows about libraries.
   */
  const object = callee.childForFieldName("object") ?? callee.child(0);
  const member = callee.childForFieldName("property")
    ?? callee.childForFieldName("attribute")
    ?? callee.childForFieldName("field");
  if (object && member && (object.text === "self" || object.text === "this")) return member.text;
  return undefined;
}

/** Whether a node is a call to one of these names. */
function callsOne(node: Node, names: string[]): string | undefined {
  const name = calleeName(node);
  return name && names.includes(name) ? name : undefined;
}

/**
 * The value a binding binds, when the binding is one name and nothing clever.
 *
 * `name`/`value` is TypeScript's `const v = ...`; `pattern`/`value` is Rust's
 * `let v = ...`; `left`/`right` is an assignment and a Python binding. A
 * destructuring pattern has children and is refused here: which part of it
 * holds the call is exactly the judgement this file does not make.
 */
function bindingOf(node: Node): { name: string; value: Node } | undefined {
  const name = node.childForFieldName("name")
    ?? node.childForFieldName("pattern")
    ?? node.childForFieldName("left");
  if (!name || name.childCount > 0) return undefined;
  const value = node.childForFieldName("value") ?? node.childForFieldName("right");
  return value ? { name: name.text, value } : undefined;
}

/**
 * Node types that hold a value without changing whose result it is.
 *
 * `await A()`, `(A())`, `A()?`, `&A()`, `A() as T`. Named rather than inferred
 * from shape, and that is the point: `[A()]` and `f(A())` also contain exactly
 * one call, and what they hold is an array and f's result. A list of wrappers
 * can only be incomplete, which costs an uncounted arrow; a shape rule that
 * guessed would cost a false confirmation.
 */
const WRAPS = /^(await|try|parenthesized|unary|reference|non_null|as_|satisfies)/;

/**
 * Peel those wrappers, so `const v = await A()` still reads as v holding A's
 * result. Stops at the first thing that is a call, and at anything it does not
 * recognise.
 */
function unwrap(node: Node): Node {
  let current = node;
  // Four is past `await (A())?` and nothing real goes deeper. A cap rather than
  // a while, because the one thing a tree walk must never do is not terminate.
  for (let depth = 0; depth < 4; depth += 1) {
    if (calleeName(current)) return current;
    if (!WRAPS.test(current.type)) return current;
    let inner: Node | undefined;
    let calls = 0;
    for (let index = 0; index < current.childCount; index += 1) {
      const child = current.child(index);
      if (child && calleeName(child)) { inner = child; calls += 1; }
    }
    // Two calls under one wrapper is an expression doing arithmetic on results,
    // and which of them the binding holds is not a question with one answer.
    if (calls !== 1 || !inner) return current;
    current = inner;
  }
  return current;
}

/** The direct arguments of a call, if it has an argument list at all. */
function argumentsOf(node: Node): Node[] {
  const list = node.childForFieldName("arguments") ?? node.childForFieldName("argument_list");
  if (!list) return [];
  const found: Node[] = [];
  for (let index = 0; index < list.childCount; index += 1) {
    const child = list.child(index);
    // Punctuation has no field and no children worth reading; keeping it costs
    // one failed comparison and no correctness.
    if (child) found.push(child);
  }
  return found;
}

/** 1-based line a node starts on, the same way `deps.ts` names its evidence. */
function lineOf(source: string, node: Node): number {
  return source.slice(0, node.startIndex).split("\n").length;
}

/**
 * One file, one direction: does anything here bind a producer's result and pass
 * it into a consumer?
 *
 * A single pre-order walk carrying a stack of scopes, because bindings are only
 * visible to the code after them and inside them -- which is lexical scoping,
 * and which a flat visitor cannot express. The parse facade has no parent
 * pointers, so the walk keeps the ancestry itself.
 */
function flowIn(
  candidate: FeedsCandidate,
  producers: string[],
  consumers: string[],
): FeedsEvidence | undefined {
  /*
   * The cheap gate first: a file that never writes either name cannot hold the
   * wiring, and the candidate set is every file importing both ends. A
   * substring test is wrong in both directions on its own -- a name in a
   * comment passes it, a name never written fails it -- and it is only ever
   * asked whether the parse is worth doing.
   */
  if (!producers.some((name) => candidate.source.includes(name))) return undefined;
  if (!consumers.some((name) => candidate.source.includes(name))) return undefined;

  const tree = parseSource(candidate.source, candidate.language);
  if (!tree) return undefined;

  /** Names currently in scope that hold a producer's result, innermost last. */
  const scopes: Array<Map<string, string>> = [new Map()];
  let found: FeedsEvidence | undefined;

  const held = (name: string): string | undefined => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const producer = scopes[index]!.get(name);
      if (producer) return producer;
    }
    return undefined;
  };

  const walk = (node: Node): void => {
    if (found) return;
    const opens = OPENS_SCOPE.test(node.type) && node.childForFieldName("body") !== null;
    if (opens) scopes.push(new Map());

    // A call into a consumer, reading its arguments for a producer's result.
    const consumer = callsOne(node, consumers);
    if (consumer) {
      for (const argument of argumentsOf(node)) {
        const inner = unwrap(argument);
        const nested = callsOne(inner, producers);
        if (nested) {
          found = {
            file: candidate.path,
            line: lineOf(candidate.source, node),
            producer: nested,
            consumer,
          };
          break;
        }
        if (argument.childCount === 0) {
          const producer = held(argument.text);
          if (producer) {
            found = {
              file: candidate.path,
              line: lineOf(candidate.source, node),
              producer,
              consumer,
              through: argument.text,
            };
            break;
          }
        }
      }
    }

    // A binding of a producer's result, recorded for the code that follows it.
    if (!found) {
      const binding = bindingOf(node);
      if (binding) {
        const producer = callsOne(unwrap(binding.value), producers);
        if (producer) scopes[scopes.length - 1]!.set(binding.name, producer);
      }
    }

    if (!found) {
      for (let index = 0; index < node.childCount; index += 1) {
        const child = node.child(index);
        if (child) walk(child);
        if (found) break;
      }
    }
    if (opens) scopes.pop();
  };

  walk(tree.rootNode);
  return found;
}

/**
 * Whether the tail's result flows into the head, somewhere a reader can see it.
 *
 * `from` and `to` are read as the arrow is drawn: `from`'s output goes into
 * `to`. Both ends carry every symbol their box anchors, and any pairing counts
 * -- the same any-of-the-members rule the body search uses, and for the same
 * reason: a box standing for a concept is satisfied by one of its names.
 *
 * `candidates` are the files that can see both ends: the two endpoint files,
 * and any file importing both. The caller assembles them, because the caller is
 * the one holding the import graph -- and it is the same candidate set the
 * shared-importer channel already computes.
 */
export function checkFeeds(
  from: { symbols: string[] },
  to: { symbols: string[] },
  candidates: FeedsCandidate[],
): FeedsVerdict {
  if (from.symbols.length === 0 || to.symbols.length === 0) {
    return { verdict: "withheld", why: "not-symbols" };
  }
  if (candidates.length === 0) return { verdict: "withheld", why: "nowhere-to-look" };

  /*
   * Forward first, and the whole candidate list, before looking backwards at
   * all. A flow the arrow claims is the answer; a flow the other way is only
   * worth mentioning once the claimed one is nowhere.
   */
  for (const candidate of candidates) {
    const evidence = flowIn(candidate, from.symbols, to.symbols);
    if (evidence) return { verdict: "confirmed", evidence };
  }
  for (const candidate of candidates) {
    const evidence = flowIn(candidate, to.symbols, from.symbols);
    if (evidence) return { verdict: "reversed", evidence };
  }
  return { verdict: "absent" };
}
