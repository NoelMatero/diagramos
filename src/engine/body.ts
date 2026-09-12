/**
 * Arrows at function granularity: does *this* function actually reach that one?
 *
 * The file-level channels cannot answer the sharpest question a diagram asks.
 * Draw `handle_request -> log` when the logging call is in `reset_connection`
 * and every one of them is satisfied -- same file, shared importers, the lot --
 * so the arrow is wrong and nothing says a word.
 *
 * Scoping the search to one function's body answers it. The body comes from a
 * real parse (see `parse.ts`), so there is no brace counting to fool and no
 * stripping pass to get wrong: a string containing `}` is a string node, and a
 * name inside a comment is not a token.
 *
 * Everything here is written against tree-sitter's *fields* rather than node
 * types, which is what makes it work in five languages with no per-language
 * branches:
 *
 *   a declaration  has a `name` field
 *   a function     also has a `body` field
 *   a call         has a `function` field (or `macro`, which is how Rust logs)
 *
 * The search follows calls as far as they go inside one file. That used to
 * stop after one hop, on the reasoning that going deeper blesses everything.
 * Measured at function level on a real 640-line Rust file and on this repo's
 * densest TypeScript, that was false: both saturate at one hop, and unlimited
 * depth flags exactly as many arrows. What depth buys is the genuine
 * three-layer chain, which is a true arrow that one hop reports as broken.
 *
 * Discrimination survives because the receiver rule does the real work.
 * `Type::foo()` and `other.foo()` are not followed, so the search stays inside
 * the code this file owns and cannot wander into everything a library exposes.
 *
 * **One file is the limit here and it is not a budget.** `bodiesFor` looks a
 * callee's name up in the tree it already parsed, so the moment a chain steps
 * into another file it ends. `reach.ts` is the other half: it follows calls
 * `calls.ts` can *place*, across files, and it exists because most real chains
 * cross one on the first hop. This file stays the one-file reader, and
 * `ownTokensOf` below is the one concession it makes to the other one being
 * possible -- a name across a file boundary is held to a stricter standard
 * than a name inside it.
 */

import { each, parseSource, type Language, type Node, type Tree } from "./parse";

/**
 * Node types that mean "this introduces a name", by suffix.
 *
 * Needed because a `name` field alone is too generous: Rust parses
 * `Other::skip()` as a `scoped_identifier` whose `name` is `skip`, and without
 * this filter every qualified call in a file would read as a declaration of
 * its own last segment. The list is suffixes, not grammar-specific types, and
 * covers all five languages -- `function_declaration`, `function_item`,
 * `function_definition`, `variable_declarator`, `macro_definition`,
 * `const_item`, `assignment` and the rest all land on one of these.
 */
const DECLARES = [
  "_declaration", "_definition", "_item", "_declarator", "_signature", "assignment",
];

/**
 * Where a `left` field is a binding rather than one side of an operator.
 *
 * `for (const entry of list)` introduces `entry`, and every grammar puts it in
 * a `left` field on a statement. `a + b` has a `left` field too, on an
 * *expression*, and reading that as a declaration of `a` would be nonsense --
 * which is the whole reason this is a separate list and not one more suffix
 * above.
 */
const BINDS = ["_statement", "_clause"];

/**
 * Body node types that hold statements rather than members.
 *
 * This is the whole `callable` / `data` distinction. A `block` runs; a
 * `class_body` or a `field_declaration_list` merely contains. The difference
 * matters in exactly one place -- the self-support rule below -- where a
 * member that runs is expected to reach the rest of its concept and one that
 * holds data is the ground the rest reaches *to*.
 */
const RUNS = new Set(["block", "statement_block", "token_tree", "expression_statement"]);

/** Value nodes that are a function in disguise: `const f = () => {...}`. */
const FUNCTIONISH = /function|arrow|lambda|closure/;

export type DeclarationKind = "callable" | "data";

/**
 * A leaf that is a name rather than prose.
 *
 * Every grammar tried calls these something ending in `identifier` --
 * `identifier`, `type_identifier`, `field_identifier`, `property_identifier`,
 * `private_property_identifier`. Nothing else qualifies, which is what keeps
 * `string_fragment` and `comment` out: a symbol written inside a string or a
 * comment is a mention, and the whole check turns on it not being a use.
 */
const IDENTIFIER = /identifier$/;

const isName = (node: Node): boolean => node.childCount === 0 && IDENTIFIER.test(node.type);

/**
 * Keywords that introduce a name inside a macro body.
 *
 * The one place approximation survives, and it is unavoidable: the contents of
 * a macro invocation are not code, they are tokens waiting for an expansion
 * that has not happened, so no grammar parses them. `lazy_static! { static ref
 * LOGGER: ... }` is the case that forced this -- an extremely ordinary way to
 * declare a Rust global, invisible to the parse and previously matched by a
 * `static\s+ref\s+` regex doing exactly the same guessing, less precisely.
 */
const DECLARING = new Set([
  "static", "const", "fn", "let", "ref", "struct", "enum", "type", "mod", "trait",
]);

/**
 * One place a name is introduced: the declaring node, the identifier it
 * introduces, and whether it came out of macro soup rather than a real parse.
 */
interface Declaration {
  node: Node;
  nameNode: Node;
  soup: boolean;
}

const declarationCache = new WeakMap<Tree, Map<string, Declaration[]>>();

/** Every name this file introduces, and where. */
function declarationNodes(tree: Tree): Map<string, Declaration[]> {
  const hit = declarationCache.get(tree);
  if (hit) return hit;

  const found = new Map<string, Declaration[]>();
  declarationCache.set(tree, found);
  const record = (declaration: Declaration) => {
    const list = found.get(declaration.nameNode.text) ?? [];
    list.push(declaration);
    found.set(declaration.nameNode.text, list);
  };

  each(tree.rootNode, (node) => {
    if (node.type === "token_tree") {
      // Macro soup: a name is whatever follows a declaring keyword.
      let armed = false;
      each(node, (leaf) => {
        if (leaf.childCount > 0) return;
        if (armed && isName(leaf)) record({ node, nameNode: leaf, soup: true });
        armed = DECLARING.has(leaf.text);
      });
      return;
    }
    const declares = DECLARES.some((suffix) => node.type.endsWith(suffix));
    const binds = declares || BINDS.some((suffix) => node.type.endsWith(suffix));
    // `left` is what a for-of binding and a Python assignment call their name.
    const name = (declares ? node.childForFieldName("name") : null)
      // `parameter` is what `catch (error)` calls the name it introduces.
      ?? (binds ? node.childForFieldName("left") ?? node.childForFieldName("parameter") : null);
    if (!name || name.childCount > 0) return; // a destructuring pattern, not a name
    record({ node, nameNode: name, soup: false });
  });
  return found;
}

/**
 * The node holding what a declaration *does*.
 *
 * Three shapes, in order. A `body` field covers functions, methods, classes
 * and traits. A `value` field covers everything assigned a name, whether that
 * is a function (`const f = () => {}`, where the block is what matters) or a
 * plain value (`const shape = { corner: rounded() }`, where the value itself
 * is the thing a claim can be about). Failing both, the first block-like node
 * anywhere inside: that is Rust's `macro_rules!`, whose expansion is a
 * `token_tree` buried one level down inside a rule.
 *
 * A declaration with none of the three -- a trait method, an overload
 * signature -- has no body, and the caller counts that rather than guessing.
 */
function bodyNode(node: Node): Node | undefined {
  const direct = node.childForFieldName("body");
  if (direct) return direct;

  const value = node.childForFieldName("value") ?? node.childForFieldName("right");
  if (value) return FUNCTIONISH.test(value.type) ? value.childForFieldName("body") ?? value : value;

  let found: Node | undefined;
  each(node, (current) => {
    if (!found && current !== node && RUNS.has(current.type)) found = current;
  });
  return found;
}

function declarationsIn(
  tree: Tree,
  symbol: string,
): Array<{ kind: DeclarationKind; node: Node; body: Node | undefined }> {
  return (declarationNodes(tree).get(symbol) ?? []).map(({ node, soup }) => {
    // A name read out of macro soup is data with no readable body, always. The
    // tokens around it are a template, not a function: the `{ ... }` after
    // `static ref LOGGER` is the initialiser, and calling it a body would make
    // every macro-declared global look like something that ought to run.
    if (soup) return { kind: "data" as const, node, body: undefined };
    const body = bodyNode(node);
    return { kind: (body && RUNS.has(body.type) ? "callable" : "data") as DeclarationKind, node, body };
  });
}

function treeOf(source: string, language: Language): Tree | undefined {
  return parseSource(source, language);
}

/**
 * The body of a named declaration, as text.
 *
 * `undefined` when there is no declaration, when there is one with no body at
 * all, or when the language has no grammar. The caller counts those and falls
 * back rather than guessing.
 */
export function bodyOf(source: string, symbol: string, language: Language): string | undefined {
  return bodiesOf(source, symbol, language)[0];
}

/**
 * Every body this name has here, not just the first.
 *
 * One name can be declared more than once in a file, and Rust `impl` blocks
 * make that ordinary rather than exotic -- `orangutan/src/lib.rs` declares both
 * `register` and `reregister` twice. Reading only the first was a false alarm
 * waiting to happen: a method that logs in the second `impl` and not the first
 * reported as never reaching the logging at all, which is the loud direction.
 */
export function bodiesOf(source: string, symbol: string, language: Language): string[] {
  const tree = treeOf(source, language);
  if (!tree) return [];
  return declarationsIn(tree, symbol)
    .map((declaration) => declaration.body?.text)
    .filter((body): body is string => body !== undefined);
}

/** Declaration kinds and bodies for one name, for callers that need both. */
export function declarationsOf(
  source: string,
  symbol: string,
  language: Language,
): Array<{ kind: DeclarationKind; body: string | undefined }> {
  const tree = treeOf(source, language);
  if (!tree) return [];
  return declarationsIn(tree, symbol)
    .map(({ kind, body }) => ({ kind, body: body?.text }));
}

/**
 * What a file has to say about one symbol: is it introduced here, and is it
 * used beyond its own introduction?
 *
 * Both numbers are exact now rather than counted with a word-boundary regex
 * over blanked text. A declaration is a declaration node; a use is an
 * identifier token that is not one of those declarations' own name nodes. That
 * removes the two approximations the old count carried -- a name in a comment
 * inflating the total, and `#private` fields defeating the word boundary.
 *
 * `unreadable` reports that the parse hit an error somewhere in the file. It
 * replaces the old lexer's whole-file bail, and it is strictly better news:
 * tree-sitter recovers locally, so the rest of the file was still read
 * properly. It is surfaced anyway, because a claim judged against a file we
 * could not fully parse deserves to be counted separately.
 */
export function symbolCounts(
  source: string,
  symbol: string,
  language: Language,
): { declared: boolean; used: number; unreadable: boolean } | undefined {
  const tree = treeOf(source, language);
  if (!tree) return undefined;

  const declaring = new Set<number>();
  for (const declaration of declarationNodes(tree).get(symbol) ?? []) {
    declaring.add(declaration.nameNode.id);
  }

  let total = 0;
  each(tree.rootNode, (node) => {
    if (isName(node) && node.text === symbol) total += 1;
  });

  return {
    declared: declaring.size > 0,
    used: Math.max(0, total - declaring.size),
    unreadable: tree.rootNode.hasError === true,
  };
}

/**
 * Calls made *by* this body, to functions that could be in the same file.
 *
 * Bare `foo(...)` and `foo!(...)`, plus an explicit `self.foo(...)` or
 * `this.foo(...)`. Deliberately not `Type::foo(...)` or `other.foo(...)`: those
 * are somebody else's `foo`, and following them is how an earlier version of
 * this blessed two arrows that were plainly false -- a body calling mio's
 * `EventSet::readable()` was read as calling the local `readable`, which does
 * log.
 *
 * There is no list of keywords to exclude any more. `if (x)` was only ever
 * mistaken for a call because a regex cannot see that it is an if-statement.
 */
const RECEIVERS = new Set(["self", "this"]);

function calleesOf(node: Node): Set<string> {
  const names = new Set<string>();
  each(node, (current) => {
    const callee = current.childForFieldName("function") ?? current.childForFieldName("macro");
    if (!callee) return;
    if (callee.childCount === 0) { names.add(callee.text); return; }

    const object = callee.childForFieldName("object") ?? callee.child(0);
    const member = callee.childForFieldName("property")
      ?? callee.childForFieldName("attribute")
      ?? callee.childForFieldName("field");
    // A qualified path is somebody else's namespace. `scoped_identifier` fails
    // this test on the receiver, which is the same answer for a different
    // reason, and both are the answer we want.
    if (object && member && RECEIVERS.has(object.text)) names.add(member.text);
  });
  return names;
}

/** The calls in a fragment of code. Parsed, so `if (x)` is not one of them. */
export function callsIn(code: string, language: Language): Set<string> {
  const tree = treeOf(code, language);
  return tree ? calleesOf(tree.rootNode) : new Set<string>();
}

/**
 * Leaf node types that are a number the code actually uses.
 *
 * The same three-fact trick the rest of this file runs on: every grammar tried
 * names its numeric leaves something containing `number`, `integer` or `float`
 * -- `number` in TS and JS, `integer_literal` and `float_literal` in Rust,
 * `integer` and `float` in Python. So there is one pattern here and no
 * per-language table.
 *
 * What it buys is the thing a regex over the file text cannot have. `255` in a
 * doc comment is not a leaf of any of these types, and `"777"` in a string is
 * `string_content`. Both are invisible here for free, which matters because a
 * board's number claim must be refuted by the code and never by a sentence
 * about the code -- `src/lib.rs` says "255 chefs" in a comment nine lines above
 * the `ThreadPool::new(255)` that actually means it, and a text search cannot
 * tell those apart.
 */
const NUMERIC = /number|integer|float/;

/**
 * One numeric literal as a number, or `undefined` when it is not one.
 *
 * Grammars hand back the literal exactly as written, so the same value arrives
 * in several spellings and all of them have to compare equal: `2_048` and
 * `2048` are one number, `0x800` is that number too, and Rust writes its type
 * on the end as `2048u32`. Anything left over after that is not a number this
 * can reason about and is skipped rather than guessed at.
 */
function numberOf(text: string): number | undefined {
  const cleaned = text.replace(/_/g, "").replace(/[iuf](8|16|32|64|128|size)$/i, "");
  if (!/^[0-9]/.test(cleaned)) return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Every number this file actually uses, as values rather than as text.
 *
 * `undefined` when the language has no grammar, which the caller counts rather
 * than reading as an empty file: "there are no numbers here" and "nobody could
 * look" are the two sentences this engine keeps apart everywhere else.
 */
export function numbersIn(source: string, language: Language): Set<number> | undefined {
  const tree = treeOf(source, language);
  if (!tree) return undefined;
  return numbersUnder(tree.rootNode);
}

function numbersUnder(node: Node): Set<number> {
  const found = new Set<number>();
  each(node, (current) => {
    if (current.childCount > 0 || !NUMERIC.test(current.type)) return;
    const value = numberOf(current.text);
    if (value !== undefined) found.add(value);
  });
  return found;
}

/**
 * The numbers one named declaration uses -- its signature and its body.
 *
 * The scope that makes a number claim worth making. Measured on the board this
 * came from: `src/lib.rs` writes `2048` five times, for a slab, a read buffer
 * and a doc comment, so a claim checked against the whole file stays green
 * after the slab it was about changed to 4096. Narrowed to `Orangutan::new`,
 * the same claim fails the moment the number does, which is the entire point.
 *
 * `undefined` means the question could not be asked -- no grammar, or nothing
 * here declares that name -- and never "no numbers". The second of those is
 * already the node check's `missing-symbol` finding, and answering it again
 * here would be one mistake reported as two.
 */
export function numbersInSymbol(
  source: string,
  symbol: string,
  language: Language,
): Set<number> | undefined {
  const tree = treeOf(source, language);
  if (!tree) return undefined;
  const declarations = declarationNodes(tree).get(symbol) ?? [];
  if (declarations.length === 0) return undefined;
  const found = new Set<number>();
  // Every declaration of the name, for the reason `bodiesOf` reads them all: an
  // `impl` block splitting a method in two is ordinary, and a number in the
  // half this did not read is a false alarm waiting to happen.
  for (const { node } of declarations) {
    for (const value of numbersUnder(node)) found.add(value);
  }
  return found;
}

/**
 * Every name mentioned under a node, once.
 *
 * This is what "the body names the target" means now, and it is stricter than
 * the substring search it replaces: `log_line` in a comment is not a name, and
 * neither is `log_line` inside a string. It is also what makes `#private`
 * class fields work, which the old word-boundary search could not match.
 */
/**
 * Held against the tree, not in one map keyed by node id.
 *
 * A node id is an address inside one tree. Two trees alive at once never
 * collide, and a tree that has fallen out of the parse cache is freed -- so
 * the next tree can be handed the same addresses, and a global map keyed on
 * them answers a question about the new file with the old file's tokens. That
 * is not a slow cache, it is a wrong answer, and the shape of it is the worst
 * one here: it depends on how many *other* files were parsed in between, so
 * the same board gives two different verdicts depending on what else the check
 * happened to read. Found when the cross-file walk in `reach.ts` started
 * parsing more files and one arrow's confirmation in `measure:reach` moved
 * without anything about that arrow changing.
 *
 * A `WeakMap` on the tree makes the lifetimes agree by construction: the
 * entries go when the tree does, which is what the old `NODE_CACHE_LIMIT`
 * was approximating with a wholesale clear.
 */
const tokenCache = new WeakMap<Tree, Map<number, Set<string>>>();
const ownTokenCache = new WeakMap<Tree, Map<number, Set<string>>>();
const callCache = new WeakMap<Tree, Map<number, Set<string>>>();

function inTree<T>(cache: WeakMap<Tree, Map<number, T>>, tree: Tree): Map<number, T> {
  const hit = cache.get(tree);
  if (hit) return hit;
  const made = new Map<number, T>();
  cache.set(tree, made);
  return made;
}

function tokensOf(tree: Tree, node: Node): Set<string> {
  const byId = inTree(tokenCache, tree);
  const hit = byId.get(node.id);
  if (hit) return hit;
  const found = new Set<string>();
  byId.set(node.id, found);
  each(node, (current) => { if (isName(current)) found.add(current.text); });
  return found;
}

function callsCached(tree: Tree, node: Node): Set<string> {
  const byId = inTree(callCache, tree);
  const hit = byId.get(node.id);
  if (hit) return hit;
  const found = calleesOf(node);
  byId.set(node.id, found);
  return found;
}

/**
 * Nothing to free: the per-node sets are held against their tree and go when
 * `resetEngineCache` drops it. Kept as a no-op because the test setup calls
 * it, and a reset that quietly stopped resetting would be worse than one that
 * says outright there is nothing left to reset.
 */
export function resetBodyCache(): void {}

/**
 * The fields a grammar puts a member's own name on.
 *
 * Fields rather than node types, for `docs/reading-a-grammar.md`'s reason: a
 * list of names -- `field_expression|member_expression|attribute` -- is a
 * second list that has to agree with a first one and silently will not. All
 * three grammars agree on the *field*: Rust's `cause.source()` puts `source`
 * on `field`, TypeScript's `x.foo()` puts `foo` on `property`, Python's on
 * `attribute`. A reader matching these needs no branch per language and grows
 * none when a fourth arrives.
 */
const MEMBER_FIELDS = ["field", "property", "attribute"];

/** The fields a grammar puts the thing a member is read off on. */
const RECEIVER_FIELDS = ["value", "object"];

/** The receivers that mean "the thing this routine is part of". */
const OWN_RECEIVER = new Set(["self", "this"]);

/**
 * A qualified name -- `path` and `name` on the same node, which in these
 * grammars is Rust's `Parser::new()` and nothing else.
 *
 * Kept apart from the member fields above rather than folded in, because
 * `name` on its own is the field every *declaration* uses: a rule that read
 * `name` as a member would eat a TypeScript `const x = f()` (a
 * `variable_declarator` carrying `name` and `value`) and a Python keyword
 * argument. `path` beside it is what makes the clause mean "a qualified
 * reference" rather than "anything with a name".
 *
 * That it belongs here at all is the second thing the corpus corrected. A
 * path call writes the type at the call site, which reads like better
 * evidence than `x.foo()` -- so it was let through, on the argument that none
 * of the 51 it was first measured against had been one. Measured over the
 * whole Rust population instead, letting it through bought 17
 * confirmations and cost 5 more wrong ones: `ripgrep`'s `config.rs` has a
 * test `fn basic` whose body writes `Parser::new()`, and an arrow to
 * `parse.rs#new` went green on it. Three right for every wrong is not a rate
 * this file accepts, so the argument lost to the number.
 */
const PATH_FIELD = "path";
const QUALIFIED_NAME_FIELD = "name";

/**
 * Identifier tokens under a node, minus the ones that are somebody else's
 * member.
 *
 * The strict standard, for a target in **another file**. `tokensOf` counts
 * every identifier leaf, which is right inside one file -- there is no second
 * thing the name could mean there -- and wrong across files, where there very
 * much is. `anyhow`'s `chain.rs` has `fn len` whose body writes
 * `cause.source()`, so an arrow from `context.rs#source` to `chain.rs#len` came
 * back confirmed: the body writes the word `source`, and it is
 * `StdError::source` on a trait object, nothing to do with the other file.
 * Rust went green on **60 arrows in 1,572 that its own compiler says never
 * reach**, nearly all of this one shape; with this rule, 9. Found by
 * `measure:reach`, and paid for in that file's "what it costs".
 *
 * It is the rule ee3b29e already settled for *following* a hop -- "`Type::foo`
 * and `other.foo` are somebody else's foo" -- applied to the place the search
 * stops rather than only to the places it steps through. `self.foo` and
 * `this.foo` still count: those are members of the type the routine belongs
 * to, and a Rust `impl` block for that type may well be in the other file.
 */
function ownTokensOf(tree: Tree, node: Node): Set<string> {
  const byId = inTree(ownTokenCache, tree);
  const hit = byId.get(node.id);
  if (hit) return hit;
  const found = new Set<string>();
  byId.set(node.id, found);
  const field = (at: Node, names: string[]): Node | undefined => {
    for (const one of names) {
      const child = at.childForFieldName(one);
      if (child) return child;
    }
    return undefined;
  };
  const walk = (current: Node): void => {
    if (isName(current)) { found.add(current.text); return; }
    const member = field(current, MEMBER_FIELDS);
    const through = member
      ? field(current, RECEIVER_FIELDS)
      : current.childForFieldName(QUALIFIED_NAME_FIELD)
        ? current.childForFieldName(PATH_FIELD)
        : null;
    if (through && !OWN_RECEIVER.has(through.text)) {
      // The left side is still read: `a.b.c` says something about `a`, and
      // `crate::chain::len` says something about `crate::chain`.
      walk(through);
      return;
    }
    for (let index = 0; index < current.childCount; index += 1) {
      const child = current.child(index);
      if (child) walk(child);
    }
  };
  walk(node);
  return found;
}

function namesAny(tree: Tree, body: Node, targets: string[], own = false): boolean {
  const tokens = own ? ownTokensOf(tree, body) : tokensOf(tree, body);
  return targets.some((target) => tokens.has(target));
}

/** Where the relationship was written, and on which line. */
export interface DeclarationHit {
  /** The target name that was found. */
  name: string;
  /** 1-based, so it can be quoted at somebody. */
  line: number;
  where: "declaration" | "enclosing";
}

const lineOf = (source: string, index: number): number =>
  source.slice(0, index).split("\n").length;

/**
 * Identifier tokens in a declaration but not in its body.
 *
 * The body is skipped by node identity rather than by text, so a nested
 * declaration inside it is skipped with it. What is left is the line or two a
 * reader would point at: the signature, the parameter types, the field's own
 * type -- `conns: Slab<Client>` in Rust, `conns: Slab<Client>` on a TypeScript
 * class, `conns: Slab[Client]` in Python, all the same shape to a walk that
 * reads tokens and stops at a body.
 *
 * Every name outside the body counts, rather than only the ones standing in a
 * type position. Both readings were measured against the seventeen arrows this
 * came from and they confirm the same five, so the one with no list of field
 * names in it wins. It is also the safe direction to be wrong in: this only
 * ever confirms, and it is asked only where the alternative reading is not
 * "these are unrelated" but "we read the wrong lines".
 *
 * The declared name itself is dropped. A declaration always names itself, and
 * confirming an arrow on that would be the search finding its own footprint.
 */
function declarationTokens(node: Node, body: Node | undefined, nameNode: Node): Set<string> {
  const tokens = new Set<string>();
  const walk = (current: Node): void => {
    if (current.id === body?.id) return;
    if (isName(current)) {
      if (current.id !== nameNode.id) tokens.add(current.text);
      return;
    }
    for (let index = 0; index < current.childCount; index += 1) {
      const child = current.child(index);
      if (child) walk(child);
    }
  };
  walk(node);
  return tokens;
}

/**
 * The chain of nodes from the root down to one node, excluding it.
 *
 * tree-sitter's own node has a `parent`, and this file's `Node` deliberately
 * does not: the interface in `parse.ts` is the small set of things every
 * question here needs, and widening it for one caller would be paying in every
 * other. One walk per declaration, on the data path only, is cheaper than that.
 */
function trailTo(tree: Tree, target: Node): Node[] {
  let found: Node[] | undefined;
  const walk = (node: Node, trail: Node[]): void => {
    if (found) return;
    if (node.id === target.id) { found = [...trail]; return; }
    trail.push(node);
    for (let index = 0; index < node.childCount && !found; index += 1) {
      const child = node.child(index);
      if (child) walk(child, trail);
    }
    trail.pop();
  };
  walk(tree.rootNode, []);
  return found ?? [];
}

/**
 * The name of the block a declaration lives inside.
 *
 * `impl Client`, `class Foo`, `trait Bar` -- the header line above a method,
 * which is where a language writes down that the method belongs to the type.
 * The nearest enclosing declaration wins, and both `type` and `name` are read
 * because grammars disagree about which one holds it: Rust's `impl_item` calls
 * it `type`, everything else calls it `name`.
 */
function enclosingNames(tree: Tree, node: Node): { tokens: Set<string>; line: number } | undefined {
  const trail = trailTo(tree, node);
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    const ancestor = trail[index]!;
    if (!DECLARES.some((suffix) => ancestor.type.endsWith(suffix))) continue;
    const heads = [ancestor.childForFieldName("type"), ancestor.childForFieldName("name")]
      .filter((head): head is Node => head !== null);
    if (heads.length === 0) continue;
    const tokens = new Set<string>();
    for (const head of heads) each(head, (leaf) => { if (isName(leaf)) tokens.add(leaf.text); });
    return { tokens, line: ancestor.startIndex };
  }
  return undefined;
}

/**
 * Where a relationship to data is written, when it is not written in a body.
 *
 * The body search answers "does this reach that", and for two functions it is
 * the whole question. For an end that names a struct, a static or a field it is
 * the wrong question asked of the wrong lines: the relationship is stated in
 * the signature (`-> &mut Client`), in the field's own type (`conns:
 * Slab<Client>`), or in the header of the block the method sits in (`impl
 * Client`) -- three places this engine already parses and never read.
 *
 * Confirm-only, like everything else here. Finding the name proves the two are
 * related; not finding it proves nothing, and the caller counts that.
 */
export function declarationMentions(
  source: string,
  symbol: string,
  targets: string[],
  language: Language,
): DeclarationHit | undefined {
  const tree = treeOf(source, language);
  if (!tree) return undefined;

  for (const { node, nameNode, soup } of declarationNodes(tree).get(symbol) ?? []) {
    // Macro soup is tokens waiting for an expansion, not a declaration. There
    // is no signature in it to read and no block header above it to trust.
    if (soup) continue;

    const own = declarationTokens(node, bodyNode(node), nameNode);
    const named = targets.find((target) => own.has(target));
    if (named) return { name: named, line: lineOf(source, node.startIndex), where: "declaration" };

    const enclosing = enclosingNames(tree, node);
    const outer = enclosing && targets.find((target) => enclosing.tokens.has(target));
    if (enclosing && outer) {
      return { name: outer, line: lineOf(source, enclosing.line), where: "enclosing" };
    }
  }
  return undefined;
}

/**
 * Walk a route the author named, and say where it stops holding.
 *
 * Every link is a plain direct check -- does this body name the next name --
 * because the path is written down and there is nothing left to infer. That is
 * the whole trade: naming the hops buys a chain of arbitrary depth out of the
 * one-hop machinery, and buys a report that can point at the broken link
 * instead of shrugging at the arrow.
 *
 * Returns the hop that failed, or `undefined` when the whole chain holds.
 * `unreadable` is a link whose body could not be found at all, which is not
 * evidence of a break.
 */
export function chainBreak(
  source: string,
  from: string,
  via: string[],
  targets: string[],
  language: Language,
): { at: string; next: string; unreadable: boolean } | undefined {
  const tree = treeOf(source, language);
  const links = [from, ...via];

  for (let index = 0; index < links.length; index += 1) {
    const here = links[index]!;
    // The last hop has to land on the box itself, and any one of its symbols
    // will do -- the same any-of-the-members rule the direct check uses.
    const wanted = index + 1 < links.length ? [links[index + 1]!] : targets;
    const bodies = tree
      ? declarationsIn(tree, here).map((d) => d.body).filter((b): b is Node => b !== undefined)
      : [];
    if (!tree || bodies.length === 0) {
      return { at: here, next: wanted.join(" or "), unreadable: true };
    }
    // Any one of this name's declarations carrying the link is enough. A method
    // declared in two impl blocks is one name to the diagram.
    if (!bodies.some((body) => namesAny(tree, body, wanted))) {
      return { at: here, next: wanted.join(" or "), unreadable: false };
    }
  }
  return undefined;
}

/**
 * Members of a concept box that show no trace of the concept.
 *
 * Membership has a hole: cut the deepest call and every caller still calls a
 * listed member, so the arrows stay green while the concept is hollow. The rule
 * that closes it is that a member which *runs* has to name another member --
 * so a claim is not trusted, it is checked, like everything else here.
 *
 * Data members are the ground and are exempt: a `static` holding a file handle
 * is what the rest of the concept reaches, and asking it to reach back would
 * flag every well-formed box. A single-member box is exempt too, having
 * nothing to connect to.
 */
export function unsupportedMembers(
  source: string,
  members: string[],
  language: Language,
): string[] {
  if (members.length < 2) return [];
  const tree = treeOf(source, language);
  if (!tree) return [];

  const orphans: string[] = [];
  for (const member of members) {
    const callable = declarationsIn(tree, member)
      .filter((declaration) => declaration.kind === "callable" && declaration.body !== undefined);
    if (callable.length === 0) continue;
    const others = members.filter((other) => other !== member);
    // Supported if *any* of its declarations shows a trace. One `impl` block
    // carrying the concept is the name carrying the concept.
    const supported = callable.some((declaration) => namesAny(tree, declaration.body!, others));
    if (!supported) orphans.push(member);
  }
  return orphans;
}

/**
 * How many bodies one question will read before giving up.
 *
 * A search that cannot finish returns `undefined` rather than `false`: not
 * finding a path is not evidence there is none, and a budget running out is
 * the least evidential thing there is. So the arrow is skipped and counted.
 *
 * Well past any single file measured -- the densest here has 23 functions --
 * and it exists so one pathological file cannot make the per-turn check slow.
 */
const VISIT_CAP = 300;

/**
 * Whether a function in `source` reaches any of `targets`, directly or through
 * calls inside the same file.
 *
 * `undefined` means the question could not be asked -- no grammar for the
 * language, or no readable body for the starting symbol -- which the caller
 * counts rather than treating as a no.
 */
export function reaches(
  source: string,
  from: string,
  targets: string[],
  language: Language,
  /**
   * Whether the targets live in another file, in which case a name written as
   * somebody else's member is not evidence about them. See `ownTokensOf`.
   */
  elsewhere = false,
): boolean | undefined {
  const tree = treeOf(source, language);
  // No grammar is no answer. Refusing the question is the quiet direction; a
  // guess would be the loud one.
  if (!tree) return undefined;

  const bodies = new Map<string, Node[]>();
  const bodiesFor = (name: string): Node[] => {
    if (!bodies.has(name)) {
      bodies.set(
        name,
        declarationsIn(tree, name).map((d) => d.body).filter((b): b is Node => b !== undefined),
      );
    }
    return bodies.get(name)!;
  };
  if (bodiesFor(from).length === 0) return undefined;

  const seen = new Set<string>([from]);
  let frontier = [from];
  let read = 0;

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const name of frontier) {
      for (const body of bodiesFor(name)) {
        if (namesAny(tree, body, targets, elsewhere)) return true;
        if (read >= VISIT_CAP) return undefined;
        read += 1;
        for (const callee of callsCached(tree, body)) {
          if (seen.has(callee)) continue;
          seen.add(callee);
          next.push(callee);
        }
      }
    }
    frontier = next;
  }
  return false;
}
