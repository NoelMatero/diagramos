/**
 * What a plain name means at the spot it is written (#468).
 *
 * Every reader that places a call starts here: `foo()` is a call to whatever
 * `foo` names *at that spot*, and the answer is one of three -- declared in
 * this repository, declared outside it, or not known. This file answers it the
 * way each language does, by walking out from the spot through the scopes that
 * can see it and stopping at the first one that binds the name.
 *
 * It replaces three readings that each kept a private notion of scope, and
 * the census of every call (#467) found all three wrong:
 *
 *   - "declared in this file" was any declaration at any depth. A Rust
 *     `type Err` in a `FromStr` impl made every `Err(...)` in the file the
 *     file's own (467 calls), a method `fn drop` made `drop(x)` the method,
 *     and a Python class's `def set` made `set()` in its methods the class's.
 *     None of those can be what the call means: a type is not a value, an
 *     impl's methods and a class body's names are not in scope anywhere else.
 *   - "bound by the routine" was every leaf under a `name`, `pattern` or
 *     `left` field. `left` is also an operator's left operand, so
 *     `isinstance(a, b) and c` bound `isinstance`; `pattern` is also a
 *     constructor, so `if let Some(v)` bound `Some`. 2,400 Rust and 2,000
 *     Python calls to built-ins read as values the routine held.
 *   - one wildcard import anywhere switched every built-in off for the whole
 *     file, though Rust scopes a `use` to its block and a test module's
 *     `use super::*` reaches nothing outside it.
 *
 * ## The rules, per language
 *
 * Read from the grammars' own scope structure, not from a list of cases:
 *
 *   TypeScript  blocks hold `let`, `const`, `class` and functions; a function
 *               holds its parameters and every `var` under it; the module
 *               holds its imports. A name nothing binds is a global, either
 *               the language's or the host's (`builtins.ts`).
 *   Python      a function holds its parameters and every name it assigns,
 *               anywhere in it, unless declared `global`/`nonlocal`; a class
 *               body's names are visible in the class body only, never in the
 *               functions inside it; the module holds the rest. Then
 *               `builtins`.
 *   Rust        a block holds its items for the whole block and each `let`
 *               from the statement after it; patterns bind in their arm; a
 *               function item sees no local of the function around it. Names
 *               live in three namespaces and a call looks in one: `Err(..)`
 *               in values, where `type Err` is not, `write!` in macros. Then
 *               the prelude.
 *
 * A `use` or `import` with a `*` is judged where it is written, after the
 * names that scope declares itself. One into the repository is opened: if it
 * cannot be read, or it does export the name, the answer is not known -- which
 * one is meant is not in this file. One into a crate outside the repository
 * (`std`, `pyo3`) can only bring in something outside it.
 *
 * Measure first, then trust: the census reads every call against a compiler,
 * and the refusals this must keep are in `tests/engine-names.test.ts`.
 */
import { providedByHost, providedByLanguage } from "./builtins";
import { wholeName } from "./declared";
import { each, incomplete, parametersOf, parseSource, unreadIn, type Language, type Node, type Tree } from "./parse";

/**
 * What a name means at one spot.
 *
 *   bound      a parameter, a pattern, a local the routine holds: a value,
 *              never a declaration this reader could follow
 *   declared   declared in this file, in a scope the spot sees. Whether it
 *              runs when called is the caller's question (#402)
 *   imported   brought in by an import the spot sees; the file's import
 *              table says from where
 *   wildcard   brought in by a wildcard, from the one file that declares it
 *   outside    provided by the language or the host, or by a wildcard that
 *              reaches outside the repository
 *   unknown    `ambiguous`: two declarations in one scope and the text does
 *              not say which wins. `unbound`: nothing visible binds it and no
 *              wildcard can be ruled out
 */
export type Meaning =
  | { at: "bound" }
  | { at: "declared" }
  | { at: "imported" }
  | { at: "wildcard"; file: string }
  | { at: "outside" }
  | { at: "unknown"; why: "ambiguous" | "unbound" };

/**
 * What a wildcard brings in, for one name: `has` it, `lacks` it (read, and
 * not there), reaches only `outside` the repository, or `unknown`. `has`
 * names the file declaring it when one file does, and nothing when it comes
 * by way of another import.
 */
export type WildcardAnswer = { has: string | undefined } | "lacks" | "outside" | "unknown";

/**
 * How a name came to be in a scope. `assigned` is a declaration by assignment
 * at a module's or a class's top -- Python's `json = None` beside an `import
 * json` in a `try`, TypeScript's `namespace f` merged into `function f` -- and
 * gives way to a real declaration of the same name rather than colliding.
 */
type Entry = "bound" | "declared" | "imported" | "assigned";

interface Scope {
  /** Value names, and when each becomes visible. */
  values: Map<string, { entry: Entry; from: number }>;
  /**
   * Rust's `let`s, each visible from the end of its statement: `let len =
   * len(x)` calls the function `len` declared in the same block, and only
   * the code after it sees the new value.
   */
  lets: Map<string, number[]>;
  /** Rust only: names `macro_rules!` declares here. */
  macros: Set<string>;
  /** Rust only: names a `struct`, `enum`, `union`, `type`, `trait` or `mod` declares here. */
  types: Set<string>;
  /** Names declared twice over here, where the text does not say which wins. */
  twice: Set<string>;
  /** Wildcards written in this scope, as specifiers. */
  wildcards: string[];
  /** Python: names a `global`/`nonlocal` sends to an outer scope. */
  elsewhere: Set<string>;
  /** Python: a class body, visible only to code directly in it. */
  classBody: boolean;
}

/** Everything one tree's lookups need, built once per tree. */
interface Index {
  parents: Map<number, Node>;
  scopes: Map<number, Scope | null>;
}

const indexes = new WeakMap<Tree, Index>();

function indexOf(tree: Tree): Index {
  const known = indexes.get(tree);
  if (known) return known;
  const parents = new Map<number, Node>();
  const visit = (node: Node): void => {
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (!child) continue;
      parents.set(child.id, node);
      if (child.childCount > 0) visit(child);
    }
  };
  visit(tree.rootNode);
  const made: Index = { parents, scopes: new Map() };
  indexes.set(tree, made);
  return made;
}

/**
 * The tree a node belongs to. Not `parseSource` again: reading one call can
 * open other files, the parse cache can let this one go meanwhile, and a
 * fresh tree has none of the old one's nodes -- every lookup from a call in
 * it then climbed nowhere and answered "not known" (Nest's `forwardRef`,
 * written in a constructor's parameter decorator, after its import was
 * followed through three barrels).
 */
function treeOf(node: Node, source: string, language: Language): Tree | undefined {
  return (node as Node & { tree?: Tree }).tree ?? parseSource(source, language);
}

/** The nodes enclosing `node`, innermost first, the root last. */
export function enclosing(source: string, language: Language, node: Node): Node[] {
  const tree = treeOf(node, source, language);
  if (!tree) return [];
  const { parents } = indexOf(tree);
  const out: Node[] = [];
  for (let at = parents.get(node.id); at; at = parents.get(at.id)) out.push(at);
  return out;
}

/** Direct children, which no grammar exposes as an array. */
function kids(node: Node): Node[] {
  const out: Node[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child) out.push(child);
  }
  return out;
}

/** Named children, with the field each fills. */
function fielded(node: Node): Array<{ node: Node; field: string | null }> {
  const out: Array<{ node: Node; field: string | null }> = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child && child.isNamed) out.push({ node: child, field: node.fieldNameForChild(index) });
  }
  return out;
}

/**
 * A scope's statements, read through the parser's own recovery: a stretch it
 * could not parse becomes an `ERROR` node holding the statements after it,
 * and in zx's `core.ts` that was the whole top of the file -- every import in
 * it unseen, 78 calls in four TypeScript projects. The old file-wide reader
 * never noticed; a reader of scopes has to look inside.
 */
function statementsOf(node: Node): Node[] {
  const out: Node[] = [];
  for (const child of kids(node)) {
    if (child.type === "ERROR") out.push(...statementsOf(child));
    else out.push(child);
  }
  return out;
}

function emptyScope(): Scope {
  return {
    values: new Map(), lets: new Map(), macros: new Set(), types: new Set(), twice: new Set(), wildcards: [],
    elsewhere: new Set(), classBody: false,
  };
}

/**
 * Put a name in a scope. Two *declarations* of one name in one scope are the
 * doubt `ambiguous` has always meant; a declaration and an import are too,
 * which is what `bindingsIn` already said at the file's top. Anything bound
 * twice -- `let x` shadowing `let x`, a name assigned in two branches -- is
 * still one value the routine holds.
 */
function put(scope: Scope, name: string, entry: Entry, from = 0): void {
  const had = scope.values.get(name);
  if (!had) { scope.values.set(name, { entry, from }); return; }
  if (entry === "assigned" && had.entry !== "bound") return;
  if (had.entry === "assigned" && entry !== "bound") { scope.values.set(name, { entry, from }); return; }
  /*
   * Declared here and imported too: which one the call means is not in the
   * text. Declared here twice -- one per `#[cfg]`, one per branch of an `if`
   * -- is still this file's, under this name, which is all a placement says.
   * The same import written twice over is one name; two imports of it from
   * two places are `bindingsIn`'s to call ambiguous.
   */
  if (had.entry !== entry && (had.entry === "imported" || entry === "imported") && had.entry !== "bound" && entry !== "bound") {
    scope.twice.add(name);
    return;
  }
  // A plain binding outranks a declaration of the same name in one scope:
  // `def f` and a later `f = wrap(f)` both bind it, and the value is the doubt.
  if (had.entry === "bound" || entry === "bound") scope.values.set(name, { entry: "bound", from: Math.min(had.from, from) });
}

/* ------------------------------------------------------------- TypeScript */

const TS_FUNCTION = new Set([
  "function_declaration", "generator_function_declaration", "function_expression", "function",
  "generator_function", "arrow_function", "method_definition",
]);
const TS_BLOCK = new Set(["statement_block", "class_static_block", "switch_body"]);

/** Every name a TypeScript binding pattern binds. */
function tsPattern(node: Node | null, into: (name: string) => void): void {
  if (!node) return;
  switch (node.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      into(node.text);
      return;
    case "pair_pattern":
      tsPattern(node.childForFieldName("value"), into);
      return;
    case "object_assignment_pattern":
    case "assignment_pattern":
      tsPattern(node.childForFieldName("left"), into);
      return;
    default:
      for (const { node: child, field } of fielded(node)) {
        if (field === "type" || field === "value" && node.type !== "pair_pattern" || field === "right") continue;
        if (/pattern|identifier/.test(child.type) || child.type === "rest_pattern") tsPattern(child, into);
      }
  }
}

/** The parameters a TypeScript function binds. */
function tsParameters(fn: Node, scope: Scope): void {
  const single = fn.childForFieldName("parameter");
  if (single) tsPattern(single, (name) => put(scope, name, "bound"));
  const list = parametersOf(fn);
  if (!list) return;
  for (const one of kids(list)) {
    if (!one.isNamed) continue;
    const pattern = one.childForFieldName("pattern") ?? (one.type === "identifier" || /pattern/.test(one.type) ? one : null);
    tsPattern(pattern, (name) => put(scope, name, "bound"));
  }
}

/** A declaration statement's names, into the scope that holds them. */
function tsDeclaration(node: Node, scope: Scope, vars: boolean): void {
  switch (node.type) {
    case "export_statement": {
      const inner = node.childForFieldName("declaration");
      if (inner) tsDeclaration(inner, scope, vars);
      return;
    }
    case "function_declaration":
    case "generator_function_declaration":
    case "class_declaration":
    case "abstract_class_declaration":
    case "enum_declaration": {
      const name = node.childForFieldName("name");
      if (name && name.childCount === 0) put(scope, name.text, "declared");
      return;
    }
    case "interface_declaration":
    case "type_alias_declaration": {
      // Types: never what a call names, and still what this file declares.
      const name = node.childForFieldName("name");
      if (name && name.childCount === 0) scope.types.add(name.text);
      return;
    }
    case "internal_module":
    case "module": {
      const name = node.childForFieldName("name");
      if (name && name.childCount === 0) put(scope, name.text, "assigned");
      return;
    }
    case "ambient_declaration":
      /*
       * `declare function f()`: a declaration with no body, of a value that
       * runs. Only here -- a `function_signature` written as a statement is
       * an overload, and the function it overloads is declared below it.
       */
      for (const child of kids(node)) {
        const name = child.type === "function_signature" ? child.childForFieldName("name") : null;
        if (name) put(scope, name.text, "declared");
        else tsDeclaration(child, scope, vars);
      }
      return;
    case "expression_statement":
      for (const child of kids(node)) if (child.type === "internal_module") tsDeclaration(child, scope, vars);
      return;
    case "lexical_declaration":
    case "variable_declaration": {
      if ((node.type === "variable_declaration") !== vars) return;
      for (const declarator of kids(node)) {
        if (declarator.type !== "variable_declarator") continue;
        const name = declarator.childForFieldName("name");
        if (!name) continue;
        // A plain name is a declaration whose value the caller asks about
        // (#402); a destructuring pattern holds parts of a value.
        if (name.type === "identifier") put(scope, name.text, "declared");
        else tsPattern(name, (one) => put(scope, one, "bound"));
      }
      return;
    }
    default:
  }
}

/** `var` is the function's, wherever in it the statement is written. */
function tsVars(node: Node, scope: Scope): void {
  for (const child of kids(node)) {
    if (TS_FUNCTION.has(child.type) || child.type === "class_declaration" || child.type === "class") continue;
    if (child.type === "variable_declaration") tsDeclaration(child, scope, true);
    else if (child.childCount > 0) tsVars(child, scope);
  }
}

function tsScope(node: Node, root = false): Scope | null {
  if (node.type === "program" || root) {
    const scope = emptyScope();
    for (const statement of statementsOf(node)) {
      tsDeclaration(statement, scope, false);
      importNames(statement, scope, "ts");
    }
    tsVars(node, scope);
    return scope;
  }
  if (TS_FUNCTION.has(node.type)) {
    const scope = emptyScope();
    tsParameters(node, scope);
    // A named function expression sees its own name.
    if (node.type === "function_expression" || node.type === "function") {
      const name = node.childForFieldName("name");
      if (name) put(scope, name.text, "declared");
    }
    const body = node.childForFieldName("body");
    if (body) {
      if (body.type === "statement_block") for (const statement of kids(body)) tsDeclaration(statement, scope, false);
      tsVars(body, scope);
    }
    return scope;
  }
  if (TS_BLOCK.has(node.type)) {
    const scope = emptyScope();
    for (const statement of kids(node)) tsDeclaration(statement, scope, false);
    return scope.values.size > 0 ? scope : null;
  }
  if (node.type === "class" || node.type === "class_declaration" || node.type === "abstract_class_declaration") {
    // Inside a class, its own name is the class.
    const name = node.childForFieldName("name");
    if (!name) return null;
    const scope = emptyScope();
    put(scope, name.text, "declared");
    return scope;
  }
  if (node.type === "catch_clause") {
    const scope = emptyScope();
    tsPattern(node.childForFieldName("parameter"), (name) => put(scope, name, "bound"));
    return scope;
  }
  if (node.type === "for_statement") {
    const scope = emptyScope();
    const init = node.childForFieldName("initializer");
    if (init?.type === "lexical_declaration") {
      for (const declarator of kids(init)) {
        if (declarator.type === "variable_declarator") tsPattern(declarator.childForFieldName("name"), (name) => put(scope, name, "bound"));
      }
    }
    return scope;
  }
  if (node.type === "for_in_statement") {
    // Bound only when declared there: `for (const k of ks)`. A bare `k` assigns
    // to a name some outer scope holds.
    if (!kids(node).some((child) => child.type === "const" || child.type === "let" || child.type === "var")) return null;
    const scope = emptyScope();
    tsPattern(node.childForFieldName("left"), (name) => put(scope, name, "bound"));
    return scope;
  }
  return null;
}

/* ----------------------------------------------------------------- Python */

const PY_FUNCTION = new Set(["function_definition", "lambda"]);
const PY_COMPREHENSION = new Set(["list_comprehension", "set_comprehension", "dictionary_comprehension", "generator_expression"]);

/** Every name a Python assignment target binds. Attributes and subscripts bind nothing. */
function pyTarget(node: Node | null, into: (name: string) => void): void {
  if (!node) return;
  switch (node.type) {
    case "identifier":
      into(node.text);
      return;
    case "pattern_list":
    case "tuple_pattern":
    case "list_pattern":
    case "tuple":
    case "list":
    case "parenthesized_expression":
    case "list_splat_pattern":
    case "as_pattern_target":
    case "expression_list":
      for (const child of kids(node)) if (child.isNamed) pyTarget(child, into);
      return;
    default:
  }
}

/** The parameters a Python function or lambda binds. */
function pyParameters(fn: Node, scope: Scope): void {
  const list = parametersOf(fn);
  if (!list) return;
  for (const one of kids(list)) {
    if (one.type === "identifier") put(scope, one.text, "bound");
    else if (one.type === "default_parameter" || one.type === "typed_default_parameter") {
      const name = one.childForFieldName("name");
      if (name) put(scope, name.text, "bound");
    } else if (one.type === "typed_parameter" || one.type === "list_splat_pattern" || one.type === "dictionary_splat_pattern") {
      const name = kids(one).find((child) => child.type === "identifier");
      if (name) put(scope, name.text, "bound");
    } else if (one.type === "tuple_pattern") {
      pyTarget(one, (name) => put(scope, name, "bound"));
    }
  }
}

/**
 * The names a Python block binds, not descending into the functions, classes
 * and comprehensions inside it -- each of those is its own scope -- but taking
 * the names of the functions and classes it declares.
 *
 * `local` is the function-scope reading: an assignment there binds a value the
 * routine holds. At a module or class top an assignment is a declaration,
 * whose value the caller asks about.
 */
function pyBlock(node: Node, scope: Scope, local: boolean): void {
  for (const child of kids(node)) {
    switch (child.type) {
      case "function_definition":
      case "class_definition": {
        const name = child.childForFieldName("name");
        if (name) put(scope, name.text, "declared");
        continue;
      }
      case "decorated_definition": {
        const inner = child.childForFieldName("definition");
        const name = inner?.childForFieldName("name");
        if (name) put(scope, name.text, "declared");
        continue;
      }
      case "lambda":
      case "list_comprehension":
      case "set_comprehension":
      case "dictionary_comprehension":
      case "generator_expression":
        // Their own scope -- except that a walrus inside a comprehension binds
        // in the enclosing function. Rare, and binding it here is the generous
        // direction: a value the routine holds.
        each(child, (inner) => {
          if (inner.type === "named_expression") pyTarget(inner.childForFieldName("name"), (n) => put(scope, n, "bound"));
        });
        continue;
      case "assignment":
      case "augmented_assignment": {
        pyTarget(child.childForFieldName("left"), (name) => put(scope, name, local ? "bound" : "assigned"));
        const right = child.childForFieldName("right");
        if (right) pyBlock(right, scope, local);
        continue;
      }
      case "for_statement":
      case "for_in_clause":
        pyTarget(child.childForFieldName("left"), (name) => put(scope, name, "bound"));
        break;
      case "as_pattern": {
        const alias = child.childForFieldName("alias");
        pyTarget(alias, (name) => put(scope, name, "bound"));
        break;
      }
      case "named_expression":
        pyTarget(child.childForFieldName("name"), (name) => put(scope, name, "bound"));
        break;
      case "global_statement":
      case "nonlocal_statement":
        for (const name of kids(child)) if (name.type === "identifier") scope.elsewhere.add(name.text);
        continue;
      case "import_statement":
      case "import_from_statement":
      case "future_import_statement":
        importNames(child, scope, "python");
        continue;
      default:
    }
    if (child.childCount > 0) pyBlock(child, scope, local);
  }
}

function pyScope(node: Node, root = false): Scope | null {
  if (node.type === "module" || root) {
    const scope = emptyScope();
    pyBlock(node, scope, false);
    return scope;
  }
  if (PY_FUNCTION.has(node.type)) {
    const scope = emptyScope();
    pyParameters(node, scope);
    const body = node.childForFieldName("body");
    if (body) pyBlock(node.type === "lambda" ? node : body, scope, true);
    for (const name of scope.elsewhere) scope.values.delete(name);
    return scope;
  }
  if (node.type === "class_definition") {
    const scope = emptyScope();
    scope.classBody = true;
    const body = node.childForFieldName("body");
    if (body) pyBlock(body, scope, false);
    return scope;
  }
  if (PY_COMPREHENSION.has(node.type)) {
    const scope = emptyScope();
    for (const clause of kids(node)) {
      if (clause.type === "for_in_clause") pyTarget(clause.childForFieldName("left"), (name) => put(scope, name, "bound"));
    }
    return scope;
  }
  return null;
}

/* ------------------------------------------------------------------- Rust */

/** Every name a Rust pattern binds. */
function rustPattern(node: Node | null, into: (name: string) => void): void {
  if (!node) return;
  switch (node.type) {
    case "identifier":
      /*
       * A lone name in a pattern binds, unless a constant, a unit struct or a
       * variant of that name is in scope -- `None`, `X`. That needs the scope
       * the pattern is being read to build; Rust's own lint names the
       * convention that settles it in practice: bindings are snake_case.
       */
      if (!/^[A-Z]/.test(node.text)) into(node.text);
      return;
    case "shorthand_field_identifier":
      into(node.text);
      return;
    case "tuple_struct_pattern":
    case "struct_pattern":
      for (const { node: child, field } of fielded(node)) if (field !== "type") rustPattern(child, into);
      return;
    case "field_pattern": {
      const pattern = node.childForFieldName("pattern");
      if (pattern) rustPattern(pattern, into);
      else rustPattern(node.childForFieldName("name"), into);
      return;
    }
    case "scoped_identifier":
    case "scoped_type_identifier":
    case "generic_type":
    case "macro_invocation":
    case "field_identifier":
    case "type_identifier":
      return;
    default:
      for (const { node: child, field } of fielded(node)) if (field !== "type" && field !== "value") rustPattern(child, into);
  }
}

/** Whether a struct declares a constructor value: `struct T(u8);` and `struct U;` do, `struct S { .. }` does not. */
function rustStructIsValue(node: Node): boolean {
  const body = node.childForFieldName("body");
  return !body || body.type === "ordered_field_declaration_list";
}

/** A Rust item's names, into the block or module that holds it. */
function rustItem(node: Node, scope: Scope): void {
  const name = node.childForFieldName("name");
  switch (node.type) {
    case "function_item":
    case "function_signature_item":
    case "const_item":
    case "static_item":
      if (name) put(scope, name.text, "declared");
      return;
    case "struct_item":
      if (name) scope.types.add(name.text);
      if (name && rustStructIsValue(node)) put(scope, name.text, "declared");
      return;
    case "enum_item":
    case "union_item":
    case "type_item":
    case "trait_item":
    case "mod_item":
      if (name) scope.types.add(name.text);
      return;
    case "macro_definition":
      if (name) scope.macros.add(name.text);
      return;
    case "foreign_mod_item": {
      const body = node.childForFieldName("body");
      if (body) for (const child of kids(body)) rustItem(child, scope);
      return;
    }
    case "use_declaration":
      importNames(node, scope, "rust");
      return;
    default:
  }
}

function rustScope(node: Node, root = false): Scope | null {
  switch (root ? "source_file" : node.type) {
    case "source_file":
    case "declaration_list":
    case "block": {
      // A `declaration_list` is a module's body only under a `mod`; under an
      // `impl` or a `trait` its items are members, reached through a type.
      const scope = emptyScope();
      for (const child of statementsOf(node)) {
        if (node.type === "block" && child.type === "let_declaration") {
          const from = child.startIndex + child.text.length;
          rustPattern(child.childForFieldName("pattern"), (name) => scope.lets.set(name, [...scope.lets.get(name) ?? [], from]));
        } else rustItem(child, scope);
      }
      return scope;
    }
    case "function_item":
    case "closure_expression": {
      const scope = emptyScope();
      const list = parametersOf(node);
      if (list) {
        for (const one of kids(list)) {
          if (one.type === "parameter") rustPattern(one.childForFieldName("pattern"), (name) => put(scope, name, "bound"));
          else if (one.isNamed && one.type !== "self_parameter") rustPattern(one, (name) => put(scope, name, "bound"));
        }
      }
      return scope;
    }
    case "match_arm":
    case "let_condition":
    case "for_expression": {
      const scope = emptyScope();
      rustPattern(node.childForFieldName("pattern"), (name) => put(scope, name, "bound"));
      return scope;
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------- imports, all three */

/**
 * The names one import statement binds, and the wildcards it writes.
 *
 * The names only: where each came from is `bindingsIn`'s table, and the
 * caller reads it there. Two imports of one name from two places are already
 * `ambiguous` in that table.
 */
function importNames(node: Node, scope: Scope, language: "ts" | "python" | "rust"): void {
  if (language === "ts") {
    if (node.type !== "import_statement") return;
    each(node, (part) => {
      if (part.type === "import_specifier") {
        const bound = part.childForFieldName("alias") ?? part.childForFieldName("name");
        if (bound) put(scope, bound.text, "imported");
      } else if (part.type === "import_clause") {
        for (const one of kids(part)) if (one.type === "identifier") put(scope, one.text, "imported");
      } else if (part.type === "namespace_import") {
        const name = kids(part).find((child) => child.type === "identifier");
        if (name) put(scope, name.text, "imported");
      }
    });
    return;
  }
  if (language === "python") {
    if (node.type === "import_from_statement") {
      const module = node.childForFieldName("module_name");
      for (const part of kids(node)) {
        if (module && part.id === module.id) continue;
        if (part.type === "dotted_name") put(scope, part.text.split(".").pop()!, "imported");
        else if (part.type === "aliased_import") {
          const alias = part.childForFieldName("alias");
          if (alias) put(scope, alias.text, "imported");
        } else if (part.type === "wildcard_import" && module) scope.wildcards.push(module.text);
      }
    } else if (node.type === "import_statement") {
      for (const part of kids(node)) {
        if (part.type === "dotted_name") put(scope, part.text.split(".")[0]!, "imported");
        else if (part.type === "aliased_import") {
          const alias = part.childForFieldName("alias");
          if (alias) put(scope, alias.text, "imported");
        }
      }
    }
    return;
  }
  const walk = (part: Node, prefix: string): void => {
    switch (part.type) {
      case "scoped_use_list": {
        const path = part.childForFieldName("path");
        const list = part.childForFieldName("list");
        const under = path ? (prefix ? `${prefix}::${path.text}` : path.text) : prefix;
        if (list) for (const one of kids(list)) walk(one, under);
        return;
      }
      case "use_list":
        for (const one of kids(part)) walk(one, prefix);
        return;
      case "use_as_clause": {
        const alias = part.childForFieldName("alias");
        if (alias && alias.text !== "_") put(scope, alias.text, "imported");
        return;
      }
      case "use_wildcard": {
        const path = kids(part).find((child) => child.isNamed);
        const under = path ? path.text : "";
        const full = prefix && under ? `${prefix}::${under}` : prefix || under;
        scope.wildcards.push(full);
        return;
      }
      case "scoped_identifier":
      case "identifier": {
        const full = prefix ? `${prefix}::${part.text}` : part.text;
        const name = full.split("::").pop();
        if (name && name !== "self") put(scope, name, "imported");
        else if (name === "self") {
          const parent = full.split("::").slice(-2, -1)[0];
          if (parent) put(scope, parent, "imported");
        }
        return;
      }
      case "self": {
        const parent = prefix.split("::").pop();
        if (parent) put(scope, parent, "imported");
        return;
      }
      default:
    }
  };
  const argument = node.childForFieldName("argument");
  if (argument) walk(argument, "");
}

/* ----------------------------------------------------------------- lookup */

function scopeAt(index: Index, node: Node, language: Language): Scope | null {
  if (index.scopes.has(node.id)) return index.scopes.get(node.id)!;
  // The top of the tree is the module, whatever the parser could make of it.
  const root = !index.parents.has(node.id);
  const made = language === "python" ? pyScope(node, root) : language === "rust" ? rustScope(node, root) : tsScope(node, root);
  index.scopes.set(node.id, made);
  return made;
}

/** Whether a node is the body of a Rust `mod name { .. }` written in place. */
function inlineModule(index: Index, node: Node): boolean {
  return node.type === "declaration_list" && index.parents.get(node.id)?.type === "mod_item";
}

/** The `enum` this file declares under `name`, and its variants -- for `use Kind::*`. */
const enums = new WeakMap<Tree, Map<string, Set<string>>>();

function variantsOf(tree: Tree, name: string): Set<string> | undefined {
  let known = enums.get(tree);
  if (!known) {
    const made = new Map<string, Set<string>>();
    each(tree.rootNode, (node) => {
      const named = node.type === "enum_item" ? node.childForFieldName("name")?.text : undefined;
      if (named === undefined || made.has(named)) return;
      const found = new Set<string>();
      const body = node.childForFieldName("body");
      if (body) for (const variant of kids(body)) {
        const n = variant.childForFieldName("name");
        if (variant.type === "enum_variant" && n) found.add(n.text);
      }
      made.set(named, found);
    });
    enums.set(tree, made);
    known = made;
  }
  return known.get(name);
}

/** Whether a Rust path names a crate outside the repository by its first step alone. */
const STANDARD_CRATES = new Set(["std", "core", "alloc"]);

/** What a Rust `use` names first: `crate`, `self`, `super`, or a crate's or a module's name. */
function firstStep(specifier: string): string {
  return specifier.replace(/^::/, "").split("::")[0] ?? "";
}

/** Rust's three namespaces; TypeScript and Python look in `value` only. */
export type Space = "value" | "macro" | "type";

export interface LookUp {
  source: string;
  language: Language;
  /**
   * What a wildcard brings in, judged by the caller -- which can open the
   * files it names. Asked only for a name no scope declared.
   */
  wildcard: (specifier: string, name: string, space: Space) => WildcardAnswer;
}

/**
 * What `name` means at `site`. `macro` and `type` are Rust's other two
 * namespaces: `name!(..)` is looked up in the first, the `Type` of
 * `Type::make()` in the second.
 */
export function lookUp(name: string, site: Node, side: LookUp, space: Space = "value"): Meaning {
  const tree = treeOf(site, side.source, side.language);
  if (!tree) return { at: "unknown", why: "unbound" };
  const index = indexOf(tree);
  const language = side.language;

  /*
   * A line the parser could not read and blanked (#462) may declare this
   * name: `const fetch = <T,>() => ..` would make `fetch()` the file's own,
   * not the host's. Every scope holding such a line, met on the way out,
   * answers "not known" rather than answering past it.
   */
  const unread = unreadIn(tree).filter((one) => wholeName(name).test(one.lines));

  /** Crossed a function, lambda or comprehension: a class body is out of sight. */
  let inFunction = false;
  /** Crossed a Rust function item: the locals around it are out of sight. */
  let pastItem = false;
  /** Rust: what an enclosing `match`/`if let` pattern binds, met on the way up. */
  let below: Node = site;
  /** Rust: climbed out of an inline module through its `use super::*`. */
  let throughSuper = false;
  /**
   * Past such a module: what is found now came in by a wildcard, and a name
   * the language provides too is then the doubt any wildcard's is.
   */
  let viaWildcard = false;
  /**
   * Rust: climbed out of an inline module without `use super::*`. Only a
   * `macro_rules!` written around it is still in sight -- macros scope by the
   * text, not by the module (`create_app!` in clap's benches).
   */
  let macrosOnly = false;

  for (let at: Node | undefined = site; at; below = at, at = index.parents.get(at.id)) {
    const holder = at;
    if (unread.some((one) => holder.startIndex <= one.start && one.end <= holder.endIndex)) return { at: "unknown", why: "unbound" };
    if (language === "rust" && at.type === "let_condition") continue;
    let scope = scopeAt(index, at, language);
    if (language === "rust" && at.type === "declaration_list") {
      // An `impl` or a `trait` body declares members, not names.
      const owner = index.parents.get(at.id);
      if (owner && owner.type !== "mod_item") scope = null;
    }
    if (language === "rust" && (at.type === "if_expression" || at.type === "while_expression")) {
      // `if let P = v { .. }`: P binds in the block it guards, not in `else`.
      const condition = at.childForFieldName("condition");
      const guarded = at.childForFieldName("consequence") ?? at.childForFieldName("body");
      if (condition && guarded && below.id === guarded.id) {
        const lets: Node[] = [];
        each(condition, (inner) => { if (inner.type === "let_condition") lets.push(inner); });
        for (const one of lets) {
          const found = scopeAt(index, one, language);
          const hit = found?.values.get(name);
          if (hit && space === "value" && !pastItem) return { at: "bound" };
        }
      }
    }
    if (language === "rust" && at.type === "match_arm" && below.id === at.childForFieldName("pattern")?.id) scope = null;
    if (language === "rust" && at.type === "for_expression" && below.id !== at.childForFieldName("body")?.id) scope = null;

    if (scope && macrosOnly) {
      if (scope.macros.has(name)) return { at: "declared" };
    } else if (scope) {
      const hidden = scope.classBody && inFunction;
      if (!hidden) {
        if (space === "type") {
          const hit = scope.values.get(name);
          if (scope.types.has(name)) return hit?.entry === "imported" ? { at: "unknown", why: "ambiguous" } : { at: "declared" };
          if (hit?.entry === "imported") return scope.twice.has(name) ? { at: "unknown", why: "ambiguous" } : { at: "imported" };
        } else if (space === "macro") {
          if (scope.macros.has(name)) return { at: "declared" };
          const hit = scope.values.get(name);
          if (hit?.entry === "imported") return scope.twice.has(name) ? { at: "unknown", why: "ambiguous" } : { at: "imported" };
        } else {
          if (!pastItem && (scope.lets.get(name) ?? []).some((from) => from <= site.startIndex)) return { at: "bound" };
          const hit = scope.values.get(name);
          const local = hit?.entry === "bound";
          const visible = hit && hit.from <= site.startIndex && !(local && pastItem);
          if (hit && visible) {
            if (scope.twice.has(name)) return { at: "unknown", why: "ambiguous" };
            if (viaWildcard && (providedByLanguage(name, language) || providedByHost(name, language))) return { at: "unknown", why: "unbound" };
            if (hit.entry === "imported") return { at: "imported" };
            return local ? { at: "bound" } : { at: "declared" };
          }
        }
        /*
         * Explicit names first, then this scope's wildcards. One that cannot
         * be read, two that both carry the name, or one carrying a name the
         * language provides too -- whose export rules then decide between
         * them, which this reader only approximates -- is not known. A name
         * nothing else could have brought is the one file's that declares it.
         */
        let carried: string | undefined;
        let carriers = 0;
        for (const specifier of scope.wildcards) {
          // `use super::*` in a module written inside this file: the module
          // around it, read below as the climb goes on.
          if (specifier === "super" && inlineModule(index, at)) { throughSuper = true; continue; }
          const answer = judgeWildcard(specifier, name, tree, side, space);
          if (answer === "unknown") return { at: "unknown", why: "unbound" };
          if (typeof answer === "object") { carriers += 1; carried = answer.has; }
        }
        if (carriers > 0) {
          if (carriers > 1 || carried === undefined || providedByLanguage(name, language) || providedByHost(name, language)) {
            return { at: "unknown", why: "unbound" };
          }
          return { at: "wildcard", file: carried };
        }
      }
    }
    // A Rust module sees none of the module around it; `use super::*` is how it would.
    if (language === "rust" && inlineModule(index, at)) {
      if (!throughSuper && space !== "macro") break;
      if (!throughSuper) { macrosOnly = true; continue; }
      throughSuper = false;
      viaWildcard = true;
    }
    if (PY_FUNCTION.has(at.type) || PY_COMPREHENSION.has(at.type)) inFunction = true;
    if (language === "rust" && at.type === "function_item") pastItem = true;
  }

  // Nothing in scope binds it. The language's or the host's, or not known.
  if (providedByLanguage(name, language) || providedByHost(name, language)) return { at: "outside" };
  /*
   * A wildcard reaching outside the repository may be where it came from, and
   * it is still not concluded: a macro at item level can declare a name
   * nothing here can see, and "outside" for that is a claim about code nobody
   * read. A built-in is another matter -- the wildcard brings one in from
   * outside or the language does, and both are outside.
   */
  return { at: "unknown", why: "unbound" };
}

/** What one wildcard brings in, for one name. */
function judgeWildcard(specifier: string, name: string, tree: Tree, side: LookUp, space: Space): WildcardAnswer {
  if (side.language === "rust") {
    // `use self::Kind::*` and `use Kind::*`: the variants of an enum this file declares.
    const steps = specifier.replace(/^(self|crate)::/, "").split("::");
    if (steps.length === 1 || /^self::/.test(specifier)) {
      const variants = variantsOf(tree, steps[steps.length - 1]!);
      // A variant is a value, never a routine: carried, and by nothing that runs.
      if (variants) return variants.has(name) && space === "value" ? { has: undefined } : "lacks";
    }
    if (STANDARD_CRATES.has(firstStep(specifier))) return "outside";
  }
  return side.wildcard(specifier, name, space);
}

/**
 * What a file's top puts in reach of a wildcard over it: every name its
 * module scope binds, in any namespace, and the wildcards it writes there.
 * Generous on purpose -- a name counted here that a wildcard would not
 * actually carry turns an answer into "not known", never into a wrong one.
 */
type Top = { scope: Scope; inner: Scope[]; broken: boolean; unreadLines: string[] } | null;
const TOPS_LIMIT = 512;
/**
 * A file's top, by its text -- not by its tree, which the parse cache lets go
 * of after 48 other files. Asked of every file an import is followed through,
 * and a barrel re-exporting sixty modules asks it of all sixty per call:
 * keyed by tree, each of those was parsed again whenever the cache had moved
 * on, faster than the collector freed the old ones, and MobX's and
 * Excalidraw's census runs ran the parser out of memory. Names only, so it
 * can remember far more files than the parse cache, as `bindingsIn` does.
 */
const tops = new Map<string, Top>();

export function moduleScope(
  source: string,
  language: Language,
): {
  has: (name: string, space: Space) => "declared" | "other" | undefined;
  /** Declared here and imported here too: which one the name means is not in the text. */
  ambiguous: (name: string) => boolean;
  wildcards: string[];
  limited: boolean;
  /**
   * The parser had to recover somewhere in this file, so its top may have
   * lost a declaration: mobx's `api/action.ts`, whose interface of generic
   * call signatures turns `export function isAction` into a stray method.
   */
  broken: boolean;
  /**
   * Whether a line the parser could not read and blanked writes this name
   * (#462): the file may declare it there, so "not here" is not known.
   */
  unread: (name: string) => boolean;
} | undefined {
  const key = `${language}:${source}`;
  let top = tops.get(key);
  if (top === undefined) {
    const tree = parseSource(source, language);
    if (!tree) return undefined;
    const scope = language === "python" ? pyScope(tree.rootNode, true) : language === "rust" ? rustScope(tree.rootNode, true) : tsScope(tree.rootNode, true);
    /*
     * Rust writes modules inside a file too -- `pub mod sinks { pub struct UTF8 }`
     * in ripgrep's `sink.rs` -- and a path through one ends in this file. What
     * they declare is this file's to answer for.
     */
    const inner: Scope[] = [];
    if (language === "rust") {
      each(tree.rootNode, (node) => {
        const body = node.type === "mod_item" ? node.childForFieldName("body") : null;
        const one = body ? rustScope(body) : null;
        if (one) inner.push(one);
      });
    }
    top = scope ? { scope, inner, broken: incomplete(tree.rootNode), unreadLines: unreadIn(tree).map((one) => one.lines) } : null;
    tops.set(key, top);
    if (tops.size > TOPS_LIMIT) tops.delete(tops.keys().next().value!);
  } else {
    tops.delete(key);
    tops.set(key, top);
  }
  if (!top) return undefined;
  const { scope, inner, broken, unreadLines } = top;
  const declaredInside = (name: string, space: Space) => inner.some((one) =>
    space === "type" ? one.types.has(name) : space === "macro" ? one.macros.has(name) : one.values.get(name)?.entry === "declared");
  return {
    has: (name, space) => {
      if (!scope.values.has(name) && !scope.types.has(name) && !scope.macros.has(name) && declaredInside(name, space)) return "declared";
      const hit = scope.values.get(name);
      if (hit?.entry === "imported" || hit && scope.twice.has(name)) return "other";
      if (space === "macro") return scope.macros.has(name) ? "declared" : undefined;
      if (space === "type") return scope.types.has(name) ? "declared" : undefined;
      if (!hit) return undefined;
      return hit.entry === "declared" ? "declared" : "other";
    },
    ambiguous: (name) => scope.twice.has(name),
    wildcards: scope.wildcards,
    // Python's `__all__` decides what a wildcard over the module carries.
    limited: language === "python" && scope.values.has("__all__"),
    broken,
    unread: (name) => unreadLines.some((lines) => wholeName(name).test(lines)),
  };
}
