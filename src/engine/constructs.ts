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
import { bindingsIn, placeName, type Bindings, type CallSide } from "./calls";
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
  names?: ConstructsNames,
): ConstructsVerdict {
  /*
   * Python spells construction as a call, so nothing in this body separates one
   * from the other and the answer comes from the file's imports instead (#309).
   * Its own path, and confirm-only: `reverse` is not consulted, because the
   * accusation that rests on it has no measured licence in this language.
   */
  if (language === "python") return pythonConstructions(source, routine, targets, names);

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

  return { verdict: "absent" };
}
