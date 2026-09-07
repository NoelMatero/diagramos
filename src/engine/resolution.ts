/**
 * What a receiver's type can be worked out to be from the text alone. (#227)
 *
 * A measurement's reader, not a claim's. #221 found the wall: 15.1% of bodies
 * that call anything have a call set `@calls` could enumerate completely, and
 * `receiver` -- `x.foo()`, where the text never says what `x` is -- is the sole
 * blocker in 28.8% of the rest, more than every other reason combined. Placing
 * `x.foo()` at all means knowing the type of `x`, and nothing in this engine
 * asked that question until now. Nothing here ships a word: no caller may use a
 * `resolved` verdict to accuse anything, and `drift.ts` imports nothing from
 * this file. That is #227's whole premise -- measure first, and let the number
 * decide whether a real type checker (tier 2) is a nice-to-have or a hard
 * requirement, before building on syntax alone.
 *
 * ## Evidence, not convention -- the gate `dataflow.ts` set for #210
 *
 * `const v = []` says v is a list in the grammar; `const v = load()` says
 * nothing, and treating `v.push(x)` as a list write there would be reading a
 * naming convention as a fact. Every shape below is held to the same test: is
 * the type *written down*, in a form nothing else could parse as, at the one
 * place the reader is allowed to look?
 *
 *   construction        `new Foo()`            cannot be anything else
 *   rust constructor     `Foo::new()`            the same shape, spelled Rust's way
 *   struct literal        `Foo { a: 1 }`          the same shape again, Rust's other one
 *   annotated parameter  `f(c: Config)`          declared in the signature
 *   annotated local       `x: Foo = load()`       declared, even though the call is opaque
 *   declared field         `self.cache: T`         declared on the class or struct
 *   collection literal    `const v = []`          already gated by `dataflow.ts`
 *
 * `Foo::new()` is trusted and `Foo::from(x)` is not, on purpose. `new()` is the
 * one associated-function name idiomatic enough that #227 accepts it as
 * evidence; nothing else in Rust's naming is -- `Path::new` famously does not
 * return `Path`. That is exactly what the referee in `scripts/lib/resolution-ts.ts`
 * and `scripts/lib/resolution-python.ts` exists to catch if this trust turns out
 * to be misplaced; a `WRONG` count above zero on that shape is the number that
 * says so, not a re-reading of this comment.
 *
 * ## What "resolved" does not mean
 *
 * A generic type parameter is not a type -- `function f<T>(x: T)` gives `x`'s
 * receiver no more evidence than no annotation would, so it withholds rather
 * than reporting the placeholder as if it were a real name. A name bound more
 * than once in a routine withholds too: which binding governs a given use is a
 * control-flow question, and this reader does not do control flow, only a
 * linear read of the text -- the same restraint `dataflow.ts` describes for
 * itself.
 *
 * ## Why every refusal has its own word
 *
 * The same argument `holds.ts` and `calls.ts` make: a resolver that guesses is
 * worse than one that shrugs, because whatever gets built on this inherits
 * every one of its mistakes. `from-a-call` and `no-annotation` are kept apart
 * on purpose even though both refuse -- the first is `x = load()`, which #221
 * already measured as the largest single population; a fix that only ever
 * needs to explain "the call was opaque" cannot be aimed at the other shapes
 * hiding under `no-annotation`.
 */
import { COLLECTION_LITERAL, COLLECTION_MAKERS } from "./dataflow";
import { each, parseSource, type Language, type Node } from "./parse";

/** The shapes carrying enough evidence in the text to name a type. */
export type ResolutionShape =
  | "construction"
  | "rust-constructor"
  | "struct-literal"
  | "annotated-parameter"
  | "annotated-local"
  | "declared-field"
  | "collection-literal";

/**
 * Why the resolver would not name a type. Every branch below is a reason to
 * stay quiet, and the caller reports the receiver exactly as it would have
 * been before anybody asked.
 */
export type ResolutionWithheld =
  /** No grammar for this language, or the file would not parse at all. */
  | "unreadable"
  /** The receiver is not a simple name and not a `self.field`/`this.field` either --
   *  `make().run()`, `a[0].run()`, `(a + b).run()`. Nothing to look up. */
  | "not-a-name"
  /** The name is not declared anywhere this reader looked: not a parameter,
   *  not a local binding, not an import, not a field of the enclosing type. */
  | "unbound"
  /** The name is bound by an import, not a local declaration. Its type may be
   *  knowable from the far file, but that is cross-file work #227 explicitly
   *  keeps out of scope for this reader. */
  | "imported-type"
  /** Bound more than once in this routine. Which binding governs this use is a
   *  control-flow question this linear reader refuses to guess at. */
  | "reassigned"
  /** The nearest binding's value is a call and nothing else says what it is:
   *  `const x = load()`. #221's largest single population, kept apart from
   *  `no-annotation` so a fix has one shape to aim at. */
  | "from-a-call"
  /** A binding exists and carries none of the shapes above -- not a
   *  construction, not a collection literal, not annotated, not from a bare
   *  call either (`x = a + b`, `x = other`, a destructured pattern). */
  | "no-annotation"
  /** The resolved head name is itself one of the enclosing routine's own type
   *  parameters -- `function f<T>(x: T)`. A placeholder, not a type. */
  | "generic-parameter"
  /** A `self.field`/`this.field` receiver whose field is not declared on the
   *  enclosing type, or whose enclosing type this reader could not find. */
  | "no-fields"
  /** The type is written as a string -- Python's forward reference. The name is
   *  in there, but not as an identifier the reader can see. */
  | "quoted"
  /** The annotation names more than one type at its outermost level --
   *  `string | undefined`, `Optional[Config]`. Both are true; picking one
   *  arbitrarily is exactly the guess this reader refuses to make. */
  | "union-type"
  /** The annotation looks another type's field up by name --
   *  `RustLayout["adopted"]`. It does not name the outer type; it names
   *  whatever that field is typed as, which is a different declaration this
   *  reader does not chase. */
  | "indexed-type";

export interface ResolutionEvidence {
  /** The head type name -- the outermost name in the annotation or constructor. */
  type: string;
  shape: ResolutionShape;
  /** 1-based, where the evidence was written, not where the receiver was used. */
  line: number;
}

export type ResolutionVerdict =
  | { verdict: "resolved"; evidence: ResolutionEvidence }
  | { verdict: "withheld"; why: ResolutionWithheld };

/** One `x.foo()` or `self.field.foo()` found in a routine body. */
export interface ReceiverSite {
  /** The bare name (`x`) or the field name (`cache`), whichever was found. */
  receiver: string;
  /** `name` for `x.foo()`; `field` for `self.field.foo()` / `this.field.foo()`. */
  kind: "name" | "field";
  /** The method called on the receiver, for a report to show what was asked. */
  method: string;
  /** 1-based line the call site sits on. */
  line: number;
  /**
   * The receiver expression's own byte range, exactly as written at this call
   * site -- `x` in `x.foo()`, or the whole `self.cache` in `self.cache.foo()`.
   * Not evidence: nothing above this reads it. It exists so a referee can find
   * the exact node a real type checker would be asked about, without
   * re-deriving what this reader already found.
   */
  at: { start: number; end: number };
  verdict: ResolutionVerdict;
}

export interface RoutineResolution {
  routine: string;
  /** 1-based line the routine opens on. */
  line: number;
  sites: ReceiverSite[];
}

export type ResolutionReading =
  | { read: true; routines: RoutineResolution[] }
  | { read: false; why: "unreadable" };

/* -------------------------------------------------------------- the grammar */

/**
 * A routine, on `parse.ts`'s own invariant: a declaration with a `parameters`
 * field and a `body` field. A signature with no body -- a TS interface method,
 * a Rust trait method with no default, an `abstract` method -- has the first
 * and not the second, and `calls.ts`'s own comment on this same test explains
 * why that half cannot be skipped: counting one as a routine with zero call
 * sites reads as a body that closes trivially and inflates a count that never
 * had anything to enumerate.
 */
function isRoutineNode(node: Node): boolean {
  return node.childForFieldName("parameters") !== null && node.childForFieldName("body") !== null;
}

/** Node types that declare a type with a member list, in any grammar loaded here. */
const TYPE_DECLARATION =
  /^(struct_item|enum_item|class_declaration|abstract_class_declaration|class_definition)$/;

/** A name a reader would recognise, wherever a grammar puts a type name. */
const TYPE_NAME = /(type_identifier|primitive_type|predefined_type)$/;

/** The receivers that mean "the thing this routine is part of". Skipped: not a receiver question. */
const OWN = new Set(["self", "this"]);

/** Peel a wrapping annotation node down to the type expression it carries. */
function peelWrapper(node: Node): Node {
  let current = node;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current.type !== "type_annotation" && current.type !== "type") return current;
    let inner: Node | undefined;
    for (let index = 0; index < current.childCount; index += 1) {
      const child = current.child(index);
      if (child && child.type !== ":") inner = child;
    }
    if (!inner) return current;
    current = inner;
  }
  return current;
}

/**
 * Whether the type written here, at its outermost level, names more than one
 * alternative -- `string | undefined`, `Config | None`, `Optional[Config]`,
 * `Union[A, B]`.
 *
 * Deliberately checked only at the top, not anywhere a union could appear:
 * `Array<string | number>`'s outer name is still `Array`, one real answer, and
 * a union sitting inside a generic's own arguments does not touch it. Only
 * the type *of the receiver itself* being more than one thing is a reason to
 * withhold -- `measure:resolution`'s referee found this the hard way, on a
 * TypeScript corpus: a parameter typed `string | undefined` read as `string`
 * because the walk below takes the first branch of anything it does not
 * recognise, and pyright correctly answered with the whole union at the
 * point the parameter was actually read.
 */
function isUnionAnnotation(node: Node): boolean {
  const peeled = peelWrapper(node);
  if (peeled.type === "union_type") return true;
  if (peeled.type === "binary_operator") {
    for (let index = 0; index < peeled.childCount; index += 1) {
      const child = peeled.child(index);
      if (child && child.childCount === 0 && child.text === "|") return true;
    }
  }
  if (peeled.type === "generic_type") {
    const head = peeled.child(0);
    if (head && (head.text === "Optional" || head.text === "Union")) return true;
  }
  return false;
}

/**
 * The first type name written inside a type expression, or why there is none.
 *
 * The same walk `holds.ts`'s `typeNamesIn` does, narrowed to the first hit --
 * the outermost name is the head, and for a generic container (`Dict[str,
 * Row]`, `Map<string, Row>`) the head is the container, on the same reading
 * `holds.ts` already gives a field of that shape. A string in the type
 * position -- Python's forward reference -- is reported as `quoted` rather
 * than silently skipped over, the same trap #195 and #223 both found.
 */
function headTypeOf(
  node: Node,
): { name: string; at: number } | { quoted: true } | { union: true } | { indexed: true } | undefined {
  if (isUnionAnnotation(node)) return { union: true };
  let quoted = false;
  let indexed = false;
  let found: { name: string; at: number } | undefined;
  const visit = (child: Node): void => {
    if (found || quoted || indexed) return;
    if (child.type === "string" || child.type === "string_literal") { quoted = true; return; }
    if (TYPE_NAME.test(child.type)) {
      /*
       * The whole qualified name, not just its tail. `holds.ts`'s
       * `typeNamesIn` takes the tail as well as the full text -- appropriate
       * there, because a box on a board is labelled `Timeout`, never
       * `NodeJS.Timeout`, and either spelling is worth matching against.
       * This reader has one answer to give, and a real type checker's own
       * printed form of a qualified type is qualified: `ts.Node` stays
       * `ts.Node`, not `Node`, and there can be a real, different `Node` in
       * the same file to be confused with -- `measure:resolution`'s referee
       * found this exact ambiguity, a parameter typed `ts.Node` reported as
       * plain `Node`. Reporting the tail here was a convenience for a board,
       * not evidence about the type.
       */
      found = { name: child.text, at: child.startIndex };
      return;
    }
    /*
     * A lookup type -- `RustLayout["adopted"]` -- does not name `RustLayout`.
     * It names whatever `RustLayout`'s `adopted` field is typed as, which
     * this reader cannot see without reading a *different* declaration --
     * cross-type work #227 keeps out of scope. Reporting the outer name here
     * was flatly wrong rather than merely optimistic: `measure:resolution`'s
     * referee reported the field's real type, `Array`, where this read
     * `RustLayout` -- a type that was never the receiver's.
     */
    if (child.type === "lookup_type") { indexed = true; return; }
    /*
     * Python's own way of writing a qualified type -- `random.Random`,
     * `typing.Optional` -- is not one leaf carrying the whole dotted text the
     * way TypeScript's `nested_type_identifier` is; it is a nested `attribute`
     * node with the module and the name as separate children. A depth-first
     * walk that takes the first identifier it finds reads the *module*, and
     * `measure:resolution`'s referee caught it: 13 of 182 checked Python sites
     * were this, `random` reported where the real answer was `Random`. The
     * `attribute` field is always the real name; the `object` side is only
     * ever the path to it.
     */
    if (child.type === "attribute") {
      const attribute = child.childForFieldName("attribute");
      if (attribute && attribute.childCount === 0) {
        found = { name: attribute.text, at: attribute.startIndex };
        return;
      }
    }
    /*
     * TypeScript's postfix array shorthand -- `Foo[]` -- is one node,
     * `array_type`, wrapping the *element* type. Recursing into it the way
     * every other container is walked reads the element as the head:
     * `Foo[]` came back `Foo`, and a real type checker's own printed form of
     * an array is `Foo[]` too (see `headOf` in `resolution-ts.ts`) -- never
     * `Array<Foo>` -- so this was never going to agree with the referee.
     * `Array` is the receiver's own type; the element is what it holds.
     */
    if (child.type === "array_type") {
      found = { name: "Array", at: child.startIndex };
      return;
    }
    /*
     * TypeScript's tuple type -- `[number, number]` -- is a fixed-length
     * array at runtime, and the same trap as `array_type` in miniature: a
     * plain recursive walk reaches the first element's own type and reports
     * that instead. A fourth full-corpus run found this on a nested tuple
     * type, `[[number, number], [number, number], [number, number]]`,
     * reported as `number` -- the innermost leaf, three levels down from
     * what the receiver actually is.
     */
    if (child.type === "tuple_type") {
      found = { name: "Array", at: child.startIndex };
      return;
    }
    /*
     * An inline object type -- `mutation: { isSuccess: boolean; reset: ()
     * => void }` -- is `object_type`, the same node `holds.ts` already
     * treats as a member list rather than as a name. A plain recursive walk
     * has no member list to stop at and reaches straight into the first
     * field's own type: a fourth full-corpus run found `boolean` reported
     * for a parameter whose real type was the anonymous object itself, the
     * same shape a checker prints as `{ isSuccess: boolean; ... }` and this
     * file's own `headOfTs` already reads as `Object`.
     */
    if (child.type === "object_type") {
      found = { name: "Object", at: child.startIndex };
      return;
    }
    /*
     * `readonly Foo[]` -- a `readonly_type` wrapping the `array_type`, and a
     * distinct spelling from `ReadonlyArray<Foo>` for the same real type. The
     * compiler prints both the same way (`readonly Foo[]`), so this has to
     * name it `ReadonlyArray`, not fall through to the plain-`Array` case
     * above -- the first full-corpus run reported `Array` here and the
     * referee correctly called it wrong, every readonly array parameter in
     * the tree.
     */
    if (child.type === "readonly_type") {
      const inner = child.child(child.childCount - 1);
      if (inner && inner.type === "array_type") {
        found = { name: "ReadonlyArray", at: child.startIndex };
        return;
      }
    }
    if (child.childCount === 0) {
      if (child.type === "identifier") found = { name: child.text, at: child.startIndex };
      return;
    }
    for (let index = 0; index < child.childCount; index += 1) {
      const grandchild = child.child(index);
      if (grandchild) visit(grandchild);
    }
  };
  visit(node);
  if (found) return found;
  if (quoted) return { quoted: true };
  if (indexed) return { indexed: true };
  return undefined;
}

/** 1-based line of a byte offset, counted the way an editor counts. */
function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

/** The callee expression of a call, whatever shape it has. */
function calleeOf(node: Node): Node | undefined {
  return node.childForFieldName("function") ?? node.childForFieldName("macro") ?? undefined;
}
const isCall = (node: Node): boolean => calleeOf(node) !== undefined;

/**
 * Whether an expression constructs a named type with nothing else it could be.
 *
 * `new Foo()` in TypeScript/JavaScript, `Foo::new()` in Rust -- deliberately
 * narrowed to that one associated function name, not every `Type::whatever()`;
 * see the module doc for why. A Rust struct literal `Foo { .. }` is folded in
 * here too: same evidence, the third spelling of it.
 */
function constructionOf(
  node: Node,
  language: Language,
): { name: string; shape: ResolutionShape; at: number } | undefined {
  if (node.type === "new_expression" || node.type === "new_instance") {
    const made = node.childForFieldName("constructor");
    if (made && made.childCount === 0) return { name: made.text, shape: "construction", at: made.startIndex };
    return undefined;
  }
  if (language === "rust" && node.type === "struct_expression") {
    const name = node.childForFieldName("name");
    if (name && name.childCount === 0) return { name: name.text, shape: "struct-literal", at: name.startIndex };
    return undefined;
  }
  if (language === "rust" && isCall(node)) {
    const callee = calleeOf(node)!;
    if (callee.type !== "scoped_identifier") return undefined;
    const path = callee.childForFieldName("path");
    const tail = callee.childForFieldName("name");
    if (!path || !tail || path.childCount !== 0 || tail.text !== "new") return undefined;
    return { name: path.text, shape: "rust-constructor", at: path.startIndex };
  }
  return undefined;
}

/** The label a literal's own node type stands for -- the same set `dataflow.ts` gates on. */
/*
 * The node types on the Python side (`dictionary`, `list`, `set`) are read as
 * lowercase, matching Python's own builtin names and what pyright's referee
 * reports -- `measure:resolution`'s first real run disagreed with the referee
 * on nearly every collection literal in a Python corpus before this was
 * fixed, and every one of them was this: a capitalisation choice, not a wrong
 * type. TypeScript's constructor names are capitalised because that is what
 * they actually are.
 */
const LITERAL_NAME: Record<string, string> = {
  array: "Array", array_expression: "Array", object: "Object",
  dictionary: "dict", list: "list", set: "set",
};

/**
 * Whether an expression makes an empty collection, with the type in the text.
 *
 * `new X()` is deliberately not read here: `constructionOf` already reads
 * every `new_expression` first, `Map` included, and reports it as a
 * construction -- accurate on its own terms, and trying to read it twice would
 * only disagree with itself about which shape to report.
 */
function collectionHeadOf(node: Node): { name: string; at: number } | undefined {
  const label = LITERAL_NAME[node.type];
  if (label) return { name: label, at: node.startIndex };
  if (!isCall(node)) return undefined;
  const callee = calleeOf(node)!;

  /*
   * A bare name -- `dict()`, `list()`, `vec![..]` -- names nothing but
   * itself, so trusting it is exactly the shape `dataflow.ts` already trusts.
   */
  if (callee.childCount === 0) {
    const head = callee.text.replace(/!$/, "");
    return COLLECTION_MAKERS.has(head) ? { name: head, at: callee.startIndex } : undefined;
  }

  /*
   * Rust's scoped path -- `HashMap::from(..)` -- and only that shape.
   * Splitting the callee's own *text* on `.` as well as `::`, the way
   * `dataflow.ts`'s `makesCollection` does for its narrower question, reads a
   * plain method call the same way: `list.child(index)` is `list.child`
   * split at the dot, and `list` is a Python builtin name that also happens
   * to be a common parameter name for a `Node`. `measure:resolution`'s
   * referee caught it -- every method call on a variable named `list`,
   * `dict` or `set` in this corpus was misread as constructing a fresh one.
   * `.` is a receiver in every one of these grammars; `::` never is, which
   * is what makes the scoped-path case safe to trust and the member-access
   * case never safe to.
   */
  if (callee.type === "scoped_identifier") {
    const path = callee.childForFieldName("path");
    if (path && path.childCount === 0 && COLLECTION_MAKERS.has(path.text)) {
      return { name: path.text, at: path.startIndex };
    }
  }
  return undefined;
}

/** What one local binding's value gives evidence of, or why it does not. */
type Classified =
  | { kind: "resolved"; shape: ResolutionShape; name: string; at: number }
  | { kind: "quoted" }
  | { kind: "union" }
  | { kind: "indexed" }
  | { kind: "call" }
  | { kind: "none" };

function classify(typeAnn: Node | null, value: Node | null, language: Language): Classified {
  if (typeAnn) {
    const head = headTypeOf(typeAnn);
    if (head && "quoted" in head) return { kind: "quoted" };
    if (head && "union" in head) return { kind: "union" };
    if (head && "indexed" in head) return { kind: "indexed" };
    if (head) return { kind: "resolved", shape: "annotated-local", name: head.name, at: head.at };
  }
  if (value) {
    const built = constructionOf(value, language);
    if (built) return { kind: "resolved", shape: built.shape, name: built.name, at: built.at };
    const collection = collectionHeadOf(value);
    if (collection) return { kind: "resolved", shape: "collection-literal", name: collection.name, at: collection.at };
    if (isCall(value)) return { kind: "call" };
  }
  return { kind: "none" };
}

/* --------------------------------------------------------------- bindings */

/** One local binding of a name, as the text writes it. */
interface Binding {
  at: number;
  classified: Classified;
}

/**
 * A name bound to a value, wherever this grammar spells a local declaration
 * or a plain reassignment.
 *
 * TypeScript/JavaScript: `variable_declarator`, inside `let`/`const`/`var`.
 * Rust: `let_declaration`. Python: `assignment` -- its *only* binding form,
 * which is why a second one is a rebind and not a shadow, the same fact
 * `dataflow.ts`'s `DECLARES` comment relies on. Reassignment in TS/JS is a
 * plain `assignment_expression`, read here as a second binding of the same
 * name rather than folded into the first -- that is what lets `reassigned` be
 * detected at all.
 */
function bindingOf(node: Node): { name: string; typeAnn: Node | null; value: Node | null } | undefined {
  if (node.type === "variable_declarator") {
    const name = node.childForFieldName("name");
    if (!name || name.childCount !== 0 || name.type !== "identifier") return undefined;
    return { name: name.text, typeAnn: node.childForFieldName("type"), value: node.childForFieldName("value") };
  }
  if (node.type === "let_declaration") {
    const name = node.childForFieldName("pattern");
    if (!name || name.childCount !== 0) return undefined;
    return { name: name.text, typeAnn: node.childForFieldName("type"), value: node.childForFieldName("value") };
  }
  if (node.type === "assignment") {
    const left = node.childForFieldName("left");
    if (!left || left.childCount !== 0 || left.type !== "identifier") return undefined;
    return { name: left.text, typeAnn: node.childForFieldName("type"), value: node.childForFieldName("right") };
  }
  if (node.type === "assignment_expression") {
    const left = node.childForFieldName("left");
    if (!left || left.childCount !== 0 || left.type !== "identifier") return undefined;
    return { name: left.text, typeAnn: null, value: node.childForFieldName("right") };
  }
  return undefined;
}

/* --------------------------------------------------------------- imports */

/**
 * Every name an import statement binds in local scope, anywhere in the file.
 *
 * Not the file it resolves to -- `deps-python.ts` and `deps.ts` already answer
 * that, and cross-file resolution is explicitly out of scope for #227. Only
 * the local *name*, so a receiver bound to one can be told apart from a
 * receiver this reader never saw declared at all (`unbound`).
 */
function importedNamesIn(tree: Node, language: Language): Set<string> {
  const names = new Set<string>();

  if (language === "python") {
    each(tree, (node) => {
      if (node.type === "import_statement") {
        // `import a.b.c` binds `a`; `import a.b.c as x` binds `x`.
        for (let index = 0; index < node.childCount; index += 1) {
          const child = node.child(index);
          if (!child) continue;
          if (child.type === "dotted_name") {
            const first = child.child(0);
            if (first && first.childCount === 0) names.add(first.text);
          } else if (child.type === "aliased_import") {
            const alias = child.childForFieldName("alias");
            if (alias && alias.childCount === 0) names.add(alias.text);
          }
        }
        return;
      }
      if (node.type === "import_from_statement") {
        // The module clause -- `from a.b` -- comes before the `import`
        // keyword and binds nothing; only what follows `import` does.
        let sawImport = false;
        for (let index = 0; index < node.childCount; index += 1) {
          const child = node.child(index);
          if (!child) continue;
          if (child.type === "import") { sawImport = true; continue; }
          if (!sawImport) continue;
          if (child.type === "dotted_name") {
            // `from a import name` -- a single-segment path, but read the last
            // segment rather than assume one: the grammar allows the same node
            // wherever a name goes, and reading the tail is always right.
            const last = child.child(child.childCount - 1);
            if (last && last.childCount === 0) names.add(last.text);
          } else if (child.type === "aliased_import") {
            const alias = child.childForFieldName("alias");
            if (alias && alias.childCount === 0) names.add(alias.text);
          }
        }
      }
    });
    return names;
  }

  if (language === "rust") {
    /**
     * Covers the two common shapes fully: a plain or aliased path
     * (`use a::b;`, `use a::b as c;`) and one flat brace list
     * (`use a::{b, c};`). A brace list nested inside another
     * (`use a::{b::{c, d}, e};`) is a known gap -- rare enough in real Rust
     * that it was not worth the walk, and this reader would rather miss an
     * import binding than guess at one.
     */
    each(tree, (node) => {
      if (node.type !== "use_declaration") return;
      const argument = node.childForFieldName("argument");
      if (!argument) return;
      if (argument.type === "use_as_clause") {
        const alias = argument.childForFieldName("alias");
        if (alias && alias.childCount === 0) names.add(alias.text);
        return;
      }
      if (argument.type === "scoped_use_list") {
        let list: Node | undefined;
        for (let index = 0; index < argument.childCount; index += 1) {
          const child = argument.child(index);
          if (child?.type === "use_list") list = child;
        }
        if (list) {
          for (let index = 0; index < list.childCount; index += 1) {
            const item = list.child(index);
            if (!item) continue;
            if (item.type === "identifier" && item.childCount === 0) names.add(item.text);
            else if (item.type === "use_as_clause") {
              const alias = item.childForFieldName("alias");
              if (alias && alias.childCount === 0) names.add(alias.text);
            }
          }
        }
        return;
      }
      if (argument.type === "scoped_identifier") {
        const tail = argument.childForFieldName("name");
        if (tail && tail.childCount === 0) names.add(tail.text);
        return;
      }
      if (argument.childCount === 0) names.add(argument.text);
    });
    return names;
  }

  // TypeScript, TSX, JavaScript.
  each(tree, (node) => {
    if (node.type !== "import_statement") return;
    each(node, (leaf) => {
      if (leaf.type === "import_specifier") {
        const alias = leaf.childForFieldName("alias");
        const name = alias ?? leaf.childForFieldName("name");
        if (name && name.childCount === 0) names.add(name.text);
      } else if (leaf.type === "namespace_import") {
        const name = leaf.child(leaf.childCount - 1);
        if (name && name.childCount === 0) names.add(name.text);
      }
    });
    const clause = node.childForFieldName("import") ?? node.child(1);
    // A bare default import: `import Foo from './foo'` -- the clause's own
    // first child is the bound identifier, not wrapped in a specifier node.
    if (clause && clause.type === "import_clause") {
      const first = clause.child(0);
      if (first && first.type === "identifier" && first.childCount === 0) names.add(first.text);
    }
  });
  return names;
}

/* --------------------------------------------------------- type parameters */

/** Names this routine's own `<T>` declares -- placeholders, not real types. */
function genericParamsOf(routine: Node): Set<string> {
  const names = new Set<string>();
  const list = routine.childForFieldName("type_parameters");
  if (!list) return names;
  for (let index = 0; index < list.childCount; index += 1) {
    const child = list.child(index);
    if (!child || child.type !== "type_parameter") continue;
    each(child, (leaf) => {
      if (leaf.childCount === 0 && TYPE_NAME.test(leaf.type)) names.add(leaf.text);
    });
  }
  return names;
}

/* ------------------------------------------------------------ containers */

/** One type's own field list, name to head type -- read once per container. */
function fieldsOf(container: Node, language: Language, source: string): Map<string, Classified> {
  const fields = new Map<string, Classified>();
  const record = (name: string, typeAnn: Node | null): void => {
    if (fields.has(name)) return; // first declaration wins; see module doc.
    if (!typeAnn) return;
    const head = headTypeOf(typeAnn);
    if (head && "quoted" in head) fields.set(name, { kind: "quoted" });
    else if (head && "union" in head) fields.set(name, { kind: "union" });
    else if (head && "indexed" in head) fields.set(name, { kind: "indexed" });
    else if (head) fields.set(name, { kind: "resolved", shape: "declared-field", name: head.name, at: head.at });
  };

  if (language === "python") {
    // Every `self.name: Type` assignment anywhere in the class, `__init__` included.
    each(container, (node) => {
      if (node.type !== "assignment") return;
      const left = node.childForFieldName("left");
      const typeAnn = node.childForFieldName("type");
      if (!left || left.type !== "attribute" || !typeAnn) return;
      const object = left.childForFieldName("object");
      const attribute = left.childForFieldName("attribute");
      if (!object || object.text !== "self" || !attribute || attribute.childCount !== 0) return;
      record(attribute.text, typeAnn);
    });
    return fields;
  }

  const body = container.childForFieldName("body");
  if (!body) return fields;
  for (let index = 0; index < body.childCount; index += 1) {
    const member = body.child(index);
    if (!member) continue;
    if (member.type === "field_declaration") {
      const name = member.childForFieldName("name");
      if (name && name.childCount === 0) record(name.text, member.childForFieldName("type"));
    } else if (member.type === "public_field_definition" || member.type === "property_signature") {
      const name = member.childForFieldName("name") ?? member.childForFieldName("property");
      if (name && name.childCount === 0) record(name.text, member.childForFieldName("type"));
    }
  }
  return fields;
}

/** Every declaration of a named type anywhere in the tree -- Rust's `impl` looks here. */
function declarationNamed(tree: Node, name: string): Node | undefined {
  let found: Node | undefined;
  each(tree, (node) => {
    if (found || !TYPE_DECLARATION.test(node.type)) return;
    const declared = node.childForFieldName("name");
    if (declared && declared.childCount === 0 && declared.text === name) found = node;
  });
  return found;
}

/* -------------------------------------------------------------- receivers */

/**
 * Object and member of a member-access node, in any of the four grammars.
 *
 * The same field order `calls.ts`'s `calleeOfNode` reads, minus `path`: a
 * Rust `scoped_identifier` (`Type::method`, `module::function`) is excluded
 * on purpose, one level up in `receiverOf` -- it is a namespaced call, not a
 * question about a value's type, and folding it in here would answer a
 * question #227 does not ask.
 */
function accessOf(node: Node): { object: Node; member: Node } | undefined {
  const object = node.childForFieldName("object")
    ?? node.childForFieldName("value")
    ?? node.child(0);
  const member = node.childForFieldName("property")
    ?? node.childForFieldName("attribute")
    ?? node.childForFieldName("field")
    ?? node.childForFieldName("name");
  if (!object || !member || member.childCount !== 0) return undefined;
  return { object, member };
}

/**
 * The receiver of one call site, or `undefined` when it is not a receiver
 * question at all -- a bare name (`foo()`), a call on `self`/`this` directly
 * (`self.foo()`, a member of the routine's own type rather than a value), or
 * a Rust static/associated call (`Type::method()`, `module::function()`).
 */
function receiverOf(
  callee: Node,
): { kind: "name" | "field"; receiver: string; method: string; node: Node } | undefined {
  if (callee.childCount === 0) return undefined;
  if (callee.type === "scoped_identifier") return undefined;
  const outer = accessOf(callee);
  if (!outer) return undefined;
  const { object, method } = { object: outer.object, method: outer.member.text };

  if (object.childCount === 0) {
    if (OWN.has(object.text)) return undefined;
    return { kind: "name", receiver: object.text, method, node: object };
  }
  if (object.type === "scoped_identifier") return undefined;

  const inner = accessOf(object);
  if (inner && inner.object.childCount === 0 && OWN.has(inner.object.text) && inner.member.childCount === 0) {
    return { kind: "field", receiver: inner.member.text, method, node: object };
  }
  // A more complex receiver -- `make().run()`, `a[0].run()`, `(a + b).run()`.
  // Still counted, so the denominator in a report is every `x.foo()` there is,
  // not only the ones this reader could have resolved.
  return { kind: "name", receiver: "", method, node: object };
}

/* --------------------------------------------------------------- verdicts */

function verdictFrom(classified: Classified, generics: Set<string>, source: string): ResolutionVerdict {
  if (classified.kind === "resolved") {
    if (generics.has(classified.name)) return { verdict: "withheld", why: "generic-parameter" };
    return {
      verdict: "resolved",
      evidence: { type: classified.name, shape: classified.shape, line: lineOf(source, classified.at) },
    };
  }
  if (classified.kind === "quoted") return { verdict: "withheld", why: "quoted" };
  if (classified.kind === "union") return { verdict: "withheld", why: "union-type" };
  if (classified.kind === "indexed") return { verdict: "withheld", why: "indexed-type" };
  if (classified.kind === "call") return { verdict: "withheld", why: "from-a-call" };
  return { verdict: "withheld", why: "no-annotation" };
}

interface Scope {
  params: Map<string, Classified>;
  bindings: Map<string, Binding[]>;
  fields: Map<string, Classified>;
  generics: Set<string>;
  imported: Set<string>;
}

function resolveReceiver(
  site: { kind: "name" | "field"; receiver: string },
  scope: Scope,
  source: string,
): ResolutionVerdict {
  if (site.kind === "field") {
    const field = scope.fields.get(site.receiver);
    if (!field) return { verdict: "withheld", why: "no-fields" };
    return verdictFrom(field, scope.generics, source);
  }
  if (site.receiver === "") return { verdict: "withheld", why: "not-a-name" };

  const param = scope.params.get(site.receiver);
  if (param) return verdictFrom(param, scope.generics, source);

  const bindings = scope.bindings.get(site.receiver);
  if (bindings && bindings.length > 0) {
    if (bindings.length > 1) return { verdict: "withheld", why: "reassigned" };
    return verdictFrom(bindings[0]!.classified, scope.generics, source);
  }

  if (scope.imported.has(site.receiver)) return { verdict: "withheld", why: "imported-type" };
  return { verdict: "withheld", why: "unbound" };
}

/* ---------------------------------------------------------------- routine */

/** The parameter list's own names and declared types, whichever grammar it is. */
function collectParams(list: Node | null, language: Language, into: Map<string, Classified>): void {
  if (!list) return;
  for (let index = 0; index < list.childCount; index += 1) {
    const param = list.child(index);
    if (!param) continue;

    if (language === "python") {
      if (param.type === "identifier" && param.childCount === 0) continue; // untyped, e.g. `self`
      if (param.type !== "typed_parameter") continue;
      const name = param.child(0);
      const typeAnn = param.childForFieldName("type");
      if (!name || name.childCount !== 0 || !typeAnn) continue;
      const head = headTypeOf(typeAnn);
      if (head && "quoted" in head) into.set(name.text, { kind: "quoted" });
      else if (head && "union" in head) into.set(name.text, { kind: "union" });
      else if (head && "indexed" in head) into.set(name.text, { kind: "indexed" });
      else if (head) into.set(name.text, { kind: "resolved", shape: "annotated-parameter", name: head.name, at: head.at });
      continue;
    }

    const pattern = param.childForFieldName("pattern") ?? param.childForFieldName("name");
    const typeAnn = param.childForFieldName("type");
    if (!pattern || pattern.childCount !== 0 || pattern.type !== "identifier" || !typeAnn) continue;
    const head = headTypeOf(typeAnn);
    if (head && "quoted" in head) into.set(pattern.text, { kind: "quoted" });
    else if (head && "union" in head) into.set(pattern.text, { kind: "union" });
    else if (head && "indexed" in head) into.set(pattern.text, { kind: "indexed" });
    else if (head) into.set(pattern.text, { kind: "resolved", shape: "annotated-parameter", name: head.name, at: head.at });
  }
}

function resolveRoutine(
  routine: Node,
  fields: Map<string, Classified>,
  tree: Node,
  source: string,
  language: Language,
  imported: Set<string>,
): RoutineResolution {
  const nameNode = routine.type === "impl_item" ? undefined : routine.childForFieldName("name");
  const routineName = nameNode && nameNode.childCount === 0 ? nameNode.text : "";
  const generics = genericParamsOf(routine);

  const params = new Map<string, Classified>();
  collectParams(routine.childForFieldName("parameters"), language, params);

  const body = routine.childForFieldName("body");
  const bindings = new Map<string, Binding[]>();
  const sites: ReceiverSite[] = [];

  if (body) {
    each(body, (node) => {
      const bound = bindingOf(node);
      if (bound) {
        const list = bindings.get(bound.name) ?? [];
        list.push({ at: node.startIndex, classified: classify(bound.typeAnn, bound.value, language) });
        bindings.set(bound.name, list);
      }

      const callee = calleeOf(node);
      if (!callee) return;
      const site = receiverOf(callee);
      if (!site) return;
      const scope: Scope = { params, bindings, fields, generics, imported };
      const verdict = resolveReceiver(site, scope, source);
      sites.push({
        receiver: site.receiver, kind: site.kind, method: site.method,
        line: lineOf(source, node.startIndex),
        at: { start: site.node.startIndex, end: site.node.startIndex + site.node.text.length },
        verdict,
      });
    });
  }

  return { routine: routineName, line: lineOf(source, routine.startIndex), sites };
}

/* ---------------------------------------------------------------- the walk */

function walk(
  node: Node,
  fields: Map<string, Classified>,
  tree: Node,
  source: string,
  language: Language,
  imported: Set<string>,
  routines: RoutineResolution[],
): void {
  if (TYPE_DECLARATION.test(node.type)) {
    const nextFields = fieldsOf(node, language, source);
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child) walk(child, nextFields, tree, source, language, imported, routines);
    }
    return;
  }
  if (language === "rust" && node.type === "impl_item") {
    const typeName = node.childForFieldName("type");
    let nextFields = new Map<string, Classified>();
    if (typeName && typeName.childCount === 0) {
      const declared = declarationNamed(tree, typeName.text);
      if (declared) nextFields = fieldsOf(declared, language, source);
    }
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child) walk(child, nextFields, tree, source, language, imported, routines);
    }
    return;
  }
  if (isRoutineNode(node)) {
    routines.push(resolveRoutine(node, fields, tree, source, language, imported));
  }
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child) walk(child, fields, tree, source, language, imported, routines);
  }
}

/**
 * Every `x.foo()` and `self.field.foo()` in a file, each resolved to a type or
 * withheld with a named reason.
 *
 * **A measurement's reader.** Nothing here is licenced, nothing here accuses --
 * see the module doc. `scripts/measure-resolution.mts` is the only caller.
 */
export function resolveReceiversIn(source: string, language: Language): ResolutionReading {
  const tree = parseSource(source, language);
  if (!tree) return { read: false, why: "unreadable" };
  const imported = importedNamesIn(tree.rootNode, language);
  const routines: RoutineResolution[] = [];
  walk(tree.rootNode, new Map(), tree.rootNode, source, language, imported, routines);
  return { read: true, routines };
}

/** A binding where a written annotation and a written construction disagree about the type. */
export interface ShapeDisagreement {
  /** 1-based, the line the binding sits on. */
  line: number;
  name: string;
  annotation: string;
  construction: string;
}

/**
 * Every binding where the annotation and the constructed value name different
 * types -- `const x: Base = new Child()`. #227's own question: both answers
 * are true, and this reader's main verdict prefers the annotation (see
 * `classify`) without ever surfacing that a choice was made. This is the
 * side channel that surfaces it, for `measure-resolution.mts` alone -- nothing
 * in the main verdict depends on it.
 */
export function shapeDisagreementsIn(source: string, language: Language): ShapeDisagreement[] {
  const tree = parseSource(source, language);
  if (!tree) return [];
  const found: ShapeDisagreement[] = [];
  each(tree.rootNode, (node) => {
    const bound = bindingOf(node);
    if (!bound || !bound.typeAnn || !bound.value) return;
    const annotationHead = headTypeOf(bound.typeAnn);
    const built = constructionOf(bound.value, language);
    if (!annotationHead || "quoted" in annotationHead || "union" in annotationHead
      || "indexed" in annotationHead || !built) return;
    if (annotationHead.name === built.name) return;
    found.push({
      line: lineOf(source, node.startIndex),
      name: bound.name,
      annotation: annotationHead.name,
      construction: built.name,
    });
  });
  return found;
}

