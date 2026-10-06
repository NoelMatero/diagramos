/**
 * Whether a routine makes one of a type.
 *
 * The gap this closes (#199): `new QueryCache()`, `RouteInfo { .. }`,
 * `<MenuContent />`. It is the only way to describe a component tree at all --
 * half the arrows on the React board in `probe-generative.mts` are one component
 * making another -- and the census nearly dropped the relation for being rare,
 * on a count that turned out to be twenty times short because JSX was not being
 * counted (#197).
 *
 * ## Why this one refutes from evidence found, and never from absence
 *
 * `holds.ts` reads a declaration, so absence there is genuine absence and it may
 * say "this type has no field of that type". A function body is not a
 * declaration. A routine that never writes `new T` can still hand you a `T` by
 * calling a factory, so "no construction of T in this body" is not evidence that
 * none happens -- which is the `feeds` argument, in full, one relation over.
 *
 * What is available is the strongest verdict this engine has, and it is the one
 * `needs.ts` was built for: finding the construction running the **other way**
 * is proof the arrow is backwards. That rests on something found rather than on
 * something missing, and a backwards arrow is the case worth catching anyway --
 * it is the entire argument for `needs` in `needs.ts`.
 *
 * So the verdicts here are `needs.ts`'s and not `holds.ts`'s, and the difference
 * that matters is that **`absent` is not a finding** and must never become one.
 *
 * ## What counts as making one, in four grammars
 *
 * Three spellings are unambiguous, and they are unambiguous in the strong
 * sense: the grammar has a node type that means exactly this and nothing else.
 *
 *     new X(..)        TypeScript, JavaScript   `new_expression`
 *     X { .. }         Rust                     `struct_expression`
 *     <X />            TypeScript with JSX      `jsx_*_element`
 *
 * Two more are constructions that a reader cannot tell from an ordinary call:
 *
 *     X::new(..)       Rust      an associated function, by convention only
 *     X(..)            Python    calling a class name *is* construction
 *
 * Rust's is still withheld rather than guessed at. Python's was too, and #309 is
 * why it no longer is.
 *
 * ## Python, and the thing that was in the file all along
 *
 * The syntax genuinely does not separate `Response(body)` from `render(body)`,
 * and guessing on capitalisation is a naming convention masquerading as
 * evidence -- wrong the first time somebody writes `Response = make_response`.
 * So for a long time this reader refused the language outright, and confirmed
 * **none** of the 12,127 true constructions #302's recall measurement found in
 * the pinned clones.
 *
 * What separates the two is not in the body. It is the line above it. The import
 * that brings `Response` into the file names the file that declares it, and that
 * file says whether it declares a class or a function -- and `calls.ts` already
 * follows exactly those imports to exactly that file, for exactly this kind of
 * question. `pythonConstructions` asks it with `placeName`, the same resolver,
 * rather than a second one that would have to agree and silently would not.
 *
 * That path **confirms and never accuses**, which is a rule and not an
 * omission: an absence is as unreadable in Python as it ever was, so the reader
 * never reaches `absent` there, and `absent` is the door `backwards` stands
 * behind. Python's `builds` accusation has no measured licence and this change
 * did not give it one.
 *
 * Python remains the whole of why this word cannot be trusted with an absence
 * even in the languages where the syntax is clear.
 */
import {
  bindingsIn, callsBetween, callSitesIn, compiledBodiesFor, EXTERNAL_RECEIVER, JSX_TAG, placeName,
  type Bindings, type CallSide, type CallsNotClosed,
} from "./calls";
import { mayAccuse } from "./licence";
import { each, parseSource, type Language, type Node } from "./parse";

/**
 * Why no verdict was reached. Every one of these is a reason to stay quiet, and
 * the caller reports the arrow exactly as it would have been reported before
 * anybody claimed anything.
 */
export type ConstructsWithheld =
  /** No grammar for this language, or the file would not parse at all. */
  | "unreadable"
  /** Nothing in that file declares that name. The node check reports that itself. */
  | "not-declared"
  /** The name is declared and it is not a routine. There is no body to read. */
  | "no-body"
  /**
   * The parse recovered from an error, so what is and is not in this body is a
   * statement about a file we only partly read.
   */
  | "incomplete"
  /**
   * The language spells construction as an ordinary call, and nothing was handed
   * in that could say which of the two this is.
   *
   * Python is the case: `Response(body)` is a construction and `render(body)` is
   * not, and nothing *in the syntax* separates them. Capitalisation is a naming
   * convention rather than evidence, and a word that accused on a convention
   * would be wrong the first time somebody wrote `Response = make_response`.
   *
   * What does separate them is the import, and since #309 a caller that can
   * offer one gets an answer instead of this. So this is now the refusal for a
   * caller holding a single file with no import table -- the reader as it was --
   * rather than a fact about the language.
   */
  | "call-shaped"
  /**
   * The body writes no call to that name at all (#309, Python).
   *
   * **Not an absence**, and it must not become one. A factory is as invisible
   * here as it is anywhere -- `make_response()` hands back a Response and writes
   * the name nowhere -- so this is "no construction found", and in Python it does
   * not even get to be `absent`, because `absent` is the door the `backwards`
   * accusation stands behind and Python has no licence to accuse.
   */
  | "not-constructed"
  /**
   * The name is written and nothing in the file binds it: a wildcard import, a
   * builtin, a global. `calls.ts`' word for the same dead end.
   */
  | "unbound"
  /** The import that binds the name resolves to no file in the tree. */
  | "unplaced"
  /** The file binds the name more than one way, and the text does not say which wins. */
  | "ambiguous"
  /** The name comes to rest in some file other than the one the arrow points at. */
  | "elsewhere"
  /**
   * The name resolves to the file the arrow points at, and that file declares it
   * as a routine rather than as a class -- so the call makes nothing.
   *
   * A refusal rather than a finding, deliberately. It is the honest answer to
   * "is this arrow confirmed" and it is not the honest basis for "this arrow is
   * wrong": the routine may still get one of that type from somewhere else in
   * the body this reader did not resolve.
   */
  | "not-a-class"
  /**
   * The body builds the constructor's name at runtime -- `new registry[kind]()`.
   *
   * The same `computed-call` doubt `deps.ts` names: the callee is a value, so
   * what gets made is not in the text.
   */
  | "computed"
  /** The declaration came out of macro soup: tokens awaiting an expansion. */
  | "macro"
  /**
   * The language has a grammar and no measured licence, so nothing has ever
   * checked how often this reader is wrong about it. Confirming is unaffected;
   * it is the accusation that needs the licence (#198).
   */
  | "unlicensed";

/** Where the construction was written, so a report can quote a file and a line. */
export interface ConstructsEvidence {
  /** The type that was made. */
  name: string;
  /** 1-based, in the file the construction was written in. */
  line: number;
  /** The construction as written, so a verdict that can refute shows what it read. */
  wrote: string;
}

export type ConstructsVerdict =
  /** The routine makes the type the arrow points at. */
  | { verdict: "confirmed"; evidence: ConstructsEvidence }
  /**
   * The construction runs the other way, and only the other way: the type's own
   * routines make the thing at the tail. The arrow is backwards.
   */
  | { verdict: "backwards"; evidence: ConstructsEvidence }
  /** Both make each other. Legal, and unanswerable. */
  | { verdict: "cycle" }
  /**
   * Neither end makes the other, as far as the text shows.
   *
   * **Not a finding, and this must stay true.** A factory is invisible here, so
   * this is "no construction found", never "no construction happens". Reported
   * exactly as an unclaimed arrow is.
   */
  /**
   * `awaitsCompiler`: a Rust routine every text rule would let say "creates
   * none", held back only because rustc's body for it was not on hand (#362).
   */
  | {
    verdict: "absent";
    awaitsCompiler?: true;
    /** Python (#362): where `@calls`' call reading stopped short of a closed body. */
    notClosed?: CallsNotClosed;
  }
  /**
   * The routine's own body creates none of the head's type, and every reason
   * it might have without writing the name was ruled out (#362).
   *
   * "A builds B" means A's body creates the B, by writing it or by calling B's
   * own constructor; a B handed back by some other function does not count
   * (#360). So this is a finding, on the absence licence, and `made` is what
   * the body creates instead -- the sentence that tells somebody where the
   * arrow should have pointed.
   */
  | { verdict: "refuted"; evidence: ConstructsRefutedEvidence }
  | { verdict: "withheld"; why: ConstructsWithheld };

/** Where the routine that creates none of it was read, and what it creates instead. */
export interface ConstructsRefutedEvidence {
  routine: string;
  /** 1-based line of the routine's first declaration. */
  line: number;
  /** Every other type the body creates, in the order written. Empty when it creates nothing. */
  made: ConstructsEvidence[];
}

/** Grammar nodes that mean construction and nothing else. */
const MAKES = new RegExp(`^(new_expression|struct_expression)$|${JSX_TAG.source}`);

/** Where each of those spells the name of the thing being made. */
function madeBy(node: Node): Node | undefined {
  return node.childForFieldName("constructor")
    ?? node.childForFieldName("type")
    ?? node.childForFieldName("name")
    ?? undefined;
}

/** A name a reader would recognise, wherever a grammar puts type names. */
const TYPE_NAME = /(type_identifier|identifier)$/;

/**
 * The names a construction expression makes.
 *
 * Read the head of the expression only, not the whole subtree: `new Foo(new
 * Bar())` makes a Foo, and `each` will reach the inner `new Bar()` on its own
 * pass. Collecting descendants here would credit Foo's constructor with making
 * a Bar.
 */
function nameOfMade(node: Node): { name: string; offset: number } | undefined {
  const made = madeBy(node);
  if (!made) return undefined;
  if (made.childCount === 0 && TYPE_NAME.test(made.type)) {
    return { name: made.text, offset: made.startIndex };
  }
  // A qualified name is one name with a namespace on the front, and a box is
  // labelled with the last part of it -- nobody writes `new NodeJS.Timeout` on a
  // canvas as `NodeJS.Timeout`.
  if (/(nested_type_identifier|scoped_type_identifier|member_expression|scoped_identifier)$/.test(made.type)) {
    const tail = made.text.split(/::|\./).pop();
    if (tail) return { name: tail, offset: made.startIndex };
  }
  return undefined;
}

/** 1-based line of a byte offset, counted the way an editor counts. */
const lineOf = (source: string, offset: number) =>
  source.slice(0, offset).split("\n").length;

/**
 * Every routine of this name in this source, as text to scan.
 *
 * `body.ts` is not used for this and the reason is a bug it would have caused.
 * `bodiesOf` hands back the *value* of a data declaration, so `const build = 3`
 * comes back with a body of `3` -- a box anchored at a constant would have been
 * scanned as though it were a routine and answered `absent`, which is a verdict
 * about a question nobody asked. And `declarationsOf` calls `const Menu = () =>
 * (<div/>)` **data**, because its `RUNS` set is statement blocks and an arrow
 * function with an expression body has none -- which would have silenced every
 * React component in the corpus, the entire population this word is for.
 *
 * So the rule comes straight from `parse.ts` instead: a routine is a declaration
 * that has `parameters`. That is one of the three facts said to hold in every
 * grammar tried, and it holds for both shapes above where the two `body.ts`
 * helpers disagree with each other.
 *
 * The whole declaration is scanned rather than just its body. A construction can
 * only appear in a signature as a parameter default, and a default is part of
 * what the routine makes.
 */
function routinesNamed(
  source: string,
  routine: string,
  language: Language,
): { routines: Node[]; declared: boolean; unreadable: boolean } {
  const tree = parseSource(source, language);
  if (!tree) return { routines: [], declared: false, unreadable: true };

  const routines: Node[] = [];
  let declared = false;
  each(tree.rootNode, (node) => {
    /*
     * Rust puts a type's routines somewhere else entirely: `impl Factory { .. }`
     * names the type on a `type` field and has no `name` at all, so a lookup by
     * name found only the bare `struct Factory;` -- no routines, refused. The
     * methods are in a separate node the struct does not contain.
     *
     * The one place in this file that knows a language apart, and it is here
     * rather than in `parse.ts` because it is not a fact about declarations in
     * general: it is where Rust keeps the methods.
     */
    const name = node.type === "impl_item"
      ? node.childForFieldName("type")
      : node.childForFieldName("name") ?? node.childForFieldName("left");
    if (!name || name.childCount !== 0 || name.text !== routine) return;
    declared = true;
    // The parameters may sit on the declaration or on the value assigned to it:
    // `function f()` has its own, `const f = () => x` has the arrow function's.
    const value = node.childForFieldName("value");
    const takesParameters = node.childForFieldName("parameters")
      ?? value?.childForFieldName("parameters");
    if (takesParameters) { routines.push(node); return; }

    /*
     * A type whose routines do the making.
     *
     * The ordinary shape on a real board: nobody draws a box for
     * `QueryClient.prototype.build`, they draw `QueryClient` and mean "this
     * thing makes Queries". So a name that is a type gets scanned through its
     * own routines rather than refused for having no body of its own -- and
     * scanning the declaration covers them, since every method is inside it.
     *
     * Guarded on there actually being a routine in there, which is what keeps
     * `const build = 3` from being scanned as a maker. Answering a question
     * about a constant is worse than declining it.
     */
    if (holdsRoutines(node)) routines.push(node);
  });
  return { routines, declared, unreadable: false };
}

/**
 * What one routine makes, and whether it can be trusted to have been read.
 *
 * Walks the node in the tree it came from rather than re-parsing its text, and
 * that is not a tidiness point: a method's text is not a valid program. Handing
 * `build() { return new Renderer(); }` back to the parser on its own produces an
 * error node, which this reader correctly refuses to answer on -- so every
 * method in the corpus came back withheld while every plain function worked, and
 * the failure looked like a rule about methods rather than a re-parse.
 */
function madeIn(
  routine: Node,
  source: string,
): { made: Map<string, ConstructsEvidence>; why?: ConstructsWithheld } {
  if (routine.hasError) return { made: new Map(), why: "incomplete" };

  const made = new Map<string, ConstructsEvidence>();
  let why: ConstructsWithheld | undefined;

  each(routine, (node) => {
    if (node.type === "token_tree") { why ??= "macro"; return; }
    if (!MAKES.test(node.type)) return;
    const hit = nameOfMade(node);
    if (!hit) {
      // `new registry[kind]()`: something is made and the text does not say
      // what. Doubt about the whole body, not about one name.
      why ??= "computed";
      return;
    }
    // A lowercase JSX name is a host element -- `div`, `span` -- not a component
    // anybody draws a box for.
    if (node.type.startsWith("jsx_") && !/^[A-Z]/.test(hit.name)) return;
    if (!made.has(hit.name)) {
      made.set(hit.name, {
        name: hit.name,
        line: lineOf(source, hit.offset),
        wrote: node.text.replace(/\s+/g, " ").slice(0, 80),
      });
    }
  });

  return { made, why };
}

/**
 * Whether every one of these types is one a body can only create by naming it
 * (#362), so that a body naming none of them has created none.
 *
 * TypeScript: a non-abstract class with at least one method or a constructor.
 * An interface, a type alias or a class of bare fields is satisfied by an
 * object literal -- `run({ x: 1 })` creates the Widget `run` asks for and
 * writes no name -- and an abstract class is only ever created as a subclass.
 * So each of those is quiet, and so is a name declared any second way in the
 * file (`class Widget` beside `interface Widget`): one reading that could be
 * made by a literal is enough doubt.
 *
 * `class_declaration` is a node name, the thing docs/reading-a-grammar.md warns
 * about, and it is tolerable here for the reason that document gives for its
 * one surviving list: this is a TypeScript-only question, both TypeScript
 * grammars spell it the same way, and every other spelling -- `interface_*`,
 * `type_alias_*`, `abstract_class_*`, a `class` expression -- fails it, which
 * is the quiet side.
 *
 * The head must be in the tail's own language family. A TypeScript routine
 * cannot create a Python class, and an arrow between them is a question this
 * reader was not asked.
 */
function onlyNewCreates(source: string, tailLanguage: Language, language: Language, names: string[]): boolean {
  if (tailLanguage === "rust" && language === "rust") return onlyStructs(source, names);
  if (!isTypeScript(tailLanguage) || !isTypeScript(language) || names.length === 0) return false;
  const tree = parseSource(source, language);
  if (!tree) return false;
  const wanted = new Set(names);
  const buildable = new Set<string>();
  let doubt = false;
  each(tree.rootNode, (node) => {
    // `<Widget />` carries the component on a `name` field too: a use, not a declaration.
    if (node.type.startsWith("jsx_") || writtenAsUse(node)) return;
    const name = node.childForFieldName("name");
    if (!name || name.childCount !== 0 || !wanted.has(name.text)) return;
    // A method or a parameter that happens to share the name is not a
    // declaration of the type, and says nothing about how it is created.
    if (node.childForFieldName("parameters")) return;
    const body = node.childForFieldName("body");
    if (node.type !== "class_declaration" || !body) { doubt = true; return; }
    let behaves = false;
    for (let at = 0; at < body.childCount; at += 1) {
      if (body.child(at)?.childForFieldName("parameters")) behaves = true;
    }
    if (behaves) {
      buildable.add(name.text);
    } else {
      doubt = true;
    }
  });
  return !doubt && names.every((name) => buildable.has(name));
}

/**
 * Whether a node that carries a `name` is a use of that name rather than a
 * declaration of it (#432): it is given type arguments (`Mutation<unknown>`
 * in a cast) or reached through a path (`ser::Serializer` in `impl
 * ser::Serializer for`, `ns.Widget`). Read by fields, which every grammar
 * here shares, rather than by node names: no declaration has either. Read as
 * a second declaration, each one made the name "declared some other way too",
 * and the reader withheld on it.
 */
function writtenAsUse(node: Node): boolean {
  return ["type_arguments", "path", "module", "scope", "object"].some((field) => node.childForFieldName(field) !== null);
}

/**
 * Rust's `onlyNewCreates`: every one of these names is declared as a struct,
 * an enum or a union, and nothing else of that name is declared -- a `type`
 * alias or a trait is quiet, because what it stands for is written elsewhere.
 * An `impl` names its type on a `type` field, not `name`, so it is not a
 * second declaration.
 */
function onlyStructs(source: string, names: string[]): boolean {
  if (names.length === 0) return false;
  const tree = parseSource(source, "rust");
  if (!tree) return false;
  const wanted = new Set(names);
  const buildable = new Set<string>();
  let doubt = false;
  each(tree.rootNode, (node) => {
    // `Widget { x }` carries the type on a `name` field too: a use, not a declaration.
    if (MAKES.test(node.type) || writtenAsUse(node)) return;
    const name = node.childForFieldName("name");
    if (!name || name.childCount !== 0 || !wanted.has(name.text)) return;
    if (node.childForFieldName("parameters")) return;
    if (/^(struct|enum|union)_item$/.test(node.type)) buildable.add(name.text);
    else doubt = true;
  });
  return !doubt && names.every((name) => buildable.has(name));
}

/**
 * Whether a macro in this file writes a routine of this name (#362).
 *
 * regex's `primitives.rs` has a plain `fn new` and a `macro_rules!` that
 * generates more of them, one of which creates a `SmallIndexIter`. The text
 * sees only the plain one, and so does the body matching in
 * `compiled-calls.ts` -- so an arrow meant for the generated `new` would be
 * answered about the other. A macro body is an unparsed token tree, so this
 * reads its text: `fn` followed by the name, anywhere inside one.
 */
function macroDeclares(source: string, routine: string): boolean {
  const tree = parseSource(source, "rust");
  if (!tree) return true;
  const written = new RegExp(`\\bfn\\s+${routine.replace(/[^\w]/g, "")}\\b`);
  let found = false;
  each(tree.rootNode, (node) => {
    if (!found && node.type === "token_tree" && written.test(node.text)) found = true;
  });
  return found;
}

/**
 * Whether rustc's own body for the routine creates none of these types (#362).
 *
 * The text cannot say what `h.first.clone()` or `x.into()` creates, and #360
 * found about 17 real functions in the Rust corpus that create a B exactly
 * that way. rustc's MIR can: every value a call hands back sits in a local
 * whose type is written, and every aggregate names its type -- through an
 * alias, a `use .. as`, or `Self`. So Rust may only say "creates none" when
 * that list agrees.
 *
 * No body is no answer: a binary target, a `cfg` on or in the routine, a body
 * that cannot be matched to exactly one declaration (`compiledBodiesFor`,
 * #357's rules).
 */
function compiledCreatesNone(routine: string, wanted: Set<string>, names: ConstructsNames | undefined): boolean {
  if (!names?.side.compiled) return false;
  const compiled = compiledBodiesFor({ ...names.side, routine }, [...wanted]);
  if (!compiled || compiled.bodies.length === 0) return false;
  /*
   * A `#[cfg]` region the build switched off is code rustc never read, and
   * one that makes a call could hand back a B without naming it --
   * `#[cfg(feature = "extra")] { return h.first.clone().x; }`. Field
   * initializers like anyhow's vtable (`object_boxed: object_boxed::<E>`)
   * call nothing, so they don't block (#396).
   */
  if (compiled.unbuilt.some((region) => names.side.source.slice(region.start, region.end).includes("("))) return false;
  return compiled.bodies.every((body) => ![...wanted].some((name) => body.made.has(name)));
}

/**
 * Whether any of these routines writes the head's name, or a name the file
 * imports it under, anywhere at all -- types included (#362).
 *
 * A body that names B may be creating one without a construction this reader
 * sees: `Widget.create()`, `Reflect.construct(Widget)`, `const C = Widget; new
 * C()`, `let w: Widget = x.into()` in Rust. And a routine that says it returns
 * one -- `(): Widget`, `Promise<Widget>` -- is a question the key itself leaves
 * undecided. Every one of those is quiet, so the rule is the plainest one that
 * covers them: any named leaf spelt as the head. It is wrong only on the quiet
 * side, when a local merely shares the word.
 *
 * Two places are not a mention (#417), because neither can make anything:
 *
 *   - the routine's own name. `class Blueprint` names Blueprint by declaring
 *     it, so an arrow from a class to itself could never be asked;
 *   - a parameter's type, when it is the type of a thing handed in:
 *     `incompatibility: Incompatibility` says what the routine is given.
 *     Not when that type is a maker -- a function or constructor type, or
 *     the language's word for a class or a callable (`MAKER_WORDS`) -- since
 *     `factory: type[Widget]` is a parameter whose call makes one.
 *
 * Everything else still counts: a return type, a variable's type, a cast,
 * `isinstance(x, Widget)`, `map(Widget, xs)`.
 *
 * `handedInCounts` keeps the parameter's type a mention, for `@calls` into a
 * class (#374), which borrows this reading. A value handed in as a Widget
 * makes no Widget, but it is how a routine runs Widget's methods with no call
 * written -- `for (const x of r)`, `[...r]`, `+m` -- and #373's probe went red
 * on both of the first two.
 */
function namesTheHead(
  routines: Node[], source: string, language: Language, wanted: Set<string>, handedInCounts = false,
  /** The head's own file, for what a value of it runs unwritten (#432). Absent, every handed-in value does. */
  head?: { source: string; language: Language },
  /** Where the routine's calls were placed, for a value handed to code outside the repository (#432). */
  placed?: CallSide,
): boolean {
  const spelt = new Set(wanted);
  let outside: Set<number> | undefined;
  const outsideCalls = () => outside ??= placedOutside(placed);
  for (const [local, binding] of bindingsIn(source, language)?.imported ?? []) {
    if (binding.name !== undefined && wanted.has(binding.name)) spelt.add(local);
  }
  const selfIsHead = language === "rust" ? selfMeansHead(source, wanted) : [];
  let named = false;
  for (const routine of routines) {
    // In Rust, `Self` inside the head's own `impl` -- or a trait's, where it is
    // whoever implements it -- is the head under another name.
    const inside = selfIsHead.some((span) => routine.startIndex >= span.start && routine.startIndex < span.end);
    const own = routine.childForFieldName("name");
    /*
     * For `@calls` into the class a handed-in value still names it when the
     * body runs one of the class's methods through it with no call written
     * (#432): `for x in r` runs `Range.__iter__`. Passed on, read from or kept,
     * it runs nothing of the class's here, and `lookupComponent(moduleRef:
     * Module)` was never asked whether it calls Module.
     */
    const handedIn = handedInTypes(routine, language)
      .filter((span) => !handedInCounts || !runsUnwritten(routine, span.name, wanted, head, outsideCalls));
    each(routine, (node) => {
      if (named || node.childCount !== 0 || !node.isNamed) return;
      if (own && node.id === own.id) return;
      if (handedIn.some((span) => node.startIndex >= span.start && node.startIndex < span.end)) return;
      if (spelt.has(node.text) || (inside && node.text === "Self")) named = true;
    });
    if (named) return true;
  }
  return false;
}

/**
 * The words each language writes for a class or a callable handed in as a
 * value: `type[W]`, `Callable[..., W]`, `typeof W`, `impl Fn() -> W`. A list,
 * for the reason `parts.ts`' `NOT_A_FUNCTION` is one: whether `F` in `f: F`
 * makes anything is not in the tree, so only the spellings that say so are
 * read. A function or constructor type needs none of it -- it has a
 * `parameters` field of its own.
 */
const MAKER_WORDS: Partial<Record<Language, RegExp>> = {
  python: /^(type|Type|Callable)$/,
  ts: /^(typeof|new)$/,
  tsx: /^(typeof|new)$/,
  js: /^(typeof|new)$/,
  rust: /^(fn|Fn|FnMut|FnOnce|impl|dyn)$/,
};

/** The spans of every parameter type under this routine that hands in a value, not a maker (#417), with the parameter's name. */
function handedInTypes(routine: Node, language: Language): Array<{ start: number; end: number; name?: string }> {
  const spans: Array<{ start: number; end: number; name?: string }> = [];
  const maker = MAKER_WORDS[language];
  each(routine, (node) => {
    const parameters = node.childForFieldName("parameters");
    if (!parameters) return;
    for (let at = 0; at < parameters.childCount; at += 1) {
      const written = parameters.child(at)?.childForFieldName("type");
      if (!written) continue;
      let makes = false;
      each(written, (inner) => {
        if (makes) return;
        if (inner.childForFieldName("parameters")) makes = true;
        else if (inner.childCount === 0 && maker?.test(inner.text)) makes = true;
      });
      if (makes) continue;
      const parameter = parameters.child(at)!;
      const named = parameter.childForFieldName("name") ?? parameter.childForFieldName("pattern") ?? parameter.child(0);
      spans.push({
        start: written.startIndex,
        end: written.startIndex + written.text.length,
        ...(named?.childCount === 0 && /identifier$/.test(named.type) ? { name: named.text } : {}),
      });
    }
  });
  return spans;
}

/**
 * The methods a language runs on a value with no call written, by how the
 * value is used (#432, #373). Python's are its dunders; TypeScript's are
 * `toString`, `valueOf`, `toJSON`, `then` and the computed `[Symbol.*]` ones.
 * `operator` is any of them: `a + b`, `a == b`, `a[k]` and `-a` each run one.
 */
const UNWRITTEN: Record<"iterate" | "format" | "hash" | "truth" | "with" | "await" | "operator", RegExp> = {
  iterate: /^(__(iter|aiter|next|getitem|len|contains)__|\[Symbol\.(asyncI|i)terator\])$/,
  format: /^(__(str|repr|format)__|toString|valueOf|toJSON|\[Symbol\.toPrimitive\])$/,
  hash: /^__(hash|eq)__$/,
  truth: /^__(bool|len)__$/,
  with: /^__(a?enter|a?exit)__$/,
  await: /^(__await__|then)$/,
  operator: /^(__(?!(init|new|init_subclass|class_getitem|set_name|post_init)__)\w+__|toString|valueOf|\[Symbol\.toPrimitive\])$/,
};
/*
 * The language's own routines whose use of an argument is known, so a value
 * handed to one runs exactly that and no more: `set.add` hashes, it does not
 * format. Any other call placed outside the repository may run anything.
 */
const ITERATES = /^(list|tuple|set|frozenset|sorted|sum|min|max|any|all|enumerate|zip|iter|next|len|dict|map|filter|reversed|Array\.from|Promise\.all)$/;
const FORMATS = /^(str|repr|format|print|String|JSON\.stringify|console\.\w+)$/;
const HASHES = /(^hash|\.(add|discard))$/;

/**
 * Whether a body runs one of the head's methods through a value handed in
 * under `name`, with no call to it written (#432): it iterates the value,
 * spreads it, formats it, hashes it, uses it with an operator, tests its
 * truth, enters it or awaits it -- and the head declares the method that
 * use runs. A class with a base may inherit one, and a Rust type runs any
 * trait it implements (`Drop` at the end of the routine alone), so both
 * count whatever the use.
 *
 * A value handed to any other code outside the repository is #412's rule:
 * a library cannot name your methods, so if it runs one it may run any.
 * `logging.info("%s", r)` runs `__str__`, `copy.deepcopy(r)` runs
 * `__deepcopy__`, and no list of library routines says which do. Whether a
 * call lands there is `outside`'s: the placements `@calls`' own closed
 * reading made, a compiler's among them. A call nobody placed has already
 * left that reading open, so no red rests on it.
 */
function runsUnwritten(
  routine: Node, name: string | undefined, wanted: Set<string>, head: { source: string; language: Language } | undefined,
  outside: () => Set<number>,
): boolean {
  if (!name || !head) return true;
  const declared = unwrittenMethods(head.source, head.language, wanted);
  if (declared === "any") return true;
  if (declared.length === 0) return false;
  const runs = (use: Use) => declared.some((method) => use === "library"
    ? Object.values(UNWRITTEN).some((one) => one.test(method))
    : UNWRITTEN[use].test(method));
  let found = false;
  const visit = (node: Node, use: Use | undefined, callee?: Called): void => {
    if (found) return;
    if (node.childCount === 0) {
      if (use && node.isNamed && node.text === name && runs(use)) found = true;
      return;
    }
    const call = calledBy(node, outside);
    for (let at = 0; at < node.childCount; at += 1) {
      const child = node.child(at)!;
      visit(child, useOf(node, node.fieldNameForChild(at), use, callee), call ?? callee);
    }
  };
  visit(routine.childForFieldName("body") ?? routine, undefined);
  return found;
}

/** `library` is a call placed outside the repository: any of the others. */
type Use = keyof typeof UNWRITTEN | "library";

/** A call's callee as written, and whether it was placed outside the repository. */
type Called = { text: string; outside: boolean };

function calledBy(node: Node, outside: () => Set<number>): Called | undefined {
  if (!/^call(_expression)?$/.test(node.type) && node.type !== "new_expression") return undefined;
  const callee = node.childForFieldName("function") ?? node.childForFieldName("constructor");
  if (!callee) return { text: "", outside: false };
  // A site is placed by its member's name, or by the bare name.
  const at = callee.childForFieldName("attribute") ?? callee.childForFieldName("property") ?? callee;
  return { text: callee.text.replace(/\s+/g, ""), outside: outside().has(at.startIndex) };
}

/** Where a side's calls were placed outside the repository, by the start of the name each is placed by. */
function placedOutside(side: CallSide | undefined): Set<number> {
  const starts = new Set<number>();
  const reading = side ? callSitesIn(side) : undefined;
  if (!reading?.read) return starts;
  for (const body of reading.bodies) {
    for (const site of body.sites) if (site.file === EXTERNAL_RECEIVER && site.nameAt) starts.add(site.nameAt.start);
  }
  return starts;
}

/** What a node's child at `field` is used for, given what the node itself is used for. */
function useOf(node: Node, field: string | null, use: Use | undefined, callee: Called | undefined): Use | undefined {
  switch (node.type) {
    // A cast hands on the same value.
    case "parenthesized_expression": case "expression_list": case "as_expression": case "type_assertion":
    case "satisfies_expression": case "non_null_expression":
      return use;
    case "for_statement": case "for_in_clause": case "for_in_statement":
      return field === "right" || field === "iterable" ? "iterate" : undefined;
    case "list_splat": case "dictionary_splat": case "spread_element": case "yield": return "iterate";
    case "interpolation": case "template_substitution": return "format";
    case "not_operator": case "boolean_operator": return "truth";
    case "binary_operator": case "binary_expression": case "comparison_operator": case "unary_operator":
    case "unary_expression": case "augmented_assignment": case "subscript": case "subscript_expression":
      return "operator";
    case "if_statement": case "while_statement": case "elif_clause": case "conditional_expression": case "assert_statement":
      return field === "condition" ? "truth" : undefined;
    case "with_item": return "with";
    case "await": case "await_expression": return "await";
    case "set": return "hash";
    // A container something walks: its items may be hashed, compared or formatted (`set([r])`, `sorted([r])`).
    case "list": case "tuple": case "array": case "dictionary": case "object": case "list_comprehension":
    case "generator_expression": case "set_comprehension": case "dictionary_comprehension":
      return use === "library" ? use : use ? "operator" : undefined;
    case "pair": return field === "key" ? "hash" : undefined;
    case "keyword_argument": return field === "value" ? use : undefined;
    case "argument_list": case "arguments": {
      const called = callee?.text ?? "";
      return ITERATES.test(called) ? "iterate" : FORMATS.test(called) ? "format" : HASHES.test(called) ? "hash"
        : callee?.outside ? "library" : undefined;
    }
    default: return undefined;
  }
}

/**
 * The methods of the head's class a value of it can run unwritten, by name;
 * `"any"` when that cannot be listed: the class names a base, or it is a
 * Rust type with a trait implemented in this file.
 */
function unwrittenMethods(source: string, language: Language, wanted: Set<string>): string[] | "any" {
  const tree = parseSource(source, language);
  if (!tree) return "any";
  if (language === "rust") {
    let traits = false;
    each(tree.rootNode, (node) => {
      if (node.type !== "impl_item" || !node.childForFieldName("trait")) return;
      const type = node.childForFieldName("type")?.text.replace(/<[\s\S]*$/, "").split("::").pop();
      if (type !== undefined && wanted.has(type)) traits = true;
    });
    return traits ? "any" : [];
  }
  const methods: string[] = [];
  let based = false;
  each(tree.rootNode, (node) => {
    const own = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (!own || !body || node.childForFieldName("parameters") || !wanted.has(own.text)) return;
    if (node.childForFieldName("superclasses")) based = true;
    for (let at = 0; at < node.childCount; at += 1) if (node.child(at)?.type === "class_heritage") based = true;
    each(body, (member) => {
      const named = member.childForFieldName("name");
      if (named && member.childForFieldName("parameters")) methods.push(named.text.replace(/\s+/g, ""));
    });
  });
  return based ? "any" : methods;
}

/** Where `Self` could be the head in a Rust file: an `impl` of one of its names, and every trait. */
function selfMeansHead(source: string, wanted: Set<string>): Array<{ start: number; end: number }> {
  const tree = parseSource(source, "rust");
  if (!tree) return [];
  const spans: Array<{ start: number; end: number }> = [];
  each(tree.rootNode, (node) => {
    const implemented = node.type === "impl_item" ? node.childForFieldName("type") : undefined;
    const bare = implemented?.text.replace(/<[\s\S]*$/, "").split("::").pop();
    if (node.type === "trait_item" || (bare !== undefined && wanted.has(bare))) {
      spans.push({ start: node.startIndex, end: node.startIndex + node.text.length });
    }
  });
  return spans;
}

/**
 * Whether every construction these routines write is of something that is
 * provably not the head (#362).
 *
 * `new C()` is only evidence of "creates a C instead" when C is known: a class
 * or a routine declared here, or imported and followed to where it is. Every
 * other spelling is a value -- a module-level `const Ctor = Widget`, a
 * parameter `k`, a local holding `this.constructor` -- and a value can be the
 * head's class. So is anything qualified (`new ns.Foo()`), and anything the
 * import does not follow to a declaration it read.
 *
 * Followed through the import with `placeName`, the resolver `@calls` and the
 * Python path already use: `import W from "./widget"` and a re-export of
 * `Widget as Gadget` both come to rest at the head. And a class that `extends`
 * the head -- one level, under any name its own file gives the head -- is a
 * head too, so that is quiet as well.
 */
function everyConstructionIsSomethingElse(
  routines: Node[],
  source: string,
  language: Language,
  wanted: Set<string>,
  names: ConstructsNames | undefined,
): boolean {
  const bindings = bindingsIn(source, language);
  if (!bindings) return false;
  let doubt = false;
  for (const routine of routines) {
    each(routine, (node) => {
      if (doubt || !MAKES.test(node.type)) return;
      const made = madeBy(node);
      if (!made) { doubt = true; return; }
      if (node.type.startsWith("jsx_") && /^[a-z]/.test(made.text)) return;
      if (made.childCount !== 0 || !TYPE_NAME.test(made.type)) { doubt = true; return; }
      if (!isSomethingElse(made.text, source, language, bindings, wanted, names)) doubt = true;
    });
    if (doubt) return false;
  }
  return true;
}

/** `everyConstructionIsSomethingElse` for one name: declared or followed, and neither the head nor a subclass of it. */
function isSomethingElse(
  name: string,
  source: string,
  language: Language,
  bindings: Bindings,
  wanted: Set<string>,
  names: ConstructsNames | undefined,
): boolean {
  if (!bindings.imported.has(name)) {
    return bindings.local.has(name) && declaredApart(source, language, name, wanted, names?.side.file, names);
  }
  if (!names) return false;
  const placed = placeName(name, names.side, bindings);
  if ("why" in placed || placed.as === undefined) return false;
  if (placed.file === names.target && wanted.has(placed.as)) return false;
  const far = placed.file === names.side.file
    ? { source, language }
    : names.side.open?.(placed.file);
  if (!far || far.language !== language && !(isTypeScript(far.language) && isTypeScript(language))) return false;
  return declaredApart(far.source, far.language, placed.as, wanted, placed.file, names);
}

const isTypeScript = (language: Language) => language === "ts" || language === "tsx";

/**
 * Whether `source` declares `name` exactly as a class or a routine, and a
 * class that is no kind of the head.
 *
 * A header that spells the head -- `extends`, `implements`, under the head's
 * name or any name this file imports it as -- is a kind of it on sight. A
 * header that spells anything else is the compiler's question, because
 * `Leaf extends Mid` says nothing about what Mid extends (#362's review).
 */
function declaredApart(
  source: string,
  language: Language,
  name: string,
  wanted: Set<string>,
  file: string | undefined,
  names: ConstructsNames | undefined,
): boolean {
  const tree = parseSource(source, language);
  if (!tree) return false;
  const spelt = new Set(wanted);
  for (const [local, binding] of bindingsIn(source, language)?.imported ?? []) {
    if (binding.name !== undefined && wanted.has(binding.name)) spelt.add(local);
  }
  let declared = 0;
  let apart = true;
  each(tree.rootNode, (node) => {
    // A JSX tag carries its component on a `name` field too, and `<Header />`
    // is a use of Header, not a second declaration of it.
    if (node.type.startsWith("jsx_")) return;
    const declaredName = node.childForFieldName("name");
    if (!declaredName || declaredName.childCount !== 0 || declaredName.text !== name) return;
    const value = node.childForFieldName("value");
    if (node.childForFieldName("parameters") ?? value?.childForFieldName("parameters")) { declared += 1; return; }
    const body = node.childForFieldName("body");
    if (!/class_declaration$/.test(node.type) || !body) { apart = false; return; }
    declared += 1;
    // The header: every child between the name and the body -- `extends`,
    // `implements`, type parameters.
    const typeParameters = node.childForFieldName("type_parameters");
    let header = false;
    let parents = false;
    for (let at = 0; at < node.childCount; at += 1) {
      const part = node.child(at);
      if (!part) continue;
      if (part.id === declaredName.id) { header = true; continue; }
      if (part.id === body.id) break;
      if (!header) continue;
      if (part.isNamed && part.id !== typeParameters?.id) parents = true;
      each(part, (leaf) => {
        if (leaf.childCount === 0 && leaf.isNamed && spelt.has(leaf.text)) apart = false;
      });
    }
    if (apart && parents && !noKindOfTheHead(file, declaredName, names, wanted, language)) apart = false;
  });
  return apart && declared > 0;
}

/**
 * Whether the compiler says the class named at `declared` in `file` derives
 * from nothing that is the head: it placed every parent, and none of them is
 * a class of the head's names declared in the head's own file.
 */
function noKindOfTheHead(
  file: string | undefined,
  declared: Node,
  names: ConstructsNames | undefined,
  wanted: Set<string>,
  language: Language,
): boolean {
  if (file === undefined || !names?.ancestors) return false;
  const ancestors = names.ancestors(file, { start: declared.startIndex, end: declared.startIndex + declared.text.length });
  if (!ancestors) return false;
  const inHead = ancestors.filter((one) => one.file === names.target);
  if (inHead.length === 0) return true;
  const head = names.target === names.side.file ? names.side.source : names.side.open?.(names.target)?.source;
  const tree = head === undefined ? undefined : parseSource(head, language);
  if (!tree) return false;
  const lines = new Set<number>();
  each(tree.rootNode, (node) => {
    const name = node.childForFieldName("name");
    if (name && name.childCount === 0 && wanted.has(name.text) && node.childForFieldName("body")) {
      lines.add(lineOf(head!, name.startIndex));
    }
  });
  return inHead.every((one) => !lines.has(one.line));
}

/** Whether this declaration has a routine anywhere inside it. */
function holdsRoutines(node: Node): boolean {
  let found = false;
  each(node, (child) => {
    if (found || child.id === node.id) return;
    if (child.childForFieldName("parameters")) found = true;
  });
  return found;
}

/**
 * Every routine name declared in a file.
 *
 * The far end of a `builds` arrow is a *type*, and the backwards question is
 * whether any of that type's own routines makes the thing at the tail. A box
 * standing for a type names the type, not its methods, so the caller has no list
 * to offer -- and asking "which methods does `Widget` have" is a question this
 * reader would have to answer anyway.
 *
 * Every routine in the file rather than only the type's own methods, and that is
 * deliberate in the safe direction: a wider search can only find *more*
 * constructions, and finding one is what makes the accusation. A narrower search
 * that missed the method actually doing the building would answer `absent`,
 * which is silence -- so the cost of being wide is a stronger verdict on
 * evidence that is still real, and the cost of being narrow is missing it.
 */
export function routineNamesIn(source: string, language: Language): string[] {
  const tree = parseSource(source, language);
  if (!tree) return [];
  const names = new Set<string>();
  each(tree.rootNode, (node) => {
    const name = node.childForFieldName("name") ?? node.childForFieldName("left");
    if (!name || name.childCount !== 0) return;
    const value = node.childForFieldName("value");
    if (node.childForFieldName("parameters") ?? value?.childForFieldName("parameters")) {
      names.add(name.text);
    }
  });
  return [...names];
}

/**
 * Where the names a Python body writes come from (#309).
 *
 * Python spells `Response(body)` and `render(body)` the same way, so which of
 * them is a construction cannot be read off the body. What separates them is one
 * line above it: the import that brings `Response` into the file names the file
 * declaring it, and that file says whether it declares a class or a function.
 *
 * `side` is the tail's own file in the shape `calls.ts` resolves a name with --
 * its imports already resolved to files by `deps.ts`, plus an `open` that can
 * read one more file, which is what makes a re-export followable. It repeats
 * `source` and `language`, and that is the price of asking the resolver the same
 * question `@calls` asks rather than writing a second one.
 *
 * `target` is the repo-relative file the far box's type is declared in. A name
 * that comes to rest anywhere else is a different `Response` than the one the
 * arrow points at, and confirming on it would be a green nobody earned.
 *
 * Optional throughout: a caller holding one file and no import table gets the
 * refusal this reader always gave.
 */
export interface ConstructsNames {
  side: CallSide;
  target: string;
  /**
   * The head's own file as a side, with the same second opinion the tail
   * has (#362). Python asks `@calls`' call reading whether the tail's whole
   * call set lands anywhere near the head, and whether the head's code
   * creates the tail -- both questions need the head readable the way
   * `callsBetween` reads it.
   */
  head?: CallSide;
  /**
   * Every class the class declared at this range of `file` derives from, at
   * any depth, from the compiler (#362's review; `ClosedBodyReferee`'s
   * `ancestorsAt`). Absent, or `undefined` from it, is no answer -- and a
   * class with a parent nobody placed may be a kind of the head.
   */
  ancestors?: (file: string, at: { start: number; end: number }) => Array<{ file: string; line: number }> | undefined;
  /**
   * The side `@calls` placed the tail's calls with, when it asks (#374):
   * the same placements its closed reading rests on, compilers included, so
   * a call it put outside the repository is one a handed-in value may be
   * run by (#432). Absent, `side`'s are used.
   */
  calls?: CallSide;
}

/**
 * Every bare call written under this node, and where.
 *
 * `parse.ts`' own rule -- *a call is a node with a `function` field* -- and a
 * bare one is a call whose function is a single identifier. `mod.Response(..)`
 * has a whole expression there instead, and which module `mod` stands for is a
 * question this reader is not asked; it is left alone rather than guessed at.
 * The referee behind #309's measurement counts bare calls only, so nothing
 * measured turns on the ones left out.
 */
function bareCalls(node: Node, source: string): Array<{ name: string; evidence: ConstructsEvidence }> {
  const found: Array<{ name: string; evidence: ConstructsEvidence }> = [];
  each(node, (child) => {
    const callee = child.childForFieldName("function");
    if (!callee || callee.childCount !== 0 || !TYPE_NAME.test(callee.type)) return;
    found.push({
      name: callee.text,
      evidence: {
        name: callee.text,
        line: lineOf(source, callee.startIndex),
        wrote: child.text.replace(/\s+/g, " ").slice(0, 80),
      },
    });
  });
  return found;
}

/**
 * Whether this Python source declares `name` as a class.
 *
 * The structural rule `parse.ts` states rather than a list of node type names: a
 * declaration is a node with a `name` field, and a routine is one that also has
 * `parameters`. `docs/reading-a-grammar.md` is about what happens to the list --
 * one reader made the same mistake four times, every instance a hand-written set
 * of node names that one language spelled differently.
 *
 * The shape is exact here, and it was checked rather than assumed. Over 400
 * Python files of the pinned clones the only nodes carrying a bare `name` field
 * *and* a `body` are `function_definition` (2,596, every one with `parameters`)
 * and `class_definition` (267, not one with any). Everything else with a `name` --
 * `keyword_argument`, a defaulted parameter, a walrus -- has no body. So name and
 * body and no parameters is a class, and nothing else in the grammar wears it.
 */
function declaresClass(source: string, name: string): boolean {
  const tree = parseSource(source, "python");
  if (!tree) return false;
  let found = false;
  each(tree.rootNode, (node) => {
    if (found) return;
    const declared = node.childForFieldName("name");
    if (!declared || declared.childCount !== 0 || declared.text !== name) return;
    if (!node.childForFieldName("body") || node.childForFieldName("parameters")) return;
    found = true;
  });
  return found;
}

/**
 * Which of the far box's names a written name stands for.
 *
 * `Res(body)` in a file that says `from app.wsgi import Response as Res` is a
 * Response being made, and the import is the only thing in the file that says so.
 * A reader comparing spellings answers "not written here" about an arrow written
 * in plain sight -- the `aliased` gap #227 named, one word over.
 *
 * Nothing new is read for it: the specifier `bindPython` records already carries
 * the original name on its tail, because that is the string `deps-python.ts`
 * resolves. A namespace binding (`import app.wsgi as w`) is left out -- `w` is a
 * module, and `w.Response(..)` is not a bare call this reader is asked about.
 */
function meansOneOf(name: string, wanted: Set<string>, bindings: Bindings): string | undefined {
  if (wanted.has(name)) return name;
  const imported = bindings.imported.get(name);
  if (!imported || imported.namespace) return undefined;
  const tail = imported.specifier.split(".").pop();
  return tail !== undefined && wanted.has(tail) ? tail : undefined;
}

/** The refusals `placeName` hands back, in this reader's own words for them. */
function unresolved(why: string): ConstructsWithheld {
  switch (why) {
    case "unbound": return "unbound";
    case "unplaced": return "unplaced";
    case "ambiguous": return "ambiguous";
    default: return "elsewhere";
  }
}

/**
 * Whether a Python routine makes one of these types, resolved through the file's
 * imports (#309).
 *
 * **Confirmations only, and that is a rule rather than an omission.** This reader
 * can now find a construction that is written; it still cannot read an absence,
 * because a factory is invisible here exactly as it is everywhere else. So every
 * answer that is not a confirmation is a refusal, and Python never reaches
 * `absent`, `cycle` or `backwards` through this path -- which is what keeps the
 * change from making a new red possible in a language whose `builds` accusation
 * has no measured licence.
 */
function pythonConstructions(
  source: string,
  routine: string,
  targets: string[],
  names: ConstructsNames | undefined,
): ConstructsVerdict {
  if (!names) return { verdict: "withheld", why: "call-shaped" };

  const { routines, declared, unreadable } = routinesNamed(source, routine, "python");
  if (unreadable) return { verdict: "withheld", why: "unreadable" };
  if (routines.length === 0) {
    return { verdict: "withheld", why: declared ? "no-body" : "not-declared" };
  }
  const bindings = bindingsIn(source, "python");
  if (!bindings) return { verdict: "withheld", why: "unreadable" };

  const wanted = new Set(targets);
  /*
   * The reason reported when nothing confirms: the first one hit, which is the
   * rule the C-family path above already follows (`withheld ??= why`). It only
   * ever decides which of several refusals gets named, never whether the answer
   * is a refusal -- and `not-constructed` is the fallback rather than a
   * candidate, so "the name is nowhere in this body" cannot mask a name that is
   * there and could not be placed.
   */
  let why: ConstructsWithheld | undefined;
  const note = (reason: ConstructsWithheld) => { why ??= reason; };

  for (const body of routines) {
    // The same doubt `madeIn` refuses on: a recovered parse is a statement about
    // a file only partly read, so a call node found inside one is not evidence.
    if (body.hasError) { note("incomplete"); continue; }
    for (const call of bareCalls(body, source)) {
      const meant = meansOneOf(call.name, wanted, bindings);
      if (meant === undefined) continue;
      const placed = placeName(call.name, names.side, bindings);
      if ("why" in placed) { note(unresolved(placed.why)); continue; }
      if (placed.file !== names.target) { note("elsewhere"); continue; }
      const at = placed.file === names.side.file
        ? { source, language: "python" as Language }
        : names.side.open?.(placed.file);
      // The far file could not be handed over, or is not Python -- either way
      // there is no Python declaration here to read a class off.
      if (!at || at.language !== "python") { note("unreadable"); continue; }
      if (!declaresClass(at.source, meant)) { note("not-a-class"); continue; }
      // The class that was made, under the name the far box carries -- not the
      // local spelling an import renamed it to.
      return { verdict: "confirmed", evidence: { ...call.evidence, name: meant } };
    }
  }
  return { verdict: "withheld", why: why ?? "not-constructed" };
}

/**
 * Python's "creates none" and "backwards", read through `@calls`' call
 * reading rather than the text (#362).
 *
 * The text cannot tell `self.do_thing()` from `self.widget_class()`, which
 * creates one, so it can never close a Python body on its own. `callsBetween`
 * can: with pyright behind it, every call the routine makes is placed at a
 * file, or the body is not closed and nothing is said. So:
 *
 *   refuted     every call placed, none in the head's file -- and none at a
 *               class that derives from the head, which is a head too
 *   backwards   the tail is a class and the head's own code calls it, which
 *               in Python is creating one
 *
 * Only after the import-resolved text path found no call spelt as the head,
 * with no doubt on the way (`not-constructed`). Quiet when the head is a
 * `TypedDict` or a `Protocol` (a dict literal or any class makes one), when
 * the routine names the head anywhere, and on a planned arrow.
 */
function pythonAbsence(
  source: string,
  routine: string,
  targets: string[],
  reverse: { source: string; routines: string[]; language: Language; names: string[] } | undefined,
  names: ConstructsNames | undefined,
  handedInCounts = false,
): ConstructsVerdict | undefined {
  if (!reverse || reverse.language !== "python" || !names?.head) return undefined;
  if (!mayAccuse("builds", "python", "absence") || !onlyCalledClasses(reverse.source, targets)) return undefined;
  const { routines } = routinesNamed(source, routine, "python");
  if (routines.length === 0) return undefined;
  if (namesTheHead(routines, source, "python", new Set(targets), handedInCounts, reverse, names.calls ?? names.side)) return undefined;

  /*
   * A call to the tail is a construction only when the tail is a class. When
   * it is not, the head's code calling it says nothing about this arrow, and
   * it used to end the question there (#417): httpx's `QueryParams` calls its
   * own `multi_items`, and "does `multi_items` make one?" was never asked.
   */
  const tailIsAClass = declaresClass(source, routine);
  const verdict = callsBetween({ ...names.side, routine }, { ...names.head, names: targets }, tailIsAClass);
  if (verdict.verdict === "backwards") {
    if (!mayAccuse("builds", "python")) return undefined;
    const { name, line, wrote } = verdict.evidence;
    return { verdict: "backwards", evidence: { name, line, wrote } };
  }
  if (verdict.verdict === "absent" && verdict.notClosed) return { verdict: "absent", notClosed: verdict.notClosed };
  if (verdict.verdict !== "refuted") return undefined;
  if (callsAComputedCallee(routines)) return undefined;
  if (aCallMayCreateTheHead(names, routine, new Set(targets))) return undefined;
  return { verdict: "refuted", evidence: {
    routine,
    line: lineOf(source, routines[0]!.startIndex),
    made: [],
  } };
}

/**
 * Python's `onlyNewCreates`: every name is a class, and none is a `TypedDict`
 * or a `Protocol` -- a dict literal makes the first, and any class with the
 * right methods is the second. A name declared any second way in the file (a
 * function, a module-level assignment) is doubt.
 */
function onlyCalledClasses(source: string, names: string[]): boolean {
  if (names.length === 0) return false;
  const tree = parseSource(source, "python");
  if (!tree) return false;
  const wanted = new Set(names);
  const classes = new Set<string>();
  let doubt = false;
  each(tree.rootNode, (node) => {
    const name = node.childForFieldName("name") ?? assigned(node);
    if (!name || name.childCount !== 0 || !wanted.has(name.text)) return;
    if (!node.childForFieldName("body") || node.childForFieldName("parameters")) { doubt = true; return; }
    const bases = node.childForFieldName("superclasses")?.text ?? "";
    if (/\b(TypedDict|Protocol)\b/.test(bases)) doubt = true;
    else classes.add(name.text);
  });
  return !doubt && names.every((name) => classes.has(name));
}

/**
 * Whether the routine calls something that is not a name: `type(self)(..)`,
 * `KINDS[k]()`. The call reading names the first by the call inside it --
 * `type`, a builtin, placed outside the repository -- so the body looks
 * closed while the thing actually called is the routine's own class.
 *
 * `self.__class__(..)` is the same call spelt as an attribute (#387): a
 * dunder is the language's attribute, not a routine anybody declared, and
 * what it holds is not written. It was read as a call placed outside the
 * repository and the correct arrow went red.
 */
function callsAComputedCallee(routines: Node[]): boolean {
  let computed = false;
  for (const routine of routines) {
    each(routine, (node) => {
      const callee = node.childForFieldName("function");
      if (computed || !callee) return;
      if (!/^(identifier|attribute)$/.test(callee.type)) computed = true;
      const attribute = callee.type === "attribute" ? callee.childForFieldName("attribute")?.text ?? "" : "";
      if (/^__\w+__$/.test(attribute)) computed = true;
    });
  }
  return computed;
}

/**
 * Whether a call in the routine may create the head after all, though the
 * call reading placed every one of them away from its file:
 *
 *   - a call landing on a class that derives from the head -- `SubWidget()`
 *     creates a Widget -- one level, under any name the subclass's file
 *     gives the head;
 *   - a call landing on something that is neither a routine nor a class:
 *     flask's `self.json_provider_class(self)` is placed at the attribute
 *     `json_provider_class = DefaultJSONProvider`, a value that holds a class;
 *   - a call placed without the far name read, which is not knowing.
 */
function aCallMayCreateTheHead(names: ConstructsNames, routine: string, wanted: Set<string>): boolean {
  const { side } = names;
  const reading = callSitesIn(side, routine);
  if (!reading.read) return true;
  for (const body of reading.bodies) {
    if (body.routine !== routine) continue;
    for (const site of body.sites) {
      if (site.file === undefined || site.file === EXTERNAL_RECEIVER) continue;
      if (site.declaredAs === undefined) return true;
      const far = site.file === side.file ? { source: side.source, language: side.language } : side.open?.(site.file);
      if (!far) return true;
      if (far.language !== "python") return true;
      if (declaresClass(far.source, site.declaredAs)) {
        if (!declaredApartPython(far.source, site.declaredAs, wanted, site.file, names)) return true;
      } else if (!declaresRoutine(far.source, site.declaredAs)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The name an assignment binds, `Widget` in `Widget = make()`, or nothing.
 *
 * Not simply the `left` field: `Widget | None` in a hint has one too, and
 * read as a declaration it silenced every class used in a union (#362,
 * httpx's `Request`). What an assignment has and an operator does not is an
 * `=` -- an anonymous token, so its type is its own text
 * (docs/reading-a-grammar.md).
 */
function assigned(node: Node): Node | undefined {
  const left = node.childForFieldName("left");
  if (!left) return undefined;
  for (let at = 0; at < node.childCount; at += 1) {
    const part = node.child(at);
    if (part && !part.isNamed && part.type === "=") return left;
  }
  return undefined;
}

/** Whether this Python source declares `name` as a `def` -- and only as that. */
function declaresRoutine(source: string, name: string): boolean {
  const tree = parseSource(source, "python");
  if (!tree) return false;
  let routine = false;
  let other = false;
  each(tree.rootNode, (node) => {
    const declared = node.childForFieldName("name") ?? assigned(node);
    if (!declared || declared.childCount !== 0 || declared.text !== name) return;
    if (node.childForFieldName("parameters") && node.childForFieldName("body")) routine = true;
    else if (node.childForFieldName("body") || assigned(node)) other = true;
  });
  return routine && !other;
}

/**
 * `declaredApart` for a Python class: its bases name none of the head's
 * spellings, and a class with any base at all is the compiler's question --
 * `Leaf(Mid)` says nothing about what Mid derives from (#362's review).
 */
function declaredApartPython(
  source: string,
  name: string,
  wanted: Set<string>,
  file: string,
  names: ConstructsNames,
): boolean {
  const tree = parseSource(source, "python");
  if (!tree) return false;
  const spelt = new Set(wanted);
  for (const [local, binding] of bindingsIn(source, "python")?.imported ?? []) {
    if (binding.name !== undefined && wanted.has(binding.name)) spelt.add(local);
  }
  let apart = true;
  each(tree.rootNode, (node) => {
    const declared = node.childForFieldName("name");
    if (!declared || declared.text !== name) return;
    const bases = node.childForFieldName("superclasses");
    if (!bases) return;
    each(bases, (leaf) => {
      if (leaf.childCount === 0 && leaf.isNamed && spelt.has(leaf.text)) apart = false;
    });
    // A keyword (`metaclass=M`) is not a parent; anything else named is.
    let parents = false;
    for (let at = 0; at < bases.childCount; at += 1) {
      const base = bases.child(at);
      if (!base?.isNamed || base.text.startsWith("#")) continue;
      if (!(base.childForFieldName("name") && base.childForFieldName("value"))) parents = true;
    }
    if (apart && parents && !noKindOfTheHead(file, declared, names, wanted, "python")) apart = false;
  });
  return apart;
}

/**
 * Whether this routine makes one of these types, and whether the reverse holds.
 *
 * `targets` is every name the far box stands for, and any one of them is enough
 * -- the same any-of-the-members rule the other checks use.
 *
 * `reverse` is the far end's own source and the routines to read in it, so the
 * backwards verdict can rest on something found. Absent means the question is
 * not asked, and the answer degrades to `confirmed` or `absent` -- which is what
 * a caller with only one file can honestly get.
 *
 * `forCalls` is `@calls` into a class asking (#374): a parameter of the
 * class's type then still names it (`namesTheHead`).
 */
export function constructions(
  source: string,
  routine: string,
  targets: string[],
  language: Language,
  reverse?: { source: string; routines: string[]; language: Language; names: string[] },
  names?: ConstructsNames,
  forCalls = false,
): ConstructsVerdict {
  /*
   * Python spells construction as a call, so nothing in this body separates one
   * from the other and the answer comes from the file's imports instead (#309).
   * Its own path, and confirm-only: `reverse` is not consulted, because the
   * accusation that rests on it has no measured licence in this language.
   */
  if (language === "python") {
    const verdict = pythonConstructions(source, routine, targets, names);
    if (verdict.verdict !== "withheld" || verdict.why !== "not-constructed") return verdict;
    return pythonAbsence(source, routine, targets, reverse, names, forCalls) ?? verdict;
  }

  const { routines, declared, unreadable } = routinesNamed(source, routine, language);
  if (unreadable) return { verdict: "withheld", why: "unreadable" };
  if (routines.length === 0) {
    // Told apart, because they send a reader to different places: a name that is
    // not here at all is the node check's own finding, and a name that is here
    // without a body is a box pointing at data rather than at a routine.
    return { verdict: "withheld", why: declared ? "no-body" : "not-declared" };
  }

  const wanted = new Set(targets);
  let withheld: ConstructsWithheld | undefined;
  const madeInstead = new Map<string, ConstructsEvidence>();

  /*
   * Every declaration of the name, and a confirmation from any of them wins.
   *
   * The rule `signature.ts` and `holds.ts` both arrived at: a name is declared
   * more than once all the time, and Rust `impl` blocks make it ordinary. A
   * single reason to doubt silences the whole answer, because "one of these
   * bodies could be making it somewhere I could not read" is exactly the doubt
   * that forbids an accusation.
   */
  for (const body of routines) {
    const { made, why } = madeIn(body, source);
    if (why) withheld ??= why;
    for (const name of wanted) {
      const evidence = made.get(name);
      if (evidence) return { verdict: "confirmed", evidence };
    }
    for (const [name, evidence] of made) if (!madeInstead.has(name)) madeInstead.set(name, evidence);
  }

  /*
   * Rust: the text found no construction, and rustc's build may have (#396).
   * `ParserNumber::F64(tri!(..))` is invisible to the text twice over -- the
   * macro stops it, and an enum variant reads as a call -- and the compiled
   * body writes it as an aggregate of `ParserNumber`. Only a value built in
   * place confirms (`built`, not `made`): a B handed back by `B::new()` is
   * B's routine making one. With a body to ask, a macro no longer blocks the
   * guarded absence path below; with none, the answer is today's.
   */
  if (language === "rust" && names?.side.compiled) {
    const compiled = compiledBodiesFor({ ...names.side, routine }, [...wanted]);
    if (compiled && compiled.bodies.length > 0) {
      const built = [...wanted].find((name) => compiled.bodies.some((body) => body.built.has(name)));
      if (built) {
        return { verdict: "confirmed", evidence: {
          name: built, line: lineOf(source, routines[0]!.startIndex), wrote: "(built in place, by the compiler's build)",
        } };
      }
      if (withheld === "macro") withheld = undefined;
    }
  }

  if (withheld) return { verdict: "withheld", why: withheld };

  /*
   * Nothing found this way round. Before answering, ask whether it runs the
   * other way -- which is the only accusation this word is entitled to, and the
   * only one that rests on something found.
   */
  if (reverse && mayAccuse("builds", reverse.language)) {
    const theirs = new Set(reverse.names);
    for (const routineName of reverse.routines) {
      for (const body of routinesNamed(reverse.source, routineName, reverse.language).routines) {
        const { made, why } = madeIn(body, reverse.source);
        if (why) continue;
        for (const name of theirs) {
          const evidence = made.get(name);
          if (evidence) return { verdict: "backwards", evidence };
        }
      }
    }
  }

  /*
   * Not made here, and not made the other way round. On the absence licence
   * that is the finding (#362): the body was read in full and creates none of
   * it. No `reverse` means a planned arrow or a head nothing could read, and
   * both stay quiet.
   */
  const byText = reverse !== undefined && mayAccuse("builds", language, "absence")
    && onlyNewCreates(reverse.source, language, reverse.language, targets)
    && !namesTheHead(routines, source, language, wanted, forCalls, reverse, names?.calls ?? names?.side)
    && !(language === "rust" && macroDeclares(source, routine));
  if (byText && language === "rust" && names && !names.side.compiled?.()) {
    return { verdict: "absent", awaitsCompiler: true };
  }
  if (byText && (language === "rust"
    ? compiledCreatesNone(routine, wanted, names)
    : everyConstructionIsSomethingElse(routines, source, language, wanted, names))) {
    return { verdict: "refuted", evidence: {
      routine,
      line: lineOf(source, routines[0]!.startIndex),
      made: [...madeInstead.values()],
    } };
  }

  return { verdict: "absent" };
}
