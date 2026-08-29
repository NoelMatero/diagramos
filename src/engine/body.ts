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
 * Every name mentioned under a node, once.
 *
 * This is what "the body names the target" means now, and it is stricter than
 * the substring search it replaces: `log_line` in a comment is not a name, and
 * neither is `log_line` inside a string. It is also what makes `#private`
 * class fields work, which the old word-boundary search could not match.
 */
const tokenCache = new Map<number, Set<string>>();
const callCache = new Map<number, Set<string>>();

/**
 * Node ids belong to a tree, and a tree gets freed when it falls out of the
 * parse cache -- so these would grow forever inside the long-lived MCP server.
 * Dropped wholesale rather than tracked per tree: rebuilding a token set is
 * microseconds, and bookkeeping to save that would cost more than it saves.
 */
const NODE_CACHE_LIMIT = 4096;

function bound(cache: Map<number, unknown>): void {
  if (cache.size > NODE_CACHE_LIMIT) cache.clear();
}

function tokensOf(node: Node): Set<string> {
  const hit = tokenCache.get(node.id);
  if (hit) return hit;
  bound(tokenCache);
  const found = new Set<string>();
  tokenCache.set(node.id, found);
  each(node, (current) => { if (isName(current)) found.add(current.text); });
  return found;
}

function callsCached(node: Node): Set<string> {
  const hit = callCache.get(node.id);
  if (hit) return hit;
  bound(callCache);
  const found = calleesOf(node);
  callCache.set(node.id, found);
  return found;
}

/** Free the per-node caches. Trees are freed by `resetEngineCache`. */
export function resetBodyCache(): void {
  tokenCache.clear();
  callCache.clear();
}

function namesAny(body: Node, targets: string[]): boolean {
  const tokens = tokensOf(body);
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
    if (bodies.length === 0) {
      return { at: here, next: wanted.join(" or "), unreadable: true };
    }
    // Any one of this name's declarations carrying the link is enough. A method
    // declared in two impl blocks is one name to the diagram.
    if (!bodies.some((body) => namesAny(body, wanted))) {
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
    const supported = callable.some((declaration) => namesAny(declaration.body!, others));
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
        if (namesAny(body, targets)) return true;
        if (read >= VISIT_CAP) return undefined;
        read += 1;
        for (const callee of callsCached(body)) {
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
