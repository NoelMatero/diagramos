/**
 * Following a value through the locals of one function body.
 *
 * **This is an instrument, not a word.** Nothing here is wired into `drift.ts`
 * and nothing here can put a colour on a diagram. It exists to answer two
 * questions with numbers (#208), and the numbers decide whether #203 is worth
 * building on. `scripts/measure-dataflow.mts` is the only caller.
 *
 * ## The two questions
 *
 * **Does a producer's result reach a consumer?** `feeds.ts` answers this for
 * one hop -- `B(A(x))` and `const v = A(x); B(v)` -- and stops. The shape it
 * cannot see is the ordinary one:
 *
 *     const rows   = parse(input);
 *     const shaped = normalise(rows);
 *     render(shaped);                  // parse feeds render, through two hops
 *
 * Following that is a def-use chain over the locals of a single body and
 * nothing more. No call is resolved, nothing crosses a function boundary, and
 * that boundary is deliberate: the moment this reaches across one it becomes
 * #189 and stops being cheap.
 *
 * **Does a value provably never leave the body it was made in?** This is the
 * one that matters. #203's refutation story is *closed regions*: a signature
 * can be listed in full, so a type missing from it is missing. The claim worth
 * testing is that the same argument reaches values -- if a value never escapes
 * the region it was made in, everything that can be in it is enumerable, and an
 * absence is then proof rather than silence.
 *
 * ## Why every doubt is counted against `contained`
 *
 * A value counted as contained when it was not is a claim that an absence is
 * proof, which is the false accusation `licence.ts` is written to prevent. So
 * the bias runs one way throughout:
 *
 * - **Every call is unresolvable.** There is no call graph, so handing a value
 *   to any routine puts it somewhere this reader cannot follow. That reads as
 *   harsh and it is the honest answer -- and because it is reported under its
 *   own name, the breakdown says exactly how much of the escaping is that one
 *   shape, which is the number that tells you what #189 would buy.
 * - **A use in a position this reader does not recognise is not a safe use.**
 *   It is recorded, by the node type around it, under `unread`. So `contained`
 *   is a floor, and the report can name the shapes that would raise it.
 *
 * Three outcomes per value, never two: **contained**, **escaped** (with the
 * reason named), or **withheld**. Reporting only the first two would let the
 * doubt be rounded away, and the doubt is the part that decides the question.
 */

import { each, parseSource, type Language, type Node } from "./parse";

/** Why a body could not be read at all. Each is a reason to say nothing. */
export type DataflowWithheld =
  /** No grammar for this language, or the file would not parse. */
  | "unreadable"
  /** Nothing in the file declares that name. */
  | "not-declared"
  /** The name is declared and is not a routine, so there is no body. */
  | "no-body"
  /** The parse recovered from an error, so what is in this body is a guess. */
  | "incomplete"
  /** The body is tokens awaiting a macro expansion. */
  | "macro";

/**
 * How a value left the body it was made in.
 *
 * Each is a place the value went that this reader cannot follow, so what ends
 * up in it stops being enumerable. Named separately rather than totalled,
 * because the breakdown is the finding: escaping through one shape and escaping
 * through twenty are different facts about what could be closed.
 */
export type Escape =
  /** Handed to a routine, which without a call graph is anywhere at all. */
  | "passed-to-a-call"
  /** A method was called on it, which can store it just as a call can. */
  | "used-as-a-receiver"
  /** The body hands it back, so it outlives the region. */
  | "returned"
  /** Written onto an object that outlives the body. */
  | "stored-in-a-field"
  /** Read from inside a nested closure, which can outlive the body. */
  | "captured-by-a-closure"
  /** Placed in an array, object, tuple or struct literal, whose fate is untracked. */
  | "into-a-structure"
  /**
   * Put into a collection, and the collection itself then left.
   *
   * Distinct from `into-a-structure` on purpose: the value was followed *into*
   * the collection and the collection is what failed to stay. Naming it
   * separately is what makes the vector case legible in the breakdown -- it
   * says how often following a value into a container bought nothing because
   * the container went out anyway.
   */
  | "left-inside-a-collection"
  /** Assigned to a name bound outside this body. */
  | "assigned-to-an-outer"
  /** Given a second name, and this reader follows the first. */
  | "bound-to-another-name"
  /** Thrown, or yielded: it leaves upwards rather than through a return. */
  | "thrown"
  | "yielded";

/** Why one local could not be followed, even though the body was read. */
export type Unfollowable =
  /** The name is assigned again, so "the value" is not one value. */
  | "rebound"
  /** An inner scope binds the same name, so a use might be either. */
  | "shadowed";

/** One local binding, and what became of the value in it. */
export interface Local {
  /** The name bound. */
  name: string;
  /** 1-based line of the binding. */
  line: number;
  /**
   * Producers whose result reached this value, and the locals it came through.
   *
   * The path starts at the local bound directly from the producer and ends at
   * this one, so `render(shaped)` can be quoted as `parse` through
   * `rows -> shaped`.
   */
  carries: Map<string, string[]>;
  /**
   * Whether this local is a collection whose creation was seen in this body.
   *
   * The gate is a *literal*: `[]`, `{}`, `new Map()`, `vec![]`, `dict()`. What
   * that buys is the type, from syntax alone rather than from a naming
   * convention -- so `v.push(x)` is known to be a collection taking a value in
   * rather than an arbitrary method that might store it anywhere. A value bound
   * from an ordinary call gets no collection modelling, on the same footing
   * `constructs.ts` withholds Python: a convention is not evidence.
   */
  collection?: true;
  /**
   * Producers whose result is inside this collection, and the path in.
   *
   * The index is deliberately not tracked. Knowing *which* slot a value sits in
   * needs the value of `i`, which is undecidable in general -- and it is not
   * needed. The collection is one thing and this is everything in it, which is
   * the abstraction that makes the question computable.
   */
  holds: Map<string, string[]>;
  /**
   * Collections this value was put into, by name.
   *
   * Where it went is not yet whether it left: a value inside a collection that
   * never leaves the body has not left the body either. Resolved after the walk,
   * because the collection's own fate may not be known when the write is read.
   */
  inside: string[];
  /**
   * Something was taken out of this collection and handed somewhere unfollowable.
   *
   * The collection itself has not left -- `use(v[i])` reads it and nothing more
   * -- but whatever came out is gone, so everything that went in has to be
   * counted as gone. Kept apart from `escapes` because the two answers differ:
   * `v` stays contained and its contents do not.
   */
  spilled?: true;
  /**
   * Declared without a value, and not yet given one.
   *
   * `let source: string;` followed by `source = readFileSync(..)` inside a
   * `try` is an ordinary shape, and without this the assignment read as writing
   * to a name from an enclosing scope -- so the local was never recorded and
   * every flow out of it was lost. The first assignment fills it; a second one
   * is a real rebind.
   */
  pending?: true;
  /**
   * Handed to a *read* of a modelled collection, as the key or index.
   *
   * `node_section.get(src)` looks `src` up and does not retain it, so the key
   * does not leave -- which is right, and is the one thing the text referee
   * cannot check without being told what a dict is. Recorded so the
   * measurement can count those disagreements under their own name instead of
   * reporting them as the reader being too generous.
   *
   * A *write* is the opposite and needs no flag: `v.set(k, x)` keeps `k`, so it
   * goes through `inside` like any other value put in.
   */
  readKey?: true;
  /** Every way the value left the body. Empty means it provably did not. */
  escapes: Escape[];
  /** Uses this reader could not account for, named by the syntax around them. */
  unread: string[];
  /** Why the local cannot be followed at all. */
  why?: Unfollowable;
}

/** A call written in the body, and the locals handed to it. */
export interface CallSite {
  /** The name called, under the same receiver rule `feeds.ts` follows. */
  callee: string;
  /** 1-based line the call sits on. */
  line: number;
  /** Locals passed as a direct argument. */
  passed: string[];
  /**
   * The producers those locals were carrying **at this line**, with the path.
   *
   * Snapshotted here rather than looked up afterwards, because a name can be
   * assigned twice: `extraction = dict(...)` then, forty lines on,
   * `extraction = dict(...)` again. Reading the carries after the walk would
   * answer the first call with the second value's history. Straight-line
   * last-write-wins, which is what the shipped reader does.
   */
  reached: Array<[string, string[]]>;
  /** Calls whose result was passed straight in, with no name in between. */
  inline: string[];
}

/** One function body, read. */
export interface Body {
  /** The routine's name, or `<module>` for a file's top level. */
  routine: string;
  /**
   * Which kind of region this is.
   *
   * A file's top level is a region with locals and it belongs in the flow half:
   * a script that writes `const language = languageOf(file)` and then
   * `bump(files, language)` outside any routine is writing a pipeline, and
   * leaving it out made this reader lose to the shipped one on 93 flows that
   * had nothing to do with how many hops they were.
   *
   * It has no place in the escape half. A module-level binding is visible to the
   * whole file by definition, so asking whether it left the region it was made
   * in is not a question with an interesting answer.
   */
  scope: "routine" | "module";
  /** 1-based line the routine opens on. */
  line: number;
  /** Every local of this body, in source order. Nested closures are not this body. */
  locals: Local[];
  /** Every call this body makes, in source order. */
  calls: CallSite[];
  /** Bindings refused because the pattern was not one name. */
  destructured: number;
}

export type BodyReading =
  | { read: true; body: Body }
  | { read: false; why: DataflowWithheld };

/** A producer's result arriving at a consumer, and the locals it came through. */
export interface FlowChain {
  producer: string;
  consumer: string;
  /** The locals the value passed through. Empty when the call was handed straight over. */
  through: string[];
  /** 1-based line of the consuming call. */
  line: number;
}

/** 1-based line of a byte offset, counted the way an editor counts. */
const lineOf = (source: string, offset: number) =>
  source.slice(0, offset).split("\n").length;

/**
 * Node types that open a body of their own.
 *
 * By suffix, the way `feeds.ts` does it, so five grammars need no branches. A
 * value read from inside one of these has been captured by something that can
 * outlive the body, and names bound inside one are not this body's locals.
 */
const OPENS_BODY = /function|method|arrow|lambda|closure|constructor/;

/**
 * Node types that hold a value without moving it anywhere.
 *
 * A position inherited through one of these is the same position: `if (v > 3)`
 * reads `v` and lets nothing out, and `return (v)` still returns it. Listed
 * rather than assumed, because the default for an unrecognised shape is doubt
 * (see `unread`), and every entry here is a shape somebody has looked at.
 */
const TRANSPARENT =
  /^(program|source_file|module|block|statement_block|expression_statement|declaration_list|if_|else_|elif_|while_|for_|loop_|do_|switch_|match_|case_|when_|with_|try_statement|catch_|except_|finally_|parenthesized|binary|unary|not_operator|boolean_operator|comparison_operator|await|try_expression|reference_expression|as_expression|satisfies_expression|non_null_expression|type_assertion|ternary_expression|conditional_expression|template_|string_interpolation|interpolation|format_|sequence_expression|comment|range_expression|compound_statement|let_condition|condition|assert|string$|spread_element|update_expression|expression_list|slice|computed_property_name|concatenated_string|generator_expression|lexical_declaration|variable_declaration)/;

/*
 * The shapes above past `assert` were all added on evidence rather than by
 * guessing, and the evidence is the `unread` column of `measure:dataflow`. Each
 * was the top entry in it at some point, and each turned out to be a plain read:
 * a value interpolated into a string is printed, `v++` mutates it in place,
 * `a[1:2]` slices it, `...v` and `a, b` pass along whatever position they are
 * already in. Leaving one out is not wrong -- it costs a value counted out of a
 * floor -- which is exactly why the column exists.
 */

/**
 * Where a value can be, as it is walked down to.
 *
 * `plain` is a read that lets nothing out. Everything else is an `Escape`, or
 * the doubt that stands in for one.
 */
type Position = { kind: "plain" } | { kind: "escape"; as: Escape } | { kind: "unread"; at: string };

const PLAIN: Position = { kind: "plain" };

/** The name a call calls, under the receiver rule `feeds.ts` and `body.ts` share. */
function calleeName(node: Node): string | undefined {
  const callee = node.childForFieldName("function") ?? node.childForFieldName("macro");
  if (!callee) return undefined;
  if (callee.childCount === 0) return callee.text;
  const object = callee.childForFieldName("object") ?? callee.child(0);
  const member = callee.childForFieldName("property")
    ?? callee.childForFieldName("attribute")
    ?? callee.childForFieldName("field");
  if (object && member && (object.text === "self" || object.text === "this")) return member.text;
  return undefined;
}

/**
 * The method and receiver of `v.push(x)`, when a call is a method call.
 *
 * Separate from `calleeName`, which deliberately answers only for `self.foo()`
 * and `this.foo()` -- following an arbitrary receiver is how a body search
 * starts confirming arrows about libraries. Here the receiver is the point: the
 * question is what is being done *to* `v`.
 */
function methodOn(node: Node): { name: string; object: Node } | undefined {
  const callee = calleeOf(node);
  if (!callee || callee.childCount === 0) return undefined;
  const object = callee.childForFieldName("object") ?? callee.child(0);
  const member = callee.childForFieldName("property")
    ?? callee.childForFieldName("attribute")
    ?? callee.childForFieldName("field")
    ?? callee.childForFieldName("name");
  if (!object || !member || member.childCount !== 0) return undefined;
  return { name: member.text, object };
}

/**
 * Whether an expression makes an empty collection, with the type in the text.
 *
 * A literal by node type; `new Map()`, `list()` and `Vec::new()` by the name
 * they name. `Vec::new()` is read off the head of the scoped call rather than
 * its tail, because the tail is `new`.
 */
function makesCollection(node: Node): boolean {
  const inner = node;
  if (COLLECTION_LITERAL.test(inner.type)) return true;
  if (inner.type === "new_expression") {
    const made = inner.childForFieldName("constructor");
    return made ? COLLECTION_MAKERS.has(made.text.split(/::|\./)[0]!) : false;
  }
  // `vec![]` and `HashMap::from([..])` alike: a macro or a scoped call whose
  // first segment names the type.
  if (isCall(inner)) {
    const callee = calleeOf(inner)!;
    const head = callee.text.split(/::|\./)[0]!.replace(/!$/, "");
    return COLLECTION_MAKERS.has(head);
  }
  return false;
}

/** The callee expression of a call, whatever shape it has. */
const calleeOf = (node: Node): Node | undefined =>
  node.childForFieldName("function") ?? node.childForFieldName("macro") ?? undefined;

/** Whether a node is a call at all. */
const isCall = (node: Node): boolean => calleeOf(node) !== undefined;

/** The argument list of a call, if it has one. */
function argumentList(node: Node): Node | undefined {
  return node.childForFieldName("arguments")
    ?? node.childForFieldName("argument_list")
    ?? undefined;
}

/** The direct arguments of a call. */
function argumentsOf(node: Node): Node[] {
  const list = argumentList(node);
  if (!list) return [];
  const found: Node[] = [];
  for (let index = 0; index < list.childCount; index += 1) {
    const child = list.child(index);
    if (child) found.push(child);
  }
  return found;
}

/**
 * Node types that hold a value without changing whose result it is.
 *
 * The same list `feeds.ts` keeps, and for the same reason: named rather than
 * inferred from shape, because `[A()]` also contains exactly one call and what
 * it holds is an array.
 */
const WRAPS = /^(await|try|parenthesized|unary|reference|non_null|as_|satisfies)/;

/** Peel those wrappers, so `const v = await A()` still reads as A's result. */
function unwrap(node: Node): Node {
  let current = node;
  for (let depth = 0; depth < 4; depth += 1) {
    if (isCall(current)) return current;
    if (!WRAPS.test(current.type)) return current;
    let inner: Node | undefined;
    let calls = 0;
    for (let index = 0; index < current.childCount; index += 1) {
      const child = current.child(index);
      if (child && isCall(child)) { inner = child; calls += 1; }
    }
    if (calls !== 1 || !inner) return current;
    current = inner;
  }
  return current;
}

/**
 * Node types where a `left` or a `name` field is a binding rather than one side
 * of an operator.
 *
 * The distinction `body.ts` also draws, and leaving it out is not a subtle bug:
 * `total > 3` is a `binary_expression` with a `left` field, so every compared
 * value in the corpus read as a rebinding of itself and came back refused.
 *
 * Parameters are deliberately not here. The question is whether a value escapes
 * *the region it was made in*, and a parameter was made somewhere else.
 */
const BINDS = /(declarator|_declaration$|assignment|const_item|static_item|let_|^for_)/;

/**
 * The subset of those that *introduce* a name rather than overwrite one.
 *
 * Python is absent on purpose: `w = other()` is its only binding form, so a
 * second one is a rebind and not a shadow. The grammar is what says which.
 */
const DECLARES = /(declarator|let_declaration|const_item|static_item|^for_)/;

/** A declaration of a name with nothing assigned to it yet. */
function declaredEmpty(node: Node): Node | undefined {
  if (!DECLARES.test(node.type)) return undefined;
  if (node.childForFieldName("value") ?? node.childForFieldName("right")) return undefined;
  const name = node.childForFieldName("name") ?? node.childForFieldName("pattern");
  return name && name.childCount === 0 && /identifier$/.test(name.type) ? name : undefined;
}

/** The value a binding binds, when the binding is one name and nothing clever. */
function bindingOf(node: Node): { name: Node; value: Node } | undefined {
  if (!BINDS.test(node.type)) return undefined;
  const name = node.childForFieldName("name")
    ?? node.childForFieldName("pattern")
    ?? node.childForFieldName("left");
  if (!name) return undefined;
  const value = node.childForFieldName("value") ?? node.childForFieldName("right");
  return value ? { name, value } : undefined;
}

/** Whether a node is a bare name a reader would recognise as one. */
const isName = (node: Node): boolean =>
  node.childCount === 0 && /identifier$/.test(node.type);

/**
 * Whether the left of an assignment names a field rather than a variable.
 *
 * `self.cache = v` and `rows[i] = v` both put the value somewhere that outlives
 * the body; `v = other` does not.
 */
/** An access by index rather than by name: the shape that reads out an element. */
const SUBSCRIPT = /^(subscript_expression|index_expression|subscript)$/;

const isFieldTarget = (node: Node): boolean =>
  /^(member_expression|field_expression|subscript_expression|index_expression|attribute|subscript)$/
    .test(node.type);

/** Node types that make a structure out of what is put in them. */
const STRUCTURE =
  /^(array|object|tuple|list|dictionary|set|struct_expression|array_expression|object_pattern|jsx_|pair|key_value|field_initializer|shorthand)/;

/** Node types that send a value upwards rather than through a return. */
const THROWN = /^(throw|raise)/;
const YIELDED = /^yield/;
const RETURNED = /^return/;

/**
 * Expressions that make an empty collection, spelled so the *type* is visible.
 *
 * This is the whole gate on collection modelling, and it is a gate about
 * evidence rather than about convenience. `const v = []` says v is a list in the
 * grammar; `const v = load()` says nothing, and treating `v.push(x)` as a list
 * write there would be reading a naming convention as a fact -- which is the
 * mistake `constructs.ts` refuses Python over.
 *
 * By node type for the literals, and by name for the three constructor spellings
 * that are equally unambiguous: `new Map()` cannot be anything else.
 */
const COLLECTION_LITERAL =
  /^(array|object|dictionary|set|list|array_expression|struct_expression)$/;

/** Constructors and factories whose result is a collection and nothing else. */
const COLLECTION_MAKERS = new Set([
  // TypeScript, JavaScript
  "Map", "Set", "WeakMap", "WeakSet", "Array",
  // Python, where the builtin name is the type
  "list", "dict", "set", "frozenset", "tuple", "defaultdict", "OrderedDict", "Counter",
  // Rust, read off `Vec::new()` as the tail of a scoped call
  "Vec", "HashMap", "HashSet", "BTreeMap", "BTreeSet", "VecDeque",
]);

/**
 * Methods that put a value into a collection.
 *
 * Four languages in one list, and the overlap is real rather than lucky: `push`
 * is TypeScript and Rust, `add` is JavaScript and Python, `insert` is Python and
 * Rust. Only consulted when the receiver is a known collection, so a user type
 * with its own `add` is never read as one.
 */
const PUTS_IN = new Set([
  "push", "unshift", "add", "set", "append", "insert", "extend", "update",
  "setdefault", "push_back", "push_front", "put", "addAll", "insert_str",
]);

/**
 * Methods that take a value back out.
 *
 * A read out of a collection yields *something* that was put in -- not a
 * particular one, because there is no index being tracked. That is exactly the
 * abstraction: whatever comes out is one of the things that went in.
 */
const TAKES_OUT = new Set([
  "get", "pop", "at", "shift", "find", "values", "entries", "keys", "items",
  "getOrDefault", "peek", "front", "back", "last", "first", "iter", "into_iter",
]);

/**
 * Properties that are a fact *about* a collection rather than a thing in it.
 *
 * `return v.length` does not return `v`, and reading it as though it did counted
 * every length check as the collection leaving -- which is most real uses of
 * one. Safe here for the same reason `PUTS_IN` is: the collection's type came
 * from watching it be made, so what `.size` means is in the language rather than
 * in somebody's code. Not applied to any other value, where a named property
 * might well be the contents.
 */
const MEASURES_OF = new Set([
  "length", "size", "len", "count", "capacity", "byteLength",
  "isEmpty", "is_empty", "empty",
]);

/** How long a def-use chain may get. A cap, because a walk must terminate. */
const LONGEST_CHAIN = 8;
/** How many producers one local may carry, so a wide body cannot blow up. */
const MOST_CARRIED = 32;

/**
 * Every routine in a file, by name and node.
 *
 * The rule is `parse.ts`'s: a routine is a declaration that has `parameters`.
 * `constructs.ts` explains why `body.ts` is not used for this -- `bodiesOf`
 * hands back the value of a data declaration, so a constant reads as a routine
 * with a body of `3`.
 */
function routinesIn(tree: Node): Array<{ name: string; node: Node }> {
  const found: Array<{ name: string; node: Node }> = [];
  /** Function nodes a declaration above has already given a name to. */
  const named = new Set<number>();

  each(tree, (node) => {
    const name = node.childForFieldName("name");
    if (!name || name.childCount !== 0) return;
    const value = node.childForFieldName("value");
    const parameters = node.childForFieldName("parameters")
      ?? value?.childForFieldName("parameters");
    if (!parameters) return;
    if (value) named.add(value.id);
    found.push({ name: name.text, node });
  });

  /*
   * Callbacks nobody named are bodies too.
   *
   * Left out at first, and the measurement said so immediately: the shipped
   * one-hop reader searches a whole file, so a flow written inside
   * `items.map((x) => B(A(x)))` is one it finds and this one could not -- and
   * the confirmation gain came back *negative*, the new reader losing to the old
   * one on a shape it was simply not being shown.
   */
  each(tree, (node) => {
    if (named.has(node.id) || node.childForFieldName("name")) return;
    if (!OPENS_BODY.test(node.type) || !node.childForFieldName("body")) return;
    found.push({ name: "<anonymous>", node });
  });
  return found;
}

/**
 * Read one routine's body: its locals, what each carries, and what became of it.
 *
 * A single pre-order walk carrying a stack of scopes and the position the value
 * is in, because a binding is visible only to the code after it and inside it,
 * and where a name appears is the whole of what decides whether it escaped. The
 * parse facade has no parent pointers, so the position is passed downwards
 * rather than looked up.
 */
function readRoutine(
  source: string,
  routine: string,
  node: Node,
  language: Language,
  scope: "routine" | "module" = "routine",
): Body {
  const body: Body = {
    routine,
    scope,
    line: lineOf(source, node.startIndex),
    locals: [],
    calls: [],
    destructured: 0,
  };

  /** Locals by name, innermost scope last. Only this body's, never a closure's. */
  const scopes: Array<Map<string, Local>> = [new Map()];
  const held = (name: string): Local | undefined => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const local = scopes[index]!.get(name);
      if (local) return local;
    }
    return undefined;
  };

  /**
   * Whether a local's *current value* is unknown, as opposed to its history.
   *
   * The two refusals are not the same and treating them the same cost 63 flows
   * the shipped reader confirms. `shadowed` means a use of the name might mean
   * either of two values, so nothing can be said. `rebound` means the name
   * stopped standing for one value across the whole body -- which settles the
   * escape question and says nothing about the flow one, because at any given
   * line the name holds the last thing written to it. That is straight-line
   * last-write-wins, and it is what `feeds.ts` already does.
   */
  const unknowable = (local: Local): boolean => local.why === "shadowed";

  /**
   * Note every local named inside a collection read's key.
   *
   * Whole subtree rather than a bare name, because the key is often a field read
   * -- `health.get(c.provider)`. Nothing in that expression is retained by the
   * lookup, including `c`, and the text referee has no way to see that: its rule
   * is that a name inside a call's arguments was handed over.
   */
  const markKeys = (expression: Node): void => {
    each(expression, (node) => {
      if (!isName(node)) return;
      const key = held(node.text);
      if (key) key.readKey = true;
    });
  };

  /** Record a use of whatever local this name refers to, in this position. */
  const use = (name: string, position: Position): void => {
    const local = held(name);
    if (!local || local.why) return;
    if (position.kind === "escape") {
      if (!local.escapes.includes(position.as)) local.escapes.push(position.as);
    } else if (position.kind === "unread") {
      if (!local.unread.includes(position.at)) local.unread.push(position.at);
    }
  };

  /**
   * The collection a name refers to, if this body watched it being made.
   *
   * `undefined` for a parameter, for a value bound from an ordinary call, and
   * for a name this body never bound -- all three being cases where the type is
   * not in the text and a method name would be a guess.
   */
  const collectionNamed = (name: string): Local | undefined => {
    const local = held(name);
    return local && local.collection && !unknowable(local) ? local : undefined;
  };

  /**
   * The collection being read out of, when an expression is a read out of one.
   *
   * Three spellings, and no index in any of them: `v[i]`, `v.get(k)`, and the
   * bare `v` an iteration walks. What comes back is one of the things that went
   * in, and which one is the question deliberately not being asked.
   */
  const readsOutOf = (expression: Node, iterating = false): Local | undefined => {
    const inner = unwrap(expression);
    /*
     * Iterating is the third way out, and in real code it is the common one:
     * `for (const row of rows)` binds an element without naming an index at
     * all. Gated on being the iterable of a loop, because a bare `rows`
     * anywhere else is the collection itself -- `const other = rows` aliases it
     * rather than taking something out.
     */
    if (iterating && isName(inner)) return collectionNamed(inner.text);
    /*
     * A subscript takes an element out. A named property does not: `v.length`
     * and `v.size` are facts *about* the collection, and reading one as taking
     * a value out counted every length check as the contents escaping -- which
     * made a collection that plainly stays put report its contents as gone.
     */
    if (SUBSCRIPT.test(inner.type)) {
      const object = inner.childForFieldName("object")
        ?? inner.childForFieldName("value") ?? inner.child(0);
      if (object && isName(object)) return collectionNamed(object.text);
      return undefined;
    }
    if (isCall(inner)) {
      const method = methodOn(inner);
      if (method && TAKES_OUT.has(method.name) && isName(method.object)) {
        return collectionNamed(method.object.text);
      }
    }
    return undefined;
  };

  /** What one expression carries: the producers whose result reached it. */
  const carriedBy = (expression: Node, iterating = false): Map<string, string[]> => {
    const carried = new Map<string, string[]>();
    const inner = unwrap(expression);
    /*
     * Out of a collection first, because `v[i]` and `v.get(k)` are also a field
     * read and a call, and the ordinary readings of those carry nothing.
     */
    const from = readsOutOf(expression, iterating);
    if (from) {
      for (const [producer, hops] of from.holds) {
        if (carried.size >= MOST_CARRIED) break;
        if (hops.length < LONGEST_CHAIN) carried.set(producer, [...hops, from.name]);
      }
      return carried;
    }
    if (isCall(inner)) {
      const callee = calleeName(inner);
      if (callee) carried.set(callee, []);
      for (const argument of argumentsOf(inner)) {
        const peeled = unwrap(argument);
        if (isCall(peeled)) {
          const nested = calleeName(peeled);
          if (nested && !carried.has(nested)) carried.set(nested, []);
          continue;
        }
        if (!isName(peeled)) continue;
        const from = held(peeled.text);
        if (!from || unknowable(from)) continue;
        for (const [producer, hops] of from.carries) {
          if (carried.size >= MOST_CARRIED) break;
          if (!carried.has(producer) && hops.length < LONGEST_CHAIN) carried.set(producer, hops);
        }
      }
      return carried;
    }
    // A bare name on the right is an alias, and it carries what that name did.
    if (isName(inner)) {
      const from = held(inner.text);
      if (from && !unknowable(from)) {
        for (const [producer, hops] of from.carries) {
          if (carried.size >= MOST_CARRIED) break;
          if (hops.length < LONGEST_CHAIN) carried.set(producer, hops);
        }
      }
    }
    return carried;
  };

  /**
   * The position each child of a node sits in.
   *
   * `undefined` means "walk it with the position inherited from above", which
   * is what `TRANSPARENT` buys. Anything this returns for a child that is not
   * recognised at all becomes `unread`, which counts against `contained`.
   */
  const walk = (current: Node, position: Position, depth: number): void => {
    /*
     * A nested body is a boundary in both directions: its own bindings are not
     * this body's locals, and a read of one of ours from inside it is a capture.
     * The scope stack is not pushed, so `held` still resolves our names -- which
     * is the point, since resolving them is how the capture is seen at all.
     */
    if (depth > 0 && OPENS_BODY.test(current.type) && current.childForFieldName("body")) {
      each(current, (inside) => {
        if (isName(inside)) { use(inside.text, { kind: "escape", as: "captured-by-a-closure" }); return; }
        /*
         * A closure can see this body's locals, so a call inside one that takes
         * a local of ours is still a flow written in this region -- no call is
         * resolved to find it. Recorded only when one of ours is actually
         * passed; a flow entirely inside the closure belongs to the closure's
         * own body, which is read separately.
         */
        if (!isCall(inside)) return;
        const callee = calleeName(inside);
        if (!callee) return;
        const passed: string[] = [];
        for (const argument of argumentsOf(inside)) {
          const peeled = unwrap(argument);
          if (isName(peeled) && held(peeled.text)) passed.push(peeled.text);
        }
        if (passed.length > 0) {
          const reached: Array<[string, string[]]> = [];
          for (const name of passed) {
            for (const pair of held(name)!.carries) reached.push(pair);
          }
          body.calls.push({
            callee, line: lineOf(source, inside.startIndex), passed, reached, inline: [],
          });
        }
      });
      return;
    }

    if (isName(current)) {
      use(current.text, position);
      return;
    }

    // A call: the callee is not a use of a value, the arguments are, and a
    // method's receiver is a use too -- `rows.push(x)` can store `rows`.
    if (isCall(current)) {
      const callee = calleeName(current);
      const site: CallSite = {
        callee: callee ?? "",
        line: lineOf(source, current.startIndex),
        passed: [],
        reached: [],
        inline: [],
      };
      const list = argumentList(current);
      const receiver = calleeOf(current);

      /*
       * A write into a collection this body made: `v.push(widget())`.
       *
       * The receiver is not an escape here, which is the whole difference. It
       * used to be -- a method might store the thing it was called on -- and
       * that is still true of an unknown receiver. What a *known* collection's
       * `push` does is in the language rather than in somebody's code, and
       * `readsOutOf` is the other half of the same fact.
       */
      const method = methodOn(current);
      const into = method && PUTS_IN.has(method.name) && isName(method.object)
        ? collectionNamed(method.object.text)
        : undefined;
      if (into) {
        for (const argument of argumentsOf(current)) {
          if (/^[(),]$/.test(argument.type)) continue;
          for (const [producer, hops] of carriedBy(argument)) {
            if (into.holds.size >= MOST_CARRIED) break;
            if (!into.holds.has(producer) && hops.length < LONGEST_CHAIN) {
              into.holds.set(producer, hops);
            }
          }
          const peeled = unwrap(argument);
          /*
           * Recorded as *inside* rather than gone. Whether it left the body is
           * now the collection's question, and the collection may not have been
           * answered yet -- so it is resolved after the walk.
           */
          if (isName(peeled)) {
            const put = held(peeled.text);
            if (put && !put.why && !put.inside.includes(into.name)) {
              put.inside.push(into.name);
            }
          } else {
            walk(argument, { kind: "escape", as: "passed-to-a-call" }, depth + 1);
          }
        }
        return;
      }

      /*
       * A read out of one: `v[i]`, `v.get(k)`. The receiver is read and nothing
       * leaves, so the call is not walked as an escape at all -- and the
       * argument is an index, which is a use of the index and not of anything in
       * the collection.
       */
      const out = readsOutOf(current);
      if (out) {
        /*
         * And what came out is gone if this position lets anything go.
         * `return [...summaries.values()]` keeps `summaries` -- a new array is
         * what leaves -- and hands over everything that was in it. Marking that
         * only on the `v[i]` shape and not on this one reported every value in
         * a Map that gets drained as never having left.
         */
        if (position.kind === "escape") out.spilled = true;
        for (const argument of argumentsOf(current)) {
          markKeys(argument);
          walk(argument, PLAIN, depth + 1);
        }
        return;
      }

      if (receiver && !isName(receiver)) {
        const object = receiver.childForFieldName("object") ?? receiver.child(0);
        if (object && isName(object)) {
          use(object.text, { kind: "escape", as: "used-as-a-receiver" });
        } else if (object) {
          walk(object, { kind: "escape", as: "used-as-a-receiver" }, depth + 1);
        }
      }
      for (const argument of argumentsOf(current)) {
        const peeled = unwrap(argument);
        if (isCall(peeled) && !readsOutOf(argument)) {
          const nested = calleeName(peeled);
          if (nested) site.inline.push(nested);
        } else if (isName(peeled) && held(peeled.text)) {
          site.passed.push(peeled.text);
        }
        /*
         * What the argument carries, whatever shape it is: a bare name, a read
         * out of a collection, a nested call's result. Read through one
         * function rather than per shape, because the per-shape version knew
         * about names only -- so `use(v[i])` handed over something the reader
         * had watched go into `v` and reported carrying nothing.
         */
        for (const pair of carriedBy(argument)) site.reached.push(pair);
        walk(argument, { kind: "escape", as: "passed-to-a-call" }, depth + 1);
      }
      if (callee) body.calls.push(site);
      // Anything else under the call -- a type argument, the callee's own
      // subexpressions -- still has to be walked, or a use hides in it.
      for (let index = 0; index < current.childCount; index += 1) {
        const child = current.child(index);
        if (!child || child.id === list?.id || child.id === receiver?.id) continue;
        walk(child, position, depth + 1);
      }
      return;
    }

    // A binding, or an assignment, which are the same node in Python.
    const empty = declaredEmpty(current);
    if (empty && !held(empty.text)) {
      body.locals.push({
        name: empty.text,
        line: lineOf(source, empty.startIndex),
        carries: new Map(),
        holds: new Map(),
        inside: [],
        escapes: [],
        unread: [],
        pending: true,
      });
      scopes[scopes.length - 1]!.set(empty.text, body.locals[body.locals.length - 1]!);
      return;
    }

    const binding = bindingOf(current);
    if (binding && !isCall(current)) {
      const target = binding.name;
      /*
       * Whatever else is under this node -- and for a loop that is the entire
       * body. `for (const child of children(node))` is a binding *and* a block,
       * and returning after the binding threw the block away; the measurement
       * caught it as a flow the shipped one-hop reader confirms and this one
       * could not.
       */
      const rest = (): void => {
        for (let index = 0; index < current.childCount; index += 1) {
          const child = current.child(index);
          if (!child || child.id === target.id || child.id === binding.value.id) continue;
          walk(child, position, depth + 1);
        }
      };
      /*
       * A loop's iterable is read rather than handed anywhere: `for (const row
       * of rows)` does not pass `rows` to anything. Its contents do leave the
       * collection into `row`, and `row`'s own uses are what decide their fate.
       */
      const iterable = /^for_/.test(current.type) && readsOutOf(binding.value, true);
      if (iterable) {
        walk(binding.value, PLAIN, depth + 1);
      } else {
        walk(binding.value, positionForAssignment(target, current, position), depth + 1);
      }
      if (namesSomethingOuter(target, current)) {
        // The name is not this body's, so there is no local to record. The value
        // has already been counted as leaving through it.
        rest();
        return;
      }
      if (isFieldTarget(target)) {
        /*
         * `self.x = v` stores. The object being written to is an ordinary read,
         * and the *index* is not: `edge[key] = v` keeps `key` in the dictionary
         * just as surely as it keeps `v`.
         */
        const object = target.childForFieldName("object")
          ?? target.childForFieldName("value") ?? target.child(0);
        if (object) walk(object, PLAIN, depth + 1);
        const index = target.childForFieldName("index")
          ?? target.childForFieldName("subscript");
        if (index) walk(index, { kind: "escape", as: "into-a-structure" }, depth + 1);
        rest();
        return;
      }
      if (!isName(target)) {
        body.destructured += 1;
        walk(target, PLAIN, depth + 1);
        rest();
        return;
      }
      /*
       * `const x = v` gives the value a second name, and from here this reader
       * follows `x`. Whether the value stayed in the body is now a question
       * about `x`'s uses rather than `v`'s, so `v` stops being answerable --
       * counted against it, the way every other doubt is.
       *
       * Checked here rather than beside the other targets, because `self.x = v` and
       * `outer = v` are already counted where they happen and would otherwise be
       * counted twice. Only when the name is the whole of the value: `const x = v.field` reads
       * out of it and `f(v)` is already counted where it happens.
       */
      const aliased = unwrap(binding.value);
      if (isName(aliased)) use(aliased.text, { kind: "escape", as: "bound-to-another-name" });
      const existing = held(target.text);
      if (existing) {
        /*
         * The same node shape means two different things and they are different
         * refusals. A *declaration* of a name an outer scope already holds
         * shadows it: both values are real, and a use after the inner block
         * might be either. An *assignment* to a name already bound is a rebind:
         * the name stops standing for one value at all.
         *
         * Python has only the second form, which is why the two are told apart
         * by the node rather than by the scope: `w = other()` inside an `if` is
         * a rebind there and a shadow in TypeScript, and it is the grammar that
         * says which.
         */
        if (existing.pending) {
          // The value it was declared to hold, arriving. Not a rebind: there was
          // no earlier value for the name to stop standing for.
          delete existing.pending;
          existing.carries = carriedBy(binding.value, /^for_/.test(current.type));
          for (const [producer, hops] of existing.carries) {
            existing.carries.set(producer, [...hops, existing.name]);
          }
          if (makesCollection(unwrap(binding.value))) existing.collection = true;
          rest();
          return;
        }
        existing.why = DECLARES.test(current.type) ? "shadowed" : "rebound";
        if (!DECLARES.test(current.type)) {
          /*
           * Refused for the escape half and still followed for the flow half.
           * The name no longer stands for one value, so nothing can be said
           * about where *it* went -- but the flow question is about the value
           * bound here and now, which the shipped reader also answers
           * last-write-wins.
           */
          existing.carries = carriedBy(binding.value, /^for_/.test(current.type));
          for (const [producer, hops] of existing.carries) {
            existing.carries.set(producer, [...hops, existing.name]);
          }
          rest();
          return;
        }
      }
      const local: Local = {
        name: target.text,
        line: lineOf(source, target.startIndex),
        carries: carriedBy(binding.value, /^for_/.test(current.type)),
        holds: new Map(),
        inside: [],
        escapes: [],
        unread: [],
      };
      if (makesCollection(unwrap(binding.value))) local.collection = true;
      // Append this local to every path that reached it.
      for (const [producer, hops] of local.carries) {
        local.carries.set(producer, [...hops, local.name]);
      }
      body.locals.push(local);
      scopes[scopes.length - 1]!.set(local.name, local);
      rest();
      return;
    }

    if (RETURNED.test(current.type)) return descend(current, { kind: "escape", as: "returned" }, depth);
    if (THROWN.test(current.type)) return descend(current, { kind: "escape", as: "thrown" }, depth);
    if (YIELDED.test(current.type)) return descend(current, { kind: "escape", as: "yielded" }, depth);
    if (STRUCTURE.test(current.type)) {
      return descend(current, { kind: "escape", as: "into-a-structure" }, depth);
    }

    /*
     * `f(key=value)` hands `value` over and `key` is a parameter's name. Walked
     * by field rather than inherited, because inheriting marked the *name* as
     * escaping too -- and a local that happens to share a keyword's spelling
     * would then read as escaping on a line it does not appear in.
     */
    if (current.type === "keyword_argument") {
      const value = current.childForFieldName("value");
      if (value) walk(value, position, depth + 1);
      return;
    }

    /*
     * A read out of a collection, in a position that lets something go.
     *
     * `use(v[i])` does not hand over `v` -- it hands over one of the things in
     * `v`, and which one is the question not being asked. So the collection is
     * an ordinary read and its *contents* are what left. Without this the
     * collection itself was reported as passed to a call, and the vector case
     * came out no better than before.
     */
    const spilling = position.kind === "escape" ? readsOutOf(current) : undefined;
    if (spilling) {
      spilling.spilled = true;
      const object = current.childForFieldName("object")
        ?? current.childForFieldName("value") ?? current.child(0);
      if (object) walk(object, PLAIN, depth + 1);
      const index = current.childForFieldName("index") ?? current.childForFieldName("subscript");
      if (index) {
        markKeys(index);
        walk(index, PLAIN, depth + 1);
      }
      return;
    }

    // A field or index read: the object is read in whatever position we are in,
    // and the property name is not a value at all.
    if (isFieldTarget(current)) {
      const object = current.childForFieldName("object")
        ?? current.childForFieldName("value")
        ?? current.child(0);
      const property = current.childForFieldName("property")
        ?? current.childForFieldName("attribute")
        ?? current.childForFieldName("field");
      /*
       * A measurement of a collection this body made. Nothing the collection
       * refers to is in a number, so neither the collection nor its contents
       * went anywhere -- and the collection stays readable as one.
       */
      if (object && isName(object) && property && MEASURES_OF.has(property.text)
        && collectionNamed(object.text)) {
        walk(object, PLAIN, depth + 1);
        return;
      }
      if (object) walk(object, position, depth + 1);
      const index = current.childForFieldName("index") ?? current.childForFieldName("subscript");
      if (index) walk(index, PLAIN, depth + 1);
      return;
    }

    if (TRANSPARENT.test(current.type)) return descend(current, position, depth);

    /*
     * A shape nobody has looked at. Walked with doubt rather than with `plain`,
     * so a use inside it counts against `contained` and shows up by node type in
     * the report -- which is how the list above gets extended on evidence.
     */
    descend(current, { kind: "unread", at: current.type }, depth);
  };

  /** Walk the children of a node in one position. */
  const descend = (current: Node, position: Position, depth: number, tail?: Node): void => {
    /*
     * Python has function scope, not block scope, and treating its `if` bodies
     * as scopes was the single largest source of false `contained` in the
     * corpus: a name bound inside a branch vanished when the branch closed, so
     * every use of it afterwards resolved to nothing and the value looked as
     * though it had never been touched. The referee found 401 of them.
     */
    const opensScope = language !== "python" && /block|body|suite|arm|clause/.test(current.type);
    if (opensScope) scopes.push(new Map());
    for (let index = 0; index < current.childCount; index += 1) {
      const child = current.child(index);
      if (!child) continue;
      walk(child, child.id === tail?.id ? { kind: "escape", as: "returned" } : position, depth + 1);
    }
    if (opensScope) scopes.pop();
  };

  /**
   * Whether an assignment target names something outside this body.
   *
   * `faces = loaded` in `font.ts` is the shape: `faces` is a module variable and
   * the assignment reads exactly like a fresh binding, so the value was being
   * counted as a local that never left -- while it was being published to the
   * whole module. The referee found it, which is what a referee is for.
   *
   * Python is the exception and it is not an exception about scope: assignment
   * is its *only* binding form, so a name this body has not seen before is a
   * local being introduced. A `global` declaration would defeat that, and the
   * cost of missing one is a value counted contained that was not -- so it is
   * worth saying plainly that this reader does not read `global`.
   */
  const namesSomethingOuter = (target: Node, node: Node): boolean =>
    isName(target)
    && !DECLARES.test(node.type)
    && language !== "python"
    && held(target.text) === undefined;

  /**
   * Where the right-hand side of an assignment puts its value.
   *
   * The fallback is the position we are already in rather than `plain`, and a
   * binding does not launder a value: `stack.extend(c for c in n.children)` is
   * a `for` binding sitting inside a call's arguments, and reading its
   * right-hand side as safe let `n` come back as a value that never left.
   */
  const positionForAssignment = (target: Node, node: Node, inherited: Position): Position => {
    if (isFieldTarget(target)) return { kind: "escape", as: "stored-in-a-field" };
    if (namesSomethingOuter(target, node)) return { kind: "escape", as: "assigned-to-an-outer" };
    return inherited;
  };

  /*
   * Rust returns its last expression without saying so, and a value handed back
   * that way has left the body exactly as a `return` would. The tail is the last
   * child of the body block that is not a statement, which is what the grammar
   * means by one -- and it is walked *in place*, in the returned position,
   * rather than checked afterwards: by the time the block is finished its scope
   * has been popped and the name resolves to nothing.
   *
   * An arrow function with an expression body has no block at all, and the whole
   * of that expression is returned.
   */
  const routineBody = scope === "module"
    ? node
    : node.childForFieldName("body") ?? node.childForFieldName("value")?.childForFieldName("body");
  if (routineBody) {
    if (scope === "module" || /block|suite/.test(routineBody.type)) {
      descend(routineBody, PLAIN, 0, tailExpression(routineBody));
    } else {
      walk(routineBody, { kind: "escape", as: "returned" }, 0);
    }
  }

  /*
   * Now settle the values that went into a collection.
   *
   * A value inside a collection that never leaves the body has not left the
   * body either -- that is the whole point of following it in. But the
   * collection's own fate is only known once the walk is finished, and a
   * collection can sit inside another one, so this runs to a fixpoint.
   *
   * Capped, because a walk must terminate and a cycle of collections holding
   * each other is legal code. Hitting the cap leaves the values escaped, which
   * is the safe direction: an unresolved value counted as contained would be the
   * one thing this file must never do.
   */
  const byName = new Map<string, Local>();
  for (const local of body.locals) if (!byName.has(local.name)) byName.set(local.name, local);

  const escaped = (local: Local): boolean =>
    local.why !== undefined || local.escapes.length > 0 || local.unread.length > 0;

  for (let round = 0; round < 4; round += 1) {
    let changed = false;
    for (const local of body.locals) {
      if (local.inside.length === 0 || local.escapes.includes("left-inside-a-collection")) continue;
      for (const name of local.inside) {
        const container = byName.get(name);
        // A collection this body cannot account for takes its contents with it,
        // and so does one that was read out of into somewhere unfollowable.
        if (!container || escaped(container) || container.spilled) {
          local.escapes.push("left-inside-a-collection");
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }

  return body;
}

/** The implicit tail expression of a block, which is how Rust returns. */
function tailExpression(block: Node): Node | undefined {
  let last: Node | undefined;
  for (let index = 0; index < block.childCount; index += 1) {
    const child = block.child(index);
    if (!child || /^[{};]$/.test(child.type) || child.type === "comment") continue;
    last = child;
  }
  if (!last) return undefined;
  if (/_statement$|^let_declaration$|_declaration$|_item$/.test(last.type)) return undefined;
  return last;
}

/** Read the body of one named routine. */
export function readBody(source: string, routine: string, language: Language): BodyReading {
  const tree = parseSource(source, language);
  if (!tree) return { read: false, why: "unreadable" };
  const routines = routinesIn(tree.rootNode).filter((one) => one.name === routine);
  if (routines.length === 0) {
    // Declared and not a routine is a different answer from never declared.
    let declared = false;
    each(tree.rootNode, (node) => {
      const name = node.childForFieldName("name") ?? node.childForFieldName("left");
      if (name && name.childCount === 0 && name.text === routine) declared = true;
    });
    return { read: false, why: declared ? "no-body" : "not-declared" };
  }
  const node = routines[0]!.node;
  if (node.hasError) return { read: false, why: "incomplete" };
  let macro = false;
  each(node, (child) => { if (child.type === "token_tree") macro = true; });
  if (macro) return { read: false, why: "macro" };
  return { read: true, body: readRoutine(source, routine, node, language) };
}

/** Read every routine in a file. The measurement's door. */
export function readBodies(
  source: string,
  language: Language,
): { bodies: Body[]; refused: Map<DataflowWithheld, number> } {
  const refused = new Map<DataflowWithheld, number>();
  const bump = (why: DataflowWithheld) => refused.set(why, (refused.get(why) ?? 0) + 1);
  const tree = parseSource(source, language);
  if (!tree) { bump("unreadable"); return { bodies: [], refused }; }

  const bodies: Body[] = [];
  for (const one of routinesIn(tree.rootNode)) {
    if (one.node.hasError) { bump("incomplete"); continue; }
    let macro = false;
    each(one.node, (child) => { if (child.type === "token_tree") macro = true; });
    if (macro) { bump("macro"); continue; }
    bodies.push(readRoutine(source, one.name, one.node, language));
  }
  bodies.push(readRoutine(source, "<module>", tree.rootNode, language, "module"));
  return { bodies, refused };
}

/**
 * Whether a producer's result reaches a consumer in this body, and through what.
 *
 * Source order, first match: a chain found earlier is the one a person reading
 * the file would point at. Any pairing of the two name lists counts, the same
 * any-of-the-members rule `feeds.ts` uses, because a box standing for a concept
 * is satisfied by one of its names.
 */
export function chainFrom(
  body: Body,
  producers: string[],
  consumers: string[],
): FlowChain | undefined {
  for (const call of body.calls) {
    if (!consumers.includes(call.callee)) continue;
    for (const inline of call.inline) {
      if (producers.includes(inline)) {
        return { producer: inline, consumer: call.callee, through: [], line: call.line };
      }
    }
    for (const [producer, hops] of call.reached) {
      if (!producers.includes(producer)) continue;
      return { producer, consumer: call.callee, through: hops, line: call.line };
    }
  }
  return undefined;
}

/** Whether a value provably never left the body it was made in. */
export const contained = (local: Local): boolean =>
  local.why === undefined && local.escapes.length === 0 && local.unread.length === 0;
