/**
 * Whether one routine calls another.
 *
 * The gap this closes (#189): calling is the single most common thing one piece
 * of code does to another -- 162,051 call relationships across the 3,297-file
 * census in #187, 53.2% of everything the syntax shows and four times the next
 * relation -- and until now an arrow could not say it. The model kept trying
 * anyway: `will call` and `calls` are the two most written pieces of prose on
 * any arrow in the board corpus, in the space where a word should be.
 *
 * ## Why this is harder than every other word here
 *
 * A field list, a signature and a file's imports are all readable inside one
 * file. **A call is not.** `foo()` is a name, and which `foo` it means is a
 * question about bindings that live somewhere else. Every other reader in this
 * directory can finish its job with the text in front of it; this one cannot,
 * and that is the whole of the difficulty.
 *
 * So the reader is two layers, and the second is the one that does the work:
 *
 *   1. **The call sites in a routine.** `parse.ts` already says a call is a
 *      node with a `function` field, and that holds in all four grammars.
 *   2. **What each called name is bound to.** A bare `foo` is the file's own
 *      `foo`, or a `foo` some import brought in, and those are different
 *      functions with one spelling. `bindingsIn` reads the import declarations
 *      and answers which.
 *
 * A call whose name cannot be tied to one file is not evidence of anything, and
 * this file is written so that such a call **raises a doubt** rather than
 * quietly counting as an absence.
 *
 * ## The footing: presence, like `@builds` and never like `@holds`
 *
 * `holds.ts` reads a declaration, so absence there is genuine absence. A
 * function body is not a declaration. A routine that never writes `b()` can
 * still reach `b` through a callback, a trait object, a dispatch table or a
 * decorator -- which is the `feeds` argument, in full, one relation over. So
 * **`absent` is not a finding here and must never become one.**
 *
 * What is available is the verdict `needs.ts` was built for and the one worth
 * having: finding the call running the **other way**, and only the other way,
 * is proof the arrow is backwards. That rests on something found rather than on
 * something missing.
 *
 * ## Every doubt is about a name, not about a body
 *
 * The first version of this raised a doubt on every call it could not resolve,
 * and refused 97% of the corpus: an ordinary body is full of `console.log` and
 * `.map()` and none of them can be resolved to a file, nor need to be.
 *
 * The rule that fixes it is that a doubt is only a doubt **about the name being
 * asked after**. `obj.render()` is unresolvable and irrelevant unless the far
 * box is called `render`; then it is a call that might be the one, and the
 * reader must stay quiet. A call whose name cannot be read at all -- `table[k]()`
 * -- is always a doubt, because the name it hides could be any name.
 *
 * ## The five ways a call escapes a static reader, and what happens to each
 *
 * The list is #189's, and none of them is answered -- each one is a reason to
 * withhold, which is the only honest thing available:
 *
 *   dynamic dispatch       a receiver whose type is not in the text  -> `receiver`
 *   callbacks              the name is passed, never called here     -> nothing to see
 *   `getattr`, `exec`      the body can reach anything at all        -> `dynamic`
 *   re-exports, barrels    the name binds to a file that forwards    -> `elsewhere`
 *   macros                 the call site is generated, not written   -> `macro`
 */
import { mayAccuse } from "./licence";
import { each, parseSource, type Language, type Node, type Tree } from "./parse";

/**
 * Why no verdict was reached. Every one of these is a reason to stay quiet, and
 * the caller reports the arrow exactly as it would have been reported before
 * anybody claimed anything.
 */
export type CallsWithheld =
  /** No grammar for this language, or the file would not parse at all. */
  | "unreadable"
  /** Nothing in that file declares that name. */
  | "not-declared"
  /** The name is declared and it is not a routine. There is no body to read. */
  | "no-body"
  /**
   * The parse recovered from an error, so what is and is not in this body is a
   * statement about a file we only partly read.
   */
  | "incomplete"
  /**
   * A call whose callee is a value: `table[kind]()`, `handlers[i]()`.
   *
   * The same `computed-call` doubt `deps.ts` names. The name is not in the
   * text, so it could be the one being asked after, and this doubt is raised
   * whatever the question was.
   */
  | "computed"
  /**
   * The body can reach a name that is nowhere in it: `getattr`, `eval`, `exec`.
   *
   * Python's whole hazard, and it is not a hypothetical -- `getattr(handler,
   * name)()` is how a dispatcher is spelled there.
   */
  | "dynamic"
  /** The declaration came out of macro soup, and the call site with it. */
  | "macro"
  /**
   * A call on a receiver whose type the text does not give: `obj.run()`.
   *
   * Raised only when the member is the name being asked after. Dynamic
   * dispatch, in all four grammars, is this.
   */
  | "receiver"
  /**
   * The name is called and nothing in the file says where it came from -- a
   * wildcard import, a global, an ambient declaration.
   */
  | "unbound"
  /**
   * The name is bound twice over: declared here *and* imported, or imported
   * from two places. Which one the call means is not in the text.
   */
  | "ambiguous"
  /**
   * The name binds to a file that is not the far end, and following the
   * forwarding ran out of road -- a file that could not be opened, a wildcard
   * re-export, a chain longer than the budget.
   *
   * Barrel files and re-exports. The binding is readable and stops short of an
   * answer.
   */
  | "elsewhere"
  /**
   * The name is imported and the specifier resolved to no file in this
   * repository.
   *
   * Usually a package: `from unittest.mock import patch`. Sometimes not -- a
   * monorepo's `@mundane/ui` is inside the repository and resolves to nothing
   * here, and reading that as "definitely not the far end" is how a workspace
   * alias becomes a false accusation. The two are indistinguishable to this
   * reader, so both withhold.
   */
  | "unplaced"
  /**
   * The language has a grammar and no measured licence, so nothing has ever
   * checked how often this reader is wrong about it. Confirming is unaffected;
   * it is the accusation that needs the licence (#198).
   */
  | "unlicensed";

/** Where the call was written, so a report can quote a file and a line. */
export interface CallsEvidence {
  /** The routine that was called. */
  name: string;
  /** The routine the call was written inside. */
  inside: string;
  /** 1-based, in the file the call was written in. */
  line: number;
  /** The call as written, so a verdict that can refute shows what it read. */
  wrote: string;
}

export type CallsVerdict =
  /** The tail calls the routine the arrow points at. */
  | { verdict: "confirmed"; evidence: CallsEvidence }
  /**
   * The call runs the other way, and only the other way: the head calls the
   * tail. The arrow is backwards.
   */
  | { verdict: "backwards"; evidence: CallsEvidence }
  /**
   * Neither end calls the other, as far as the text shows.
   *
   * **Not a finding, and this must stay true.** A callback is invisible here,
   * so this is "no call found", never "no call happens". Reported exactly as an
   * unclaimed arrow is.
   */
  | { verdict: "absent" }
  | { verdict: "withheld"; why: CallsWithheld };

/** One end of the question: a file, its text, and what its imports point at. */
export interface CallSide {
  /** Repo-relative, and the identity a binding is compared against. */
  file: string;
  source: string;
  language: Language;
  /**
   * This file's dependencies, already resolved to files by `deps.ts`.
   *
   * Handed in rather than read here, because resolving a specifier to a file is
   * three different problems in three languages and `deps.ts`, `deps-rust.ts`
   * and `deps-python.ts` have each been measured at it. This file's job is the
   * half nothing else does: which specifier a *name* came from.
   */
  imports: Array<{ specifier: string; file?: string }>;
  /**
   * Another file in the same repository, when one can be read.
   *
   * A name is very often imported from a file that does not declare it --
   * `from graphify.extract import extract_objc`, where `extract.py` re-exports
   * what `extractors/objc.py` declares. Without this the reader answered
   * `absent` on 250 calls in one repository that are written in plain sight,
   * and each one of those is half of a false `backwards`.
   *
   * Optional, because a caller holding one file can still get a confirmation
   * out of this reader. Without it a forwarded name withholds.
   */
  open?: (file: string) => { source: string; language: Language; imports: CallSide["imports"] } | undefined;
}

/* ------------------------------------------------------------------ bindings */

/** What one name in a file is bound to. */
interface Binding {
  /** The import specifier it came from, spelled as the language writes it. */
  specifier: string;
  /** True when the name stands for a module rather than for a routine. */
  namespace: boolean;
}

export interface Bindings {
  /** Names this file brought in, and where from. */
  imported: Map<string, Binding>;
  /** Names declared in this file's own text. */
  local: Set<string>;
  /** Names bound more than once, where the text does not say which wins. */
  ambiguous: Set<string>;
  /**
   * Names this file passes on without binding: `export { x } from "./y"`.
   *
   * Not a binding -- nothing in this file can call `x` -- so it is kept apart
   * from `imported`. It is the only thing that makes a barrel file followable.
   */
  forwarded: Map<string, Binding>;
  /**
   * True when the file brings in or passes on names nothing can enumerate:
   * `from x import *`, `export * from "./y"`, `use crate::a::*`.
   *
   * A file like this can never answer "the name did not come from here", so
   * following through it stops rather than concluding.
   */
  wildcard: boolean;
}

/** The separators a module path is written with, in the four grammars. */
const PATH_STEP = ["::", ".", "/"];

/** Whether `outer` names `inner` or a module above it. */
function pathCovers(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  return PATH_STEP.some((step) => inner.startsWith(outer + step));
}

/**
 * The last segment of a dotted or scoped path, which is the name it binds.
 *
 * `import a.b` binds `a`, not `b` -- Python's one exception, handled by its own
 * caller rather than here.
 */
function lastSegment(path: string): string {
  return path.split(/::|\./).pop() ?? path;
}

function bind(into: Bindings, name: string, binding: Binding): void {
  if (into.local.has(name)) { into.ambiguous.add(name); return; }
  const already = into.imported.get(name);
  if (already && already.specifier !== binding.specifier) { into.ambiguous.add(name); return; }
  into.imported.set(name, binding);
}

/** Direct children of a node, which no grammar exposes as an array. */
function children(node: Node): Node[] {
  const out: Node[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child) out.push(child);
  }
  return out;
}

/**
 * TypeScript, JavaScript and TSX: everything hangs off `import_clause`.
 *
 * `export { x } from "./y"` is deliberately not read. It binds nothing in this
 * file -- it forwards -- and reading it as a binding is how a barrel file would
 * have started answering questions about names it only passes through.
 */
function bindTypeScript(root: Node, into: Bindings): void {
  each(root, (node) => {
    const isImport = node.type === "import_statement";
    if (!isImport && node.type !== "export_statement") return;
    const from = node.childForFieldName("source");
    if (!from) return;
    const specifier = from.text.slice(1, -1);
    /*
     * `export { x } from "./y"` binds nothing here -- no code in this file can
     * call `x` -- so it goes in `forwarded`, which is the map that makes a
     * barrel file followable and the reason this branch exists at all.
     */
    const into_ = isImport ? into.imported : into.forwarded;
    const record = (name: string, namespace: boolean) => {
      if (isImport) bind(into, name, { specifier, namespace });
      else into_.set(name, { specifier, namespace });
    };

    for (const part of children(node)) {
      if (part.type === "export_clause" || part.type === "named_imports") {
        for (const one of children(part)) {
          if (one.type !== "export_specifier" && one.type !== "import_specifier") continue;
          const alias = one.childForFieldName("alias") ?? one.childForFieldName("name");
          if (alias) record(alias.text, false);
        }
        continue;
      }
      if (part.type === "*") { into.wildcard = true; continue; }
      if (part.type !== "import_clause") continue;
      for (const clause of children(part)) {
        if (clause.type === "identifier") {
          // `import def from "./y"`.
          record(clause.text, false);
        } else if (clause.type === "namespace_import") {
          const name = children(clause).find((child) => child.type === "identifier");
          if (name) record(name.text, true);
        } else if (clause.type === "named_imports") {
          for (const one of children(clause)) {
            if (one.type !== "import_specifier") continue;
            const alias = one.childForFieldName("alias") ?? one.childForFieldName("name");
            if (alias) record(alias.text, false);
          }
        }
      }
    }
  });
}

/**
 * Python, where the same keyword binds two different kinds of thing.
 *
 * `from x import foo` binds the routine `foo` and the specifier is `x.foo`,
 * which is exactly the shape `deps-python.ts` records for it. `import a.b`
 * binds the *module* `a` -- the first segment, not the last -- and `a.b.go()`
 * reaches through it.
 *
 * `from x import *` binds names this reader cannot enumerate. Nothing is
 * recorded, and every name it brought in comes out `unbound`, which is the
 * correct answer rather than a gap.
 */
function bindPython(root: Node, into: Bindings): void {
  each(root, (node) => {
    if (node.type === "import_from_statement") {
      const moduleNode = node.childForFieldName("module_name");
      if (!moduleNode) return;
      const module = moduleNode.text;
      for (const part of children(node)) {
        if (part.id === moduleNode.id) continue;
        if (part.type === "dotted_name") {
          bind(into, lastSegment(part.text), { specifier: `${module}.${part.text}`, namespace: false });
        } else if (part.type === "aliased_import") {
          const name = part.childForFieldName("name");
          const alias = part.childForFieldName("alias");
          if (name && alias) {
            bind(into, alias.text, { specifier: `${module}.${name.text}`, namespace: false });
          }
        } else if (part.type === "wildcard_import") {
          into.wildcard = true;
        }
      }
      return;
    }
    if (node.type !== "import_statement") return;
    for (const part of children(node)) {
      if (part.type === "dotted_name") {
        // `import a.b` puts `a` in scope, and only `a`.
        const head = part.text.split(".")[0]!;
        bind(into, head, { specifier: head, namespace: true });
      } else if (part.type === "aliased_import") {
        const name = part.childForFieldName("name");
        const alias = part.childForFieldName("alias");
        if (name && alias) bind(into, alias.text, { specifier: name.text, namespace: true });
      }
    }
  });
}

/**
 * Rust, where one `use` can bind a dozen names and the tree is nested.
 *
 * `use crate::a::{b, c as d}` is a `scoped_use_list`, and every leaf under it is
 * a separate binding whose specifier is the full path -- which is what
 * `deps-rust.ts` records and what `pathCovers` then matches against.
 *
 * A `use ...::*` binds names nothing can list, exactly as Python's does, and is
 * left out for the same reason.
 */
function bindRust(root: Node, into: Bindings): void {
  const walk = (node: Node, prefix: string): void => {
    switch (node.type) {
      case "scoped_use_list": {
        const path = node.childForFieldName("path");
        const list = node.childForFieldName("list");
        const under = path ? (prefix ? `${prefix}::${path.text}` : path.text) : prefix;
        if (list) for (const one of children(list)) walk(one, under);
        return;
      }
      case "use_list": {
        for (const one of children(node)) walk(one, prefix);
        return;
      }
      case "use_as_clause": {
        const path = node.childForFieldName("path");
        const alias = node.childForFieldName("alias");
        if (!path || !alias) return;
        const full = prefix ? `${prefix}::${path.text}` : path.text;
        bind(into, alias.text, { specifier: full, namespace: false });
        return;
      }
      case "use_wildcard":
        // Binds names nothing can enumerate, so nothing is recorded and the
        // flag stops a follow rather than letting it conclude.
        into.wildcard = true;
        return;
      case "scoped_identifier":
      case "identifier":
      case "crate":
      case "self":
      case "super": {
        const full = prefix ? `${prefix}::${node.text}` : node.text;
        const name = lastSegment(full);
        if (name) bind(into, name, { specifier: full, namespace: false });
        return;
      }
      default:
    }
  };

  each(root, (node) => {
    if (node.type !== "use_declaration") return;
    const argument = node.childForFieldName("argument");
    if (argument) walk(argument, "");
  });
}

/**
 * Statements that bring a name in from somewhere else rather than declaring it.
 *
 * Pruned rather than filtered, because an import *looks* exactly like a
 * declaration to the rule `parse.ts` states -- `import { foo }` is a node with a
 * `name` field, and so is `use crate::a::foo`. The first version of this counted
 * every imported name as locally declared, which made every import in every
 * TypeScript file ambiguous with itself: 217 refusals in `ts` and 156 in `tsx`,
 * and **zero** cross-file calls confirmed in either. The whole word looked
 * impossible in TypeScript and the cause was one missing exclusion.
 */
const BRINGS_IN = /^(import_statement|import_from_statement|use_declaration|future_import_statement)$/;

/**
 * Node types that declare a name, as opposed to merely carrying one.
 *
 * Needed for the same reason `BRINGS_IN` is. `f(name=1)` in Python is a
 * `keyword_argument` with a `name` field, and a parameter with a default is a
 * `default_parameter` with one -- neither declares anything a call could reach,
 * and both would make an ordinary import ambiguous with an argument label.
 */
const DECLARES = /(_declaration|_definition|_declarator|_item)$/;

/**
 * Declarations a bare call could never reach: the members of a type.
 *
 * `interface EmailPreviewProps { registerRef: ... }` declares a name, and
 * nothing in that file can call it -- it is the shape of somebody else's
 * argument. Counting it made a call to an imported `registerRef` read as a call
 * to "this file's own", which is a definite no rather than a doubt, and the
 * reader answered `absent` on a call written three lines below the interface.
 *
 * A method is left in. It is reached through `self` or `this`, and that branch
 * asks a different question.
 */
const NOT_REACHABLE =
  /^(property_signature|method_signature|call_signature|construct_signature|abstract_method_signature|public_field_definition|field_definition|field_declaration|enum_variant)$/;

/** Names this file declares itself, at any depth, imports excluded. */
function declaredNames(node: Node, into: Set<string>): void {
  if (BRINGS_IN.test(node.type)) return;
  if (DECLARES.test(node.type) && !NOT_REACHABLE.test(node.type)) {
    const name = node.childForFieldName("name")
      ?? (node.type === "impl_item" ? node.childForFieldName("type") : undefined);
    if (name && name.childCount === 0) into.add(name.text);
  }
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child) declaredNames(child, into);
  }
}

const BINDINGS_LIMIT = 512;
/**
 * What a file binds, remembered across the questions asked about it.
 *
 * Nothing here has a shelf life: the key is the file's whole text, so an edited
 * file is a different question and a stale answer cannot be returned. What it
 * buys is that the answer is a fact about a *file* while the caller asks it once
 * per *call site*. `measure:calls` asked this 19,320 times about 775 files --
 * every one of those a full walk of the tree, and every node on that walk a
 * crossing into WebAssembly and back.
 *
 * Bounded and holding only strings. `parseSource` has to keep its own cache
 * small because a tree is WebAssembly memory that only `delete()` returns; this
 * one holds names, so it can afford to remember more files than that.
 */
const bindings_ = new Map<string, Bindings | undefined>();

/**
 * What every name in a file is bound to.
 *
 * Exported because the measurement drives it directly: the binding half is
 * where a call reader goes wrong, and a number about the whole verdict would
 * not say which layer produced it.
 */
export function bindingsIn(source: string, language: Language): Bindings | undefined {
  const remembered = `${language}:${source}`;
  if (bindings_.has(remembered)) {
    const cached = bindings_.get(remembered);
    bindings_.delete(remembered);
    bindings_.set(remembered, cached);
    return cached;
  }
  const found = readBindings(source, language);
  bindings_.set(remembered, found);
  if (bindings_.size > BINDINGS_LIMIT) {
    const oldest = bindings_.keys().next();
    if (!oldest.done) bindings_.delete(oldest.value);
  }
  return found;
}

function readBindings(source: string, language: Language): Bindings | undefined {
  const tree = parseSource(source, language);
  if (!tree) return undefined;
  const bindings: Bindings = {
    imported: new Map(), local: new Set(), ambiguous: new Set(),
    forwarded: new Map(), wildcard: false,
  };
  declaredNames(tree.rootNode, bindings.local);
  if (language === "python") bindPython(tree.rootNode, bindings);
  else if (language === "rust") bindRust(tree.rootNode, bindings);
  else bindTypeScript(tree.rootNode, bindings);
  // A name that is both declared here and imported was bound twice; `bind`
  // catches the orders it sees, and this catches the one it cannot.
  for (const name of bindings.imported.keys()) {
    if (bindings.local.has(name)) bindings.ambiguous.add(name);
  }
  return bindings;
}

/* --------------------------------------------------------------- call sites */

/** How a call names the thing it calls. */
type Callee =
  /** `foo()` -- a bare name in this file's scope. */
  | { kind: "bare"; name: string }
  /** `self.foo()`, `this.foo()` -- a member of the thing the routine belongs to. */
  | { kind: "own"; name: string }
  /** `ns.foo()`, `Type::foo()` -- a member of something else that is named. */
  | { kind: "through"; through: string; name: string }
  /** `table[k]()` -- the name is not in the text. */
  | { kind: "computed" };

/** The receivers that mean "the thing this routine is part of". */
const OWN = new Set(["self", "this"]);

/** A name a reader would recognise, wherever a grammar puts one. */
const NAME_LEAF = /identifier$|^field_identifier$|^property_identifier$/;

function calleeOf(node: Node): Callee | undefined {
  const callee = node.childForFieldName("function") ?? node.childForFieldName("macro");
  return callee ? calleeOfNode(callee) : undefined;
}

function calleeOfNode(callee: Node): Callee {
  if (callee.childCount === 0) {
    return NAME_LEAF.test(callee.type) ? { kind: "bare", name: callee.text } : { kind: "computed" };
  }

  /*
   * `foo::<T>()` in Rust is a `generic_function` wrapping the real callee, and
   * reading it as a member access made 66 Rust calls come back `computed` -- a
   * doubt about a name that was right there in the text.
   */
  const inner = callee.childForFieldName("function");
  if (inner) return calleeOfNode(inner);

  const object = callee.childForFieldName("object")
    ?? callee.childForFieldName("value")
    ?? callee.childForFieldName("path")
    ?? callee.child(0);
  const member = callee.childForFieldName("property")
    ?? callee.childForFieldName("attribute")
    ?? callee.childForFieldName("field")
    ?? callee.childForFieldName("name");
  if (!object || !member || member.childCount !== 0) return { kind: "computed" };
  if (OWN.has(object.text)) return { kind: "own", name: member.text };
  // A receiver that is itself an expression -- `make().run()`, `a.b.c()` -- names
  // nothing this reader can look up. Treated as an unknown receiver rather than
  // as a computed callee: the member *is* readable, so the doubt it raises is
  // only about the name it is a member of.
  const through = object.childCount === 0 ? object.text : "";
  return { kind: "through", through, name: member.text };
}

/** 1-based line of a byte offset, counted the way an editor counts. */
const lineOf = (source: string, offset: number) => source.slice(0, offset).split("\n").length;

/**
 * The names a body can reach without naming them.
 *
 * All four languages have a way to call a string, and a body that uses one can
 * call anything at all -- so the doubt is raised whatever name was asked after,
 * the same way a computed callee is.
 */
const REACHES_ANYTHING = new Set([
  "getattr", "setattr", "eval", "exec", "__import__", "globals", "locals", "vars",
  "apply", "call", "Function",
]);

type Named = { routines: Node[]; declared: boolean; unreadable: boolean };
const named_ = new WeakMap<Tree, Map<string, Named>>();

/**
 * Every routine of this name in this source.
 *
 * The rule and its reasoning are `constructs.ts`'s, and deliberately identical:
 * a routine is a declaration that has `parameters`, which is one of the three
 * facts `parse.ts` says holds in every grammar; a Rust `impl` block names its
 * type on a `type` field; and a box that names a *type* is scanned through the
 * routines inside it, because nobody draws a box for one method of a class.
 */
function routinesNamed(
  source: string,
  routine: string,
  language: Language,
): Named {
  const tree = parseSource(source, language);
  if (!tree) return { routines: [], declared: false, unreadable: true };

  /*
   * Held against the tree rather than against the text, because what is
   * remembered here are nodes *inside* that tree -- they mean nothing once it
   * is freed. A weak key is exactly that lifetime: `parseSource` evicting a
   * tree makes every answer about it unreachable, so a stale node cannot come
   * back. The same file gets asked about a dozen different routines and every
   * one of those walked the whole tree again.
   */
  const found_ = named_.get(tree) ?? new Map<string, Named>();
  named_.set(tree, found_);
  const remembered = found_.get(routine);
  if (remembered) return remembered;

  const routines: Node[] = [];
  let declared = false;
  each(tree.rootNode, (node) => {
    const name = node.type === "impl_item"
      ? node.childForFieldName("type")
      : node.childForFieldName("name") ?? node.childForFieldName("left");
    if (!name || name.childCount !== 0 || name.text !== routine) return;
    declared = true;
    const value = node.childForFieldName("value");
    if (node.childForFieldName("parameters") ?? value?.childForFieldName("parameters")) {
      routines.push(node);
      return;
    }
    if (holdsRoutines(node)) routines.push(node);
  });
  const answer = { routines, declared, unreadable: false };
  found_.set(routine, answer);
  return answer;
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
 * Which files a bound name could have come from.
 *
 * The binding says `crate::a::b::foo` or `./layout` or `flask.app.Flask`, and
 * `deps.ts` has already turned this file's specifiers into repo-relative files.
 * A dependency answers for a binding when its specifier names the binding or a
 * module above it -- which is what the three readers record and the only way
 * one entry for `crate::a::b` can answer for a name inside it.
 *
 * An empty result is a binding whose specifier resolved to nothing, which means
 * a module outside this repository. That is a definite answer -- the far end is
 * inside it -- and not a doubt.
 */
function filesFor(specifier: string, imports: CallSide["imports"]): { files: Set<string>; known: boolean } {
  const files = new Set<string>();
  let known = false;
  for (const one of imports) {
    if (!pathCovers(one.specifier, specifier) && !pathCovers(specifier, one.specifier)) continue;
    known = true;
    if (one.file) files.add(one.file);
  }
  return { files, known };
}

/**
 * How many files deep a forwarded name is followed.
 *
 * A re-export chain in real code is one hop -- `extract.py` passing on what
 * `extractors/objc.py` declares -- and three is well past anything measured.
 * The budget exists so a cycle of barrels cannot make one arrow expensive; it
 * runs out into a doubt, never into an answer.
 */
const FOLLOW_LIMIT = 3;

/**
 * Whether the name a file was asked for arrives at the far end.
 *
 * "yes" is the name declared there. "no" is a file that declares this name
 * itself and is not the far end -- a definite answer, which is what lets a
 * genuine name collision stay quiet instead of raising a doubt. Anything else
 * is "maybe", and the caller turns that into a refusal.
 */
function arrivesAt(
  name: string,
  file: string,
  side: CallSide,
  target: string,
  seen: Set<string>,
): "yes" | "no" | "maybe" {
  if (file === target) return "yes";
  if (seen.has(file) || seen.size >= FOLLOW_LIMIT) return "maybe";
  seen.add(file);

  const opened = side.open?.(file);
  if (!opened) return "maybe";
  const bindings = bindingsIn(opened.source, opened.language);
  if (!bindings) return "maybe";
  if (bindings.ambiguous.has(name)) return "maybe";

  const onward = bindings.imported.get(name) ?? bindings.forwarded.get(name);
  if (!onward) {
    // Declared right here, and here is not the far end. The one place a
    // forwarding search gets to say no.
    if (bindings.local.has(name) && !bindings.wildcard) return "no";
    return "maybe";
  }

  const { files } = filesFor(onward.specifier, opened.imports);
  if (files.has(target)) return "yes";
  if (files.size === 0) return "maybe";
  let maybe = false;
  for (const next of files) {
    const answer = arrivesAt(name, next, side, target, seen);
    if (answer === "yes") return "yes";
    if (answer === "maybe") maybe = true;
  }
  return maybe ? "maybe" : "no";
}

/**
 * Whether one call site is a call to a name declared in the far file.
 *
 * `undefined` is "no", with certainty. A reason is "maybe, and the text does not
 * say", which is the whole point of this file.
 */
function resolves(
  callee: Callee,
  side: CallSide,
  bindings: Bindings,
  target: { file: string; names: Set<string> },
): "yes" | CallsWithheld | undefined {
  if (callee.kind === "computed") return "computed";
  if (callee.kind === "bare" && REACHES_ANYTHING.has(callee.name)) return "dynamic";
  if (callee.kind === "through" && REACHES_ANYTHING.has(callee.name)) return "dynamic";
  if (!target.names.has(callee.name)) return undefined;

  /*
   * A member of `self` is a member of whatever the routine belongs to, and that
   * is in this file. Same file, so the name is placed; a different file, and the
   * text says nothing about whose method it is.
   */
  if (callee.kind === "own") return side.file === target.file ? "yes" : "receiver";

  const bound = callee.kind === "through" ? callee.through : callee.name;
  if (!bound) return "receiver";
  if (bindings.ambiguous.has(bound)) return "ambiguous";

  const imported = bindings.imported.get(bound);
  if (!imported) {
    /*
     * Not imported. Declared here is an answer -- the call means this file's own
     * -- and anything else is a name from a wildcard import, a global or an
     * ambient declaration, which the text does not place.
     *
     * The two are told apart because they send a reader to different places. A
     * bare `foo()` naming nothing is `unbound`: something brought that name into
     * scope invisibly. `thing.foo()` where `thing` is an ordinary local is
     * `receiver`: the name is placed, and what it is a member *of* is a value
     * whose type is not in the text. That is dynamic dispatch, and it is the
     * first hazard #189 lists.
     */
    if (!bindings.local.has(bound)) return callee.kind === "through" ? "receiver" : "unbound";
    if (side.file === target.file) return "yes";
    return callee.kind === "through" ? "receiver" : undefined;
  }

  const { files, known } = filesFor(imported.specifier, side.imports);
  if (files.has(target.file)) return "yes";
  /*
   * Imported from a module that resolved to no file here. A package, almost
   * always -- and sometimes a workspace alias that is inside the repository and
   * that `resolve.ts` cannot place. Nothing separates the two, so it withholds.
   */
  if (files.size === 0) return known ? "unplaced" : "unbound";

  // Resolved, and to somewhere else. Follow it: the file it landed on may be
  // passing the name on from the far end.
  let maybe = false;
  for (const file of files) {
    const answer = arrivesAt(callee.name, file, side, target.file, new Set());
    if (answer === "yes") return "yes";
    if (answer === "maybe") maybe = true;
  }
  return maybe ? "elsewhere" : undefined;
}

/**
 * Every call one routine makes to the far end, and every reason to doubt the
 * answer if none was found.
 *
 * A confirmation needs one call site and nothing else. An absence needs the
 * whole body read without a doubt in it, which is the asymmetry the verdicts
 * below are built on.
 */
function callsTo(
  side: CallSide,
  routine: string,
  target: { file: string; names: Set<string> },
): { evidence?: CallsEvidence; why?: CallsWithheld } {
  const bindings = bindingsIn(side.source, side.language);
  if (!bindings) return { why: "unreadable" };

  const { routines, declared, unreadable } = routinesNamed(side.source, routine, side.language);
  if (unreadable) return { why: "unreadable" };
  if (routines.length === 0) return { why: declared ? "no-body" : "not-declared" };

  let why: CallsWithheld | undefined;
  for (const body of routines) {
    if (body.hasError) { why ??= "incomplete"; continue; }
    let found: CallsEvidence | undefined;
    each(body, (node) => {
      if (found) return;
      /*
       * A macro's arguments are loose tokens rather than a tree, so a call
       * written inside one is invisible. Only a doubt when the name being asked
       * after is somewhere in those tokens -- otherwise every `println!` in
       * Rust would silence every question.
       */
      if (node.type === "token_tree") {
        if ([...target.names].some((name) => new RegExp(`\\b${escapeName(name)}\\b`).test(node.text))) {
          why ??= "macro";
        }
        return;
      }
      const callee = calleeOf(node);
      if (!callee) return;
      const answer = resolves(callee, side, bindings, target);
      if (answer === undefined) return;
      if (answer === "yes") {
        found = {
          name: callee.kind === "computed" ? "" : callee.name,
          inside: routine,
          line: lineOf(side.source, node.startIndex),
          wrote: node.text.replace(/\s+/g, " ").slice(0, 80),
        };
        return;
      }
      why ??= answer;
    });
    if (found) return { evidence: found };
  }
  return why ? { why } : {};
}

/** A name, made safe to put in a pattern. Identifiers are tame; `$` is not. */
function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether the tail calls the head, and whether the call runs the other way.
 *
 * `from.routine` is the one symbol the tail box stands for; `to.names` is every
 * symbol the head box stands for, and any one of them is enough -- the same
 * any-of-the-members rule the other checks use.
 *
 * The backwards question is asked by reading the head's own routines, so the
 * accusation rests on something found. It is refused unless **both** languages
 * carry a licence, and that is stricter than `constructs.ts`: half of a
 * backwards verdict is the absence in the forward direction, and an absence
 * read by a reader nobody has measured is not evidence of anything (#198).
 */
export function callsBetween(
  from: CallSide & { routine: string },
  to: CallSide & { names: string[] },
): CallsVerdict {
  const wanted = new Set(to.names);
  const forward = callsTo(from, from.routine, { file: to.file, names: wanted });
  if (forward.evidence) return { verdict: "confirmed", evidence: forward.evidence };
  if (forward.why) return { verdict: "withheld", why: forward.why };

  if (!mayAccuse("calls", from.language) || !mayAccuse("calls", to.language)) {
    return { verdict: "withheld", why: "unlicensed" };
  }

  /*
   * Nothing found this way round. Before answering, ask whether it runs the
   * other way -- which is the only accusation this word is entitled to, and the
   * only one that rests on something found.
   *
   * A doubt on the way back is not a withheld verdict: the forward direction was
   * read cleanly, so the honest answer is that no call was found, which is
   * `absent` and is silence either way.
   */
  const back = { file: from.file, names: new Set([from.routine]) };
  for (const name of to.names) {
    const reverse = callsTo(to, name, back);
    if (reverse.evidence) return { verdict: "backwards", evidence: reverse.evidence };
  }

  return { verdict: "absent" };
}
