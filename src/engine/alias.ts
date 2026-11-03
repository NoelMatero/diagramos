/**
 * Names that stand for a type written somewhere else (#303).
 *
 * Both refutable readers of a declaration -- `signature.ts` and `holds.ts` --
 * are allowed to say *wrong* because what they read is a closed region: a
 * parameter list and a field list can each be written out in full, so a type
 * absent from one is absent. That holds only while every name in the region
 * means itself. One alias in it and the target could be sitting there under
 * another spelling, and the absence is about the reader rather than the code.
 *
 * Each reader used to carry its own copy of this, kept separate on purpose. The
 * copies then disagreed, which is the failure `docs/reading-a-grammar.md` is
 * about: #300's fixtures found `@takes`, `@returns` and `@holds` all calling a
 * correct aliased arrow wrong, and Python doing it even for an alias declared
 * on the line above -- because Python spells an alias as an ordinary assignment
 * and neither copy read one.
 *
 * Two questions, and they are not the same question:
 *
 *  - **What does this file rename?** `use a::B as C`, `import { B as C }`,
 *    `type C = B`, `C = B`. Seeing `C` in a signature means the signature might
 *    be naming the target, so nothing may refute.
 *  - **What does the *target's* file call it?** The alias that hides a type is
 *    usually declared beside the type, and imported plainly from there --
 *    `use crate::model::{Req, Request}`, where `model.rs` says `pub type Req =
 *    Request`. Nothing in the reading file marks `Req` as anything but an
 *    import, so the first question cannot see it and the second is the only one
 *    that can.
 *
 * Neither is alias *resolution*, which would need a type checker: an alias
 * found here withholds the answer, and never turns one into a confirmation.
 */
import { each, keywordOf, parametersOf, parseSource, type Language, type Node } from "./parse";

/** Node types that can rename something on the way in, if they actually do. */
const RENAMES = new Set([
  "import_specifier", "aliased_import", "export_specifier", "use_as_clause",
]);

/** Node types that introduce a name for a type written elsewhere. */
const ALIASES = new Set(["type_alias_declaration", "type_item"]);

/** A declaration's name, wherever its grammar puts one. Python annotates through `left`. */
function nameOf(node: Node): Node | undefined {
  return node.childForFieldName("name") ?? node.childForFieldName("left") ?? undefined;
}

/** What a declaration stands for, wherever its grammar puts that. */
function valueOf(node: Node): Node | undefined {
  return node.childForFieldName("value")
    ?? node.childForFieldName("type")
    ?? node.childForFieldName("right")
    ?? undefined;
}

/**
 * Whether this declaration is one that gives a name to something else.
 *
 * `parse.ts`'s rule, read the way it is written there: a declaration has a
 * `name`, a routine also has `parameters`, and something with a `body` of its
 * own is a thing rather than a name for one. What is left -- a name and a value
 * and neither of those -- is every spelling of an alias in every grammar
 * loaded here, and a hand-written list of node types would have missed the
 * Python one, which is how this shipped wrong.
 */
function isAlias(node: Node): boolean {
  if (parametersOf(node) || node.childForFieldName("body")) return false;
  return nameOf(node) !== undefined && valueOf(node) !== undefined;
}

/**
 * Names in this file that stand for something other than themselves.
 *
 * The last name in a rename is the one the file goes on to use -- `use a::B as
 * C`, `import { B as C }`, `from a import B as C` all end in the alias -- and
 * the name of an alias declaration is the one it introduces.
 *
 * Only a rename that actually renames. Every grammar here gives a plain named
 * import the same node type as a renamed one, and the `alias` field is the only
 * thing separating them; treating every import as a possible rename took the
 * signature reader's refusal rate to 42% when #169 measured it, which is a word
 * that ships and never fires.
 *
 * Deliberately a set of names rather than a flag on the file. A file with one
 * alias in it that no signature uses is still a file whose signatures can be
 * refuted, and the whole-file version would have withheld on most real code.
 */
export function aliasNames(root: Node): Set<string> {
  const shadows = new Set<string>();
  each(root, (node) => {
    if (RENAMES.has(node.type)) {
      const alias = node.childForFieldName("alias");
      if (alias && alias.childCount === 0) shadows.add(alias.text);
      return;
    }
    if (ALIASES.has(node.type)) {
      const name = node.childForFieldName("name");
      if (name) shadows.add(name.text);
    }
  });
  for (const name of boundAtTopLevel(root)) shadows.add(name);
  return shadows;
}

/**
 * Names this file binds to a value at its top level.
 *
 * How Python spells a type alias: `Req = Request`, with no keyword to say so
 * and no node type of its own. So the rule is the position -- a name bound at
 * module level, used where a type goes -- and that is sound in the one
 * direction it is asked: a name that is a variable in this file is not a name
 * that can be relied on to mean itself.
 *
 * Top level only, walked through the statement wrappers each grammar puts
 * around one. A local inside a routine is not visible where an annotation is
 * written, and collecting every one of them would have silenced a file for
 * every temporary in it.
 *
 * **It must bind something.** A name that is only *annotated* -- `declare const
 * ComputedRefSymbol: unique symbol`, which vue's `computed.ts` writes twice --
 * declares a thing rather than a name for another thing, and nothing can be
 * hiding behind it. So `type` does not count here, where it does in
 * `aliasesFor`: there the question is what a declaration stands for, and Rust
 * writes that on `type`.
 *
 * No board in the corpus changes verdict on this alone; it is here because the
 * wider rule was reached for while reading one of these, and a refusal that
 * cannot be right is worth not making.
 */
function boundAtTopLevel(root: Node): string[] {
  const names: string[] = [];
  const consider = (node: Node, depth: number): void => {
    if (depth > 2) return;
    const bound = node.childForFieldName("value") ?? node.childForFieldName("right");
    if (bound && isAlias(node)) {
      const name = nameOf(node);
      if (name && name.childCount === 0) names.push(name.text);
      return;
    }
    if (parametersOf(node) || node.childForFieldName("body")) return;
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child) consider(child, depth + 1);
    }
  };
  for (let index = 0; index < root.childCount; index += 1) {
    const child = root.child(index);
    if (child) consider(child, 0);
  }
  return names;
}

/**
 * What the file declaring a type calls it, besides its own name.
 *
 * `use crate::model::{Req, Request}` tells the reading file nothing: both
 * arrive as plain imports and only `model.rs` knows that one of them is
 * `pub type Req = Request`. Every one of #300's nine aliased false reds is this
 * shape, in three languages, and it is not visible from the file being refuted.
 *
 * One hop, and deliberately: an alias naming the target directly is the shape
 * real code writes, and a chain of them is a question for a type checker. What
 * a longer chain costs is a red that should have been silence, which is the
 * failure that was already there.
 */
export function aliasesFor(
  source: string,
  language: Language,
  targets: string[],
): Set<string> {
  const names = new Set<string>();
  const tree = parseSource(source, language);
  if (!tree) return names;
  const wanted = new Set(targets);
  each(tree.rootNode, (node) => {
    if (!isAlias(node)) return;
    const name = nameOf(node);
    const value = valueOf(node);
    if (!name || name.childCount !== 0 || !value) return;
    let stands = false;
    each(value, (part) => {
      if (part.childCount === 0 && wanted.has(part.text)) stands = true;
    });
    if (stands) names.add(name.text);
  });
  return names;
}

/**
 * Whether a declaration gives a type a second name: `type Handler = (n: number)
 * => number` in TypeScript, `type Named = Shape;` in Rust, `type Handler =
 * Callable[[int], int]` in Python -- or Python's older spelling, which says so
 * on the line: `Handler: TypeAlias = Callable[[int], int]`.
 *
 * By the word the declaration opens with, which is the same word in all three
 * grammars and is an anonymous token, so its type is its own text -- the
 * reading `parts.ts` already makes for "is this a type or a value". Not
 * `isAlias` above: that one is generous on purpose and counts every `const x =
 * y` and every Python `x = y`, which is right for "might this name be hiding
 * another" and wrong for "is this name a type" -- a value declared with
 * `const` is called by its own name, and an arrow at it is a question about
 * the value. A bare Python `Alias = Shape` stays out for the same reason: the
 * text cannot tell it from a module-level value.
 */
export function isTypeAlias(node: Node): boolean {
  const name = declaredName(node);
  // Something it names, too: `import { type X }` opens with the word and names nothing.
  if (!name || !valueOf(node)) return false;
  if (keywordOf(node, name) === "type") return true;
  const annotation = node.childForFieldName("type");
  return node.childForFieldName("right") !== null && annotation !== null
    && /^(?:typing(?:_extensions)?\.)?TypeAlias$/.test(annotation.text);
}

/**
 * The plain name a declaration introduces, or none. Python's `type X = ...`
 * wraps its name in a `type` node of one child, so that one is looked through.
 */
function declaredName(node: Node): Node | undefined {
  let name = node.childForFieldName("name") ?? node.childForFieldName("left");
  if (name && name.childCount === 1) name = name.child(0);
  return name && name.childCount === 0 ? name : undefined;
}

/**
 * Whether `name` is declared in this file as a type alias and as nothing else
 * (#476).
 *
 * Every declaration counts. TypeScript keeps types and values apart, so
 * `type Make = { .. }` and `function Make() {}` can share a name, and an arrow
 * at that name may mean the routine -- which is read as one, as before. What
 * counts as a declaration is `isTypeName`'s rule in `calls.ts`: a name with a
 * body, parameters or a value beside it. A member's signature in an object
 * type (`{ Handler: () => void }`) or a struct's field has only a type beside
 * it, and declares nothing here.
 */
export function onlyATypeAlias(source: string, name: string, language: Language): boolean {
  const tree = parseSource(source, language);
  if (!tree) return false;
  let aliases = 0;
  let other = 0;
  each(tree.rootNode, (node) => {
    if (declaredName(node)?.text !== name) return;
    if (isTypeAlias(node)) aliases += 1;
    else if (parametersOf(node) || ["body", "value", "right"].some((field) => node.childForFieldName(field))) other += 1;
  });
  return aliases > 0 && other === 0;
}

/**
 * What an alias at an arrow's *type* end stands for (#479).
 *
 * The other direction from everything above. There, the code writes a name
 * that may hide the target; here, the arrow names `Alias` where `type Alias =
 * Shape`, and the code writes `Shape`. Looking for the word `Alias` in a
 * signature or a field list finds nothing, and that absence is about the
 * spelling rather than the code -- every one of #479's fifteen probe arrows
 * was correct and red, in all three languages.
 *
 * So a written type that *is* what the alias stands for counts as "might be
 * this one", which withholds and never confirms. What it stands for is
 * compared whole, never by a name it shares: httpx's `HeaderTypes` is a union
 * naming `Tuple` and `bytes`, and `Headers`' one field writes both, in a list
 * of byte triples that is not a `HeaderTypes` at all -- a red on a wrong arrow
 * that a shared-name rule would have thrown away.
 *
 * One hop, as `aliasesFor` is: an alias of an alias is a question for a type
 * checker, and what a longer chain costs is a red that should have been
 * silence, which is what there was before.
 */
export interface StandsFor {
  /** The alias's value written canonically, as a whole match; its type parameters match anything. */
  pattern: RegExp;
  /**
   * The type names the value writes, canonically, less its type parameters.
   * A compiler's answer is a flat list of parts with no shape to compare, so
   * the most it can say is "every one of these is in it" -- needed for the
   * type to be the alias's value, and enough here, where it only withholds.
   */
  names: string[];
}

/** Stands for a type parameter in a canonical spelling. Not a character any type can write. */
const PARAMETER = "\u0001";
const QUALIFIED = /^[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*$/;
/** `typing`'s capitalised spellings of builtins, which mean the same type (PEP 585). */
const PYTHON_BUILTINS: Record<string, string> = {
  List: "list", Dict: "dict", Set: "set", FrozenSet: "frozenset", Tuple: "tuple", Type: "type", Text: "str",
};
/** Wrappers that only say "one of these": not a part a compiler lists. */
const NOT_A_PART = new Set(["Union", "Optional", "None", "undefined", "null"]);

/** The named children of a node: what is left once its punctuation and keywords are. */
function named(node: Node): Node[] {
  const children: Node[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child?.isNamed) children.push(child);
  }
  return children;
}

function plainName(text: string, language: Language): string {
  const last = text.split(/\.|::/).pop()!;
  return language === "python" ? PYTHON_BUILTINS[last] ?? last : last;
}

/**
 * The members of a union, flattened: `A | B | C` in TypeScript and Python,
 * and Python's `Union[A, B]` and `Optional[A]`, which mean the same thing.
 * Undefined for anything that is not a union.
 */
function unionMembers(node: Node, language: Language): Array<Node | "None"> | undefined {
  const members: Array<Node | "None"> = [];
  const flatten = (part: Node): void => {
    if (part.type === "type" && named(part).length === 1) return flatten(named(part)[0]!);
    if (part.type === "union_type") {
      for (const member of named(part)) flatten(member);
      return;
    }
    const operator = part.type === "binary_operator" ? part.childForFieldName("operator") : null;
    if (operator?.text === "|") {
      flatten(part.childForFieldName("left")!);
      flatten(part.childForFieldName("right")!);
      return;
    }
    const wrapped = language === "python" ? pythonUnion(part) : undefined;
    if (wrapped) {
      members.push(...wrapped);
      return;
    }
    members.push(part);
  };
  flatten(node);
  return members.length > 1 ? members : undefined;
}

/** Python's `Union[A, B]` and `Optional[A]` as members, or undefined. */
function pythonUnion(node: Node): Array<Node | "None"> | undefined {
  let head: Node | null = null;
  let args: Node[] = [];
  if (node.type === "subscript") {
    head = node.childForFieldName("value");
    for (let index = 0; index < node.childCount; index += 1) {
      if (node.fieldNameForChild(index) === "subscript") args.push(node.child(index)!);
    }
  } else if (node.type === "generic_type") {
    head = named(node)[0] ?? null;
    const parameters = named(node).find((child) => child.type === "type_parameter");
    args = parameters ? named(parameters) : [];
  }
  if (!head || !QUALIFIED.test(head.text)) return undefined;
  const name = plainName(head.text, "python");
  if (name === "Union") return args;
  if (name === "Optional" && args.length === 1) return [args[0]!, "None"];
  return undefined;
}

/**
 * A type written the same way whatever spelling it was given: no whitespace,
 * no namespace (`typing.List`, `crate::types::Shape`), no quotes round a Python
 * forward reference, union members in one order, `T[]` as `Array<T>`, and a
 * function type's parameter names left out. Type parameters become one mark.
 */
function canonical(node: Node, language: Language, parameters: Set<string>): string {
  const text = node.text.replace(/\s+/g, "");
  if (language === "python" && node.type === "string") {
    const inner = text.replace(/^[rRbBuUfF]*("""|'''|"|')/, "").replace(/("""|'''|"|')$/, "");
    return inner.replace(/[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*/g, (name) => plainName(name, language));
  }
  if (node.type === "lifetime") return "";
  if (QUALIFIED.test(text) && node.isNamed) {
    if (parameters.has(text)) return PARAMETER;
    return plainName(text, language);
  }
  if (node.childCount === 0) return text;
  const members = unionMembers(node, language);
  if (members) {
    const each = members.map((member) => (member === "None" ? "None" : canonical(member, language, parameters)));
    return `U(${[...new Set(each)].sort().join(",")})`;
  }
  const inner = named(node);
  if (node.type === "array_type" && inner.length === 1) return `Array<${canonical(inner[0]!, language, parameters)}>`;
  if ((node.type === "parenthesized_type" || node.type === "type") && inner.length === 1) {
    return canonical(inner[0]!, language, parameters);
  }
  // A parameter of a function type is its type: `(n: number) => T` is `(x: number) => T`.
  if (/^(required_parameter|optional_parameter|parameter)$/.test(node.type)) {
    const type = node.childForFieldName("type");
    if (type) return canonical(type, language, parameters) + (node.type === "optional_parameter" ? "?" : "");
  }
  let out = "";
  for (let index = 0; index < node.childCount; index += 1) out += canonical(node.child(index)!, language, parameters);
  return out;
}

/** Type names a value writes, each once and canonically, for a compiler's flat list of parts. */
function typeNamesOf(value: Node, language: Language, parameters: Set<string>): string[] {
  const names = new Set<string>();
  const visit = (node: Node): void => {
    const text = node.text.replace(/\s+/g, "");
    const typeLike = language === "python"
      ? node.type === "identifier" || node.type === "attribute"
      : /^(type_identifier|predefined_type|primitive_type|nested_type_identifier|scoped_type_identifier)$/.test(node.type);
    if (typeLike && QUALIFIED.test(text)) {
      if (!parameters.has(text)) names.add(plainName(text, language));
      return;
    }
    if (language === "python" && node.type === "string") {
      for (const name of canonical(node, language, parameters).match(/[A-Za-z_]\w*/g) ?? []) names.add(name);
      return;
    }
    for (let index = 0; index < node.childCount; index += 1) visit(node.child(index)!);
  };
  visit(value);
  return [...names].filter((name) => !NOT_A_PART.has(name));
}

/** The name an alias declaration introduces, and its type parameters' names. */
function aliasHead(node: Node): { name: string; parameters: Set<string> } | undefined {
  const parameters = new Set<string>();
  const declared = node.childForFieldName("type_parameters");
  if (declared) {
    each(declared, (part) => {
      if (part.type === "type_parameter") {
        const name = part.childForFieldName("name");
        if (name) parameters.add(name.text);
      }
    });
  }
  if (node.type === "type_alias_statement") {
    // Python 3.12: `type Box[T] = list[T]` puts the name and its parameters in a `generic_type`.
    let left = node.childForFieldName("left");
    if (left?.type === "type" && named(left).length === 1) left = named(left)[0]!;
    if (left?.type === "generic_type") {
      const name = named(left)[0];
      each(left, (part) => {
        if (part.type === "type_parameter") for (const one of named(part)) parameters.add(one.text);
      });
      return name ? { name: name.text, parameters } : undefined;
    }
    return left && left.childCount === 0 ? { name: left.text, parameters } : undefined;
  }
  const name = declaredName(node);
  return name ? { name: name.text, parameters } : undefined;
}

/** The value of an alias declaration, in each grammar's field for it. */
function aliasValue(node: Node): Node | undefined {
  return node.childForFieldName("value")
    ?? (node.type === "type_item" ? node.childForFieldName("type") : node.childForFieldName("right"))
    ?? undefined;
}

/** Right-hand sides that can be a Python type: a name, a dotted name, a subscript, an `A | B`. */
const PYTHON_TYPE_VALUE = /^(identifier|attribute|subscript|generic_type|binary_operator|none)$/;

/**
 * Python's plain `Alias = Shape` at module level, the spelling httpx and most
 * Python code uses -- and only where the value could be a type. `isTypeAlias`
 * leaves it out because an arrow at it may be about the value; here it only
 * adds a reason to withhold, so a value that is really a value costs a red on
 * an arrow that names a variable where a type belongs.
 */
function pythonAssignments(root: Node): Node[] {
  const found: Node[] = [];
  const consider = (node: Node, depth: number): void => {
    if (depth > 3 || parametersOf(node) || node.type === "class_definition") return;
    if (node.type === "assignment") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (left?.type === "identifier" && right && PYTHON_TYPE_VALUE.test(right.type)) {
        if (right.type !== "binary_operator" || right.childForFieldName("operator")?.text === "|") found.push(node);
      }
      return;
    }
    for (let index = 0; index < node.childCount; index += 1) consider(node.child(index)!, depth + 1);
  };
  consider(root, 0);
  return found;
}

/**
 * What each of `targets` stands for, where the type end's own file declares it
 * as an alias. Empty for a name that is not one, which is every name the
 * readers asked about before this.
 */
export function standsFor(source: string, language: Language, targets: string[]): StandsFor[] {
  const wanted = new Set(targets);
  const tree = parseSource(source, language);
  if (!tree) return [];
  const declarations: Node[] = [];
  each(tree.rootNode, (node) => {
    if (node.type === "type_alias_statement" || isTypeAlias(node)) declarations.push(node);
  });
  if (language === "python") declarations.push(...pythonAssignments(tree.rootNode));
  const found: StandsFor[] = [];
  for (const declaration of declarations) {
    const head = aliasHead(declaration);
    const value = aliasValue(declaration);
    if (!head || !value || !wanted.has(head.name)) continue;
    const written = canonical(value, language, head.parameters);
    const pattern = new RegExp(`^${written.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").split(PARAMETER).join(".+")}$`);
    found.push({ pattern, names: typeNamesOf(value, language, head.parameters) });
  }
  return found;
}

/** Whether a written type, or any type inside it, is what one of the aliases stands for. */
export function writesWhatItStandsFor(type: Node | null | undefined, language: Language, stands: StandsFor[]): boolean {
  if (!type || stands.length === 0) return false;
  let hit = false;
  each(type, (part) => {
    if (hit || !part.isNamed) return;
    const written = canonical(part, language, new Set());
    if (stands.some((one) => one.pattern.test(written))) hit = true;
  });
  return hit;
}

/** Whether a compiler's parts of a type include every name one of the aliases writes. */
export function partsMayBe(parts: string[], language: Language, stands: StandsFor[]): boolean {
  const have = new Set(parts.map((part) => plainName(part, language)));
  return stands.some((one) => one.names.every((name) => have.has(name)));
}
