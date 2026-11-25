/**
 * Whether a routine can run when a call names something else (#351).
 *
 * A call through an interface, a trait, a Protocol or a method a subclass
 * replaces -- `backend.moveToFailed()` -- runs whichever routine the value
 * holds under that name. Every class that implements it declares one, and
 * each is a routine *named* `moveToFailed`. So the call cannot directly be a
 * routine with another name, such as `handleFailed`, and `@calls`' closed
 * reading may count it as read (`textClosed`).
 *
 * Unless something stores the other routine under that name, which every
 * language here allows:
 *
 *   `{ onError: handleFailed }`, `self.cb = self.handle_failed`,  the routine named as a value: handed,
 *   `save = _save_impl`, `register(Self::handle)`               stored, assigned, returned
 *   `getattr(self, "handle_failed")`, `this["handle"]`          the routine read by a name in a string
 *   `import { handleFailed as onError }`, `use a::f as g`       the routine renamed on the way in or out
 *   `{ onError: (e) => handleFailed(e) }`,                      the routine called from a function that
 *   `Box::new(move |j| handle_failed(j))`                       has no name of its own, which is then
 *                                                               what runs under the other name
 *
 * So the question is asked of the whole repository, not of the call: does the
 * text anywhere write the routine's name in one of those ways? Any one of them
 * answers yes, and the dispatched call stays a doubt. Matching is by name and
 * not by binding, so a local or a field that only shares the name answers yes
 * too; the cost of that is a wrong arrow left unaccused, never a correct one
 * accused.
 *
 * A method is only ever named through something: `x.save`, `Self::save`,
 * `"save"`. A bare `save` names a local, a parameter or a free function, so
 * for a method (`member`) a bare name is not counted -- except in a Python
 * class body, where `save = _save_impl` reads the method declared above it.
 *
 * Two more ways a routine is handed on without its name being written as a
 * value (the untyped-value extension, `runsItsOwnName` in `calls.ts`):
 *
 *   `@app.route("/") def handle()`, `@Get() handle()`             a decorator is handed the routine itself, and
 *                                                               may keep it under any name it likes
 *   a JavaScript file in a Rust repository naming `run`         a file of another language cannot hold this
 *                                                               one's routines, so it is not asked (`language`)
 *
 * A decorator the language itself gives -- Python's `@staticmethod`,
 * `@classmethod`, `@property` and its setters, `@abstractmethod`,
 * `@override`, `@overload`, `@final` -- only changes how the routine is bound
 * and keeps it under its own name, so it is not counted.
 *
 * What it leaves out on purpose: a *named* routine that calls the head and is
 * itself what runs (`save() { this.handleFailed() }`, a blanket `impl<F: Fn>`
 * whose `handle` calls `self()`). That is a call to a routine of the
 * dispatched name, a step and not the head, as an ordinary call to it is.
 */
import { calledNameAt, routinesNamed } from "./calls";
import { wholeName } from "./declared";
import { each, parametersOf, withParsed, type Language, type Node } from "./parse";

export interface StoredSource {
  file: string;
  source: string;
  language: Language;
}

/** One place the text writes a routine's name in a way that can make it run under another. */
export interface StoredFinding {
  how: "value" | "by-name" | "renamed" | "wrapped" | "decorated" | "unread";
  file: string;
  line: number;
  /** For `wrapped`: the function with no name is written as a call's argument, not stored. */
  argument?: true;
  /**
   * For `wrapped`: every function with no name around the call, up to the
   * nearest named routine, innermost last, by their byte ranges -- what a
   * call elsewhere may run, so what a question about that call is put to
   * (`callee-type.ts`).
   */
  wrappers?: Array<{ start: number; end: number }>;
}

export interface Stored {
  /**
   * Every place the repository writes `name` so that it can run under
   * another name. `member`: the routine is a method, so a bare name is not it.
   * A walk that gave up answers with an `unread` finding: "cannot tell" is
   * never "nothing".
   *
   * `language`: the routine's own. Only files that can hold one of its
   * routines are read -- TypeScript and JavaScript for each other, Python for
   * Python, Rust for Rust. Absent, every file is.
   */
  findings(name: string, member: boolean, language?: Language): StoredFinding[];
}

/** A function written with no name of its own: what runs is whatever it was stored as. */
const ANONYMOUS = new Set(["arrow_function", "function_expression", "function", "generator_function", "lambda", "closure_expression"]);

/** Fields that bind or declare a name, or say a type: nothing under them is a value being handed. */
const NOT_A_VALUE = new Set([
  "name", "pattern", "left", "key", "alias", "label", "field", "type", "return_type",
  "type_parameters", "type_arguments", "module_name", "parameters", "trait",
]);

/** Fields that hold a value even under a binding: a default, an initializer, the right of `=`. */
const A_VALUE = new Set(["value", "right", "default", "body", "arguments", "argument", "object", "function", "condition", "index", "subscript"]);

/** Node types that are only ever a type, or a binding pattern. */
const TYPE_OR_PATTERN = /(^|_)(type_annotation|type_arguments|type_parameters|pattern)$|^(type_alias_declaration|interface_declaration)$/;

/** Calls that read or write a member by a name written as a string. */
const BY_NAME = new Set(["getattr", "setattr", "methodcaller", "attrgetter", "defineProperty"]);

/** Where an import or an export is written. */
const IMPORTING = /^(import_statement|import_from_statement|future_import_statement|use_declaration|export_clause|import_clause|named_imports)$/;

/** The member half of an access: `x.save`, `self.save`, `Self::save`. */
const MEMBER_FIELD = new Set(["property", "attribute"]);

/**
 * Lazily over `sources`: nothing is read until the first question, and a file
 * is parsed only when its text writes the name asked about. `undefined` from
 * `sources` is a walk that gave up, and every question then answers yes.
 */
export function storedIn(sources: () => readonly StoredSource[] | undefined): Stored {
  let files: readonly StoredSource[] | undefined | null = null;
  const known = new Map<string, StoredFinding[]>();

  const findings = (name: string, member: boolean, language?: Language): StoredFinding[] => {
    const plain = name.replace(/^(#|r#)/, "");
    const family = language ? familyOf(language) : "";
    const key = `${member ? "m" : "f"} ${family} ${plain}`;
    const cached = known.get(key);
    if (cached) return cached;
    if (files === null) files = sources();
    let found: StoredFinding[];
    if (!files) {
      found = [{ how: "unread", file: "", line: 0 }];
    } else {
      found = [];
      const word = wholeName(plain);
      for (const file of files) {
        if (family && familyOf(file.language) !== family) continue;
        if (!word.test(file.source)) continue;
        const here = withParsed(file.source, file.language, (tree) => findingsIn(tree.rootNode, plain, member, file));
        // A file with a grammar that would not parse could write it any way at all.
        found.push(...(here ?? [{ how: "unread" as const, file: file.file, line: 0 }]));
      }
    }
    known.set(key, found);
    return found;
  };
  return { findings };
}

/** Languages whose files can hold each other's routines. */
function familyOf(language: Language): string {
  return language === "python" || language === "rust" ? language : "javascript";
}

/**
 * Python's own decorators: each keeps the routine under its own name and only
 * changes how it is bound or checked. `x.setter`, `x.getter` and `x.deleter`
 * are a property's.
 */
const BINDS_ONLY = new Set([
  "staticmethod", "classmethod", "property", "setter", "getter", "deleter",
  "abstractmethod", "abstractproperty", "override", "overload", "final",
]);

/**
 * The routines named `name` this tree declares under a decorator that may
 * keep them (`decorated`): Python's `decorated_definition`, and TypeScript's
 * decorators, which its grammar writes just before the member they decorate.
 */
function decoratedIn(root: Node, name: string): Node[] {
  const out: Node[] = [];
  const judge = (decorators: Node[], target: Node | null, python: boolean): void => {
    if (!target || target.childForFieldName("name")?.text !== name) return;
    for (const decorator of decorators) {
      let written: Node | null = null;
      for (let index = 0; index < decorator.childCount && !written; index += 1) {
        const child = decorator.child(index);
        if (child?.isNamed && !/comment/.test(child.type)) written = child;
      }
      const callee = written && /^call(_expression)?$/.test(written.type) ? written.childForFieldName("function") : written;
      if (python && BINDS_ONLY.has(lastName(callee))) continue;
      out.push(decorator);
    }
  };
  each(root, (node) => {
    const kids: Node[] = [];
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child) kids.push(child);
    }
    if (node.type === "decorated_definition") {
      judge(kids.filter((one) => one.type === "decorator"), node.childForFieldName("definition"), true);
      return;
    }
    // TypeScript: a member's decorators are written inside it, or just before it in the class body.
    const inside = kids.filter((one) => one.type === "decorator");
    if (inside.length > 0 && node.childForFieldName("name")) judge(inside, node, false);
    let pending: Node[] = [];
    for (const child of kids) {
      if (!child.isNamed || /comment/.test(child.type)) continue;
      if (child.type === "decorator") { pending.push(child); continue; }
      if (pending.length > 0) judge(pending, child, false);
      pending = [];
    }
  });
  return out;
}

interface Context {
  /** Under a binding, a declaration's own name, or a type. */
  quiet: boolean;
  /** Inside an import or export: `renamed` when the clause gives the name another. */
  imported?: "plain" | "renamed";
  /** The nearest function around this has no name: written as a call's argument, or anywhere else. */
  anonymous?: "argument" | "stored";
  /** The functions with no name around this, up to the nearest named routine. */
  wrappers?: Array<{ start: number; end: number }>;
  /** For a function handed as an argument: the routine of this file it is handed to, and in which place. */
  handedTo?: { name: string; own: boolean; index: number };
  /** Inside a call's arguments: the routine called, when it is named plainly or as `this.f` / `self.f`. */
  calling?: { name: string; own: boolean };
  /** A string here is a member's name: `x["name"]`, `getattr(x, "name")`. */
  byName: boolean;
  /** This leaf is the member half of an access. */
  memberPart: boolean;
  /** Directly in a Python class body, outside any function. */
  classBody: boolean;
}

function findingsIn(root: Node, name: string, member: boolean, file: StoredSource): StoredFinding[] {
  const called = new Set<number>();
  const spelt = (text: string) => text === name || text === `#${name}` || text === `r#${name}`;
  const found: StoredFinding[] = [];
  const line = (at: number) => file.source.slice(0, at).split("\n").length;
  const python = file.language === "python";

  const leaf = (node: Node, context: Context, callNext: boolean): void => {
    if (/string_content|string_fragment/.test(node.type)) {
      if (context.byName && node.text === name) found.push({ how: "by-name", file: file.file, line: line(node.startIndex) });
      return;
    }
    if (!spelt(node.text) || !/identifier$/.test(node.type) || node.type === "type_identifier") return;
    // A Rust field is never a function: `x.f` without a call reads data.
    if (node.type === "field_identifier" && file.language === "rust") return;
    if (context.imported) {
      if (context.imported === "renamed") found.push({ how: "renamed", file: file.file, line: line(node.startIndex) });
      return;
    }
    if (called.has(node.startIndex) || callNext) {
      if (context.anonymous) {
        if (context.anonymous === "argument" && context.handedTo && runsOnTheSpot(context.handedTo, file, called)) return;
        found.push({
          how: "wrapped", file: file.file, line: line(node.startIndex),
          ...(context.anonymous === "argument" ? { argument: true as const } : {}),
          ...(context.wrappers ? { wrappers: context.wrappers } : {}),
        });
      }
      return;
    }
    if (context.quiet) return;
    if (member && !context.memberPart && node.type !== "private_property_identifier" && !(python && context.classBody)) return;
    found.push({ how: "value", file: file.file, line: line(node.startIndex) });
  };

  const visit = (node: Node, context: Context): void => {
    if (node.childCount === 0) { leaf(node, context, false); return; }
    let here: Context = { ...context, memberPart: false };
    if (IMPORTING.test(node.type) && !here.imported) here.imported = "plain";
    if (TYPE_OR_PATTERN.test(node.type)) here.quiet = true;
    if (node.childForFieldName("name") && node.childForFieldName("body") && !ANONYMOUS.has(node.type)) {
      // A named routine or a class: whatever is around it no longer decides.
      here = { ...here, anonymous: undefined, wrappers: undefined, classBody: python && node.type === "class_definition" };
    }
    const renames = Boolean(node.childForFieldName("alias")) && Boolean(here.imported);
    const byNameCall = Boolean(node.childForFieldName("arguments")) && BY_NAME.has(lastName(node.childForFieldName("function")));
    const path = node.type === "scoped_identifier";
    const calling = node.childForFieldName("arguments") ? plainCallee(node.childForFieldName("function")) : undefined;
    let position = 0;
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (!child) continue;
      const field = node.fieldNameForChild(index);
      const inner: Context = { ...here };
      if (renames) inner.imported = field === "alias" ? "plain" : "renamed";
      if (field && NOT_A_VALUE.has(field) && !(path && field === "name")) inner.quiet = true;
      else if (field && A_VALUE.has(field)) inner.quiet = false;
      if (field === "body" && python && node.type === "class_definition") inner.classBody = true;
      inner.memberPart = (field !== null && MEMBER_FIELD.has(field)) || (path && field === "name");
      inner.byName = field === "index" || field === "subscript" || (byNameCall && field === "arguments")
        || (here.byName && /argument|string/.test(node.type));
      inner.calling = field === "arguments" ? calling : undefined;
      const listed = /^(arguments|argument_list)$/.test(node.type);
      if (ANONYMOUS.has(child.type)) {
        const handed = listed || (node.type === "keyword_argument" && field === "value");
        inner.anonymous = handed ? "argument" : "stored";
        inner.wrappers = [...(here.wrappers ?? []), { start: child.startIndex, end: child.endIndex }];
        inner.handedTo = listed && here.calling ? { ...here.calling, index: position } : undefined;
        inner.classBody = false;
      }
      if (listed && child.isNamed && !/comment/.test(child.type)) position += 1;
      // Rust reads a macro's arguments as tokens: `go(x)` there is `go` and then a `( .. )`.
      if (node.type === "token_tree" && child.childCount === 0) {
        const next = node.child(index + 1);
        const before = node.child(index - 1);
        // In Rust only a path names a function: `x.f` with no call is a field.
        inner.memberPart = before?.type === "::";
        leaf(child, inner, next?.type === "token_tree" && next.child(0)?.type === "(");
        continue;
      }
      visit(child, inner);
    }
  };

  // Every name a call, a construction or a JSX tag is written with, and a decorator's.
  const mark = (node: Node): void => {
    const at = calledNameAt(node);
    if (at !== undefined) called.add(at);
    if (node.type === "decorator") {
      for (let index = 0; index < node.childCount; index += 1) {
        const child = node.child(index);
        const tail = child?.isNamed ? lastLeaf(child) : undefined;
        if (tail) called.add(tail.startIndex);
      }
    }
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child) mark(child);
    }
  };
  mark(root);
  visit(root, { quiet: false, byName: false, memberPart: false, classBody: false });
  for (const decorator of decoratedIn(root, name)) found.push({ how: "decorated", file: file.file, line: line(decorator.startIndex) });
  return found;
}

/** `f` in `f(..)`, `this.f(..)`, `self.f(..)`: a callee this file may declare. */
function plainCallee(written: Node | null): { name: string; own: boolean } | undefined {
  let node = written;
  // `await this.f<T>(..)` comes back from TypeScript's grammar as a call of `await this.f`.
  while (node && /^(await_expression|parenthesized_expression|instantiation_expression)$/.test(node.type)) node = lastNamed(node);
  if (!node) return undefined;
  if (node.childCount === 0) return /identifier$/.test(node.type) ? { name: node.text, own: false } : undefined;
  const object = node.childForFieldName("object");
  const member = node.childForFieldName("property") ?? node.childForFieldName("attribute");
  if (object && member && member.childCount === 0 && /^(this|self)$/.test(object.text)) return { name: member.text, own: true };
  return undefined;
}

/**
 * Whether a function handed to `handed.name` in its `handed.index` place is
 * only run there and kept nowhere: every routine of that name this file
 * declares does nothing with that parameter but call it. bullmq's worker
 * hands `() => this.handleFailed(..)` to its own `retryIfFailed(fn, opts)`,
 * whose body only ever writes `await fn()` -- nothing can find that function
 * again under another name. A runner in another file, or one that hands the
 * parameter on or keeps it, and the function stays one that may be stored.
 */
function runsOnTheSpot(handed: { name: string; own: boolean; index: number }, file: StoredSource, called: Set<number>): boolean {
  const { routines } = routinesNamed(file.source, handed.name, file.language);
  if (routines.length === 0) return false;
  return routines.every((routine) => {
    const list = parametersOf(routine) ?? parametersOf(routine.childForFieldName("value"));
    const body = routine.childForFieldName("body") ?? routine.childForFieldName("value")?.childForFieldName("body");
    if (!list || !body) return false;
    const parameters: Node[] = [];
    for (let index = 0; index < list.childCount; index += 1) {
      const one = list.child(index);
      if (one?.isNamed && !/comment/.test(one.type)) parameters.push(one);
    }
    // A method's receiver is not a place a call fills.
    const first = parameters[0] ? firstLeaf(parameters[0])?.text : undefined;
    if (first && /^(self|cls|this|&self|&mut self)$/.test(first) || parameters[0]?.type === "self_parameter") parameters.shift();
    const parameter = parameters[handed.index];
    const name = parameter ? firstLeaf(parameter) : undefined;
    if (!name || !/identifier$/.test(name.type)) return false;
    let onlyCalled = true;
    each(body, (node) => {
      if (onlyCalled && node.childCount === 0 && node.text === name.text && /identifier$/.test(node.type) && !called.has(node.startIndex)) onlyCalled = false;
    });
    return onlyCalled;
  });
}

function lastNamed(node: Node): Node | null {
  for (let index = node.childCount - 1; index >= 0; index -= 1) {
    const child = node.child(index);
    if (child?.isNamed) return child;
  }
  return null;
}

function firstLeaf(node: Node): Node | undefined {
  if (node.childCount === 0) return node;
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child?.isNamed) return firstLeaf(child);
  }
  return undefined;
}

function lastName(node: Node | null): string {
  return node ? lastLeaf(node)?.text ?? "" : "";
}

function lastLeaf(node: Node): Node | undefined {
  if (node.childCount === 0) return node;
  for (let index = node.childCount - 1; index >= 0; index -= 1) {
    const child = node.child(index);
    if (child?.isNamed) return lastLeaf(child);
  }
  return undefined;
}
