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
 * from node-type names (`docs/reading-a-grammar.md`). Three shapes are all it
 * knows, and all three are the rule `parse.ts` is built on:
 *
 *   a routine   is a declaration with a `parameters` field
 *   a container is a declaration with a `body` field and none of
 *               `parameters`, `value`, `right` or `type`
 *   a value     is a declaration with a `type` field, or one assigned
 *               something this file can read the shape of
 *
 * A routine has a signature and a result and never a field list or a base
 * list; it has a body when the grammar gave it a `body` field. A container --
 * a struct, a class, an interface, an enum, a trait, a module -- is the other
 * way round.
 *
 * A value is the third, and it is narrower than it sounds (#307, #337). What
 * can be said about one without resolving a single name is that it is not a
 * type: `status: QueryStatus` names one thing of that type and is not the type
 * itself, so `@builds` or `@holds` pointed at it can never be true. Whether
 * anything can *call* it is a second question, answered only where the type is
 * written plainly enough that no resolution could change it -- every word of
 * that is in `couldBeCalled`, and it is the one rule in this file that has to
 * know how each language spells a function.
 *
 * Everything else is "not sure" on the text alone: a type alias, a name
 * assigned a call's result, a name out of a macro. Those may be a function or a
 * type in disguise.
 *
 * **Where a compiler answers, it settles that doubt (#343).** `ctx =
 * makeContext()` is a value the text cannot judge and the TypeScript checker or
 * pyright can: asked at the name, it says whether a value of that type can be
 * called and whether the name is a type. `partsOf` takes that answer as `ask`,
 * only for a value and only where the text was unsure, and without one reads
 * exactly as before -- so no answer is never an accusation.
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

export const PARTS = [
  "body", "signature", "result", "fields", "bases", "type", "callable", "implementable",
] as const;
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
 * wrong-kind mistakes there and #297's first cut never looked. `conforms` asks
 * one step more of its head than "a type" (#345): something a type can
 * implement or extend, which is every type in TypeScript and Python and only
 * a trait in Rust. `calls` has no
 * second line: calling a class is how Python and a Rust tuple struct construct
 * one, so a type at its head is not a wrong kind, and a constant there may hold
 * a function.
 */
export const NEEDS: Record<ArrowClaim, { from?: Part; to?: Part }> = {
  needs: {},
  // Same as `needs`: every declaration lives in a file, and a file has imports.
  depends: {},
  feeds: { from: "result" },
  calls: { from: "body", to: "callable" },
  builds: { from: "body", to: "type" },
  takes: { from: "type", to: "signature" },
  returns: { from: "type", to: "signature" },
  holds: { from: "fields", to: "type" },
  conforms: { from: "bases", to: "implementable" },
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
  callable: "holds data, and cannot be called",
  implementable: "cannot be implemented",
};

/** And the other way round: what the claim wanted to find there. */
export const PART_NEEDED: Record<Part, string> = {
  body: "a body of code that runs",
  signature: "parameters or a return type",
  result: "a result",
  fields: "a field list",
  bases: "a base list",
  type: "a type",
  callable: "something that can be called",
  implementable: "a type another can implement or extend (in Rust, only a trait)",
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

/**
 * Whether this value is written out in full: a number, a string, `true`, a list
 * of those.
 *
 * The test is what a literal has *not* got, which is the same question in every
 * grammar and needs no list of what each one calls a number: no name anywhere
 * inside it, nothing invoked, and nothing carrying parameters or a body. So
 * `4`, `"utf-8"` and `[1, 2]` qualify; `() => {}` has parameters, `makeIt()`
 * has a call, and `OTHER` is a name that may stand for anything.
 *
 * What it buys is the one thing that can be said about a constant without
 * guessing: a value spelled out like this is not a function and not a type.
 */
/**
 * The words a language writes for a value that has no name of its own. They
 * parse as names and are not ones -- Python capitalises its two, which is the
 * kind of spelling difference this file otherwise never has to know about.
 */
const LITERAL_WORDS = new Set([
  "true", "false", "True", "False", "None", "null", "undefined", "nil",
]);

function isLiteral(value: Node): boolean {
  let plain = true;
  let written = false;
  each(value, (current) => {
    if (!plain) return;
    if (has(current, "function") || has(current, "macro") || has(current, "arguments")
      || has(current, "parameters") || has(current, "body")) plain = false;
    if (current.childCount !== 0) return;
    const text = current.text;
    if (LITERAL_WORDS.has(text)) { written = true; return; }
    /*
     * An empty collection is written out in full and writes nothing down:
     * `[]`, `{}`, `()`. Without this the rule below asks for a number or a
     * string and finds neither, and `result: Record<string, string[]> = {}`
     * reads as a value nobody may say anything about.
     *
     * An opening bracket only, and only as a token of its own: the closing one
     * would count the same collection twice, and a bracket *inside* a name is
     * not a token at all.
     */
    if (!current.isNamed && (text === "[" || text === "{" || text === "(")) { written = true; return; }
    // A name is a childless node whose text could be one: `OTHER`, `String`.
    if (current.isNamed && /^[A-Za-z_]\w*$/.test(text)) { plain = false; return; }
    // A number or a string: what makes this a value rather than punctuation.
    if (/^["'`]/.test(text) || /^\d/.test(text)) written = true;
  });
  /*
   * Something must actually be written down. Without this, a type expression
   * made of keywords -- `type ColorTuple = readonly [string, string]`, whose
   * `string` is a keyword rather than a name -- reads as a value written out in
   * full, and a type would be told it is not a type.
   */
  return plain && written;
}

/**
 * The word a declaration opens with, where it has one: `const`, `static`,
 * `type`, `class`. A keyword is an anonymous token, so its type is its own
 * text -- the reading `nounOf` uses for the sentence, used here to keep one
 * word out of the literal rule.
 */
function keywordOf(node: Node, nameNode: Node): string | undefined {
  let keyword: string | undefined;
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (!child || child.startIndex >= nameNode.startIndex) break;
    if (!child.isNamed && /^[a-z]+$/.test(child.type)) keyword = child.type;
  }
  return keyword;
}

/**
 * A value made by constructing something: `new WeakSet()`, `new Buffer(4)`.
 *
 * Read off the `constructor` field, which is what the grammars that have this
 * shape put the constructed name on. What comes back is an instance, and an
 * instance is not a type and is not something a call can reach -- a class with
 * a call signature is a declaration-merging trick and would need one anyway.
 */
function isConstruction(value: Node): boolean {
  return has(value, "constructor");
}

/**
 * A value whose own shape is written out: a lambda, a comprehension, anything
 * the grammar gives parameters or a body of its own.
 *
 * Whatever else it is, it is a value -- nothing in these languages lets a
 * lambda or a list comprehension stand where a type name does -- so this
 * settles `type` and leaves `callable` exactly as unsure as it found it.
 */
function isWrittenValue(value: Node): boolean {
  return has(value, "parameters") || has(value, "body");
}

/**
 * The names each language writes for a type that cannot hold a function.
 *
 * A list, and the third in this file after `LITERAL_WORDS` and the keywords
 * `nounOf` reads -- for the reason `docs/reading-a-grammar.md` allows one: the
 * fact is not in the tree. `x: Handler` is callable or not depending on what
 * `Handler` turns out to be, and nothing in this file resolves a name.
 *
 * So the question is turned round. Rather than ask which types are functions,
 * which needs the whole program, ask which are written out plainly enough that
 * no resolution could change the answer. A `bool` is a bool in every file.
 *
 * TypeScript's are keywords, which no `type` statement can rebind. Python's
 * are builtins, which one could shadow and none of the fifteen corpus
 * repositories does. Rust is not in here and does not need to be: see below.
 */
const NOT_A_FUNCTION: Record<string, RegExp> = {
  ts: /^(string|number|boolean|void|null|undefined|symbol|bigint|never|object|true|false|readonly|unique)$/,
  python: /^(int|str|bool|float|complex|bytes|bytearray|list|dict|set|frozenset|tuple|None)$/,
};

/**
 * Whether a written type could be something a call reaches.
 *
 * Doubt goes to `true`, so a type this does not recognise keeps the name
 * `unsure` and nobody is accused over it.
 *
 * **Rust is read in full**, because there the answer is in the type as
 * written: a value is callable only where it is a function pointer, a closure
 * or a generic whose bound is elsewhere -- `fn`, `Fn`, `dyn`, `impl`, or a
 * bare parameter like `F`. A `Vec<Spec>` is not callable and neither is an
 * `Option<fn()>`, which has to be unwrapped before anything can call it.
 *
 * **TypeScript and Python are read conservatively**, because there a name can
 * be a function type -- `type NodeTransform = (node, ctx) => void` -- and this
 * file cannot follow a name. Only a type spelled out of the words above is
 * judged, and every named type keeps its doubt. That costs most of what this
 * rule could catch in those two languages and it is the difference between a
 * red that is always right and one that is right about the corpus.
 */
function couldBeCalled(annotation: string, language: Language): boolean {
  /*
   * The colon belongs to the annotation in the curly-brace grammars and not in
   * Rust's or Python's, so it is taken off here rather than in three places:
   * `: F` and `F` are the same written type.
   */
  const text = annotation.replace(/^\s*:\s*/, "").trim();
  if (text === "") return true;
  if (language === "rust") {
    return /^[A-Z]\w?$/.test(text) || /\b(fn|Fn|FnMut|FnOnce|dyn|impl)\b/.test(text);
  }
  const plain = NOT_A_FUNCTION[language === "tsx" || language === "js" ? "ts" : language];
  if (!plain) return true;
  /*
   * A function type written out has punctuation and may have no words at all:
   * `() => void` is one, and so is `{ (): void }`, and reading only the words
   * in them finds `void` and calls the field a plain value. Found by the
   * corpus -- TanStack's `destroy: () => void` -- and it is the whole reason
   * this rule is measured before it may accuse.
   */
  if (/=>|\(/.test(text)) return true;
  /*
   * A written-out value stands for itself: `type: 'failed'` is a string and
   * nothing resolves it into a function. Taken out first, or the word inside
   * the quotes reads as a name.
   */
  const spelled = text.replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, "");
  // Every word left has to be one of them; the punctuation between them --
  // `|`, `[]`, `?`, `<>` -- builds nothing a call could reach.
  const words = spelled.match(/[A-Za-z_]\w*/g) ?? [];
  return !words.every((word) => plain.test(word));
}

/**
 * Whether this name is a type alias written with an annotation rather than a
 * keyword: `Handler: TypeAlias = Callable[[], None]`.
 *
 * Python's spelling, and the one shape where a written type does not mean the
 * name is a value.
 */
function aliasesByAnnotation(text: string): boolean {
  return /\bTypeAlias\b/.test(text);
}

/**
 * `type Handler = "a" | "b"` writes a value where a type belongs, and the one
 * thing that tells it apart from a constant is the word the language opens it
 * with. Both TypeScript and Rust spell it `type`.
 */
function aliasesAType(node: Node): boolean {
  const name = node.childForFieldName("name");
  return name !== null && keywordOf(node, name) === "type";
}

/**
 * Whether a type could implement or extend this one, for `@conforms`' head
 * (#345).
 *
 * In TypeScript and Python this is the same question as "is it a type": a
 * class can be extended and implemented, an interface or a `Protocol` too, so
 * no type there is the wrong kind of thing to conform to.
 *
 * **In Rust only a trait can be implemented**, and whether a declaration is one
 * is written on the declaration itself -- but not in a field. A trait, a
 * struct, an enum and a module all carry the same two, `name` and `body`, and
 * a unit struct carries only `name`. What differs is the word before the name,
 * and a keyword is an anonymous token, so its type is its own text: the reading
 * `nounOf` makes to say "a struct" in the sentence. `trait` is the one word
 * that makes a thing implementable, which is a rule of the language and not a
 * list of its declarations -- `struct`, `enum`, `union`, `mod`, `fn`, `const`
 * all fall out of it without being named. `unsafe trait` and `auto trait` end
 * on the same word.
 *
 * Where the declaration opens with no word -- an enum variant, a field -- the
 * answer is whatever `type` said, and an alias keeps its doubt: `type Handler =
 * ...` may name a trait object, and nothing here follows it.
 */
function implementable(node: Node, language: Language, type: PartReading): PartReading {
  if (language !== "rust" || aliasesAType(node)) return type;
  const name = node.childForFieldName("name");
  const keyword = name ? keywordOf(node, name) : undefined;
  if (!keyword) return type;
  return keyword === "trait" ? "has" : "lacks";
}

/**
 * What a compiler says about one declared name (#343): whether a value of its
 * type can be called, and whether the name is a type. `undefined` for either
 * is the compiler not knowing -- an `any`, an unresolved import, a type
 * parameter -- and is read exactly as no answer at all.
 */
export interface ValueKind {
  callable?: boolean;
  type?: boolean;
}

/** Asks a compiler about the name at this range, or answers `undefined`. */
export type AskKind = (at: { start: number; end: number }) => ValueKind | undefined;

/**
 * Whether a declaration is a value, which is the one kind a compiler is asked
 * about. A routine and a container read their parts off the grammar and need
 * nothing more; a type alias is a type whatever it aliases.
 */
function isValue(node: Node, language: Language): boolean {
  if (has(node, "parameters") || isContainer(node) || aliasesAType(node)) return false;
  const written = node.childForFieldName("type");
  return !(language === "python" && written && aliasesByAnnotation(written.text));
}

/**
 * The compiler's answer, laid over the text's reading of a value (#343).
 *
 * It only ever settles a doubt. What the text already knows it keeps: a
 * `lacks` it reads was licensed by `measure:parts` on its own, and a compiler
 * saying "callable" about a name the text calls unsure changes nothing.
 *
 * **Not callable** settles `body`, `signature` and `callable` together, the
 * same three `readShape` settles from a written type: a value nothing can call
 * has no code of its own that runs.
 *
 * **Not a type** is only believed of a value that is also not callable. A
 * variable holding a class (`const Model = class {}`, Python's `type[Foo]`) or
 * a component (`const Row = memo(...)`) is a value to the compiler and is
 * exactly what `@builds` means to point at; its type has a call or a construct
 * signature, and that is the answer that keeps it out.
 */
function settle(shape: Shape, kind: ValueKind | undefined): Shape {
  if (kind?.callable !== false) return shape;
  const lacks = (part: PartReading): PartReading => (part === "unsure" ? "lacks" : part);
  return {
    ...shape,
    body: lacks(shape.body),
    signature: lacks(shape.signature),
    callable: lacks(shape.callable),
    type: kind.type === false ? lacks(shape.type) : shape.type,
  };
}

/** How one declaration reads, by the shapes above and, for a value, a compiler's answer. */
function readDeclaration(node: Node, nameNode: Node, language: Language, ask?: AskKind): Record<Part, PartReading> {
  const read = readShape(node, language);
  const shape = ask && (read.callable === "unsure" || read.type === "unsure") && isValue(node, language)
    ? settle(read, ask({ start: nameNode.startIndex, end: nameNode.startIndex + nameNode.text.length }))
    : read;
  return { ...shape, implementable: implementable(node, language, shape.type) };
}

/**
 * A container is a declaration with a `body` field and none of `parameters`,
 * `value`, `right` or `type`: a struct, a class, an interface, an enum, a
 * trait, a module.
 */
function isContainer(node: Node): boolean {
  return has(node, "name") && has(node, "body")
    && !has(node, "parameters") && !has(node, "value") && !has(node, "right") && !has(node, "type");
}

type Shape = Record<Exclude<Part, "implementable">, PartReading>;

function readShape(node: Node, language: Language): Shape {
  if (has(node, "parameters")) {
    return {
      body: has(node, "body") ? "has" : "lacks",
      signature: "has",
      result: "has",
      fields: "lacks",
      bases: "lacks",
      type: "lacks",
      callable: "has",
    };
  }
  if (isContainer(node)) {
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
      /*
       * Not "lacks": calling a class is how Python makes one of it, and a Rust
       * tuple struct is called to construct one. `@calls` into a type is a
       * board to read, not one to accuse.
       */
      callable: "unsure",
    };
  }
  const value = node.childForFieldName("value") ?? node.childForFieldName("right");
  if (aliasesAType(node)) return { ...UNSURE };
  if (value && isLiteral(value)) {
    return {
      body: "lacks", signature: "lacks", result: "unsure", fields: "unsure", bases: "unsure",
      type: "lacks", callable: "lacks",
    };
  }
  /*
   * A name with a type written beside it (#337): a struct field, an annotated
   * assignment, a property in an interface. The `type` field is what every
   * grammar here puts that on, and two facts follow from it however the type
   * is spelled.
   *
   * **It is a value, and a value is not a type.** `status: QueryStatus` names
   * one thing of that type; it is not the type, and `@builds` or `@holds`
   * pointed at it can never be true. The one exception is Python's annotated
   * alias, `Handler: TypeAlias = ...`, which is what `aliasesByAnnotation`
   * keeps out. Rust and TypeScript write theirs with the keyword, above.
   *
   * **And whether anything can call it is what its type says**, which is the
   * one question that needs to know how each language spells a function type.
   * Where the type could be one, the name keeps every doubt it had: a field
   * holding `fn(Own<ErrorImpl>)` is called all day long.
   *
   * A value assigned something this file can see keeps the last word. A lambda
   * under a type alias -- `transformElement: NodeTransform = (node, ctx) => {}`
   * -- is callable whatever the alias resolves to, and reading the annotation
   * alone would put a red on an arrow that is right.
   */
  const written = node.childForFieldName("type");
  if (written && !aliasesByAnnotation(written.text)) {
    const callable = value && isWrittenValue(value) ? "unsure"
      : couldBeCalled(written.text, language) ? "unsure" : "lacks";
    return {
      body: callable, signature: callable, result: "unsure", fields: "unsure", bases: "unsure",
      type: "lacks", callable,
    };
  }
  /*
   * No type written, and a value this file can read the shape of: a thing
   * constructed, or a function written out. Neither is a type -- `x = new
   * Set()` names a set and `run = (dep) => {}` names a function, and nothing
   * in these languages lets either stand where a type name does.
   */
  if (value && isConstruction(value)) {
    return {
      body: "unsure", signature: "unsure", result: "unsure", fields: "unsure", bases: "unsure",
      type: "lacks", callable: "lacks",
    };
  }
  if (value && isWrittenValue(value)) {
    return { ...UNSURE, type: "lacks" };
  }
  return { ...UNSURE };
}

const UNSURE: Record<Part, PartReading> = {
  body: "unsure", signature: "unsure", result: "unsure", fields: "unsure", bases: "unsure",
  type: "unsure", callable: "unsure", implementable: "unsure",
};

/**
 * What one name in one file has, by every declaration of it there.
 *
 * `undefined` when the file declares no such name or has no grammar: a missing
 * name is the node check's business, not a part this name lacks.
 *
 * `ask` is a compiler, where the caller holds one (#343). It is asked about a
 * value only, only where the text left a doubt, and one question per
 * declaration; without it, or where it cannot say, this reads exactly as the
 * text does.
 */
export function partsOf(
  source: string,
  name: string,
  language: Language,
  ask?: AskKind,
): Record<Part, PartReading> | undefined {
  const declarations = declaredShapes(source, language)?.get(name);
  if (!declarations || declarations.length === 0) return undefined;
  const readings = declarations.map(({ node, nameNode, soup }) =>
    (soup ? UNSURE : readDeclaration(node, nameNode, language, ask)));
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
 * 2,733 JS. **Zero wrong lacks in every square but one** -- 42,222 agreed
 * field-lacks in Python, 14,414 agreed "not a type" in Rust, and so on through
 * docs/claim-vocabulary.md's table. The one is Rust's `body`, below.
 *
 * That is not the usual outcome in this codebase and is worth being suspicious
 * of, so the measurement was broken on purpose twice to check it can fail:
 * made to say a struct lacks fields, the run refuses all five languages; made
 * to say a function lacks a signature, it reports 926 wrong lacks in Python
 * and 208 in Rust.
 *
 * `callable` and `type` are the two squares this widened, and both were
 * measured the same way after each widening. A value written out in full
 * (#307) and a value with its type written beside it (#337) are 0 wrong lacks
 * across every language, and the second is most of what is now said: `type`
 * went from 5,276 agreed lacks in Python to 52,012, and `callable` from 874 in
 * Rust to 3,430. The referee cannot parse everything it is handed -- **190
 * Python, 12 TypeScript, 2 Rust and 1 TSX** lacks went unjudged, 0.2% of what
 * the reader claimed. Those were sampled and read: a value spread over lines,
 * a comprehension's own binding, a name a server lists at another line. Not
 * one was a reader mistake, and the squares are licensed on that basis rather
 * than on a clean sweep.
 *
 * The corpus found the one shape a rule about written types gets wrong, and it
 * found it rather than review doing so: a function type can be spelled with no
 * word in it that is not a keyword -- `destroy: () => void` -- and a reading
 * that counts words alone calls that field a plain value. `couldBeCalled`
 * refuses any type with an arrow or a bracket in it for that reason.
 *
 * `implementable` (#345) is `type` in every language but Rust, number for
 * number. In Rust it reads the keyword, and rust-analyzer agreed on all 16,941
 * lacks with 0 wrong and 0 unjudged.
 *
 * **The compiler's answers (#343)** were measured with `measure:parts
 * --compiler` over the ten TypeScript and Python repositories, refereed by
 * writing the call and asking a checker whether it compiles -- the TypeScript
 * compiler's own call resolution, mypy, and pyright's command line where mypy
 * reads `Any`. 0 wrong lacks in every square. `callable` went from 7,613
 * agreed to 18,502 in Python, 8,014 to 25,071 in TS and 1,709 to 4,878 in TSX;
 * 173 of the compiler's lacks went unjudged -- index-signature keys, members
 * of declaration files, bindings in `@no_type_check` code -- and every one was
 * read: all plain values. Rust asks no compiler and its squares did not move.
 *
 * A square goes `false` the moment a run finds one wrong lack in that
 * language. The claim's reader is unaffected either way: losing this costs the
 * accusation and nothing else, exactly as `licence.ts` has it.
 */
export const PART_LICENCE: Record<Language, Record<Part, boolean>> = {
  ts: {
    body: true, signature: true, result: true, fields: true, bases: true, type: true, callable: true,
    implementable: true,
  },
  tsx: {
    body: true, signature: true, result: true, fields: true, bases: true, type: true, callable: true,
    implementable: true,
  },
  js: {
    body: true, signature: true, result: true, fields: true, bases: true, type: true, callable: true,
    implementable: true,
  },
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
  rust: {
    body: false, signature: true, result: true, fields: true, bases: true, type: true, callable: true,
    implementable: true,
  },
  python: {
    body: true, signature: true, result: true, fields: true, bases: true, type: true, callable: true,
    implementable: true,
  },
};

/** One end of an arrow, as the check has it. */
export interface PartEnd {
  source: string;
  language: Language | undefined;
  symbols: string[];
  /** A compiler for this end's file, where the check holds one (#343). */
  ask?: AskKind;
}

/** The parts a compiler's answer can settle; `settle` names the same five. */
const SETTLED_BY_A_COMPILER: ReadonlySet<Part> = new Set(["body", "signature", "callable", "type", "implementable"]);

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
    const ask = SETTLED_BY_A_COMPILER.has(part) ? side.ask : undefined;
    const lacks = side.symbols.every(
      (name) => partsOf(side.source, name, side.language!, ask)?.[part] === "lacks",
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
 * keyword (`fn`, `def`, `function` are not nouns), a container that writes
 * none, like an enum variant, is "a type", and a value that writes none is "a
 * value".
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
  /*
   * No word before the name: an enum variant, which is a type, or a value --
   * a field, a Python local, `ctx = make_context()` -- which is not, and a
   * sentence saying "a type is a plain value" helps nobody fix the arrow.
   */
  if (!keyword) return isValue(node, language) ? "a value" : "a type";
  return `${/^[aeiou]/.test(keyword) ? "an" : "a"} ${keyword}`;
}
