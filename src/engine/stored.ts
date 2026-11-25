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
 *
 * Three things a finding says beyond "it is written here", for the question
 * `calls.ts` asks of one call at a time -- could this call run the head at
 * all (calls research, 2026-11):
 *
 *   `wrappers`   for a routine called from a function with no name: where each
 *                such function is written, because it is what runs under the
 *                other name and is put to the same test as the routine
 *   `attached`   the routine is what a member, a key or a class-level name is
 *                set to: found on a class, Python fills its first parameter
 *   `test`       it is written in a test, which hands routines around to drive
 *                them; `inProduct` leaves those out (owner decision,
 *                2026-11-25: what a test hands in is not what the product calls)
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
   * For `wrapped`: every function with no name around the call, outermost
   * first, up to the nearest named routine -- where each is written, in
   * `file`. One of them is what runs under the other name, so a test of
   * whether a call can run the routine is put to each of them too
   * (`calls.ts`, "could this call run the far end?").
   */
  wrappers?: Array<{ start: number; end: number }>;
  /**
   * For `value`: the routine is written as what a member, a key or a name in
   * a class body is set to -- `Cls.run = helper`, `{ run: helper }`, `run =
   * helper` under `class`, `setattr(Cls, "run", helper)`. Found on a class,
   * Python hands a function the instance as its first argument.
   */
  attached?: true;
  /**
   * Written in a test: a test file, or in Rust a `#[cfg(test)]` module or a
   * `#[test]` function. What a test hands in is not what the product calls
   * (`inProduct`).
   */
  test?: true;
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
        const read = here ?? [{ how: "unread" as const, file: file.file, line: 0 }];
        found.push(...(isTestFile(file.file) ? read.map((one) => ({ ...one, test: true as const })) : read));
      }
    }
    known.set(key, found);
    return found;
  };
  return { findings };
}

/**
 * A test file, by each language's own conventions: a `test`, `tests`,
 * `__tests__`, `__mocks__`, `spec`, `specs`, `e2e`, `fixtures`, `benches` or
 * `benchmarks` directory (Cargo's `tests/` and `benches/` among them);
 * `x.test.ts`, `x.spec.js`, `x.test-d.ts`, `x.e2e.ts`, `x.bench.ts`; pytest's
 * `test_x.py`, `x_test.py` and `conftest.py`. And a bundle built out of the
 * same code, `x.min.js` or `x.umd.js`, which says nothing its source does not.
 *
 * Examples, documentation and a package's own testing helpers (`trio.testing`)
 * are not tests: they are written the way a user of the code writes.
 */
const TEST_FILE = new RegExp(
  "(^|/)(tests?|__tests__|__mocks__|specs?|e2e|__fixtures__|fixtures?|benches|benchmarks?)(/|$)"
  + "|\\.(test|spec|test-d|e2e|bench|min|umd)\\.[cm]?[jt]sx?$"
  + "|(^|/)test_[^/]*\\.py$|_test\\.py$|(^|/)conftest\\.py$",
);

/** Whether a repo-relative file is a test, or a bundle of code written elsewhere. */
export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file.split("\\").join("/"));
}

/**
 * The findings the product itself writes (owner decision, 2026-11-25): what a
 * test hands in is not what the product calls. `it("..", () => job.promote())`
 * names `promote` from a function with no name, and a test's mock stores a
 * routine wherever it likes; neither says how the code under test reaches it.
 * A walk that gave up (`unread`) stays: "cannot tell" is never "nothing". A
 * test file that would not parse is still a test, and is left out.
 *
 * The cost, on the record: a routine only a test swaps in is read as never
 * swapped in.
 */
export function inProduct<T extends { how: string; test?: true }>(findings: readonly T[]): T[] {
  return findings.filter((one) => !one.test);
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
  /** The functions with no name around this, outermost first, up to the nearest named routine. */
  wrappers?: Array<{ start: number; end: number }>;
  /** Inside a Rust `#[cfg(test)]` module or `#[test]` function. */
  test?: true;
  /** Under what a member, a key or a class-level name is set to (`StoredFinding.attached`). */
  attaches?: true;
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
  const rust = file.language === "rust";
  /** A finding, marked as a test's when it is written in one. */
  const note = (one: StoredFinding, context: Context): void => { found.push(context.test ? { ...one, test: true } : one); };

  const leaf = (node: Node, context: Context, callNext: boolean): void => {
    if (/string_content|string_fragment/.test(node.type)) {
      if (context.byName && node.text === name) note({ how: "by-name", file: file.file, line: line(node.startIndex) }, context);
      return;
    }
    if (!spelt(node.text) || !/identifier$/.test(node.type) || node.type === "type_identifier") return;
    // A Rust field is never a function: `x.f` without a call reads data.
    if (node.type === "field_identifier" && file.language === "rust") return;
    if (context.imported) {
      if (context.imported === "renamed") note({ how: "renamed", file: file.file, line: line(node.startIndex) }, context);
      return;
    }
    if (called.has(node.startIndex) || callNext) {
      if (context.anonymous) {
        if (context.anonymous === "argument" && context.handedTo && runsOnTheSpot(context.handedTo, file, called)) return;
        note({
          how: "wrapped", file: file.file, line: line(node.startIndex),
          ...(context.anonymous === "argument" ? { argument: true as const } : {}),
          ...(context.wrappers ? { wrappers: context.wrappers } : {}),
        }, context);
      }
      return;
    }
    if (context.quiet) return;
    if (member && !context.memberPart && node.type !== "private_property_identifier" && !(python && context.classBody)) return;
    note({ how: "value", file: file.file, line: line(node.startIndex), ...(context.attaches ? { attached: true as const } : {}) }, context);
  };

  const visit = (node: Node, context: Context): void => {
    if (node.childCount === 0) { leaf(node, context, false); return; }
    let here: Context = { ...context, memberPart: false };
    if (IMPORTING.test(node.type) && !here.imported) here.imported = "plain";
    if (TYPE_OR_PATTERN.test(node.type)) here.quiet = true;
    if (node.childForFieldName("name") && node.childForFieldName("body") && !ANONYMOUS.has(node.type)) {
      // A named routine or a class: whatever is around it no longer decides.
      here = { ...here, anonymous: undefined, wrappers: undefined, attaches: undefined, classBody: python && node.type === "class_definition" };
    }
    // `x.m = ..`, `x[k] = ..`, and in a Python class body `m = ..`: the right side lands on something.
    const target = node.childForFieldName("right") ? node.childForFieldName("left") : null;
    const lands = target !== null && (target.childCount > 0 || (python && here.classBody));
    const keyed = node.childForFieldName("key") !== null;
    const renames = Boolean(node.childForFieldName("alias")) && Boolean(here.imported);
    const byNameCall = Boolean(node.childForFieldName("arguments")) && BY_NAME.has(lastName(node.childForFieldName("function")));
    const path = node.type === "scoped_identifier";
    const calling = node.childForFieldName("arguments") ? plainCallee(node.childForFieldName("function")) : undefined;
    let position = 0;
    // Rust writes a test where the product is: the item under `#[cfg(test)]` or `#[test]`.
    let testNext = false;
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (!child) continue;
      const field = node.fieldNameForChild(index);
      const inner: Context = { ...here };
      if (rust) {
        if (child.type === "attribute_item") { if (RUST_TEST_ATTRIBUTE.test(child.text)) testNext = true; }
        else if (child.isNamed && !/comment/.test(child.type)) {
          if (testNext) inner.test = true;
          testNext = false;
        }
      }
      if (renames) inner.imported = field === "alias" ? "plain" : "renamed";
      if (field && NOT_A_VALUE.has(field) && !(path && field === "name")) inner.quiet = true;
      else if (field && A_VALUE.has(field)) inner.quiet = false;
      if (field === "body" && python && node.type === "class_definition") inner.classBody = true;
      inner.memberPart = (field !== null && MEMBER_FIELD.has(field)) || (path && field === "name");
      inner.byName = field === "index" || field === "subscript" || (byNameCall && field === "arguments")
        || (here.byName && /argument|string/.test(node.type));
      if ((field === "right" && lands) || (field === "value" && keyed) || (field === "arguments" && byNameCall)) inner.attaches = true;
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

/**
 * Rust's own marks for a test: `#[cfg(test)]` on a module or an item, `#[test]`
 * on a function, and a test harness's attribute of that last name
 * (`#[tokio::test]`, `#[rstest]` is not one and is left alone).
 */
const RUST_TEST_ATTRIBUTE = /^#\[\s*(cfg\s*\(\s*test\s*\)|(\w+\s*::\s*)*test\b)/;

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
