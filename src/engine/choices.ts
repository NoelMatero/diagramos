/**
 * The functions a routine picks among at run time, when the list is written
 * down (#375).
 *
 * `handlers[command]()` calls one function out of a table, and which one is
 * decided by the input. An arrow "run calls start" drawn through it can be
 * neither confirmed nor refuted -- the call is computed -- so the board keeps
 * an arrow nobody can check. When the table is written out in the same file
 * and nothing writes into it, the honest drawing is "run runs one of {start,
 * stop}", which is a set of plain `calls` arrows, one per choice. This reads
 * that set so the drawing agent can be told it.
 *
 * It never decides a verdict. What it finds goes to the draw-time result as a
 * suggestion, and every doubt below means saying nothing, because "draw these
 * choices" about a list that is not really closed would send an agent to
 * draw a picture of the code that is not true either.
 *
 * ## What counts as closed, measured before it was built
 *
 * On the corpus's fifteen projects (tests excluded), 89 TypeScript and 67
 * Python call sites pick the function at run time; roughly 15 of them pick
 * from a table of the project's own functions written out in source, and the
 * rest take any string -- `getattr(self, "clean_" + name)`, a registry filled
 * in at run time. Rust has none: it chooses with a `match` whose arms call
 * each function directly, which `calls` already reads arm by arm. So:
 *
 * - **The table** is a `const` object literal (TypeScript) or a dict literal
 *   (Python) bound once in this file, at file level or -- for `self.T` -- in
 *   the class body, and every entry is a plain name: `start`, `ops.stop`,
 *   `"go": go`. A spread, a lambda or a method written inline is a choice
 *   with no name to draw, and the table is left alone.
 * - **Nothing writes into it** anywhere in the file: no `T[k] = ..`, no
 *   `T.x = ..`, no `del T[k]`, no `T.update(..)`, no `Object.assign(T, ..)`.
 * - **TypeScript's key is typed closed**: a union of literals, `keyof typeof
 *   T`, or an alias in this file for one of those. A `string` key over the
 *   same table is a lookup that can miss, and is said nothing about. Python's
 *   key is not read; the dict being written out is the issue's bar for it.
 *
 * ## One reading of the grammar, by field
 *
 * `docs/reading-a-grammar.md`: read the field, not a list of node names. A
 * call has a `function`; a subscript has `object`/`index` in TypeScript and
 * `value`/`subscript` in Python; a binding has `name`/`value` or
 * `left`/`right`; a member has `property` or `attribute`. The two lists that
 * remain -- what a literal table is, and what wraps an expression without
 * changing it -- are written once below.
 */

import { declaredShapes } from "./body";
import { each, parseSource, type Language, type Node } from "./parse";

/** A table one routine picks a function from. */
export interface RunTimeChoice {
  /** The table as the routine writes it: `handlers`, `self.HANDLERS`. */
  table: string;
  /** Every function it can pick, in the order the table writes them. */
  names: string[];
  /** 1-based line of the call that picks. */
  line: number;
}

/** A literal table: an object literal in TypeScript, a dict in Python. */
const LITERAL_TABLE = /^(object|dictionary)$/;
/** What wraps an expression without changing which value it is. */
const SEE_THROUGH = /^(parenthesized_expression|non_null_expression)$/;
/** Methods that put an entry into a table, or take one out. */
const WRITES = new Set(["update", "setdefault", "pop", "popitem", "clear", "set", "delete"]);

const field = (node: Node, ...names: string[]): Node | undefined => {
  for (const name of names) {
    const found = node.childForFieldName(name);
    if (found) return found;
  }
  return undefined;
};

const seeThrough = (node: Node | undefined): Node | undefined => {
  let at = node;
  while (at && SEE_THROUGH.test(at.type)) {
    let inner: Node | undefined;
    for (let index = 0; index < at.childCount; index += 1) {
      const child = at.child(index);
      if (child?.isNamed) { inner = child; break; }
    }
    at = inner;
  }
  return at;
};

/** `T[k]` read by field, in either grammar: the table and the key. */
const subscriptOf = (node: Node | undefined): { table: Node; key: Node } | undefined => {
  if (!node) return undefined;
  const table = field(node, "object", "value");
  const key = field(node, "index", "subscript");
  return table && key && !node.childForFieldName("property") && !node.childForFieldName("attribute")
    ? { table, key }
    : undefined;
};

/** A key written as a literal is not a choice made at run time. */
const isLiteral = (node: Node): boolean => /^(string|number|integer|float|true|false)$/.test(node.type);

/** The name an assignment-like node binds, and the value it binds it to. */
const bindingOf = (node: Node): { name: Node; value: Node } | undefined => {
  const name = field(node, "name", "left");
  const value = field(node, "value", "right");
  return name && value ? { name, value } : undefined;
};

/** The last name of `ops.stop` or `ops.stop`, or the name itself. */
const plainName = (node: Node): string | undefined => {
  if (node.type === "identifier") return node.text;
  const member = field(node, "property", "attribute");
  return member && field(node, "object") ? member.text : undefined;
};

/** Every function a literal table holds, or undefined if one has no name. */
function namesIn(table: Node): string[] | undefined {
  const names: string[] = [];
  for (let index = 0; index < table.childCount; index += 1) {
    const entry = table.child(index)!;
    if (!entry.isNamed || entry.type === "comment") continue;
    if (entry.type === "shorthand_property_identifier") { names.push(entry.text); continue; }
    const value = field(entry, "value");
    if (!value || !field(entry, "key")) return undefined; // a spread, a method, a splat
    const name = plainName(value);
    if (!name) return undefined; // a lambda or a call: a choice with no name
    names.push(name);
  }
  return names.length > 1 ? [...new Set(names)] : undefined;
}

/** Whether `node` is the table, by text, allowing `self.T` / `this.T`. */
const isTable = (node: Node | undefined, table: string): boolean =>
  seeThrough(node)?.text === table;

/** Whether anything in the file puts an entry into the table or takes one out. */
function writtenInto(root: Node, table: string): boolean {
  let written = false;
  each(root, (node) => {
    if (written) return;
    if (/assignment/.test(node.type)) {
      const left = field(node, "left");
      if (left && left !== undefined) {
        const target = subscriptOf(left)?.table ?? field(left, "object");
        if (target && isTable(target, table)) written = true;
      }
    }
    if (node.type === "delete_statement" && node.text.replace(/^del\s+/, "").startsWith(`${table}[`)) written = true;
    const fn = field(node, "function");
    if (fn && node.childForFieldName("arguments")) {
      const member = field(fn, "property", "attribute");
      const object = field(fn, "object");
      if (member && object && isTable(object, table) && WRITES.has(member.text)) written = true;
      if (object?.text === "Object") {
        const args = node.childForFieldName("arguments")!;
        for (let index = 0; index < args.childCount; index += 1) {
          const arg = args.child(index);
          if (arg?.isNamed) { if (isTable(arg, table)) written = true; break; }
        }
      }
    }
  });
  return written;
}

/**
 * The one literal table a name is bound to, or undefined.
 *
 * `T` is looked for at file level; `self.T` / `cls.T` / `this.T` in a class
 * body. Bound twice, bound to anything but a literal, or -- in TypeScript --
 * bound with `let` or `var`, and it is not a list anybody can trust.
 */
function literalTable(root: Node, table: string, language: Language): Node | undefined {
  const own = /^(self|cls|this)\.(.+)$/.exec(table);
  const name = own ? own[2]! : table;
  const found: Node[] = [];
  each(root, (node) => {
    const binding = bindingOf(node);
    if (!binding || binding.name.text !== name) return;
    if (!own && binding.name.type !== "identifier") return;
    found.push(node);
  });
  if (found.length !== 1) return undefined;
  const value = seeThrough(found[0]!.childForFieldName("value") ?? found[0]!.childForFieldName("right") ?? undefined);
  if (!value || !LITERAL_TABLE.test(value.type)) return undefined;
  if (language !== "python") {
    // `const` is the first token of the declaration around the declarator.
    let declaration: Node | undefined;
    each(root, (node) => {
      if (declaration) return;
      for (let index = 0; index < node.childCount; index += 1) {
        if (node.child(index)?.id === found[0]!.id) { declaration = node; return; }
      }
    });
    if (declaration?.child(0)?.text !== "const") return undefined;
  }
  return value;
}

/**
 * Whether a TypeScript key can only hold a value the table was written with:
 * typed as a union of literals, as `keyof typeof T`, or as an alias in this
 * file for either. Anything else -- `string`, no annotation, a type from
 * another file -- is a lookup that may take any string.
 */
function keyIsClosed(root: Node, body: Node, key: Node, table: string): boolean {
  if (key.type !== "identifier") return false;
  let annotation: Node | undefined;
  const look = (scope: Node) => each(scope, (node) => {
    if (annotation) return;
    const pattern = field(node, "pattern", "name");
    if (pattern?.text === key.text && node.childForFieldName("type")) annotation = node.childForFieldName("type")!;
  });
  // The routine's own parameters sit beside its body, not in it.
  let routine: Node | undefined;
  each(root, (node) => { if (!routine && node.childForFieldName("body")?.id === body.id) routine = node; });
  if (routine) look(routine);
  if (!annotation) return false;
  return closedType(root, annotation, table, 0);
}

function closedType(root: Node, type: Node, table: string, depth: number): boolean {
  let at: Node | undefined = type;
  while (at && (at.type === "type_annotation" || at.type === "parenthesized_type")) {
    let inner: Node | undefined;
    for (let index = 0; index < at.childCount; index += 1) {
      if (at.child(index)?.isNamed) { inner = at.child(index)!; break; }
    }
    at = inner;
  }
  if (!at) return false;
  if (at.type === "literal_type") return true;
  if (at.type === "union_type") {
    const parts: Node[] = [];
    for (let index = 0; index < at.childCount; index += 1) {
      const part = at.child(index);
      if (part?.isNamed) parts.push(part);
    }
    return parts.length > 0 && parts.every((part) => closedType(root, part, table, depth));
  }
  if (at.type === "index_type_query") return at.text.replace(/\s+/g, " ") === `keyof typeof ${table}`;
  if (at.type === "type_identifier" && depth === 0) {
    let alias: Node | undefined;
    each(root, (node) => {
      if (!alias && node.type === "type_alias_declaration" && field(node, "name")?.text === at!.text) {
        alias = field(node, "value");
      }
    });
    return alias !== undefined && closedType(root, alias, table, 1);
  }
  return false;
}

/**
 * Every closed table `routine` picks a function from, in this file.
 *
 * Empty for Rust, for a routine this file does not declare, and for every
 * lookup that fails one of the tests above -- including any table whose key
 * may be any string.
 */
export function runTimeChoices(source: string, language: Language, routine: string): RunTimeChoice[] {
  if (language === "rust") return [];
  const tree = parseSource(source, language);
  const shapes = declaredShapes(source, language);
  if (!tree || !shapes) return [];
  const root = tree.rootNode;
  const bodies = (shapes.get(routine) ?? [])
    .map(({ node }) => node.childForFieldName("body") ?? field(node, "value")?.childForFieldName("body") ?? undefined)
    .filter((body): body is Node => body !== undefined);

  const found = new Map<string, RunTimeChoice>();
  for (const body of bodies) {
    // `h = T[k]` / `h = T.get(k)` in this body, so `h()` is read as the pick.
    const picked = new Map<string, { table: Node; key: Node }>();
    each(body, (node) => {
      const binding = bindingOf(node);
      if (!binding || binding.name.type !== "identifier") return;
      const pick = pickOf(seeThrough(binding.value));
      if (pick) picked.set(binding.name.text, pick);
    });
    each(body, (node) => {
      const fn = seeThrough(field(node, "function"));
      if (!fn || !node.childForFieldName("arguments")) return;
      const pick = pickOf(fn) ?? (fn.type === "identifier" ? picked.get(fn.text) : undefined);
      if (!pick || isLiteral(pick.key)) return;
      const table = seeThrough(pick.table)?.text;
      if (!table || found.has(table)) return;
      const literal = literalTable(root, table, language);
      if (!literal || writtenInto(root, table)) return;
      if (language !== "python" && !keyIsClosed(root, body, pick.key, table)) return;
      const names = namesIn(literal);
      if (!names) return;
      found.set(table, { table, names, line: source.slice(0, node.startIndex).split("\n").length });
    });
  }
  return [...found.values()];
}

/** `T[k]`, or `T.get(k)`: the table and the key a pick reads. */
function pickOf(node: Node | undefined): { table: Node; key: Node } | undefined {
  const direct = subscriptOf(node);
  if (direct) return direct;
  const fn = node && field(node, "function");
  const member = fn && field(fn, "property", "attribute");
  const object = fn && field(fn, "object");
  if (!member || !object || member.text !== "get") return undefined;
  const args = node!.childForFieldName("arguments");
  for (let index = 0; index < (args?.childCount ?? 0); index += 1) {
    const arg = args!.child(index);
    if (arg?.isNamed) return { table: object, key: arg };
  }
  return undefined;
}
