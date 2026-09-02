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
 * Two more are constructions that a reader cannot tell from an ordinary call,
 * and both are withheld rather than guessed at:
 *
 *     X::new(..)       Rust      an associated function, by convention only
 *     X(..)            Python    calling a class name *is* construction
 *
 * Python is the whole of why this word cannot be trusted with an absence even in
 * the languages where the syntax is clear. It is also why Python gets no
 * confirmations here at all: the reader cannot see the difference between
 * `Response(body)` making a Response and `render(body)` making nothing, and
 * guessing on capitalisation is a naming convention masquerading as evidence.
 */
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
   * The language spells construction as an ordinary call, so the reader cannot
   * tell one from the other.
   *
   * Python is the case: `Response(body)` is a construction and `render(body)` is
   * not, and nothing in the syntax separates them. Capitalisation is a naming
   * convention rather than evidence, and a word that accused on a convention
   * would be wrong the first time somebody wrote `Response = make_response`.
   */
  | "call-shaped"
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
  | { verdict: "absent" }
  | { verdict: "withheld"; why: ConstructsWithheld };

/** Grammar nodes that mean construction and nothing else. */
const MAKES = /^(new_expression|struct_expression|jsx_opening_element|jsx_self_closing_element)$/;

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
    const name = node.childForFieldName("name") ?? node.childForFieldName("left");
    if (!name || name.childCount !== 0 || name.text !== routine) return;
    declared = true;
    // The parameters may sit on the declaration or on the value assigned to it:
    // `function f()` has its own, `const f = () => x` has the arrow function's.
    const value = node.childForFieldName("value");
    const takesParameters = node.childForFieldName("parameters")
      ?? value?.childForFieldName("parameters");
    if (takesParameters) routines.push(node);
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
 * Whether this routine makes one of these types, and whether the reverse holds.
 *
 * `targets` is every name the far box stands for, and any one of them is enough
 * -- the same any-of-the-members rule the other checks use.
 *
 * `reverse` is the far end's own source and the routines to read in it, so the
 * backwards verdict can rest on something found. Absent means the question is
 * not asked, and the answer degrades to `confirmed` or `absent` -- which is what
 * a caller with only one file can honestly get.
 */
export function constructions(
  source: string,
  routine: string,
  targets: string[],
  language: Language,
  reverse?: { source: string; routines: string[]; language: Language; names: string[] },
): ConstructsVerdict {
  /*
   * Python spells construction as a call, so there is nothing here to read in
   * either direction. Answered before the parse: the refusal is about the
   * language rather than about this file, and saying so costs nothing.
   */
  if (language === "python") return { verdict: "withheld", why: "call-shaped" };

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
  }

  if (withheld) return { verdict: "withheld", why: withheld };

  /*
   * Nothing found this way round. Before answering, ask whether it runs the
   * other way -- which is the only accusation this word is entitled to, and the
   * only one that rests on something found.
   */
  if (reverse && mayAccuse(reverse.language)) {
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

  return { verdict: "absent" };
}
