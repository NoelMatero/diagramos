/**
 * Whether an arrow's end is the kind of thing its claim is about (#297).
 *
 * `Client --@feeds--> handle_request` cannot be true: `Client` is a struct, and
 * a struct has no result to hand anybody. Before this, every reader met that
 * arrow on its own terms, found nothing, and withheld -- so the one mistake on
 * the board a person could have fixed in a second was reported as "not sure".
 *
 * Two halves, and only the first is written by hand.
 *
 * **What each claim needs from each end** is `NEEDS`: nine short lines. `feeds`
 * needs a result from its tail, `calls` a body, `holds` a field list. That is a
 * statement about the vocabulary and it is the same in every language.
 *
 * **Whether an end has that part** is read from the grammar's fields, never
 * from node-type names (`docs/reading-a-grammar.md`). Two shapes are all it
 * knows, and both are the rule `parse.ts` is built on:
 *
 *   a routine   is a declaration with a `parameters` field
 *   a container is a declaration with a `body` field and none of
 *               `parameters`, `value`, `right` or `type`
 *
 * A routine has a signature and a result and never a field list or a base
 * list; it has a body when the grammar gave it a `body` field. A container --
 * a struct, a class, an interface, an enum, a trait, a module -- is the other
 * way round. Everything else is "not sure": a constant, a field, a type alias,
 * a variable holding who knows what, a name out of a macro. Those may be a
 * function in disguise, so they never lack anything here.
 *
 * A name declared more than once lacks a part only when **every** declaration
 * lacks it. `interface Foo` beside `function Foo` has a signature.
 *
 * Whether a lack may go red is a per-language, per-part licence, and the
 * numbers behind it are `npm run measure:parts`, which compares this reader with
 * rust-analyzer, pyright and the TypeScript compiler.
 */
import type { ArrowClaim } from "./claim";
import { declaredShapes } from "./body";
import { each, type Language, type Node } from "./parse";

export const PARTS = ["body", "signature", "result", "fields", "bases", "type"] as const;
export type Part = (typeof PARTS)[number];

export type PartReading = "has" | "lacks" | "unsure";

/**
 * What each claim needs from each end. The only hand-written part of this file.
 *
 * `needs` asks nothing of either end: every declaration lives in a file, and a
 * file has imports. `takes` and `returns` read the signature at the head, which
 * is where `signature.ts` reads it, and want a type at the tail.
 *
 * The second end of `takes`, `returns`, `holds`, `conforms` and `builds` --
 * "this end is a type" -- was added when #301's test set planted its
 * wrong-kind mistakes there and #297's first cut never looked. `calls` has no
 * second line: calling a class is how Python and a Rust tuple struct construct
 * one, so a type at its head is not a wrong kind, and a constant there may hold
 * a function.
 */
export const NEEDS: Record<ArrowClaim, { from?: Part; to?: Part }> = {
  needs: {},
  feeds: { from: "result" },
  calls: { from: "body" },
  builds: { from: "body", to: "type" },
  takes: { from: "type", to: "signature" },
  returns: { from: "type", to: "signature" },
  holds: { from: "fields", to: "type" },
  conforms: { from: "bases", to: "type" },
  accesses: { from: "body", to: "fields" },
};

/** An end without the part, in the words a person reads on the board. */
export const PART_WORDS: Record<Part, string> = {
  body: "has no body of code that runs",
  signature: "has no parameters or return type",
  result: "has no result",
  fields: "has no fields",
  bases: "has no base types",
  type: "is not a type",
};

/** And the other way round: what the claim wanted to find there. */
export const PART_NEEDED: Record<Part, string> = {
  body: "a body of code that runs",
  signature: "parameters or a return type",
  result: "a result",
  fields: "a field list",
  bases: "a base list",
  type: "a type",
};

const has = (node: Node, field: string) => node.childForFieldName(field) !== null;

/**
 * Whether any code could run in here: something invoked, or something that
 * could be.
 *
 * A call is a node with a `function` field (`parse.ts`) or Rust's `macro`, and
 * a third field catches what those two miss -- `new Buffer()` puts the callee
 * on a `constructor` field, and every invocation in every grammar here carries
 * `arguments`, which is the field they have in common.
 *
 * A routine inside counts too, and that is the wider half. A module, a
 * namespace, a class with methods all hold code, and a box anchored at one may
 * perfectly well mean "something in here calls that" -- which is a board to
 * read rather than a board to accuse. What is left saying "no body" is the
 * shape this is for: a field list, and a class of nothing but attributes.
 */
function holdsCode(node: Node): boolean {
  let found = false;
  each(node, (current) => {
    if (found || current === node) return;
    if (has(current, "function") || has(current, "macro") || has(current, "arguments")
      || has(current, "parameters")) found = true;
  });
  return found;
}

/** How one declaration reads, by the two shapes above. */
function readDeclaration(node: Node): Record<Part, PartReading> {
  if (has(node, "parameters")) {
    return {
      body: has(node, "body") ? "has" : "lacks",
      signature: "has",
      result: "has",
      fields: "lacks",
      bases: "lacks",
      type: "lacks",
    };
  }
  const container = has(node, "name") && has(node, "body")
    && !has(node, "value") && !has(node, "right") && !has(node, "type");
  if (container) {
    /*
     * A field list holds no code. A class body does: Python runs one at
     * import, TypeScript runs a field initialiser at construction, and a
     * module or a class with methods holds routines somebody may well have
     * drawn the box for. Calling any of those "no body" would be a red on
     * code doing exactly what the arrow says, so `holdsCode` keeps them all
     * out of it.
     */
    const runs = holdsCode(node.childForFieldName("body")!);
    return {
      body: runs ? "unsure" : "lacks",
      signature: "lacks", result: "lacks", fields: "unsure", bases: "unsure", type: "has",
    };
  }
  return { body: "unsure", signature: "unsure", result: "unsure", fields: "unsure", bases: "unsure", type: "unsure" };
}

const UNSURE: Record<Part, PartReading> = {
  body: "unsure", signature: "unsure", result: "unsure", fields: "unsure", bases: "unsure", type: "unsure",
};

/**
 * What one name in one file has, by every declaration of it there.
 *
 * `undefined` when the file declares no such name or has no grammar: a missing
 * name is the node check's business, not a part this name lacks.
 */
export function partsOf(
  source: string,
  name: string,
  language: Language,
): Record<Part, PartReading> | undefined {
  const declarations = declaredShapes(source, language)?.get(name);
  if (!declarations || declarations.length === 0) return undefined;
  const readings = declarations.map(({ node, soup }) => (soup ? UNSURE : readDeclaration(node)));
  const combined = { ...UNSURE };
  for (const part of PARTS) {
    const all = readings.map((reading) => reading[part]);
    combined[part] = all.every((one) => one === "lacks")
      ? "lacks"
      : all.some((one) => one === "has") ? "has" : "unsure";
  }
  return combined;
}

/** Every name a file declares, for the measurement. */
export function declaredNames(source: string, language: Language): string[] {
  return [...(declaredShapes(source, language)?.keys() ?? [])];
}

/**
 * Which parts may say "lacks" out loud, per language.
 *
 * Every square measured by `npm run measure:parts -- .corpus/*` against
 * rust-analyzer, pyright and the TypeScript compiler, over all fifteen pinned
 * repositories: 17,955 Rust names, 100,346 Python, 49,146 TS, 10,258 TSX,
 * 2,733 JS. **Zero wrong lacks and zero unjudged lacks in every square but
 * one** -- 42,222 agreed field-lacks in Python, 10,264 agreed "not a type" in
 * Rust, and so on through docs/claim-vocabulary.md's table. The one is Rust's
 * `body`, below.
 *
 * That is not the usual outcome in this codebase and is worth being suspicious
 * of, so the measurement was broken on purpose twice to check it can fail:
 * made to say a struct lacks fields, the run refuses all five languages; made
 * to say a function lacks a signature, it reports 926 wrong lacks in Python
 * and 208 in Rust.
 *
 * A square goes `false` the moment a run finds one wrong lack in that
 * language. The claim's reader is unaffected either way: losing this costs the
 * accusation and nothing else, exactly as `licence.ts` has it.
 */
export const PART_LICENCE: Record<Language, Record<Part, boolean>> = {
  ts: { body: true, signature: true, result: true, fields: true, bases: true, type: true },
  tsx: { body: true, signature: true, result: true, fields: true, bases: true, type: true },
  js: { body: true, signature: true, result: true, fields: true, bases: true, type: true },
  /*
   * Closed on `body`, and it was open for a day. A Rust type's code is its
   * `impl` blocks, which live outside the declaration and may be in any file of
   * the crate, so "this struct has no code" cannot be read off the struct. The
   * first measurement agreed with the reader only because its referee was told
   * the same wrong thing; #301's test set caught it as two false reds
   * (ripgrep's `GlobSet` and `Core`), and with the referee counting `impl`
   * blocks the square reads 1,068 wrong lacks. The same footing as `@conforms`
   * in Rust: the fact is somewhere in the crate.
   */
  rust: { body: false, signature: true, result: true, fields: true, bases: true, type: true },
  python: { body: true, signature: true, result: true, fields: true, bases: true, type: true },
};

/** One end of an arrow, as the check has it. */
export interface PartEnd {
  source: string;
  language: Language | undefined;
  symbols: string[];
}

/** An end that is the wrong kind of thing for its claim. */
export interface LackingEnd {
  end: "from" | "to";
  part: Part;
  /** The name the box anchors, as written in its ref. */
  name: string;
  /** What the source calls it: `struct`, `class`, `interface` -- or a plain word. */
  noun: string;
}

/**
 * The end of this arrow that lacks what its claim needs, if one does and the
 * reader has earned the right to say so in that end's language.
 *
 * Every name the box stands for has to lack the part: a box listing a struct
 * and the function that fills it can still feed something.
 */
export function lackingEnd(claim: ArrowClaim, from: PartEnd, to: PartEnd): LackingEnd | undefined {
  for (const end of ["from", "to"] as const) {
    const part = NEEDS[claim][end];
    const side = end === "from" ? from : to;
    if (!part || !side.language || side.symbols.length === 0) continue;
    if (!PART_LICENCE[side.language][part]) continue;
    const lacks = side.symbols.every(
      (name) => partsOf(side.source, name, side.language!)?.[part] === "lacks",
    );
    if (!lacks) continue;
    const name = side.symbols[0]!;
    return { end, part, name, noun: nounOf(side.source, name, side.language) };
  }
  return undefined;
}

/**
 * What a declaration calls itself, for the sentence.
 *
 * The word the source writes just before the name -- `struct`, `class`,
 * `trait`, `interface`. A keyword is an anonymous token, so its type is its own
 * text and no list of them is needed. A routine is "a function" whatever its
 * keyword (`fn`, `def`, `function` are not nouns), and a container that writes
 * none, like an enum variant, is "a type".
 */
function nounOf(source: string, name: string, language: Language): string {
  const declaration = declaredShapes(source, language)?.get(name)?.find((one) => !one.soup);
  if (!declaration) return "a type";
  const { node, nameNode } = declaration;
  if (has(node, "parameters")) return "a function";
  let keyword: string | undefined;
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (!child || child.startIndex >= nameNode.startIndex) break;
    if (!child.isNamed && /^[a-z]+$/.test(child.type)) keyword = child.type;
  }
  if (!keyword) return "a type";
  return `${/^[aeiou]/.test(keyword) ? "an" : "a"} ${keyword}`;
}
